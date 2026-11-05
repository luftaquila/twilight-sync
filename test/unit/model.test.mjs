import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../helpers/engine.mjs';

const plain = x => JSON.parse(JSON.stringify(x));

let TS;
let sidebar;
let present; // ids of live DOM elements (tabs/folders/splits)
let storeData;
let now;

function makeSidebar() {
  return {
    spaces: [{ uuid: 'ws1', name: 'Work', containerTabId: 0 }],
    tabs: [
      { zenSyncId: 'p1', pinned: true, zenWorkspace: 'ws1', entries: [{ url: 'https://p1.example/', title: 'P1' }], index: 1, _zenPinnedInitialState: { entry: { url: 'https://p1.example/', title: 'P1' } } },
      { zenSyncId: 'n1', zenWorkspace: 'ws1', entries: [{ url: 'https://n1.example/', title: 'N1' }], index: 1 },
    ],
    folders: [],
    splitViewData: [],
  };
}

beforeEach(() => {
  TS = loadEngine(['util.js', 'project.js', 'model.js']);
  now = 1_000_000;
  TS.now = () => now;
  sidebar = makeSidebar();
  present = new Set(['p1', 'n1']);
  storeData = { version: 1, uploaded: {}, containers: {}, holds: {} };
  TS.store = { data: () => storeData, save() {} };
  TS.sidebar = { collect: () => sidebar };
  TS.keys = { project: () => ({ records: [], pending: [] }) };
  TS.capture = { options: { normalTabs: true, shortcuts: true, keyMapping: 'physical' } };
  const win = {
    gZenWorkspaces: { getWorkspaces: () => sidebar.spaces },
  };
  TS.env = {
    modules: { ContextualIdentityService: { getPublicIdentities: () => [], getPublicIdentityFromId: () => null } },
    primaryWindow: () => win,
    findElement: id => (present.has(id) ? { win, el: {} } : null),
  };
});

function sync() {
  // Pretend the server acknowledged everything that is currently projected.
  TS.model.invalidate();
  const { changed, deleted } = TS.model.computeChanges();
  TS.model.markUploaded({ records: changed, deleted });
  TS.model.invalidate();
}

test('first diff uploads everything; an acknowledged state is quiet', () => {
  TS.model.invalidate();
  const first = TS.model.computeChanges();
  assert.deepEqual(plain(first.changed.map(r => r.id).sort()), ['layout', 'n1', 'p1', 'ws1']);
  assert.deepEqual(plain(first.deleted), []);
  TS.model.markUploaded({ records: first.changed, deleted: [] });
  TS.model.invalidate();
  const second = TS.model.computeChanges();
  assert.equal(second.changed.length, 0);
  assert.equal(second.deleted.length, 0);
});

test('hard changes upload; a title change syncs only right after one', () => {
  sync();
  // Shortly after a record first syncs, its title may still be settling.
  sidebar.tabs[1].entries[0].title = 'N1 (loaded)';
  TS.model.invalidate();
  assert.deepEqual(plain(TS.model.computeChanges().changed.map(r => r.id)), ['n1']);
  sync();

  // Later, live title churn on an idle tab uploads nothing.
  now += TS.model.SETTLE_MS + 1;
  sidebar.tabs[1].entries[0].title = 'N1 (3 unread)';
  TS.model.invalidate();
  assert.equal(TS.model.computeChanges().changed.length, 0);

  // A navigation (hard) uploads and opens the settle window...
  sidebar.tabs[1].entries = [{ url: 'https://n1.example/next', title: 'https://n1.example/next' }];
  TS.model.invalidate();
  const nav = TS.model.computeChanges();
  assert.deepEqual(plain(nav.changed.map(r => r.id)), ['n1']);
  assert.equal(nav.changed[0].data.title, '');
  TS.model.markUploaded({ records: nav.changed, deleted: [] });

  // ...so the title that arrives after the load still syncs.
  sidebar.tabs[1].entries = [{ url: 'https://n1.example/next', title: 'Next page' }];
  TS.model.invalidate();
  const settled = TS.model.computeChanges();
  assert.deepEqual(plain(settled.changed.map(r => [r.id, r.data.title])), [['n1', 'Next page']]);
});

test('deletions require confirmed local absence', () => {
  sync();
  // The projection loses n1 but the tab element still exists (e.g. it is
  // mid-navigation with no entries): never a deletion.
  sidebar.tabs[1].entries = [];
  TS.model.invalidate();
  assert.deepEqual(plain(TS.model.computeChanges().deleted), []);

  // Really closed: deleted.
  sidebar.tabs.splice(1, 1);
  present.delete('n1');
  TS.model.invalidate();
  assert.deepEqual(plain(TS.model.computeChanges().deleted), ['n1']);
});

test('no deletion is emitted without a synced window', () => {
  sync();
  sidebar.tabs.splice(1, 1);
  present.delete('n1');
  TS.env.primaryWindow = () => null;
  TS.model.invalidate();
  assert.deepEqual(plain(TS.model.computeChanges().deleted), []);
});

test('normal tabs switched off: open tabs are neither changed nor deleted, the space echoes its open-tab section', () => {
  sync();
  TS.capture.options.normalTabs = false;
  sidebar.tabs.splice(1, 1);
  present.delete('n1');
  TS.model.invalidate();
  const diff = TS.model.computeChanges();
  assert.deepEqual(plain(diff.deleted), []);
  assert.deepEqual(plain(diff.changed), []);
  assert.deepEqual(plain(TS.model.current().map.get('ws1').data.normalChildren), ['n1']);
});

test('noteApplied makes a faithful materialization quiet and a divergent one re-upload', () => {
  sync();
  const incoming = { kind: 'tab', data: { ...TS.model.current().map.get('n1').data, url: 'https://n1.example/remote' } };
  TS.model.noteApplied('n1', incoming);
  // Divergent (the tab is still at the old URL): local truth re-uploads.
  TS.model.invalidate();
  assert.deepEqual(plain(TS.model.computeChanges().changed.map(r => r.id)), ['n1']);
  // Faithful: quiet.
  sidebar.tabs[1].entries = [{ url: 'https://n1.example/remote', title: 'N1' }];
  TS.model.invalidate();
  assert.equal(TS.model.computeChanges().changed.length, 0);
});

test('markUploaded advances from the sent payload, not the current state', () => {
  TS.model.invalidate();
  const { changed } = TS.model.computeChanges();
  // The tab navigates while the upload is in flight.
  sidebar.tabs[1].entries = [{ url: 'https://n1.example/moved', title: 'Moved' }];
  TS.model.markUploaded({ records: changed, deleted: [] });
  TS.model.invalidate();
  assert.deepEqual(plain(TS.model.computeChanges().changed.map(r => r.id)), ['n1']);
});

test('dropKeyBaselines forgets only shortcut entries', () => {
  storeData.uploaded = { a: { k: 'tab', h: 'x', s: '' }, 'key:b': { k: 'key', h: 'y', s: '' } };
  TS.model.dropKeyBaselines();
  assert.deepEqual(Object.keys(storeData.uploaded), ['a']);
});

test('container guids: built-ins are fixed, others are minted once and remembered', () => {
  const identities = new Map([
    [1, { userContextId: 1, name: 'Personal' }],
    [7, { userContextId: 7, name: 'Custom' }],
  ]);
  TS.env.modules.ContextualIdentityService = {
    getPublicIdentities: () => [...identities.values()],
    getPublicIdentityFromId: id => identities.get(id) || null,
  };
  assert.equal(TS.model.guidForContextId(1, { create: true }), 'builtin-1');
  assert.equal(TS.model.guidForContextId(7), null);
  const guid = TS.model.guidForContextId(7, { create: true });
  assert.match(guid, /^[0-9a-f-]{36}$/);
  assert.equal(TS.model.guidForContextId(7), guid);
  assert.equal(TS.model.contextIdForGuid(guid), 7);
  assert.equal(TS.model.contextIdForGuid('builtin-1'), 1);
  // A deleted container forgets its mapping.
  identities.delete(7);
  assert.equal(TS.model.contextIdForGuid(guid), null);
  // A re-created built-in maps its old guid to the new id.
  identities.delete(1);
  identities.set(9, { userContextId: 9, name: 'Personal' });
  TS.model.registerContainerGuid('builtin-1', 9);
  assert.equal(TS.model.contextIdForGuid('builtin-1'), 9);
  assert.equal(TS.model.guidForContextId(9), 'builtin-1');
});

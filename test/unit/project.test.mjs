import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../helpers/engine.mjs';

const TS = loadEngine(['util.js', 'project.js']);
const plain = x => JSON.parse(JSON.stringify(x));

const entry = (url, title) => ({ url, title });

function fixture() {
  return {
    spaces: [
      { uuid: 'ws1', name: 'Work', icon: 'W', theme: { type: 'gradient', gradientColors: [] }, containerTabId: 0 },
      { uuid: 'ws2', name: 'Home', containerTabId: 5 },
    ],
    tabs: [
      {
        zenSyncId: 'e1',
        zenEssential: true,
        pinned: true,
        entries: [entry('https://mail.example/inbox/42', 'Thread')],
        index: 1,
        _zenPinnedInitialState: { entry: entry('https://mail.example/', 'Mail'), image: 'data:e1' },
        zenDefaultUserContextId: 'true',
      },
      {
        zenSyncId: 'p1',
        pinned: true,
        zenWorkspace: 'ws1',
        entries: [entry('https://pin.example/', 'Pin'), entry('https://pin.example/other', 'Other')],
        index: 2,
        _zenPinnedInitialState: { entry: entry('https://pin.example/', 'Pin') },
      },
      { zenSyncId: 'fe', zenIsEmpty: true, pinned: true, groupId: 'F1', zenWorkspace: 'ws1', entries: [] },
      { zenSyncId: 'p2', pinned: true, groupId: 'F1', zenWorkspace: 'ws1', entries: [entry('https://p2.example/', 'P2')], index: 1 },
      { zenSyncId: 'se', zenIsEmpty: true, pinned: true, groupId: 'F2', zenWorkspace: 'ws1', entries: [] },
      { zenSyncId: 'p3', pinned: true, groupId: 'F2', zenWorkspace: 'ws1', entries: [entry('https://p3.example/', 'P3')], index: 1, zenStaticLabel: 'Renamed' },
      { zenSyncId: 'n1', zenWorkspace: 'ws1', entries: [entry('https://n1.example/', 'N1')], index: 1, image: 'https://n1.example/favicon.ico' },
      { zenSyncId: 'n2', zenWorkspace: 'ws1', groupId: 'S1', entries: [entry('https://n2.example/', 'https://n2.example/')], index: 1 },
      { zenSyncId: 'n3', zenWorkspace: 'ws1', groupId: 'S1', entries: [entry('https://n3.example/', 'N3')], index: 1 },
      { zenSyncId: 'n4', zenWorkspace: 'ws1', entries: [entry('about:newtab', 'New Tab')], index: 1 },
      { zenSyncId: 'g1', zenIsGlance: true, zenWorkspace: 'ws1', entries: [entry('https://glance.example/', 'G')], index: 1 },
      { zenSyncId: 'n5', zenWorkspace: 'ws2', userContextId: 5, entries: [entry('https://n5.example/', 'N5')], index: 1 },
    ],
    folders: [
      { id: 'F1', name: 'Folder', workspaceId: 'ws1', parentId: null, userIcon: 'chrome://zen/skin/icon.svg' },
      { id: 'F2', name: 'Sub', workspaceId: 'ws1', parentId: 'F1' },
    ],
    splitViewData: [{ groupId: 'S1', gridType: 'vsep', tabs: ['n2', 'n3'] }],
  };
}

function ctx(over = {}) {
  return {
    options: { normalTabs: true, shortcuts: true },
    guidForContextId: id => (Number(id) === 5 ? 'guid-5' : null),
    containerIdentities: () => [{ userContextId: 5, name: 'Home', icon: 'fingerprint', color: 'blue' }],
    liveFolderData: () => null,
    holds: {},
    keys: null,
    ...over,
  };
}

test('space sections follow strip order: pinned tabs and folders, then open tabs and splits', () => {
  const { map } = TS.project.build(fixture(), ctx());
  assert.deepEqual(plain(map.get('ws1').data.children), ['p1', 'F1']);
  assert.deepEqual(plain(map.get('ws1').data.normalChildren), ['n1', 'S1']);
  assert.deepEqual(plain(map.get('ws2').data.children), []);
  assert.deepEqual(plain(map.get('ws2').data.normalChildren), ['n5']);
  assert.equal(map.get('ws2').data.containerGuid, 'guid-5');
});

test('folders nest and list their direct children', () => {
  const { map } = TS.project.build(fixture(), ctx());
  assert.deepEqual(plain(map.get('F1').data), {
    folderId: 'F1',
    name: 'Folder',
    icon: 'chrome://zen/skin/icon.svg',
    workspaceUuid: 'ws1',
    parentFolderId: null,
    live: null,
    children: ['p2', 'F2'],
  });
  assert.equal(map.get('F2').data.parentFolderId, 'F1');
  assert.deepEqual(plain(map.get('F2').data.children), ['p3']);
});

test('pinned and essential tabs use the pin target, normal tabs the live entry', () => {
  const { map } = TS.project.build(fixture(), ctx());
  const p1 = map.get('p1').data;
  assert.equal(p1.url, 'https://pin.example/');
  assert.equal(p1.title, 'Pin');
  assert.equal(p1.pinned, true);
  const e1 = map.get('e1').data;
  assert.equal(e1.url, 'https://mail.example/');
  assert.equal(e1.essential, true);
  assert.equal(e1.workspaceUuid, null);
  assert.equal(e1.icon, 'data:e1');
  assert.equal(e1.defaultContainer, true);
  const n1 = map.get('n1').data;
  assert.equal(n1.url, 'https://n1.example/');
  assert.equal(n1.pinned, false);
  assert.equal(n1.icon, '', 'remote favicons are not synced');
  assert.equal(map.get('n2').data.title, '', 'a title equal to the URL is the loading placeholder');
  assert.equal(map.get('p3').data.staticLabel, 'Renamed');
  assert.equal(map.get('p3').data.folderId, 'F2');
  assert.equal(map.get('n5').data.containerGuid, 'guid-5');
});

test('splits, layout and containers', () => {
  const { map } = TS.project.build(fixture(), ctx());
  assert.deepEqual(plain(map.get('S1').data), {
    splitId: 'S1',
    gridType: 'vsep',
    pinned: false,
    tabs: ['n2', 'n3'],
    workspaceUuid: 'ws1',
    folderId: null,
  });
  assert.deepEqual(plain(map.get('layout').data), { spaces: ['ws1', 'ws2'], essentials: { default: ['e1'] } });
  assert.deepEqual(plain(map.get('guid-5')), {
    kind: 'container',
    data: { guid: 'guid-5', name: 'Home', icon: 'fingerprint', color: 'blue' },
  });
});

test('unprojectable tabs are pending, glance and placeholder tabs are ignored', () => {
  const { map, pending } = TS.project.build(fixture(), ctx());
  assert.ok(!map.has('n4'));
  assert.ok(pending.has('n4'));
  for (const id of ['g1', 'fe', 'se']) {
    assert.ok(!map.has(id), id);
    assert.ok(!pending.has(id), id);
  }
});

test('normal tabs switched off: held as pending, never deleted', () => {
  const { map, pending } = TS.project.build(fixture(), ctx({ options: { normalTabs: false, shortcuts: true } }));
  for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) {
    assert.ok(!map.has(id), id);
    assert.ok(pending.has(id), id);
  }
  assert.ok(pending.has('S1'), 'a split of held tabs is held too');
  assert.ok(!map.has('S1'));
  assert.deepEqual(plain(map.get('ws1').data.children), ['p1', 'F1']);
  assert.ok(map.has('p1') && map.has('e1'));
});

test('normal tabs switched off: the open-tab section echoes the last synced one', () => {
  const echo = { ws1: ['remote-a', 'remote-b'] };
  const { map } = TS.project.build(
    fixture(),
    ctx({ options: { normalTabs: false, shortcuts: true }, normalChildrenEcho: uuid => echo[uuid] })
  );
  assert.deepEqual(plain(map.get('ws1').data.normalChildren), ['remote-a', 'remote-b']);
  assert.deepEqual(plain(map.get('ws2').data.normalChildren), []);
});

test('a navigation hold projects the remote URL', () => {
  const holds = { n1: { url: 'https://held.example/', title: 'Held', icon: '', localUrl: 'https://n1.example/' } };
  const { map } = TS.project.build(fixture(), ctx({ holds }));
  assert.equal(map.get('n1').data.url, 'https://held.example/');
  assert.equal(map.get('n1').data.title, 'Held');
  // Holds never apply to pinned kinds.
  const pinnedHold = { p1: { url: 'https://other.example/' } };
  assert.equal(TS.project.build(fixture(), ctx({ holds: pinnedHold })).map.get('p1').data.url, 'https://pin.example/');
});

test('live folders without provider data are pending', () => {
  const sidebar = fixture();
  sidebar.folders[0].isLiveFolder = true;
  const { map, pending } = TS.project.build(sidebar, ctx());
  assert.ok(!map.has('F1'));
  assert.ok(pending.has('F1'));
  const live = TS.project.build(sidebar, ctx({ liveFolderData: () => ({ type: 'rss', state: { url: 'https://feed' } }) }));
  assert.deepEqual(plain(live.map.get('F1').data.live), { type: 'rss', state: { url: 'https://feed' } });
});

test('key records and their pending ids are merged in', () => {
  const keys = { records: [{ id: 'key:k1', data: { keyId: 'k1', mods: ['ctrl'], key: 'T', keycode: null, cleared: false } }], pending: ['key:k2'] };
  const { map, pending } = TS.project.build(fixture(), ctx({ keys }));
  assert.equal(map.get('key:k1').kind, 'key');
  assert.ok(pending.has('key:k2'));
});

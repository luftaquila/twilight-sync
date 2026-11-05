import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../helpers/engine.mjs';

const plain = x => JSON.parse(JSON.stringify(x));

let TS;
let file; // customKeys.json contents
let mtime;
let elements; // key element attributes on the "window"
let customized; // CustomKeys.getDefaultKey results (original bindings of customized keys)
let calls;

beforeEach(async () => {
  TS = loadEngine(['util.js', 'keys.js']);
  file = {};
  mtime = 1;
  elements = {
    key_reload: { modifiers: 'accel', key: 'R' },
    key_find: { modifiers: 'accel', key: 'F' },
  };
  customized = {};
  calls = [];
  TS.PathUtils = { join: (...p) => p.join('/'), profileDir: '/profile' };
  TS.IOUtils = {
    stat: async () => ({ lastModified: mtime }),
    readJSON: async () => structuredClone(file),
  };
  const win = {
    document: {
      getElementById: id =>
        elements[id]
          ? { localName: 'key', getAttribute: name => elements[id][name] ?? null }
          : null,
    },
  };
  TS.env = {
    platform: 'macosx',
    primaryWindow: () => win,
    modules: {
      CustomKeys: {
        getDefaultKey: id => customized[id] || null,
        changeKey: (id, b) => calls.push(['change', id, b]),
        clearKey: id => calls.push(['clear', id]),
        resetKey: id => calls.push(['reset', id]),
      },
    },
  };
  TS.capture = { options: { keyMapping: 'physical' } };
  await TS.keys.refresh();
});

const rec = (keyId, mods, key) => ({ keyId, mods, key, keycode: null, cleared: false });

test('local customizations become physical-key records', () => {
  file = { key_reload: { modifiers: 'control,shift', key: 'Y' }, key_viewSource: {} };
  mtime = 2;
  return TS.keys.refresh().then(() => {
    const { records, pending } = TS.keys.project({}, true);
    assert.deepEqual(plain(records), [
      { id: 'key:key_reload', data: rec('key_reload', ['ctrl', 'shift'], 'Y') },
      { id: 'key:key_viewSource', data: { keyId: 'key_viewSource', mods: [], key: null, keycode: null, cleared: true } },
    ]);
    assert.deepEqual(plain(pending), []);
  });
});

test('a synced binding CustomKeys folded back into the default stays present', () => {
  // Synced: key_reload = ⌘R (meta+R). On this Mac that IS the default, so
  // CustomKeys keeps no customization — the record must still project.
  const uploaded = { 'key:key_reload': { k: 'key', x: rec('key_reload', ['meta'], 'R') } };
  const { records, pending } = TS.keys.project(uploaded, true);
  assert.deepEqual(plain(records), [{ id: 'key:key_reload', data: rec('key_reload', ['meta'], 'R') }]);
  assert.deepEqual(plain(pending), []);
});

test('a synced customization reset locally reads as a deletion', () => {
  const uploaded = { 'key:key_reload': { k: 'key', x: rec('key_reload', ['ctrl', 'shift'], 'Y') } };
  const { records, pending } = TS.keys.project(uploaded, true);
  assert.deepEqual(plain(records), []);
  assert.deepEqual(plain(pending), [], 'not pending: absent and not default-equivalent → deletion');
});

test("a key element this window doesn't have can't be judged: pending", () => {
  const uploaded = { 'key:key_inspectorMac': { k: 'key', x: rec('key_inspectorMac', ['alt', 'meta'], 'I') } };
  const { pending } = TS.keys.project(uploaded, true);
  assert.deepEqual(plain(pending), ['key:key_inspectorMac']);
});

test('the default of a customized key comes from CustomKeys, not the element', () => {
  file = { key_find: { modifiers: 'control', key: 'F' } };
  mtime = 3;
  customized.key_find = { modifiers: 'accel', key: 'F' };
  elements.key_find = { modifiers: 'control', key: 'F' };
  return TS.keys.refresh().then(() => {
    const { records } = TS.keys.project({}, true);
    assert.deepEqual(plain(records.map(r => r.id)), ['key:key_find']);
  });
});

test('after an apply the file is ignored until CustomKeys rewrites it', async () => {
  TS.keys.apply([{ id: 'key:key_reload', kind: 'key', data: rec('key_reload', ['ctrl'], 'R') }], []);
  assert.deepEqual(plain(calls), [['change', 'key_reload', { modifiers: 'control', key: 'R' }]]);
  const stale = TS.keys.project({ 'key:key_find': { k: 'key', x: rec('key_find', ['ctrl'], 'F') } }, true);
  assert.deepEqual(plain(stale.records), []);
  assert.deepEqual(plain(stale.pending), ['key:key_find']);
  // CustomKeys saves: new mtime → fresh again.
  file = { key_reload: { modifiers: 'control', key: 'R' } };
  mtime = 9;
  await TS.keys.refresh();
  assert.equal(TS.keys.isStale(), false);
  assert.deepEqual(plain(TS.keys.project({}, true).records.map(r => r.id)), ['key:key_reload']);
});

test('unbindable records are skipped, deletions reset', () => {
  TS.env.platform = 'win';
  const result = TS.keys.apply(
    [{ id: 'key:key_reload', kind: 'key', data: rec('key_reload', ['meta'], 'R') }],
    ['key:key_find']
  );
  assert.deepEqual(plain(result.skipped), ['key:key_reload']);
  assert.deepEqual(plain(calls), [['reset', 'key_find']]);
});

test('shortcut sync off: every key id is pending', () => {
  file = { key_reload: { modifiers: 'control', key: 'Y' } };
  mtime = 4;
  return TS.keys.refresh().then(() => {
    const { records, pending } = TS.keys.project({ 'key:key_find': { k: 'key' } }, false);
    assert.deepEqual(plain(records), []);
    assert.deepEqual(plain(pending).sort(), ['key:key_find', 'key:key_reload']);
  });
});

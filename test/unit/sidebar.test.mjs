import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../helpers/engine.mjs';

const { sidebar } = loadEngine(['sidebar.js']);
const plain = x => JSON.parse(JSON.stringify(x));

test('merges window states like ZenSessionStore: dedupe by sync id, prefer real and active copies', () => {
  const blankCopy = { zenSyncId: 't1', entries: [{ url: 'about:blank' }] };
  const realCopy = { zenSyncId: 't1', entries: [{ url: 'https://a.example/' }] };
  const inactive = { zenSyncId: 't2', entries: [{ url: 'https://b.example/one' }] };
  const active = { zenSyncId: 't2', entries: [{ url: 'https://b.example/two' }], _zenIsActiveTab: true };
  const merged = sidebar.merge([
    {
      tabs: [blankCopy, inactive, { zenSyncId: 'e', zenIsEmpty: true, entries: [] }],
      folders: [{ id: 'F' }],
      spaces: [{ uuid: 'ws' }],
      splitViewData: [{ groupId: 'S1', tabs: ['x', 'y'] }],
    },
    {
      tabs: [realCopy, active, { zenSyncId: 't3', entries: [{ url: 'https://c.example/' }] }],
      folders: [{ id: 'IGNORED' }],
      spaces: [{ uuid: 'IGNORED' }],
      splitViewData: [{ groupId: 'S2', tabs: ['z', 'w'] }, { groupId: 'S1', tabs: ['dup', 'dup2'] }],
    },
  ]);
  assert.deepEqual(plain(merged.tabs.map(t => t.entries[0].url)), ['https://a.example/', 'https://b.example/two', 'https://c.example/']);
  assert.deepEqual(plain(merged.folders), [{ id: 'F' }]);
  assert.deepEqual(plain(merged.spaces), [{ uuid: 'ws' }]);
  assert.deepEqual(plain(merged.splitViewData.map(s => s.groupId)), ['S1', 'S2']);
  assert.deepEqual(plain(merged.splitViewData[0].tabs), ['x', 'y']);
  assert.equal(merged.windowCount, 2);
});

test('folder placeholder tabs are kept (they anchor folder order), stray empty tabs are not', () => {
  const merged = sidebar.merge([
    {
      tabs: [
        { zenSyncId: 'ph', zenIsEmpty: true, groupId: 'F', entries: [] },
        { zenSyncId: 'stray', zenIsEmpty: true, entries: [] },
        { entries: [{ url: 'about:newtab' }] },
      ],
    },
  ]);
  assert.deepEqual(plain(merged.tabs.map(t => t.zenSyncId)), ['ph']);
});

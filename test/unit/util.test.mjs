import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../helpers/engine.mjs';
import { canonicalJSON as serverCanonicalJSON } from '../../server/lib/records.js';

const TS = loadEngine(['util.js']);
const { util } = TS;

test('canonicalJSON sorts keys recursively and maps undefined to null', () => {
  assert.equal(util.canonicalJSON({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":null},"b":1}');
});

test('server and engine canonical JSON agree', () => {
  const sample = { kind: 'tab', data: { url: 'https://a.example/', title: 'A', z: [1, { b: 2, a: undefined }], essential: false } };
  assert.equal(util.canonicalJSON(sample), serverCanonicalJSON(sample));
});

test('syncableIconUrl keeps local icons, drops remote ones, unwraps moz-remote-image', () => {
  assert.equal(util.syncableIconUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(util.syncableIconUrl('chrome://branding/content/icon32.png'), 'chrome://branding/content/icon32.png');
  assert.equal(util.syncableIconUrl('https://example.com/favicon.ico'), '');
  assert.equal(util.syncableIconUrl('page-icon:https://example.com/'), '');
  const wrapped = `moz-remote-image:?url=${encodeURIComponent('data:image/svg+xml,<svg/>')}&width=16`;
  assert.equal(util.syncableIconUrl(wrapped), 'data:image/svg+xml,<svg/>');
  const wrappedRemote = `moz-remote-image:?url=${encodeURIComponent('https://x.example/i.png')}`;
  assert.equal(util.syncableIconUrl(wrappedRemote), '');
  assert.equal(util.syncableIconUrl(null), '');
});

test('isSyncableUrl accepts only http(s)', () => {
  assert.ok(util.isSyncableUrl('https://a.example'));
  assert.ok(util.isSyncableUrl('http://a.example'));
  for (const url of ['about:blank', 'about:newtab', 'file:///etc/hosts', 'javascript:alert(1)', 'moz-extension://x/', '', null]) {
    assert.ok(!util.isSyncableUrl(url), String(url));
  }
});

const tab = (over = {}) => ({
  tabId: 't1',
  url: 'https://a.example/',
  title: 'Inbox (3)',
  icon: 'data:image/png;base64,AAAA',
  containerGuid: null,
  essential: false,
  pinned: false,
  workspaceUuid: 'ws1',
  folderId: null,
  staticLabel: null,
  hasStaticIcon: false,
  defaultContainer: false,
  ...over,
});

test('tab title and live icon are soft: they never change the hard digest', () => {
  const base = util.hardDigest('tab', tab());
  assert.equal(util.hardDigest('tab', tab({ title: 'Inbox (4)' })), base);
  assert.equal(util.hardDigest('tab', tab({ icon: '' })), base);
  assert.notEqual(util.softDigest('tab', tab({ title: 'Inbox (4)' })), util.softDigest('tab', tab()));
  assert.notEqual(util.hardDigest('tab', tab({ url: 'https://b.example/' })), base);
  assert.notEqual(util.hardDigest('tab', tab({ pinned: true })), base);
  assert.notEqual(util.hardDigest('tab', tab({ workspaceUuid: 'ws2' })), base);
});

test('a static (user-chosen) tab icon is hard', () => {
  const a = tab({ hasStaticIcon: true, icon: 'data:a' });
  const b = tab({ hasStaticIcon: true, icon: 'data:b' });
  assert.notEqual(util.hardDigest('tab', a), util.hardDigest('tab', b));
});

test('non-tab kinds have no soft part', () => {
  assert.equal(util.softDigest('space', { uuid: 's', name: 'x' }), '');
  assert.notEqual(util.hardDigest('space', { uuid: 's', name: 'x' }), util.hardDigest('space', { uuid: 's', name: 'y' }));
});

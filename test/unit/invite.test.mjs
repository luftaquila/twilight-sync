import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvite, buildInvite } from '../../extension/common/invite.js';
import { buildInvite as serverBuildInvite } from '../../server/lib/invite.js';

test('parses secure, plaintext and subpath invites', () => {
  assert.deepEqual(parseInvite('twsync://sync.example.com/?t=abc'), {
    serverUrl: 'wss://sync.example.com',
    token: 'abc',
    deviceName: null,
  });
  assert.deepEqual(parseInvite('twsync://127.0.0.1:9223/?t=abc&s=0&n=Laptop'), {
    serverUrl: 'ws://127.0.0.1:9223',
    token: 'abc',
    deviceName: 'Laptop',
  });
  assert.deepEqual(parseInvite('  twsync://proxy.example.com/zen/sync/?t=xyz \n'), {
    serverUrl: 'wss://proxy.example.com/zen/sync',
    token: 'xyz',
    deviceName: null,
  });
  assert.deepEqual(parseInvite('wss://h.example/path?t=tok'), { serverUrl: 'wss://h.example/path', token: 'tok', deviceName: null });
});

test('rejects garbage', () => {
  for (const bad of ['', 'hello', 'https://x.example/?t=1', 'twsync://host/', 'twsync:///?t=1', null]) {
    assert.equal(parseInvite(bad), null, String(bad));
  }
});

test('build → parse round-trips', () => {
  for (const serverUrl of ['wss://a.example', 'ws://localhost:9223', 'wss://b.example/sub/path']) {
    const invite = buildInvite({ serverUrl, token: 't0k', deviceName: 'Mac' });
    assert.deepEqual(parseInvite(invite), { serverUrl, token: 't0k', deviceName: 'Mac' });
  }
  assert.equal(buildInvite({ serverUrl: 'https://not-ws', token: 'x' }), null);
});

test("the server's invite is the extension's format", () => {
  assert.deepEqual(parseInvite(serverBuildInvite({ publicUrl: 'wss://sync.example.com', port: 9223, token: 'k' })), {
    serverUrl: 'wss://sync.example.com',
    token: 'k',
    deviceName: null,
  });
  assert.deepEqual(parseInvite(serverBuildInvite({ publicUrl: 'https://proxy.example.com/tw/', port: 9223, token: 'k' })), {
    serverUrl: 'wss://proxy.example.com/tw',
    token: 'k',
    deviceName: null,
  });
  assert.deepEqual(parseInvite(serverBuildInvite({ publicUrl: '', port: 9555, token: 'k' })), {
    serverUrl: 'ws://localhost:9555',
    token: 'k',
    deviceName: null,
  });
});

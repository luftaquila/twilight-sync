// Drives the real server over its WebSocket protocol: the Node server, or the
// Cloudflare Worker under `wrangler dev` with SYNC_SERVER=worker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { SERVER_TARGET, startSyncServer, stopSyncServer } from '../helpers/sync-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WebSocket = createRequire(join(root, 'server/package.json'))('ws');
const TOKEN = 'test-token';
const PORT = 19000 + Math.floor(Math.random() * 1000);
let dataDir;
let proc;

async function startServer() {
  proc = await startSyncServer({ port: PORT, dataDir, token: TOKEN });
}

function stopServer(signal = 'SIGTERM') {
  return stopSyncServer(proc, signal);
}

class Client {
  messages = [];
  #waiters = [];

  static async connect(opts = {}) {
    const c = new Client();
    await c.open(opts);
    return c;
  }

  open({ token = TOKEN, deviceId = `dev-${Math.random().toString(16).slice(2)}`, name = 'test', protocol = 1, expectWelcome = true } = {}) {
    this.deviceId = deviceId;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/any/path`);
    this.ws.on('message', raw => {
      const msg = JSON.parse(raw);
      this.messages.push(msg);
      for (const w of [...this.#waiters]) {
        if (w.match(msg)) {
          this.#waiters.splice(this.#waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    this.closed = new Promise(resolve => this.ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        this.send({ type: 'hello', protocol, token, deviceId, deviceName: name, platform: 'linux', client: 'test' });
        if (!expectWelcome) return resolve();
        this.next('welcome').then(resolve, reject);
      });
      this.ws.once('error', reject);
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  next(type, pred = () => true, timeout = 3000) {
    const match = m => m.type === type && pred(m);
    const found = this.messages.find(match);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: m => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeout);
      this.#waiters.push(waiter);
    });
  }

  async none(type, ms = 400) {
    await new Promise(r => setTimeout(r, ms));
    assert.ok(!this.messages.some(m => m.type === type), `unexpected ${type}`);
  }

  close() {
    this.ws.close();
  }
}

const tab = (id, url = `https://${id}.example/`, extra = {}) => ({
  id,
  kind: 'tab',
  data: { tabId: id, url, title: id, icon: '', containerGuid: null, essential: false, pinned: false, workspaceUuid: 'ws1', folderId: null, staticLabel: null, hasStaticIcon: false, defaultContainer: false, ...extra },
});
const space = id => ({ id, kind: 'space', data: { uuid: id, name: id, icon: null, theme: null, containerGuid: null, children: [], normalChildren: [] } });

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'twsync-server-'));
  await startServer();
});

after(async () => {
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test('health endpoint', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('bad token and protocol mismatch are refused', async () => {
  const bad = new Client();
  await bad.open({ token: 'nope', expectWelcome: false });
  const err = await bad.next('error');
  assert.equal(err.code, 'auth_failed');
  assert.equal((await bad.closed).code, 4001);

  const old = new Client();
  await old.open({ protocol: 99, expectWelcome: false });
  const mismatch = await old.next('error');
  assert.equal(mismatch.code, 'protocol_mismatch');
  assert.equal(mismatch.protocol, 1);
});

test('a socket sending more than a hello before authenticating is dropped; authenticated ones are not limited', async () => {
  const noisy = new WebSocket(`ws://127.0.0.1:${PORT}/`, { perMessageDeflate: false });
  noisy.on('error', () => {});
  await new Promise(resolve => noisy.once('open', resolve));
  const closed = new Promise(resolve => noisy.once('close', code => resolve(code)));
  noisy.send(JSON.stringify({ type: 'hello', padding: 'x'.repeat(64 * 1024) }));
  // Node destroys the socket (1006); the Worker closes it (1009).
  assert.ok([1006, 1009].includes(await closed));

  // ~200 KB of hex stays above the pre-auth limit even when compressed.
  const a = await Client.connect();
  a.send({ type: 'put', reqId: 'big', records: [tab('big', undefined, { title: randomBytes(100 * 1024).toString('hex') })], deleted: [] });
  assert.deepEqual((await a.next('put_ok', m => m.reqId === 'big')).accepted, ['big']);
  a.send({ type: 'put', reqId: 'big-gone', records: [], deleted: ['big'] });
  await a.next('put_ok', m => m.reqId === 'big-gone');
  a.close();
});

test('put is acknowledged, broadcast to others, and idempotent', async () => {
  const a = await Client.connect({ name: 'A' });
  const b = await Client.connect({ name: 'B' });
  a.send({ type: 'put', reqId: 'r1', records: [space('ws1'), tab('t1')], deleted: [] });
  const ok = await a.next('put_ok');
  assert.equal(ok.reqId, 'r1');
  assert.deepEqual(ok.accepted.sort(), ['t1', 'ws1']);
  const change = await b.next('changes');
  assert.deepEqual(change.records.map(r => r.id).sort(), ['t1', 'ws1']);
  assert.equal(change.source, a.deviceId);
  await a.none('changes');

  // Same content again: acknowledged, but no version bump and no broadcast.
  a.send({ type: 'put', reqId: 'r2', records: [tab('t1')], deleted: [] });
  const ok2 = await a.next('put_ok');
  assert.equal(ok2.version, ok.version);
  await b.none('changes');

  a.close();
  b.close();
});

test('invalid records are rejected individually', async () => {
  const a = await Client.connect();
  a.send({
    type: 'put',
    reqId: 'v',
    records: [
      tab('bad1', 'javascript:alert(1)'),
      { id: 'key:k', kind: 'key', data: { keyId: 'other', mods: ['ctrl'], key: 'T' } },
      { id: 'x', kind: 'weird', data: {} },
      { id: 'key:ok', kind: 'key', data: { keyId: 'ok', mods: ['ctrl', 'shift'], key: 'T', keycode: null, cleared: false } },
    ],
    deleted: [],
  });
  const ok = await a.next('put_ok');
  assert.deepEqual(ok.accepted, ['key:ok']);
  assert.deepEqual(ok.rejected.map(r => r.id).sort(), ['bad1', 'key:k', 'x']);
  a.close();
});

test('fetch returns the full state', async () => {
  const a = await Client.connect();
  a.send({ type: 'fetch' });
  const state = await a.next('state');
  const ids = state.records.map(r => r.id);
  assert.ok(ids.includes('t1') && ids.includes('ws1') && ids.includes('key:ok'));
  assert.ok(state.generation);
  a.close();
});

test('deleting a space cascades to records still placed in it', async () => {
  const a = await Client.connect();
  a.send({ type: 'put', reqId: 'c1', records: [space('ws9'), tab('in9', undefined, { workspaceUuid: 'ws9' }), tab('moved', undefined, { workspaceUuid: 'ws9' })], deleted: [] });
  await a.next('put_ok');
  // In the same message, 'moved' is re-placed elsewhere: it survives.
  a.send({ type: 'put', reqId: 'c2', records: [tab('moved', undefined, { workspaceUuid: 'ws1' })], deleted: ['ws9'] });
  await a.next('put_ok');
  a.send({ type: 'fetch' });
  const ids = (await a.next('state')).records.map(r => r.id);
  assert.ok(!ids.includes('ws9'));
  assert.ok(!ids.includes('in9'));
  assert.ok(ids.includes('moved'));
  a.close();
});

test('mass deletion is held unless forced; replays of applied deletions pass', async () => {
  const a = await Client.connect();
  const many = Array.from({ length: 40 }, (_, i) => tab(`m${i}`));
  a.send({ type: 'put', reqId: 'm1', records: many, deleted: [] });
  await a.next('put_ok');
  a.send({ type: 'fetch' });
  const total = (await a.next('state')).records.length;
  const ids = (await (async () => {
    a.send({ type: 'fetch' });
    return (await a.next('state')).records.map(r => r.id);
  })());
  a.send({ type: 'put', reqId: 'm2', records: [], deleted: ids });
  const rejected = await a.next('put_rejected');
  assert.equal(rejected.reason, 'mass_delete');
  assert.equal(rejected.wouldDelete, total);

  a.send({ type: 'put', reqId: 'm3', records: [], deleted: ids, force: true });
  const ok = await a.next('put_ok', m => m.reqId === 'm3');
  assert.equal(ok.rejected.length, 0);
  // A replay of the same deletions removes nothing, so it is not held.
  a.send({ type: 'put', reqId: 'm4', records: [], deleted: ids });
  await a.next('put_ok', m => m.reqId === 'm4');
  a.close();
});

test('replace is compare-and-swap and broadcasts the new state', async () => {
  const a = await Client.connect({ name: 'A' });
  const b = await Client.connect({ name: 'B' });
  a.send({ type: 'fetch' });
  const { version } = await a.next('state');
  a.send({ type: 'replace', reqId: 'x1', records: [space('only'), tab('solo')], baseVersion: version });
  const ok = await a.next('replace_ok');
  assert.deepEqual(ok.accepted.sort(), ['only', 'solo']);
  const pushed = await b.next('state');
  assert.deepEqual(pushed.records.map(r => r.id).sort(), ['only', 'solo']);

  b.send({ type: 'replace', reqId: 'x2', records: [], baseVersion: version });
  const conflict = await b.next('replace_conflict');
  assert.equal(conflict.reqId, 'x2');
  assert.equal(conflict.version, ok.version);
  a.close();
  b.close();
});

test('a reconnecting device replaces its stale socket; device lists follow', async () => {
  const a1 = await Client.connect({ deviceId: 'same', name: 'Laptop' });
  const watcher = await Client.connect({ name: 'Watcher' });
  const a2 = await Client.connect({ deviceId: 'same', name: 'Laptop' });
  await a1.closed;
  const list = await watcher.next('devices', m => m.devices.filter(d => d.deviceId === 'same').length === 1);
  assert.ok(list.devices.some(d => d.name === 'Watcher'));
  a2.close();
  watcher.close();
});

test('state survives a restart; admin reset gives a new generation and disables everyone', async () => {
  const a = await Client.connect();
  a.send({ type: 'put', reqId: 'p', records: [tab('persist')], deleted: [] });
  await a.next('put_ok');
  const generation = (await (async () => {
    a.send({ type: 'fetch' });
    return a.next('state');
  })()).generation;
  a.close();

  if (process.platform === 'win32') {
    // No SIGTERM handlers on Windows: let the debounced save land first.
    await new Promise(r => setTimeout(r, 1000));
  }
  await stopServer('SIGTERM');
  if (SERVER_TARGET === 'node') {
    const saved = JSON.parse(readFileSync(join(dataDir, 'sync-state.json'), 'utf-8'));
    assert.ok(saved.records.persist, 'state was saved (SIGTERM flushes the debounced save on POSIX)');
  }
  await startServer();

  const b = await Client.connect();
  b.send({ type: 'fetch' });
  const state = await b.next('state');
  assert.equal(state.generation, generation);
  assert.ok(state.records.some(r => r.id === 'persist'));

  const c = await Client.connect();
  b.send({ type: 'admin', action: 'reset' });
  await b.next('admin_ok');
  assert.equal((await b.next('force_disable')).reason, 'admin_reset');
  assert.equal((await c.next('force_disable')).reason, 'admin_reset');
  const d = await Client.connect();
  d.send({ type: 'fetch' });
  const after = await d.next('state');
  assert.notEqual(after.generation, generation);
  assert.equal(after.records.length, 0);
  b.close();
  c.close();
  d.close();
});

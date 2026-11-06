#!/usr/bin/env node
/**
 * Twilight Sync server — a single-process WebSocket relay with a persistent
 * record map. See extension/common/protocol.js for the wire protocol.
 *
 * Environment:
 *   PORT        listen port (default 9223)
 *   HOST        listen address (default 0.0.0.0)
 *   DATA_DIR    where sync-state.json and tokens.json live (default: ./data)
 *   SYNC_TOKEN  operator-owned token (registered idempotently; makes the
 *               invite reprintable with `node server.js --invite`)
 *   PUBLIC_URL  address devices actually reach, e.g. wss://sync.example.com
 */

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from './lib/store.js';
import { Tokens } from './lib/tokens.js';
import { buildInvite } from './lib/invite.js';
import { PROTOCOL_VERSION, describeRecord } from './lib/records.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '9223', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || join(here, 'data');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const MASS_DELETE_MIN = 30;
const MASS_DELETE_RATIO = 0.9;
const AUTH_TIMEOUT_MS = 10000;
// Before its hello is accepted a client sends nothing but the hello (well
// under 1 KB), so a socket that sends more is dropped as the bytes arrive
// instead of being buffered up to maxPayload.
const PRE_AUTH_MAX_BYTES = 16 * 1024;
const HEARTBEAT_MS = 30000;

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(join(DATA_DIR, 'sync-state.json'));
const tokens = new Tokens(join(DATA_DIR, 'tokens.json'));

/* Mark: token bootstrap */

let bootstrapToken = '';
let generatedToken = false;
if (SYNC_TOKEN) {
  tokens.register(SYNC_TOKEN, 'env');
  bootstrapToken = SYNC_TOKEN;
} else if (tokens.count === 0) {
  bootstrapToken = tokens.generate('default');
  generatedToken = true;
}

function printInvite() {
  const line = '='.repeat(68);
  console.log(line);
  if (bootstrapToken) {
    console.log('  Paste this invite into the Twilight Sync popup on each device:');
    console.log(`  ${buildInvite({ publicUrl: PUBLIC_URL, port: PORT, token: bootstrapToken })}`);
    if (generatedToken) {
      console.log('');
      console.log('  Save it now: this token was generated and tokens.json keeps only');
      console.log('  its hash, so it can never be printed again. Set SYNC_TOKEN to own');
      console.log('  the token and make the invite reprintable.');
    }
  } else {
    console.log('  A token exists but cannot be shown (tokens.json stores hashes only).');
    console.log('  Set SYNC_TOKEN, or delete tokens.json to generate a new one.');
  }
  if (!PUBLIC_URL) {
    console.log('');
    console.log('  Tip: set PUBLIC_URL (e.g. wss://sync.example.com) so the invite');
    console.log('  advertises the address your devices actually reach.');
  }
  console.log(line);
}

if (process.argv.includes('--invite')) {
  printInvite();
  process.exit(bootstrapToken ? 0 : 1);
}

/* Mark: logging */

function logState(label) {
  const c = store.counts();
  console.log(
    `[state] ${label} | v${store.version} gen=${store.generation} | spaces:${c.space || 0} ` +
      `tabs:${c.tab || 0} folders:${c.folder || 0} splits:${c.split || 0} ` +
      `containers:${c.container || 0} shortcuts:${c.key || 0}`
  );
}

/* Mark: connections */

const clients = new Map(); // ws → { deviceId, name, platform, since, alive }

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg, except = null) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== except && ws.readyState === 1) ws.send(data);
  }
}

function deviceList() {
  return [...clients.values()].map(({ deviceId, name, platform, since }) => ({ deviceId, name, platform, since }));
}

function broadcastDevices() {
  broadcast({ type: 'devices', devices: deviceList() });
}

function handleHello(ws, msg) {
  if (msg.protocol !== PROTOCOL_VERSION) {
    send(ws, {
      type: 'error',
      code: 'protocol_mismatch',
      protocol: PROTOCOL_VERSION,
      message: `Server speaks protocol v${PROTOCOL_VERSION}, client v${msg.protocol}`,
    });
    ws.close(4003, 'protocol mismatch');
    return false;
  }
  if (!tokens.verify(msg.token)) {
    send(ws, { type: 'error', code: 'auth_failed', message: 'Invalid token' });
    ws.close(4001, 'unauthorized');
    return false;
  }
  const deviceId = typeof msg.deviceId === 'string' && msg.deviceId ? msg.deviceId.slice(0, 64) : randomBytes(8).toString('hex');
  // A device reconnecting before its old socket timed out replaces it.
  for (const [other, info] of clients) {
    if (info.deviceId === deviceId && other !== ws) {
      clients.delete(other);
      other.terminate();
    }
  }
  clients.set(ws, {
    deviceId,
    name: String(msg.deviceName || 'Unknown').slice(0, 80),
    platform: String(msg.platform || '').slice(0, 16),
    since: Date.now(),
    alive: true,
  });
  send(ws, {
    type: 'welcome',
    protocol: PROTOCOL_VERSION,
    deviceId,
    generation: store.generation,
    version: store.version,
    records: store.recordsPayload(),
    devices: deviceList(),
  });
  console.log(`[conn] ${msg.deviceName || deviceId} connected (${msg.platform || '?'}, ${msg.client || '?'})`);
  broadcastDevices();
  return true;
}

function handlePut(ws, info, msg) {
  const records = Array.isArray(msg.records) ? msg.records : [];
  const deleted = Array.isArray(msg.deleted) ? msg.deleted : [];
  // Mass-deletion guard (second line behind the client's capture guard).
  // Only deletions of existing records count, so a replayed batch can't wedge.
  const effective = store.effectiveDeletions(deleted);
  const current = store.size;
  if (!msg.force && current > MASS_DELETE_MIN && effective > current * MASS_DELETE_RATIO) {
    console.warn(`[${info.name}] put rejected: ${effective}/${current} deletions`);
    send(ws, { type: 'put_rejected', reqId: msg.reqId, reason: 'mass_delete', wouldDelete: effective, current });
    return;
  }
  const result = store.put({ records, deleted }, info.deviceId);
  if (result.changed.length || result.removed.length) {
    console.log(`[${info.name}] put: ${result.changed.length} upserted, ${result.removed.length} deleted`);
    for (const r of result.changed.slice(0, 20)) console.log(`    + ${describeRecord(r)}`);
    if (result.changed.length > 20) console.log(`    … ${result.changed.length - 20} more`);
    for (const id of result.removed.slice(0, 20)) console.log(`    - ${id}`);
  }
  for (const r of result.rejected) console.warn(`[${info.name}] rejected ${r.id}: ${r.reason}`);
  send(ws, { type: 'put_ok', reqId: msg.reqId, accepted: result.accepted, rejected: result.rejected, version: store.version });
  if (result.changed.length || result.removed.length) {
    broadcast(
      { type: 'changes', records: result.changed, deleted: result.removed, version: store.version, source: info.deviceId },
      ws
    );
  }
}

function handleReplace(ws, info, msg) {
  // Compare-and-swap on the version, so two devices pushing at once can't
  // silently clobber each other: the loser re-prompts.
  if (typeof msg.baseVersion === 'number' && msg.baseVersion !== store.version) {
    console.warn(`[${info.name}] replace conflict (base v${msg.baseVersion}, now v${store.version})`);
    send(ws, { type: 'replace_conflict', reqId: msg.reqId, version: store.version, counts: store.counts() });
    return;
  }
  const result = store.replace(Array.isArray(msg.records) ? msg.records : [], info.deviceId);
  for (const r of result.rejected) console.warn(`[${info.name}] replace rejected ${r.id}: ${r.reason}`);
  logState(`${info.name} replaced the state`);
  send(ws, {
    type: 'replace_ok',
    reqId: msg.reqId,
    accepted: result.accepted,
    generation: store.generation,
    version: store.version,
  });
  broadcast(
    { type: 'state', generation: store.generation, version: store.version, records: store.recordsPayload(), source: info.deviceId },
    ws
  );
}

function handleAdmin(ws, info, msg) {
  if (msg.action === 'reset') {
    // New generation, and every device (this one included) is switched off so
    // no capture loop silently repopulates the state.
    store.reset();
    logState(`${info.name} reset the server`);
    send(ws, { type: 'admin_ok', action: 'reset' });
    broadcast({ type: 'force_disable', reason: 'admin_reset' });
  } else if (msg.action === 'disable_all') {
    console.log(`[${info.name}] disabled sync on all devices`);
    send(ws, { type: 'admin_ok', action: 'disable_all' });
    broadcast({ type: 'force_disable', reason: 'admin' });
  } else {
    send(ws, { type: 'error', code: 'bad_request', message: 'unknown admin action' });
  }
}

/* Mark: servers */

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, devices: clients.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Twilight Sync server. Connect with the browser extension.\n');
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024 },
});

// Any path upgrades, so reverse-proxy subpaths work unchanged.
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    // Counts raw socket bytes (`head` is pushed back into the socket, so it
    // is counted too) until the connection authenticates.
    let metering = true;
    let received = 0;
    const meter = chunk => {
      if (!metering) return;
      received += chunk.length;
      if (received > PRE_AUTH_MAX_BYTES) socket.destroy();
    };
    socket.on('data', meter);
    const authenticated = () => {
      metering = false;
      socket.off('data', meter);
    };
    wss.emit('connection', ws, req, authenticated);
  });
});

wss.on('connection', (ws, req, authenticated) => {
  let authed = false;
  const authTimer = setTimeout(() => {
    if (!authed) {
      send(ws, { type: 'error', code: 'auth_timeout', message: 'Authentication timeout' });
      ws.close(4002, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('pong', () => {
    const info = clients.get(ws);
    if (info) info.alive = true;
  });

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: 'error', code: 'bad_request', message: 'Invalid JSON' });
      return;
    }
    if (!authed) {
      if (msg?.type !== 'hello') {
        send(ws, { type: 'error', code: 'auth_required', message: 'Say hello first' });
        return;
      }
      authed = handleHello(ws, msg);
      if (authed) {
        clearTimeout(authTimer);
        authenticated();
      }
      return;
    }
    const info = clients.get(ws);
    if (!info) return;
    try {
      switch (msg.type) {
        case 'put':
          handlePut(ws, info, msg);
          break;
        case 'fetch':
          send(ws, { type: 'state', generation: store.generation, version: store.version, records: store.recordsPayload() });
          break;
        case 'replace':
          handleReplace(ws, info, msg);
          break;
        case 'admin':
          handleAdmin(ws, info, msg);
          break;
        case 'ping':
          send(ws, { type: 'pong', t: msg.t });
          break;
        default:
          send(ws, { type: 'error', code: 'bad_request', message: `Unknown message type ${msg.type}` });
      }
    } catch (e) {
      console.error('[server] message handling failed:', e);
      send(ws, { type: 'error', code: 'internal', message: 'Internal error' });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    const info = clients.get(ws);
    if (info) {
      clients.delete(ws);
      console.log(`[conn] ${info.name} disconnected`);
      broadcastDevices();
    }
  });

  ws.on('error', e => console.warn('[conn] socket error:', e.message));
});

// Server-side heartbeat: drop sockets that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const [ws, info] of clients) {
    if (!info.alive) {
      ws.terminate();
      continue;
    }
    info.alive = false;
    try {
      ws.ping();
    } catch {}
  }
}, HEARTBEAT_MS);
heartbeat.unref();

const gc = setInterval(() => {
  const dropped = store.gcTombstones();
  if (dropped) console.log(`[gc] dropped ${dropped} expired tombstones`);
}, 24 * 60 * 60 * 1000);
gc.unref();
store.gcTombstones();

httpServer.listen(PORT, HOST, () => {
  console.log(`Twilight Sync server on ${HOST}:${PORT} (protocol v${PROTOCOL_VERSION}, data ${DATA_DIR})`);
  logState('startup');
  if (bootstrapToken) printInvite();
});

function shutdown(signal) {
  console.log(`[server] ${signal}: saving state`);
  store.flush();
  for (const [ws] of clients) ws.close(1001, 'server shutting down');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

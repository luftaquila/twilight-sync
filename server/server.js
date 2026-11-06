#!/usr/bin/env node
/**
 * Twilight Sync server — a single-process WebSocket relay with a persistent
 * record map. See extension/common/protocol.js for the wire protocol; the
 * message handling itself is lib/hub.js, shared with the Cloudflare Worker
 * (worker.js).
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
import { WebSocketServer } from 'ws';
import { Store } from './lib/store.js';
import { Tokens } from './lib/tokens.js';
import { Hub } from './lib/hub.js';
import { buildInvite } from './lib/invite.js';
import { PROTOCOL_VERSION } from './lib/records.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '9223', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || join(here, 'data');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
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

/* Mark: connections */

const clients = new Map(); // ws → { deviceId, name, platform, since }
const alive = new WeakMap(); // ws → answered the last heartbeat ping

const hub = new Hub({
  store,
  verifyToken: token => tokens.verify(token),
  transport: {
    send(ws, text) {
      if (ws.readyState === 1) ws.send(text);
    },
    close(ws, code, reason) {
      ws.close(code, reason);
    },
    drop(ws) {
      ws.terminate();
    },
    info: ws => clients.get(ws) || null,
    register(ws, info) {
      clients.set(ws, info);
      alive.set(ws, true);
    },
    unregister(ws) {
      clients.delete(ws);
    },
    clients: () => clients.entries(),
  },
});

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
  const authTimer = setTimeout(() => {
    if (!clients.has(ws)) {
      hub.send(ws, { type: 'error', code: 'auth_timeout', message: 'Authentication timed out' });
      ws.close(4002, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('pong', () => alive.set(ws, true));

  ws.on('message', raw => {
    if (hub.receive(ws, raw)) {
      clearTimeout(authTimer);
      authenticated();
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    const info = clients.get(ws);
    if (info) {
      clients.delete(ws);
      console.log(`[conn] ${info.name} disconnected`);
      hub.broadcastDevices();
    }
  });

  ws.on('error', e => console.warn('[conn] socket error:', e.message));
});

// Server-side heartbeat: drop sockets that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const [ws] of clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
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
  hub.logState('startup');
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

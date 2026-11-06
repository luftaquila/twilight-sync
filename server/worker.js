/**
 * Twilight Sync server as a Cloudflare Worker: one Durable Object (`SyncRoom`)
 * holds the record map in its SQLite storage and the devices' WebSockets
 * (Hibernation API, so an idle room costs no duration). Message handling is
 * lib/hub.js, shared with the Node server.
 *
 * Secret: SYNC_TOKEN (the token devices present in their hello).
 */
import { DurableObject } from 'cloudflare:workers';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hub } from './lib/hub.js';
import { FORMAT, SyncState, emptyState } from './lib/state.js';
import { PROTOCOL_VERSION } from './lib/records.js';

const ROOM = 'default';
const AUTH_TIMEOUT_MS = 10000;
// Before its hello is accepted a client sends nothing but the hello.
const PRE_AUTH_MAX_BYTES = 16 * 1024;

const sha256 = text => createHash('sha256').update(String(text)).digest();

/** Per-socket state that survives hibernation: { connectedAt, info?, dropped?, closed? }. */
function attachment(ws) {
  try {
    return ws.deserializeAttachment() || {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const room = env.SYNC.get(env.SYNC.idFromName(ROOM));
    // Any path upgrades, so the Worker can sit behind a route with a path.
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return room.fetch(request);
    if (new URL(request.url).pathname === '/healthz') return room.fetch(request);
    return new Response('Twilight Sync server. Connect with the browser extension.\n', {
      headers: { 'content-type': 'text/plain' },
    });
  },
};

export class SyncRoom extends DurableObject {
  #state = null;
  #hub;

  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK (id = 1), format INTEGER, generation TEXT, version INTEGER, updated_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, kind TEXT, data TEXT, digest TEXT, seq INTEGER, device TEXT, updated_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY, seq INTEGER, deleted_at INTEGER)`);

    this.#hub = new Hub({
      store: () => this.#store(),
      verifyToken: token => this.#verifyToken(token),
      transport: {
        send(ws, text) {
          try {
            ws.send(text);
          } catch {}
        },
        close(ws, code, reason) {
          try {
            ws.close(code, reason);
          } catch {}
        },
        drop(ws) {
          try {
            ws.close(4000, 'replaced by a newer connection');
          } catch {}
        },
        info: ws => attachment(ws).info || null,
        register(ws, info) {
          ws.serializeAttachment({ ...attachment(ws), info });
        },
        unregister(ws) {
          const { info, ...rest } = attachment(ws);
          try {
            ws.serializeAttachment({ ...rest, dropped: true });
          } catch {}
        },
        clients: () =>
          ctx
            .getWebSockets()
            .map(ws => [ws, attachment(ws).info])
            .filter(([, info]) => info),
      },
    });
  }

  #verifyToken(token) {
    if (!this.env.SYNC_TOKEN) {
      console.error('[server] SYNC_TOKEN is not set; every device is refused');
      return false;
    }
    if (typeof token !== 'string' || !token) return false;
    return timingSafeEqual(sha256(token), sha256(this.env.SYNC_TOKEN));
  }

  /** The record map, loaded on first use after a (re)start or hibernation. */
  #store() {
    if (this.#state) return this.#state;
    const sql = this.ctx.storage.sql;
    const meta = sql.exec('SELECT format, generation, version, updated_at FROM meta WHERE id = 1').toArray()[0];
    let state;
    let fresh = false;
    if (meta && meta.format === FORMAT && meta.generation) {
      state = { format: FORMAT, generation: meta.generation, version: meta.version, updatedAt: meta.updated_at, records: {}, tombstones: {} };
      for (const r of sql.exec('SELECT id, kind, data, digest, seq, device, updated_at FROM records')) {
        state.records[r.id] = { kind: r.kind, data: JSON.parse(r.data), digest: r.digest, seq: r.seq, device: r.device, updatedAt: r.updated_at };
      }
      for (const t of sql.exec('SELECT id, seq, deleted_at FROM tombstones')) {
        state.tombstones[t.id] = { seq: t.seq, deletedAt: t.deleted_at };
      }
    } else {
      state = emptyState();
      fresh = true;
    }
    this.#state = new SyncState(state, { onChange: () => this.#persist() });
    if (fresh) {
      this.#state.markAll();
      this.#persist();
    }
    const dropped = this.#state.gcTombstones();
    if (dropped) console.log(`[gc] dropped ${dropped} expired tombstones`);
    return this.#state;
  }

  /** Writes what changed since the last write, in one transaction. */
  #persist() {
    const sync = this.#state;
    const dirty = sync.takeDirty();
    const { records, tombstones } = sync.state;
    const sql = this.ctx.storage.sql;
    const writeRecord = id => {
      const r = records[id];
      sql.exec(
        'INSERT OR REPLACE INTO records (id, kind, data, digest, seq, device, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, r.kind, JSON.stringify(r.data), r.digest, r.seq, r.device ?? null, r.updatedAt
      );
    };
    const writeTombstone = id => {
      const t = tombstones[id];
      sql.exec('INSERT OR REPLACE INTO tombstones (id, seq, deleted_at) VALUES (?, ?, ?)', id, t.seq, t.deletedAt);
    };
    this.ctx.storage.transactionSync(() => {
      if (dirty.all) {
        sql.exec('DELETE FROM records');
        sql.exec('DELETE FROM tombstones');
        for (const id of Object.keys(records)) writeRecord(id);
        for (const id of Object.keys(tombstones)) writeTombstone(id);
      } else {
        for (const id of dirty.records) {
          if (records[id]) writeRecord(id);
          else sql.exec('DELETE FROM records WHERE id = ?', id);
        }
        for (const id of dirty.tombstones) {
          if (tombstones[id]) writeTombstone(id);
          else sql.exec('DELETE FROM tombstones WHERE id = ?', id);
        }
      }
      const s = sync.state;
      sql.exec(
        'INSERT OR REPLACE INTO meta (id, format, generation, version, updated_at) VALUES (1, ?, ?, ?, ?)',
        s.format, s.generation, s.version, s.updatedAt
      );
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const devices = this.ctx.getWebSockets().filter(ws => attachment(ws).info).length;
      return Response.json({ ok: true, protocol: PROTOCOL_VERSION, devices, configured: !!this.env.SYNC_TOKEN });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: Date.now() });
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + AUTH_TIMEOUT_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (!attachment(ws).info) {
      // UTF-16 length never exceeds the UTF-8 byte length.
      const size = typeof message === 'string' ? message.length : message.byteLength;
      if (size > PRE_AUTH_MAX_BYTES) {
        ws.close(1009, 'too large before authentication');
        return;
      }
    }
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    this.#hub.receive(ws, text);
  }

  async webSocketClose(ws, code) {
    this.#closed(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing');
    } catch {}
  }

  async webSocketError(ws) {
    this.#closed(ws);
  }

  #closed(ws) {
    const { info } = attachment(ws);
    if (!info) return;
    try {
      ws.serializeAttachment({ closed: true });
    } catch {}
    console.log(`[conn] ${info.name} disconnected`);
    this.#hub.broadcastDevices(ws);
  }

  /** Closes sockets that did not authenticate in time. */
  async alarm() {
    const now = Date.now();
    let next = null;
    for (const ws of this.ctx.getWebSockets()) {
      const { info, connectedAt = 0, dropped, closed } = attachment(ws);
      if (info || dropped || closed) continue;
      const due = connectedAt + AUTH_TIMEOUT_MS;
      if (due <= now) {
        this.#hub.send(ws, { type: 'error', code: 'auth_timeout', message: 'Authentication timed out' });
        try {
          ws.close(4002, 'auth timeout');
        } catch {}
      } else {
        next = next === null ? due : Math.min(next, due);
      }
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

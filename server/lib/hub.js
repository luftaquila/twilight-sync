import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, describeRecord } from './records.js';

export const MASS_DELETE_MIN = 30;
export const MASS_DELETE_RATIO = 0.9;

/**
 * Protocol v1 message handling (see extension/common/protocol.js), shared by
 * the Node server and the Cloudflare Durable Object. The socket layer is a
 * `transport`:
 *   send(conn, text)          deliver one message if the socket is open
 *   close(conn, code, reason) close with a code the client acts on
 *   drop(conn)                discard a stale socket
 *   info(conn)                device info of an authenticated socket, else null
 *   register(conn, info)      mark a socket authenticated
 *   unregister(conn)          forget a socket (it stays open until dropped)
 *   clients()                 [conn, info] of every authenticated socket
 * `store` is a SyncState or a function returning one (loaded on first use, so
 * pings never touch storage).
 */
export class Hub {
  #store;
  #transport;
  #verifyToken;

  constructor({ store, transport, verifyToken }) {
    this.#store = typeof store === 'function' ? store : () => store;
    this.#transport = transport;
    this.#verifyToken = verifyToken;
  }

  get store() {
    return this.#store();
  }

  send(conn, msg) {
    this.#transport.send(conn, JSON.stringify(msg));
  }

  broadcast(msg, except = null) {
    const data = JSON.stringify(msg);
    for (const [conn] of this.#transport.clients()) {
      if (conn !== except) this.#transport.send(conn, data);
    }
  }

  deviceList(exclude = null) {
    return [...this.#transport.clients()]
      .filter(([conn]) => conn !== exclude)
      .map(([, { deviceId, name, platform, since }]) => ({ deviceId, name, platform, since }));
  }

  /** After a socket closed; `exclude` is the closed socket if the transport still lists it. */
  broadcastDevices(exclude = null) {
    const msg = JSON.stringify({ type: 'devices', devices: this.deviceList(exclude) });
    for (const [conn] of this.#transport.clients()) {
      if (conn !== exclude) this.#transport.send(conn, msg);
    }
  }

  logState(label) {
    const c = this.store.counts();
    console.log(
      `[state] ${label} | v${this.store.version} gen=${this.store.generation} | spaces:${c.space || 0} ` +
        `tabs:${c.tab || 0} folders:${c.folder || 0} splits:${c.split || 0} ` +
        `containers:${c.container || 0} shortcuts:${c.key || 0}`
    );
  }

  /**
   * Handles one incoming text message. Returns true when it authenticated the
   * socket (the transport then lifts its pre-authentication limits).
   */
  receive(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(conn, { type: 'error', code: 'bad_request', message: 'Invalid JSON' });
      return false;
    }
    const info = this.#transport.info(conn);
    if (!info) {
      if (msg?.type !== 'hello') {
        this.send(conn, { type: 'error', code: 'auth_required', message: 'Not authenticated' });
        return false;
      }
      return this.#hello(conn, msg);
    }
    try {
      switch (msg.type) {
        case 'put':
          this.#put(conn, info, msg);
          break;
        case 'fetch':
          this.send(conn, { type: 'state', generation: this.store.generation, version: this.store.version, records: this.store.recordsPayload() });
          break;
        case 'replace':
          this.#replace(conn, info, msg);
          break;
        case 'admin':
          this.#admin(conn, info, msg);
          break;
        case 'ping':
          this.send(conn, { type: 'pong', t: msg.t });
          break;
        default:
          this.send(conn, { type: 'error', code: 'bad_request', message: `Unknown message type ${msg.type}` });
      }
    } catch (e) {
      console.error('[server] message handling failed:', e);
      this.send(conn, { type: 'error', code: 'internal', message: 'Internal error' });
    }
    return false;
  }

  #hello(conn, msg) {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.send(conn, {
        type: 'error',
        code: 'protocol_mismatch',
        protocol: PROTOCOL_VERSION,
        message: `Server uses protocol v${PROTOCOL_VERSION}, client v${msg.protocol}`,
      });
      this.#transport.close(conn, 4003, 'protocol mismatch');
      return false;
    }
    if (!this.#verifyToken(msg.token)) {
      this.send(conn, { type: 'error', code: 'auth_failed', message: 'Invalid token' });
      this.#transport.close(conn, 4001, 'unauthorized');
      return false;
    }
    const deviceId = typeof msg.deviceId === 'string' && msg.deviceId ? msg.deviceId.slice(0, 64) : randomBytes(8).toString('hex');
    // A device reconnecting before its old socket timed out replaces it.
    for (const [other, info] of [...this.#transport.clients()]) {
      if (info.deviceId === deviceId && other !== conn) {
        this.#transport.unregister(other);
        this.#transport.drop(other);
      }
    }
    this.#transport.register(conn, {
      deviceId,
      name: String(msg.deviceName || 'Unknown').slice(0, 80),
      platform: String(msg.platform || '').slice(0, 16),
      since: Date.now(),
    });
    this.send(conn, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      deviceId,
      generation: this.store.generation,
      version: this.store.version,
      records: this.store.recordsPayload(),
      devices: this.deviceList(),
    });
    console.log(`[conn] ${msg.deviceName || deviceId} connected (${msg.platform || '?'}, ${msg.client || '?'})`);
    this.broadcastDevices();
    return true;
  }

  #put(conn, info, msg) {
    const store = this.store;
    const records = Array.isArray(msg.records) ? msg.records : [];
    const deleted = Array.isArray(msg.deleted) ? msg.deleted : [];
    // Mass-deletion guard (second line behind the client's capture guard).
    // Only deletions of existing records count, so a replayed batch can't wedge.
    const effective = store.effectiveDeletions(deleted);
    const current = store.size;
    if (!msg.force && current > MASS_DELETE_MIN && effective > current * MASS_DELETE_RATIO) {
      console.warn(`[${info.name}] put rejected: ${effective}/${current} deletions`);
      this.send(conn, { type: 'put_rejected', reqId: msg.reqId, reason: 'mass_delete', wouldDelete: effective, current });
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
    this.send(conn, { type: 'put_ok', reqId: msg.reqId, accepted: result.accepted, rejected: result.rejected, version: store.version });
    if (result.changed.length || result.removed.length) {
      this.broadcast(
        { type: 'changes', records: result.changed, deleted: result.removed, version: store.version, source: info.deviceId },
        conn
      );
    }
  }

  #replace(conn, info, msg) {
    const store = this.store;
    // Compare-and-swap on the version, so two devices pushing at once can't
    // silently clobber each other: the loser re-prompts.
    if (typeof msg.baseVersion === 'number' && msg.baseVersion !== store.version) {
      console.warn(`[${info.name}] replace conflict (base v${msg.baseVersion}, now v${store.version})`);
      this.send(conn, { type: 'replace_conflict', reqId: msg.reqId, version: store.version, counts: store.counts() });
      return;
    }
    const result = store.replace(Array.isArray(msg.records) ? msg.records : [], info.deviceId);
    for (const r of result.rejected) console.warn(`[${info.name}] replace rejected ${r.id}: ${r.reason}`);
    this.logState(`${info.name} replaced the state`);
    this.send(conn, {
      type: 'replace_ok',
      reqId: msg.reqId,
      accepted: result.accepted,
      generation: store.generation,
      version: store.version,
    });
    this.broadcast(
      { type: 'state', generation: store.generation, version: store.version, records: store.recordsPayload(), source: info.deviceId },
      conn
    );
  }

  #admin(conn, info, msg) {
    if (msg.action === 'reset') {
      // New generation, and every device (this one included) is switched off so
      // no capture loop silently repopulates the state.
      this.store.reset();
      this.logState(`${info.name} reset the server`);
      this.send(conn, { type: 'admin_ok', action: 'reset' });
      this.broadcast({ type: 'force_disable', reason: 'admin_reset' });
    } else if (msg.action === 'disable_all') {
      console.log(`[${info.name}] disabled sync on all devices`);
      this.send(conn, { type: 'admin_ok', action: 'disable_all' });
      this.broadcast({ type: 'force_disable', reason: 'admin' });
    } else {
      this.send(conn, { type: 'error', code: 'bad_request', message: 'Unknown admin action' });
    }
  }
}

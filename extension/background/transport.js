/**
 * WebSocket transport for protocol v1: hello handshake, exponential-backoff
 * reconnect, application heartbeat. Knows nothing about records.
 */

import { PROTOCOL_VERSION } from '../common/protocol.js';

const HEARTBEAT_MS = 25000;
const STALE_MS = 70000;
const MAX_BACKOFF_MS = 30000;

export default class Transport {
  #ws = null;
  #config = null;
  #handlers;
  #status = 'disconnected';
  #wantConnected = false;
  #attempt = 0;
  #reconnectTimer = null;
  #heartbeatTimer = null;
  #lastReceived = 0;
  #welcomed = false;

  constructor(handlers) {
    this.#handlers = handlers;
    globalThis.addEventListener?.('online', () => {
      if (this.#wantConnected && !this.#ws) {
        this.#attempt = 0;
        this.#openSoon(0);
      }
    });
  }

  get status() {
    return this.#status;
  }

  get connected() {
    return this.#welcomed && this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(config) {
    this.disconnect({ quiet: true });
    this.#config = config;
    this.#wantConnected = true;
    this.#attempt = 0;
    this.#open();
  }

  disconnect({ quiet = false } = {}) {
    this.#wantConnected = false;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    if (this.#ws) {
      const ws = this.#ws;
      this.#ws = null;
      this.#welcomed = false;
      try {
        ws.close(1000, 'client disconnect');
      } catch {}
    }
    if (!quiet) this.#setStatus('disconnected');
  }

  send(msg) {
    if (!this.connected) return false;
    try {
      this.#ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  #setStatus(status, detail = null) {
    if (this.#status === status && !detail) return;
    this.#status = status;
    this.#handlers.onStatus?.(status, detail);
  }

  #openSoon(delay) {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  #scheduleReconnect() {
    if (!this.#wantConnected) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.#attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.#attempt = Math.min(this.#attempt + 1, 10);
    this.#setStatus('reconnecting', { retryInMs: delay });
    this.#openSoon(delay);
  }

  #open() {
    if (!this.#wantConnected || !this.#config) return;
    this.#setStatus(this.#attempt ? 'reconnecting' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(this.#config.serverUrl);
    } catch (e) {
      this.#handlers.onError?.(`Bad server URL: ${e.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.#welcomed = false;

    ws.onopen = () => {
      if (this.#ws !== ws) return;
      const { token, deviceId, deviceName, platform, client } = this.#config;
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token, deviceId, deviceName, platform, client }));
    };

    ws.onmessage = event => {
      if (this.#ws !== ws) return;
      this.#lastReceived = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.#welcomed = true;
        this.#attempt = 0;
        this.#startHeartbeat();
        this.#setStatus('connected');
      } else if (msg.type === 'error' && !this.#welcomed) {
        if (msg.code === 'auth_failed') {
          this.#wantConnected = false;
          this.#setStatus('auth_failed', { message: msg.message });
        } else if (msg.code === 'protocol_mismatch') {
          this.#wantConnected = false;
          this.#setStatus('protocol_mismatch', { server: msg.protocol, client: PROTOCOL_VERSION });
        }
      } else if (msg.type === 'pong') {
        return;
      }
      this.#handlers.onMessage?.(msg);
    };

    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#welcomed = false;
      this.#stopHeartbeat();
      this.#handlers.onClosed?.();
      if (this.#wantConnected) {
        this.#scheduleReconnect();
      } else if (this.#status !== 'auth_failed' && this.#status !== 'protocol_mismatch') {
        this.#setStatus('disconnected');
      }
    };

    ws.onerror = () => {
      // onclose follows and handles the reconnect.
    };
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#lastReceived = Date.now();
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#ws) return;
      if (Date.now() - this.#lastReceived > STALE_MS) {
        // Half-open connection (sleep/wake, network change): a close
        // handshake would hang, so abandon the socket and redial now.
        const old = this.#ws;
        this.#ws = null;
        this.#welcomed = false;
        this.#stopHeartbeat();
        try {
          old.close(4000, 'stale');
        } catch {}
        this.#handlers.onClosed?.();
        this.#scheduleReconnect();
        return;
      }
      this.send({ type: 'ping', t: Date.now() });
    }, HEARTBEAT_MS);
  }

  #stopHeartbeat() {
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }
}

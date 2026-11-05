// Minimal Marionette (protocol 3) client — enough to run chrome-context
// scripts, install a temporary add-on, and handle modal prompts.
import net from 'node:net';

export class Marionette {
  #socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();

  static async connect(port, { timeoutMs = 120000, host = '127.0.0.1' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await Marionette.#connectOnce(port, host);
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`marionette :${port} unreachable: ${e.message}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  static #connectOnce(port, host) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      const client = new Marionette();
      client.#socket = socket;
      let greeted = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('handshake timeout'));
      }, 5000);
      socket.on('error', e => {
        clearTimeout(timer);
        if (!greeted) reject(e);
        else client.#failAll(e);
      });
      socket.on('data', chunk => {
        client.#buffer = Buffer.concat([client.#buffer, chunk]);
        for (;;) {
          const msg = client.#read();
          if (msg === null) break;
          if (!greeted) {
            greeted = true;
            clearTimeout(timer);
            resolve(client);
            continue;
          }
          client.#dispatch(msg);
        }
      });
      socket.on('close', () => client.#failAll(new Error('marionette socket closed')));
    });
  }

  #read() {
    const colon = this.#buffer.indexOf(0x3a);
    if (colon === -1) return null;
    const len = Number.parseInt(this.#buffer.subarray(0, colon).toString(), 10);
    if (!Number.isFinite(len)) throw new Error('bad marionette frame');
    if (this.#buffer.length < colon + 1 + len) return null;
    const body = this.#buffer.subarray(colon + 1, colon + 1 + len).toString('utf-8');
    this.#buffer = this.#buffer.subarray(colon + 1 + len);
    return JSON.parse(body);
  }

  #dispatch(msg) {
    if (!Array.isArray(msg) || msg[0] !== 1) return;
    const waiter = this.#pending.get(msg[1]);
    if (!waiter) return;
    this.#pending.delete(msg[1]);
    if (msg[2]) waiter.reject(new Error(`${msg[2].error}: ${msg[2].message}`));
    else waiter.resolve(msg[3]);
  }

  #failAll(err) {
    for (const [, w] of this.#pending) w.reject(err);
    this.#pending.clear();
  }

  send(name, params = {}) {
    const id = this.#nextId++;
    const frame = JSON.stringify([0, id, name, params]);
    this.#socket.write(`${Buffer.byteLength(frame)}:${frame}`);
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async newSession() {
    await this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore' } } });
    await this.send('WebDriver:SetTimeouts', { script: 120000 });
    await this.send('Marionette:SetContext', { value: 'chrome' });
  }

  async exec(script, args = []) {
    return (await this.send('WebDriver:ExecuteScript', { script, args }))?.value;
  }

  async execAsync(script, args = []) {
    return (await this.send('WebDriver:ExecuteAsyncScript', { script, args }))?.value;
  }

  installAddon(path) {
    return this.send('Addon:Install', { path, temporary: true });
  }

  async alertText() {
    try {
      return (await this.send('WebDriver:GetAlertText'))?.value ?? null;
    } catch {
      return null;
    }
  }

  async acceptAlert() {
    try {
      await this.send('WebDriver:AcceptAlert');
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.#socket.destroy();
    } catch {}
  }
}

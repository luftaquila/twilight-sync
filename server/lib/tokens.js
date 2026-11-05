import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const hash = token => createHash('sha256').update(String(token)).digest('hex');

/**
 * Bearer tokens, stored as SHA-256 hashes only (tokens.json, mode 0600).
 * SYNC_TOKEN from the environment is registered idempotently, which makes
 * the invite reprintable; an auto-generated token is shown once.
 */
export class Tokens {
  #file;
  #tokens;

  constructor(file) {
    this.#file = file;
    this.#tokens = this.#load();
  }

  #load() {
    try {
      if (existsSync(this.#file)) return JSON.parse(readFileSync(this.#file, 'utf-8'));
    } catch (e) {
      console.error('[tokens] unreadable token file; starting empty:', e.message);
    }
    return {};
  }

  #save() {
    writeFileSync(this.#file, JSON.stringify(this.#tokens, null, 2), { mode: 0o600 });
  }

  get count() {
    return Object.keys(this.#tokens).length;
  }

  register(token, name) {
    const h = hash(token);
    if (!this.#tokens[h]) {
      this.#tokens[h] = { name, createdAt: Date.now() };
      this.#save();
    }
  }

  generate(name) {
    const token = randomBytes(32).toString('hex');
    this.register(token, name);
    return token;
  }

  verify(token) {
    if (typeof token !== 'string' || !token) return false;
    const candidate = Buffer.from(hash(token), 'hex');
    for (const h of Object.keys(this.#tokens)) {
      const known = Buffer.from(h, 'hex');
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) return true;
    }
    return false;
  }
}

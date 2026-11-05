import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { recordDigest, validateRecord } from './records.js';

const FORMAT = 1;
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 500;

function emptyState() {
  return {
    format: FORMAT,
    generation: randomBytes(8).toString('hex'),
    version: 0,
    records: {},
    tombstones: {},
    updatedAt: Date.now(),
  };
}

/**
 * The server's record map. Every write bumps a monotonic `version`; each
 * record remembers the version (`seq`) of its last change, which is the only
 * conflict clock (client wall clocks are never trusted).
 */
export class Store {
  #file;
  #saveTimer = null;
  state;

  constructor(file) {
    this.#file = file;
    this.state = this.#load();
  }

  #load() {
    try {
      if (existsSync(this.#file)) {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf-8'));
        if (parsed.format === FORMAT && parsed.generation) {
          parsed.records ||= {};
          parsed.tombstones ||= {};
          return parsed;
        }
        console.error(`[store] unknown state format ${parsed.format}; starting fresh`);
      }
    } catch (e) {
      console.error('[store] unreadable state file; starting fresh:', e.message);
    }
    return emptyState();
  }

  scheduleSave() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.flush();
    }, SAVE_DELAY_MS);
    this.#saveTimer.unref?.();
  }

  /** Atomic write (tmp + rename). */
  flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    try {
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.#file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }

  get generation() {
    return this.state.generation;
  }

  get version() {
    return this.state.version;
  }

  recordsPayload() {
    return Object.entries(this.state.records).map(([id, r]) => ({ id, kind: r.kind, data: r.data }));
  }

  counts() {
    const counts = {};
    for (const r of Object.values(this.state.records)) counts[r.kind] = (counts[r.kind] || 0) + 1;
    return counts;
  }

  get size() {
    return Object.keys(this.state.records).length;
  }

  /** Deletions that would remove an existing record (replays don't count). */
  effectiveDeletions(ids) {
    return (ids || []).filter(id => typeof id === 'string' && this.state.records[id]).length;
  }

  /**
   * Applies upserts and deletions. A record whose digest equals the stored
   * one is a no-op (no version bump, no broadcast), so ack-lost re-uploads
   * never echo through the fleet.
   */
  put({ records = [], deleted = [] }, deviceId) {
    const changed = [];
    const removed = [];
    const accepted = [];
    const rejected = [];
    const now = Date.now();

    for (const record of records) {
      const problem = validateRecord(record);
      if (problem) {
        rejected.push({ id: typeof record?.id === 'string' ? record.id : '?', reason: problem });
        continue;
      }
      accepted.push(record.id);
      const digest = recordDigest(record.kind, record.data);
      const existing = this.state.records[record.id];
      if (existing && existing.digest === digest) continue;
      this.state.version++;
      this.state.records[record.id] = {
        kind: record.kind,
        data: record.data,
        digest,
        seq: this.state.version,
        device: deviceId,
        updatedAt: now,
      };
      delete this.state.tombstones[record.id];
      changed.push({ id: record.id, kind: record.kind, data: record.data });
    }

    const upserted = new Set(changed.map(r => r.id));
    const remove = id => {
      this.state.version++;
      delete this.state.records[id];
      this.state.tombstones[id] = { seq: this.state.version, deletedAt: now };
      removed.push(id);
    };
    for (const id of deleted) {
      if (typeof id !== 'string' || !id || id === 'layout') continue;
      accepted.push(id);
      const existing = this.state.records[id];
      if (!existing) continue;
      remove(id);
      if (existing.kind === 'space') {
        // Cascade: a racing update can otherwise durably orphan records that
        // still point at the deleted space. Records upserted in the same
        // message keep their new placement.
        for (const [rid, rec] of Object.entries(this.state.records)) {
          if (!upserted.has(rid) && rec.data?.workspaceUuid === id) remove(rid);
        }
      }
    }

    if (changed.length || removed.length) {
      this.state.updatedAt = now;
      this.scheduleSave();
    }
    return { changed, removed, accepted, rejected };
  }

  /** Replaces everything (the "push this device" flow). */
  replace(records, deviceId) {
    const accepted = [];
    const rejected = [];
    const now = Date.now();
    this.state.records = {};
    this.state.tombstones = {};
    for (const record of records || []) {
      const problem = validateRecord(record);
      if (problem) {
        rejected.push({ id: typeof record?.id === 'string' ? record.id : '?', reason: problem });
        continue;
      }
      this.state.version++;
      this.state.records[record.id] = {
        kind: record.kind,
        data: record.data,
        digest: recordDigest(record.kind, record.data),
        seq: this.state.version,
        device: deviceId,
        updatedAt: now,
      };
      accepted.push(record.id);
    }
    this.state.updatedAt = now;
    this.scheduleSave();
    return { accepted, rejected };
  }

  /** Wipes everything under a NEW generation (clients must re-negotiate). */
  reset() {
    this.state = emptyState();
    this.scheduleSave();
  }

  gcTombstones() {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    let dropped = 0;
    for (const [id, t] of Object.entries(this.state.tombstones)) {
      if ((t.deletedAt || 0) < cutoff) {
        delete this.state.tombstones[id];
        dropped++;
      }
    }
    if (dropped) this.scheduleSave();
    return dropped;
  }
}

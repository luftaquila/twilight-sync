import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { FORMAT, SyncState, emptyState } from './state.js';

const SAVE_DELAY_MS = 500;

function load(file) {
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
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

/** The record map persisted as one JSON file (`sync-state.json`), written atomically and debounced. */
export class Store extends SyncState {
  #file;
  #saveTimer = null;

  constructor(file) {
    super(load(file), { onChange: () => this.scheduleSave() });
    this.#file = file;
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
    this.takeDirty();
    try {
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.#file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }
}

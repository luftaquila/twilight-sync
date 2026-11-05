import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1;

export const RECORD_KINDS = new Set(['container', 'space', 'tab', 'folder', 'split', 'layout', 'key']);
export const LAYOUT_RECORD_ID = 'layout';
export const KEY_ID_PREFIX = 'key:';

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 16 * 1024;
const MAX_TITLE_LENGTH = 2048;
const MAX_ICON_LENGTH = 128 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const KEY_MODS = new Set(['alt', 'ctrl', 'meta', 'shift']);

function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedClone(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

/** Same canonical form the extension uses (sorted keys, undefined → null). */
export function canonicalJSON(value) {
  return JSON.stringify(sortedClone(value));
}

/** Server-side content digest: makes ack-lost re-uploads idempotent. */
export function recordDigest(kind, data) {
  return createHash('sha256').update(canonicalJSON({ kind, data })).digest('base64');
}

export function isSyncableUrl(url) {
  return typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:'));
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isIdList = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length <= MAX_ID_LENGTH);

/**
 * Validates (and lightly sanitizes) one record in place.
 * Returns null when acceptable, or a short reason.
 */
export function validateRecord(record) {
  if (!isObject(record)) return 'not an object';
  const { id, kind, data } = record;
  if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) return 'bad id';
  if (!RECORD_KINDS.has(kind)) return `unknown kind ${kind}`;
  if (!isObject(data)) return 'bad data';

  switch (kind) {
    case 'tab':
      if (data.tabId !== id) return 'tabId mismatch';
      if (!isSyncableUrl(data.url) || data.url.length > MAX_URL_LENGTH) return 'tab url must be http(s)';
      if (typeof data.title === 'string' && data.title.length > MAX_TITLE_LENGTH) {
        data.title = data.title.slice(0, MAX_TITLE_LENGTH);
      }
      break;
    case 'space':
      if (data.uuid !== id) return 'uuid mismatch';
      if (data.children !== undefined && !isIdList(data.children)) return 'bad children';
      break;
    case 'folder':
      if (data.folderId !== id) return 'folderId mismatch';
      if (data.children !== undefined && !isIdList(data.children)) return 'bad children';
      break;
    case 'split':
      if (data.splitId !== id) return 'splitId mismatch';
      if (!isIdList(data.tabs) || data.tabs.length < 2) return 'bad split tabs';
      break;
    case 'container':
      if (data.guid !== id) return 'guid mismatch';
      if (typeof data.name !== 'string' || !data.name) return 'container needs a name';
      break;
    case 'layout':
      if (id !== LAYOUT_RECORD_ID) return 'layout id must be "layout"';
      if (data.spaces !== undefined && !isIdList(data.spaces)) return 'bad layout spaces';
      break;
    case 'key': {
      if (typeof data.keyId !== 'string' || !data.keyId || id !== KEY_ID_PREFIX + data.keyId) return 'key id mismatch';
      if (!Array.isArray(data.mods) || !data.mods.every(m => KEY_MODS.has(m))) return 'bad modifiers';
      if (!data.cleared) {
        const hasKey = typeof data.key === 'string' && data.key.length > 0 && data.key.length <= 32;
        const hasCode = typeof data.keycode === 'string' && data.keycode.length > 0 && data.keycode.length <= 64;
        if (!hasKey && !hasCode) return 'shortcut needs a key or keycode';
      }
      break;
    }
  }

  // Icons on any kind are capped: one oversized data: blob would bloat every
  // future welcome/state payload.
  if (typeof data.icon === 'string' && data.icon.length > MAX_ICON_LENGTH) {
    data.icon = kind === 'tab' ? '' : null;
  }
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_RECORD_BYTES) return 'record too large';
  return null;
}

export function describeRecord(record) {
  const d = record.data || {};
  switch (record.kind) {
    case 'tab': {
      const kind = d.essential ? 'essential' : d.pinned ? 'pinned' : 'open';
      return `tab(${kind}) ${(d.url || '').slice(0, 80)}`;
    }
    case 'space':
      return `space "${d.name}"`;
    case 'folder':
      return `folder "${d.name}"`;
    case 'split':
      return `split ×${d.tabs?.length ?? 0}`;
    case 'container':
      return `container "${d.name}"`;
    case 'layout':
      return `layout (${d.spaces?.length ?? 0} spaces)`;
    case 'key':
      return d.cleared ? `shortcut ${d.keyId} (cleared)` : `shortcut ${d.keyId} = ${[...(d.mods || []), d.key || d.keycode].join('+')}`;
    default:
      return record.kind;
  }
}

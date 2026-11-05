// Loads the chrome-side engine scripts into a Node vm context with minimal
// shims, so their pure parts (records, projection, keymap, diff) can be
// unit-tested without a browser.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const engineDir = join(dirname(fileURLToPath(import.meta.url)), '../../extension/experiments/twilight');

export function sha256(str) {
  return createHash('sha256').update(str).digest('base64');
}

export function loadEngine(files, globals = {}) {
  const ctx = {
    console,
    URL,
    URLSearchParams,
    Services: {
      io: {
        newURI(spec) {
          // Only .query is used (moz-remote-image unwrapping).
          const q = spec.indexOf('?');
          return { query: q === -1 ? '' : spec.slice(q + 1) };
        },
      },
      uuid: { generateUUID: () => ({ toString: () => `{${randomUUID()}}` }) },
    },
    ...globals,
  };
  vm.createContext(ctx);
  for (const file of files) {
    vm.runInContext(readFileSync(join(engineDir, file), 'utf-8'), ctx, { filename: file });
  }
  ctx.TS.util?.setHasher(sha256);
  return ctx.TS;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../helpers/engine.mjs';

const { keys } = loadEngine(['util.js', 'keys.js']);
const plain = x => JSON.parse(JSON.stringify(x));
const PLATFORMS = ['macosx', 'win', 'linux'];

test('CustomKeys capture formats map to physical modifiers', () => {
  // macOS capture: Ctrl → "control", Cmd → "accel"
  assert.deepEqual(plain(keys.toCanonicalMods('control,shift', 'macosx', 'physical')), ['ctrl', 'shift']);
  assert.deepEqual(plain(keys.toCanonicalMods('accel', 'macosx', 'physical')), ['meta']);
  // Windows/Linux capture: Ctrl → "accel", Super → "meta"
  assert.deepEqual(plain(keys.toCanonicalMods('accel,alt', 'win', 'physical')), ['alt', 'ctrl']);
  assert.deepEqual(plain(keys.toCanonicalMods('meta', 'linux', 'physical')), ['meta']);
  assert.deepEqual(plain(keys.toCanonicalMods('control', 'linux', 'physical')), ['ctrl']);
  assert.equal(keys.toCanonicalMods('access', 'win', 'physical'), null);
});

test('local → canonical → local round-trips to the capture format on every platform', () => {
  const captured = {
    macosx: ['control', 'accel', 'accel,shift', 'alt,control', 'accel,alt,control,shift', ''],
    win: ['accel', 'accel,shift', 'alt', 'accel,alt,shift'],
    linux: ['accel', 'meta', 'accel,meta,shift', 'alt,shift'],
  };
  for (const platform of PLATFORMS) {
    for (const mapping of ['physical', 'swap']) {
      for (const mods of captured[platform]) {
        const canon = keys.toCanonicalMods(mods, platform, mapping);
        assert.equal(keys.toLocalMods(canon, platform, mapping), mods, `${platform}/${mapping}/${mods}`);
      }
    }
  }
});

test('physical mapping: Ctrl on a Mac is Ctrl on Windows and Linux', () => {
  const canon = keys.toCanonicalMods('control,shift', 'macosx', 'physical');
  assert.equal(keys.toLocalMods(canon, 'win', 'physical'), 'accel,shift');
  assert.equal(keys.toLocalMods(canon, 'linux', 'physical'), 'accel,shift');
  // ⌘ maps to Super; Windows can't bind the Win key.
  const cmd = keys.toCanonicalMods('accel', 'macosx', 'physical');
  assert.equal(keys.toLocalMods(cmd, 'linux', 'physical'), 'meta');
  assert.equal(keys.toLocalMods(cmd, 'win', 'physical'), null);
});

test('swap mapping (macOS only): ⌘ ↔ Ctrl across platforms', () => {
  const cmdT = keys.toCanonicalMods('accel', 'macosx', 'swap');
  assert.deepEqual(plain(cmdT), ['ctrl']);
  assert.equal(keys.toLocalMods(cmdT, 'win', 'physical'), 'accel');
  // ...and Windows' Ctrl comes back as ⌘ on that Mac.
  const winCtrl = keys.toCanonicalMods('accel', 'win', 'physical');
  assert.equal(keys.toLocalMods(winCtrl, 'macosx', 'swap'), 'accel');
  // swap is ignored off macOS
  assert.deepEqual(plain(keys.toCanonicalMods('accel', 'win', 'swap')), ['ctrl']);
});

test('fromLocal / toLocal', () => {
  assert.deepEqual(plain(keys.fromLocal('k', {}, 'win', 'physical')), { keyId: 'k', mods: [], key: null, keycode: null, cleared: true });
  assert.deepEqual(plain(keys.fromLocal('k', { modifiers: 'accel', key: 't' }, 'win', 'physical')), {
    keyId: 'k',
    mods: ['ctrl'],
    key: 'T',
    keycode: null,
    cleared: false,
  });
  assert.deepEqual(plain(keys.fromLocal('k', { modifiers: 'shift', keycode: 'VK_F5' }, 'linux', 'physical')), {
    keyId: 'k',
    mods: ['shift'],
    key: null,
    keycode: 'VK_F5',
    cleared: false,
  });
  assert.deepEqual(plain(keys.toLocal({ keyId: 'k', cleared: true, mods: [] }, 'macosx', 'physical')), {});
  assert.deepEqual(plain(keys.toLocal({ keyId: 'k', mods: ['ctrl'], key: 'T', cleared: false }, 'macosx', 'physical')), {
    modifiers: 'control',
    key: 'T',
  });
  assert.equal(keys.toLocal({ keyId: 'k', mods: ['meta'], key: 'T', cleared: false }, 'win', 'physical'), null);
});

test('a record survives every platform pair unchanged (no ping-pong)', () => {
  const records = [
    { keyId: 'a', mods: ['ctrl', 'shift'], key: 'T', keycode: null, cleared: false },
    { keyId: 'b', mods: ['alt'], key: null, keycode: 'VK_F2', cleared: false },
    { keyId: 'c', mods: [], key: null, keycode: null, cleared: true },
  ];
  for (const platform of PLATFORMS) {
    for (const mapping of ['physical', 'swap']) {
      for (const record of records) {
        const local = keys.toLocal(record, platform, mapping);
        const back = keys.fromLocal(record.keyId, local, platform, mapping);
        assert.ok(keys.sameBinding(back, record), `${platform}/${mapping}/${record.keyId}`);
      }
    }
  }
});

test('sameBinding ignores key case and modifier order', () => {
  assert.ok(keys.sameBinding({ mods: ['shift', 'ctrl'], key: 't' }, { mods: ['ctrl', 'shift'], key: 'T' }));
  assert.ok(!keys.sameBinding({ mods: ['ctrl'], key: 'T' }, { mods: ['ctrl', 'shift'], key: 'T' }));
  assert.ok(keys.sameBinding({ cleared: true }, { cleared: true, mods: [] }));
});

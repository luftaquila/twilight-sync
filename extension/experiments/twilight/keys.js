/*
 * twilight-sync engine — keyboard shortcut sync.
 *
 * Firefox's CustomKeys (about:keyboard; Zen moved its own shortcuts there in
 * 1.24b, gh-16163) keeps customizations in <profile>/customKeys.json as
 *   { "<key element id>": { modifiers: "accel,shift", key: "T" } | {} }
 * where {} means "shortcut cleared". It has no change notification and its
 * state object is module-private, so the file is watched (mtime poll) and
 * changes are applied through CustomKeys.changeKey/clearKey/resetKey, which
 * update every open window live.
 *
 * Cross-OS model. CustomKeys stores modifiers per platform (macOS: Ctrl key
 * → "control", Cmd → "accel"; Windows/Linux: Ctrl → "accel", Super → "meta").
 * Records carry PHYSICAL modifiers instead: ctrl | alt | shift | meta (meta =
 * Cmd on macOS, Super/Win elsewhere). Each device converts with a bijection,
 * so a record round-trips unchanged and devices never ping-pong:
 *   physical (default)  Ctrl ↔ Ctrl,  Cmd ↔ Super
 *   swap (macOS only)   Cmd ↔ Ctrl,   Ctrl ↔ Super   — for keymaps built
 *                       around Cmd that should feel native on Windows/Linux
 * Windows cannot bind the Win key (GlobalKeyListener ignores it, bug
 * 1100862); a record that needs it is skipped there, never mangled.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const FILE_NAME = "customKeys.json";
  const POLL_MS = 2000;
  // After we apply, CustomKeys saves its file ~1.5 s later; until then the
  // file still shows the pre-apply state and must not be diffed.
  const APPLY_SETTLE_MS = 5000;

  /* Mark: pure mapping (unit-tested) */

  const swapCtrlMeta = m => (m === "ctrl" ? "meta" : m === "meta" ? "ctrl" : m);

  /** CustomKeys modifier string → sorted physical modifiers, or null if unportable. */
  function toCanonicalMods(modifiers, platform, mapping) {
    const out = new Set();
    for (const raw of String(modifiers || "").split(/[\s,]+/)) {
      const m = raw.trim().toLowerCase();
      if (!m) {
        continue;
      }
      switch (m) {
        case "shift":
          out.add("shift");
          break;
        case "alt":
          out.add("alt");
          break;
        case "control":
          out.add("ctrl");
          break;
        case "accel":
          out.add(platform === "macosx" ? "meta" : "ctrl");
          break;
        case "meta":
        case "os":
          out.add("meta");
          break;
        default:
          // "access" and anything unknown has no portable meaning.
          return null;
      }
    }
    let mods = [...out];
    if (platform === "macosx" && mapping === "swap") {
      mods = mods.map(swapCtrlMeta);
    }
    return mods.sort();
  }

  /** Physical modifiers → CustomKeys modifier string, or null if not bindable here. */
  function toLocalMods(mods, platform, mapping) {
    let list = Array.isArray(mods) ? [...mods] : [];
    if (platform === "macosx" && mapping === "swap") {
      list = list.map(swapCtrlMeta);
    }
    const out = new Set();
    for (const m of list) {
      switch (m) {
        case "shift":
          out.add("shift");
          break;
        case "alt":
          out.add("alt");
          break;
        case "ctrl":
          out.add(platform === "macosx" ? "control" : "accel");
          break;
        case "meta":
          if (platform === "win") {
            return null;
          }
          out.add(platform === "macosx" ? "accel" : "meta");
          break;
        default:
          return null;
      }
    }
    // Same shape CustomKeys' capture produces: sorted, comma-joined.
    return [...out].sort().join(",");
  }

  /** A CustomKeys binding → record data, or null if unportable. */
  function fromLocal(keyId, binding, platform, mapping) {
    const key = typeof binding?.key === "string" && binding.key ? binding.key.toUpperCase() : null;
    const keycode = typeof binding?.keycode === "string" && binding.keycode ? binding.keycode : null;
    if (!key && !keycode) {
      return { keyId, mods: [], key: null, keycode: null, cleared: true };
    }
    const mods = toCanonicalMods(binding.modifiers, platform, mapping);
    if (!mods) {
      return null;
    }
    return { keyId, mods, key, keycode: key ? null : keycode, cleared: false };
  }

  /** Record data → CustomKeys binding ({} = cleared), or null if not bindable here. */
  function toLocal(data, platform, mapping) {
    if (data?.cleared) {
      return {};
    }
    const modifiers = toLocalMods(data?.mods, platform, mapping);
    if (modifiers === null || (!data?.key && !data?.keycode)) {
      return null;
    }
    const binding = { modifiers };
    if (data.key) {
      binding.key = data.key;
    } else {
      binding.keycode = data.keycode;
    }
    return binding;
  }

  function sameBinding(a, b) {
    const norm = d => ({
      mods: d?.cleared ? [] : [...(d?.mods || [])].sort(),
      key: d?.cleared ? null : d?.key ? String(d.key).toUpperCase() : null,
      keycode: d?.cleared ? null : d?.keycode || null,
      cleared: !!d?.cleared,
    });
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  }

  /* Mark: chrome integration */

  let local = null; // { mtime, data }
  let staleUntil = 0;
  let staleMtime = null;
  let pollTimer = null;

  function filePath() {
    return TS.PathUtils.join(TS.PathUtils.profileDir, FILE_NAME);
  }

  function mapping() {
    return TS.capture?.options?.keyMapping === "swap" ? "swap" : "physical";
  }

  /** Re-reads customKeys.json if it changed. Resolves true when it did. */
  async function refresh() {
    let mtime = 0;
    try {
      const info = await TS.IOUtils.stat(filePath());
      mtime = info.lastModified || 0;
    } catch (e) {
      mtime = 0;
    }
    if (local && local.mtime === mtime) {
      return false;
    }
    let data = {};
    if (mtime) {
      try {
        data = (await TS.IOUtils.readJSON(filePath())) || {};
      } catch (e) {
        // Mid-write or corrupt: keep the previous view, retry next poll.
        return false;
      }
    }
    local = { mtime, data };
    if (staleMtime !== null && mtime !== staleMtime) {
      // CustomKeys flushed our apply: the file is authoritative again.
      staleUntil = 0;
      staleMtime = null;
    }
    return true;
  }

  function isStale() {
    return !local || Date.now() < staleUntil;
  }

  /**
   * Default binding of a shortcut on this device, as record data.
   * undefined = cannot tell (element missing or not localized yet).
   */
  function defaultRecordOf(keyId) {
    const win = TS.env.primaryWindow();
    const el = win?.document.getElementById(keyId);
    if (!el || el.localName !== "key") {
      return undefined;
    }
    const CK = TS.env.modules.CustomKeys;
    const original = CK?.getDefaultKey(keyId);
    const binding = original || {
      modifiers: el.getAttribute("modifiers") || "",
      key: el.getAttribute("key") || "",
      keycode: el.getAttribute("keycode") || "",
    };
    if (!binding.key && !binding.keycode) {
      return undefined;
    }
    return fromLocal(keyId, binding, TS.env.platform, mapping()) || undefined;
  }

  /**
   * Key records for the projection.
   *
   * @param {object} uploaded - the baseline (TS.store uploaded map)
   * @param {boolean} enabled - shortcut sync option
   * @returns {{records: Array, pending: Array}}
   */
  function project(uploaded, enabled) {
    const K = TS.util.RECORD_KINDS;
    const baselineIds = Object.keys(uploaded).filter(id => uploaded[id]?.k === K.KEY);
    if (!enabled || !TS.env.modules.CustomKeys || isStale()) {
      const pending = new Set(baselineIds);
      for (const keyId of Object.keys(local?.data || {})) {
        pending.add(TS.util.keyRecordId(keyId));
      }
      return { records: [], pending: [...pending] };
    }
    const records = [];
    const pending = [];
    const platform = TS.env.platform;
    const map = mapping();
    for (const [keyId, binding] of Object.entries(local.data)) {
      const id = TS.util.keyRecordId(keyId);
      const data = fromLocal(keyId, binding, platform, map);
      if (data) {
        records.push({ id, data });
      } else {
        pending.push(id);
      }
    }
    // A synced customization CustomKeys folded back into "default" (because
    // it equals this platform's default) is still the same shortcut: project
    // the synced record so it neither re-uploads nor reads as a deletion.
    for (const id of baselineIds) {
      const keyId = id.slice(TS.util.KEY_ID_PREFIX.length);
      if (keyId in local.data) {
        continue;
      }
      const synced = uploaded[id].x;
      const def = defaultRecordOf(keyId);
      if (def === undefined) {
        pending.push(id);
      } else if (synced && sameBinding(def, synced)) {
        records.push({ id, data: synced });
      }
      // else: reset locally → deletion (the diff confirms absence)
    }
    return { records, pending };
  }

  /**
   * Applies key records. Returns ids that cannot be bound on this platform
   * (skipped: neither failed nor acknowledged).
   */
  function apply(upserts, deletions) {
    const CK = TS.env.modules.CustomKeys;
    const skipped = [];
    const failed = [];
    if (!CK) {
      return { skipped: upserts.map(r => r.id).concat(deletions), failed };
    }
    const platform = TS.env.platform;
    const map = mapping();
    let touched = false;
    for (const record of upserts) {
      const keyId = record.data?.keyId;
      if (!keyId || record.id !== TS.util.keyRecordId(keyId)) {
        failed.push(record.id);
        continue;
      }
      const binding = toLocal(record.data, platform, map);
      if (binding === null) {
        skipped.push(record.id);
        continue;
      }
      try {
        if (record.data.cleared) {
          CK.clearKey(keyId);
        } else {
          CK.changeKey(keyId, binding);
        }
        touched = true;
      } catch (e) {
        console.error(`TwilightSync: failed to apply shortcut ${keyId}`, e);
        failed.push(record.id);
      }
    }
    for (const id of deletions) {
      try {
        CK.resetKey(id.slice(TS.util.KEY_ID_PREFIX.length));
        touched = true;
      } catch (e) {
        failed.push(id);
      }
    }
    if (touched) {
      staleUntil = Date.now() + APPLY_SETTLE_MS;
      staleMtime = local?.mtime ?? 0;
    }
    return { skipped, failed };
  }

  /** Every local customization (for the initial "replace local" reconcile). */
  function localKeyIds() {
    return Object.keys(local?.data || {});
  }

  function resetLocal(keyIds) {
    const CK = TS.env.modules.CustomKeys;
    if (!CK) {
      return;
    }
    for (const keyId of keyIds) {
      try {
        CK.resetKey(keyId);
      } catch (e) {
        // ignore
      }
    }
    staleUntil = Date.now() + APPLY_SETTLE_MS;
    staleMtime = local?.mtime ?? 0;
  }

  function startWatching(onChange) {
    stopWatching();
    const tick = async () => {
      try {
        if (await refresh()) {
          onChange();
        } else if (staleUntil && Date.now() >= staleUntil) {
          // Settle window passed without a rewrite (the apply was a no-op).
          staleUntil = 0;
          staleMtime = null;
          onChange();
        }
      } catch (e) {
        // ignore
      }
    };
    pollTimer = TS.env.timer.setInterval(tick, POLL_MS);
    return refresh();
  }

  function stopWatching() {
    if (pollTimer) {
      TS.env.timer.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  TS.keys = {
    // pure
    toCanonicalMods,
    toLocalMods,
    fromLocal,
    toLocal,
    sameBinding,
    // chrome
    refresh,
    project,
    apply,
    localKeyIds,
    resetLocal,
    startWatching,
    stopWatching,
    isStale,
    markStale() {
      staleUntil = Date.now() + APPLY_SETTLE_MS;
      staleMtime = local?.mtime ?? 0;
    },
  };
})(this);

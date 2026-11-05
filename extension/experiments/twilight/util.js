/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Shared record helpers: canonical JSON, digests, URL/icon filters.
 * syncableIconUrl and canonicalJSON follow Zen's ZenSpacesSyncModel
 * (src/zen/sync) so digests stay comparable with upstream semantics.
 *
 * Pure apart from `Services.io` (icon unwrapping) and the hash provider,
 * both of which the Node unit tests shim.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const RECORD_KINDS = Object.freeze({
    CONTAINER: "container",
    SPACE: "space",
    TAB: "tab",
    FOLDER: "folder",
    SPLIT: "split",
    LAYOUT: "layout",
    KEY: "key",
  });

  const LAYOUT_RECORD_ID = "layout";
  const KEY_ID_PREFIX = "key:";

  // Everything gBrowser.setIcon accepts without a loading principal.
  const LOCAL_ICON_PROTOCOLS = ["data:", "chrome:", "about:", "resource:"];

  function isSyncableUrl(url) {
    return (
      typeof url === "string" &&
      (url.startsWith("http:") || url.startsWith("https:"))
    );
  }

  /**
   * Normalizes a tab or folder icon for syncing. moz-remote-image: wraps the
   * real (usually svg data:) favicon with a per-process id that means nothing
   * on another device, so the wrapped URL is synced instead. Remote favicons
   * are dropped: setIcon would refuse them without a principal anyway.
   */
  function syncableIconUrl(icon) {
    if (!icon || typeof icon !== "string") {
      return "";
    }
    if (icon.startsWith("moz-remote-image:")) {
      try {
        const uri = Services.io.newURI(icon);
        icon = new URLSearchParams(uri.query).get("url") || "";
      } catch (e) {
        return "";
      }
    }
    return LOCAL_ICON_PROTOCOLS.some(p => icon.startsWith(p)) ? icon : "";
  }

  function sortedClone(value) {
    if (Array.isArray(value)) {
      return value.map(sortedClone);
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sortedClone(value[key]);
      }
      return out;
    }
    return value === undefined ? null : value;
  }

  /** Deterministic JSON: recursively sorted keys, undefined → null. */
  function canonicalJSON(value) {
    return JSON.stringify(sortedClone(value));
  }

  /* Mark: hashing */

  let hasher = null;

  function nsSha256(str) {
    const Cc_ = typeof Cc !== "undefined" ? Cc : Components.classes;
    const Ci_ = typeof Ci !== "undefined" ? Ci : Components.interfaces;
    const h = Cc_["@mozilla.org/security/hash;1"].createInstance(
      Ci_.nsICryptoHash
    );
    h.init(Ci_.nsICryptoHash.SHA256);
    const bytes = TS.encodeUTF8(str);
    h.update(bytes, bytes.length);
    return h.finish(true);
  }

  // Equality-only fallback if nsICryptoHash is unavailable in this scope.
  function fnv64(str) {
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0xcbf29ce4 >>> 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ((c >> 8) | (c << 3)), 0x01000193) >>> 0;
    }
    return `fnv-${h1.toString(36)}-${h2.toString(36)}`;
  }

  function hash(str) {
    if (!hasher) {
      try {
        nsSha256("probe");
        hasher = nsSha256;
      } catch (e) {
        hasher = fnv64;
      }
    }
    return hasher(str);
  }

  /* Mark: hard / soft split */

  // A tab's title and (non-static) icon are volatile on a loaded page:
  // notification counters, badge favicons, two devices showing different
  // live titles for the same URL. They travel with the record but only count
  // as a change right after a hard change (see SETTLE_MS in model.js), so
  // two devices with the same page loaded never ping-pong over its title.
  function splitRecord(kind, data) {
    if (kind !== RECORD_KINDS.TAB || !data) {
      return { hard: data, soft: null };
    }
    const hard = { ...data };
    const soft = { title: hard.title ?? "" };
    delete hard.title;
    if (!data.hasStaticIcon) {
      soft.icon = hard.icon ?? "";
      delete hard.icon;
    }
    return { hard, soft };
  }

  function hardDigest(kind, data) {
    return hash(canonicalJSON({ kind, data: splitRecord(kind, data).hard }));
  }

  function softDigest(kind, data) {
    const { soft } = splitRecord(kind, data);
    return soft ? hash(canonicalJSON(soft)) : "";
  }

  function keyRecordId(keyId) {
    return KEY_ID_PREFIX + keyId;
  }

  TS.util = {
    RECORD_KINDS,
    LAYOUT_RECORD_ID,
    KEY_ID_PREFIX,
    isSyncableUrl,
    syncableIconUrl,
    canonicalJSON,
    hash,
    hardDigest,
    softDigest,
    splitRecord,
    keyRecordId,
    // Tests inject node's crypto here.
    setHasher(fn) {
      hasher = fn;
    },
  };
})(this);

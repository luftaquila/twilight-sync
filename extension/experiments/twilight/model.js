/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * twilight-sync engine — model: projections vs. the uploaded baseline.
 *
 * Container identity follows Zen's ZenSpacesSyncModel (userContextId → guid,
 * built-in containers as "builtin-N"). Change detection:
 *   - a record is CHANGED when its hard digest differs from the baseline, or
 *     its soft digest (tab title / icon) differs within SETTLE_MS of a hard
 *     change made here (so the title that arrives after a navigation still
 *     syncs, but live title churn never does)
 *   - a baseline id is DELETED only when its owning local object is confirmed
 *     absent — never because a projection skipped it this cycle
 * Echo prevention is stateless: applying a remote record stores the incoming
 * digests as the baseline, so a faithful materialization diffs to nothing and
 * a divergent one re-uploads local truth (self-healing).
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const SETTLE_MS = 20000;
  const BUILTIN_CONTAINER_MAX = 4;
  const BUILTIN_GUID_PREFIX = "builtin-";

  let cache = null;
  const settleUntil = new Map();
  // Unit tests drive the settle window through TS.now.
  const clock = () => (typeof TS.now === "function" ? TS.now() : Date.now());

  const util = () => TS.util;
  const store = () => TS.store.data();
  const CIS = () => TS.env.modules.ContextualIdentityService;

  /* Mark: container identity */

  // Zen's own Spaces sync keeps the same kind of userContextId → guid map
  // (zen-spaces-sync.json). Devices that synced through it share those guids
  // — built-in ones included, e.g. a "Work" container recreated as id 6 but
  // known everywhere as "builtin-2" — so they are adopted instead of minting
  // new ones; otherwise moving to Twilight Sync would duplicate containers.
  function nativeModel() {
    return TS.env?.modules?.ZenSpacesSyncModel || null;
  }

  function nativeGuidFor(id) {
    try {
      return nativeModel()?.guidForContextId(id) || null;
    } catch (e) {
      return null;
    }
  }

  function builtinIdOf(guid) {
    if (typeof guid !== "string" || !guid.startsWith(BUILTIN_GUID_PREFIX)) {
      return null;
    }
    const id = Number(guid.slice(BUILTIN_GUID_PREFIX.length));
    return Number.isSafeInteger(id) && id > 0 && id <= BUILTIN_CONTAINER_MAX ? id : null;
  }

  /** Whether a local container other than `id` already answers to `guid`. */
  function guidClaimedElsewhere(guid, id) {
    const containers = store().containers;
    if (Object.entries(containers).some(([k, g]) => g === guid && Number(k) !== id)) {
      return true;
    }
    // An existing built-in container is "builtin-N" by its own id.
    const builtin = builtinIdOf(guid);
    return (
      builtin !== null &&
      builtin !== id &&
      !(builtin in containers) &&
      !!CIS()?.getPublicIdentityFromId(builtin)
    );
  }

  function guidForContextId(userContextId, { create = false } = {}) {
    const id = Number(userContextId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return null;
    }
    const data = store();
    if (!CIS()?.getPublicIdentityFromId(id)) {
      // A space or tab still pointing at a deleted container.
      if (id in data.containers) {
        delete data.containers[id];
        TS.store.save();
      }
      return null;
    }
    const existing = data.containers[id];
    if (existing) {
      return existing;
    }
    if (id <= BUILTIN_CONTAINER_MAX) {
      return `${BUILTIN_GUID_PREFIX}${id}`;
    }
    const native = nativeGuidFor(id);
    if (native && !guidClaimedElsewhere(native, id)) {
      data.containers[id] = native;
      TS.store.save();
      return native;
    }
    if (!create) {
      return null;
    }
    const guid = Services.uuid.generateUUID().toString().slice(1, -1);
    data.containers[id] = guid;
    TS.store.save();
    return guid;
  }

  function contextIdForGuid(guid) {
    if (typeof guid !== "string" || !guid) {
      return null;
    }
    const data = store();
    for (const [id, mapped] of Object.entries(data.containers)) {
      if (mapped === guid) {
        const contextId = Number(id);
        if (CIS()?.getPublicIdentityFromId(contextId)) {
          return contextId;
        }
        delete data.containers[id];
        TS.store.save();
        return null;
      }
    }
    const builtin = builtinIdOf(guid);
    if (builtin !== null && !(builtin in data.containers) && CIS()?.getPublicIdentityFromId(builtin)) {
      return builtin;
    }
    // Known only to Zen's own sync on this profile (e.g. a built-in container
    // recreated under a new id): take its mapping over.
    let native = null;
    try {
      native = nativeModel()?.contextIdForGuid(guid) ?? null;
    } catch (e) {
      native = null;
    }
    if (native !== null && !(native in data.containers) && CIS()?.getPublicIdentityFromId(native)) {
      data.containers[native] = guid;
      TS.store.save();
      return native;
    }
    return null;
  }

  function registerContainerGuid(guid, userContextId) {
    store().containers[userContextId] = guid;
    TS.store.save();
  }

  /**
   * One-time switch, per profile, to Zen's own container guids for containers
   * this profile had already named itself before they were adopted (Twilight
   * Sync 1.0.0 minted fresh guids). The old guid is then confirmed absent and
   * deleted everywhere, the adopted one uploaded with every space and tab
   * that uses the container. Returns the userContextIds that switched.
   */
  function adoptNativeContainerGuids() {
    const data = store();
    if (data.nativeContainersAdopted) {
      return [];
    }
    const changed = [];
    for (const identity of CIS()?.getPublicIdentities() || []) {
      const id = identity.userContextId;
      if (id <= BUILTIN_CONTAINER_MAX) {
        continue;
      }
      const native = nativeGuidFor(id);
      if (native && data.containers[id] !== native && !guidClaimedElsewhere(native, id)) {
        data.containers[id] = native;
        changed.push(id);
      }
    }
    data.nativeContainersAdopted = true;
    TS.store.save();
    if (changed.length) {
      invalidate();
    }
    return changed;
  }

  /**
   * An incoming container nobody here knows may still be one this profile has
   * under a guid it never shared: same name, icon and color, not built-in,
   * unknown to Zen's own sync, its current guid neither uploaded from here nor
   * part of the incoming batch. That container takes the incoming guid
   * instead of a duplicate being created (two devices that each made "Work").
   *
   * @param {string} guid - the incoming guid (contextIdForGuid found nothing)
   * @param {{name: string, icon: string, color: string}} incoming
   * @param {Set<string>} batchGuids - every container guid in the batch
   * @returns {number|null} the userContextId now mapped to `guid`
   */
  function adoptMatchingContainer(guid, { name, icon, color }, batchGuids) {
    const data = store();
    for (const identity of CIS()?.getPublicIdentities() || []) {
      const id = identity.userContextId;
      if (id <= BUILTIN_CONTAINER_MAX || identity.name !== name) {
        continue;
      }
      if ((identity.icon || "") !== (icon || "") || (identity.color || "") !== (color || "")) {
        continue;
      }
      const mapped = data.containers[id];
      if (mapped && (data.uploaded[mapped] || batchGuids.has(mapped))) {
        continue;
      }
      if (nativeGuidFor(id)) {
        continue;
      }
      data.containers[id] = guid;
      TS.store.save();
      invalidate();
      return id;
    }
    return null;
  }

  function forgetContainerGuid(guid) {
    const data = store();
    for (const [id, mapped] of Object.entries(data.containers)) {
      if (mapped === guid) {
        delete data.containers[id];
        TS.store.save();
        return;
      }
    }
  }

  /* Mark: projection */

  function options() {
    return TS.capture?.options || { normalTabs: true, shortcuts: true, keyMapping: "physical" };
  }

  function current() {
    if (cache) {
      return cache;
    }
    const data = store();
    const opts = options();
    const sidebar = TS.sidebar.collect();
    const { map, pending } = TS.project.build(sidebar, {
      options: opts,
      guidForContextId,
      containerIdentities: () => CIS()?.getPublicIdentities() || [],
      liveFolderData: id => TS.env.modules.ZenLiveFoldersManager?.getSyncableFolderData(id) ?? null,
      holds: data.holds,
      keys: TS.keys.project(data.uploaded, !!opts.shortcuts),
      normalChildrenEcho: uuid => data.uploaded[uuid]?.x?.normalChildren || [],
    });
    const digests = new Map();
    for (const [id, rec] of map) {
      digests.set(id, {
        h: util().hardDigest(rec.kind, rec.data),
        s: util().softDigest(rec.kind, rec.data),
      });
    }
    cache = { map, pending, digests, sidebar };
    return cache;
  }

  function invalidate() {
    cache = null;
  }

  /* Mark: baseline */

  function entryFor(kind, data) {
    const entry = {
      k: kind,
      h: util().hardDigest(kind, data),
      s: util().softDigest(kind, data),
    };
    if (kind === util().RECORD_KINDS.TAB) {
      entry.p = !!(data?.pinned || data?.essential);
    } else if (kind === util().RECORD_KINDS.KEY) {
      // Kept whole: the default-equivalence check needs the binding.
      entry.x = data;
    } else if (kind === util().RECORD_KINDS.SPACE) {
      // Echoed by devices that don't sync open tabs.
      entry.x = { normalChildren: Array.isArray(data?.normalChildren) ? data.normalChildren : [] };
    }
    return entry;
  }

  /**
   * Confirms the local object owning `id` is really gone (the deletion
   * invariant). Anything uncertain answers false.
   */
  function confirmAbsent(id, entry) {
    const K = util().RECORD_KINDS;
    try {
      switch (entry.k) {
        case K.LAYOUT:
          return false;
        case K.KEY:
          // keys.project() already turned "can't tell" into pending and
          // default-equivalent into present.
          return true;
        case K.CONTAINER: {
          const mapped = contextIdForGuid(id);
          return mapped === null || !CIS()?.getPublicIdentityFromId(mapped);
        }
        case K.SPACE: {
          const win = TS.env.primaryWindow();
          return !!win && !win.gZenWorkspaces.getWorkspaces().some(s => s.uuid === id);
        }
        default: {
          // tab / folder / split: the record id is the element id, in any
          // synced window.
          return !!TS.env.primaryWindow() && !TS.env.findElement(id);
        }
      }
    } catch (e) {
      return false;
    }
  }

  /**
   * @returns {{changed: Array<{id, kind, data}>, deleted: Array<string>}}
   */
  function computeChanges() {
    const K = util().RECORD_KINDS;
    const { map, pending, digests } = current();
    const uploaded = store().uploaded;
    const opts = options();
    const now = clock();
    const changed = [];
    for (const [id, rec] of map) {
      const digest = digests.get(id);
      const base = uploaded[id];
      if (!base || base.k !== rec.kind || base.h !== digest.h) {
        changed.push({ id, kind: rec.kind, data: rec.data });
        settleUntil.set(id, now + SETTLE_MS);
      } else if (base.s !== digest.s && (settleUntil.get(id) || 0) > now) {
        changed.push({ id, kind: rec.kind, data: rec.data });
      }
    }
    const deleted = [];
    for (const [id, base] of Object.entries(uploaded)) {
      if (map.has(id) || pending.has(id)) {
        continue;
      }
      if (base.k === K.TAB && !base.p && !opts.normalTabs) {
        continue;
      }
      if (base.k === K.KEY && !opts.shortcuts) {
        continue;
      }
      if (confirmAbsent(id, base)) {
        deleted.push(id);
      }
    }
    for (const [id, until] of settleUntil) {
      if (until <= now) {
        settleUntil.delete(id);
      }
    }
    return { changed, deleted };
  }

  /** Server acknowledged a put: the baseline advances from the SENT payload. */
  function markUploaded({ records = [], deleted = [] }) {
    const uploaded = store().uploaded;
    for (const record of records) {
      if (record?.id && record.kind) {
        uploaded[record.id] = entryFor(record.kind, record.data);
      }
    }
    for (const id of deleted) {
      delete uploaded[id];
    }
    TS.store.save();
  }

  /** An incoming record was applied: its digests become the baseline. */
  function noteApplied(id, record) {
    const uploaded = store().uploaded;
    if (!record) {
      delete uploaded[id];
    } else {
      uploaded[id] = entryFor(record.kind, record.data);
    }
    settleUntil.delete(id);
    TS.store.save();
  }

  /** Whether a soft (title/icon) change of this record would upload now. */
  function wantsSoftUpdate(id) {
    if (!id) {
      return false;
    }
    return !store().uploaded[id] || (settleUntil.get(id) || 0) > clock();
  }

  function dropBaseline(id) {
    delete store().uploaded[id];
    TS.store.save();
  }

  /** Forget all shortcut baselines so the server's keymap re-applies here. */
  function dropKeyBaselines() {
    const uploaded = store().uploaded;
    for (const id of Object.keys(uploaded)) {
      if (uploaded[id]?.k === util().RECORD_KINDS.KEY) {
        delete uploaded[id];
      }
    }
    TS.store.save();
  }

  TS.model = {
    SETTLE_MS,
    guidForContextId,
    contextIdForGuid,
    registerContainerGuid,
    forgetContainerGuid,
    adoptNativeContainerGuids,
    adoptMatchingContainer,
    current,
    invalidate,
    computeChanges,
    markUploaded,
    noteApplied,
    wantsSoftUpdate,
    dropBaseline,
    dropKeyBaselines,
    entryFor,
    hardDigest: (kind, data) => util().hardDigest(kind, data),
    uploaded: () => store().uploaded,
    uploadedEntry: id => store().uploaded[id] || null,
    uploadedIds: () => Object.keys(store().uploaded),
    getGeneration: () => store().generation || null,
    setGeneration(generation) {
      store().generation = generation;
      TS.store.save();
    },
    resetBaseline() {
      const data = store();
      data.uploaded = {};
      data.holds = {};
      delete data.generation;
      settleUntil.clear();
      TS.store.save();
    },
    getHolds: () => store().holds,
    setHold(tabId, hold) {
      store().holds[tabId] = hold;
      TS.store.save();
    },
    dropHold(tabId) {
      const data = store();
      if (tabId in data.holds) {
        delete data.holds[tabId];
        TS.store.save();
        return true;
      }
      return false;
    },
  };
})(this);

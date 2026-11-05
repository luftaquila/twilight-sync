/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * twilight-sync engine — applier: incoming records → live browser.
 *
 * Ported from Zen's ZenSpacesSyncApplier (src/zen/sync, Twilight 1.25t) and
 * extended:
 *   - normal tabs: created without pinning; a remote navigation retargets an
 *     unloaded tab, quietly unloads-and-retargets a loaded tab nobody is
 *     using, and otherwise becomes a hold (never yanks a page in use)
 *   - keyboard shortcut records (keys.js)
 *   - apply-side mass-deletion guard and deferred (non-blocking) space
 *     deletion confirmation
 *   - folder nesting cycles broken before they reach the DOM
 *   - "replace local" reconcile pass driven by live browser state
 *   - records naming an unknown space fall back to the active one; the
 *     digest self-heal then re-uploads the real placement
 * Everything runs in the primary synced window; Zen's window sync mirrors it.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  // A loaded normal tab that hasn't been looked at for this long is not in
  // use: a remote navigation may unload it and point it at the new URL.
  const IDLE_RETARGET_MS = 3 * 60 * 1000;
  const IDLE_RETARGET_PREF = "extensions.twilightSync.idleRetargetMs";

  function idleRetargetMs() {
    try {
      return Services.prefs.getIntPref(IDLE_RETARGET_PREF, IDLE_RETARGET_MS);
    } catch (e) {
      return IDLE_RETARGET_MS;
    }
  }

  const K = () => TS.util.RECORD_KINDS;
  const M = () => TS.env.modules;

  let queue = Promise.resolve();
  let applying = 0;

  /* Mark: helpers */

  function itemIn(win, id) {
    return id ? win.document.getElementById(id) : null;
  }

  function handleTabMove(win, el, callback) {
    if (typeof win.gBrowser.zenHandleTabMove === "function") {
      win.gBrowser.zenHandleTabMove(el, callback);
    } else {
      callback();
    }
  }

  function resolveContainerId(containerGuid) {
    if (!containerGuid) {
      return 0;
    }
    const mapped = TS.model.contextIdForGuid(containerGuid);
    if (mapped === null) {
      // Its container record hasn't applied here yet: fail and redeliver.
      throw new Error(`unknown container ${containerGuid}`);
    }
    return mapped;
  }

  function resolveWorkspace(win, workspaceUuid) {
    if (!workspaceUuid) {
      return null;
    }
    if (win.gZenWorkspaces.getWorkspaces().some(s => s.uuid === workspaceUuid)) {
      return workspaceUuid;
    }
    console.warn(`TwilightSync: unknown space ${workspaceUuid}, using the active one`);
    return win.gZenWorkspaces.activeWorkspace || null;
  }

  function isPinnedKind(data) {
    return !!(data?.essential || data?.pinned);
  }

  /** Nothing the user could be looking at would be yanked. */
  function isUnloadedTab(tab) {
    return !tab.linkedPanel || tab.hasAttribute("pending");
  }

  function loadedTabUrl(tab) {
    try {
      const spec = tab.linkedBrowser?.currentURI?.spec;
      return spec && spec !== "about:blank" ? spec : null;
    } catch (e) {
      return null;
    }
  }

  function sessionUrl(win, tab) {
    try {
      const state = JSON.parse(win.SessionStore.getTabState(tab));
      const entries = state?.entries || [];
      if (!entries.length) {
        return { url: null, title: "" };
      }
      const index = Math.min(Math.max((state.index || entries.length) - 1, 0), entries.length - 1);
      return { url: entries[index]?.url || null, title: entries[index]?.title || "" };
    } catch (e) {
      return { url: null, title: "" };
    }
  }

  /** Copies of a tab across synced windows (one per window with full window sync). */
  function copiesOf(tabId) {
    const out = [];
    for (const win of TS.env.syncedWindows()) {
      const el = win.document.getElementById(tabId);
      if (el && win.gBrowser.isTab(el)) {
        out.push({ win, tab: el });
      }
    }
    return out;
  }

  function isVisible(win, tab) {
    if (tab.selected) {
      return true;
    }
    // A split view shows several tabs at once.
    try {
      const selected = win.gBrowser.selectedTab;
      return !!(tab.splitView && selected?.splitView && tab.group && tab.group === selected.group);
    } catch (e) {
      return false;
    }
  }

  /**
   * Whether a loaded normal tab can be unloaded and retargeted without the
   * user noticing: not visible in any window, not playing audio, not sharing
   * camera/screen, and idle for a while.
   */
  function canQuietlyRetarget(tabId) {
    for (const { win, tab } of copiesOf(tabId)) {
      if (isVisible(win, tab)) {
        return false;
      }
      if (tab.hasAttribute("soundplaying") || tab.hasAttribute("sharing")) {
        return false;
      }
      const last = tab.lastAccessed;
      if (Number.isFinite(last) && last > 0 && Date.now() - last < idleRetargetMs()) {
        return false;
      }
    }
    return true;
  }

  /* Mark: entry point */

  /**
   * Serialized so batches arriving back-to-back never interleave.
   *
   * @param {Array<{id, kind, data}>} records
   * @param {Array<string>} deleted
   * @param {object} opts - { reconcile, overrideGuard }
   * @returns {Promise<{failed: string[], skipped: string[], guard: ?object}>}
   */
  function apply(records, deleted, opts = {}) {
    const run = queue.then(async () => {
      applying++;
      try {
        return await applyBatch(records || [], deleted || [], opts);
      } finally {
        applying--;
        TS.capture?.afterApply();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  async function applyBatch(records, deleted, { reconcile = false, overrideGuard = false } = {}) {
    const kinds = K();
    const options = TS.capture?.options || { normalTabs: true, shortcuts: true };
    const incoming = {
      containers: [],
      spaces: [],
      tabs: [],
      folders: [],
      splits: [],
      keys: [],
      layout: null,
    };
    const handled = [];
    const skipped = new Set();
    for (const record of records) {
      if (typeof record?.id !== "string" || !record.id || !record.data || typeof record.data !== "object") {
        continue;
      }
      const entry = { key: record.id, data: record.data, record };
      switch (record.kind) {
        case kinds.CONTAINER:
          incoming.containers.push(entry);
          break;
        case kinds.SPACE:
          incoming.spaces.push(entry);
          break;
        case kinds.TAB:
          if (!isPinnedKind(record.data) && !options.normalTabs) {
            // Normal-tab sync is off here: leave it unacknowledged.
            skipped.add(record.id);
            continue;
          }
          incoming.tabs.push(entry);
          break;
        case kinds.FOLDER:
          incoming.folders.push(entry);
          break;
        case kinds.SPLIT:
          incoming.splits.push(entry);
          break;
        case kinds.LAYOUT:
          incoming.layout = entry;
          break;
        case kinds.KEY:
          if (!options.shortcuts) {
            skipped.add(record.id);
            continue;
          }
          incoming.keys.push(entry);
          break;
        default:
          // Unknown kind (newer peer): untouched and unacknowledged.
          skipped.add(record.id);
          continue;
      }
      handled.push(record);
    }
    const deletions = deleted
      .filter(id => typeof id === "string" && id && id !== TS.util.LAYOUT_RECORD_ID)
      .map(id => ({ key: id }));

    const failed = new Set();
    const fail = (entry, e) => {
      failed.add(entry.key);
      console.error(`TwilightSync: failed to apply ${entry.key}:`, e);
    };
    // Withheld (guard, pending confirmation): unacknowledged but not an
    // error — no retry loop; the guard prompt / confirmation resolves it.
    const withhold = entry => skipped.add(entry.key);

    // Container upserts first: tabs and spaces resolve containers through
    // them. Container deletions wait behind the window check and the guard.
    applyContainerUpserts(incoming.containers, fail);

    const win = TS.env.primaryWindow();
    if (!win) {
      for (const entry of [
        ...incoming.spaces,
        ...incoming.folders,
        ...incoming.tabs,
        ...incoming.splits,
        ...incoming.keys,
        ...(incoming.layout ? [incoming.layout] : []),
        ...deletions,
      ]) {
        failed.add(entry.key);
      }
      return { failed: [...failed], skipped: [...skipped], guard: null };
    }

    try {
      await M().SessionStore.promiseAllWindowsRestored;
    } catch (e) {
      // ignore
    }
    await win.gZenWorkspaces.promiseInitialized;

    let removals = routeTombstones(win, deletions, options);
    for (const id of removals.skipped) {
      // A tombstone for something this device doesn't sync right now stays
      // unacknowledged; reconnect reconciliation applies it once enabled.
      skipped.add(id);
    }
    let guard = null;
    if (!overrideGuard && !reconcile) {
      const wouldDelete =
        removals.tabs.length +
        removals.folders.length +
        removals.spaces.length +
        removals.splits.length +
        removals.containers.length +
        removals.keys.length;
      const localCount = TS.model.current().map.size;
      if (wouldDelete > 10 && wouldDelete > localCount * 0.5) {
        guard = { wouldDelete, localCount };
        removals = { ...emptyRemovals(), skipped: removals.skipped };
        for (const entry of deletions) {
          withhold(entry);
        }
        TS.env.diag(`apply guard held ${wouldDelete} deletions (${localCount} local)`);
      }
    }

    // A sync apply is a materialization like session restore: keep it
    // visually silent (no folder animations).
    win.gZenFolders._sessionRestoring = true;
    try {
      deleteContainers(removals.containers, fail);
      deleteTabs(win, removals.tabs, fail);
      deleteSplits(win, removals.splits, fail);
      await applySpaces(win, incoming.spaces, fail);
      await applyFolders(win, incoming.folders, fail);
      applyTabs(win, incoming.tabs, fail);
      applySplits(win, incoming.splits, fail);
      await deleteFolders(win, removals.folders, fail);
      await deleteSpaces(win, removals.spaces, fail, withhold, {
        skipConfirm: reconcile || overrideGuard,
      });
      applyOrdering(win, incoming, fail, options);
      if (reconcile) {
        await reconcileRemovals(win, records, options);
      }
    } finally {
      delete win.gZenFolders._sessionRestoring;
      TS.env.invalidateTabCaches();
    }

    // Keys last: independent of the sidebar, and CustomKeys touches every window.
    const keyResult = TS.keys.apply(
      incoming.keys.map(e => e.record),
      removals.keys.map(e => e.key)
    );
    for (const id of keyResult.skipped) {
      skipped.add(id);
    }
    for (const id of keyResult.failed) {
      failed.add(id);
    }

    TS.model.invalidate();
    for (const record of handled) {
      if (!failed.has(record.id) && !skipped.has(record.id)) {
        TS.model.noteApplied(record.id, { kind: record.kind, data: record.data });
      }
    }
    for (const entry of deletions) {
      if (!failed.has(entry.key) && !skipped.has(entry.key)) {
        TS.model.noteApplied(entry.key, null);
        TS.model.dropHold(entry.key);
      }
    }
    return { failed: [...failed], skipped: [...skipped], guard };
  }

  function emptyRemovals() {
    return { tabs: [], folders: [], splits: [], spaces: [], containers: [], keys: [], skipped: [] };
  }

  /**
   * Tombstones carry no payload: whatever local object owns the id decides
   * what kind of deletion it is. Ids with no local counterpart need no work.
   */
  function routeTombstones(win, deletions, options) {
    const routed = emptyRemovals();
    const spaces = win.gZenWorkspaces.getWorkspaces();
    for (const entry of deletions) {
      if (entry.key.startsWith(TS.util.KEY_ID_PREFIX)) {
        if (options.shortcuts) {
          routed.keys.push(entry);
        } else {
          routed.skipped.push(entry.key);
        }
        continue;
      }
      if (TS.model.contextIdForGuid(entry.key) !== null) {
        routed.containers.push(entry);
        continue;
      }
      const found = TS.env.findElement(entry.key);
      const el = found?.el;
      if (el && found.win.gBrowser.isTab(el)) {
        if (!options.normalTabs && !el.pinned) {
          routed.skipped.push(entry.key);
          continue;
        }
        routed.tabs.push(entry);
      } else if (el?.isZenFolder) {
        routed.folders.push(entry);
      } else if (el?.hasAttribute?.("split-view-group")) {
        routed.splits.push(entry);
      } else if (spaces.some(s => s.uuid === entry.key)) {
        routed.spaces.push(entry);
      }
    }
    return routed;
  }

  /* Mark: containers */

  function applyContainerUpserts(containers, fail) {
    const CIS = M().ContextualIdentityService;
    const batchGuids = new Set(containers.map(entry => entry.key));
    for (const entry of containers) {
      const { key: guid, data } = entry;
      try {
        if (!data.name || !CIS) {
          continue;
        }
        const mapped =
          TS.model.contextIdForGuid(guid) ?? TS.model.adoptMatchingContainer(guid, data, batchGuids);
        const existing = mapped !== null ? CIS.getPublicIdentityFromId(mapped) : null;
        if (existing) {
          if (existing.name !== data.name || existing.icon !== data.icon || existing.color !== data.color) {
            CIS.update(mapped, data.name, data.icon, data.color);
          }
        } else {
          // New here — including a built-in container this profile deleted,
          // which comes back under a fresh id mapped to the same guid.
          const identity = CIS.create(data.name, data.icon, data.color);
          TS.model.registerContainerGuid(guid, identity.userContextId);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  function deleteContainers(removals, fail) {
    const CIS = M().ContextualIdentityService;
    for (const entry of removals) {
      try {
        const mapped = TS.model.contextIdForGuid(entry.key);
        if (mapped !== null && CIS?.getPublicIdentityFromId(mapped)) {
          CIS.remove(mapped);
        }
        TS.model.forgetContainerGuid(entry.key);
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: spaces */

  async function applySpaces(win, spaces, fail) {
    if (!spaces.length) {
      return;
    }
    const canonicalJSON = TS.util.canonicalJSON;
    const list = win.gZenWorkspaces.getWorkspaces();
    let changed = false;
    const repaint = [];
    for (const entry of spaces) {
      const { data } = entry;
      try {
        if (!data.uuid || data.uuid !== entry.key) {
          throw new Error("space record id/uuid mismatch");
        }
        const fields = {
          uuid: data.uuid,
          name: data.name ?? "",
          icon: data.icon ?? undefined,
          theme: data.theme ?? null,
          containerTabId: resolveContainerId(data.containerGuid),
        };
        // A space record re-syncs whenever its children change; only
        // propagate (and repaint) when its own fields did.
        const index = list.findIndex(s => s.uuid === data.uuid);
        const current = index === -1 ? null : list[index];
        const visualChanged =
          !current ||
          (current.name ?? "") !== fields.name ||
          (current.icon ?? null) !== (fields.icon ?? null) ||
          canonicalJSON(current.theme ?? null) !== canonicalJSON(fields.theme ?? null);
        const containerChanged = !current || (current.containerTabId ?? 0) !== fields.containerTabId;
        if (!current) {
          list.push(fields);
          changed = true;
        } else if (visualChanged || containerChanged) {
          list[index] = { ...current, ...fields };
          changed = true;
        }
        if (visualChanged) {
          repaint.push(data.uuid);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
    if (changed) {
      await win.gZenWorkspaces.propagateWorkspaces(list);
      try {
        (win.gZenWindowSync || M().ZenWindowSync).propagateWorkspacesToAllWindows(list);
      } catch (e) {
        console.error("TwilightSync: propagating spaces failed", e);
      }
      for (const uuid of repaint) {
        const updated = list.find(s => s.uuid === uuid);
        if (updated) {
          try {
            win.gZenThemePicker?.onWorkspaceChange(updated);
          } catch (e) {
            // cosmetic
          }
        }
      }
    }
  }

  async function deleteSpaces(win, removals, fail, withhold, { skipConfirm = false } = {}) {
    for (const entry of removals) {
      const uuid = entry.key;
      try {
        const spaces = win.gZenWorkspaces.getWorkspaces();
        if (!spaces.some(s => s.uuid === uuid)) {
          continue;
        }
        if (spaces.length <= 1) {
          // Never delete the last space; the local copy revives it remotely.
          continue;
        }
        if (skipConfirm) {
          await win.gZenWorkspaces.removeWorkspace(uuid);
        } else {
          // Never await a modal inside the apply queue: an unattended device
          // must keep applying and capturing. The tombstone stays
          // unacknowledged until the detached prompt resolves.
          withhold(entry);
          queueSpaceDeleteConfirm(uuid);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  let confirmChain = Promise.resolve();
  const pendingConfirms = new Set();

  function queueSpaceDeleteConfirm(uuid) {
    if (pendingConfirms.has(uuid)) {
      return;
    }
    pendingConfirms.add(uuid);
    confirmChain = confirmChain
      .then(async () => {
        try {
          const win = TS.env.primaryWindow();
          if (!win) {
            return;
          }
          const spaces = win.gZenWorkspaces.getWorkspaces();
          if (!spaces.some(s => s.uuid === uuid) || spaces.length <= 1) {
            return;
          }
          if (await confirmRemoteSpaceDelete(win, uuid)) {
            await win.gZenWorkspaces.removeWorkspace(uuid);
          }
          // Either way the baseline entry goes: accepted → space and baseline
          // gone; declined → the space is no longer in the baseline, so the
          // next diff re-uploads it and revives it on the other devices.
          TS.model.noteApplied(uuid, null);
          TS.model.invalidate();
          TS.capture?.schedule("space-delete-confirmed");
        } catch (e) {
          console.error("TwilightSync: space deletion confirmation failed", e);
        } finally {
          pendingConfirms.delete(uuid);
        }
      })
      .catch(() => {});
  }

  async function confirmRemoteSpaceDelete(win, uuid) {
    const name = win.gZenWorkspaces.getWorkspaceFromId(uuid)?.name || uuid;
    let title = "Delete synced space?";
    let body = `"${name}" was deleted on another device. Delete it here too? Keeping it will restore it on your other devices.`;
    try {
      // Zen ships localized strings for exactly this prompt.
      const [t, b] = await win.document.l10n.formatValues([
        { id: "zen-workspaces-remote-delete-title" },
        { id: "zen-workspaces-remote-delete-body", args: { name } },
      ]);
      title = t || title;
      body = b || body;
    } catch (e) {
      // keep the fallback text
    }
    try {
      const result = await Services.prompt.asyncConfirmEx(
        win.browsingContext,
        Services.prompt.MODAL_TYPE_WINDOW,
        title,
        body,
        Services.prompt.STD_YES_NO_BUTTONS,
        null,
        null,
        null,
        null,
        false
      );
      return result.get("buttonNumClicked") === 0;
    } catch (e) {
      // No prompt possible: keep local data.
      return false;
    }
  }

  /* Mark: folders */

  async function applyFolders(win, folders, fail) {
    if (!folders.length) {
      return;
    }
    // Break nesting cycles in the merged (local + incoming) parent graph:
    // appending an ancestor into its descendant throws, and the poisoned
    // record would be redelivered forever. The self-heal re-uploads truth.
    const parentOf = new Map();
    for (const [id, rec] of TS.model.current().map) {
      if (rec.kind === K().FOLDER) {
        parentOf.set(id, rec.data.parentFolderId || null);
      }
    }
    for (const f of folders) {
      parentOf.set(f.key, f.data.parentFolderId || null);
    }
    for (const f of folders) {
      const seen = new Set([f.key]);
      let parent = f.data.parentFolderId || null;
      while (parent) {
        if (seen.has(parent)) {
          console.warn(`TwilightSync: folder nesting cycle at ${f.key}; dropping its parent edge`);
          f.data = { ...f.data, parentFolderId: null };
          parentOf.set(f.key, null);
          break;
        }
        seen.add(parent);
        parent = parentOf.get(parent) || null;
      }
    }

    // Parents before children so nesting targets exist.
    const depthOf = key => {
      let depth = 0;
      let parent = parentOf.get(key);
      const seen = new Set([key]);
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        depth++;
        parent = parentOf.get(parent);
      }
      return depth;
    };
    const ordered = [...folders].sort((a, b) => depthOf(a.key) - depthOf(b.key));

    for (const entry of ordered) {
      const { key: folderId, data } = entry;
      try {
        if (data.folderId !== folderId) {
          throw new Error("folder record id mismatch");
        }
        const workspaceUuid = resolveWorkspace(win, data.workspaceUuid);
        let folder = itemIn(win, folderId);
        if (!folder?.isZenFolder) {
          folder = win.gZenFolders.createFolder([], {
            id: folderId,
            label: data.name || "Folder",
            workspaceId: workspaceUuid || win.gZenWorkspaces.activeWorkspace,
            isLiveFolder: !!data.live,
            collapsed: true,
          });
        } else if ((folder.label || "") !== (data.name || "") && data.name) {
          folder.label = data.name;
        }

        if (data.live && !folder.isLiveFolder) {
          // Synced before its provider config was available here.
          folder.isLiveFolder = true;
        }

        // Same local-only filter as capture, so a corrupt record can't smuggle
        // an arbitrary URL into the icon.
        const wantIcon = TS.util.syncableIconUrl(data.icon || "") || null;
        if ((TS.util.syncableIconUrl(folder.iconURL || "") || null) !== wantIcon) {
          win.gZenFolders.setFolderUserIcon(folder, wantIcon);
          folder.dispatchEvent(new win.CustomEvent("TabGroupUpdate", { bubbles: true }));
        }

        const desiredParent = data.parentFolderId ? itemIn(win, data.parentFolderId) : null;
        const currentParent = folder.group;
        if ((currentParent?.id || null) !== (data.parentFolderId || null)) {
          if (desiredParent?.isZenFolder) {
            handleTabMove(win, folder, () => {
              if (desiredParent.tabs.length) {
                desiredParent.tabs[0].after(folder);
              } else {
                desiredParent.appendChild(folder);
              }
            });
          } else if (!data.parentFolderId && currentParent?.isZenFolder) {
            const ws = workspaceUuid || win.gZenWorkspaces.activeWorkspace;
            const container = win.gZenWorkspaces.workspaceElement(ws)?.pinnedTabsContainer;
            if (container) {
              handleTabMove(win, folder, () => {
                container.insertBefore(folder, container.querySelector(".pinned-tabs-container-separator"));
              });
            }
          }
        }
        if (workspaceUuid && folder.getAttribute("zen-workspace-id") !== workspaceUuid) {
          if (!folder.group) {
            win.gZenFolders.changeFolderToSpace(folder, workspaceUuid);
          } else {
            folder.setAttribute("zen-workspace-id", workspaceUuid);
          }
        }
        if (data.live && M().ZenLiveFoldersManager?.adoptSyncedFolder) {
          await M().ZenLiveFoldersManager.adoptSyncedFolder(folderId, data.live);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  async function deleteFolders(win, removals, fail) {
    for (const entry of removals) {
      try {
        const folder = itemIn(win, entry.key);
        if (!folder?.isZenFolder) {
          continue;
        }
        // Members without their own tombstone survive: unpack first.
        await folder.unpackTabs();
        await folder.delete();
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: tabs */

  function applyTabs(win, tabs, fail) {
    for (const entry of tabs) {
      const { key: tabId, data } = entry;
      try {
        if (data.tabId !== tabId) {
          throw new Error("tab record id mismatch");
        }
        if (!TS.util.isSyncableUrl(data.url)) {
          continue;
        }
        const found = TS.env.findElement(tabId);
        if (found && found.win.gBrowser.isTab(found.el)) {
          updateTab(found.win, found.el, data);
        } else {
          createTab(win, tabId, data);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  function createTab(win, tabId, data) {
    const userContextId = resolveContainerId(data.containerGuid);
    const tab = win.gBrowser.addTrustedTab(data.url, {
      createLazyBrowser: true,
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
      noInitialLabel: true,
      lazyTabTitle: data.title || undefined,
      userContextId,
      skipRoute: true,
    });
    if (!tab) {
      throw new Error("addTrustedTab returned no tab");
    }
    // The sync id must be set before window sync's queued TabOpen handler
    // runs, so it treats this tab as already replicated.
    tab.id = tabId;
    tab._zenContentsVisible = true;
    if (isPinnedKind(data)) {
      updatePinnedIdentity(win, tab, data);
    }
    updateTabDecorations(win, tab, data);
    if (data.essential) {
      win.gZenPinnedTabManager.addToEssentials(tab, { replicating: true });
    } else {
      const workspaceUuid = resolveWorkspace(win, data.workspaceUuid);
      if (workspaceUuid) {
        tab.setAttribute("zen-workspace-id", workspaceUuid);
      }
      if (data.pinned) {
        win.gBrowser.pinTab(tab);
      }
      if (workspaceUuid) {
        win.gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
      }
      if (data.pinned && data.folderId) {
        const folder = itemIn(win, data.folderId);
        if (folder?.isZenFolder) {
          folder.addTabs([tab]);
        }
      }
    }
    try {
      M().ZenWindowSync.on_TabOpen({ target: tab }, { ignoreExistingId: true });
    } catch (e) {
      console.error("TwilightSync: window sync TabOpen failed", e);
    }
  }

  /**
   * Pin target (canonical url/title/icon) of a pinned or essential tab. An
   * unloaded tab is also pointed at it, so its next activation loads it.
   */
  function updatePinnedIdentity(win, tab, data) {
    const icon = TS.util.syncableIconUrl(data.icon);
    const initial = tab._zenPinnedInitialState;
    const identityChanged =
      initial?.entry?.url !== data.url || (initial?.entry?.title || "") !== (data.title || "");
    if (identityChanged || TS.util.syncableIconUrl(initial?.image || "") !== icon) {
      M().ZenWindowSync.setPinnedInitialState(tab, { url: data.url, title: data.title || "" }, icon || undefined);
    }
    if (identityChanged && isUnloadedTab(tab)) {
      retargetUnloadedTab(win, tab, data, initial?.entry?.url || null);
    }
  }

  /** Static label / static icon / default-container marker, for every kind. */
  function updateTabDecorations(win, tab, data) {
    const icon = TS.util.syncableIconUrl(data.icon);
    const staticLabel = typeof data.staticLabel === "string" ? data.staticLabel : null;
    const localLabel = typeof tab.zenStaticLabel === "string" ? tab.zenStaticLabel : null;
    if (staticLabel !== localLabel) {
      tab.zenStaticLabel = staticLabel ?? undefined;
      if (staticLabel) {
        tab._zenChangeLabelFlag = true;
        try {
          win.gBrowser._setTabLabel(tab, staticLabel);
        } finally {
          delete tab._zenChangeLabelFlag;
        }
      }
    }
    tab.zenStaticIcon = data.hasStaticIcon && icon ? icon : undefined;
    // Compare normalized: setIcon rewraps svg data: icons as moz-remote-image.
    const iconDiffers = icon && TS.util.syncableIconUrl(tab.getAttribute("image")) !== icon;
    if (iconDiffers && (data.hasStaticIcon || isUnloadedTab(tab))) {
      try {
        win.gBrowser.setIcon(tab, icon);
        M().TabStateCache?.update(tab.linkedBrowser.permanentKey, { image: icon || null });
      } catch (e) {
        console.error("TwilightSync: failed to set tab icon", e);
      }
    }
    if (data.defaultContainer) {
      tab.setAttribute("zenDefaultUserContextId", "true");
    } else {
      tab.removeAttribute("zenDefaultUserContextId");
    }
  }

  /**
   * Points an unloaded tab's session state at the record's URL.
   *
   * @param {?string} previousUrl - the synced URL before this record. If the
   *   tab's lazy URL is neither that nor the new one, the user navigated it
   *   here meanwhile; their page is kept.
   */
  function retargetUnloadedTab(win, tab, data, previousUrl) {
    try {
      const state = JSON.parse(win.SessionStore.getTabState(tab));
      const entries = state.entries || [];
      let currentUrl = null;
      let currentTitle = "";
      if (entries.length) {
        const index = Math.min(Math.max((state.index || entries.length) - 1, 0), entries.length - 1);
        currentUrl = entries[index]?.url || null;
        currentTitle = entries[index]?.title || "";
      }
      if (currentUrl === data.url && currentTitle === (data.title || "")) {
        return;
      }
      if (currentUrl && currentUrl !== data.url && previousUrl && currentUrl !== previousUrl) {
        return;
      }
      state.entries = [
        {
          url: data.url,
          title: data.title || "",
          triggeringPrincipal_base64: M().E10SUtils.serializePrincipal(
            Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(data.url), {})
          ),
        },
      ];
      state.index = 1;
      state.image = TS.util.syncableIconUrl(data.icon) || undefined;
      delete state.scroll;
      delete state.formdata;
      win.SessionStore.setTabState(tab, state);
    } catch (e) {
      console.error("TwilightSync: failed to retarget unloaded tab", e);
    }
  }

  /**
   * Converges a normal tab's URL without ever yanking a page in use:
   *   unloaded                    → retarget its session state
   *   loaded, idle, not visible   → unload, then retarget
   *   otherwise                   → hold (resolved by processHolds)
   */
  function applyNormalTabUrl(win, tab, data) {
    if (isUnloadedTab(tab)) {
      TS.model.dropHold(tab.id);
      retargetUnloadedTab(win, tab, data, null);
      return;
    }
    const currentUrl = loadedTabUrl(tab);
    if (!currentUrl || currentUrl === data.url) {
      TS.model.dropHold(tab.id);
      return;
    }
    if (canQuietlyRetarget(tab.id) && unloadEverywhere(tab.id)) {
      TS.model.dropHold(tab.id);
      retargetUnloadedTab(win, tab, data, null);
      return;
    }
    TS.model.setHold(tab.id, {
      url: data.url,
      title: data.title || "",
      icon: data.icon || "",
      localUrl: currentUrl,
      since: Date.now(),
    });
  }

  /** Unloads every loaded copy of a tab. False if any copy refused. */
  function unloadEverywhere(tabId) {
    for (const { win, tab } of copiesOf(tabId)) {
      if (!isUnloadedTab(tab)) {
        let ok = false;
        try {
          ok = win.gBrowser.discardBrowser(tab);
        } catch (e) {
          ok = false;
        }
        if (!ok) {
          return false;
        }
      }
    }
    return true;
  }

  function applyFolderMembership(win, item, folderId) {
    const currentFolder = item.group?.isZenFolder ? item.group.id : null;
    const wantFolder = folderId || null;
    if (currentFolder === wantFolder) {
      return;
    }
    const target = wantFolder && itemIn(win, wantFolder);
    if (target?.isZenFolder) {
      target.addTabs([item]);
    } else if (!wantFolder && currentFolder) {
      // ungroupTab pops one nesting level; repeat until top-level.
      let guard = 16;
      while (guard-- > 0 && win.gBrowser.isTabGroup(item.group) && item.group.isZenFolder) {
        win.gBrowser.ungroupTab(item);
      }
    }
  }

  function updateTab(win, tab, data) {
    // Kind transitions are field updates on one record, never remove+add.
    // Essential is cleared first (removeEssentials re-homes the tab into the
    // RECEIVER's active space, so the explicit space move must come after).
    const isEssential = tab.hasAttribute("zen-essential");
    if (!data.essential && isEssential) {
      win.gZenPinnedTabManager.removeEssentials(tab, /* unpin */ false);
    }

    if (isPinnedKind(data)) {
      updatePinnedIdentity(win, tab, data);
    }
    updateTabDecorations(win, tab, data);

    if (data.essential) {
      if (!isEssential) {
        win.gZenPinnedTabManager.addToEssentials(tab, { replicating: true });
      }
      return;
    }

    const inSplit = tab.group?.hasAttribute?.("split-view-group");
    if (data.pinned && !tab.pinned) {
      win.gBrowser.pinTab(tab);
    } else if (!data.pinned && tab.pinned && !inSplit) {
      win.gBrowser.unpinTab(tab);
      // Pin identity would otherwise freeze the projection of a normal tab.
      delete tab._zenPinnedInitialState;
    }

    if (!data.pinned) {
      applyNormalTabUrl(win, tab, data);
    }

    if (inSplit) {
      // The split record governs its members' placement.
      return;
    }
    if (data.pinned) {
      applyFolderMembership(win, tab, data.folderId);
    } else if (tab.group?.isZenFolder) {
      applyFolderMembership(win, tab, null);
    }
    const workspaceUuid = resolveWorkspace(win, data.workspaceUuid);
    if (
      (!data.folderId || !data.pinned) &&
      workspaceUuid &&
      tab.getAttribute("zen-workspace-id") !== workspaceUuid
    ) {
      win.gZenWorkspaces.moveTabToWorkspace(tab, workspaceUuid);
    }
  }

  function removeTab(win, tab) {
    if (tab.splitView) {
      win.gZenViewSplitter.removeTabFromGroup(tab, undefined, {
        forUnsplit: true,
        changeTab: false,
      });
    }
    TS.model.dropHold(tab.id);
    win.gBrowser.removeTab(tab, { animate: true });
  }

  function deleteTabs(win, removals, fail) {
    for (const entry of removals) {
      try {
        const found = TS.env.findElement(entry.key);
        if (found && found.win.gBrowser.isTab(found.el)) {
          removeTab(found.win, found.el);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: splits */

  function applySplits(win, splits, fail) {
    for (const entry of splits) {
      const { key: splitId, data } = entry;
      try {
        if (data.splitId !== splitId) {
          throw new Error("split record id mismatch");
        }
        const members = (data.tabs || [])
          .map(id => itemIn(win, id))
          .filter(tab => win.gBrowser.isTab(tab));
        const existing = itemIn(win, splitId);
        if (existing?.hasAttribute?.("split-view-group")) {
          const wanted = new Set(data.tabs || []);
          for (const tab of [...existing.tabs]) {
            if (tab.id && !wanted.has(tab.id)) {
              win.gZenViewSplitter.removeTabFromGroup(tab, undefined, { changeTab: false });
            }
          }
        }
        if (members.length >= 2) {
          win.gZenViewSplitter.splitTabs(members, data.gridType, -1, { groupFetchId: splitId });
        }
        const group = itemIn(win, splitId);
        if (group?.hasAttribute?.("split-view-group")) {
          applyFolderMembership(win, group, data.folderId);
        } else if (members.length >= 2) {
          throw new Error("split group was not created");
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  function deleteSplits(win, removals, fail) {
    for (const entry of removals) {
      try {
        const index = win.gZenViewSplitter._data.findIndex(g => g.groupId === entry.key);
        if (index >= 0) {
          win.gZenViewSplitter.removeGroup(index);
        }
      } catch (e) {
        fail(entry, e);
      }
    }
  }

  /* Mark: ordering */

  /**
   * Fixes inversions only (upstream semantics): an element is moved right
   * after its predecessor when it currently sits before it. Elements with a
   * different parent (pinned vs. normal section) are never moved across.
   */
  function applyRelativeOrder(win, elements) {
    let prev = null;
    for (const el of elements) {
      if (!el) {
        continue;
      }
      if (
        prev &&
        prev.parentNode &&
        prev.parentNode === el.parentNode &&
        prev.compareDocumentPosition(el) & win.Node.DOCUMENT_POSITION_PRECEDING
      ) {
        const anchor = prev;
        handleTabMove(win, el, () => anchor.after(el));
      }
      prev = el;
    }
  }

  function applyOrdering(win, incoming, fail, options) {
    for (const entry of [...incoming.spaces, ...incoming.folders]) {
      const { key, data } = entry;
      try {
        if (Array.isArray(data.children) && data.children.length) {
          // A folder's empty-tab placeholder anchors its first child.
          const folder = data.folderId ? itemIn(win, key) : null;
          const start = folder?.isZenFolder
            ? folder.tabs.find(t => t.hasAttribute("zen-empty-tab"))
            : null;
          applyRelativeOrder(win, [start ?? null, ...data.children.map(id => itemIn(win, id))]);
        }
        if (options.normalTabs && Array.isArray(data.normalChildren) && data.normalChildren.length > 1) {
          applyRelativeOrder(win, data.normalChildren.map(id => itemIn(win, id)));
        }
      } catch (e) {
        fail(entry, e);
      }
    }
    if (!incoming.layout) {
      return;
    }
    const { data } = incoming.layout;
    try {
      for (const tabIds of Object.values(data.essentials || {})) {
        if (Array.isArray(tabIds) && tabIds.length > 1) {
          applyRelativeOrder(win, tabIds.map(id => itemIn(win, id)));
        }
      }
      if (Array.isArray(data.spaces) && data.spaces.length > 1) {
        const current = win.gZenWorkspaces.getWorkspaces();
        const byUuid = new Map(current.map(s => [s.uuid, s]));
        const ordered = data.spaces.map(uuid => byUuid.get(uuid)).filter(Boolean);
        for (const space of current) {
          if (!data.spaces.includes(space.uuid)) {
            ordered.push(space);
          }
        }
        const changedOrder = ordered.some((space, i) => current[i]?.uuid !== space.uuid);
        if (changedOrder && ordered.length === current.length) {
          (win.gZenWindowSync || M().ZenWindowSync).propagateWorkspacesToAllWindows(ordered);
        }
      }
    } catch (e) {
      fail(incoming.layout, e);
    }
  }

  /* Mark: initial "replace local" */

  /**
   * Deletes local synced things absent from the incoming set, walking LIVE
   * browser state (a stale collection must not let stragglers survive).
   * Containers are never deleted here. Only syncable things are touched.
   */
  async function reconcileRemovals(win, records, options) {
    const keep = new Set(records.map(r => r.id));

    for (const w of TS.env.syncedWindows()) {
      for (const tab of [...w.gZenWorkspaces.allStoredTabs]) {
        try {
          if (!tab.id || keep.has(tab.id) || !tab.isConnected) {
            continue;
          }
          if (
            tab.hasAttribute("zen-empty-tab") ||
            tab.hasAttribute("zen-glance-tab") ||
            tab.hasAttribute("zen-live-folder-item-id")
          ) {
            continue;
          }
          if (!tab.pinned && !tab.hasAttribute("zen-essential") && !options.normalTabs) {
            continue;
          }
          const url = loadedTabUrl(tab) || sessionUrl(w, tab).url;
          if (!TS.util.isSyncableUrl(url)) {
            continue;
          }
          removeTab(w, tab);
        } catch (e) {
          console.warn("TwilightSync: reconcile tab removal failed", e);
        }
      }
    }

    for (const folder of [...win.document.querySelectorAll("zen-folder")]) {
      try {
        if (!folder.id || keep.has(folder.id) || !folder.isZenFolder || !folder.isConnected) {
          continue;
        }
        if (folder.hasAttribute("zen-library-copy")) {
          continue;
        }
        await folder.unpackTabs();
        await folder.delete();
      } catch (e) {
        console.warn("TwilightSync: reconcile folder removal failed", e);
      }
    }

    for (const space of [...win.gZenWorkspaces.getWorkspaces()]) {
      try {
        if (keep.has(space.uuid)) {
          continue;
        }
        if (win.gZenWorkspaces.getWorkspaces().length <= 1) {
          break;
        }
        await win.gZenWorkspaces.removeWorkspace(space.uuid);
      } catch (e) {
        console.warn("TwilightSync: reconcile space removal failed", e);
      }
    }

    if (options.shortcuts) {
      const stale = TS.keys
        .localKeyIds()
        .filter(keyId => !keep.has(TS.util.keyRecordId(keyId)));
      if (stale.length) {
        TS.keys.resetLocal(stale);
      }
    }
  }

  /* Mark: holds */

  /**
   * Re-evaluates pending navigation holds; runs at the start of every capture
   * and when a tab unloads.
   */
  function processHolds() {
    const win = TS.env.primaryWindow();
    if (!win) {
      return;
    }
    const holds = TS.model.getHolds();
    for (const [tabId, hold] of Object.entries(holds)) {
      const found = TS.env.findElement(tabId);
      if (!found || !found.win.gBrowser.isTab(found.el)) {
        // Closed: its tombstone path handles the rest.
        TS.model.dropHold(tabId);
        continue;
      }
      const { win: tabWin, el: tab } = found;
      if (tab.pinned || tab.hasAttribute("zen-essential")) {
        // Became a pinned kind: pin identity governs now.
        TS.model.dropHold(tabId);
        continue;
      }
      if (isUnloadedTab(tab)) {
        // The hold stays until a collection shows the retargeted URL, or
        // this cycle's diff (from a pre-retarget state) would re-upload the
        // stale local URL.
        const lazy = sessionUrl(tabWin, tab);
        if (lazy.url === hold.url) {
          TS.model.dropHold(tabId);
        } else {
          retargetUnloadedTab(tabWin, tab, hold, null);
        }
        continue;
      }
      const currentUrl = loadedTabUrl(tab);
      if (!currentUrl) {
        continue;
      }
      if (currentUrl === hold.url) {
        TS.model.dropHold(tabId);
      } else if (currentUrl !== hold.localUrl) {
        // The user navigated it here: local truth wins and re-uploads.
        TS.model.dropHold(tabId);
      } else if (canQuietlyRetarget(tabId) && unloadEverywhere(tabId)) {
        retargetUnloadedTab(tabWin, tab, hold, null);
      }
    }
  }

  TS.apply = {
    apply,
    processHolds,
    idleRetargetMs,
    get isApplying() {
      return applying > 0;
    },
  };
})(this);

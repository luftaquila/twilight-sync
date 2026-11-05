/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * twilight-sync engine — projection: sidebar data → sync records.
 *
 * Ported from Zen's ZenSpacesSyncModel projections (src/zen/sync, Twilight
 * 1.25t) and extended:
 *   - normal (unpinned) tabs are first-class records; their identity is the
 *     live session entry, while pinned/essential tabs keep the pin target
 *   - a tab with a pending navigation hold projects the held remote URL, so
 *     the rest of its record (pin state, space, folder) keeps syncing while
 *     the URL waits for the tab to become safe to retarget
 *   - anything locally present but not projectable this cycle is reported in
 *     `pending`, which the diff never reads as a deletion
 *   - keyboard shortcut records are merged in from keys.js
 *
 * Pure: everything browser-specific arrives through `ctx`, so the Node unit
 * tests drive it with plain objects.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const tabIdentity = (tab, util) => {
    const pinnedKind = !!(tab.pinned || tab.zenEssential);
    // Pin identity freezes url/title at pin time; a normal tab follows its
    // live entry (a leftover initial state from a past pin must not shadow it).
    const initial = pinnedKind ? tab._zenPinnedInitialState : null;
    let url = initial?.entry?.url;
    let title = initial?.entry?.title;
    if (!url || url === "about:blank") {
      const entries = tab.entries || [];
      if (entries.length) {
        const index = Math.min(
          Math.max((tab.index || entries.length) - 1, 0),
          entries.length - 1
        );
        const entry = entries[index] || entries[0];
        if (entry?.url && entry.url !== "about:blank") {
          url = entry.url;
          title ??= entry.title;
        }
      }
    }
    if (!util.isSyncableUrl(url)) {
      return null;
    }
    title = typeof title === "string" ? title : "";
    // A title equal to the URL is the mid-load placeholder.
    if (title === url) {
      title = "";
    }
    const icon = util.syncableIconUrl(
      (tab.zenHasStaticIcon ? tab.image : initial?.image || tab.image) || ""
    );
    return { url, title, icon };
  };

  function isTabRecordMaterial(tab) {
    return !!(
      tab &&
      tab.zenSyncId &&
      !tab.zenIsEmpty &&
      !tab.zenIsGlance &&
      !tab.zenLiveFolderItemId
    );
  }

  function projectionContext(sidebar, ctx, util, pending) {
    const allTabs = sidebar.tabs || [];
    const tabs = [];
    const identities = new Map();
    for (const tab of allTabs) {
      if (!isTabRecordMaterial(tab)) {
        continue;
      }
      const pinnedKind = !!(tab.pinned || tab.zenEssential);
      if (!pinnedKind && !ctx.options.normalTabs) {
        // Excluded by option, not deleted: flipping the option off must not
        // tombstone these on other devices.
        pending.add(tab.zenSyncId);
        continue;
      }
      let identity = tabIdentity(tab, util);
      const hold = !pinnedKind ? ctx.holds?.[tab.zenSyncId] : null;
      if (hold?.url) {
        identity = {
          url: hold.url,
          title: hold.title || "",
          icon: util.syncableIconUrl(hold.icon || ""),
        };
      }
      if (!identity) {
        // No http(s) identity yet (new tab page, about: pages, a tab whose
        // first entry hasn't been flushed): present, just not projectable.
        pending.add(tab.zenSyncId);
        continue;
      }
      identities.set(tab.zenSyncId, identity);
      tabs.push(tab);
    }

    const folders = (sidebar.folders || []).filter(f => f?.id && !f.splitViewGroup);
    const folderIds = new Set(folders.map(f => f.id));
    const folderById = new Map(folders.map(f => [f.id, f]));
    const splitParents = new Map();
    for (const entry of sidebar.folders || []) {
      if (entry?.splitViewGroup && entry.id) {
        splitParents.set(entry.id, entry.parentId || null);
      }
    }

    // A split syncs only when every member is a synced tab.
    const syncableTabIds = new Set(tabs.map(t => t.zenSyncId));
    const splits = [];
    for (const group of sidebar.splitViewData || []) {
      if (!group?.groupId || !Array.isArray(group.tabs) || group.tabs.length < 2) {
        continue;
      }
      if (group.tabs.every(id => syncableTabIds.has(id))) {
        splits.push(group);
      } else if (group.tabs.some(id => pending.has(id))) {
        pending.add(group.groupId);
      }
    }
    const splitIds = new Set(splits.map(g => g.groupId));
    const splitWs = new Map();
    const splitPinned = new Map();
    for (const tab of tabs) {
      const groupId = tab.groupId || null;
      if (groupId && splitIds.has(groupId) && !splitWs.has(groupId)) {
        splitWs.set(groupId, tab.zenWorkspace || null);
        splitPinned.set(groupId, !!(tab.pinned || tab.zenEssential));
      }
    }
    const folderOf = groupId => {
      if (!groupId) {
        return null;
      }
      if (splitIds.has(groupId)) {
        return splitParents.get(groupId) || null;
      }
      return folderIds.has(groupId) ? groupId : null;
    };
    return {
      allTabs,
      tabs,
      identities,
      folders,
      folderById,
      syncableTabIds,
      splits,
      splitIds,
      splitParents,
      splitWs,
      splitPinned,
      folderOf,
    };
  }

  /**
   * Walks a folder's parent chain up to the direct child of `scope`, or null
   * when the chain leads elsewhere. (Upstream #scopeChildFolder.)
   */
  function scopeChildFolder(pc, scope, folderId) {
    const seen = new Set();
    let current = pc.folderById.get(folderId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const parentId = current.parentId || null;
      if (scope.folder ? parentId === scope.folder : !parentId) {
        if (scope.space && (current.workspaceId || null) !== scope.space) {
          return null;
        }
        return current.id;
      }
      current = parentId ? pc.folderById.get(parentId) : null;
    }
    return null;
  }

  /**
   * Ordered child ids of one parent, from the collected tab list (which is in
   * strip order). A space has two sections — `pinned` (pinned tabs, folders,
   * pinned splits) and `normal` (open tabs, their splits) — kept apart so a
   * device that doesn't sync open tabs can echo the normal section untouched.
   * (Upstream #childSequence, plus the section split.)
   */
  function childSequence(pc, scope) {
    const seq = [];
    const seen = new Set();
    const push = id => {
      if (!seen.has(id)) {
        seen.add(id);
        seq.push(id);
      }
    };
    const wantPinned = !scope.space || scope.section === "pinned";
    for (const tab of pc.allTabs) {
      const groupId = tab.groupId || null;
      if (!groupId) {
        if (
          scope.space &&
          !tab.zenEssential &&
          (tab.zenWorkspace || null) === scope.space &&
          pc.syncableTabIds.has(tab.zenSyncId) &&
          !!tab.pinned === wantPinned
        ) {
          push(tab.zenSyncId);
        }
        continue;
      }
      if (scope.folder && groupId === scope.folder) {
        if (pc.syncableTabIds.has(tab.zenSyncId)) {
          push(tab.zenSyncId);
        }
        continue;
      }
      if (pc.splitIds.has(groupId) || pc.splitParents.has(groupId)) {
        const parent = pc.splitParents.get(groupId) ?? null;
        const isDirect = scope.folder ? parent === scope.folder : !parent;
        if (isDirect) {
          if (
            pc.splitIds.has(groupId) &&
            (!scope.space ||
              ((pc.splitWs.get(groupId) ?? null) === scope.space &&
                !!pc.splitPinned.get(groupId) === wantPinned))
          ) {
            push(groupId);
          }
        } else if (parent && wantPinned) {
          const child = scopeChildFolder(pc, scope, parent);
          if (child) {
            push(child);
          }
        }
        continue;
      }
      if (pc.folderById.has(groupId) && wantPinned) {
        const child = scopeChildFolder(pc, scope, groupId);
        if (child) {
          push(child);
        }
      }
    }
    return seq;
  }

  /**
   * @param {object} sidebar - output of TS.sidebar.collect()
   * @param {object} ctx
   * @param {{normalTabs: boolean, shortcuts: boolean}} ctx.options
   * @param {Function} ctx.guidForContextId - (userContextId, {create}) → guid|null
   * @param {Function} ctx.containerIdentities - () → [{userContextId, name, icon, color}]
   * @param {Function} ctx.liveFolderData - (folderId) → object|null
   * @param {object} ctx.holds - { tabId: {url, title, icon} }
   * @param {?{records: Array, pending: Array}} ctx.keys - from keys.js
   * @returns {{map: Map<string, {kind, data}>, pending: Set<string>}}
   */
  function build(sidebar, ctx) {
    const util = TS.util;
    const K = util.RECORD_KINDS;
    const map = new Map();
    const pending = new Set();
    const pc = projectionContext(sidebar, ctx, util, pending);
    const guid = id => ctx.guidForContextId(id, { create: true });

    // Containers
    for (const identity of ctx.containerIdentities()) {
      if (!identity?.name) {
        continue;
      }
      const g = guid(identity.userContextId);
      if (!g) {
        continue;
      }
      map.set(g, {
        kind: K.CONTAINER,
        data: { guid: g, name: identity.name, icon: identity.icon || "", color: identity.color || "" },
      });
    }

    // Spaces
    const spaces = (sidebar.spaces || []).filter(s => s?.uuid);
    for (const space of spaces) {
      map.set(space.uuid, {
        kind: K.SPACE,
        data: {
          uuid: space.uuid,
          name: space.name ?? "",
          icon: space.icon ?? null,
          theme: space.theme ?? null,
          containerGuid: guid(space.containerTabId),
          children: childSequence(pc, { space: space.uuid, section: "pinned" }),
          // Without open-tab sync this device can't know the normal section:
          // it echoes the last synced one so devices never fight over it.
          normalChildren: ctx.options.normalTabs
            ? childSequence(pc, { space: space.uuid, section: "normal" })
            : [...(ctx.normalChildrenEcho?.(space.uuid) || [])],
        },
      });
    }

    // Folders
    for (const folder of pc.folders) {
      let live = null;
      if (folder.isLiveFolder) {
        try {
          live = ctx.liveFolderData(folder.id) ?? null;
        } catch (e) {
          live = null;
        }
        if (!live) {
          // Provider config not available yet: never a deletion.
          pending.add(folder.id);
          continue;
        }
      }
      map.set(folder.id, {
        kind: K.FOLDER,
        data: {
          folderId: folder.id,
          name: folder.name ?? "",
          icon: util.syncableIconUrl(folder.userIcon || "") || null,
          workspaceUuid: folder.workspaceId || null,
          parentFolderId: folder.parentId || null,
          live,
          children: childSequence(pc, { folder: folder.id }),
        },
      });
    }

    // Tabs
    for (const tab of pc.tabs) {
      const identity = pc.identities.get(tab.zenSyncId);
      const essential = !!tab.zenEssential;
      map.set(tab.zenSyncId, {
        kind: K.TAB,
        data: {
          tabId: tab.zenSyncId,
          url: identity.url,
          title: identity.title,
          icon: identity.icon,
          containerGuid: guid(tab.userContextId),
          essential,
          pinned: !!(tab.pinned || essential),
          workspaceUuid: essential ? null : tab.zenWorkspace || null,
          folderId: pc.folderOf(tab.groupId || null),
          staticLabel: typeof tab.zenStaticLabel === "string" ? tab.zenStaticLabel : null,
          hasStaticIcon: !!tab.zenHasStaticIcon,
          defaultContainer: !!tab.zenDefaultUserContextId,
        },
      });
    }

    // Splits
    const tabById = new Map(pc.tabs.map(t => [t.zenSyncId, t]));
    for (const split of pc.splits) {
      const member = tabById.get(split.tabs[0]);
      map.set(split.groupId, {
        kind: K.SPLIT,
        data: {
          splitId: split.groupId,
          gridType: split.gridType || "grid",
          pinned: !!(member?.pinned || member?.zenEssential),
          tabs: [...split.tabs],
          workspaceUuid: pc.splitWs.get(split.groupId) ?? null,
          folderId: pc.splitParents.get(split.groupId) || null,
        },
      });
    }

    // Layout: space order + essentials order per container section.
    if (spaces.length) {
      const essentials = {};
      for (const tab of pc.tabs) {
        if (!tab.zenEssential) {
          continue;
        }
        const key = guid(tab.userContextId) || "default";
        (essentials[key] ||= []).push(tab.zenSyncId);
      }
      map.set(util.LAYOUT_RECORD_ID, {
        kind: K.LAYOUT,
        data: { spaces: spaces.map(s => s.uuid), essentials },
      });
    }

    // Keyboard shortcuts
    if (ctx.keys) {
      for (const record of ctx.keys.records) {
        map.set(record.id, { kind: K.KEY, data: record.data });
      }
      for (const id of ctx.keys.pending) {
        pending.add(id);
      }
    }

    return { map, pending };
  }

  TS.project = { build, tabIdentity: tab => tabIdentity(tab, TS.util) };
})(this);

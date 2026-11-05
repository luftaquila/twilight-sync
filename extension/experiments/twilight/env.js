/*
 * twilight-sync engine — environment.
 *
 * Module imports, system-global borrowing, synced-window helpers and the
 * capability probe. Every Zen internal the engine touches is listed in
 * probe(); a missing one disables capture AND apply (fail closed), because
 * Twilight moves weekly and silent partial operation corrupts state slowly.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const Cu_ = typeof Cu !== "undefined" ? Cu : Components.utils;

  // The experiment sandbox only exposes a curated set of globals. WebIDL
  // helpers (TextEncoder, PathUtils, IOUtils) are borrowed from the system
  // global that Services lives in — a bare `new TextEncoder()` would throw
  // and kill the whole loadSubScript.
  const systemGlobal = (() => {
    try {
      return Cu_.getGlobalForObject(Services);
    } catch (e) {
      return globalThis;
    }
  })();
  const borrow = name =>
    typeof globalThis[name] !== "undefined"
      ? globalThis[name]
      : systemGlobal[name];

  const TextEncoder_ = borrow("TextEncoder");
  const encoder = new TextEncoder_();
  TS.encodeUTF8 = str => encoder.encode(str);
  TS.PathUtils = borrow("PathUtils");
  TS.IOUtils = borrow("IOUtils");

  const modules = {};
  const importFailures = [];

  function load(name, urls, symbol, { optional = false } = {}) {
    for (const url of urls) {
      try {
        const mod = ChromeUtils.importESModule(url);
        if (mod?.[symbol]) {
          modules[name] = mod[symbol];
          return;
        }
      } catch (e) {
        // try the next location
      }
    }
    modules[name] = null;
    if (!optional) {
      importFailures.push(name);
    }
  }

  const SS = "moz-src:///browser/components/sessionstore/";
  load(
    "SessionStore",
    [`${SS}SessionStore.sys.mjs`, "resource:///modules/sessionstore/SessionStore.sys.mjs"],
    "SessionStore"
  );
  load(
    "TabStateFlusher",
    [`${SS}TabStateFlusher.sys.mjs`, "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"],
    "TabStateFlusher"
  );
  load(
    "TabStateCache",
    [`${SS}TabStateCache.sys.mjs`, "resource:///modules/sessionstore/TabStateCache.sys.mjs"],
    "TabStateCache"
  );
  load(
    "SessionStartup",
    [`${SS}SessionStartup.sys.mjs`, "resource:///modules/sessionstore/SessionStartup.sys.mjs"],
    "SessionStartup",
    { optional: true }
  );
  load("ZenWindowSync", ["resource:///modules/zen/ZenWindowSync.sys.mjs"], "ZenWindowSync");
  load(
    "ZenLiveFoldersManager",
    ["resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"],
    "ZenLiveFoldersManager",
    { optional: true }
  );
  load(
    "ContextualIdentityService",
    [
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
      "resource://gre/modules/ContextualIdentityService.sys.mjs",
    ],
    "ContextualIdentityService"
  );
  load(
    "CustomKeys",
    ["moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"],
    "CustomKeys",
    { optional: true }
  );
  load("JSONFile", ["resource://gre/modules/JSONFile.sys.mjs"], "JSONFile");
  load("E10SUtils", ["resource://gre/modules/E10SUtils.sys.mjs"], "E10SUtils");
  load("AppConstants", ["resource://gre/modules/AppConstants.sys.mjs"], "AppConstants");
  load(
    "PrivateBrowsingUtils",
    ["resource://gre/modules/PrivateBrowsingUtils.sys.mjs"],
    "PrivateBrowsingUtils"
  );
  const timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  /* Mark: windows */

  function isSyncedWindow(win) {
    try {
      return (
        !!win &&
        !win.closed &&
        win.document?.documentElement?.getAttribute("windowtype") === "navigator:browser" &&
        !!win.gZenWorkspaces &&
        !win.gZenWorkspaces.privateWindowOrDisabled &&
        !modules.PrivateBrowsingUtils?.isWindowPrivate(win)
      );
    } catch (e) {
      return false;
    }
  }

  /** All synced (non-private, non-unsynced, toolbar) browser windows, primary first. */
  function syncedWindows() {
    const out = [];
    const primary = primaryWindow();
    if (primary) {
      out.push(primary);
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win !== primary && isSyncedWindow(win)) {
        out.push(win);
      }
    }
    return out;
  }

  /**
   * The window incoming records are applied into. Zen's window sync mirrors
   * everything it does to the other synced windows.
   */
  function primaryWindow() {
    const first = modules.ZenWindowSync?.firstSyncedWindow;
    if (isSyncedWindow(first)) {
      return first;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (isSyncedWindow(win)) {
        return win;
      }
    }
    return null;
  }

  /**
   * Finds the live element for a record id. With full window sync every
   * synced window holds a copy; with zen.window-sync.sync-only-pinned-tabs a
   * normal tab lives in exactly one window, so all of them are searched.
   */
  function findElement(id) {
    if (!id) {
      return null;
    }
    for (const win of syncedWindows()) {
      const el = win.document.getElementById(id);
      if (el) {
        return { win, el };
      }
    }
    return null;
  }

  /**
   * Drops the tab strip's cached lists (allTabs, ariaFocusableItems /
   * dragAndDropElements, gZenWorkspaces._allStoredTabs). Zen 1.25t can keep
   * a removed split view's label in ariaFocusableItems; with new tabs opening
   * on top, the next new tab then anchors on that detached node and is never
   * inserted. Invalidating only nulls caches (they rebuild lazily from the
   * DOM), so it can't create stale state itself.
   */
  function invalidateTabCaches(win = null) {
    for (const w of win ? [win] : syncedWindows()) {
      try {
        w.gBrowser?.tabContainer?._invalidateCachedTabs?.();
      } catch (e) {
        // ignore
      }
    }
  }

  function hostName() {
    try {
      const name = Services.dns.myHostName;
      if (name) {
        return String(name).replace(/\.(local|lan|home)$/i, "");
      }
    } catch (e) {
      // fall through
    }
    try {
      const env = Components.classes["@mozilla.org/process/environment;1"].getService(
        Components.interfaces.nsIEnvironment
      );
      for (const key of ["COMPUTERNAME", "HOSTNAME", "HOST"]) {
        const value = env.get(key);
        if (value) {
          return value.replace(/\.(local|lan|home)$/i, "");
        }
      }
    } catch (e) {
      // fall through
    }
    return "";
  }

  /* Mark: capability probe */

  function probe() {
    const missing = importFailures.map(name => `module ${name}`);
    const need = (label, ok) => {
      if (!ok) {
        missing.push(label);
      }
    };
    const SessionStore = modules.SessionStore;
    need("SessionStore.getWindowState", typeof SessionStore?.getWindowState === "function");
    need("SessionStore.getTabState", typeof SessionStore?.getTabState === "function");
    need("SessionStore.setTabState", typeof SessionStore?.setTabState === "function");
    need("TabStateFlusher.flushWindow", typeof modules.TabStateFlusher?.flushWindow === "function");
    const WS = modules.ZenWindowSync;
    need("ZenWindowSync.on_TabOpen", typeof WS?.on_TabOpen === "function");
    need("ZenWindowSync.setPinnedInitialState", typeof WS?.setPinnedInitialState === "function");
    need(
      "ZenWindowSync.propagateWorkspacesToAllWindows",
      typeof WS?.propagateWorkspacesToAllWindows === "function"
    );
    need("ZenWindowSync.firstSyncedWindow", !!WS && "firstSyncedWindow" in WS);

    const win = primaryWindow();
    if (!win) {
      missing.push("no synced browser window");
    } else {
      const fn = (obj, name) => typeof obj?.[name] === "function";
      const W = win.gZenWorkspaces;
      for (const name of [
        "getWorkspaces",
        "propagateWorkspaces",
        "removeWorkspace",
        "moveTabToWorkspace",
        "workspaceElement",
        "getWorkspaceFromId",
      ]) {
        need(`gZenWorkspaces.${name}`, fn(W, name));
      }
      need("gZenWorkspaces.allStoredTabs", !!W && "allStoredTabs" in W);
      need("gZenWorkspaces.promiseInitialized", !!W?.promiseInitialized);
      const F = win.gZenFolders;
      for (const name of ["createFolder", "setFolderUserIcon", "changeFolderToSpace"]) {
        need(`gZenFolders.${name}`, fn(F, name));
      }
      const P = win.gZenPinnedTabManager;
      for (const name of ["addToEssentials", "removeEssentials"]) {
        need(`gZenPinnedTabManager.${name}`, fn(P, name));
      }
      const V = win.gZenViewSplitter;
      for (const name of ["splitTabs", "removeTabFromGroup", "removeGroup"]) {
        need(`gZenViewSplitter.${name}`, fn(V, name));
      }
      need("gZenViewSplitter._data", Array.isArray(V?._data));
      const B = win.gBrowser;
      for (const name of [
        "addTrustedTab",
        "pinTab",
        "unpinTab",
        "removeTab",
        "ungroupTab",
        "isTab",
        "isTabGroup",
        "setIcon",
        "_setTabLabel",
        "discardBrowser",
        "zenHandleTabMove",
      ]) {
        need(`gBrowser.${name}`, fn(B, name));
      }
    }
    return { compatible: missing.length === 0, missing };
  }

  TS.env = {
    modules,
    timer,
    systemGlobal,
    platform: modules.AppConstants?.platform || "unknown",
    isSyncedWindow,
    syncedWindows,
    primaryWindow,
    findElement,
    invalidateTabCaches,
    hostName,
    probe,
    diag(msg) {
      try {
        Services.console.logStringMessage(`[TwilightSync] ${msg}`);
      } catch (e) {
        // ignore
      }
    },
  };
})(this);

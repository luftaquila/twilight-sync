/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * twilight-sync engine — sidebar collection.
 *
 * Builds the same "sidebar" shape ZenSessionStore.#collectWindowData produces
 * (src/zen/sessionstore/ZenSessionManager.sys.mjs), but straight from
 * SessionStore.getWindowState() of every synced window instead of waiting for
 * a session save. That keeps capture fresh without forcing session writes to
 * disk every few seconds.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const Cu_ = typeof Cu !== "undefined" ? Cu : typeof Components !== "undefined" ? Components.utils : null;

  // ZenSessionStore.#isBlankTabData
  function isBlankTabData(tabData) {
    const entries = tabData.entries || [];
    if (!entries.length) {
      return true;
    }
    if (entries.length !== 1) {
      return false;
    }
    const url = entries[0].url;
    return (
      url == "about:blank" ||
      (url == "about:home" && !tabData.splitViewId) ||
      (url == "about:newtab" && !tabData.splitViewId) ||
      url == "about:privatebrowsing"
    );
  }

  // ZenSessionStore.#shouldCollectTab
  function shouldCollectTab(tabData) {
    if (!tabData || (tabData.zenIsEmpty && !tabData.groupId)) {
      return false;
    }
    return !!tabData.zenSyncId || !isBlankTabData(tabData);
  }

  // ZenSessionStore.#isBetterTabData: of two window copies of one tab, keep
  // the non-blank one, then the one that is the live (active) instance.
  function isBetterTabData(candidate, kept) {
    const candidateIsBlank = isBlankTabData(candidate);
    if (candidateIsBlank !== isBlankTabData(kept)) {
      return !candidateIsBlank;
    }
    return !!candidate._zenIsActiveTab;
  }

  function windowStates() {
    const { SessionStore } = TS.env.modules;
    const states = [];
    for (const win of TS.env.syncedWindows()) {
      try {
        let state = SessionStore.getWindowState(win);
        try {
          state = Cu_.waiveXrays(state);
        } catch (e) {
          // already a plain object
        }
        const winData = state?.windows?.[0];
        if (!winData || winData.isPopup || winData.isTaskbarTab || winData.isZenUnsynced) {
          continue;
        }
        states.push(winData);
      } catch (e) {
        // window not tracked (closing / still restoring)
      }
    }
    return states;
  }

  /**
   * Pure part, unit-tested: merges window states into one sidebar.
   *
   * @param {Array<object>} windows - window states, primary window first
   */
  function merge(windows) {
    const byId = new Map();
    for (const winData of windows) {
      for (const tabData of winData.tabs || []) {
        if (!shouldCollectTab(tabData)) {
          continue;
        }
        const kept = byId.get(tabData.zenSyncId);
        if (!kept || isBetterTabData(tabData, kept)) {
          byId.set(tabData.zenSyncId, tabData);
        }
      }
    }
    // Folders and spaces are mirrored to every synced window, so the primary
    // window's copy is authoritative (as in Zen). Split views of normal tabs
    // can live in a single window when only pinned tabs are window-synced,
    // so splits are merged across windows.
    const first = windows[0] || {};
    const splits = new Map();
    for (const winData of windows) {
      for (const split of winData.splitViewData || []) {
        if (split?.groupId && !splits.has(split.groupId)) {
          splits.set(split.groupId, split);
        }
      }
    }
    return {
      windowCount: windows.length,
      tabs: [...byId.values()],
      folders: first.folders || [],
      splitViewData: [...splits.values()],
      spaces: first.spaces || [],
    };
  }

  let stamp = 0;

  function collect() {
    const sidebar = merge(windowStates());
    sidebar.stamp = ++stamp;
    return sidebar;
  }

  /**
   * A freshly opened tab has no TabState in the parent cache until its first
   * content flush, so it would read as blank. Flush every synced window first
   * (bounded: a hung content process must not stall capture).
   */
  async function flush(timeoutMs = 3000) {
    const { TabStateFlusher } = TS.env.modules;
    const flushes = [];
    for (const win of TS.env.syncedWindows()) {
      try {
        flushes.push(Promise.resolve(TabStateFlusher.flushWindow(win)).catch(() => {}));
      } catch (e) {
        // ignore
      }
    }
    let timer = null;
    await Promise.race([
      Promise.all(flushes),
      new Promise(resolve => {
        timer = TS.env.timer.setTimeout(resolve, timeoutMs);
      }),
    ]);
    TS.env.timer.clearTimeout(timer);
  }

  TS.sidebar = { collect, flush, merge, isBlankTabData, shouldCollectTab };
})(this);

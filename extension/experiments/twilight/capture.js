/*
 * twilight-sync engine — lifecycle, capture scheduling, reconnect merge.
 *
 * Capture pipeline: chrome events (Zen's own window-sync events plus space,
 * folder, split, label/icon and top-level location changes, container
 * observers, the customKeys.json watcher and a periodic safety tick) →
 * debounce → flush tab state of every synced window → collect window state
 * (no session write) → resolve holds → digest diff → onLocalChanges.
 *
 * Echo prevention is stateless (see model.js); the scheduling here only
 * reduces noise. The baseline advances only on server acknowledgement, so a
 * lost send simply re-diffs on the next capture.
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const Cu_ = typeof Cu !== "undefined" ? Cu : Components.utils;

  const WINDOW_EVENTS = [
    "TabOpen",
    "TabClose",
    "TabMove",
    "TabPinned",
    "TabUnpinned",
    "TabAddedToEssentials",
    "TabRemovedFromEssentials",
    "TabGrouped",
    "TabUngrouped",
    "TabGroupCreate",
    "TabGroupRemoved",
    "TabGroupMoved",
    "TabGroupUpdate",
    "TabAttrModified",
    "TabBrowserDiscarded",
    "TabSelect",
    "ZenTabIconChanged",
    "ZenTabLabelChanged",
    "ZenTabRemovedFromSplit",
    "ZenSplitViewTabsSplit",
    "ZenWorkspaceDataChanged",
    "ZenWorkspacesUIUpdate",
    "ZenFolderRenamed",
    "ZenFolderChangedWorkspace",
  ];
  const OBSERVER_TOPICS = [
    "contextual-identity-created",
    "contextual-identity-updated",
    "contextual-identity-deleted",
  ];
  const ENV_PREFS = [
    "services.sync.engine.spaces",
    "services.sync.username",
    "zen.window-sync.sync-only-pinned-tabs",
  ];

  const DEBOUNCE_MS = 400;
  const MIN_INTERVAL_MS = 1500;
  const MAX_WAIT_MS = 2500;
  const AFTER_APPLY_MS = 600;
  const PERIODIC_MS = 60 * 1000;
  const PROVISION_BRANCH = "extensions.twilightSync.";
  const DEBUG_TOPIC = "twilight-sync:debug";

  const state = {
    started: false,
    ready: false,
    shuttingDown: false,
    onLocalChanges: null,
    onEnvironmentChanged: null,
    debounceTimer: null,
    pendingSince: 0,
    periodicTimer: null,
    holdTimer: null,
    lastRun: 0,
    running: false,
    rerun: false,
    lastEventAt: 0,
    emptyRetried: false,
    lastPendingKey: "",
    lastGuard: null,
    attached: new WeakMap(),
    wwObserver: null,
    prefObserver: null,
  };

  const options = { normalTabs: true, shortcuts: true, keyMapping: "physical" };

  const timer = () => TS.env.timer;

  /* Mark: environment */

  function readProvision() {
    const out = {};
    const str = name => {
      try {
        const v = Services.prefs.getStringPref(PROVISION_BRANCH + name, "");
        if (v) {
          out[name] = v;
        }
      } catch (e) {
        // ignore
      }
    };
    str("invite");
    str("deviceName");
    str("autoInitial");
    try {
      out.enabled = Services.prefs.getBoolPref(PROVISION_BRANCH + "enabled", false);
    } catch (e) {
      out.enabled = false;
    }
    return out;
  }

  function getEnvironment() {
    const pref = (fn, name, fallback) => {
      try {
        return Services.prefs[fn](name, fallback);
      } catch (e) {
        return fallback;
      }
    };
    const probe = TS.env.probe();
    return {
      compatible: probe.compatible,
      missing: probe.missing,
      ready: state.ready,
      zenVersion: Services.appinfo.version,
      buildId: Services.appinfo.appBuildID,
      platform: TS.env.platform,
      hostName: TS.env.hostName(),
      spacesEngineEnabled: pref("getBoolPref", "services.sync.engine.spaces", false),
      fxaConfigured: !!pref("getStringPref", "services.sync.username", ""),
      syncOnlyPinnedWindows: pref("getBoolPref", "zen.window-sync.sync-only-pinned-tabs", false),
      shortcutsAvailable: !!TS.env.modules.CustomKeys,
      captureGuard: state.lastGuard,
      provision: readProvision(),
      options: { ...options },
    };
  }

  function notifyEnvironment() {
    try {
      state.onEnvironmentChanged?.(getEnvironment());
    } catch (e) {
      // ignore
    }
  }

  /* Mark: lifecycle */

  async function start({ onLocalChanges, onEnvironmentChanged }) {
    state.onLocalChanges = onLocalChanges;
    state.onEnvironmentChanged = onEnvironmentChanged;
    if (state.started) {
      return getEnvironment();
    }
    state.started = true;

    Services.obs.addObserver(observer, "quit-application-granted");
    Services.obs.addObserver(observer, DEBUG_TOPIC);
    for (const topic of OBSERVER_TOPICS) {
      Services.obs.addObserver(observer, topic);
    }
    state.prefObserver = { observe: () => notifyEnvironment() };
    for (const pref of ENV_PREFS) {
      Services.prefs.addObserver(pref, state.prefObserver);
    }

    await awaitReady();
    if (!state.started) {
      return getEnvironment();
    }
    const adopted = TS.model.adoptNativeContainerGuids();
    if (adopted.length) {
      TS.env.diag(`took over Zen's own guids for containers ${adopted.join(", ")}`);
    }
    reconcileStartupLoss();

    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      attachWindow(win);
    }
    state.wwObserver = (subject, topic) => {
      if (topic !== "domwindowopened") {
        return;
      }
      subject.addEventListener(
        "load",
        () => {
          // Zen initializes workspaces after load; attach once it's ready.
          Promise.resolve(subject.gZenWorkspaces?.promiseInitialized)
            .catch(() => {})
            .then(() => {
              attachWindow(subject);
              schedule("window-opened");
            });
        },
        { once: true }
      );
    };
    Services.ww.registerNotification(state.wwObserver);

    await TS.keys.startWatching(() => schedule("shortcuts"));
    state.periodicTimer = timer().setInterval(() => schedule("periodic"), PERIODIC_MS);
    state.ready = true;
    TS.env.diag(`engine ready (Zen ${Services.appinfo.version}, ${TS.env.platform})`);
    schedule("start");
    return getEnvironment();
  }

  /**
   * First-upload gate: a half-restored session reads like "the user closed
   * most tabs". Nothing is captured before every window is restored and a
   * synced window's workspaces are initialized.
   */
  async function awaitReady() {
    try {
      await TS.env.modules.SessionStore.promiseAllWindowsRestored;
    } catch (e) {
      // ignore
    }
    for (let i = 0; i < 240 && state.started; i++) {
      const win = TS.env.primaryWindow();
      if (win?.gZenWorkspaces) {
        try {
          await win.gZenWorkspaces.promiseInitialized;
        } catch (e) {
          // ignore
        }
        return;
      }
      await new Promise(resolve => timer().setTimeout(resolve, 500));
    }
  }

  /**
   * When this session didn't restore open tabs (startup page isn't "resume
   * session", a crash without resume, permanent private browsing — Zen then
   * restores pinned tabs only), open tabs missing now were dropped by the
   * startup, not closed by the user. Forget their baselines so they are
   * re-applied from the server instead of deleted on every device.
   */
  function reconcileStartupLoss() {
    const pref = (fn, name, fallback) => {
      try {
        return Services.prefs[fn](name, fallback);
      } catch (e) {
        return fallback;
      }
    };
    let crashedWithoutResume = false;
    try {
      crashedWithoutResume =
        !!TS.env.modules.SessionStartup?.previousSessionCrashed &&
        !pref("getBoolPref", "browser.sessionstore.resume_from_crash", true);
    } catch (e) {
      // ignore
    }
    const restoresOpenTabs =
      pref("getIntPref", "browser.startup.page", 1) === 3 &&
      !crashedWithoutResume &&
      !TS.env.modules.PrivateBrowsingUtils?.permanentPrivateBrowsing;
    if (restoresOpenTabs) {
      return;
    }
    const K = TS.util.RECORD_KINDS;
    let dropped = 0;
    for (const [id, entry] of Object.entries(TS.model.uploaded())) {
      if (entry.k === K.TAB && !entry.p && !TS.env.findElement(id)) {
        TS.model.dropBaseline(id);
        dropped++;
      }
    }
    if (dropped) {
      TS.env.diag(`session started without open tabs: ${dropped} will be restored from the server`);
    }
  }

  function stop() {
    if (!state.started) {
      return;
    }
    state.started = false;
    state.ready = false;
    timer().clearTimeout(state.debounceTimer);
    timer().clearTimeout(state.holdTimer);
    timer().clearInterval(state.periodicTimer);
    TS.keys.stopWatching();
    for (const topic of ["quit-application-granted", DEBUG_TOPIC, ...OBSERVER_TOPICS]) {
      try {
        Services.obs.removeObserver(observer, topic);
      } catch (e) {
        // ignore
      }
    }
    if (state.prefObserver) {
      for (const pref of ENV_PREFS) {
        try {
          Services.prefs.removeObserver(pref, state.prefObserver);
        } catch (e) {
          // ignore
        }
      }
      state.prefObserver = null;
    }
    if (state.wwObserver) {
      try {
        Services.ww.unregisterNotification(state.wwObserver);
      } catch (e) {
        // ignore
      }
      state.wwObserver = null;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      detachWindow(win);
    }
    state.onLocalChanges = null;
    state.onEnvironmentChanged = null;
  }

  const observer = {
    observe(subject, topic) {
      if (topic === "quit-application-granted") {
        state.shuttingDown = true;
        timer().clearTimeout(state.debounceTimer);
        TS.store.flush().catch(() => {});
        return;
      }
      if (topic === DEBUG_TOPIC) {
        // Diagnostics for the E2E harness and the browser console:
        //   const s = { wrappedJSObject: {} };
        //   Services.obs.notifyObservers(s, "twilight-sync:debug");
        try {
          const holder = subject?.wrappedJSObject;
          if (holder) {
            holder.result = debugSnapshot();
          }
        } catch (e) {
          // ignore
        }
        return;
      }
      schedule(topic);
    },
  };

  function debugSnapshot() {
    const current = TS.model.current();
    return JSON.stringify({
      ready: state.ready,
      applying: TS.apply.isApplying,
      generation: TS.model.getGeneration(),
      baseline: TS.model.uploadedIds().length,
      projected: current.map.size,
      pending: [...current.pending],
      holds: TS.model.getHolds(),
      keysStale: TS.keys.isStale(),
      options: { ...options },
      lastGuard: state.lastGuard,
    });
  }

  /* Mark: window listeners */

  function attachWindow(win) {
    if (!TS.env.isSyncedWindow(win) || state.attached.has(win)) {
      return;
    }
    // A sandbox function handed to a chrome window's addEventListener gets
    // wrapped into something the DOM can't call; export it into the window
    // first.
    let onEvent = event => onWindowEvent(event);
    try {
      onEvent = Cu_.exportFunction(onEvent, win);
    } catch (e) {
      // keep the plain function
    }
    for (const name of WINDOW_EVENTS) {
      win.addEventListener(name, onEvent, true);
    }
    let progress = null;
    try {
      progress = Cu_.cloneInto(
        {
          onLocationChange(browser, webProgress) {
            if (webProgress?.isTopLevel) {
              state.lastEventAt = Date.now();
              schedule("location");
            }
          },
        },
        win,
        { cloneFunctions: true }
      );
      win.gBrowser.addTabsProgressListener(progress);
    } catch (e) {
      progress = null;
    }
    let onUnload = () => detachWindow(win);
    try {
      onUnload = Cu_.exportFunction(onUnload, win);
    } catch (e) {
      // keep the plain function
    }
    win.addEventListener("unload", onUnload, { once: true });
    state.attached.set(win, { onEvent, progress });
  }

  function detachWindow(win) {
    const entry = state.attached.get(win);
    if (!entry) {
      return;
    }
    state.attached.delete(win);
    for (const name of WINDOW_EVENTS) {
      try {
        win.removeEventListener(name, entry.onEvent, true);
      } catch (e) {
        // ignore
      }
    }
    if (entry.progress) {
      try {
        win.gBrowser.removeTabsProgressListener(entry.progress);
      } catch (e) {
        // ignore
      }
    }
  }

  function onWindowEvent(event) {
    if (!state.ready || state.shuttingDown) {
      return;
    }
    const target = event.target;
    try {
      if (target?.hasAttribute?.("zen-library-copy")) {
        return;
      }
    } catch (e) {
      // ignore
    }
    switch (event.type) {
      case "TabAttrModified": {
        let changed = null;
        try {
          changed = [...(Cu_.waiveXrays(event.detail)?.changed || [])];
        } catch (e) {
          changed = [...(event.detail?.changed || [])];
        }
        if (changed.includes("pending")) {
          break;
        }
        if (!changed.includes("label") && !changed.includes("image")) {
          return;
        }
        // Labels and favicons change constantly on live pages. They only
        // matter for an open tab whose record is new or still settling
        // (pinned identity is the pin target; static labels arrive as
        // ZenTabLabelChanged; navigations as location changes).
        try {
          if (target.pinned || !TS.model.wantsSoftUpdate(target.id)) {
            return;
          }
        } catch (e) {
          // fall through and capture
        }
        break;
      }
      case "TabSelect":
      case "TabBrowserDiscarded":
        // Only interesting while a hold may be waiting for this.
        if (!Object.keys(TS.model.getHolds()).length) {
          return;
        }
        break;
      case "TabGroupRemoved":
      case "ZenTabRemovedFromSplit": {
        // See env.invalidateTabCaches: heal the strip caches once the
        // removal has finished.
        const win = target?.ownerGlobal;
        timer().setTimeout(() => TS.env.invalidateTabCaches(win), 0);
        timer().setTimeout(() => TS.env.invalidateTabCaches(win), 300);
        break;
      }
    }
    state.lastEventAt = Date.now();
    schedule(event.type);
  }

  /* Mark: scheduling */

  function schedule(reason) {
    if (!state.started || state.shuttingDown) {
      return;
    }
    const now = Date.now();
    if (state.debounceTimer) {
      // A steady stream of events must not starve the capture forever.
      if (now - state.pendingSince >= MAX_WAIT_MS) {
        return;
      }
      timer().clearTimeout(state.debounceTimer);
    } else {
      state.pendingSince = now;
    }
    const delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - (now - state.lastRun));
    state.debounceTimer = timer().setTimeout(() => {
      state.debounceTimer = null;
      run(reason);
    }, delay);
  }

  /**
   * While a navigation hold waits for its tab to go idle, look again once the
   * idle threshold can have passed (at most every minute).
   */
  function scheduleHoldRecheck() {
    if (state.holdTimer || !Object.keys(TS.model.getHolds()).length) {
      return;
    }
    const delay = Math.min(TS.apply.idleRetargetMs() + 1000, PERIODIC_MS);
    state.holdTimer = timer().setTimeout(() => {
      state.holdTimer = null;
      schedule("hold-recheck");
    }, delay);
  }

  function afterApply() {
    if (!state.started) {
      return;
    }
    timer().clearTimeout(state.debounceTimer);
    state.pendingSince = Date.now();
    state.debounceTimer = timer().setTimeout(() => {
      state.debounceTimer = null;
      run("after-apply");
    }, AFTER_APPLY_MS);
  }

  async function freshProjection() {
    await TS.sidebar.flush();
    await TS.keys.refresh();
    TS.model.invalidate();
    return TS.model.current();
  }

  async function run(reason) {
    if (!state.ready || state.shuttingDown) {
      return;
    }
    if (state.running) {
      state.rerun = true;
      return;
    }
    if (TS.apply.isApplying) {
      // The applier schedules its own follow-up capture when it finishes.
      return;
    }
    state.running = true;
    state.lastRun = Date.now();
    try {
      await TS.sidebar.flush();
      await TS.keys.refresh();
      if (TS.apply.isApplying || !state.ready) {
        return;
      }
      TS.apply.processHolds();
      scheduleHoldRecheck();
      TS.model.invalidate();
      const { changed, deleted } = TS.model.computeChanges();
      const { map, pending } = TS.model.current();
      // Reading window state may have filled the strip caches mid-transition.
      TS.env.invalidateTabCaches();

      // A tab whose first entry hasn't been flushed sits in `pending`
      // (correctly never a deletion). One follow-up per distinct pending set
      // surfaces it in seconds; an unchanging set stops retrying.
      const pendingKey = [...pending].sort().join(",");
      if (pending.size && pendingKey !== state.lastPendingKey) {
        timer().setTimeout(() => schedule("pending-retry"), 2000);
      }
      state.lastPendingKey = pendingKey;

      if (!changed.length && !deleted.length) {
        // A collection right after a burst of tab events can miss the change
        // by a beat; retry once per quiet stretch.
        if (Date.now() - state.lastEventAt < 4000 && !state.emptyRetried) {
          state.emptyRetried = true;
          timer().setTimeout(() => schedule("empty-retry"), 1500);
        }
        state.lastGuard = null;
        return;
      }
      state.emptyRetried = false;

      // Outbound guard: losing nearly every synced tab at once is either a
      // deliberate mass close (e.g. "close all unpinned tabs") or a failure.
      // Everything else still uploads; the deletions wait for the user.
      const K = TS.util.RECORD_KINDS;
      const uploaded = TS.model.uploaded();
      const uploadedTabs = Object.values(uploaded).filter(e => e.k === K.TAB).length;
      let currentTabs = 0;
      for (const [, rec] of map) {
        if (rec.kind === K.TAB) {
          currentTabs++;
        }
      }
      if (deleted.length && uploadedTabs > 30 && currentTabs < uploadedTabs * 0.1) {
        state.lastGuard = { uploadedTabs, currentTabs, wouldDelete: deleted.length };
        TS.env.diag(`capture guard holds ${deleted.length} deletions (${currentTabs}/${uploadedTabs} tabs left)`);
        state.onLocalChanges?.({ changed, deleted: [], heldDeleted: deleted, guard: state.lastGuard });
        return;
      }
      state.lastGuard = null;
      TS.env.diag(`diff (${reason}): changed=${changed.length} deleted=${deleted.length} pending=${pending.size}`);
      state.onLocalChanges?.({ changed, deleted });
    } catch (e) {
      console.error("TwilightSync: capture failed", e);
      TS.env.diag(`capture failed: ${e?.message || e}`);
    } finally {
      state.running = false;
      if (state.rerun) {
        state.rerun = false;
        schedule("rerun");
      }
    }
  }

  /* Mark: reconnect merge */

  /**
   * Applies the server's full record set while preserving offline work:
   *   - deleted here, unchanged on the server since    → keep deleted (push)
   *   - edited here, unchanged on the server since     → keep the edit (push)
   *   - in our baseline but gone from the server       → deleted remotely
   *       (unless edited here meanwhile: kept and re-uploaded as new)
   *   - everything else                                → remote wins
   * Leftover local truth is pushed by the capture that follows.
   */
  async function reconnectMerge(records, { overrideGuard = false } = {}) {
    await freshProjection();
    const local = TS.model.computeChanges();
    const locallyDeleted = new Set(local.deleted);
    const locallyChanged = new Set(local.changed.map(r => r.id));
    const serverIds = new Set();
    const toApply = [];
    for (const record of records || []) {
      if (!record?.id) {
        continue;
      }
      serverIds.add(record.id);
      const base = TS.model.uploadedEntry(record.id);
      const serverUnchanged =
        !!base && base.k === record.kind && base.h === TS.model.hardDigest(record.kind, record.data);
      if (serverUnchanged && (locallyDeleted.has(record.id) || locallyChanged.has(record.id))) {
        continue;
      }
      toApply.push(record);
    }
    const remoteDeleted = [];
    for (const id of TS.model.uploadedIds()) {
      if (serverIds.has(id) || locallyDeleted.has(id)) {
        continue;
      }
      if (locallyChanged.has(id)) {
        TS.model.dropBaseline(id);
        continue;
      }
      remoteDeleted.push(id);
    }
    return TS.apply.apply(toApply, remoteDeleted, { overrideGuard });
  }

  /* Mark: options */

  function setOptions(next = {}) {
    const before = { ...options };
    if (typeof next.normalTabs === "boolean") {
      options.normalTabs = next.normalTabs;
    }
    if (typeof next.shortcuts === "boolean") {
      options.shortcuts = next.shortcuts;
    }
    if (next.keyMapping === "physical" || next.keyMapping === "swap") {
      options.keyMapping = next.keyMapping;
    }
    const keyMappingChanged = before.keyMapping !== options.keyMapping;
    if (keyMappingChanged) {
      // Re-derive the local keymap from the shared one under the new mapping
      // instead of re-uploading local keys re-interpreted.
      TS.model.dropKeyBaselines();
      TS.keys.markStale();
    }
    TS.model.invalidate();
    if (
      before.normalTabs !== options.normalTabs ||
      before.shortcuts !== options.shortcuts ||
      keyMappingChanged
    ) {
      schedule("options");
    }
    return { options: { ...options }, keyMappingChanged };
  }

  TS.capture = {
    options,
    start,
    stop,
    getEnvironment,
    setOptions,
    schedule,
    afterApply,
    freshProjection,
    reconnectMerge,
    forceCapture() {
      state.lastRun = 0;
      schedule("forced");
    },
    get isReady() {
      return state.ready;
    },
  };
})(this);

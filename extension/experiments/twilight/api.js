/* global ExtensionAPI, ExtensionCommon, Services, ChromeUtils */

/*
 * twilightSync experiment API — glue between the background page and the
 * chrome-side engine. The engine scripts are loaded into one shared scope
 * object; each attaches its module to scope.TS.
 *
 * Identity model: record ids are Zen's own ids, verbatim — tab zenSyncId (=
 * DOM id, persisted in session state), folder DOM id, space uuid, split
 * groupId — plus "layout", container guids and "key:<key element id>".
 * After the first sync, document.getElementById(id) resolves every
 * tab/folder/split record on every device.
 */

"use strict";

const ENGINE_FILES = [
  "env.js",
  "util.js",
  "store.js",
  "sidebar.js",
  "project.js",
  "keys.js",
  "model.js",
  "apply.js",
  "capture.js",
];

this.twilightSync = class extends ExtensionAPI {
  onShutdown() {
    try {
      this._scope?.TS?.capture?.stop();
    } catch (e) {
      // ignore
    }
  }

  #engine() {
    if (!this._scope) {
      const scope = {};
      const base = this.extension.rootURI.resolve("experiments/twilight/");
      for (const file of ENGINE_FILES) {
        // Extension files are file:/jar: URLs, which plain loadSubScript
        // refuses since Gecko 159 ("untrusted URI"); this is the same opt-in
        // Firefox uses to load experiment API scripts themselves.
        Services.scriptloader.loadSubScriptWithOptions(base + file, {
          target: scope,
          allowUnsafeURL: true,
        });
      }
      this._scope = scope;
    }
    return this._scope.TS;
  }

  getAPI(context) {
    const api = this;
    const { EventManager } =
      typeof ExtensionCommon !== "undefined"
        ? ExtensionCommon
        : ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs").ExtensionCommon;

    const changeListeners = new Set();
    const envListeners = new Set();
    const dispatch = (set, payload) => {
      for (const listener of set) {
        try {
          listener(payload);
        } catch (e) {
          // ignore
        }
      }
    };
    const guarded = async (fn, fallback) => {
      try {
        return await fn(api.#engine());
      } catch (e) {
        console.error("TwilightSync:", e);
        return typeof fallback === "function" ? fallback(e) : fallback;
      }
    };
    const errorOf = e => e?.message || String(e);

    return {
      twilightSync: {
        start: () =>
          guarded(
            TS =>
              TS.capture.start({
                onLocalChanges: payload => dispatch(changeListeners, payload),
                onEnvironmentChanged: payload => dispatch(envListeners, payload),
              }),
            e => ({ compatible: false, missing: [`engine start failed: ${errorOf(e)}`] })
          ),

        stop: () => guarded(TS => TS.capture.stop(), null),

        getEnvironment: () =>
          guarded(
            TS => TS.capture.getEnvironment(),
            e => ({ compatible: false, missing: [`environment failed: ${errorOf(e)}`] })
          ),

        setOptions: options => guarded(TS => TS.capture.setOptions(options || {}), null),

        setSpacesEnginePref: enabled =>
          guarded(
            () => {
              Services.prefs.setBoolPref("services.sync.engine.spaces", !!enabled);
              return { success: true };
            },
            e => ({ success: false, error: errorOf(e) })
          ),

        getFullProjection: () =>
          guarded(async TS => {
            const { map } = await TS.capture.freshProjection();
            return [...map].map(([id, rec]) => ({ id, kind: rec.kind, data: rec.data }));
          }, null),

        getCounts: () =>
          guarded(async TS => {
            const { map } = await TS.capture.freshProjection();
            const K = TS.util.RECORD_KINDS;
            const counts = { spaces: 0, folders: 0, essentials: 0, pinned: 0, normal: 0, splits: 0, containers: 0, shortcuts: 0 };
            for (const [, rec] of map) {
              switch (rec.kind) {
                case K.SPACE:
                  counts.spaces++;
                  break;
                case K.FOLDER:
                  counts.folders++;
                  break;
                case K.SPLIT:
                  counts.splits++;
                  break;
                case K.CONTAINER:
                  counts.containers++;
                  break;
                case K.KEY:
                  counts.shortcuts++;
                  break;
                case K.TAB:
                  if (rec.data.essential) {
                    counts.essentials++;
                  } else if (rec.data.pinned) {
                    counts.pinned++;
                  } else {
                    counts.normal++;
                  }
                  break;
              }
            }
            return counts;
          }, null),

        applyRecords: payload =>
          guarded(
            TS =>
              TS.apply.apply(payload?.records || [], payload?.deleted || [], {
                reconcile: !!payload?.reconcile,
                overrideGuard: !!payload?.overrideGuard,
              }),
            e => ({
              failed: (payload?.records || []).map(r => r.id).concat(payload?.deleted || []),
              skipped: [],
              guard: null,
              error: errorOf(e),
            })
          ),

        reconnectMerge: payload =>
          guarded(
            TS =>
              TS.capture.reconnectMerge(payload?.records || [], {
                overrideGuard: !!payload?.overrideGuard,
              }),
            e => ({
              failed: (payload?.records || []).map(r => r.id),
              skipped: [],
              guard: null,
              error: errorOf(e),
            })
          ),

        markUploaded: payload =>
          guarded(
            TS => {
              TS.model.markUploaded({ records: payload?.records || [], deleted: payload?.deleted || [] });
              return { success: true };
            },
            e => ({ success: false, error: errorOf(e) })
          ),

        getGeneration: () => guarded(TS => TS.model.getGeneration(), null),

        setGeneration: generation =>
          guarded(
            TS => {
              TS.model.setGeneration(generation);
              return { success: true };
            },
            e => ({ success: false, error: errorOf(e) })
          ),

        resetBaseline: () =>
          guarded(
            TS => {
              TS.model.resetBaseline();
              return { success: true };
            },
            e => ({ success: false, error: errorOf(e) })
          ),

        forceCapture: () =>
          guarded(
            TS => {
              TS.capture.forceCapture();
              return { success: true };
            },
            e => ({ success: false, error: errorOf(e) })
          ),

        debugState: () =>
          guarded(TS => {
            const current = TS.model.current();
            return {
              baseline: TS.model.uploadedIds().length,
              projected: current.map.size,
              pending: [...current.pending],
              holds: TS.model.getHolds(),
              keysStale: TS.keys.isStale(),
              applying: TS.apply.isApplying,
              generation: TS.model.getGeneration(),
            };
          }, null),

        log: msg =>
          guarded(TS => {
            TS.env.diag(String(msg));
            return { success: true };
          }, null),

        onLocalChanges: new EventManager({
          context,
          name: "twilightSync.onLocalChanges",
          register: fire => {
            const listener = payload => fire.async(payload).catch(() => {});
            changeListeners.add(listener);
            return () => changeListeners.delete(listener);
          },
        }).api(),

        onEnvironmentChanged: new EventManager({
          context,
          name: "twilightSync.onEnvironmentChanged",
          register: fire => {
            const listener = payload => fire.async(payload).catch(() => {});
            envListeners.add(listener);
            return () => envListeners.delete(listener);
          },
        }).api(),
      },
    };
  }
};

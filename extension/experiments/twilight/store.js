/*
 * twilight-sync engine — persistent per-profile store.
 *
 * <profile>/twilight-sync.json holds everything that describes THIS profile's
 * relationship with the server:
 *   generation  server store generation the baseline belongs to
 *   uploaded    { id: { k: kind, h: hardDigest, s: softDigest, x?: data } }
 *               — what the server holds for each id, as far as we know
 *               (advanced only from acknowledged payloads and applied records)
 *   containers  { userContextId: guid } — per-profile container identity map
 *   holds       { tabId: { url, title, icon, localUrl, since } } — remote
 *               navigations not yet materialized on a loaded tab
 */

"use strict";

(function (scope) {
  const TS = (scope.TS ||= {});

  const STORE_FILE_NAME = "twilight-sync.json";
  const STORE_VERSION = 1;

  let file = null;

  function data() {
    if (!file) {
      const { JSONFile } = TS.env.modules;
      file = new JSONFile({
        path: TS.PathUtils.join(TS.PathUtils.profileDir, STORE_FILE_NAME),
        dataPostProcessor: d => {
          if (d.version !== STORE_VERSION) {
            // An incompatible baseline is dropped (everything re-diffs and the
            // initial-sync prompt runs again); the container map describes this
            // profile, not the server, and survives.
            d.uploaded = {};
            d.holds = {};
            delete d.generation;
          }
          d.version = STORE_VERSION;
          d.uploaded ||= {};
          d.containers ||= {};
          d.holds ||= {};
          return d;
        },
      });
      file.ensureDataReady();
    }
    return file.data;
  }

  function save() {
    data();
    file.saveSoon();
  }

  TS.store = {
    data,
    save,
    async flush() {
      if (file) {
        await file._save?.();
      }
    },
  };
})(this);

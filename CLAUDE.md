# CLAUDE.md

## Project

Twilight Sync: a Firefox WebExtension with a privileged experiment API plus a small WebSocket server that syncs Zen Browser **Twilight** in real time — spaces, essentials, pinned tabs, folders, open (unpinned) tabs, split views, containers and `about:keyboard` shortcuts — across macOS, Windows and Linux.

Ground-up rewrite of `zen-sidebar-sync` against Twilight 1.25t (Gecko 159) internals. It replaces Zen's native Firefox-Sync Spaces engine (`services.sync.engine.spaces` must be off while connected).

## Layout

- `extension/` — MV2 WebExtension, no build step
  - `experiments/twilight/` — the engine (chrome context, privileged), loaded by `api.js` with `loadSubScriptWithOptions(..., { allowUnsafeURL: true })` into one shared scope; each file attaches to `scope.TS`, in this order:
    - `env.js` — module imports, borrowed WebIDL globals, synced-window helpers, **capability probe**
    - `util.js` — canonical JSON, digests, URL/icon filters, hard/soft record split *(MPL, from Zen)*
    - `store.js` — `<profile>/twilight-sync.json`: generation, baseline, container map, holds
    - `sidebar.js` — sidebar collection from `SessionStore.getWindowState()` of every synced window *(MPL, from Zen)*
    - `project.js` — sidebar → records, pure *(MPL, from Zen's ZenSpacesSyncModel)*
    - `keys.js` — `customKeys.json` watcher, OS modifier mapping, CustomKeys apply
    - `model.js` — diff against the baseline, container guids *(MPL, from Zen)*
    - `apply.js` — records → browser *(MPL, from Zen's ZenSpacesSyncApplier)*
    - `capture.js` — lifecycle, event listeners, capture scheduling, reconnect merge, options, debug topic
    - `api.js` / `schema.json` — `browser.twilightSync` glue
  - `background/` — `main.js` (policy: connection, initial choice, guards, options, popup messaging; server messages processed strictly in order), `transport.js` (WebSocket, backoff, heartbeat)
  - `common/` — `invite.js` (`twsync://` invites), `protocol.js` (wire constants + protocol doc)
  - `popup/` — vanilla UI; destructive buttons are click-twice (`confirm()` doesn't work in popups)
- `server/` — Node ≥ 20, ESM, `ws`; `server.js` + `lib/{records,store,tokens,invite}.js`
- `test/unit` (node:test, engine files loaded into `vm` with shims via `test/helpers/engine.mjs`), `test/server` (spawns the server), `test/e2e` (two real Twilight profiles over Marionette)
- `scripts/build-xpi.mjs` — dependency-free zip writer (works on Windows too)

## Records (protocol v1)

Ids are Zen's own, verbatim: tab `zenSyncId` (= DOM id, persisted by session store), folder DOM id, space `uuid`, split `groupId`; plus container guids (`builtin-N` or a per-profile uuid through the store's `containers` map), the singleton `layout`, and `key:<key element id>`.

```
container { guid, name, icon, color }
space     { uuid, name, icon, theme, containerGuid,
            children: [pinned tabs | folders | pinned splits],     // strip order
            normalChildren: [open tabs | open splits] }            // strip order
tab       { tabId, url, title*, icon*, containerGuid, essential, pinned,
            workspaceUuid, folderId, staticLabel, hasStaticIcon, defaultContainer }
folder    { folderId, name, icon, workspaceUuid, parentFolderId, live, children }
split     { splitId, gridType, pinned, tabs, workspaceUuid, folderId }
layout    { spaces: [uuid], essentials: { containerGuid | "default": [tabId] } }
key       { keyId, mods: [alt|ctrl|meta|shift], key, keycode, cleared }
```
`*` soft fields (see below). Wire messages are documented at the top of `extension/common/protocol.js`.

## Invariants (read before changing the engine)

- **Echo prevention is stateless.** Baseline = per id `{k, h: hardDigest, s: softDigest, p?, x?}`, advanced only from (a) the SENT payload on `put_ok` (never the ack-time projection — a tab changed mid-flight must keep diffing) and (b) the INCOMING record after a successful apply (`noteApplied`). A faithful materialization diffs to nothing; a divergent one re-uploads local truth.
- **Hard vs soft.** Tab `title` and non-static `icon` are soft: excluded from the hard digest and uploaded only within `SETTLE_MS` (20 s) after a hard change made here (or for a record without baseline). Live titles/badges never ping-pong between devices with the same page loaded. Static icons and labels are hard.
- **Deletion only on confirmed absence** (`model.confirmAbsent`): element gone from every synced window (tab/folder/split), space gone from the space list, container identity gone. Anything not projectable this cycle is in `pending` and is never a deletion (no http(s) identity yet, live folder without provider data, option-excluded items, unbindable shortcuts, shortcut state during the post-apply settle window).
- **Options never cause ping-pong.** With open-tab sync off, open tabs and their splits are pending, incoming ones are skipped (unacknowledged), and `space.normalChildren` echoes the baseline (`x.normalChildren`) instead of local state. Shortcut sync off: key records skipped/pending.
- **A page in use is never navigated.** Normal-tab URL changes: unloaded → retarget session state; loaded, invisible, silent, idle ≥ `idleRetargetMs` (3 min; pref `extensions.twilightSync.idleRetargetMs`) → `discardBrowser` then retarget; else a **hold** (stored) whose remote URL the projection reports, so the rest of the record keeps syncing. Holds resolve on unload, user navigation (local wins), convergence, or idleness (re-checked by a timer).
- **Pinned/essential identity is the pin target** (`_zenPinnedInitialState`, set before pinning so `on_TabPinned` keeps it). Navigation inside a pinned tab changes nothing.
- **Shortcuts are physical.** `mods` are physical keys; each device converts with a bijection (`keys.toCanonicalMods`/`toLocalMods`), so records round-trip unchanged on every platform/mapping. `swap` (macOS only) exchanges Ctrl↔⌘. A changed mapping drops key baselines and re-fetches, re-deriving the local keymap from the shared one. CustomKeys folding a customization back into "default" is treated as present (default-equivalence via `getDefaultKey` / key element attributes). After applying, `customKeys.json` is ignored until CustomKeys rewrites it (≤ 5 s).
- **Capture** reads `SessionStore.getWindowState()` of every synced window after `TabStateFlusher.flushWindow()` — no forced session writes. Triggers: Zen's window-sync events, space/folder/split events, top-level location changes (tabs progress listener), container observers, the `customKeys.json` poll (2 s), hold timer, 60 s tick. Debounce 400 ms, min interval 1.5 s, max wait 2.5 s. Label/icon events are ignored unless the tab's record could change (new or settling). Library copies (`zen-library-copy`) are ignored.
- **Apply** runs in the primary synced window (Zen's window sync mirrors it), serialized, `gZenFolders._sessionRestoring` set for visual silence. Order: container upserts → tombstone routing → guard → container/tab/split deletions → spaces → folders (cycles broken, parents first) → tabs → splits → folder deletions (unpack first) → space deletions (deferred, non-blocking confirm with Zen's localized strings; never the last space) → ordering (inversion-only, same parent) → reconcile (initial replace) → keys. New tabs: `addTrustedTab(..., {createLazyBrowser, noInitialLabel, lazyTabTitle, skipRoute: true})`, id set before `ZenWindowSync.on_TabOpen(..., {ignoreExistingId: true})`; essentials via `addToEssentials(tab, {replicating: true})`.
- **Kind transitions** (open ↔ pinned ↔ essential) are field updates on one record: essential cleared first, then pin state, then space move, then folder membership.
- **Guards.** Capture: >90 % of >30 synced tabs vanished at once (a deliberate mass close or a failure) → everything else uploads, the deletions wait for confirmation in the popup (then go out with `force`). Server: >90 % of >30 records deleted by one put → `put_rejected` (only deletions of existing records count, so replays pass) until resent with `force` after confirmation. Apply: a batch deleting >50 % of >10 local items → deletions withheld (skipped, not failed), popup asks.
- **Failures vs skips.** `failed` ids trigger a backoff `fetch` (10 s → 5 min); `skipped` ids (option-excluded, unbindable, withheld) are simply left unacknowledged.
- **Reconnect merge** (`capture.reconnectMerge`): locally deleted or edited records whose server copy is unchanged since our baseline are not re-applied (offline work wins); ids in our baseline but gone from the server are deleted here unless edited here (then re-uploaded as new); everything else applies (server wins).
- **Startup without restore** (startup page ≠ 3, crash without resume, permanent PB): baselines of missing open tabs are dropped so the merge re-applies them instead of deleting them everywhere.
- **Initial choice** (unknown server generation): empty server → push automatically; fresh local profile → replace automatically; otherwise popup: replace (reconcile against live state) / merge / push (CAS on `baseVersion`; a force push retries once on conflict, an initial push re-prompts). The generation is adopted only after the apply demonstrably ran.
- **Fail closed.** `env.probe()` lists every internal the engine touches; anything missing → no capture, no apply, `incompatible` status.
- **Zen strip-cache workaround.** Twilight 1.25t can leave a removed split view's label in the tab container's cached `ariaFocusableItems`; with new tabs opening on top (`zen.view.show-newtab-button-top`, default) the next new tab anchors on that detached node and is silently never inserted (E2E-proven, root-caused). `env.invalidateTabCaches()` (`tabContainer._invalidateCachedTabs()`, which only nulls caches) runs after every capture's state read, after every apply, and 0/300 ms after `TabGroupRemoved`/`ZenTabRemovedFromSplit`.
- **Popup messaging** uses a `runtime.connect({name: 'popup'})` port; the background never `sendMessage`s blindly (that logs an uncaught error per call when no popup is open).

## Server

- `sync-state.json` `{format, generation, version, records: {id: {kind, data, digest, seq, device, updatedAt}}, tombstones: {id: {seq, deletedAt}}}`; atomic debounced writes, flushed on SIGTERM/SIGINT; tombstones GC'd after 60 days.
- Idempotent puts (same digest → no version bump, no broadcast). Space deletion cascades to records still placed in it unless re-placed in the same put.
- Validation per kind (id/data agreement, http(s) tab URLs, key modifiers), icons > 128 KB dropped, records > 512 KB rejected.
- `perMessageDeflate`, any upgrade path (reverse-proxy subpaths), `/healthz`, ping/terminate heartbeat, a reconnecting `deviceId` replaces its stale socket.
- Tokens: SHA-256 hashes in `tokens.json` (0600); `SYNC_TOKEN` registered idempotently; `--invite` prints the invite.

## Commands

```bash
npm test                                   # unit tests
(cd server && npm ci) && npm run test:server
npm run build:xpi                          # dist/twilight-sync-<version>.xpi
ZEN_BIN=/Applications/Twilight.app/Contents/MacOS/zen npm run e2e
#   E2E_ONLY=G1,G3  run selected gates   E2E_BAIL=1  stop at the first failure
#   E2E_WORK=<dir>  keep profiles/logs there
```

More E2E switches: `E2E_HEALTH=1` checks after every gate that a new tab still gets a Zen sync id in both browsers; `E2E_KEEP=1` leaves browsers and servers running after a failure; `E2E_TRACE_WS=1` records ZenWindowSync events/handlers on A (`ZenWindowSync.__ring`, `__pending`). Dev helpers: `node test/e2e/probe.mjs [--with-ext|--with-server] [--async] '<chrome js>'` (throwaway profile), `node test/e2e/attach.mjs <marionette port> '<chrome js>'` (running/kept browser).

Gecko 159 Marionette needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (the harness sets it) for chrome-context scripts, plain `loadSubScript` refuses extension URLs (hence `allowUnsafeURL`), WebDriver window handles are opaque UUIDs (find a tab's handle by switching and matching `location.href`), and any command sent while a modal prompt is open dismisses it. Engine diagnostics: `[TwilightSync]` lines in the browser console, and

```js
const s = { wrappedJSObject: {} };
Services.obs.notifyObservers(s, "twilight-sync:debug");
JSON.parse(s.wrappedJSObject.result);   // baseline size, pending, holds, generation…
```

## Verification

`npm run e2e` against Twilight **1.25t** (BuildID 20261031100347, macOS arm64), 2026-11-05: **all 29 gates** with `E2E_HEALTH=1` — initial push 0.25 s; B materializes with identical ids 0.26 s; idle and echo-free quiescence; open 0.6 s / close 1.5 s / navigate-retarget 1.5 s; a selected loaded tab held, converging ~5 s after it was left (idle threshold 2 s in the test); held tab navigated locally wins; pin/unpin and essential add/remove on one record; pinned navigation without churn; space create/rename/delete (Zen's prompt, accepted); nested folders + rename; split create/unsplit; container + tab in it; open-tab reorder; shortcut change/clear/reset (Ctrl+Shift+Y as `control,shift` both ends); live title churn on both devices → 15 s silence; matrix quiescence; restart keeps ids and stays quiet; offline add/close on both sides merges; 60 tabs in 1.5 s; popup status + open-tab sync off/on on one device without ping-pong; restart without session restore brings 69 open tabs back from the server; a third device merging keeps its own tab and gets the others; closing 109 tabs at once is held and asked on the closing device, then held and asked again on the receiving one, and goes through after both confirmations; apply-side guard holds a 32-tab deletion from a foreign writer.

Not covered by automation: Windows/Linux browsers (unit and server tests run on all three in CI; the OS-specific code is the keymap, unit-tested per platform), multiple windows per profile, live folders, long offline periods (tombstone GC), real network failures.

## Conventions

- Verify every Zen/Firefox internal against the Twilight source at the exact build (`application.ini` SourceStamp) before using it; add it to `env.probe()`.
- Engine files: plain scripts in an IIFE taking `scope`, no top-level bindings shared across files (use `TS.*`); keep pure logic free of chrome globals so it stays unit-testable.
- Server/extension canonical JSON must stay identical (`test/unit/util.test.mjs`); invites too (`test/unit/invite.test.mjs`).
- When behavior changes, update README.md and this file together.

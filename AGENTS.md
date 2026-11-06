# AGENTS.md

- Real-time sync of Zen Browser (1.24b and later, release and Twilight) between devices: a privileged WebExtension and a WebSocket server
- Locations: engine `extension/experiments/twilight`, background `extension/background`, popup `extension/popup`, protocol and invites `extension/common`, server `server`, tests `test/{unit,server,e2e}`, packaging `scripts/build-xpi.mjs`

## AGENTS.md writing rules
- Terse bullets, noun phrases, no ambiguous wording
- Readable by an agent without memory from this file and the repo alone
  - No coined terms; each item clear on its own. Things in code named by their identifiers
- Behavior and formats readable directly from code left out. Core system structure kept
- No rationale, measurements, history, dates or commit hashes. A changed decision rewrites its item; the old one is not kept
- Numbers only when the value itself is the decision. Code constants named by identifier
- Rejected alternatives only as prohibitions, when needed to stop them being proposed again
- One decision per item. Sub-items only for conditions, exceptions and examples; examples from the repo
- New items in their section. No duplication across sections or with `README.md`
- Content matches current code. On a conflict, ask the user which side is right before changing either
- No environment-specific content (local paths, personal toolchain locations)
- No references to private or temporary documents

## System structure
- Engine: chrome-context scripts (`ENGINE_FILES` in `api.js`, in order) loaded into one shared scope with `loadSubScriptWithOptions(..., { allowUnsafeURL: true })`
  - Plain `loadSubScript` refuses extension URLs; `allowUnsafeURL` stays
  - Each file an IIFE taking `scope`, attaching to `scope.TS`; no top-level bindings shared across files
  - Pure logic (`util`, `project`, `model`, `keys`) free of chrome globals, unit-tested in `vm` (`test/helpers/engine.mjs`)
  - MPL files derived from Zen (`util`, `sidebar`, `project`, `model`, `apply`) keep their headers
- Engine state per profile in `twilight-sync.json` (`store.js`): generation, baseline, container map, holds
- Background `main.js` owns policy: connection, initial choice, guards, options. Server messages processed strictly in order
- Popup talks to the background only through a `runtime.connect({name: 'popup'})` port; no blind `sendMessage`
  - No `confirm()` in the popup (unavailable); destructive buttons are click-twice
- Record ids are Zen's own: tab `zenSyncId`, folder DOM id, space `uuid`, split `groupId`; plus container guids, `layout`, `key:<key element id>`
  - Record shapes in `project.js`; wire messages in the header of `extension/common/protocol.js`
- Replaces Zen's own Spaces sync; `services.sync.engine.spaces` off while connected
- Server: one Node process, one versioned record per id, tombstones kept `TOMBSTONE_TTL_MS`
  - Space deletion cascades to records still placed in it unless re-placed in the same put
  - Clients send only `hello` before `welcome`; the server destroys unauthenticated sockets past `PRE_AUTH_MAX_BYTES`

## Sync invariants
- Echo prevention stateless. Baseline per id advanced only from:
  - the sent payload on `put_ok`, never the projection at ack time
  - the incoming record after a successful apply (`noteApplied`)
- Tab `title` and non-static `icon` soft: outside the hard digest, uploaded only within `SETTLE_MS` after a hard change made here or for a record without baseline. Static icons and labels hard
- Deletion only on confirmed absence (`model.confirmAbsent`): gone from every synced window, space gone from the space list, container identity gone
  - Anything not projectable this cycle is `pending`, never a deletion
- Options never cause ping-pong
  - Open-tab sync off: open tabs and their splits pending, incoming ones skipped (unacknowledged), `space.normalChildren` echoes the baseline (`x.normalChildren`)
  - Shortcut sync off: key records skipped and pending
- A page in use never navigated by a remote change
  - Unloaded: session state retargeted
  - Loaded, invisible, silent, idle for `IDLE_RETARGET_MS` (pref `IDLE_RETARGET_PREF`): `discardBrowser`, then retarget
  - Otherwise a stored hold; the projection reports the remote URL. Resolved on unload, local navigation (local wins), convergence or idleness
- Pinned and essential identity is the pin target (`_zenPinnedInitialState`, set before pinning)
- Kind changes (open, pinned, essential) are field updates on one record, in order: essential cleared, pin state, space move, folder membership
- Container guid resolution (`model.js`): store map, then `builtin-N` for a live built-in, then Zen's own map (`ZenSpacesSyncModel`, optional), then a minted uuid
  - A Zen guid another local container already answers to is never adopted
  - Incoming unknown guid tries `adoptMatchingContainer` first: a non-built-in local container with identical name, icon and color, unknown to Zen's sync, whose guid is in neither the baseline nor the batch
  - `adoptNativeContainerGuids` once per profile (`nativeContainersAdopted`); the replaced guid is tombstoned
- Shortcut `mods` are physical keys, converted per device by `keys.toCanonicalMods` and `keys.toLocalMods`
  - `swap` (macOS only) exchanges Ctrl and ⌘
  - Mapping change drops key baselines and re-fetches
  - CustomKeys folding a customization back to its default counts as present
  - After an apply, `customKeys.json` ignored until CustomKeys rewrites it (`APPLY_SETTLE_MS`)
- Capture reads `SessionStore.getWindowState()` of every synced window after `TabStateFlusher.flushWindow()`; no forced session writes
  - Label and icon events ignored unless the record can change; library copies (`zen-library-copy`) ignored
- Apply runs serialized in the primary synced window with `gZenFolders._sessionRestoring` set
  - New tabs: `addTrustedTab(..., { skipRoute: true })`, id set before `ZenWindowSync.on_TabOpen(..., { ignoreExistingId: true })`
  - Essentials: `addToEssentials(tab, { replicating: true })`
  - Remote space deletion: non-blocking confirm with Zen's localized strings; never the last space
  - Ordering: inversions only, within the same parent
- Mass-deletion guards hold back only the deletions; everything else syncs
  - Capture (`capture.js`): nearly all synced tabs gone at once; popup confirmation, then sent with `force`
  - Server (`MASS_DELETE_MIN`, `MASS_DELETE_RATIO`): `put_rejected` until resent with `force`; only deletions of existing records count
  - Apply (`apply.js`): deletions withheld as skipped, popup asks
- `failed` ids: backoff `fetch` (`RETRY_BASE_MS` to `RETRY_MAX_MS`). `skipped` ids: left unacknowledged
- Reconnect merge (`capture.reconnectMerge`)
  - Local deletions and edits whose server copy is unchanged since the baseline: not re-applied
  - In the baseline but gone from the server: deleted here, unless edited here (then re-uploaded)
  - Everything else: server wins
- Session not restored at startup (startup page other than resume, crash without resume, permanent private browsing): baselines of missing open tabs dropped, so the merge brings them back
- Initial choice for an unknown server generation: empty server pushes, fresh profile replaces, otherwise the popup asks (replace, merge, push)
  - Push is compare-and-swap on `baseVersion`
  - Generation adopted only after the apply ran
- Fail closed: every Zen and Firefox internal the engine uses is in `env.probe()`; anything missing means no capture, no apply, `incompatible`
- `env.invalidateTabCaches()` after every capture read, every apply, and after `TabGroupRemoved` and `ZenTabRemovedFromSplit`
  - Zen can keep a removed split view's label in the cached `ariaFocusableItems`; a new tab opened at the top then anchors on it and is never inserted

## Working rules
- Every Zen or Firefox internal checked against the Zen source before use and added to `env.probe()`
- Support floor Zen 1.24b. A new internal must exist there, or be optional with a fallback
- Server and extension canonical JSON identical (`test/unit/util.test.mjs`); invites too (`test/unit/invite.test.mjs`)
- Behavior changes update this file; `README.md` only for setup and the compatibility note
- Release: `v<version>` tag matching `extension/manifest.json` runs `release.yml`. Tags and releases only on user request

## Verification
- `npm test`; `npm run test:server` after `npm ci` in `server`; `npm run e2e` with `ZEN_BIN` set to the Zen binary
  - `E2E_ONLY=G1,G3` selected gates, `E2E_BAIL=1` stop at the first failure, `E2E_WORK=<dir>` keep profiles and logs, `E2E_HEALTH=1` check after each gate that new tabs still get a Zen sync id, `E2E_KEEP=1` leave browsers and servers running after a failure, `E2E_TRACE_WS=1` record ZenWindowSync events on A
  - `test/e2e/probe.mjs` runs chrome JS in a throwaway profile; `test/e2e/attach.mjs` in a running browser
- Passing unit and server tests do not verify browser behavior; engine changes need an E2E run
- Not covered by E2E: Linux browsers, several windows per profile, live folders, long offline periods (tombstone GC), real network failures
- Marionette
  - Chrome-context scripts need `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (set by the harness)
  - Window handles are opaque; a tab's handle is found by switching and matching `location.href`
  - Any command sent while a modal prompt is open dismisses it
- Windows E2E needs the interactive desktop session; browsers started from an SSH session exit at startup
- Engine diagnostics: `[TwilightSync]` console lines; the `twilight-sync:debug` observer topic returns engine state
  - `const s = { wrappedJSObject: {} }; Services.obs.notifyObservers(s, "twilight-sync:debug"); JSON.parse(s.wrappedJSObject.result)`

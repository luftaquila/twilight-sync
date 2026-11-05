# Twilight Sync

Real-time sync for [Zen Browser](https://zen-browser.app) **Twilight** across devices and operating systems:

- **Spaces** — name, icon, theme, container, order
- **Essentials** — per container section, ordered
- **Pinned tabs** — pin target, custom label and icon, folder membership
- **Folders** — nested, named, icons, order (live folders included)
- **Open (unpinned) tabs** — the page they show, their space, their order
- **Split views**, **containers**
- **Keyboard shortcuts** — everything customized in `about:keyboard` (Zen's own shortcuts live there since 1.25t), mapped sensibly between macOS, Windows and Linux

Changes propagate in about a second through a small self-hosted server, instead of Firefox Sync's schedule.

> Zen Twilight ships its own Spaces sync (Firefox Sync based). It doesn't sync keyboard shortcuts, syncs open tabs only behind a hidden pref, and runs on Firefox Sync's schedule. Twilight Sync replaces it; the two must not run at the same time (the popup turns Zen's off with one click).

## How it works

```
┌─────────────────────────────────┐   WebSocket    ┌────────────────┐
│ Zen Twilight + extension        │◄──────────────►│  sync server   │
│  ├ engine (privileged, chrome)  │                │  record map    │
│  │   capture · diff · apply     │                │  + versions    │
│  └ background: transport/policy │                └───────┬────────┘
└─────────────────────────────────┘                        │
┌─────────────────────────────────┐   WebSocket            │
│ Zen Twilight + extension (#2)   │◄───────────────────────┘
└─────────────────────────────────┘
```

- The engine runs inside the browser through an *experiment API*: it reads Zen's live session state and applies changes with Zen's own internals — the same identity model and data layer as Zen's native sync (record ids are Zen's own tab/folder/space/split ids, adopted verbatim on every device).
- Every change is a record diff against what the server last acknowledged; applying a remote record makes it the new baseline, so nothing echoes back.
- The server stores one record per item with a server-assigned version, keeps tombstones for 60 days, and is a single Node.js process.

## Setup

### 1. Server

```bash
docker run -d --name twilight-sync -p 9223:9223 -v twilight-sync-data:/data \
  -e SYNC_TOKEN="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=wss://sync.example.com \
  ghcr.io/luftaquila/twilight-sync:latest
docker exec twilight-sync node server.js --invite   # prints the invite
```

or `docker compose up -d` / `podman-compose up -d` with [`compose.yml`](compose.yml), or without containers:

```bash
cd server && npm ci && SYNC_TOKEN=… PUBLIC_URL=wss://sync.example.com npm start
```

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | listen address (default `0.0.0.0:9223`) |
| `DATA_DIR` | `sync-state.json` + `tokens.json` (default `server/data`, `/data` in the image) |
| `SYNC_TOKEN` | your token; without it one is generated and printed **once** |
| `PUBLIC_URL` | what devices connect to (`wss://…` behind a TLS reverse proxy); goes into the invite |

Put it behind a TLS-terminating reverse proxy for anything beyond a trusted LAN (any path works, so sub-path proxies are fine). `GET /healthz` answers for health checks.

### 2. Extension (every device: macOS, Windows, Linux)

1. In `about:config`:

   | Pref | Value |
   |---|---|
   | `xpinstall.signatures.required` | `false` |
   | `extensions.experiments.enabled` | `true` |

2. Install the `.xpi` (CI artifact, or `npm run build:xpi` → `dist/`) by dragging it onto Zen.
3. Open the toolbar popup, paste the invite, **Connect**. On every further device, use **Copy invite** on a connected one.

On the first connection to a server that already has data, the popup asks how to combine it with this browser: **use the server's**, **merge both**, or **use this device's**. A fresh profile adopts the server's state automatically, and an empty server is seeded automatically.

For unattended setup, the same can come from `user.js`:

```js
user_pref("extensions.twilightSync.invite", "twsync://sync.example.com/?t=<token>");
user_pref("extensions.twilightSync.enabled", true);
user_pref("extensions.twilightSync.deviceName", "Work laptop");     // optional
user_pref("extensions.twilightSync.autoInitial", "merge");          // optional: replace | merge | push
```

## Behavior

**Open tabs never get yanked.** When another device navigates a tab:
- unloaded here → its session entry is retargeted (nothing loads);
- loaded but not in use (not visible in any window, no audio/camera, untouched for 3 minutes) → it is unloaded and retargeted;
- otherwise it is *held*: the page you are looking at stays, and the tab converges once you leave it. Navigating it yourself wins instead.

**Titles don't ping-pong.** A tab's title and favicon travel with its record but only count as a change shortly after a real change (navigation, move, pin…). Notification counters and badge favicons stay local; two devices showing the same page never fight over its title.

**Pinned and essential tabs** sync their pin target, like Zen's own sync: browsing inside a pinned tab doesn't change it anywhere; changing the pinned URL does.

**Containers** keep the identity Zen's own Spaces sync gave them: a profile that used it carries on with the same container ids (a deleted built-in recreated under a new id included), so switching to Twilight Sync doesn't duplicate them on other devices. A container another device made with the same name, icon and color as one here that was never synced is reused rather than duplicated.

**Keyboard shortcuts** sync as physical keys (Ctrl, Alt, Shift, ⌘/Super). The default keeps the same physical key on every OS — Ctrl+T on a Mac becomes Ctrl+T on Windows. On a Mac whose keymap is built around ⌘, choose **Swap** in the popup so ⌘ maps to Ctrl elsewhere. A shortcut that needs the Win key can't be bound on Windows and is skipped there.

**Safety.**
- A deletion is only sent for things that are really gone locally — never because they couldn't be read for a moment.
- Three mass-deletion guards: on capture (closing nearly all synced tabs at once, e.g. "close all unpinned tabs"), on the server (a put deleting >90% of everything), and on apply (a batch deleting >50% of this device's items). Each holds only the deletions — everything else keeps syncing — and asks in the popup.
- A space deleted on another device is removed here only after you confirm (Zen's own prompt); declining restores it everywhere. The last space is never deleted.
- Offline edits survive reconnecting: things you closed or changed offline win over an unchanged server copy; things deleted elsewhere while you were offline are deleted here, unless you edited them meanwhile.
- If Zen was started without restoring open tabs (startup page not "previous session", or after a crash without resume), missing open tabs are restored from the server instead of being deleted everywhere.
- The extension probes every Zen internal it uses at startup and disables itself if one is missing, rather than half-working on a changed Twilight build.

**Options** (popup, per device): open-tab sync and shortcut sync can each be turned off; spaces, essentials, pinned tabs and folders always sync. Devices with different settings coexist without conflicts.

## Limitations

- Requires Zen **Twilight** 1.25t internals (Gecko 159). Release builds and future Twilight builds that change these internals will be refused by the compatibility probe until updated.
- Unsigned extension with an experiment API: needs the two `about:config` prefs above.
- Not synced: split-view pane sizes, folder collapsed state, tab history (back/forward), Firefox tab groups of unpinned tabs (their tabs sync flat), private and unsynced windows.
- Favicons of open tabs sync only when they are local images (data:, chrome:); website favicons appear once the tab loads.
- A loaded tab you are actively using can show a different page than other devices until you leave it (by design, see above).
- Conflicts are last-writer-wins per record, ordered by the server.

## Development

```bash
npm test                 # unit tests (projection, keymap, diff, records, invites)
cd server && npm ci && cd .. && npm run test:server   # server protocol tests
npm run build:xpi        # dist/twilight-sync-<version>.xpi
ZEN_BIN=/Applications/Twilight.app/Contents/MacOS/zen npm run e2e   # real two-browser test
```

The E2E run launches throwaway Twilight profiles under Marionette, installs the extension, and walks 29 gates: propagation of every record kind, quiescence (no echo, no ping-pong), holds, shortcuts, restarts (with and without session restore), offline merge, a third device merging, per-device options, scale and the guards (including their popup confirmations). Last full pass: Twilight 1.25t on macOS, 29/29. See [CLAUDE.md](CLAUDE.md) for the architecture, protocol notes and E2E switches.

## License

MIT. Files derived from Zen Browser keep their MPL-2.0 headers (see [LICENSE](LICENSE)).

// Two-profile end-to-end test against a real Zen Twilight build.
//
//   ZEN_BIN=/Applications/Twilight.app/Contents/MacOS/zen node test/e2e/run.mjs
//   (Windows: "C:\Program Files\Zen Twilight\zen.exe", Linux: path to zen)
//
// Starts the sync server and a page server, launches two throwaway profiles
// with Marionette, installs the extension temporarily, provisions it through
// extensions.twilightSync.* prefs (A pushes, B replaces), then walks the
// gates below. Two browser windows open on the desktop while it runs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Marionette } from './marionette.mjs';
import { SERVER_TARGET, startSyncServer as startServerProcess, stopSyncServer as stopServerProcess } from '../helpers/sync-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WebSocket = createRequire(join(root, 'server/package.json'))('ws');

function defaultZenBin() {
  if (platform() === 'darwin') return '/Applications/Twilight.app/Contents/MacOS/zen';
  if (platform() === 'win32') return 'C:\\Program Files\\Zen Twilight\\zen.exe';
  return '/opt/zen-twilight/zen';
}
const ZEN_BIN = process.env.ZEN_BIN || defaultZenBin();
if (!existsSync(ZEN_BIN)) {
  console.error(`Zen binary not found: ${ZEN_BIN} (set ZEN_BIN)`);
  process.exit(2);
}
const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',')) : null;
const BAIL = process.env.E2E_BAIL === '1';
const HEALTH = process.env.E2E_HEALTH === '1';

const SYNC_PORT = 9600 + Math.floor(Math.random() * 300);
const HTTP_PORT = SYNC_PORT + 1;
const TOKEN = 'e2e-token';
const WORK = process.env.E2E_WORK || mkdtempSync(join(tmpdir(), 'twsync-e2e-'));
mkdirSync(WORK, { recursive: true });
console.log(`workdir ${WORK}\nzen ${ZEN_BIN}\nserver ${SERVER_TARGET}`);

/* Mark: reporting */

const results = [];
let failures = 0;
const log = line => {
  results.push(line);
  console.log(line);
};
const ok = (label, extra = '') => log(`  ok    ${label}${extra ? `  (${extra})` : ''}`);
const fail = (label, extra = '') => {
  failures++;
  log(`  FAIL  ${label}${extra ? `  (${extra})` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch (e) {
      last = null;
    }
    if (last) return { value: last, ms: Date.now() - start };
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`);
    await sleep(interval);
  }
}

async function gate(name, label, fn) {
  if (ONLY && !ONLY.has(name)) return;
  try {
    const extra = await fn();
    ok(`${name}: ${label}`, typeof extra === 'string' ? extra : '');
  } catch (e) {
    fail(`${name}: ${label}`, e.message);
    if (BAIL) throw new Error(`bailing after ${name}`);
  }
  if (HEALTH) {
    for (const b of [A, B]) {
      if (!b.mar) continue;
      const healthy = await b
        .execAsync(`const cached = W.gBrowser.tabContainer.ariaFocusableItems;
          const staleItems = cached.filter(x => !x.isConnected).map(x => (x.tagName || '?') + '#' + (x.id || (x.group && x.group.id) || ''));
          const t = W.gBrowser.addTrustedTab('about:blank', { inBackground: true });
          const at0 = { connected: t.isConnected, parent: t.parentNode && (t.parentNode.className || t.parentNode.tagName) };
          setTimeout(() => {
            if (t.id) { W.gBrowser.removeTab(t); return done(true); }
            const chain = []; let n = t; for (let i = 0; i < 6 && n; i++) { chain.push((n.tagName || n.nodeName) + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(' ')[0] : '')); n = n.parentNode; }
            const main = Services.wm.getMostRecentWindow('navigator:browser');
            const info = { staleItems, at0, connected: t.isConnected, chain, inTabs: W.gBrowser.tabs.includes(t), sameWindow: W === main, windows: [...Services.wm.getEnumerator(null)].map(w => w.document.documentElement.getAttribute('windowtype') || w.location.href), selected: W.gBrowser.selectedTab.id, splitView: W.gZenViewSplitter.currentView };
            W.gBrowser.removeTab(t);
            done(JSON.stringify(info));
          }, 1500);`)
        .catch(e => `error ${e.message}`);
      if (healthy !== true) {
        fail(`health after "${label}"`, `${b.name}: new tabs get no sync id (Zen window sync stalled): ${healthy}`);
        if (BAIL) throw new Error('bailing on health');
      }
    }
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* Mark: servers */

const serverDir = join(WORK, 'server');
mkdirSync(serverDir, { recursive: true });
const serverLog = createWriteStream(join(WORK, 'server.log'), { flags: 'a' });
let serverProc = null;

async function startSyncServer() {
  serverProc = await startServerProcess({ port: SYNC_PORT, dataDir: serverDir, token: TOKEN, onOutput: chunk => serverLog.write(chunk) });
}

function stopSyncServer() {
  return stopServerProcess(serverProc, 'SIGKILL');
}

const pageServer = http.createServer((req, res) => {
  const [, kind, n = '0'] = req.url.split('/');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (kind === 'dyn') {
    // A page whose title keeps changing (notification-counter style).
    res.end(`<!doctype html><title>Dyn ${n} (0)</title><script>let i=0;setInterval(()=>{document.title='Dyn ${n} ('+(++i)+')'},700)</script><h1>Dyn ${n}</h1>`);
    return;
  }
  res.end(`<!doctype html><title>Page ${n}</title><h1>Page ${n}</h1>`);
});
const page = n => `http://127.0.0.1:${HTTP_PORT}/p/${n}`;
const dyn = n => `http://127.0.0.1:${HTTP_PORT}/dyn/${n}`;

/* Mark: observer (mirrors the server) */

class Observer {
  records = new Map();
  version = 0;
  generation = null;
  events = [];
  devices = new Map(); // name → deviceId
  #ws;

  connect() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(`ws://127.0.0.1:${SYNC_PORT}`);
      this.#ws.on('open', () =>
        this.#ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: TOKEN, deviceId: 'observer', deviceName: 'observer', platform: 'test' }))
      );
      this.#ws.on('error', reject);
      this.#ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.devices) {
          for (const d of msg.devices) this.devices.set(d.name, d.deviceId);
        }
        if (msg.type === 'welcome' || msg.type === 'state') {
          this.records = new Map(msg.records.map(r => [r.id, r]));
          this.version = msg.version;
          this.generation = msg.generation;
          if (msg.type === 'state') this.events.push({ at: Date.now(), source: msg.source || 'state', ids: msg.records.map(r => r.id), deleted: [] });
          if (msg.type === 'welcome') resolve();
        } else if (msg.type === 'changes') {
          for (const r of msg.records) this.records.set(r.id, r);
          for (const id of msg.deleted) this.records.delete(id);
          this.version = msg.version;
          this.events.push({ at: Date.now(), source: msg.source, ids: msg.records.map(r => r.id), deleted: msg.deleted });
        } else if (msg.type === 'force_disable') {
          this.events.push({ at: Date.now(), source: 'admin', ids: [], deleted: [] });
        }
      });
    });
  }

  get(id) {
    return this.records.get(id)?.data ?? null;
  }

  ofKind(kind) {
    return [...this.records.values()].filter(r => r.kind === kind);
  }

  since(t) {
    return this.events.filter(e => e.at >= t);
  }

  put(records, deleted, { force = false } = {}) {
    this.#ws.send(JSON.stringify({ type: 'put', reqId: `obs${Date.now()}`, records, deleted, force }));
  }

  close() {
    try {
      this.#ws.close();
    } catch {}
  }
}

/* Mark: browsers */

const CHROME_HELPERS = `
  const W = window;
  const el = id => W.document.getElementById(id);
  const sessionOf = tab => {
    try {
      const s = JSON.parse(W.SessionStore.getTabState(tab));
      const e = s.entries || [];
      if (!e.length) return { url: null, title: '' };
      const i = Math.min(Math.max((s.index || e.length) - 1, 0), e.length - 1);
      return { url: e[i]?.url || null, title: e[i]?.title || '' };
    } catch (x) { return { url: null, title: '' }; }
  };
  const tabInfo = id => {
    const t = el(id);
    if (!t || !W.gBrowser.isTab(t)) return null;
    return {
      id,
      pinned: !!t.pinned,
      essential: t.hasAttribute('zen-essential'),
      ws: t.getAttribute('zen-workspace-id'),
      folder: t.group && t.group.isZenFolder ? t.group.id : null,
      split: t.group && t.group.hasAttribute && t.group.hasAttribute('split-view-group') ? t.group.id : null,
      loaded: !!t.linkedPanel && !t.hasAttribute('pending'),
      liveUrl: t.linkedBrowser && t.linkedBrowser.currentURI ? t.linkedBrowser.currentURI.spec : null,
      session: sessionOf(t),
      label: t.label,
      ctx: t.userContextId,
      pinUrl: t._zenPinnedInitialState && t._zenPinnedInitialState.entry ? t._zenPinnedInitialState.entry.url : null,
      selected: !!t.selected,
    };
  };
  const debugState = () => {
    const holder = { wrappedJSObject: {} };
    Services.obs.notifyObservers(holder, 'twilight-sync:debug');
    return holder.wrappedJSObject.result ? JSON.parse(holder.wrappedJSObject.result) : null;
  };
  const CK = () => ChromeUtils.importESModule('moz-src:///browser/components/customkeys/CustomKeys.sys.mjs').CustomKeys;
  const CIS = () => ChromeUtils.importESModule('moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs').ContextualIdentityService;
`;

class Browser {
  constructor(name, marionettePort) {
    this.name = name;
    this.port = marionettePort;
    this.dir = join(WORK, `profile-${name}`);
  }

  writeProfile(autoInitial) {
    mkdirSync(this.dir, { recursive: true });
    const prefs = {
      'marionette.port': this.port,
      'browser.shell.checkDefaultBrowser': false,
      'app.update.disabledForTesting': true,
      'app.update.auto': false,
      'datareporting.policy.dataSubmissionEnabled': false,
      'toolkit.telemetry.reportingpolicy.firstRun': false,
      'browser.sessionstore.resume_from_crash': false,
      'browser.aboutwelcome.enabled': false,
      'startup.homepage_welcome_url': '',
      'startup.homepage_override_url': '',
      'browser.startup.homepage_override.mstone': 'ignore',
      'zen.welcome-screen.seen': true,
      'zen.tab-unloader.enabled': false,
      'browser.tabs.warnOnClose': false,
      'browser.warnOnQuit': false,
      'browser.warnOnQuitShortcut': false,
      'xpinstall.signatures.required': false,
      'extensions.experiments.enabled': true,
      'services.sync.engine.spaces': false,
      'extensions.twilightSync.invite': `twsync://127.0.0.1:${SYNC_PORT}/?t=${TOKEN}&s=0`,
      'extensions.twilightSync.deviceName': `e2e-${this.name}`,
      'extensions.twilightSync.enabled': true,
      'extensions.twilightSync.autoInitial': autoInitial,
      'extensions.twilightSync.idleRetargetMs': 2000,
    };
    writeFileSync(
      join(this.dir, 'user.js'),
      Object.entries(prefs)
        .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join('\n')
    );
  }

  async launch() {
    const out = createWriteStream(join(WORK, `${this.name}.log`), { flags: 'a' });
    this.proc = spawn(ZEN_BIN, ['--marionette', '--remote-allow-system-access', '-no-remote', '-profile', this.dir], {
      env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    });
    this.proc.stdout.pipe(out);
    this.proc.stderr.pipe(out);
    this.mar = await Marionette.connect(this.port);
    await this.mar.newSession();
    // Wait for Zen's spaces to initialize.
    await waitFor(() => this.exec(`return !!(window.gZenWorkspaces && window.gZenWorkspaces.getWorkspaces().length);`), {
      timeout: 60000,
      label: `${this.name} spaces ready`,
    });
  }

  install() {
    return this.mar.installAddon(join(root, 'extension'));
  }

  exec(body, args = []) {
    return this.mar.exec(`${CHROME_HELPERS}\n${body}`, args);
  }

  execAsync(body, args = []) {
    return this.mar.execAsync(`${CHROME_HELPERS}\nconst done = arguments[arguments.length - 1];\n${body}`, args);
  }

  tab(id) {
    return this.exec(`return tabInfo(arguments[0]);`, [id]);
  }

  /** Opens the extension popup page in a tab; content() then targets it. */
  async openPopupPage() {
    const { tabId, url } = await this.execAsync(
      `const url = WebExtensionPolicy.getByID('twilight-sync@luftaquila').getURL('popup/popup.html');
       const t = W.gBrowser.addTrustedTab(url, { inBackground: false });
       W.gBrowser.selectedTab = t;
       const wait = () => (t.id ? setTimeout(() => done({ tabId: t.id, url }), 1500) : setTimeout(wait, 100));
       wait();`
    );
    this.contentUrl = url;
    this.contentHandle = null;
    return tabId;
  }

  /** Runs a script in the popup page opened by openPopupPage(). */
  async content(body, args = []) {
    await this.mar.send('Marionette:SetContext', { value: 'content' });
    try {
      if (!this.contentHandle) {
        // WebDriver handles are opaque: find the tab showing the popup page.
        for (const handle of await this.mar.send('WebDriver:GetWindowHandles')) {
          await this.mar.send('WebDriver:SwitchToWindow', { handle, focus: false });
          if ((await this.mar.exec('return location.href;')) === this.contentUrl) {
            this.contentHandle = handle;
            break;
          }
        }
        if (!this.contentHandle) throw new Error('popup tab not found');
      } else {
        await this.mar.send('WebDriver:SwitchToWindow', { handle: this.contentHandle, focus: false });
      }
      return await this.mar.exec(body, args);
    } finally {
      await this.mar.send('Marionette:SetContext', { value: 'chrome' });
    }
  }

  debug() {
    return this.exec(`return debugState();`);
  }

  /** Opens a background tab; resolves with its sync id once Zen assigned one. */
  async openTab(url, { select = false } = {}) {
    return this.execAsync(
      `const t = W.gBrowser.addTrustedTab(arguments[0], { inBackground: !arguments[1] });
       const wait = () => (t.id ? done(t.id) : setTimeout(wait, 100));
       wait();`,
      [url, select]
    );
  }

  async quit() {
    try {
      await this.mar.exec('Services.startup.quit(Services.startup.eAttemptQuit);');
    } catch {}
    this.mar.close();
    await new Promise(resolve => {
      if (this.proc.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 20000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  kill() {
    try {
      this.mar?.close();
    } catch {}
    try {
      this.proc?.kill('SIGKILL');
    } catch {}
  }

  async dumpConsole() {
    try {
      const alert = await this.mar.alertText();
      if (alert !== null) console.log(`--- ${this.name} open dialog: ${JSON.stringify(alert)}`);
      const lines = await this.mar.exec(`
        const msgs = Services.console.getMessageArray().map(m => {
          try {
            if (m instanceof Ci.nsIScriptError) return '[err] ' + m.errorMessage + ' @ ' + (m.sourceName || '?') + ':' + m.lineNumber;
            return m.message || String(m);
          } catch (e) { return String(m); }
        });
        const ours = msgs.filter(s => /TwilightSync|twilight-sync|twilight\\//i.test(s));
        return [...ours.slice(-60), '--- recent errors ---', ...msgs.filter(s => s.startsWith('[err]')).slice(-20)];
      `);
      console.log(`--- ${this.name} console ---`);
      for (const line of lines || []) console.log(`  ${line}`);
    } catch (e) {
      console.log(`(console dump failed for ${this.name}: ${e.message})`);
    }
  }
}

/* Mark: scenario */

const observer = new Observer();
const A = new Browser('a', 2840 + Math.floor(Math.random() * 50));
const B = new Browser('b', A.port + 100);
const extraBrowsers = [];

async function quietFor(ms, label) {
  const start = Date.now();
  const v0 = observer.version;
  await sleep(ms);
  const events = observer.since(start);
  assert(observer.version === v0 && events.length === 0, `${label}: version ${v0}→${observer.version}, ${JSON.stringify(events).slice(0, 400)}`);
  return `${ms / 1000}s quiet`;
}

async function teardown() {
  for (const b of [A, B, ...extraBrowsers]) b.kill();
  await stopSyncServer();
  pageServer.close();
  observer.close();
}

process.on('SIGINT', async () => {
  await teardown();
  process.exit(130);
});

try {
  await startSyncServer();
  pageServer.listen(HTTP_PORT, '127.0.0.1');
  await observer.connect();
  ok('servers up');

  // ---- Device A: seeded before the extension exists ----
  A.writeProfile('push');
  await A.launch();
  if (process.env.E2E_TRACE_WS === '1') {
    // Record ZenWindowSync handlers that never settle (debugging aid).
    await A.exec(`
      const { ZenWindowSync } = ChromeUtils.importESModule('resource:///modules/zen/ZenWindowSync.sys.mjs');
      const pending = (ZenWindowSync.__pending = new Map());
      const ring = (ZenWindowSync.__ring = []);
      const push = s => { ring.push(Date.now() % 100000 + ' ' + s); if (ring.length > 300) ring.shift(); };
      const origHandle = ZenWindowSync.handleEvent;
      ZenWindowSync.handleEvent = function (e) {
        push('E ' + e.type + ' ' + (e.target?.id || e.target?.tagName || '') + ' ct=' + (e.currentTarget === window ? 'win' : String(e.currentTarget)));
        return origHandle.call(this, e);
      };
      let seq = 0;
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(ZenWindowSync))) {
        if (!name.startsWith('on_')) continue;
        const orig = ZenWindowSync[name];
        ZenWindowSync[name] = function (event, ...rest) {
          const id = ++seq;
          const t = event?.target;
          pending.set(id, { name, at: Date.now(), target: (t?.id || t?.tagName || '') + '' });
          push('H> ' + name + ' ' + (t?.id || ''));
          let result;
          try { result = orig.call(this, event, ...rest); } catch (e) { pending.delete(id); push('H! ' + name + ' ' + e); throw e; }
          Promise.resolve(result).finally(() => { pending.delete(id); push('H< ' + name); });
          return result;
        };
      }
    `);
  }
  const seed = await A.execAsync(`
    const B_ = W.gBrowser;
    const t1 = B_.addTrustedTab(${JSON.stringify(page(1))}, { inBackground: true });
    const t2 = B_.addTrustedTab(${JSON.stringify(page(2))}, { inBackground: true });
    const t3 = B_.addTrustedTab(${JSON.stringify(page(3))}, { inBackground: true });
    setTimeout(() => {
      B_.pinTab(t2);
      W.gZenPinnedTabManager.addToEssentials(t3);
      setTimeout(() => done({ t1: t1.id, t2: t2.id, t3: t3.id, ws: W.gZenWorkspaces.activeWorkspace }), 1200);
    }, 1500);
  `);
  assert(seed?.t1 && seed?.t2 && seed?.t3, `seeding failed: ${JSON.stringify(seed)}`);
  ok('A seeded (open, pinned, essential)');
  await A.install();

  await gate('G1', 'A pushes its state on first connect', async () => {
    const { ms } = await waitFor(() => observer.get(seed.t1) && observer.get(seed.t2) && observer.get(seed.t3), {
      timeout: 90000,
      label: 'initial push',
    });
    const [t1, t2, t3] = [observer.get(seed.t1), observer.get(seed.t2), observer.get(seed.t3)];
    assert(t1.url === page(1) && !t1.pinned && !t1.essential && t1.workspaceUuid === seed.ws, `t1 ${JSON.stringify(t1)}`);
    assert(t2.pinned && !t2.essential && t2.url === page(2), `t2 ${JSON.stringify(t2)}`);
    assert(t3.essential && t3.pinned && t3.workspaceUuid === null, `t3 ${JSON.stringify(t3)}`);
    assert(observer.get(seed.ws) && observer.get('layout'), 'space/layout records');
    assert(observer.get(seed.ws).normalChildren.includes(seed.t1), 'open tab in space normalChildren');
    return `${ms}ms`;
  });

  await gate('G2', 'idle A uploads nothing', async () => {
    await sleep(6000);
    return quietFor(12000, 'A idle');
  });

  // ---- Device B: replaces its local state with the server's ----
  B.writeProfile('replace');
  await B.launch();
  await B.install();

  await gate('G3', "B materializes A's state with identical ids", async () => {
    const { ms } = await waitFor(
      async () => {
        const [t1, t2, t3] = await Promise.all([B.tab(seed.t1), B.tab(seed.t2), B.tab(seed.t3)]);
        return t1 && t2?.pinned && t3?.essential && { t1, t2, t3 };
      },
      { timeout: 90000, label: 'B materialization' }
    );
    const spaces = await B.exec(`return W.gZenWorkspaces.getWorkspaces().map(s => s.uuid);`);
    assert(spaces.includes(seed.ws), `space uuid not adopted: ${JSON.stringify(spaces)}`);
    const t1 = await B.tab(seed.t1);
    assert(!t1.loaded, 'synced open tab arrives unloaded');
    assert(t1.session.url === page(1), `t1 session url ${t1.session.url}`);
    assert(t1.ws === seed.ws, `t1 space ${t1.ws}`);
    return `${ms}ms`;
  });

  await gate('G3', 'echo-free: B uploads nothing after materializing', async () => {
    await sleep(6000);
    return quietFor(12000, 'B echo');
  });

  // ---- Realtime matrix ----
  let t4;
  await gate('G4a', 'open tab A→B', async () => {
    const start = Date.now();
    t4 = await A.openTab(page(4));
    await waitFor(async () => (await B.tab(t4))?.session.url === page(4), { label: 'open propagation' });
    return `${Date.now() - start}ms`;
  });

  await gate('G4b', 'close tab B→A', async () => {
    const start = Date.now();
    await B.exec(`const t = el(arguments[0]); if (t) W.gBrowser.removeTab(t);`, [t4]);
    await waitFor(async () => !(await A.tab(t4)), { label: 'close propagation' });
    return `${Date.now() - start}ms`;
  });

  let t5;
  await gate('G4c', 'navigate on A retargets the unloaded copy on B without loading it', async () => {
    t5 = await A.openTab(page(5));
    await waitFor(async () => (await B.tab(t5))?.session.url === page(5), { label: 't5 on B' });
    const start = Date.now();
    await A.exec(`el(arguments[0]).linkedBrowser.loadURI(Services.io.newURI(arguments[1]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [t5, page(55)]);
    await waitFor(async () => (await B.tab(t5))?.session.url === page(55), { label: 'retarget on B' });
    const info = await B.tab(t5);
    assert(!info.loaded, 'B copy must stay unloaded');
    return `${Date.now() - start}ms`;
  });

  await gate('G4d', 'a loaded tab in use is never navigated; it converges once idle', async () => {
    // B selects t5 (loads it), A navigates it: B must hold, not yank.
    await B.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [t5]);
    await waitFor(async () => (await B.tab(t5))?.liveUrl === page(55), { label: 'B loads t5' });
    await A.exec(`el(arguments[0]).linkedBrowser.loadURI(Services.io.newURI(arguments[1]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [t5, page(56)]);
    await waitFor(async () => (await B.debug())?.holds?.[t5]?.url === page(56), { label: 'hold on B' });
    const held = await B.tab(t5);
    assert(held.liveUrl === page(55), `B's visible tab was navigated to ${held.liveUrl}`);
    // The server keeps A's URL (no ping-pong from B's stale page).
    await sleep(3000);
    assert(observer.get(t5).url === page(56), `server url ${observer.get(t5).url}`);
    // Leave the tab; after the idle threshold it is unloaded and retargeted.
    await B.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [seed.t1]);
    const { ms } = await waitFor(
      async () => {
        const info = await B.tab(t5);
        return !info.loaded && info.session.url === page(56);
      },
      { timeout: 30000, label: 'idle retarget' }
    );
    await waitFor(async () => !(await B.debug())?.holds?.[t5], { timeout: 10000, label: 'hold dropped' });
    return `converged ${ms}ms after leaving the tab`;
  });

  await gate('G4e', 'navigating a held tab yourself wins', async () => {
    await B.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [t5]);
    await waitFor(async () => (await B.tab(t5))?.liveUrl === page(56), { label: 'B loads t5 again' });
    await A.exec(`el(arguments[0]).linkedBrowser.loadURI(Services.io.newURI(arguments[1]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [t5, page(57)]);
    await waitFor(async () => (await B.debug())?.holds?.[t5], { label: 'hold' });
    await B.exec(`el(arguments[0]).linkedBrowser.loadURI(Services.io.newURI(arguments[1]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [t5, page(58)]);
    await waitFor(() => observer.get(t5)?.url === page(58), { label: "B's navigation reaches the server" });
    await waitFor(async () => !(await B.debug())?.holds?.[t5], { label: 'hold dropped' });
    await B.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [seed.t1]);
    return 'local navigation uploaded';
  });

  await gate('G4f', 'pin / unpin keep the same record', async () => {
    await A.exec(`W.gBrowser.pinTab(el(arguments[0]));`, [seed.t1]);
    await waitFor(async () => (await B.tab(seed.t1))?.pinned, { label: 'pin on B' });
    await A.exec(`W.gBrowser.unpinTab(el(arguments[0]));`, [seed.t1]);
    await waitFor(async () => (await B.tab(seed.t1))?.pinned === false, { label: 'unpin on B' });
    const info = await B.tab(seed.t1);
    assert(info.ws === seed.ws, `space after unpin ${info.ws}`);
    return 'normal→pinned→normal';
  });

  await gate('G4g', 'pinned tab navigation does not change its record (pin target is identity)', async () => {
    const v0 = observer.version;
    await A.exec(`el(arguments[0]).linkedBrowser.loadURI(Services.io.newURI(arguments[1]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [seed.t2, page(22)]);
    await sleep(6000);
    assert(observer.get(seed.t2).url === page(2), `pinned record url ${observer.get(seed.t2).url}`);
    return observer.version === v0 ? 'no churn' : `version moved ${v0}→${observer.version} (other records)`;
  });

  await gate('G4h', 'essentials: add and remove', async () => {
    await A.exec(`W.gZenPinnedTabManager.addToEssentials(el(arguments[0]));`, [t5]);
    await waitFor(async () => (await B.tab(t5))?.essential, { label: 'essential on B' });
    await A.exec(`W.gZenPinnedTabManager.removeEssentials(el(arguments[0]), false);`, [t5]);
    await waitFor(async () => (await B.tab(t5))?.essential === false, { label: 'un-essential on B' });
    return 'ok';
  });

  let ws2;
  await gate('G4i', 'space create and rename', async () => {
    ws2 = await A.execAsync(`W.gZenWorkspaces.createAndSaveWorkspace('E2E Space', undefined, true).then(ws => done(ws.uuid));`);
    await waitFor(async () => (await B.exec(`return W.gZenWorkspaces.getWorkspaces().some(s => s.uuid === arguments[0]);`, [ws2])), { label: 'space on B' });
    await A.exec(`const s = W.gZenWorkspaces.getWorkspaceFromId(arguments[0]); s.name = 'Renamed Space'; W.gZenWorkspaces.saveWorkspace(s);`, [ws2]);
    await waitFor(async () => (await B.exec(`return W.gZenWorkspaces.getWorkspaceFromId(arguments[0])?.name;`, [ws2])) === 'Renamed Space', { label: 'rename on B' });
    return ws2;
  });

  let folderId;
  let t6;
  await gate('G4j', 'folder with a pinned tab, nested subfolder, rename', async () => {
    t6 = await A.openTab(page(6));
    folderId = await A.exec(`const f = W.gZenFolders.createFolder([el(arguments[0])], { label: 'E2E Folder', workspaceId: W.gZenWorkspaces.activeWorkspace }); return f.id;`, [t6]);
    await waitFor(async () => (await B.tab(t6))?.folder === folderId, { label: 'folder on B' });
    const label = await B.exec(`return el(arguments[0])?.label;`, [folderId]);
    assert(label === 'E2E Folder', `folder label ${label}`);
    await A.exec(`el(arguments[0]).label = 'Renamed Folder'; el(arguments[0]).dispatchEvent(new W.CustomEvent('TabGroupUpdate', { bubbles: true }));`, [folderId]);
    await waitFor(async () => (await B.exec(`return el(arguments[0])?.label;`, [folderId])) === 'Renamed Folder', { label: 'folder rename on B' });
    // Nested: a subfolder holding its own pinned tab.
    const t7 = await A.openTab(page(66));
    const subId = await A.exec(
      `const parent = el(arguments[0]);
       const sub = W.gZenFolders.createFolder([el(arguments[1])], { label: 'E2E Sub', insertAfter: parent.groupContainer.lastElementChild });
       return sub.id;`,
      [folderId, t7]
    );
    await waitFor(async () => (await B.tab(t7))?.folder === subId, { label: 'subfolder tab on B' });
    const parentOnB = await B.exec(`return el(arguments[0])?.group?.id || null;`, [subId]);
    assert(parentOnB === folderId, `subfolder parent on B: ${parentOnB}`);
    return `${folderId} ⊃ ${subId}`;
  });

  let splitId;
  let s1;
  let s2;
  await gate('G4S', 'split view create and unsplit', async () => {
    s1 = await A.openTab(page(7));
    s2 = await A.openTab(page(8));
    await waitFor(async () => (await B.tab(s1)) && (await B.tab(s2)), { label: 'split tabs on B' });
    splitId = await A.exec(`const g = W.gZenViewSplitter.splitTabs([el(arguments[0]), el(arguments[1])], 'vsep', -1); return g?.groupId || el(arguments[0]).group?.id;`, [s1, s2]);
    await waitFor(async () => (await B.tab(s1))?.split === splitId && (await B.tab(s2))?.split === splitId, { label: 'split on B' });
    await A.exec(`const i = W.gZenViewSplitter._data.findIndex(g => g.groupId === arguments[0]); W.gZenViewSplitter.removeGroup(i);`, [splitId]);
    await waitFor(async () => !(await B.tab(s1))?.split && (await B.tab(s1)), { label: 'unsplit on B' });
    return splitId;
  });

  await gate('G4C', 'container create, and a tab in it', async () => {
    const userContextId = await A.exec(`return CIS().create('E2E Container', 'fingerprint', 'purple').userContextId;`);
    const tc = await A.execAsync(
      `const t = W.gBrowser.addTrustedTab(arguments[0], { inBackground: true, userContextId: arguments[1] });
       const wait = () => (t.id ? done(t.id) : setTimeout(wait, 100)); wait();`,
      [page(9), userContextId]
    );
    await waitFor(async () => (await B.exec(`return CIS().getPublicIdentities().some(i => i.name === 'E2E Container');`)), { label: 'container on B' });
    const info = await waitFor(async () => (await B.tab(tc))?.ctx > 0 && (await B.tab(tc)), { label: 'container tab on B' });
    const name = await B.exec(`return CIS().getPublicIdentityFromId(arguments[0])?.name;`, [info.value.ctx]);
    assert(name === 'E2E Container', `B tab container ${name}`);
    return `ctx ${info.value.ctx}`;
  });

  await gate('G4k', 'open-tab reorder', async () => {
    const [x, y] = [await A.openTab(page(10)), await A.openTab(page(11))];
    await waitFor(async () => (await B.tab(x)) && (await B.tab(y)), { label: 'reorder tabs on B' });
    await A.exec(`const x = el(arguments[0]), y = el(arguments[1]); W.gBrowser.zenHandleTabMove(y, () => x.before(y));`, [x, y]);
    await waitFor(
      async () => (await B.exec(`const x = el(arguments[0]), y = el(arguments[1]); return !!(x && y && (y.compareDocumentPosition(x) & W.Node.DOCUMENT_POSITION_FOLLOWING));`, [x, y])),
      { label: 'order on B' }
    );
    return 'y before x on B';
  });

  await gate('G5', 'keyboard shortcuts: change, clear, reset', async () => {
    // key_reload → Ctrl+Shift+Y on A (CustomKeys format of this platform).
    const platform = await A.exec(`return AppConstants.platform;`).catch(() => null);
    const ctrl = platform === 'macosx' ? 'control' : 'accel';
    await A.exec(`CK().changeKey('key_reload', { modifiers: arguments[0], key: 'Y' });`, [`${ctrl},shift`]);
    await waitFor(() => observer.get('key:key_reload')?.key === 'Y', { label: 'shortcut uploaded' });
    const rec = observer.get('key:key_reload');
    assert(JSON.stringify(rec.mods) === '["ctrl","shift"]', `canonical mods ${JSON.stringify(rec.mods)}`);
    await waitFor(async () => (await B.exec(`const k = el('key_reload'); return k && k.getAttribute('key') === 'Y' && k.getAttribute('modifiers');`)), {
      label: 'shortcut on B',
    });
    const mods = await B.exec(`return el('key_reload').getAttribute('modifiers');`);
    assert(mods === `${ctrl},shift`, `B modifiers ${mods}`);
    await A.exec(`CK().clearKey('key_viewSource');`);
    await waitFor(() => observer.get('key:key_viewSource')?.cleared, { label: 'cleared uploaded' });
    await waitFor(async () => (await B.exec(`const k = el('key_viewSource'); return k && !k.getAttribute('key') && !k.getAttribute('keycode');`)), {
      label: 'cleared on B',
    });
    await A.exec(`CK().resetKey('key_reload');`);
    await waitFor(() => !observer.get('key:key_reload'), { label: 'reset uploaded (tombstone)' });
    await waitFor(async () => (await B.exec(`return el('key_reload').getAttribute('key') !== 'Y';`)), { label: 'reset on B' });
    return `mods ${mods}`;
  });

  await gate('G6', 'live title churn on a page loaded on both devices never ping-pongs', async () => {
    const td = await A.openTab(dyn(1), { select: true });
    await waitFor(async () => (await B.tab(td)), { label: 'dyn tab on B' });
    await B.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [td]);
    await waitFor(async () => (await B.tab(td))?.loaded, { label: 'dyn loaded on B' });
    // Let the settle window pass, then expect silence despite titles changing.
    await sleep(25000);
    const r = await quietFor(15000, 'title churn');
    await B.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [seed.t1]);
    await A.exec(`W.gBrowser.selectedTab = el(arguments[0]);`, [seed.t1]);
    return r;
  });

  await gate('G7', 'remote space deletion asks first, then applies', async () => {
    await A.execAsync(`W.gZenWorkspaces.removeWorkspace(arguments[0]).then(() => done(true));`, [ws2]);
    // While Zen's prompt is open, any other Marionette command would make it
    // dismiss the dialog (= decline), so only the prompt is touched here.
    const { value: text } = await waitFor(() => B.mar.alertText(), { label: 'confirmation on B' });
    assert(/space|Space/.test(text), `dialog text ${text}`);
    assert(observer.get(ws2) === null, 'server dropped the space');
    await B.mar.acceptAlert();
    await waitFor(async () => !(await B.exec(`return W.gZenWorkspaces.getWorkspaces().some(s => s.uuid === arguments[0]);`, [ws2])), { label: 'space removed on B' });
    return 'confirmed';
  });

  await gate('G8', 'matrix quiescence (no A↔B ping-pong)', async () => {
    await sleep(8000);
    return quietFor(15000, 'post-matrix');
  });

  await gate('G9', 'B restart: ids survive, nothing re-uploads', async () => {
    const before = await B.exec(`return W.gZenWorkspaces.allStoredTabs.map(t => t.id).filter(Boolean).sort();`);
    await B.quit();
    await B.launch();
    // Temporary add-ons don't survive a restart; the profile's sync store does.
    await B.install();
    await waitFor(async () => (await B.debug())?.ready, { timeout: 60000, label: 'engine ready after restart' });
    const after = await B.exec(`return W.gZenWorkspaces.allStoredTabs.map(t => t.id).filter(Boolean).sort();`);
    // Only synced tabs matter (a blank startup tab isn't restored by Zen).
    const missing = before.filter(id => observer.records.has(id) && !after.includes(id));
    assert(!missing.length, `synced ids lost: ${missing.join(',')}`);
    await sleep(8000);
    return quietFor(12000, 'post-restart');
  });

  await gate('G10', 'offline edits on both sides merge on reconnect', async () => {
    const victim = await A.openTab(page(30));
    await waitFor(async () => (await B.tab(victim)), { label: 'victim on B' });
    await stopSyncServer();
    await sleep(1500);
    const offlineA = await A.openTab(page(31));
    await B.exec(`W.gBrowser.removeTab(el(arguments[0]));`, [victim]);
    await sleep(3000);
    await startSyncServer();
    await observer.connect();
    await waitFor(async () => (await B.tab(offlineA)), { timeout: 60000, label: "A's offline tab on B" });
    await waitFor(async () => !(await A.tab(victim)), { timeout: 60000, label: "B's offline close on A" });
    assert(!observer.get(victim), 'closed tab resurrected on the server');
    return 'converged';
  });

  await gate('G11', '60 tabs at once', async () => {
    const start = Date.now();
    const ids = await A.execAsync(`
      const tabs = [];
      for (let i = 0; i < 60; i++) tabs.push(W.gBrowser.addTrustedTab(arguments[0] + i, { inBackground: true, createLazyBrowser: true }));
      const wait = () => (tabs.every(t => t.id) ? done(tabs.map(t => t.id)) : setTimeout(wait, 100));
      wait();
    `, [`http://127.0.0.1:${HTTP_PORT}/p/bulk`]);
    await waitFor(async () => (await B.exec(`return arguments[0].every(id => !!el(id));`, [ids])), { timeout: 60000, label: '60 tabs on B' });
    return `${Date.now() - start}ms`;
  });

  await gate('G13', 'popup shows status; open-tab sync off/on per device without ping-pong', async () => {
    const popupTab = await B.openPopupPage();
    const { value: pill } = await waitFor(
      async () => {
        const text = await B.content(`return document.getElementById('pill').textContent;`);
        return text === 'Syncing' && text;
      },
      { timeout: 15000, label: 'popup status' }
    );
    const counts = await B.content(`return [...document.querySelectorAll('.count b')].map(b => b.textContent).join(',');`);
    assert(counts.split(',').length === 8, `counts ${counts}`);
    // Turn open-tab sync off on B only.
    await B.content(`document.getElementById('opt-normal').click();`);
    await waitFor(async () => (await B.debug())?.options?.normalTabs === false, { label: 'option applied' });
    const start = Date.now();
    const hidden = await A.openTab(page(40));
    await sleep(6000);
    assert(!(await B.tab(hidden)), 'B received an open tab while open-tab sync is off');
    // A's space record changed (new open tab); B must not fight over it.
    const bId = observer.devices.get('e2e-b');
    const bEvents = observer.since(start).filter(e => e.source === bId && (e.ids.length || e.deleted.length));
    assert(!bEvents.some(e => e.ids.includes(seed.ws)), `B re-uploaded the space: ${JSON.stringify(bEvents).slice(0, 300)}`);
    // Back on: B pulls what it skipped.
    await B.content(`document.getElementById('opt-normal').click();`);
    await waitFor(async () => (await B.tab(hidden)), { timeout: 20000, label: 'skipped tab arrives after re-enabling' });
    await B.exec(`const t = el(arguments[0]); if (t) W.gBrowser.removeTab(t); W.gBrowser.selectedTab = el(arguments[1]);`, [popupTab, seed.t1]);
    return `popup "${pill}", counts ${counts}`;
  });

  await gate('G14', 'restart without session restore: open tabs come back from the server, nothing is deleted', async () => {
    const openOnServer = () => observer.ofKind('tab').filter(r => !r.data.pinned).map(r => r.id).sort();
    const before = openOnServer();
    await B.exec(`Services.prefs.setIntPref('browser.startup.page', 1);`);
    await B.quit();
    await B.launch();
    await B.install();
    await waitFor(async () => (await B.debug())?.ready, { timeout: 60000, label: 'engine ready' });
    const { ms } = await waitFor(async () => (await B.exec(`return arguments[0].every(id => !!el(id));`, [before])), {
      timeout: 60000,
      label: 'open tabs restored from the server',
    });
    await sleep(5000);
    const after = openOnServer();
    const lost = before.filter(id => !after.includes(id));
    assert(!lost.length, `server lost ${lost.length} open tabs`);
    const note = await B.exec(
      `return Services.console.getMessageArray().map(m => m.message || '').find(t => t.includes('session started without open tabs')) || null;`
    );
    assert(note, 'Zen restored the open tabs itself — the no-restore path was not exercised');
    await B.exec(`Services.prefs.setIntPref('browser.startup.page', 3);`);
    return `${before.length} open tabs back in ${ms}ms; ${note.replace('[TwilightSync] ', '')}`;
  });

  await gate('G15', 'a third device merges: keeps its own tabs and gets everyone else\'s', async () => {
    const C = new Browser('c', B.port + 100);
    C.writeProfile('merge');
    await C.launch();
    extraBrowsers.push(C);
    const local = await C.openTab(page(90));
    await C.exec(`W.gBrowser.pinTab(el(arguments[0]));`, [local]);
    // Containers: one that Zen's own sync named (a built-in recreated under a
    // new id) keeps that shared guid; one made here with the same name, icon
    // and color as a server container (G4C) is reused, not duplicated.
    const nativeCtx = await C.exec(`
      if (CIS().getPublicIdentityFromId(2)) CIS().remove(2);
      const work = CIS().create('Native Work', 'briefcase', 'orange');
      ChromeUtils.importESModule('resource:///modules/zen/ZenSpacesSyncModel.sys.mjs')
        .ZenSpacesSyncModel.registerContainerGuid('builtin-2', work.userContextId);
      CIS().create('E2E Container', 'fingerprint', 'purple');
      return work.userContextId;
    `);
    await sleep(1500);
    await C.install();
    await waitFor(async () => (await C.tab(seed.t2))?.pinned, { timeout: 90000, label: "server's pinned tab on C" });
    await waitFor(async () => (await A.tab(local))?.pinned, { timeout: 30000, label: "C's own tab on A" });
    assert(await C.tab(local), 'C lost its own tab');
    await waitFor(() => observer.records.get('builtin-2')?.data?.name === 'Native Work', {
      timeout: 30000,
      label: "C's container under Zen's guid on the server",
    });
    // A gets it once — as its own built-in 2 if it has one (Twilight profiles
    // start without built-ins), otherwise as a new container mapped to it.
    await waitFor(
      async () => (await A.exec(`return CIS().getPublicIdentities().filter(i => i.name === 'Native Work').length;`)) === 1,
      { timeout: 30000, label: "C's container on A" }
    );
    const containerNames = [...observer.records.values()].filter(r => r.kind === 'container').map(r => r.data?.name);
    for (const name of ['E2E Container', 'Native Work']) {
      const n = containerNames.filter(x => x === name).length;
      assert(n === 1, `${n} '${name}' records on the server: ${JSON.stringify(containerNames)}`);
    }
    const onC = await C.exec(`return CIS().getPublicIdentities().filter(i => i.name === 'E2E Container').length;`);
    assert(onC === 1, `${onC} 'E2E Container' containers on C`);
    const works = await C.exec(`return CIS().getPublicIdentities().filter(i => i.name === 'Native Work').map(i => i.userContextId);`);
    assert(works.length === 1 && works[0] === nativeCtx, `C's 'Native Work' containers: ${JSON.stringify(works)}`);
    await sleep(3000);
    await quietFor(10000, 'three devices after the merge');
    await C.quit();
    extraBrowsers.splice(extraBrowsers.indexOf(C), 1);
    return `union; containers ${JSON.stringify(containerNames)}`;
  });

  await gate('G16', 'closing nearly every tab asks first, then deletes everywhere after confirmations', async () => {
    const extra = await A.execAsync(`
      const tabs = [];
      for (let i = 0; i < 40; i++) tabs.push(W.gBrowser.addTrustedTab(arguments[0] + i, { inBackground: true, createLazyBrowser: true }));
      const wait = () => (tabs.every(t => t.id) ? done(tabs.map(t => t.id)) : setTimeout(wait, 100));
      wait();
    `, [`http://127.0.0.1:${HTTP_PORT}/p/closeall`]);
    await waitFor(() => extra.every(id => observer.records.has(id)), { timeout: 30000, label: 'extra tabs synced' });
    await waitFor(async () => (await B.exec(`return arguments[0].every(id => !!el(id));`, [extra])), { timeout: 60000, label: 'extra tabs on B' });
    const openIds = await A.exec(
      `return W.gZenWorkspaces.allStoredTabs.filter(t => !t.pinned && !t.hasAttribute('zen-essential') && t.id && !t.hasAttribute('zen-empty-tab')).map(t => t.id);`
    );
    const synced = openIds.filter(id => observer.records.has(id));
    assert(synced.length > 30, `need >30 synced open tabs, have ${synced.length}`);
    await A.exec(`for (const id of arguments[0]) { const t = el(id); if (t) W.gBrowser.removeTab(t); }`, [openIds]);
    // A holds the deletions and asks.
    await A.openPopupPage();
    await waitFor(async () => (await A.content(`return document.getElementById('pill').textContent;`)) === 'Needs confirmation', {
      timeout: 20000,
      label: 'guard prompt on A',
    });
    assert(synced.every(id => observer.records.has(id)), 'deletions left A before confirmation');
    await A.content(`document.getElementById('guard-confirm').click();`);
    await waitFor(() => synced.every(id => !observer.records.has(id)), { timeout: 20000, label: 'deletions on the server' });
    // B withholds such a large incoming deletion until confirmed there too.
    await sleep(3000);
    const stillOnB = await B.exec(`return arguments[0].filter(id => !!el(id)).length;`, [synced]);
    assert(stillOnB === synced.length, `B deleted ${synced.length - stillOnB} tabs without asking`);
    await B.openPopupPage();
    await waitFor(async () => (await B.content(`return document.getElementById('pill').textContent;`)) === 'Needs confirmation', {
      timeout: 20000,
      label: 'guard prompt on B',
    });
    await B.content(`document.getElementById('guard-confirm').click();`);
    await waitFor(async () => (await B.exec(`return arguments[0].every(id => !el(id));`, [synced])), { timeout: 30000, label: 'B deletes after confirming' });
    for (const b of [A, B]) {
      await b.exec(`for (const t of [...W.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.startsWith('moz-extension:')) W.gBrowser.removeTab(t);`);
    }
    return `${synced.length} tabs, confirmed on both`;
  });

  await gate('G12', 'apply-side guard withholds a mass deletion', async () => {
    // Fresh tabs so this gate stands on its own.
    const bulk = await A.execAsync(`
      const tabs = [];
      for (let i = 0; i < 40; i++) tabs.push(W.gBrowser.addTrustedTab(arguments[0] + i, { inBackground: true, createLazyBrowser: true }));
      const wait = () => (tabs.every(t => t.id) ? done(tabs.map(t => t.id)) : setTimeout(wait, 100));
      wait();
    `, [`http://127.0.0.1:${HTTP_PORT}/p/guard`]);
    await waitFor(async () => (await B.exec(`return arguments[0].every(id => !!el(id));`, [bulk])), { timeout: 60000, label: 'guard tabs on B' });
    const tabs = bulk;
    const doomed = tabs.slice(0, Math.ceil(tabs.length * 0.8));
    observer.put([], doomed, { force: true });
    await waitFor(async () => {
      const present = await B.exec(`return arguments[0].filter(id => !!el(id)).length;`, [doomed]);
      return present === doomed.length;
    }, { timeout: 5000, label: 'tabs still present' });
    await sleep(4000);
    const present = await B.exec(`return arguments[0].filter(id => !!el(id)).length;`, [doomed]);
    assert(present === doomed.length, `B deleted ${doomed.length - present} tabs`);
    return `${doomed.length} deletions held`;
  });
} catch (e) {
  fail('fatal', e.stack || e.message);
} finally {
  if (failures) {
    for (const b of [A, B]) if (b.mar) await b.dumpConsole();
  }
  console.log('\n=== summary ===');
  for (const line of results) console.log(line);
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'} — logs in ${WORK}`);
  if (failures && process.env.E2E_KEEP === '1') {
    // Leave the browsers (and servers) running for inspection.
    console.log(`kept: A marionette ${A.port}, B marionette ${B.port}, sync ${SYNC_PORT} (Ctrl+C to stop)`);
    for (const b of [A, B]) b.mar?.close();
    await new Promise(() => {});
  }
  await teardown();
  process.exit(failures ? 1 : 0);
}

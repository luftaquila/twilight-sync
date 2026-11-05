// Development helper: launches one throwaway Twilight profile under
// Marionette, runs a chrome-context snippet, prints the result, quits.
//
//   ZEN_BIN=… node test/e2e/probe.mjs 'return window.gZenWorkspaces.getWorkspaces().length'
//   ZEN_BIN=… node test/e2e/probe.mjs --async 'setTimeout(() => done(1), 100)'
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { Marionette } from './marionette.mjs';

const ZEN_BIN =
  process.env.ZEN_BIN ||
  (platform() === 'darwin' ? '/Applications/Twilight.app/Contents/MacOS/zen' : platform() === 'win32' ? 'C:\\Program Files\\Zen Twilight\\zen.exe' : '/opt/zen-twilight/zen');
if (!existsSync(ZEN_BIN)) {
  console.error(`Zen binary not found: ${ZEN_BIN}`);
  process.exit(2);
}
let args = process.argv.slice(2);
const withServer = args[0] === '--with-server';
if (withServer) args = args.slice(1);
const withExt = withServer || args[0] === '--with-ext';
if (args[0] === '--with-ext') args = args.slice(1);
const isAsync = args[0] === '--async';
const body = isAsync ? args[1] : args[0];
const port = 2990 + Math.floor(Math.random() * 100);
const dir = mkdtempSync(join(tmpdir(), 'twsync-probe-'));
const syncPort = 9900 + Math.floor(Math.random() * 90);
let server = null;
if (withServer) {
  const dataDir = mkdtempSync(join(tmpdir(), 'twsync-probe-server-'));
  server = spawn(process.execPath, [new URL('../../server/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(syncPort), HOST: '127.0.0.1', DATA_DIR: dataDir, SYNC_TOKEN: 'probe' },
    stdio: 'ignore',
  });
  await new Promise(r => setTimeout(r, 800));
}
writeFileSync(
  join(dir, 'user.js'),
  [
    ['marionette.port', port],
    ['browser.shell.checkDefaultBrowser', false],
    ['app.update.disabledForTesting', true],
    ['zen.welcome-screen.seen', true],
    ['browser.aboutwelcome.enabled', false],
    ['xpinstall.signatures.required', false],
    ['extensions.experiments.enabled', true],
    ['services.sync.engine.spaces', false],
    ...(withServer
      ? [
          ['extensions.twilightSync.invite', `twsync://127.0.0.1:${syncPort}/?t=probe&s=0`],
          ['extensions.twilightSync.enabled', true],
          ['extensions.twilightSync.autoInitial', 'push'],
        ]
      : []),
  ]
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n')
);
const proc = spawn(ZEN_BIN, ['--marionette', '-no-remote', '-profile', dir], {
  env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  stdio: 'ignore',
});
const mar = await Marionette.connect(port);
await mar.newSession();
for (let i = 0; i < 120; i++) {
  if (await mar.exec('return !!(window.gZenWorkspaces && window.gZenWorkspaces.getWorkspaces().length)').catch(() => false)) break;
  await new Promise(r => setTimeout(r, 500));
}
if (withExt) {
  await mar.installAddon(new URL('../../extension', import.meta.url).pathname);
  for (let i = 0; i < 60; i++) {
    const ready = await mar
      .exec(`const h = { wrappedJSObject: {} }; Services.obs.notifyObservers(h, 'twilight-sync:debug'); return h.wrappedJSObject.result ? JSON.parse(h.wrappedJSObject.result).ready : false;`)
      .catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 500));
  }
}
try {
  const result = isAsync
    ? await mar.execAsync(`const done = arguments[arguments.length - 1];\n${body}`)
    : await mar.exec(body);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('error:', e.message);
}
try {
  await mar.exec('Services.startup.quit(Services.startup.eForceQuit)');
} catch {}
mar.close();
setTimeout(() => {
  proc.kill('SIGKILL');
  server?.kill('SIGKILL');
  process.exit(0);
}, 1500);

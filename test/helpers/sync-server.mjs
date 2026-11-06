// Starts the sync server for tests: the Node server (default) or the
// Cloudflare Worker under `wrangler dev` (SYNC_SERVER=worker). Both serve the
// same protocol on 127.0.0.1:<port>.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const SERVER_TARGET = process.env.SYNC_SERVER === 'worker' ? 'worker' : 'node';

/**
 * Resolves with the child process once it accepts connections. `dataDir`
 * holds the server state (the Worker's local Durable Object storage), so a
 * restart with the same directory keeps it. `onOutput` receives stdout and
 * stderr chunks.
 */
export function startSyncServer({ port, dataDir, token, onOutput = () => {} }) {
  const proc =
    SERVER_TARGET === 'worker'
      ? spawn(
          process.execPath,
          [
            join(root, 'server/node_modules/wrangler/bin/wrangler.js'),
            'dev',
            '--ip', '127.0.0.1',
            '--port', String(port),
            '--var', `SYNC_TOKEN:${token}`,
            '--persist-to', dataDir,
          ],
          { cwd: join(root, 'server'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] }
        )
      : spawn(process.execPath, [join(root, 'server/server.js')], {
          env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, SYNC_TOKEN: token },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
  const ready = SERVER_TARGET === 'worker' ? 'Ready on' : 'Twilight Sync server on';
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = chunk => {
      onOutput(chunk);
      output += String(chunk);
      if (output.includes(ready)) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', code => reject(new Error(`sync server exited ${code}:\n${output.slice(-2000)}`)));
  });
}

/**
 * Stops it; SIGTERM lets the Node server flush its debounced save. The Worker
 * always goes down with its process tree: a killed wrangler leaves its workerd
 * child serving the port (SIGTERM on POSIX, taskkill /T on Windows).
 */
export function stopSyncServer(proc, signal = 'SIGTERM') {
  return new Promise(resolve => {
    if (!proc || proc.exitCode !== null) return resolve();
    if (SERVER_TARGET === 'worker' && process.platform === 'win32') {
      // Windows releases workerd's storage files about a second after the
      // tree is gone; a restart on the same directory before that hangs.
      proc.once('exit', () => setTimeout(resolve, 2000));
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    proc.once('exit', () => resolve());
    proc.kill(SERVER_TARGET === 'worker' ? 'SIGTERM' : signal);
  });
}

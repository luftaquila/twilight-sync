// Development helper: runs a chrome-context snippet in an already running
// Zen started with --marionette (e.g. one kept by E2E_KEEP=1).
//   node test/e2e/attach.mjs <port> '<script>'   |   --async variant like probe.mjs
import { Marionette } from './marionette.mjs';
const [port, ...rest] = process.argv.slice(2);
const isAsync = rest[0] === '--async';
const body = isAsync ? rest[1] : rest[0];
const mar = await Marionette.connect(Number(port), { timeoutMs: 10000 });
await mar.newSession();
try {
  const result = isAsync ? await mar.execAsync(`const done = arguments[arguments.length - 1];\n${body}`) : await mar.exec(body);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('error:', e.message);
}
await mar.send('WebDriver:DeleteSession').catch(() => {});
mar.close();

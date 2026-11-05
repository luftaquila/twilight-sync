/**
 * Builds the one-paste invite the extension consumes (mirror of
 * extension/common/invite.js buildInvite; test/unit/invite.test.mjs keeps
 * the two in agreement):
 *   twsync://<host>[:<port>][/<path>]/?t=<token>[&s=0]
 */
export function buildInvite({ publicUrl, port, token }) {
  let host = '';
  let secure = true;
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      secure = u.protocol === 'wss:' || u.protocol === 'https:';
      const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
      host = u.host + path;
    } catch {
      console.warn(`Ignoring malformed PUBLIC_URL: ${publicUrl}`);
    }
  }
  if (!host) {
    host = `localhost:${port}`;
    secure = false;
  }
  const params = new URLSearchParams({ t: token });
  if (!secure) params.set('s', '0');
  return `twsync://${host}/?${params.toString()}`;
}

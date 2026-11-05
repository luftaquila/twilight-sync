/**
 * Invite string — the one-paste form of a server connection.
 *
 *   twsync://<host>[:<port>][/<path>]/?t=<token>[&n=<device name>][&s=0]
 *
 * The scheme is a container, not a transport: wss:// is implied and `s=0`
 * marks a plaintext ws:// deployment (localhost / trusted LAN). A raw
 * ws(s):// URL with ?t= is accepted too. Shared by the popup, the background
 * page, and the server (which prints invites), so it must stay dependency-free.
 */

export const INVITE_SCHEME = 'twsync';

export function parseInvite(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (![INVITE_SCHEME, 'ws', 'wss'].includes(scheme)) return null;
  if (!url.host) return null;

  const params = url.searchParams;
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const token = (params.get('t') || params.get('token') || fragment || '').trim();
  if (!token) return null;

  let serverUrl;
  if (scheme === 'ws' || scheme === 'wss') {
    url.hash = '';
    for (const key of ['t', 'token', 'n', 's']) params.delete(key);
    serverUrl = url.toString().replace(/\?$/, '').replace(/\/$/, '');
  } else {
    const secure = params.get('s') !== '0';
    const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
    serverUrl = `${secure ? 'wss' : 'ws'}://${url.host}${path}`;
  }

  const deviceName = (params.get('n') || '').trim();
  return { serverUrl, token, deviceName: deviceName || null };
}

/** Rebuilds an invite from stored config, so device N+1 never needs server access. */
export function buildInvite({ serverUrl, token, deviceName = null }) {
  if (!serverUrl || !token) return null;
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
  const params = new URLSearchParams({ t: token });
  if (url.protocol === 'ws:') params.set('s', '0');
  if (deviceName) params.set('n', deviceName);
  return `${INVITE_SCHEME}://${url.host}${path}/?${params.toString()}`;
}

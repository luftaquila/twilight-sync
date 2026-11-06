/**
 * Popup — renders the background snapshot and forwards user choices.
 */

import { parseInvite } from '../common/invite.js';

const $ = id => document.getElementById(id);
const send = msg => browser.runtime.sendMessage(msg);

let last = null;

const STATUS = {
  starting: ['Starting…', ''],
  unconfigured: ['Not set up', ''],
  disabled: ['Off', ''],
  connecting: ['Connecting…', 'warn'],
  reconnecting: ['Reconnecting…', 'warn'],
  disconnected: ['Disconnected', 'warn'],
  syncing: ['Syncing', 'ok'],
  awaiting_initial: ['Choice needed', 'warn'],
  pushing: ['Uploading…', 'warn'],
  guard: ['Needs confirmation', 'bad'],
  incompatible: ['Unsupported Zen', 'bad'],
  spaces_conflict: ['Zen sync is on', 'bad'],
  auth_failed: ['Invalid token', 'bad'],
  protocol_mismatch: ['Version mismatch', 'bad'],
};

function show(id, visible) {
  $(id).hidden = !visible;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

/**
 * window.confirm() doesn't work in extension popups: destructive buttons
 * arm on the first click and act on the second (within 4 s).
 */
function armed(button, prompt) {
  const labelEl = button.querySelector('strong') || button;
  if (button.dataset.armed === '1') {
    button.dataset.armed = '';
    labelEl.textContent = button.dataset.label;
    return true;
  }
  button.dataset.armed = '1';
  button.dataset.label = labelEl.textContent;
  labelEl.textContent = prompt;
  setTimeout(() => {
    if (button.dataset.armed === '1') {
      button.dataset.armed = '';
      labelEl.textContent = button.dataset.label;
    }
  }, 4000);
  return false;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString();
}

function banner(text, { list = null, actions = [] } = {}) {
  $('banner-text').textContent = text;
  const ul = $('banner-list');
  ul.replaceChildren();
  if (list?.length) {
    for (const item of list) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.append(li);
    }
  }
  ul.hidden = !list?.length;
  const row = $('banner-actions');
  row.replaceChildren();
  for (const { label, onClick, cls } of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    row.append(b);
  }
  row.hidden = !actions.length;
  show('banner', true);
}

function render(st) {
  last = st;
  const [label, cls] = STATUS[st.status] || [st.status, ''];
  const pill = $('pill');
  pill.textContent = label;
  pill.className = `pill ${cls}`;
  $('version').textContent = `v${st.version}`;

  show('banner', false);
  if (st.status === 'incompatible') {
    const missing = st.env?.missing || [];
    banner(`This Zen build isn't supported, so sync is off.${missing.length ? ' Missing:' : ''}`, { list: missing });
  } else if (st.status === 'spaces_conflict') {
    banner("Zen's own Spaces sync (Firefox Sync) is on. Turn it off to use Twilight Sync.", {
      actions: [
        {
          label: 'Turn off Zen Spaces sync',
          cls: 'primary',
          onClick: async () => {
            await send({ type: 'disable_spaces_engine' });
            refresh();
          },
        },
      ],
    });
  } else if (st.status === 'auth_failed') {
    banner('The server rejected the token. Paste a fresh invite.');
  } else if (st.status === 'protocol_mismatch') {
    banner('The server uses a different protocol version. Update the server or the extension.');
  } else if (st.lastError && st.status !== 'syncing') {
    banner(st.lastError);
  }

  const configured = st.configured;
  show('setup', !configured || st.status === 'auth_failed');
  if (!$('setup-name').value) $('setup-name').value = st.deviceName || '';

  // Initial sync prompt
  const initial = st.status === 'awaiting_initial' && st.pendingInitial;
  show('initial', !!initial);
  if (initial) {
    const rows = [
      ['Spaces', 'spaces'],
      ['Essentials', 'essentials'],
      ['Pinned tabs', 'pinned'],
      ['Open tabs', 'normal'],
      ['Folders', 'folders'],
      ['Shortcuts', 'shortcuts'],
    ];
    const body = $('compare-body');
    body.replaceChildren();
    for (const [name, key] of rows) {
      const tr = document.createElement('tr');
      for (const text of [name, st.pendingInitial.server?.[key] ?? 0, st.pendingInitial.local?.[key] ?? 0]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      body.append(tr);
    }
  }

  // Guard
  show('guard', st.status === 'guard' && !!st.pendingGuard);
  if (st.pendingGuard) {
    const g = st.pendingGuard;
    $('guard-text').textContent = g.outgoing
      ? `This device is about to delete ${g.wouldDelete} of ${g.localCount} items on the server (and on every other device).`
      : `Another device's changes would delete ${g.wouldDelete} of the ${g.localCount} synced items in this browser.`;
  }

  const active = configured && !['incompatible'].includes(st.status);
  show('overview', active);
  show('options', configured);
  show('actions', configured);
  if (active) {
    if (document.activeElement !== $('device-name')) $('device-name').value = st.deviceName || '';
    $('server-host').textContent = st.serverHost || '—';
    $('last-sync').textContent = ago(st.lastSyncAt);
    $('zen-version').textContent = st.env ? `${st.env.zenVersion} (${st.env.platform})` : '—';
    const devices = $('devices');
    devices.replaceChildren();
    for (const d of st.devices || []) {
      const chip = document.createElement('span');
      chip.className = `device${d.deviceId === st.deviceId ? ' self' : ''}`;
      chip.textContent = d.deviceId === st.deviceId ? `${d.name} (this)` : d.name;
      chip.title = d.platform || '';
      devices.append(chip);
    }
    const counts = $('counts');
    counts.replaceChildren();
    const c = st.counts;
    if (c) {
      for (const [name, value] of [
        ['spaces', c.spaces],
        ['essentials', c.essentials],
        ['pinned', c.pinned],
        ['open', c.normal],
        ['folders', c.folders],
        ['splits', c.splits],
        ['containers', c.containers],
        ['shortcuts', c.shortcuts],
      ]) {
        const box = document.createElement('div');
        box.className = 'count';
        const b = document.createElement('b');
        b.textContent = value ?? 0;
        const sp = document.createElement('span');
        sp.textContent = name;
        box.append(b, sp);
        counts.append(box);
      }
    }
  }

  // Options
  const o = st.options || {};
  $('opt-normal').checked = o.normalTabs !== false;
  $('opt-keys').checked = o.shortcuts !== false;
  $('opt-keys').disabled = st.env && !st.env.shortcutsAvailable;
  $('opt-mapping').value = o.keyMapping === 'swap' ? 'swap' : 'physical';
  show('mapping-row', st.env?.platform === 'macosx' && o.shortcuts !== false);

  $('toggle').textContent = st.enabled ? 'Disconnect' : 'Connect';
}

async function refresh() {
  try {
    const st = await send({ type: 'get_status' });
    if (st) render(st);
  } catch (e) {
    $('pill').textContent = 'Starting…';
  }
}

/* Handlers */

$('connect').addEventListener('click', async () => {
  const err = $('setup-error');
  err.hidden = true;
  const invite = $('invite').value.trim();
  const msg = { type: 'connect', deviceName: $('setup-name').value.trim() };
  if (invite) {
    if (!parseInvite(invite)) {
      err.textContent = 'That does not look like a twsync:// invite.';
      err.hidden = false;
      return;
    }
    msg.invite = invite;
  } else {
    msg.serverUrl = $('setup-url').value.trim();
    msg.token = $('setup-token').value.trim();
  }
  const result = await send(msg);
  if (!result?.success) {
    err.textContent = result?.error || 'Could not connect.';
    err.hidden = false;
    return;
  }
  // Don't leave the secret on screen.
  $('invite').value = '';
  $('setup-token').value = '';
  refresh();
});

for (const button of document.querySelectorAll('[data-initial]')) {
  button.addEventListener('click', async () => {
    const mode = button.dataset.initial;
    if (mode === 'push' && !armed(button, 'Click again to overwrite every device')) return;
    for (const b of document.querySelectorAll('[data-initial]')) b.disabled = true;
    const result = await send({ type: 'initial_choice', mode });
    for (const b of document.querySelectorAll('[data-initial]')) b.disabled = false;
    if (!result?.success) toast(result?.error || 'Failed');
    refresh();
  });
}

$('guard-confirm').addEventListener('click', async () => {
  await send({ type: 'guard_choice', confirm: true });
  refresh();
});

$('guard-reject').addEventListener('click', async () => {
  await send({ type: 'guard_choice', confirm: false });
  refresh();
});

$('device-name').addEventListener('change', async () => {
  await send({ type: 'set_device_name', deviceName: $('device-name').value });
  toast('Device name saved');
});

const setOptions = options => send({ type: 'set_options', options }).then(refresh);
$('opt-normal').addEventListener('change', () => setOptions({ normalTabs: $('opt-normal').checked }));
$('opt-keys').addEventListener('change', () => setOptions({ shortcuts: $('opt-keys').checked }));
$('opt-mapping').addEventListener('change', () => setOptions({ keyMapping: $('opt-mapping').value }));

$('copy-invite').addEventListener('click', async () => {
  const { invite } = (await send({ type: 'get_invite' })) || {};
  if (!invite) return toast('Nothing to copy yet');
  await navigator.clipboard.writeText(invite);
  toast('Invite copied. It contains your token, so share it privately.');
});

$('toggle').addEventListener('click', async () => {
  await send({ type: last?.enabled ? 'disconnect' : 'reconnect' });
  refresh();
});

$('force-pull').addEventListener('click', async () => {
  const r = await send({ type: 'force_pull' });
  toast(r?.success ? 'Pulling from the server…' : r?.error || 'Failed');
});

$('force-push').addEventListener('click', async event => {
  if (!armed(event.currentTarget, 'Click again: every device will match this one')) return;
  const r = await send({ type: 'force_push' });
  toast(r?.success ? 'Pushing this device…' : r?.error || 'Failed');
});

$('admin-disable').addEventListener('click', async event => {
  if (!armed(event.currentTarget, 'Click again to disconnect every device')) return;
  const r = await send({ type: 'admin', action: 'disable_all' });
  toast(r?.success ? 'Sync turned off on every device' : r?.error || 'Failed');
});

$('admin-reset').addEventListener('click', async event => {
  if (!armed(event.currentTarget, 'Click again to wipe the server')) return;
  const r = await send({ type: 'admin', action: 'reset' });
  toast(r?.success ? 'Server reset' : r?.error || 'Failed');
});

const port = browser.runtime.connect({ name: 'popup' });
port.onMessage.addListener(msg => {
  if (msg?.type === 'status' && msg.status) {
    render({ ...msg.status, counts: last?.counts });
  }
});

refresh();
setInterval(() => {
  if (last) $('last-sync').textContent = ago(last.lastSyncAt);
}, 5000);

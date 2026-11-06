/**
 * Twilight Sync — background orchestrator.
 *
 * Policy layer between the chrome-side engine (browser.twilightSync: capture,
 * diff, apply) and the WebSocket transport. Owns the connection lifecycle,
 * the initial-sync choice, guard confirmations, options and popup messaging.
 * Server messages are processed strictly in arrival order.
 */

import Transport from './transport.js';
import { parseInvite, buildInvite } from '../common/invite.js';
import { PROTOCOL_VERSION } from '../common/protocol.js';

const engine = () => browser.twilightSync;
const DEFAULT_OPTIONS = { normalTabs: true, shortcuts: true, keyMapping: 'physical' };
const RETRY_BASE_MS = 10000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const s = {
  config: null, // { serverUrl, token, deviceName, deviceId, enabled, options }
  env: null,
  started: false,
  phase: 'idle', // idle | negotiating | syncing
  transportStatus: 'disconnected',
  transportDetail: null,
  blocked: null, // 'incompatible' | 'spaces_conflict' | null
  devices: [],
  serverVersion: 0,
  serverGeneration: null,
  lastSyncAt: null,
  lastError: null,
  pendingInitial: null, // { records, generation, version, info }
  pendingGuard: null, // { mode, records, deleted, guard }
  replace: null, // { reqId, records, purpose: 'initial' | 'force', retries }
  inflight: new Map(), // reqId → { records, deleted }
  rejected: new Map(), // id → serialized record the server refused
  retryTimer: null,
  retryDelay: RETRY_BASE_MS,
};

let transport = null;
let msgQueue = Promise.resolve();
let putSeq = 0;

/* Mark: config */

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadConfig() {
  const stored = await browser.storage.local.get(['serverUrl', 'token', 'deviceName', 'deviceId', 'enabled', 'options']);
  const config = {
    serverUrl: stored.serverUrl || '',
    token: stored.token || '',
    deviceName: stored.deviceName || '',
    deviceId: stored.deviceId || randomId(),
    enabled: !!stored.enabled,
    options: { ...DEFAULT_OPTIONS, ...(stored.options || {}) },
  };
  if (!stored.deviceId) {
    await browser.storage.local.set({ deviceId: config.deviceId });
  }
  return config;
}

async function saveConfig(patch) {
  Object.assign(s.config, patch);
  await browser.storage.local.set(patch);
}

function defaultDeviceName() {
  const names = { macosx: 'Mac', win: 'Windows', linux: 'Linux' };
  return s.env?.hostName || names[s.env?.platform] || 'Zen';
}

/* Mark: startup */

async function init() {
  browser.runtime.onMessage.addListener(handlePopupMessage);
  s.config = await loadConfig();
  transport = new Transport({
    onStatus: onTransportStatus,
    onMessage: msg => {
      msgQueue = msgQueue.then(() => handleServerMessage(msg)).catch(e => {
        console.error('[TwilightSync] message handling failed', e);
      });
    },
    onClosed: onTransportClosed,
    onError: message => {
      s.lastError = message;
      notifyPopup();
    },
  });

  // Resolves only after session restore + Zen spaces are ready (first-upload
  // gate): nothing captures or connects before that.
  s.env = await engine().start();
  s.started = true;
  engine().onLocalChanges.addListener(onLocalChanges);
  engine().onEnvironmentChanged.addListener(onEnvironmentChanged);
  await engine().setOptions(s.config.options);

  // Headless provisioning (about:config extensions.twilightSync.*): a profile
  // without stored config adopts it.
  const provision = s.env?.provision || {};
  if (!s.config.serverUrl && provision.invite) {
    const parsed = parseInvite(provision.invite);
    if (parsed) {
      await saveConfig({
        serverUrl: parsed.serverUrl,
        token: parsed.token,
        deviceName: provision.deviceName || parsed.deviceName || s.config.deviceName,
        enabled: !!provision.enabled,
      });
      console.log('[TwilightSync] adopted provisioning prefs');
    } else {
      console.warn('[TwilightSync] ignoring malformed extensions.twilightSync.invite');
    }
  }
  if (!s.config.deviceName) {
    await saveConfig({ deviceName: defaultDeviceName() });
  }
  if (s.config.enabled && s.config.serverUrl && s.config.token) {
    await connect();
  }
  notifyPopup();
  console.log(`[TwilightSync] ready — extension ${browser.runtime.getManifest().version}, protocol v${PROTOCOL_VERSION}, engine compatible=${s.env?.compatible}`);
}

/* Mark: connection */

function spacesConflict() {
  return !!(s.env?.spacesEngineEnabled && s.env?.fxaConfigured);
}

async function connect() {
  s.env = await engine().getEnvironment();
  s.blocked = null;
  if (!s.env?.compatible) {
    // Fail closed: a partially working engine must neither capture nor apply.
    s.blocked = 'incompatible';
    console.error('[TwilightSync] incompatible Zen build, missing:', s.env?.missing);
    notifyPopup();
    return;
  }
  if (spacesConflict()) {
    // Two syncers over the same data would feed back into each other.
    s.blocked = 'spaces_conflict';
    notifyPopup();
    return;
  }
  resetSession();
  transport.connect({
    serverUrl: s.config.serverUrl,
    token: s.config.token,
    deviceId: s.config.deviceId,
    deviceName: s.config.deviceName || defaultDeviceName(),
    platform: s.env?.platform || 'unknown',
    client: `twilight-sync/${browser.runtime.getManifest().version}`,
  });
}

function resetSession() {
  s.phase = 'idle';
  s.pendingInitial = null;
  s.pendingGuard = null;
  s.replace = null;
  s.inflight.clear();
  clearTimeout(s.retryTimer);
}

async function disconnect({ disable = true } = {}) {
  transport.disconnect();
  resetSession();
  s.blocked = null;
  if (disable) {
    await saveConfig({ enabled: false });
  }
  notifyPopup();
}

function onEnvironmentChanged(env) {
  s.env = env;
  if (spacesConflict() && transport.connected) {
    console.warn('[TwilightSync] Zen Spaces sync was re-enabled — pausing');
    transport.disconnect({ quiet: true });
    resetSession();
    s.blocked = 'spaces_conflict';
  }
  notifyPopup();
}

function onTransportStatus(status, detail) {
  s.transportStatus = status;
  s.transportDetail = detail;
  if (status !== 'connected') {
    // A reconnect re-runs the welcome reconciliation; nothing flows until then.
    s.phase = 'idle';
    s.inflight.clear();
    s.replace = null;
  }
  notifyPopup();
}

function onTransportClosed() {
  s.phase = 'idle';
  s.inflight.clear();
  s.replace = null;
}

/* Mark: outbound */

function recordKey(record) {
  return JSON.stringify(record);
}

function sendPut(records, deleted, { force = false } = {}) {
  if (!records.length && !deleted.length) return false;
  const reqId = `p${++putSeq}`;
  s.inflight.set(reqId, { records, deleted });
  if (!transport.send({ type: 'put', reqId, records, deleted, force })) {
    s.inflight.delete(reqId);
    return false;
  }
  return true;
}

function onLocalChanges({ changed, deleted, heldDeleted, guard }) {
  if (s.phase !== 'syncing' || !transport.connected) return;
  if (guard && heldDeleted?.length) {
    // The engine's outbound guard: ask before deleting nearly everything.
    const first = !s.pendingGuard;
    s.pendingGuard = {
      mode: 'outgoing',
      records: [],
      deleted: heldDeleted,
      guard: { wouldDelete: heldDeleted.length, localCount: guard.uploadedTabs, outgoing: true },
    };
    notifyPopup();
    if (first) browser.browserAction.openPopup().catch(() => {});
  } else if (s.pendingGuard?.mode === 'outgoing') {
    // The tabs came back (or the deletions shrank below the guard): no question left.
    s.pendingGuard = null;
    notifyPopup();
  }
  // Skip exactly what is already in flight (the baseline advances on ack),
  // and what the server already refused in this exact form.
  const inflightRecords = new Map();
  const inflightDeletes = new Set();
  for (const batch of s.inflight.values()) {
    for (const r of batch.records) inflightRecords.set(r.id, recordKey(r));
    for (const id of batch.deleted) inflightDeletes.add(id);
  }
  const records = changed.filter(r => {
    const key = recordKey(r);
    return inflightRecords.get(r.id) !== key && s.rejected.get(r.id) !== key;
  });
  const dels = deleted.filter(id => !inflightDeletes.has(id));
  sendPut(records, dels);
}

/* Mark: inbound */

async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      return onWelcome(msg);
    case 'put_ok':
      return onPutOk(msg);
    case 'put_rejected':
      return onPutRejected(msg);
    case 'changes':
      return onChanges(msg);
    case 'state':
      return onState(msg);
    case 'replace_ok':
      return onReplaceOk(msg);
    case 'replace_conflict':
      return onReplaceConflict(msg);
    case 'devices':
      s.devices = msg.devices || [];
      return notifyPopup();
    case 'admin_ok':
      return notifyPopup();
    case 'force_disable':
      return onForceDisable(msg);
    case 'error':
      s.lastError = msg.message || msg.code || 'Server error';
      console.warn('[TwilightSync] server error:', msg);
      return notifyPopup();
  }
}

function countRecords(records) {
  const c = { spaces: 0, folders: 0, essentials: 0, pinned: 0, normal: 0, shortcuts: 0 };
  for (const r of records || []) {
    if (r.kind === 'space') c.spaces++;
    else if (r.kind === 'folder') c.folders++;
    else if (r.kind === 'key') c.shortcuts++;
    else if (r.kind === 'tab') {
      if (r.data?.essential) c.essentials++;
      else if (r.data?.pinned) c.pinned++;
      else c.normal++;
    }
  }
  return c;
}

async function onWelcome({ generation, version, records, devices }) {
  s.serverVersion = version;
  s.serverGeneration = generation;
  s.devices = devices || [];
  s.lastError = null;

  const stored = await engine().getGeneration();
  if (stored && stored === generation) {
    // Known server: reconcile automatically, keeping offline work.
    s.phase = 'syncing';
    const result = await engine().reconnectMerge({ records });
    handleApplyResult(result, { mode: 'merge', records });
    engine().forceCapture();
    s.lastSyncAt = Date.now();
    notifyPopup();
    return;
  }
  await negotiate({ generation, version, records });
}

/** Unknown server generation: never touch either side silently. */
async function negotiate({ generation, version, records }) {
  s.phase = 'negotiating';
  const local = (await engine().getCounts()) || {};
  const localTabs = (local.pinned || 0) + (local.normal || 0) + (local.essentials || 0);
  const localEmpty = localTabs === 0 && !local.folders && (local.spaces || 0) <= 1 && !local.shortcuts;
  const info = {
    server: countRecords(records),
    local: { spaces: local.spaces || 0, folders: local.folders || 0, essentials: local.essentials || 0, pinned: local.pinned || 0, normal: local.normal || 0, shortcuts: local.shortcuts || 0 },
    serverEmpty: records.length === 0,
  };
  s.pendingInitial = { records, generation, version, info };

  if (records.length === 0) {
    // Nothing on the server to lose: this device seeds it.
    console.log('[TwilightSync] server is empty — pushing local state');
    await pushLocal('initial');
    return;
  }
  const auto = s.env?.provision?.autoInitial;
  if (auto === 'push' || auto === 'replace' || auto === 'merge') {
    console.log(`[TwilightSync] autoInitial=${auto}`);
    await initialChoice(auto);
    return;
  }
  if (localEmpty) {
    console.log('[TwilightSync] fresh profile — adopting server state');
    await initialChoice('replace');
    return;
  }
  notifyPopup();
  browser.browserAction.openPopup().catch(() => {});
}

async function initialChoice(mode) {
  if (!s.pendingInitial || !transport.connected) {
    return { success: false, error: 'No pending initial sync' };
  }
  if (mode === 'cancel') {
    await disconnect();
    return { success: true };
  }
  if (mode === 'push') {
    return pushLocal('initial');
  }
  const { records, generation } = s.pendingInitial;
  // The baseline is rebuilt from the applied records (noteApplied); the
  // generation is adopted only once the apply demonstrably ran — adopting it
  // after a wholesale failure would upload exactly the local state the user
  // chose to discard.
  await engine().resetBaseline();
  const result = await engine().applyRecords({ records, reconcile: mode === 'replace' });
  const wholesale = records.length > 0 && (result?.failed?.length || 0) >= records.length;
  if (result?.error || wholesale) {
    console.error('[TwilightSync] initial apply failed wholesale', result?.error);
    notifyPopup();
    return { success: false, error: result?.error || "Couldn't apply the server's data. Open a browser window and try again." };
  }
  await engine().setGeneration(generation);
  s.pendingInitial = null;
  s.phase = 'syncing';
  if (result?.failed?.length) {
    scheduleRetry();
  }
  // Local leftovers (merge) or self-heal divergence upload through the
  // capture; broadcasts dropped while the prompt was open are re-fetched.
  engine().forceCapture();
  transport.send({ type: 'fetch' });
  s.lastSyncAt = Date.now();
  notifyPopup();
  return { success: true };
}

async function pushLocal(purpose) {
  const records = await engine().getFullProjection();
  if (!records) return { success: false, error: "Couldn't read this browser's tabs." };
  const reqId = `r${++putSeq}`;
  const baseVersion = purpose === 'initial' ? s.pendingInitial?.version ?? s.serverVersion : s.serverVersion;
  s.replace = { reqId, records, purpose, retries: s.replace?.purpose === purpose ? s.replace.retries : 0 };
  if (!transport.send({ type: 'replace', reqId, records, baseVersion })) {
    s.replace = null;
    return { success: false, error: 'Not connected' };
  }
  return { success: true };
}

async function onReplaceOk({ reqId, accepted, generation, version }) {
  if (!s.replace || s.replace.reqId !== reqId) return;
  const sent = s.replace.records;
  s.replace = null;
  s.serverVersion = version;
  s.serverGeneration = generation;
  // Baseline = exactly what the server accepted (the sent payload).
  await engine().resetBaseline();
  await engine().setGeneration(generation);
  const ok = new Set(accepted || []);
  await engine().markUploaded({ records: sent.filter(r => ok.has(r.id)), deleted: [] });
  s.pendingInitial = null;
  s.phase = 'syncing';
  s.lastSyncAt = Date.now();
  engine().forceCapture();
  notifyPopup();
}

async function onReplaceConflict({ reqId, version }) {
  if (!s.replace || s.replace.reqId !== reqId) return;
  const { purpose, retries } = s.replace;
  s.serverVersion = version;
  if (purpose === 'force' && retries < 1) {
    // A concurrent write raced the force push: retry against the fresh
    // version (falling back to a pull would silently invert the user's push).
    s.replace.retries++;
    await pushLocal('force');
    return;
  }
  s.replace = null;
  if (purpose === 'initial' && s.pendingInitial) {
    // Another device seeded the server first: re-prompt with fresh numbers.
    transport.send({ type: 'fetch' });
  }
}

function onPutOk({ reqId, accepted, rejected, version }) {
  if (typeof version === 'number') s.serverVersion = version;
  const batch = s.inflight.get(reqId);
  if (!batch) return;
  s.inflight.delete(reqId);
  const refused = new Set((rejected || []).map(r => r.id));
  for (const r of batch.records) {
    if (refused.has(r.id)) s.rejected.set(r.id, recordKey(r));
    else s.rejected.delete(r.id);
  }
  if (refused.size) console.warn('[TwilightSync] server rejected records:', rejected);
  // The baseline advances from the SENT payload, never the ack-time state:
  // a tab closed or navigated mid-flight keeps its baseline entry, so its
  // tombstone or update can still be emitted.
  engine()
    .markUploaded({
      records: batch.records.filter(r => !refused.has(r.id)),
      deleted: batch.deleted.filter(id => !refused.has(id)),
    })
    .catch(() => {});
  s.lastSyncAt = Date.now();
  notifyPopup();
}

function onPutRejected({ reqId, reason, wouldDelete, current }) {
  const batch = s.inflight.get(reqId);
  s.inflight.delete(reqId);
  if (!batch || reason !== 'mass_delete') return;
  s.pendingGuard = {
    mode: 'server',
    records: batch.records,
    deleted: batch.deleted,
    guard: { wouldDelete, localCount: current, outgoing: true },
  };
  notifyPopup();
  browser.browserAction.openPopup().catch(() => {});
}

async function onChanges({ records, deleted, version }) {
  if (s.phase !== 'syncing') return;
  s.serverVersion = version;
  const result = await engine().applyRecords({ records, deleted });
  handleApplyResult(result, { mode: 'apply', records, deleted });
  s.lastSyncAt = Date.now();
  notifyPopup();
}

async function onState({ generation, version, records }) {
  s.serverVersion = version;
  s.serverGeneration = generation;
  if (s.pendingInitial && !s.replace) {
    await negotiate({ generation, version, records });
    return;
  }
  if (s.phase !== 'syncing') return;
  const stored = await engine().getGeneration();
  if (stored && generation !== stored) {
    // The server was reset or replaced under a new generation: auto-merging
    // would mass-delete. Back to the initial choice.
    console.warn('[TwilightSync] server generation changed — re-negotiating');
    await negotiate({ generation, version, records });
    return;
  }
  const result = await engine().reconnectMerge({ records });
  handleApplyResult(result, { mode: 'merge', records });
  s.lastSyncAt = Date.now();
  notifyPopup();
}

function handleApplyResult(result, context) {
  if (result?.guard) {
    // Deletions withheld: the batch would remove most local synced items.
    s.pendingGuard = { ...context, guard: result.guard };
    notifyPopup();
    browser.browserAction.openPopup().catch(() => {});
    return;
  }
  if (result?.failed?.length || result?.error) {
    console.warn(`[TwilightSync] ${result.failed?.length || 0} records failed to apply${result.error ? ` (${result.error})` : ''}`);
    scheduleRetry();
  } else {
    s.retryDelay = RETRY_BASE_MS;
  }
}

/** Failed records are retried through a full-state refresh, with backoff. */
function scheduleRetry() {
  clearTimeout(s.retryTimer);
  const delay = s.retryDelay;
  s.retryDelay = Math.min(RETRY_MAX_MS, s.retryDelay * 2);
  s.retryTimer = setTimeout(() => {
    if (transport.connected && s.phase === 'syncing') transport.send({ type: 'fetch' });
  }, delay);
}

async function onForceDisable({ reason }) {
  console.log('[TwilightSync] force-disabled by server:', reason);
  await disconnect();
  s.lastError = reason === 'admin_reset' ? 'Server state was reset by an admin' : 'Sync was disabled by an admin';
  notifyPopup();
}

/* Mark: popup */

function computeStatus() {
  if (!s.started) return 'starting';
  if (!s.config?.serverUrl || !s.config?.token) return 'unconfigured';
  if (s.blocked) return s.blocked;
  if (!s.config.enabled) return 'disabled';
  if (s.transportStatus === 'auth_failed') return 'auth_failed';
  if (s.transportStatus === 'protocol_mismatch') return 'protocol_mismatch';
  if (s.transportStatus !== 'connected') return s.transportStatus;
  if (s.pendingGuard) return 'guard';
  if (s.pendingInitial) return s.replace ? 'pushing' : 'awaiting_initial';
  if (s.phase === 'syncing') return 'syncing';
  return 'connecting';
}

function snapshot() {
  let host = '';
  try {
    host = s.config?.serverUrl ? new URL(s.config.serverUrl).host : '';
  } catch {}
  return {
    status: computeStatus(),
    transportDetail: s.transportDetail,
    configured: !!(s.config?.serverUrl && s.config?.token),
    enabled: !!s.config?.enabled,
    serverHost: host,
    deviceName: s.config?.deviceName || '',
    deviceId: s.config?.deviceId || '',
    devices: s.devices,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    options: s.config?.options || DEFAULT_OPTIONS,
    env: s.env
      ? {
          compatible: s.env.compatible,
          missing: s.env.missing,
          zenVersion: s.env.zenVersion,
          platform: s.env.platform,
          spacesEngineEnabled: s.env.spacesEngineEnabled,
          fxaConfigured: s.env.fxaConfigured,
          syncOnlyPinnedWindows: s.env.syncOnlyPinnedWindows,
          shortcutsAvailable: s.env.shortcutsAvailable,
          captureGuard: s.env.captureGuard,
        }
      : null,
    pendingInitial: s.pendingInitial?.info || null,
    pendingGuard: s.pendingGuard?.guard || null,
    version: browser.runtime.getManifest().version,
  };
}

// The popup connects a port while it is open; status pushes go only there
// (a blind runtime.sendMessage would fail and log on every ack).
const popupPorts = new Set();
browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
});

function notifyPopup() {
  if (!popupPorts.size) return;
  const status = snapshot();
  for (const port of popupPorts) {
    try {
      port.postMessage({ type: 'status', status });
    } catch {
      popupPorts.delete(port);
    }
  }
}

async function handlePopupMessage(msg) {
  switch (msg?.type) {
    case 'get_status': {
      const status = snapshot();
      status.counts = s.started ? await engine().getCounts().catch(() => null) : null;
      return status;
    }

    case 'connect': {
      let { serverUrl, token, deviceName } = msg;
      if (msg.invite) {
        const parsed = parseInvite(msg.invite);
        if (!parsed) return { success: false, error: 'That does not look like a twsync:// invite.' };
        ({ serverUrl, token } = parsed);
        deviceName = deviceName || parsed.deviceName;
      }
      if (!serverUrl || !token) return { success: false, error: 'Server URL and token are required.' };
      try {
        const u = new URL(serverUrl);
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error();
      } catch {
        return { success: false, error: 'Server URL must start with ws:// or wss://' };
      }
      const changedServer = serverUrl !== s.config.serverUrl;
      await saveConfig({ serverUrl, token, deviceName: deviceName || s.config.deviceName || defaultDeviceName(), enabled: true });
      if (changedServer) {
        // A different server: the baseline describes the old one.
        await engine().resetBaseline();
      }
      await connect();
      return { success: true };
    }

    case 'disconnect':
      await disconnect();
      return { success: true };

    case 'reconnect':
      if (!s.config.serverUrl) return { success: false, error: 'Not configured' };
      await saveConfig({ enabled: true });
      await connect();
      return { success: true };

    case 'set_device_name':
      await saveConfig({ deviceName: String(msg.deviceName || '').trim() || defaultDeviceName() });
      if (transport.connected) await connect();
      return { success: true };

    case 'set_options': {
      const options = { ...s.config.options, ...(msg.options || {}) };
      const before = s.config.options;
      await saveConfig({ options });
      const result = await engine().setOptions(options);
      const enabledMore =
        (options.normalTabs && !before.normalTabs) || (options.shortcuts && !before.shortcuts);
      if ((result?.keyMappingChanged || enabledMore) && transport.connected && s.phase === 'syncing') {
        // Pull what this device skipped (or must re-derive) from the server.
        transport.send({ type: 'fetch' });
      }
      notifyPopup();
      return { success: true };
    }

    case 'initial_choice':
      return initialChoice(msg.mode);

    case 'guard_choice': {
      const held = s.pendingGuard;
      if (!held) return { success: false, error: 'Nothing pending' };
      s.pendingGuard = null;
      if (!msg.confirm) {
        // Protective stop: the user says this mass deletion is wrong.
        await disconnect();
        return { success: true };
      }
      if (held.mode === 'server' || held.mode === 'outgoing') {
        if (!transport.connected) return { success: false, error: 'Not connected' };
        sendPut(held.records, held.deleted, { force: true });
      } else if (held.mode === 'merge') {
        handleApplyResult(await engine().reconnectMerge({ records: held.records, overrideGuard: true }), held);
      } else {
        handleApplyResult(
          await engine().applyRecords({ records: held.records, deleted: held.deleted, overrideGuard: true }),
          held
        );
      }
      notifyPopup();
      return { success: true };
    }

    case 'disable_spaces_engine': {
      const result = await engine().setSpacesEnginePref(false);
      s.env = await engine().getEnvironment();
      if (s.blocked === 'spaces_conflict' && s.config.enabled) await connect();
      notifyPopup();
      return result;
    }

    case 'force_push':
      if (!transport.connected || s.phase !== 'syncing') return { success: false, error: 'Not syncing' };
      return pushLocal('force');

    case 'force_pull':
      if (!transport.connected || s.phase !== 'syncing') return { success: false, error: 'Not syncing' };
      transport.send({ type: 'fetch' });
      return { success: true };

    case 'admin':
      if (!transport.connected) return { success: false, error: 'Not connected' };
      if (msg.action !== 'reset' && msg.action !== 'disable_all') return { success: false, error: 'Unknown action' };
      transport.send({ type: 'admin', action: msg.action });
      return { success: true };

    case 'get_invite':
      return { invite: buildInvite({ serverUrl: s.config.serverUrl, token: s.config.token }) };
  }
  return undefined;
}

globalThis.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  console.error('[TwilightSync] unhandled rejection:', reason?.message || reason, reason?.stack || '');
  engine()
    ?.log?.(`unhandled rejection in background: ${reason?.message || reason}`)
    .catch(() => {});
});

init().catch(e => {
  console.error('[TwilightSync] init failed', e);
  s.lastError = `Twilight Sync failed to start: ${e?.message || e}`;
});

/**
 * Wire protocol constants shared by the extension and the server.
 *
 * Protocol v1 (JSON over WebSocket):
 *   client → server
 *     hello   { protocol, token, deviceId, deviceName, platform, client }
 *     put     { reqId, records: [{id, kind, data}], deleted: [id], force? }
 *     fetch   {}                                 → state
 *     replace { reqId, records, baseVersion }    (compare-and-swap)
 *     admin   { action: "reset" | "disable_all" }
 *     ping    { t }
 *   server → client
 *     welcome          { protocol, deviceId, generation, version, records, devices }
 *     put_ok           { reqId, accepted: [id], rejected: [{id, reason}], version }
 *     put_rejected     { reqId, reason: "mass_delete", wouldDelete, current }
 *     changes          { records, deleted, version, source }   (broadcast)
 *     state            { generation, version, records, source? }
 *     replace_ok       { reqId, accepted: [id], generation, version }
 *     replace_conflict { reqId, version, counts }
 *     devices          { devices: [{deviceId, name, platform, since}] }
 *     admin_ok         { action }
 *     force_disable    { reason }
 *     pong             { t }
 *     error            { code, message, protocol? }
 */

export const PROTOCOL_VERSION = 1;

export const RECORD_KINDS = Object.freeze(['container', 'space', 'tab', 'folder', 'split', 'layout', 'key']);

export const LAYOUT_RECORD_ID = 'layout';
export const KEY_ID_PREFIX = 'key:';

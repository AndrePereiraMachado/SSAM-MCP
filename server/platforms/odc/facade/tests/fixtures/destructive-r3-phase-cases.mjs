// CX15 r3 (F7, M6 of review cx15-2): the CONTRACT of destructivePhase(tool, args, {destructive}) as a table, for the join
// with the CX12 (classifyTool, STUDIO_WRITE_TOOLS, the cancellation after the 25 s detach). Pure data: importing this file
// runs nothing. Every case is {tool, args, phase, form, destructive?, r3?}:
// - phase: 'preview' (no confirmationToken: a read; nothing is sent), 'execute' (with it: a write), 'refuse' (a
//   passthrough line the guard stops: nothing reaches the bridge; a read), null (not a destructive call: the CX12
//   classification of the tool decides);
// - destructive: for odc_write / odc_portal_write, what the caller's predicate answers for these args (the effect only the
//   catalog knows: effectOf(catalog.get(operationId).operation, body) === 'destructive' for odc_write, effects.mjs; and
//   PORTAL_WRITES[operationId].effect === 'destructive' for odc_portal_write, portal-routes.mjs); absent: no predicate given;
// - r3: true for the studio_command forms the r3 changed (BYPASS-1, CT-12: the line read as the bridge reads it,
//   bridgeCommandOf/bridgeLineUnsafeStart); ab1376b1 answered null for them.
// The join reuses it as: for (const c of PHASE_CASES) classifyTool(c.tool, c.args) is a read for preview/refuse, a write
// for execute, and the CX12 table's own answer for null (CLASS_OF_PHASE).
export const CLASS_OF_PHASE = Object.freeze({ preview: 'read', execute: 'write', refuse: 'read' });

// Every character .NET char.IsWhiteSpace accepts (String.Trim() removes them from the ends of the bridge line).
export const NET_WHITESPACE = Object.freeze([
  ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680],
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
].map(c => String.fromCodePoint(c)));
const hex = c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

const TOKEN = '00000000-0000-4000-8000-000000000001.synthetic';
const cases = [];
const add = (tool, args, phase, form, extra = {}) => cases.push({ tool, args, phase, form, ...extra });
// A destructive verb: every form of a preview (no token, empty token, blank token) and the execution.
function verb(tool, base, form) {
  add(tool, base, 'preview', `${form}, no confirmationToken`);
  add(tool, { ...base, confirmationToken: '' }, 'preview', `${form}, empty confirmationToken`);
  add(tool, { ...base, confirmationToken: '   ' }, 'preview', `${form}, blank confirmationToken`);
  add(tool, { ...base, confirmationToken: TOKEN }, 'execute', `${form}, with confirmationToken`);
}
// Not destructive, with or without a token.
function none(tool, base, form) {
  add(tool, base, null, form);
  add(tool, { ...base, confirmationToken: TOKEN }, null, `${form}, a confirmationToken changes nothing`);
}

const HOST = 'personal-0000test.outsystemscloud.com';
// ---- O11
for (const action of ['delete', 'module-delete', 'extension-delete', 'application-delete', 'solution-delete', 'db-connection-delete'])
  verb('o11_service_center_write', { action, host: HOST, applications: ['ZZSynthApp'] }, `action ${action}`);
verb('o11_service_center_write', { action: 'delete', host: HOST, prefix: 'ZZSynth' }, 'action delete by prefix');
for (const action of ['timer-run', 'apply-settings', 'verify', 'solution-remove-component']) none('o11_service_center_write', { action, host: HOST }, `action ${action}`);
verb('o11_environment', { action: 'delete-app', app: 'ZZSynthApp' }, 'action delete-app');
none('o11_environment', { action: 'users' }, 'action users');
verb('o11_extension', { action: 'delete', extension: 'ZZSynthExt' }, 'action delete');
none('o11_extension', { action: 'publish', extension: 'ZZSynthExt' }, 'action publish');
// o11_data: the token rides on each delete op of the request (request.confirmationToken), never on the call.
const del = (extra = {}) => ({ operation: 'delete', entity: 'ZZSynthEnt', ids: ['1', '2'], ...extra });
add('o11_data', { request: del() }, 'preview', 'request delete, no confirmationToken');
add('o11_data', { request: del({ confirmationToken: '  ' }) }, 'preview', 'request delete, blank confirmationToken');
add('o11_data', { request: del({ confirmationToken: TOKEN }) }, 'execute', 'request delete, with request.confirmationToken');
add('o11_data', { confirmationToken: TOKEN, request: del() }, 'preview', 'a token on the call, none on the delete op: still the preview');
add('o11_data', { request: { batch: [{ operation: 'insert', entity: 'ZZSynthEnt' }, del()] } }, 'preview', 'batch insert + delete, no token');
add('o11_data', { request: { batch: [del({ confirmationToken: TOKEN }), del({ ids: ['3'] })] } }, 'preview', 'batch of two deletes, one without its token');
add('o11_data', { request: { batch: [del({ confirmationToken: TOKEN }), { operation: 'read', entity: 'ZZSynthEnt' }, del({ ids: ['3'], confirmationToken: TOKEN })] } }, 'execute', 'batch of deletes, every one with its token (and a read)');
add('o11_data', { request: { operation: 'read', entity: 'ZZSynthEnt' } }, null, 'request read');
add('o11_data', { request: { batch: [{ operation: 'insert' }, { operation: 'update', confirmationToken: TOKEN }] } }, null, 'batch without a delete');
add('o11_data', {}, null, 'no request');
// ---- ODC
verb('studio_data_delete', { module: 'ZZSynthMod', entity: 'ZZSynthEnt', ids: ['1'] }, 'records by id');
verb('odc_asset_delete', { tenant: HOST, assetKey: 'zzsynth-key' }, 'asset');
verb('odc_a2a_connection_delete', { tenant: HOST, connectionKey: 'zzsynth-conn' }, 'A2A connection');
verb('odc_deploy', { tenant: HOST, operation: 'Undeploy', assetKey: 'zzsynth-key', stage: 'Development' }, 'operation Undeploy');
for (const operation of ['Deploy', 'ApplyConfigs']) none('odc_deploy', { tenant: HOST, operation, assetKey: 'zzsynth-key' }, `operation ${operation}`);
for (const action of ['delete', 'remove-entities']) verb('odc_external_db_connection', { tenant: HOST, action, connection: 'ZZSynthDb' }, `action ${action}`);
for (const action of ['create', 'list', 'test', 'import-entities']) none('odc_external_db_connection', { tenant: HOST, action }, `action ${action}`);
verb('odc_external_library', { tenant: HOST, action: 'discard', library: 'ZZSynthLib' }, 'action discard');
for (const action of ['deploy', 'build', 'status']) none('odc_external_library', { tenant: HOST, action, library: 'ZZSynthLib' }, `action ${action}`);
// odc_write / odc_portal_write: the effect is the catalog's; the caller passes its predicate.
const withPredicate = (tool, base, form) => {
  for (const c of [['preview', base], ['preview', { ...base, confirmationToken: '' }], ['execute', { ...base, confirmationToken: TOKEN }]])
    add(tool, c[1], c[0], `${form}, destructive per the catalog${c[1].confirmationToken === TOKEN ? ', with confirmationToken' : ', no confirmationToken'}`, { destructive: true });
  add(tool, { ...base, confirmationToken: TOKEN }, null, `${form}, NOT destructive per the catalog`, { destructive: false });
  add(tool, { ...base, confirmationToken: TOKEN }, null, `${form}, no predicate given: never guessed`);
};
withPredicate('odc_write', { tenant: HOST, operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: 'zzsynth-key' } }, 'a DELETE');
withPredicate('odc_write', { tenant: HOST, operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', path: { key: 'zzsynth-group' }, body: { userKeysToRemove: ['zzsynth-user'] } }, 'a PATCH with userKeysToRemove (BYPASS-2)');
withPredicate('odc_portal_write', { tenant: HOST, operationId: 'connections.delete', input: { key: 'zzsynth-conn' } }, 'a destructive Portal route');
// ---- tools outside the inventory: never a phase, whatever they carry.
for (const tool of ['odc_read', 'odc_receipt', 'ssam_task', 'studio_publish', 'studio_deliver', 'o11_job', 'o11_publish', 'ssam_job'])
  add(tool, { confirmationToken: TOKEN, command: 'data-delete', action: 'delete' }, null, 'not in the inventory');

// ---- studio_command: the passthrough line, as the bridge reads it ([command, ...args].join(' '), String.Trim(), the
// text up to the first space). Destructive commands are refused in every form; an invisible start is refused whatever
// follows; anything else is not destructive (null).
const BRIDGE = ['data-delete', 'portal-call', 'portal-private-call', 'portal-api-client-fixture-cleanup'];
const ARGS = ['ZZSynthMod', 'ZZSynthEnt', '1'];
for (const cmd of BRIDGE) {
  add('studio_command', { command: cmd }, 'refuse', `${cmd} alone`);
  add('studio_command', { command: cmd, args: ARGS }, 'refuse', `${cmd} with separate arguments`);
  add('studio_command', { command: cmd.toUpperCase(), args: ARGS }, 'refuse', `${cmd} in another case`, { r3: true });
  add('studio_command', { command: `${cmd} ${ARGS.join(' ')}` }, 'refuse', `${cmd} and its arguments in the first argument`, { r3: true });
  add('studio_command', { command: ' ', args: [cmd, ...ARGS] }, 'refuse', `command " " and ${cmd} in the arguments`, { r3: true });
  add('studio_command', { command: '', args: [cmd, ...ARGS] }, 'refuse', `empty command and ${cmd} in the arguments`, { r3: true });
  for (const ws of NET_WHITESPACE) {
    add('studio_command', { command: ws + cmd, args: ARGS }, 'refuse', `${hex(ws)} before ${cmd}`, { r3: true });
    add('studio_command', { command: cmd + ws, args: ARGS }, 'refuse', `${hex(ws)} after ${cmd}`, { r3: true });
    add('studio_command', { command: ws, args: [cmd, ...ARGS] }, 'refuse', `command "${hex(ws)}" and ${cmd} in the arguments`, { r3: true });
    if (ws !== ' ') add('studio_command', { command: `${cmd}${ws}${ARGS.join(' ')}` }, 'refuse', `${cmd}${hex(ws)}<arguments> in the first argument`, { r3: true });
  }
}
for (const cmd of ['module-info', 'publish-status', 'publish-log', 'stop']) {
  add('studio_command', { command: cmd }, null, `${cmd}: not destructive`);
  add('studio_command', { command: cmd, args: ['data-delete'] }, null, `${cmd} with "data-delete" as an argument: the bridge runs ${cmd}`);
  add('studio_command', { command: ` ${cmd}` }, null, `an ASCII space before ${cmd}: trimmed, not destructive`);
}
// An invisible start is never sent, whatever the command (the bridge's Trim would remove part of it and run what follows).
for (const lead of ['\u0085', ' ', '\t', '​', '﻿', '\u0000']) add('studio_command', { command: lead + 'module-info' }, 'refuse', `${hex(lead)} before module-info`, { r3: true });

export const PHASE_CASES = Object.freeze(cases.map(c => Object.freeze(c)));
// The options destructivePhase takes for a case (the predicate only when the case states one).
export const phaseOptions = c => (c.destructive === undefined ? {} : { destructive: () => c.destructive });
export const caseName = c => `${c.tool} ${c.form} -> ${c.phase}`;

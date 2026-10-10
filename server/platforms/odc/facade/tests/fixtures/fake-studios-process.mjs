// The Studios of one simulated customer machine, in their own process, for the process end to end of phase 2
// (hosted-e2e-processes.mjs). Never a real Studio: a fake ODC bridge on \\.\pipe\ODC3-Bridge-<ODC_BRIDGE>-<unlikely pid> and a
// fake O11 bridge (the thin Anvil bridge, flavor "thin", that already serves the fake Service Studio) on a loopback port
// in 7400-7499.
//   node fake-studios-process.mjs <agentRoot> <studiosFile> <o11Port> [snapshotBytes] [o11Module.json]
// Writes {odcPid, o11Pid, o11Port, odcVersion, o11Version} to <studiosFile> once both listen, and one JSON line per
// request to <studiosFile>.log. Like the real bridges it reads and writes files only under the agent root it was given
// (the open O11 module's bytes come from the OML named in o11Module.json, the module the fake Service Studio has open).
//
// The fake O11 bridge keeps the wire contract of the thin bridge (docs/O11-BRIDGE-FINA.md 3, 14): the 21 verbs, the removed
// ones answer {success:false, executed:false, "Unknown method: <m>"}; merge_from_oml with base_path needs the
// reference_plan the server computes, read as strictly as ReferencePlan.Parse, a base registered by its own
// snapshot_module and the sha256 the delivery froze; a merge replaces the open module's bytes with the candidate's
// (with the merge order's first_pass_path, checked like the thin bridge, in one receipt of two merges).
// environment_session answers the primitives one call each (connect, modules, referenceable, download, signature,
// close). It never computes a plan or a find: those are the server's. refresh_references (the Studio's own Refresh
// References, ninth release) answers the module up to date; get_errors with settle answers settled and a generation.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ODC_BRIDGE } from './odc-bridge-version.mjs';

const [agentRoot, studiosFile, portText, bytesText, moduleFile] = process.argv.slice(2);
const o11Port = Number(portText);
const snapshotBytes = Number(bytesText) || 6 * 1024 * 1024 + 4321;
const odcPid = 900000 + Math.floor(Math.random() * 90000), o11Pid = odcPid + 1;
const odcVersion = '1.7.27.4021', o11Version = '11.55.91.65012';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = entry => fs.appendFileSync(studiosFile + '.log', JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const inside = file => { const rel = path.relative(agentRoot, path.resolve(file)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// The bridge key the O11 bridge created when it started (BridgeAccess.Initialize) in the agent's authority folder.
const keyFile = path.join(agentRoot, 'private', 'authority', 'bridge.key');
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString('base64url'));
const bridgeKey = fs.readFileSync(keyFile, 'utf8').trim();

function odcReply(line) {
  const [command, ...args] = line.split(' ');
  if (command === 'status') return { ok: true, bridge: ODC_BRIDGE, busy: null, modules: [] };
  // A compromised bridge (or agent) naming a file outside the customer's workspace.
  if (command === 'snapshot' && args[0] === 'Evil') return { ok: true, module: 'Evil', path: 'agent:..\\..\\..\\.local\\server\\tokens.json' };
  if (command === 'snapshot') {
    const bytes = randomBytes(snapshotBytes);
    const hash = sha(bytes).toUpperCase();
    const file = path.join(agentRoot, 'odc', 'snapshots', args[0] + '-' + hash + '.oml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(file + '.json', JSON.stringify({ ok: true, module: args[0], sha256: hash, path: file }));
    return { ok: true, module: args[0], sha256: hash, size: bytes.length, path: file };
  }
  if (command === 'open') {
    if (!args[1]) return { ok: true, module: args[0], opened: true };
    if (!inside(args[1]) || !fs.existsSync(args[1])) return { ok: false, error: 'fake bridge: no local OML under the agent root' };
    const bytes = fs.readFileSync(args[1]);
    return { ok: true, module: args[0], opened: true, path: args[1], sha256: sha(bytes), size: bytes.length };
  }
  return { ok: false, error: 'fake bridge: ' + command };
}

const odc = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const i = buffer.indexOf('\n'); if (i < 0) return;
    const line = buffer.slice(0, i).replace(/\r$/, '');
    let reply;
    try { reply = odcReply(line); } catch (error) { reply = { ok: false, error: error.message }; }
    record({ studio: 'odc', line, ok: reply.ok });
    socket.write(JSON.stringify(reply) + '\r\n');
  });
  socket.on('error', () => {});
});

// ---------------------------------------------------------------- the fake thin O11 bridge
const VERBS = ['ping', 'bridge_manifest', 'get_active_module', 'list_open_modules', 'get_errors', 'open_module', 'close_module', 'publish',
  'windows', 'ui_alive', 'close_dialog', 'snapshot_module', 'merge_from_oml', 'merge_status', 'environment_session', 'sc_api', 'sc_web',
  'studio_login', 'sc_session', 'publish_log', 'refresh_references'];
// The thin bridge's Dispatch.Capabilities (merge_from_oml:first_pass: the merge order runs in one call; the ninth release's
// rollback proof, module_key, validation generation, publish wait and dialogs, server operation and refresh_references).
const CAPABILITIES = ['environment_session', 'sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', 'sc_web', 'sc_web:secretRefs', 'sc_web:hidden',
  'sc_web:login', 'studio_login', 'sc_session', 'publish_log', 'merge_from_oml:first_pass', 'merge_from_oml:rollback_proof', 'merge_from_oml:module_key',
  'get_errors:generation', 'publish:wait_running', 'publish:dialogs_seen', 'list_open_modules:server_operation', 'refresh_references', 'thin', 'merge:reference-plan'];
let generation = 0;
const OPERATIONS = ['applications', 'modules', 'application-icon', 'catalogs', 'referenceable', 'extensions', 'extension-download', 'versions',
  'templates', 'template-module', 'template-download', 'signature', 'template-user-provider', 'download', 'application-save', 'module-associate',
  'application-delete', 'module-delete', 'publish-start', 'publish-check', 'data-read', 'data-write'];
// {oml, name, key, environment, systemKey}: the module the fake Service Studio has open (optional).
const spec = moduleFile ? JSON.parse(fs.readFileSync(moduleFile, 'utf8')) : null;
let current = spec ? fs.readFileSync(spec.oml) : null;
const snapshots = new Map(); // snapshot_id -> sha256 (upper hex) of the bytes it captured
const journal = new Map();   // operation_id -> receipt
const leases = new Map();    // lease -> {readOnly}
const upper = bytes => sha(bytes).toUpperCase();

class NotExecuted extends Error {}
const refuse = message => { throw new NotExecuted(message); };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE = ['ProducerKey', 'LocalReferenceKey', 'BaseReferenceKey', 'ForeignReferenceKey', 'Kind', 'BaseHash', 'LocalHash', 'ForeignHash'];
const CONFLICT = ['ProducerKey', 'Code', 'Message'];
const exactly = (value, names, what) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(what + ' is not an object');
  const keys = Object.keys(value);
  if (keys.length !== names.length || names.some(n => !keys.includes(n))) throw new Error(what + ' has the fields ' + keys.join(',') + ', not ' + names.join(','));
};
// The JSON of ReferenceSignatureMergePlan with the default serializer options, as strictly as the thin ReferencePlan.Parse.
function readPlan(plan) {
  exactly(plan, ['Changes', 'Conflicts', 'HasChanges', 'HasConflicts'], 'reference_plan');
  if (!Array.isArray(plan.Changes) || !Array.isArray(plan.Conflicts)) throw new Error('Changes and Conflicts must be lists');
  for (const change of plan.Changes) {
    exactly(change, CHANGE, 'a change');
    if (CHANGE.some(n => typeof change[n] !== 'string')) throw new Error('a change field is not text');
    if (!['BaseHash', 'LocalHash', 'ForeignHash'].every(n => GUID.test(change[n]))) throw new Error('a change hash is not a GUID');
  }
  for (const conflict of plan.Conflicts) {
    exactly(conflict, CONFLICT, 'a conflict');
    if (CONFLICT.some(n => typeof conflict[n] !== 'string')) throw new Error('a conflict field is not text');
  }
  if (plan.HasChanges !== (plan.Changes.length > 0) || plan.HasConflicts !== (plan.Conflicts.length > 0)) throw new Error('HasChanges/HasConflicts contradict the lists');
  return plan;
}

function target(params) {
  if (!spec) refuse('No module is open in the Studio');
  if (params.module_key != null && params.module_key !== spec.key) refuse(`module_key '${params.module_key}' is not the active module`);
  if (params.environment != null && params.environment !== spec.environment) refuse(`environment '${params.environment}' is not the active module's`);
}
const absolute = (verb, name, value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${verb}: '${name}' must be an absolute path`);
  if (!inside(value)) refuse(`${verb}: '${name}' is outside the agent root`);
  return value;
};
const moduleSummary = () => ({ Name: spec.name, Key: spec.key, Kind: 'eSpace', ESpaceKind: 'Service', VersionId: 7, Version: 3, ApplicationName: 'ThinE2E',
  ApplicationKey: 'thin-e2e-app', UploadDate: '2026-10-01T12:00:00Z', UploaderUsername: 'e2e.user', IsActive: true, CanDownloadFlag: true, Description: null });

function snapshot(params, extra) {
  target(params);
  const file = absolute('snapshot_module', 'path', params.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, current);
  const id = randomUUID().replace(/-/g, '');
  const hash = upper(current);
  snapshots.set(id, hash);
  extra.snapshotSha256 = hash;
  return { baseline: [], environment: spec.environment, bridgeSessionId: 'fake-thin', snapshot_id: id, sha256: hash, path: file, bytes: current.length,
    name: spec.name, key: spec.key, elapsedMs: 1 };
}

function merge(params, extra) {
  const foreignPath = absolute('merge_from_oml', 'foreign_path', params.foreign_path);
  const basePath = params.base_path == null ? null : absolute('merge_from_oml', 'base_path', params.base_path);
  // The merge order (Delivery): a first-pass copy merged first, then the candidate over it, in the same call.
  const firstPassPath = params.first_pass_path == null ? null : absolute('merge_from_oml', 'first_pass_path', params.first_pass_path);
  if (!fs.existsSync(foreignPath)) refuse("merge_from_oml: 'foreign_path' must exist");
  if (basePath && !fs.existsSync(basePath)) refuse("merge_from_oml: 'base_path' does not exist");
  if (firstPassPath && !fs.existsSync(firstPassPath)) refuse("merge_from_oml: 'first_pass_path' does not exist");
  const mode = String(params.mode ?? 'auto').toLowerCase();
  if (!['preview', 'auto', 'dialog'].includes(mode)) refuse('merge_from_oml: mode must be preview|auto|dialog');
  if (firstPassPath && mode === 'dialog') refuse('merge_from_oml: first_pass_path runs two automatic merges; use mode=auto or preview');
  const firstPass = firstPassPath ? fs.readFileSync(firstPassPath) : null;
  if (firstPass && params.first_pass_sha256 !== sha(firstPass)) refuse('Validated first-pass bytes changed before merge (first_pass_sha256 is required with first_pass_path)');
  if (firstPass) extra.firstPassSha256 = sha(firstPass);
  let plan = null;
  if (basePath) {
    if (params.reference_plan == null) { extra.plan = 'missing'; refuse('merge_from_oml: the thin bridge needs the reference_plan computed by the server; update the server'); }
    try { plan = readPlan(params.reference_plan); } catch (error) { extra.plan = 'unreadable: ' + error.message; refuse('merge_from_oml: the thin bridge needs the reference_plan computed by the server; update the server (' + error.message + ')'); }
    extra.plan = 'ok'; extra.planChanges = plan.Changes.length; extra.planConflicts = plan.Conflicts.length;
  }
  target(params);
  const foreign = fs.readFileSync(foreignPath);
  const base = basePath ? fs.readFileSync(basePath) : null;
  if (!base || ![...snapshots.values()].includes(upper(base))) refuse(`base '${basePath ?? '(missing)'}' is not a snapshot of this module taken in this session: use snapshot_module`);
  if (params.base_sha256 != null && params.base_sha256 !== sha(base)) refuse('Validated base bytes changed before merge');
  if (params.foreign_sha256 != null && params.foreign_sha256 !== sha(foreign)) refuse('Validated foreign bytes changed before merge');
  const id = String(params.operation_id ?? randomUUID().replace(/-/g, ''));
  if (journal.has(id)) return journal.get(id);
  extra.foreignSha256 = sha(foreign); extra.baseSha256 = sha(base);
  const same = sha(foreign) === sha(base) && !plan.HasChanges;
  const data = { mode, local: spec.name, foreign: spec.name, base: spec.name, hasNoDifferences: same, hasConflicts: plan.HasConflicts,
    nativeHasNoDifferences: sha(foreign) === sha(base), referenceSignatures: plan, dumpPath: foreignPath + '.matchtree.txt', dumpChars: 0, dumpHead: '',
    timings: { thread: 'worker' } };
  if (firstPass) data.mergeOrder = { passes: 2, firstPassSha256: sha(firstPass) };
  if (mode === 'preview' || (same && !firstPass) || plan.HasConflicts) {
    Object.assign(data, { merged: false, reason: mode === 'preview' ? 'preview' : plan.HasConflicts ? 'producer signature changed concurrently: review referenceSignatures before retrying' : 'no differences' });
  } else {
    current = foreign; // the merged module is the candidate (the module had no edit since the base)
    Object.assign(data, { result: 'Merge', merged: true, undoSteps: firstPass ? 2 : 1 });
    if (firstPass) data.secondPass = { dumpPath: foreignPath + '.second-pass.matchtree.txt', hasConflicts: false, hasNoDifferences: false, result: 'Merge', merged: true };
  }
  Object.assign(data, { new: [], fixed: [], preexisting: [], newErrors: 0, localIsValidAfter: true, totalMs: 1, operationId: id });
  extra.merged = data.merged;
  journal.set(id, data);
  return data;
}

function environment(params, extra) {
  const operation = params.operation;
  extra.operation = operation;
  if (operation === 'connect') {
    if (!spec) refuse('No Studio session is logged in');
    const lease = randomUUID();
    leases.set(lease, { readOnly: params.readOnly === true });
    return { lease, host: spec.environment, username: 'e2e.user', ideVersion: o11Version, serverVersion: '11.41.0.46924', operations: OPERATIONS };
  }
  if (!leases.has(params.lease)) refuse('environment_session: unknown or expired lease');
  if (operation === 'close') { leases.delete(params.lease); return { closed: true }; }
  const args = params.arguments ?? {};
  if (operation === 'modules') return { value: [moduleSummary()] };
  // The server catalog has a newer (System) signature than the module's reference: the server finds it stale.
  if (operation === 'referenceable') return { value: [{ Key: spec.systemKey, Name: '(System)', Kind: 'eSpace', SignatureHash: '9b2d5f7e-3c41-4a8e-b6d0-1f2e3a4b5c6d', IsSystem: true, ApplicationKey: null }] };
  if (operation === 'signature') return { value: null };
  if (operation === 'download') {
    if (args.module?.Key !== spec.key) refuse('download: unknown module');
    const folder = absolute('environment_session', 'outputDirectory', args.outputDirectory);
    const file = path.join(folder, spec.name + '.oml');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, current);
    extra.downloadSha256 = sha(current);
    return { value: { Name: spec.name, Key: spec.key, Kind: 'eSpace', VersionId: 7, Bytes: current.length, FilePath: file, UploadDate: '2026-10-01T12:00:00Z',
      UploadUser: 'e2e.user', IsPublishedVersion: true, ElapsedMs: 1, Status: 'ok' } };
  }
  throw new Error('fake bridge: environment_session ' + operation);
}

// The last 1-Click Publish as the thin bridge projects it: the element only from ExtraInfo "Name;Key" (no resolver).
const publishLog = () => ({ found: true, module: spec?.name ?? null, moduleKey: spec?.key ?? null, environment: spec?.environment ?? null, serverOperationId: 'op-thin-e2e',
  operation: '1-Click Publish', status: 'failed', state: 'Error', stage: 'Deploying', failedStage: 'Deploying', startedAt: '2026-10-05T10:00:00Z', endedAt: '2026-10-05T10:00:09Z',
  lastUploadDateTime: '2026-10-05T10:00:01Z', triggeredBy: 'e2e.user', errors: 1, warnings: 0,
  steps: [{ stage: 'Preparing', text: 'Uploading', shownAt: '2026-10-05T10:00:00Z' }, { stage: 'Deploying', text: 'Deploying', shownAt: '2026-10-05T10:00:05Z' }],
  messages: [{ type: 'Error', stage: 'Deploying', text: "Invalid SQL in 'ThinE2EPing'", id: 'DatabaseError', shownAt: '2026-10-05T10:00:08Z',
    element: { name: 'ThinE2EPing', key: 'thin-e2e-ping-key', source: 'extraInfo' } }],
  omitted: 0 });

const ownFileSha256 = () => { try { return sha(fs.readFileSync(path.join(agentRoot, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll'))); } catch { return null; } };

function o11Reply(method, params, extra) {
  if (method === 'ping') return { bridge: 'anvil', flavor: 'thin', pid: o11Pid, version: o11Version, uiThread: true };
  // Like the thin bridge loaded by the development hook from <agent>\bin\o11\bridge: the Studio pid, no bridge id, the
  // release hook ABI it supports and the sha256 of its own file (the agent's version handshake compares it with pack.json).
  if (method === 'bridge_manifest') return { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true,
    pid: o11Pid, bridgeId: null, hookAbi: 'h1', ideVersion: o11Version, bridgeSha256: ownFileSha256(),
    verbs: VERBS, capabilities: CAPABILITIES, serviceCenter: {} };
  if (method === 'ui_alive') return { alive: true };
  if (spec && method === 'get_active_module') return { name: spec.name, key: spec.key, environment: spec.environment };
  if (spec && method === 'open_module') {
    if (String(params.name ?? '').toLowerCase() !== spec.name.toLowerCase()) throw new Error(`module '${params.name}' did not become active`);
    return { name: spec.name, opened: false, alreadyOpen: true, elapsedMs: 1 };
  }
  if (spec && method === 'snapshot_module') return snapshot(params, extra);
  if (spec && method === 'merge_from_oml') return merge(params, extra);
  if (spec && method === 'merge_status') {
    const receipt = journal.get(String(params.operation_id ?? ''));
    return receipt ? { state: receipt.merged ? 'applied' : receipt.reason === 'no differences' ? 'unchanged' : 'not-applied', receipt } : { state: 'unknown' };
  }
  if (spec && method === 'get_errors') {
    target(params);
    const settled = params.settle === true;
    if (settled) generation++;
    extra.settle = settled;
    return { rawMessages: [], isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [], verifyMs: 1, kernelHints: false,
      ...(params.since ? { snapshot_id: params.since, new: [], fixed: [], preexisting: [], newErrors: 0 } : {}), generation, settled };
  }
  if (spec && method === 'refresh_references') {
    target(params);
    extra.producers = params.producers ?? null; extra.producerKeys = params.producer_keys ?? null;
    return { module: spec.name, moduleKey: spec.key, changed: false, refreshed: [], upToDate: Array.isArray(params.producers) ? params.producers : [],
      missing: [], newErrors: 0, undo: null, elapsedMs: 1 };
  }
  if (spec && method === 'publish_log') return publishLog();
  if (spec && method === 'environment_session') return environment(params, extra);
  return { method, modules: [], active: null, errors: [], windows: [] };
}

const o11 = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      const { method, params = {}, authorization } = request;
      // ping and bridge_manifest answer without a key (the agent probes with them); the rest needs the agent's own key.
      const open = method === 'ping' || method === 'bridge_manifest';
      const authOk = authorization === bridgeKey;
      const extra = {};
      let reply;
      if (!open && !authOk) reply = { success: false, error: 'Bridge authentication failed' };
      else if (!VERBS.includes(method)) reply = { success: false, executed: false, error: 'Unknown method: ' + method };
      else {
        try { reply = { success: true, data: o11Reply(method, params ?? {}, extra) }; }
        catch (error) { reply = error instanceof NotExecuted ? { success: false, executed: false, error: error.message } : { success: false, error: error.message }; }
      }
      record({ studio: 'o11', method, paramKeys: Object.keys(params ?? {}), authOk, hasPort: Object.hasOwn(params ?? {}, 'port'), success: reply.success,
        ...(reply.executed === false ? { executed: false } : {}), ...(reply.success ? {} : { error: reply.error }), ...extra });
      socket.write(JSON.stringify(reply) + '\n');
    }
  });
  socket.on('error', () => {});
});

await new Promise((resolve, reject) => { odc.once('error', reject); odc.listen(`\\\\.\\pipe\\ODC3-Bridge-${ODC_BRIDGE}-${odcPid}`, resolve); });
await new Promise((resolve, reject) => { o11.once('error', reject); o11.listen(o11Port, '127.0.0.1', resolve); });
fs.writeFileSync(studiosFile, JSON.stringify({ odcPid, o11Pid, o11Port, odcVersion, o11Version }));
// Ends with its parent: the harness closes stdin (or kills this process).
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

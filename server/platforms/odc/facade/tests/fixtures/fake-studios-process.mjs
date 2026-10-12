// The Studios of one simulated customer machine, in their own process, for the process end to end of phase 2
// (hosted-e2e-processes.mjs). Never a real Studio: a fake ODC bridge on \\.\pipe\ODC3-Bridge-<ODC_BRIDGE>-<unlikely pid> and a
// fake O11 bridge (the thin Anvil bridge, flavor "thin", that already serves the fake Service Studio) on a loopback port
// in 7400-7499.
//   node fake-studios-process.mjs <agentRoot> <studiosFile> <o11Port> [snapshotBytes] [o11Module.json] [odcModule.json] [profile]
// Writes {odcPid, o11Pid, o11Port, odcVersion, o11Version, odcBridge} to <studiosFile> once both listen, and one JSON line
// per request to <studiosFile>.log. Like the real bridges it reads and writes files only under the agent root it was given
// (the open O11 module's bytes come from the OML named in o11Module.json, the module the fake Service Studio has open).
// odcModule.json {name, oml, moduleKey, host, developerId} (servidor/fase4-22): a snapshot of that ODC module writes the
// bytes of that OML with the identity a real capture carries, so the server's kernel can build over it; any other
// module stays random bytes.
// profile (servidor/fase4-24): "current" (default) is this checkout's pack. The ODC bridge of client/Program.cs answers
// reference-producers and the headless Portal session (auth-status, portal-session status/fetch) for the ODC module's
// host. The thin O11 bridge of the 24th serves sc_http (sc_http:studioSession): the Service Center over the Studio's own
// HTTP session, the page fixtures of the facade tests standing for the Service Center (SC_PAGES). "pack-v48" is a
// customer still on the pack of the 23rd: the ODC bridge v48 (pipe ODC3-Bridge-v48-<pid>, no reference-producers) and
// the thin bridge of the 23rd (no sc_http; sc_web:hidden, sc_web:login and studio_login among its capabilities).
//
// The fake O11 bridge keeps the wire contract of the thin bridge (docs/O11-BRIDGE-FINA.md 3, 14, 16): the verbs of VERBS,
// any other answers {success:false, executed:false, "Unknown method: <m>"}; merge_from_oml with base_path needs the
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

const [agentRoot, studiosFile, portText, bytesText, moduleFile, odcModuleFile, profileText] = process.argv.slice(2);
const odcModule = odcModuleFile ? JSON.parse(fs.readFileSync(odcModuleFile, 'utf8')) : null;
const profile = profileText || 'current';
if (!['current', 'pack-v48'].includes(profile)) throw new Error('unknown profile ' + profile);
const pack23 = profile === 'pack-v48';
const odcBridge = pack23 ? 'v48' : ODC_BRIDGE;
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

// The headless Portal session of the 24th: the Studio is signed in on the ODC module's host. portal-session fetch reads
// the request file the server's mirror brought under the agent root and answers as the Studio's own HTTP session would:
// the public module assets PortalMetadata inspects (moduleversioninfo, the module page, its entry bundle and the view
// scripts, built from PORTAL_VIEWS) and the screenservice actions of one MCP connection (MCP), what odc_mcp_connection
// readiness reads. Any other route answers 404.
const TENANT = odcModule?.host ?? null;
const STUDIO_USER = odcModule?.developerId ?? 'e2e.dev';
const PORTAL_VIEWS = { connections: {
  'Connections.connection': ['connections/Connections/connection/DataActionGetConnection'],
  'Connections.elements': ['connections/Connections/elements/DataActionGetConnection', 'connections/Connections/elements/DataActionGetActions',
    'connections/Connections/elements/DataActionGetSelectedActions'] } };
const MCP = { connectionId: 'e2e-mcp-connection', name: 'E2E MCP', updatedOn: '2026-10-01T12:00:00Z', available: ['search_orders', 'get_order'], selected: ['search_orders'] };
const actionRows = names => ({ List: names.map(name => ({ Name: name, OriginalName: name, IsNotSupported: false })) });
const SCREEN_DATA = {
  'connections/Connections/connection/DataActionGetConnection': v => (v.ConnectionId === MCP.connectionId && v.ProviderId === 'mcp'
    ? { NotFound: false, Connection: { connectionId: MCP.connectionId, providerId: 'mcp', name: MCP.name, portfolioKey: '0b0e2e00-0000-4000-8000-000000000001',
      updatedOn: MCP.updatedOn, StageConfigurations: { List: [{ StageKey: 'e2e-stage-dev', configurationValues: { List: [{ key: 'host', value: 'mcp.neutral-e2e.test' }] } }] },
      ExternalMetadata: { selectedObjectCount: 0, selectedActionCount: MCP.selected.length } } }
    : { NotFound: true, Connection: null }),
  'connections/Connections/elements/DataActionGetConnection': () => ({ LastSuccessfulMetadataUpdateTimestamp: MCP.updatedOn, ConnectionUpdateTimestamp: MCP.updatedOn }),
  'connections/Connections/elements/DataActionGetActions': () => ({ ActionList: actionRows(MCP.available) }),
  'connections/Connections/elements/DataActionGetSelectedActions': () => ({ ActionList: actionRows(MCP.selected) }),
};
function portalFetch(file, host) {
  if (!TENANT || host !== TENANT) return { ok: false, code: 'HOST_MISMATCH', error: 'fake bridge: the Studio is not signed in on ' + host };
  if (!inside(file) || !fs.existsSync(file)) return { ok: false, code: 'BAD_REQUEST', error: 'fake bridge: no request file under the agent root' };
  const request = JSON.parse(fs.readFileSync(file, 'utf8'));
  const answer = (text, status = 200) => ({ ok: true, host: TENANT, status, text, user: STUDIO_USER });
  const url = new URL(request.path, 'https://' + TENANT);
  const [module, area, ...rest] = url.pathname.split('/').filter(Boolean);
  const views = PORTAL_VIEWS[module];
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!views) return answer('', 404);
  if (method === 'GET' && area === 'moduleservices' && rest.join('/') === 'moduleversioninfo') return answer(JSON.stringify({ versionToken: 'e2e-' + module }));
  if (method === 'GET' && area === undefined) return answer('<html><head><script src="scripts/_osbundle-e2e.index.js"></script></head><body></body></html>');
  if (method === 'GET' && area === 'scripts' && rest[0] === '_osbundle-e2e.index.js')
    return answer(Object.keys(views).map(view => `{screenName:"${view}",load:()=>import("./${view}.js")}`).join(',\n'));
  if (method === 'GET' && area === 'scripts' && rest.length === 1 && rest[0].endsWith('.js')) {
    const actions = views[rest[0].slice(0, -3)];
    return actions ? answer(actions.map(action => `define("screenservices/${action}","e2e-api")`).join(';\n')) : answer('', 404);
  }
  if (method === 'POST' && area === 'screenservices' && Object.hasOwn(SCREEN_DATA, rest.join('/')))
    return answer(JSON.stringify({ versionInfo: { hasModuleVersionChanged: false, hasApiVersionChanged: false },
      data: SCREEN_DATA[rest.join('/')](request.body?.screenData?.variables ?? {}) }));
  return answer('', 404);
}
const optionOf = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };

function odcReply(line) {
  const [command, ...args] = line.split(' ');
  if (command === 'status') return { ok: true, bridge: odcBridge, busy: null, modules: [] };
  if (command === 'auth-status') return { ok: true, bridge: odcBridge, portalWindows: [], capabilities: ['portal-session:headless'],
    sessions: TENANT ? [{ host: TENANT, loggedIn: true, user: STUDIO_USER, tokenValidUntil: '2099-01-01T00:00:00Z' }] : [] };
  if (command === 'portal-session' && args[0] === 'status') {
    const host = optionOf(args, '--tenant');
    return host === TENANT ? { ok: true, host, signedIn: true, studioUser: STUDIO_USER } : { ok: false, code: 'HOST_MISMATCH', error: 'fake bridge: not signed in on ' + host };
  }
  if (command === 'portal-session' && args[0] === 'fetch') return portalFetch(args[1], optionOf(args, '--tenant'));
  // reference-producers <Module> (bridge v96): ReferencesService.ListReferenceable in the open consumer session, read only.
  // The v48 bridge has no such command.
  if (command === 'reference-producers' && !pack23) {
    const real = odcModule && args[0] === odcModule.name;
    if (!real) return { ok: false, code: 'MODULE_NOT_OPEN', error: 'fake bridge: ' + args[0] + ' is not open' };
    return { ok: true, module: args[0], moduleKey: odcModule.moduleKey, tenant: TENANT, listedAt: new Date().toISOString(), source: 'ReferencesService.ListReferenceable',
      scope: 'consumer-session-visible-producers', count: 1, producers: [{ name: 'NeutralProducerLib', key: 'e2e-producer-key' }],
      sourceSha256: sha(fs.readFileSync(odcModule.oml)).toUpperCase(), consumerUnchanged: true, mergeInvoked: false, publishInvoked: false };
  }
  // A compromised bridge (or agent) naming a file outside the customer's workspace.
  if (command === 'snapshot' && args[0] === 'Evil') return { ok: true, module: 'Evil', path: 'agent:..\\..\\..\\.local\\server\\tokens.json' };
  if (command === 'snapshot') {
    const real = odcModule && args[0] === odcModule.name;
    const bytes = real ? fs.readFileSync(odcModule.oml) : randomBytes(snapshotBytes);
    const hash = sha(bytes).toUpperCase();
    const file = path.join(agentRoot, 'odc', 'snapshots', args[0] + '-' + hash + '.oml');
    const identity = real ? { moduleKey: odcModule.moduleKey, host: odcModule.host, developerId: odcModule.developerId } : {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(file + '.json', JSON.stringify({ ok: true, module: args[0], sha256: hash, path: file, ...identity }));
    return { ok: true, module: args[0], sha256: hash, size: bytes.length, path: file, ...identity };
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
// The verbs of the thin bridge of the 23rd this fake serves; the 24th adds sc_http after sc_web (Dispatch.Verbs).
const VERBS_23 = ['ping', 'bridge_manifest', 'get_active_module', 'list_open_modules', 'get_errors', 'open_module', 'close_module', 'publish',
  'windows', 'ui_alive', 'close_dialog', 'snapshot_module', 'merge_from_oml', 'merge_status', 'environment_session', 'sc_api', 'sc_web',
  'studio_login', 'sc_session', 'publish_log', 'refresh_references'];
const VERBS = pack23 ? VERBS_23 : VERBS_23.flatMap(verb => (verb === 'sc_web' ? ['sc_web', 'sc_http'] : [verb]));
// The thin bridge's Dispatch.Capabilities (merge_from_oml:first_pass: the merge order runs in one call; the ninth release's
// rollback proof, module_key, validation generation, publish wait and dialogs, server operation and refresh_references).
// The 24th: sc_api:integration-studio and sc_http:studioSession in; sc_web:hidden, sc_web:login and studio_login out.
const CAPABILITIES_23 = ['environment_session', 'sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', 'sc_web', 'sc_web:secretRefs', 'sc_web:hidden',
  'sc_web:login', 'studio_login', 'sc_session', 'publish_log', 'merge_from_oml:first_pass', 'merge_from_oml:rollback_proof', 'merge_from_oml:module_key',
  'get_errors:generation', 'publish:wait_running', 'publish:dialogs_seen', 'list_open_modules:server_operation', 'refresh_references', 'thin', 'merge:reference-plan'];
const CAPABILITIES = pack23 ? CAPABILITIES_23 : ['environment_session', 'sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', 'sc_web', 'sc_web:secretRefs',
  'sc_session', 'publish_log', 'merge_from_oml:first_pass', 'merge_from_oml:rollback_proof', 'merge_from_oml:module_key', 'get_errors:generation',
  'publish:wait_running', 'publish:dialogs_seen', 'list_open_modules:server_operation', 'refresh_references', 'sc_api:integration-studio',
  'sc_http:studioSession', 'thin', 'merge:reference-plan'];
// The Service Center pages the fake Studio's own HTTP session answers (sc_http fetch): the page fixtures of the facade
// tests stand for the Service Center of the open module's environment.
const SC_PAGES = { 'GET /ServiceCenter/DatabaseConnections_List.aspx': path.join(import.meta.dirname, 'sc-pages', 'modern', 'dbconnections', 'dbconnections-list.html') };
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

// sc_http (ScHttpHandler): status, open, close and login answer the Studio's own session (no window, no credential);
// fetch answers a page of SC_PAGES for the open module's environment, anything else is refused before any request.
function serviceCenterHttp(params, extra) {
  extra.scAction = params.action ?? null; extra.scMethod = params.method ?? null; extra.scPath = params.path ?? null;
  if (params.host !== spec.environment) refuse(`sc_http: the Studio is not signed in on '${params.host}'`);
  if (['status', 'open', 'close', 'login'].includes(params.action)) return { ok: true, host: params.host, signedIn: true, headless: true };
  if (params.action !== 'fetch') refuse('sc_http: unknown action ' + params.action);
  const key = `${params.method} ${params.path}`;
  if (!Object.hasOwn(SC_PAGES, key)) refuse('sc_http: the fake Service Center has no page ' + key);
  return { ok: true, source: 'studio-http', host: params.host, status: 200, finalUrl: `https://${params.host}${params.path}`, contentType: 'text/html; charset=utf-8',
    html: fs.readFileSync(SC_PAGES[key], 'utf8').replace(/\r\n?/g, '\n') };
}

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
  // The Service Center through the Studio (both profiles answer sc_session; only the 24th has sc_http in VERBS).
  if (spec && method === 'sc_session') {
    if (params.host == null) return { ok: true, signedInHosts: [spec.environment] };
    return { ok: true, source: 'studio', host: params.host, bridgeVersion: o11Version, studio: { signedIn: params.host === spec.environment, user: 'e2e.user', loginType: 'sso' },
      web: { open: false, signedIn: false } };
  }
  if (spec && method === 'sc_http') return serviceCenterHttp(params, extra);
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

await new Promise((resolve, reject) => { odc.once('error', reject); odc.listen(`\\\\.\\pipe\\ODC3-Bridge-${odcBridge}-${odcPid}`, resolve); });
await new Promise((resolve, reject) => { o11.once('error', reject); o11.listen(o11Port, '127.0.0.1', resolve); });
fs.writeFileSync(studiosFile, JSON.stringify({ odcPid, o11Pid, o11Port, odcVersion, o11Version, odcBridge }));
// Ends with its parent: the harness closes stdin (or kills this process).
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

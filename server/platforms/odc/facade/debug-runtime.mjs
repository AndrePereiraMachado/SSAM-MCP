import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { anvilRoot, workspaceRoot } from './workspace.mjs';
import { debugSchema, sessionIdSchema, traceSchema } from './debug.mjs';
import { prepareDebugAppUser, releaseDebugAppUser, privateAppUserVault, appUserBinding, sameAppUserTarget, appUserSummary } from './debug-app-user.mjs';
import { getO11DebugToken, o11DebugAuthTarget, validateO11PublicationProof } from './debug-o11-auth.mjs';
import { developerAuthRequired, legacyDeveloperAuth, nativeFailure, signInFailureOf } from './debug-guidance.mjs';
import { validateOdcProducerRedaction } from './debug-odc-producer-target.mjs';
import { createServerPrivateInspection } from './debug-server-private-inspection.mjs';
const privateInspections = new Map();
// Only gates before start(), token acquisition and worker creation may throw this.
export class DebugInspectionPreflightError extends Error {
  constructor() { super('debug_o11_anonymous_inspection_context_invalid'); }
}
const exec = promisify(execFile);
const sessionRoot = path.join(workspaceRoot, '.local', 'debugger');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); }
const o11AuthRoot = path.join(sessionRoot, 'o11-auth');
const safeO11Error = error => /^debug_o11_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_o11_token_exchange_unavailable';
// The public arguments of the same start (a continuation repeats them once the user can sign in); nothing private.
const repeatArguments = input => Object.fromEntries(['op', 'lane', 'tenant', 'module', 'moduleKey', 'runtimeUrl', 'nodeKeys', 'paths', 'seconds', 'o11Auth', 'credentials']
  .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
export const debugBootstrapTimeoutMs = lane => lane === 'odc' ? 125000 : 40000;
const debugFailureCode = value => typeof value === 'string' && /^debug_[a-z0-9_]{1,100}(?::[A-Za-z0-9_]{1,80}){0,3}$/.test(value) ? value : null;
const debugExceptionClass = value => ['DebugFailure', 'WebException', 'HttpRequestException', 'IOException', 'TimeoutException',
  'TaskCanceledException', 'OperationCanceledException', 'JsonReaderException', 'JsonSerializationException', 'JsonException',
  'InvalidOperationException', 'ArgumentException', 'NullReferenceException', 'AggregateException'].includes(value) ? value : value == null ? null : 'unknown';
// Deliberately select fields: a worker failure may never expose arbitrary message/type/transport data.
export function debugSessionDiagnostic(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const result = { startError: debugFailureCode(Object.hasOwn(value, 'startError') ? value.startError : value.error),
    startExceptionClass: debugExceptionClass(Object.hasOwn(value, 'startExceptionClass') ? value.startExceptionClass : value.exceptionType),
    stopError: debugFailureCode(value.stopError), stopExceptionClass: debugExceptionClass(value.stopExceptionClass) };
  const t = value.transport;
  if (t && ['not-started', 'preparing', 'rest-start', 'hub-configure', 'hub-connect', 'connected', 'soap-start', 'poll-starting', 'poll-connected'].includes(t.startPhase) &&
      ['not-started', 'no-session-token', 'rest-stop', 'hub-dispose', 'completed', 'stopping', 'stopped'].includes(t.stopPhase) &&
      ['not-attempted', 'attempted', 'failed', 'accepted'].includes(t.startOutcome) && typeof t.tokenObtained === 'boolean')
    result.transport = { startPhase: t.startPhase, stopPhase: t.stopPhase, startOutcome: t.startOutcome, tokenObtained: t.tokenObtained,
      ...Object.fromEntries(['pollRequests','pollResponses','lastPollStatus','nativeEvents'].filter(k => Number.isSafeInteger(t[k]) && t[k] >= 0).map(k => [k,t[k]])) };
  return result;
}
export const O11_CROSS_MODULE_REDACTION = true;
// Internal runner context only: the consumer's credentials suppress private values in
// producer frames. They do not authenticate a producer request or prove its user/roles.
export function debugRedactionBinding(input, descriptor, sessionId, redactionOnly = false, odcProducerTrace) {
  const target = appUserBinding(input, sessionId);
  if (!descriptor) return target;
  const source = descriptor.binding;
  if (!Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= Date.now())
    throw new Error('debug_app_user_scope_mismatch');
  if (sameAppUserTarget(source, target)) return target;
  if (redactionOnly === true && odcProducerTrace && source?.sessionId === sessionId &&
      sameAppUserTarget(source, appUserBinding(source, sessionId)) && validateOdcProducerRedaction(input, source, odcProducerTrace)) return source;
  if (redactionOnly !== true || input.lane !== 'o11' || !input.o11Auth || source?.lane !== 'o11' ||
      source.sessionId !== sessionId || !sameAppUserTarget(source, appUserBinding(source, sessionId)) ||
      new URL(source.runtimeUrl).origin !== new URL(target.runtimeUrl).origin)
    throw new Error('debug_app_user_scope_mismatch');
  return source;
}
// Private host-to-worker data only. This is redaction evidence, never app authorization or public output.
export async function privateAppUserValues(descriptor, binding, { vault = privateAppUserVault, now = Date.now } = {}) {
  const validExpiry = value => Number.isFinite(Date.parse(value)) && Date.parse(value) > now();
  const nonempty = (value, max = 65536) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(descriptor?.credentialRef ?? '') ||
      !sameAppUserTarget(descriptor?.binding, binding) || !validExpiry(descriptor?.expiresAt)) throw new Error('debug_app_user_scope_mismatch');
  // A Custom REST endpoint credential: its header values are the private values; it never authenticates the debugger.
  if (descriptor.kind === 'endpoint-credential') return (await import('./debug-app-user-worker.mjs')).privateEndpointCredentialValues(descriptor, { vault, now });
  let record; const values = [];
  const add = value => { if (nonempty(value) && !values.includes(value)) values.push(value); };
  try {
    record = await vault('read', { credentialRef: descriptor.credentialRef, binding, expiresAt: descriptor.expiresAt });
    if (!record?.ok || !sameAppUserTarget(record.binding, binding) || !validExpiry(record.expiresAt) || !validExpiry(descriptor.expiresAt))
      throw new Error();
    if (binding.lane === 'o11') {
      if (record.kind !== 'credentials' || !nonempty(record.username, 4096) || !nonempty(record.password, 4096)) throw new Error();
      add(record.username); add(record.password);
    } else {
      const session = record.kind === 'session' ? record.session : null;
      if (!session || descriptor.state !== 'authenticated' || descriptor.authenticated !== true || !sameAppUserTarget(session.binding, binding) ||
          !validExpiry(session.expiresAt) || !nonempty(session.accessToken) || /[\x00-\x1f\x7f]/.test(session.accessToken) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(session.userKey ?? '') || session.userKey !== descriptor.userKey) throw new Error();
      for (const key of ['idToken', 'refreshToken']) if (session[key] != null && session[key] !== '' && !nonempty(session[key])) throw new Error();
      for (const key of ['accessToken', 'idToken', 'refreshToken', 'username', 'email']) add(session[key]);
      add(record.username); add(record.email);
      // Existing bound ID-token claims are used only to suppress copied identifiers, never to assign roles/user.
      try {
        const parts = session.idToken?.split('.');
        if (parts?.length === 3 && parts[1].length <= 32768) {
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          for (const key of ['email', 'username', 'preferred_username', 'cognito:username']) if (nonempty(claims[key], 4096)) add(claims[key]);
        }
      } catch { /* Opaque/malformed tokens remain private values; no claim is trusted for authentication. */ }
      // ODC passwords have been discarded after SRP; do not restore or persist them for redaction.
    }
    if (values.length > 32) throw new Error();
    return values;
  } catch {
    values.fill('');
    throw new Error('debug_app_user_credentials_unavailable');
  } finally {
    if (record) {
      record.username = ''; record.password = ''; record.email = '';
      if (record.session) for (const key of ['accessToken', 'idToken', 'refreshToken', 'username', 'email']) record.session[key] = '';
    }
    record = null;
  }
}
async function odcDebugToken(input) {
  const { connect } = await import('./debug-odc-portal.mjs');
  const portal = await connect(input.tenant), { bridge } = portal;
  try {
  const live = await bridge.execute('portfolio-api-v2:get:/environments', {}, 'read');
  const rows = Array.isArray(live.data) ? live.data : live.data?.results;
  if (!live.ok || !rows?.some(e => [e.builtinDomain, e.defaultDomain].includes(new URL(input.runtimeUrl).hostname))) throw new Error('debug_runtime_not_in_tenant');
    return await bridge.auth.getToken();
  } finally { await portal.release?.(); }
}
export async function selectedO11Studio(services = {}) {
  const { LANES, anvilLaneFacts } = await import('./lanes.mjs');
  const { readConnection } = await import('./studio-session.mjs');
  const { assertSelectedO11, probeO11 } = await import('./studio-connect.mjs');
  const lane = services.lane ?? LANES.o11;
  const readSelected = services.readConnection ?? readConnection;
  let record;
  try {
    record = readSelected(lane.root, lane.lane);
    if (!record) throw new Error();
    await (services.assertSelectedO11 ?? assertSelectedO11)();
    const current = readSelected(lane.root, lane.lane);
    if (!current || current.pid !== record.pid || current.startedUtc !== record.startedUtc || current.studioDir !== record.studioDir) throw new Error();
    const [probe, facts] = await Promise.all([(services.probeO11 ?? probeO11)(record.port), (services.anvilLaneFacts ?? anvilLaneFacts)()]);
    if (!probe.connected || probe.pid !== record.pid || path.resolve(facts.studioDir).toLowerCase() !== path.resolve(record.studioDir).toLowerCase()) throw new Error();
  } catch { throw new Error('debug_o11_selected_studio_unavailable'); }
  return { pid: record.pid, startedUtc: record.startedUtc, studioDir: record.studioDir };
}
// Testable identity gate, also executed before the private token request. It never reads Studio credentials.
export function o11DebugRequest(input, sessionId, selected, operationId = randomUUID(), now = Date.now()) {
  const url = new URL(input.runtimeUrl);
  const entryModule = input.o11Auth?.entry?.module ?? input.module;
  if (input.lane !== 'o11' || !input.o11Auth || url.port || !['/' + entryModule, '/' + entryModule + '/'].includes(url.pathname))
    throw new Error('debug_o11_same_module_required');
  if (!selected || !Number.isSafeInteger(selected.pid) || selected.pid < 1 || !Number.isFinite(Date.parse(selected.startedUtc)) || !path.isAbsolute(selected.studioDir ?? ''))
    throw new Error('debug_o11_selected_studio_unavailable');
  const request = { operationId, pid: selected.pid, startedUtc: selected.startedUtc, host: url.hostname,
    module: input.module, moduleKey: input.moduleKey, ...input.o11Auth, sessionId };
  const binding = { ...o11DebugAuthTarget(request), startedUtc: selected.startedUtc };
  let bytes, proof;
  try {
    if (fs.statSync(request.publishedProof.path).size > 8388608) throw new Error();
    bytes = fs.readFileSync(request.publishedProof.path);
    proof = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch { throw new Error('debug_o11_publication_proof_invalid'); }
  if (bytes.length > 8388608 || createHash('sha256').update(bytes).digest('hex') !== request.publishedProof.sha256) throw new Error('debug_o11_publication_proof_changed');
  validateO11PublicationProof(binding, proof, now);
  return { request, binding };
}
function validatePrivateO11Reply(reply, authority) {
  const privateText = (value, max, bytes = max) => typeof value === 'string' && value.length > 0 && value.length <= max && Buffer.byteLength(value) <= bytes && !/[\x00-\x1f\x7f]/.test(value);
  const preflight = reply?.preflight;
  if (reply?.ok !== true || reply.operationId !== authority.request.operationId || reply.newAuthentication !== true ||
      !['oauth', 'server-identity', 'identity-service'].includes(reply.path) || JSON.stringify(reply.binding) !== JSON.stringify(authority.binding) ||
      !privateText(reply.token, 65536) || !privateText(reply.soapUser, 512, 2048) || !privateText(reply.soapSecret, 65536) ||
      preflight?.pingSucceeded !== true || preflight.inDebug !== true || preflight.debuggerVersion !== 1 ||
      Object.keys(preflight).some(key => !['pingSucceeded', 'inDebug', 'debuggerVersion'].includes(key))) throw new Error('debug_o11_token_response_invalid');
}
function authOperationPhase(operationId) {
  try { return read(path.join(o11AuthRoot, operationId, 'journal.json')).phase; } catch { return null; }
}
export function o11TokenFailureIsUncertain(error, phase) {
  if (phase === 'failed') return false;
  if (['uncertain', 'attaching', 'consumed'].includes(phase)) return true;
  // Pre-attach contract/proof/process refusals prove no authentication was submitted.
  return !/^debug_o11_(publication_proof_[a-z_]+|module_scope_[a-z_]+|token_contract_[a-z_]+|auth_hook_build_failed|selected_studio_unavailable|studio_target_unavailable|studio_operation_failed|process_changed)$/.test(error?.message ?? '');
}
export function pipeRequest(id, request, timeout = 15000) {
  sessionIdSchema.parse(id);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection('\\\\.\\pipe\\ssam-debug-' + id); let data = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result); };
    socket.setTimeout(timeout, () => finish(new Error('debug_command_uncertain: query status; do not repeat execution')));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', buffer => { data += buffer; if (data.length > 4194304) return finish(new Error('debug_response_too_large')); const end = data.indexOf('\n'); if (end >= 0) { try { finish(null, JSON.parse(data.slice(0, end))); } catch { finish(new Error('debug_invalid_response')); } } });
    socket.on('error', () => finish(new Error('debug_session_unreachable')));
    socket.on('end', () => { if (!settled) finish(new Error('debug_command_uncertain')); });
  });
}
// ODC: the runtime rule of the kernel and the reader (lib.mjs odcStudioDir): ANVIL_ODC_STUDIO_DIR when set, refused
// when it is not an ODC Studio folder, never replaced by the installation; unset, the installed ODC Studio, as before.
async function installation(lane) {
  if (lane === 'odc') return (await import('./lib.mjs')).odcStudioDir();
  const { anvilLaneFacts } = await import('./lanes.mjs'); return (await anvilLaneFacts()).studioDir;
}
async function worker(lane, studioDir) {
  const root = path.join(anvilRoot, 'debug'), hash = createHash('sha256').update(studioDir);
  for (const dir of ['shared', lane]) for (const file of fs.readdirSync(path.join(root, dir)).filter(f => /\.(cs|csproj)$/.test(f)).sort()) hash.update(fs.readFileSync(path.join(root, dir, file)));
  for (const file of ['Directory.Build.props', 'NativeReferences.props']) hash.update(fs.readFileSync(path.join(root, file)));
  if (lane === 'o11') hash.update(fs.readFileSync(path.join(anvilRoot, 'src', 'Anvil.Core', 'Kernel', 'Credentials.cs')));
  const sdk = fs.statSync(path.join(studioDir, 'OutSystems.DebuggerClient.dll')); hash.update(String(sdk.size) + ':' + sdk.mtimeMs);
  const out = path.join(sessionRoot, 'builds', lane, hash.digest('hex').slice(0, 16)), dll = path.join(out, 'SSAM.Debugger.dll');
  if (!fs.existsSync(path.join(out, 'ready.json'))) {
    const buildLock = path.join(sessionRoot, 'build-' + lane + '.lock'); let handle;
    try { handle = fs.openSync(buildLock, 'wx'); } catch { throw new Error('debug_build_in_progress'); }
    try { await exec('dotnet', ['build', path.join(root, lane, 'Debugger.csproj'), '-c', 'Release', '-o', out, '-p:StudioDir=' + studioDir, '--nologo', '-v', 'quiet'], { windowsHide: true, timeout: 120000, maxBuffer: 1048576 }); write(path.join(out, 'ready.json'), { built: true }); }
    catch { throw new Error('debug_build_failed: build kernel/debug/' + lane + '/Debugger.csproj to inspect SDK compatibility'); }
    finally { fs.closeSync(handle); fs.unlinkSync(buildLock); }
  }
  return dll;
}
async function start(input, suppliedAppUser, services = {}, redactionOnly = false, backgroundWatch = false, anonymousWatch = false, odcProducerTrace, anonymousInspection, backgroundInspection, additionalO11Session = false, privateCompare) {
  const { lane, module, moduleKey, runtimeUrl, nodeKeys, seconds, pauseSeconds, autoContinue, paths, credentials } = input;
  // An O11 start with no developer sign-in at all (no o11Auth, no credentials file, no SSAM_O11_*) would open the app
  // user window and then fail natively; it is refused first, with the call that has the Studio SSO (C05).
  if (lane === 'o11' && !input.o11Auth && !credentials && !(services.legacyDeveloperAuth ?? legacyDeveloperAuth)())
    return developerAuthRequired(input);
  const debugRoot = services.sessionRoot ?? sessionRoot;
  const releaseAppUser = services.releaseAppUser ?? releaseDebugAppUser;
  const sessionId = additionalO11Session ? randomUUID().replaceAll('-', '') : suppliedAppUser?.binding?.sessionId ?? randomUUID().replaceAll('-', '');
  let modelScopeEvidence;
  if (input.modelScope) {
    // Finish model reads before acquiring a debugger lock, credentials or a
    // token. A bad capture must never become an uncertain native start.
    const readScopes = services.readScopes ?? (await import('./debug-native-scope-reader.mjs')).readNativeInspectionScopes;
    const model = await readScopes({ lane, moduleKey, ...input.modelScope, runtime: 'server',
      directory: path.join(debugRoot, 'model-scopes', sessionId) });
    const { inspectionSchema } = await import('./debug.mjs');
    const inspection = inspectionSchema.safeParse({ variables: model.variables,
      scopes: input.modelScope.scopes.flatMap(scope => scope.nodeKeys.map(nodeKey => ({ moduleKey: input.moduleKey,
        functionKey: scope.functionKey, nodeKey, sourceSha256: input.modelScope.source.sha256 }))) });
    if (!inspection.success) throw new Error('debug_native_scope_server_metadata_invalid');
    // Reapply lane-specific native address validation; no paths or variables
    // are truncated to fit the worker's selected-metadata budget.
    const { modelScope, ...base } = input;
    input = debugSchema.parse({ ...base, inspection: inspection.data });
    modelScopeEvidence = { source: modelScope.source, evidence: model.evidence, coverage: model.coverage,
      scopeComplete: false, publishedBindingVerified: false, runtimeValuesEvaluated: false };
  }
  // An auxiliary consumer debugger owns its native session, not the runner's
  // credential lease. Read the original lease with its original binding; never
  // clone/rebind credentials just to allocate a second native worker.
  const binding = debugRedactionBinding(input, suppliedAppUser,
    additionalO11Session ? suppliedAppUser.binding.sessionId : sessionId, redactionOnly, odcProducerTrace);
  fs.mkdirSync(debugRoot, { recursive: true });
  const targetHash = createHash('sha256').update(lane + '|' + new URL(runtimeUrl).origin.toLowerCase() + '|' + moduleKey).digest('hex');
  const lock = path.join(debugRoot, targetHash + '.lock');
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); } catch { throw new Error('debug_target_has_session: inspect the session receipt before another start: ' + lock); }
  fs.writeFileSync(descriptor, JSON.stringify({ sessionId })); fs.closeSync(descriptor);
  const dir = path.join(debugRoot, sessionId); fs.mkdirSync(dir);
  const receiptPath = path.join(dir, 'receipt.json');
  const manifest = { sessionId, lane, tenant: input.tenant, module, moduleKey, runtimeUrl, nodeKeys, lock, receiptPath,
    ...(input.nodeModuleKeys ? { breakpointOwners: input.nodeModuleKeys } : {}),
    ...(input.inspection && [...(input.inspection.sources??[]),...(input.inspection.scopes??[]),...input.inspection.variables].length
      ? {privateInspectionEnabled:true} : {}),
    ...(modelScopeEvidence ? { modelScopeEvidence } : {}),
    ...(backgroundWatch ? { contextMode: 'native-background', backgroundWatch: true } : {}),
    ...(anonymousWatch ? { contextMode: 'anonymous', anonymousWatch: true } : {}),
    ...(anonymousInspection ? { anonymousInspection } : {}),
    ...(backgroundInspection ? { backgroundInspection } : {}),
    ...(redactionOnly ? { appUserBorrowed: true, appRequestIdentityProved: false } : {}),
    ...(additionalO11Session ? { additionalO11Session: true, credentialOwnerSessionId: binding.sessionId } : {}),
    ...(odcProducerTrace ? { producerTarget: odcProducerTrace, rolesProved: false, propagationProved: false } : {}),
    ...(input.op === 'watch' ? { mode: 'watch', trace: input.trace, seconds } : {}) };
  write(path.join(dir, 'manifest.json'), manifest);
  let spawned = false, appUser = suppliedAppUser, authority, tokenRequested = false;
  let token, soapUser, soapSecret, privateValues = [], bootstrap = '';
  try {
    if (lane === 'odc') token = await (services.getOdcDebugToken ?? odcDebugToken)(input);
    const selected = input.o11Auth ? await (services.selectedO11Studio ?? selectedO11Studio)() : null;
    const studioDir = selected?.studioDir ?? await (services.installation ?? installation)(lane);
    const dll = await (services.worker ?? worker)(lane, studioDir);
    if (!appUser && !backgroundWatch && !anonymousWatch) {
      const prepared = await (services.prepareAppUser ?? prepareDebugAppUser)(input, { sessionId });
      if (!prepared.ok) {
        write(receiptPath, { ...prepared, sessionId, lane }); fs.unlinkSync(lock);
        return { ...prepared, sessionId, receiptPath };
      }
      appUser = prepared.descriptor;
    }
    if (!backgroundWatch && !anonymousWatch) privateValues = await privateAppUserValues(appUser, binding, { vault: services.privateAppUserVault ?? privateAppUserVault });
    if (input.o11Auth) {
      authority = o11DebugRequest(input, sessionId, selected);
      // Only metadata is persisted. Native SSO is requested after the private app sign-in window closes.
      manifest.o11Auth = { operationId: authority.request.operationId, binding: authority.binding, publishedProof: authority.request.publishedProof };
      write(path.join(dir, 'manifest.json'), { ...manifest, appUser });
      write(receiptPath, { ok: false, state: 'authenticating-debugger', sessionId, lane, o11Auth: manifest.o11Auth });
      tokenRequested = true;
      const reply = await (services.getO11DebugToken ?? getO11DebugToken)(authority.request);
      try {
        validatePrivateO11Reply(reply, authority);
        token = reply.token; soapUser = reply.soapUser; soapSecret = reply.soapSecret;
      } finally {
        if (reply && typeof reply === 'object') { reply.token = null; reply.soapUser = null; reply.soapSecret = null; }
      }
      tokenRequested = false; // A confirmed token exchange is terminal; a later local failure has no remote debug session.
    }
    write(path.join(dir, 'manifest.json'), { ...manifest, appUser });
    write(receiptPath, { ok: false, state: 'starting', sessionId, lane });
    if (appUser && Date.parse(appUser.expiresAt) <= Date.now()) throw new Error('debug_app_user_expired');
    if (input.inspection) {
      const sources=[...(input.inspection.sources??[]),...(input.inspection.scopes??[]),...input.inspection.variables]
        .map(({moduleKey,sourceSha256})=>({moduleKey,sourceSha256}));
      if(sources.length) {
        const expiresAt=new Date(Math.min(Date.now()+seconds*1000,appUser?Date.parse(appUser.expiresAt):Infinity)).toISOString();
        privateInspections.set(sessionId,createServerPrivateInspection({expiresAt,sources,binding:{kind:'native-debug-session',
          sessionId,lane,runtimeUrl,moduleKey,module,contextMode:appUser?'app-user':backgroundWatch?'native-background':'anonymous',
          ...(additionalO11Session?{credentialOwnerSessionId:binding.sessionId}:{}),
          ...(appUser?{appUser:binding}:{})}},privateCompare?{privateCompare}:{}));
      }
    }
    // Match native SSO: distinct debug bearer plus username/server-call ID token, privately over stdin.
    // The fourth SOAP argument controls exception pauses and stays false.
    bootstrap = JSON.stringify({ sessionId, runtimeUrl, module, moduleKey, nodeKeys, ...(input.nodeModuleKeys ? { nodeModuleKeys: input.nodeModuleKeys } : {}), token, soapUser, soapSecret, credentials, privateValues, seconds, pauseSeconds, autoContinue, paths, receiptPath,
      ...(appUser ? { credentialExpiresAt: appUser.expiresAt } : {}),
      ...(input.o11Auth?.entry ? { entryModule: input.o11Auth.entry.module, entryModuleKey: input.o11Auth.entry.moduleKey } : {}), ...(input.trace ? { trace: input.trace } : {}),
      ...(input.inspection ? { inspection: input.inspection } : {}),
      ...(privateInspections.has(sessionId)?{privateInspectionKey:privateInspections.get(sessionId).bootstrapKey()}:{}) });
    token = null; soapUser = null; soapSecret = null;
    if (bootstrap.length > 1024 * 1024) throw new Error('debug_o11_bootstrap_too_large');
    const child = (services.spawn ?? spawn)('dotnet', [dll, studioDir], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); spawned = true;
    const initial = new Promise((resolve, reject) => {
      let data = ''; const timer = setTimeout(() => { detach(); reject(new Error('debug_start_uncertain: inspect receipt ' + receiptPath)); }, debugBootstrapTimeoutMs(lane));
      function detach() { clearTimeout(timer); child.stdout.destroy(); child.stdin.destroy(); child.unref(); }
      child.once('error', () => { spawned = false; detach(); reject(new Error('debug_worker_start_failed')); });
      child.stdout.on('data', b => { data += b; if (data.length > 1048576) { detach(); reject(new Error('debug_invalid_bootstrap_response')); return; } const end = data.indexOf('\n'); if (end >= 0) { try { const result = JSON.parse(data.slice(0, end)); detach(); resolve(result); } catch { detach(); reject(new Error('debug_invalid_bootstrap_response')); } } });
      child.once('exit', () => { if (!data.includes('\n')) { detach(); reject(new Error('debug_worker_exited: inspect receipt ' + receiptPath)); } });
    });
    child.stdin.on('error', () => {}); // Exit before bootstrap is reported by the process/receipt, never raw pipe text.
    // Private parent/child bootstrap. No secrets in args, environment, files, stdout or journal.
    child.stdin.end(bootstrap + '\n');
    bootstrap = ''; privateValues.fill(''); privateValues = [];
    const result = { ...await initial, sessionId, receiptPath, ...(modelScopeEvidence ? { modelScopeEvidence } : {}), ...(appUser ? { appUser: appUserSummary(appUser) } : {}) };
    if (!result.ok && fs.existsSync(receiptPath)) {
      const terminal = read(receiptPath);
      if (terminal.sessionId === sessionId && terminal.lane === lane && ['stopped', 'stop-uncertain'].includes(terminal.state))
        Object.assign(result, { state: terminal.state, ...debugSessionDiagnostic(terminal) });
    }
    // The worker writes its final receipt before reporting a failed start; a definite rejection (state stopped) leaves nothing on the server.
    if (!result.ok && fs.existsSync(receiptPath) && read(receiptPath).state === 'stopped') {
      privateInspections.get(sessionId)?.close();privateInspections.delete(sessionId);
      fs.unlinkSync(lock); if (appUser && !redactionOnly) await releaseAppUser(appUser).catch(() => {});
      // The worker's read-only preflight failed before StartDebugSession: no native session can exist.
      if (result.transport?.startOutcome === 'not-attempted' && result.transport.tokenObtained === false &&
          /^debug_start_unreachable:preflight(?::[A-Za-z0-9_]{1,80})?$/.test(result.startError ?? '')) Object.assign(result, { knownNotStarted: true, uncertain: false });
    }
    // A failed native start names its cause, the next step and the receipt read, never a bare private code (C05).
    return nativeFailure(result, input);
  } catch (error) {
    privateInspections.get(sessionId)?.close();privateInspections.delete(sessionId);
    if (!spawned) {
      const phase = authority && tokenRequested ? (services.authOperationPhase ?? authOperationPhase)(authority.request.operationId) : null;
      if (tokenRequested && o11TokenFailureIsUncertain(error, phase)) {
        const result = { ok: false, state: 'token-uncertain', error: safeO11Error(error), sessionId, lane, receiptPath,
          o11Auth: manifest.o11Auth, ...(appUser ? { appUser: appUserSummary(appUser) } : {}) };
        write(receiptPath, result);
        return result; // No child exists, but the token operation and target lock must be reconciled.
      }
      // No worker exists and the token exchange, if attempted, is terminal.
      // Return that evidence to the runner instead of losing it in a thrown
      // transport error, which the runner must conservatively treat as uncertain.
      const result = { ok: false, state: 'not-started', sessionId, lane, receiptPath,
        workerStarted: false, uncertain: false,
        error: debugFailureCode(error?.message) ?? 'debug_local_start_failed' };
      write(receiptPath, result); fs.unlinkSync(lock); if (appUser && !redactionOnly) await releaseAppUser(appUser).catch(() => {});
      // A refused app-user sign-in ran nothing: the answer keeps this not-started shape for the runner and gains the
      // structured failure (DEBUG_APP_USER_SIGN_IN_FAILED: user, provider, environment, next, continuation; C05).
      const failure = signInFailureOf(error, { lane, runtimeUrl, tenant: input.tenant }, { tool: 'ssam_debug', arguments: repeatArguments(input) });
      return failure ? { ...result, ...failure } : result;
    }
    throw error;
  } finally {
    token = null; soapUser = null; soapSecret = null; bootstrap = '';
    privateValues.fill(''); privateValues = [];
  }
}
// Watch decorates native results only. It does not select an app user's request or execute application logic.
function watchResult(result, manifest) {
  if (manifest.anonymousInspection || manifest.backgroundInspection) return { ...result, contextMode: manifest.backgroundInspection ? 'native-background' : 'anonymous',
    requestOwnershipProved: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false,
    valuesComplete: false, executionCompleted: false };
  if (manifest.mode !== 'watch') return result;
  const count = result.trace?.count ?? 0, steps = result.trace?.steps ?? manifest.trace?.steps;
  const state = result.state === 'stopped' ? 'stopped'
    : ['stop-uncertain', 'token-uncertain', 'starting', 'authenticating-debugger', 'unknown'].includes(result.state) ? 'uncertain'
    : result.ok !== true || result.state !== 'connected' ? 'not-watching'
    : Number.isFinite(steps) && count >= steps ? 'trace-limit-reached'
    : count > 0 ? 'tracing' : 'waiting-for-app-use';
  return { ...result, mode: 'watch', ...(manifest.backgroundWatch || manifest.anonymousWatch ? {
    contextMode: manifest.anonymousWatch ? 'anonymous' : 'native-background',
    requestOwnershipProved: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false,
    valuesComplete: false, executionCompleted: false } : {}), watch: { state, seconds: manifest.seconds,
    automaticInvocation: false, userRequestIsolationProved: false, appRequestIdentityProved: false } };
}
export async function sessionCommand(input, services = {}) {
  const manifest = read(path.join(services.sessionRoot ?? sessionRoot, input.sessionId, 'manifest.json'));
  if (input.lane && input.lane !== manifest.lane) throw new Error('debug_session_lane_mismatch');
  // Anonymous/background observations only evaluate the original action roots selected by the runner.
  // Never turn their session id into an unrestricted manual variables/stepping capability.
  if (manifest.backgroundWatch && !manifest.backgroundInspection && !['status', 'stop'].includes(input.op)) throw new Error('debug_' + manifest.lane + '_background_watch_command_invalid');
  if ((manifest.anonymousWatch || manifest.backgroundInspection) && !['status', 'stop'].includes(input.op)) {
    const boundInspection = manifest.anonymousInspection ?? manifest.backgroundInspection;
    const allowed = ['scope','read','private-read','read-many','read-frame','expand','refresh','frame','continue','step-into','step-over','step-out','pause','bind-scope'];
    if (!boundInspection || !allowed.includes(input.op)) throw new Error('debug_o11_anonymous_watch_command_invalid');
    if (input.op === 'bind-scope' && (input.scopeUpdate.moduleKey !== boundInspection.moduleKey ||
        input.scopeUpdate.sourceSha256 !== boundInspection.sourceSha256)) throw new Error('debug_o11_anonymous_inspection_scope_invalid');
  }
  let result,privateCleanup;
  const privateInspection=privateInspections.get(input.sessionId);
  if(input.op==='private-read' && !privateInspection)throw new Error('debug_server_private_inspection_owner_unavailable');
  // Revoke before a control can execute, including when its reply is lost.
  if(['frame','continue','step-into','step-over','step-out','bind-scope'].includes(input.op))privateCleanup=privateInspection?.invalidate();
  if(input.op==='stop')privateCleanup=privateInspection?.close();
  try { result = await (services.pipeRequest ?? pipeRequest)(input.sessionId, { op: input.op, threadId: input.threadId, eventId: input.eventId, frame: input.frame, depth: input.depth, paths: input.paths,
    ...(input.reference ? { reference: input.reference } : {}), ...(input.childPath ? { childPath: input.childPath } : {}),
    ...(input.references ? { references: input.references } : {}),
    ...(input.op === 'bind-scope' ? { scopeUpdate: input.scopeUpdate } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.textOffset !== undefined ? { textOffset: input.textOffset } : {}), ...(input.textLimit !== undefined ? { textLimit: input.textLimit } : {}),
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}) }); }
  catch (error) {
    // A worker that expired or exited leaves its final state in the receipt: status and stop answer from it and
    // release the target lock. Execution commands and uncertain (timed-out) pipe results are never masked by the receipt.
    const unreachable = error.message === 'debug_session_unreachable';
    if (input.op !== 'status' && !(input.op === 'stop' && unreachable)) throw error;
    result = fs.existsSync(manifest.receiptPath) ? read(manifest.receiptPath) : { ok: false, state: 'unknown', error: 'debug_session_unreachable' };
    if (['authenticating-debugger', 'token-uncertain'].includes(result.state)) result = { ...result, ok: false, error: result.error ?? 'debug_o11_token_exchange_uncertain' };
    else if (result.state === 'starting') result = { ...result, ok: false, error: 'debug_start_uncertain' };
    else if (input.op === 'stop' && result.state !== 'stopped' && result.state !== 'stop-uncertain') result = { ...result, ok: false, error: 'debug_session_unreachable' };
  }
  if(input.op==='private-read' && result.ok===true)result=privateInspection.read(result,input);
  if(['stopped','stop-uncertain'].includes(result.state))privateCleanup=privateInspection?.close();
  if(!privateInspection && manifest.privateInspectionEnabled && ['stopped','stop-uncertain'].includes(result.state))
    privateCleanup={completed:false,pending:null,ownerAvailable:false};
  if(privateCleanup)result={...result,privateInspectionCleanup:privateCleanup,
    ...(privateCleanup.completed?{}:{ok:false,error:'debug_private_inspection_cleanup_failed'})};
  if (result.state === 'stopped') {
    if (fs.existsSync(manifest.lock) && read(manifest.lock).sessionId === input.sessionId) fs.unlinkSync(manifest.lock);
    const released = !manifest.appUser || manifest.appUserBorrowed ? { ok: true } : await (services.releaseAppUser ?? releaseDebugAppUser)(manifest.appUser).catch(() => ({ ok: false }));
    if (manifest.appUser) result = { ...result, credentialCleanup: { state: manifest.appUserBorrowed ? 'runner-owned' : released.ok ? 'released' : 'uncertain' } };
  }
  if (manifest.appUser) result = { ...result, appUser: result.state === 'stopped'
    ? { state: result.credentialCleanup.state === 'runner-owned' ? 'runner-owned' : result.credentialCleanup.state === 'released' ? 'released' : 'cleanup-uncertain', authenticated: false } : appUserSummary(manifest.appUser) };
  return watchResult({ ...result, ...(manifest.modelScopeEvidence ? { modelScopeEvidence: manifest.modelScopeEvidence } : {}) }, manifest);
}
// Embedding API only: validate the live native stop/frame before privately
// consuming the snapshot. Callback return values never enter a public result.
export async function consumeServerPrivateInspection({sessionId,threadId,eventId,descriptor},consumer,services={}) {
  sessionIdSchema.parse(sessionId);
  const channel=privateInspections.get(sessionId);
  if(!channel)throw new Error('debug_server_private_inspection_owner_unavailable');
  const current=await sessionCommand({op:'scope',sessionId,threadId,eventId},services);
  if(current.ok!==true || !current.context)throw new Error('debug_server_private_inspection_stale_stop');
  return channel.consume(descriptor,current.context,consumer);
}
// Private coordinator operation. It is deliberately absent from debugSchema,
// CLI and MCP arguments; addresses come from the pinned native model reader.
export async function bindServerInspectionScope({ sessionId, threadId, eventId, scopeUpdate }, services = {}) {
  sessionIdSchema.parse(sessionId);
  const { inspectionSchema, inspectionScopeSchema } = await import('./debug.mjs');
  const { variables, generation, frame, previousNodeKey, ...identity } = scopeUpdate;
  inspectionScopeSchema.parse(identity); inspectionSchema.parse({ variables });
  if (previousNodeKey != null && !/^[A-Za-z0-9_+]{22}$/.test(previousNodeKey)) throw new Error('debug_invalid_inspection_scope');
  if (!Number.isInteger(generation) || generation < 1 || !Number.isInteger(frame) || frame < 0 || frame > 100 ||
      typeof threadId !== 'string' || !threadId || !/^\d+$/.test(eventId)) throw new Error('debug_invalid_inspection_scope');
  return sessionCommand({ op: 'bind-scope', sessionId, threadId, eventId, scopeUpdate }, services);
}
// internal.privateCompare: the public session's compare session (server-session coordinator only, never a public argument).
export async function headlessDebug(raw, { appUser, services = {}, redactionOnly = false, backgroundWatch = false, anonymousWatch = false, contextMode, odcProducerTrace, anonymousInspection, backgroundInspection, additionalO11Session = false } = {}, { privateCompare } = {}) {
  const parsed = debugSchema.parse(raw);
  const input = parsed.op === 'watch' ? { ...parsed, trace: parsed.trace ?? traceSchema.parse({}) } : parsed;
  if (privateCompare !== undefined && (input.op !== 'start' || typeof privateCompare?.member !== 'function' || typeof privateCompare.compare !== 'function'))
    throw new Error('debug_server_private_compare_binding_invalid');
  if (additionalO11Session) {
    // Internal coordinator capability, never a public argument. Only the exact
    // authenticated entry binding may borrow the runner's redaction lease.
    if (additionalO11Session !== true || input.op !== 'start' || input.lane !== 'o11' || redactionOnly !== true ||
        !appUser || !sessionIdSchema.safeParse(appUser.binding?.sessionId).success || !input.o11Auth || input.o11Auth.entry ||
        input.credentials || input.autoContinue !== false || !input.inspection || input.trace ||
        backgroundWatch || anonymousWatch || contextMode !== undefined || odcProducerTrace || anonymousInspection || backgroundInspection ||
        !sameAppUserTarget(appUser.binding, appUserBinding(input, appUser.binding.sessionId)))
      throw new Error('debug_o11_additional_session_binding_invalid');
  }
  if (odcProducerTrace) {
    try {
      if (input.op !== 'start' || input.lane !== 'odc' || !appUser || redactionOnly !== true || backgroundWatch || anonymousWatch ||
          !validateOdcProducerRedaction(input, appUser.binding, odcProducerTrace)) throw new Error('debug_odc_producer_redaction_binding_invalid');
    } catch (error) {
      // This gate precedes start(), authentication, mutex acquisition and worker
      // creation. Preserve that certainty instead of reporting an unknown start.
      return { ok: false, state: 'not-started', failurePhase: 'producer-preflight',
        error: debugFailureCode(error?.message) ?? 'debug_odc_producer_redaction_binding_invalid' };
    }
  }
  // Internal original-entry observer only. The debugger authenticates with Studio SSO; no app identity is invented.
  // The native-entry runner derives these roots from the published endpoint/Timer action. Keep values in that
  // action alone; both full and diagnostic captures still use the worker's unchanged DebugPolicy.
  const observerScopes = Object.entries(input.trace?.scopes ?? {});
  const observer = anonymousWatch === true && backgroundWatch === false && contextMode === 'anonymous' ||
    backgroundWatch === true && anonymousWatch === false && contextMode === 'native-background';
  const observerAuthority = input.lane === 'o11' ? !!input.o11Auth && !input.o11Auth.entry
    : input.lane === 'odc' && !input.o11Auth && (backgroundWatch === true && anonymousWatch === false ||
      anonymousWatch === true && backgroundWatch === false && !!anonymousInspection);
  if (anonymousInspection || backgroundInspection) {
    const binding = anonymousInspection ?? backgroundInspection, sources = input.inspection?.sources ?? [], scopes = input.inspection?.scopes ?? [];
    const functions = binding.functionKeys ?? [binding.functionKey];
    if (!observer || !observerAuthority || !['o11', 'odc'].includes(input.lane) || !!anonymousInspection === !!backgroundInspection || (anonymousInspection ? !anonymousWatch || backgroundWatch : !backgroundWatch || anonymousWatch) || appUser || redactionOnly || input.credentials ||
        input.op !== 'start' || input.autoContinue !== false || input.trace || !input.inspection || input.paths?.length ||
        binding.moduleKey !== input.moduleKey || !/^[A-Za-z0-9_+]{22}$/.test(binding.functionKey ?? '') || !/^[a-f0-9]{64}$/.test(binding.sourceSha256 ?? '') ||
        !Array.isArray(functions) || !functions.length || functions.length > 20 ||
        functions.some(key => !/^[A-Za-z0-9_+]{22}$/.test(key)) || !functions.includes(binding.functionKey) ||
        sources.length !== 1 || sources[0].moduleKey !== binding.moduleKey || sources[0].sourceSha256 !== binding.sourceSha256 || !scopes.length ||
        scopes.some(s => s.moduleKey !== binding.moduleKey || !functions.includes(s.functionKey) || s.sourceSha256 !== binding.sourceSha256) ||
        input.inspection.variables.some(v => v.moduleKey !== binding.moduleKey || v.sourceSha256 !== binding.sourceSha256))
      throw new DebugInspectionPreflightError();
  }
  if (!anonymousInspection && !backgroundInspection && (backgroundWatch || anonymousWatch || contextMode !== undefined) && (!observer ||
      input.op !== 'watch' || !observerAuthority || appUser || redactionOnly || input.credentials ||
      input.trace?.mode !== 'step' || !input.trace?.focusFunctionKey || input.trace.focusFunctionKey !== input.trace.requireFunctionKey ||
      input.autoContinue !== true || (input.paths?.length ?? 0) !== 0 ||
      (input.trace.fullValues ? observerScopes.length !== 1 : observerScopes.length !== 0) ||
      observerScopes.some(([key, roots]) => key !== input.trace.focusFunctionKey || new Set(roots).size !== roots.length ||
        roots.some(root => !/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(root)))))
    throw new Error(anonymousWatch ? 'debug_o11_anonymous_watch_context_invalid' : 'debug_' + input.lane + '_background_watch_context_invalid');
  const began = new Date().toISOString(); let result;
  try {
    result = ['start', 'watch'].includes(input.op) ? await start(input, appUser, services, redactionOnly, backgroundWatch, anonymousWatch, odcProducerTrace, anonymousInspection, backgroundInspection, additionalO11Session, privateCompare) : await sessionCommand(input, services);
    if (anonymousInspection || backgroundInspection) result = watchResult(result, { anonymousInspection, backgroundInspection });
    if (input.op === 'watch') result = watchResult(result, { mode: 'watch', trace: input.trace, seconds: input.seconds, backgroundWatch, anonymousWatch });
    return result;
  } finally {
    const journal = services.journal ?? (await import('./lib.mjs')).journal;
    journal({ start: began, tool: 'ssam_debug', command: input.op, module: input.module, outcome: result?.ok ? 'ok' : 'failed-or-uncertain', note: result?.sessionId ?? input.sessionId });
  }
}

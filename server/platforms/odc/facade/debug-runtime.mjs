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
const exec = promisify(execFile);
const sessionRoot = path.join(workspaceRoot, '.local', 'debugger');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); }
const o11AuthRoot = path.join(sessionRoot, 'o11-auth');
const safeO11Error = error => /^debug_o11_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_o11_token_exchange_unavailable';
// Private host-to-worker data only. This is redaction evidence, never app authorization or public output.
export async function privateAppUserValues(descriptor, binding, { vault = privateAppUserVault, now = Date.now } = {}) {
  const validExpiry = value => Number.isFinite(Date.parse(value)) && Date.parse(value) > now();
  const nonempty = (value, max = 65536) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(descriptor?.credentialRef ?? '') ||
      !sameAppUserTarget(descriptor?.binding, binding) || !validExpiry(descriptor?.expiresAt)) throw new Error('debug_app_user_scope_mismatch');
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
// Producer-module trace: the entry (and its app user) lives in a consumer module, the breakpoint in its producer.
// The consumer's descriptor is accepted as redaction evidence only: its vault record feeds the same privateValues as
// the same-module path, it never authorizes the session (native SSO is per producer module) and never opens a prompt.
// Only the in-process native-entry runner passes `appUserEntry`; CLI and MCP calls have no such context.
export const O11_CROSS_MODULE_REDACTION = true;
export function appUserRedactionBinding(input, sessionId, supplied, entry) {
  const binding = appUserBinding(input, sessionId);
  if (!entry) return binding;
  const consumer = appUserBinding({ lane: input.lane, runtimeUrl: new URL(input.runtimeUrl).origin + '/' + entry.module + '/',
    module: entry.module, moduleKey: entry.moduleKey }, sessionId);
  if (input.lane !== 'o11' || !input.o11Auth || !supplied || consumer.module === binding.module || consumer.moduleKey === binding.moduleKey ||
      !sameAppUserTarget(supplied.binding, consumer)) throw new Error('debug_app_user_scope_mismatch');
  return consumer;
}
async function odcDebugToken(input) {
  const { portalBridge, tenantOf } = await import('./lib.mjs');
  const { host, tenant } = tenantOf(input.tenant), { bridge } = await portalBridge(host, tenant);
  const live = await bridge.execute('portfolio-api-v2:get:/environments', {}, 'read');
  const rows = Array.isArray(live.data) ? live.data : live.data?.results;
  if (!live.ok || !rows?.some(e => [e.builtinDomain, e.defaultDomain].includes(new URL(input.runtimeUrl).hostname))) throw new Error('debug_runtime_not_in_tenant');
  return bridge.auth.getToken();
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
  if (input.lane !== 'o11' || !input.o11Auth || url.port || !['/' + input.module, '/' + input.module + '/'].includes(url.pathname))
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
// The public arguments of the same start (a continuation repeats them once the user can sign in); nothing private.
const repeatArguments = input => Object.fromEntries(['op', 'lane', 'tenant', 'module', 'moduleKey', 'runtimeUrl', 'nodeKeys', 'paths', 'seconds', 'o11Auth', 'credentials']
  .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
async function start(input, suppliedAppUser, services = {}, appUserEntry = null) {
  const { lane, module, moduleKey, runtimeUrl, nodeKeys, seconds, pauseSeconds, autoContinue, paths, credentials } = input;
  // An O11 start with no developer sign-in at all (no o11Auth, no credentials file, no SSAM_O11_*) would open the app
  // user window and then fail natively; it is refused first, with the call that has the Studio SSO (C05).
  if (lane === 'o11' && !input.o11Auth && !credentials && !(services.legacyDeveloperAuth ?? legacyDeveloperAuth)())
    return developerAuthRequired(input);
  const debugRoot = services.sessionRoot ?? sessionRoot;
  const releaseAppUser = services.releaseAppUser ?? releaseDebugAppUser;
  const sessionId = suppliedAppUser?.binding?.sessionId ?? randomUUID().replaceAll('-', '');
  // Same module: the target binding. Producer trace: the consumer binding the supplied descriptor was issued for.
  const binding = appUserRedactionBinding(input, sessionId, suppliedAppUser, appUserEntry);
  if (suppliedAppUser && (!sameAppUserTarget(suppliedAppUser.binding, binding) || !Number.isFinite(Date.parse(suppliedAppUser.expiresAt)) || Date.parse(suppliedAppUser.expiresAt) <= Date.now()))
    throw new Error('debug_app_user_scope_mismatch');
  fs.mkdirSync(debugRoot, { recursive: true });
  const targetHash = createHash('sha256').update(lane + '|' + new URL(runtimeUrl).origin.toLowerCase() + '|' + moduleKey).digest('hex');
  const lock = path.join(debugRoot, targetHash + '.lock');
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); } catch { throw new Error('debug_target_has_session: inspect the session receipt before another start: ' + lock); }
  fs.writeFileSync(descriptor, JSON.stringify({ sessionId })); fs.closeSync(descriptor);
  const dir = path.join(debugRoot, sessionId); fs.mkdirSync(dir);
  const receiptPath = path.join(dir, 'receipt.json');
  const manifest = { sessionId, lane, tenant: input.tenant, module, moduleKey, runtimeUrl, nodeKeys, lock, receiptPath,
    ...(appUserEntry ? { appUserScope: { purpose: 'redaction', module: binding.module, moduleKey: binding.moduleKey } } : {}),
    ...(input.op === 'watch' ? { mode: 'watch', trace: input.trace, seconds } : {}) };
  write(path.join(dir, 'manifest.json'), manifest);
  let spawned = false, appUser = suppliedAppUser, authority, tokenRequested = false;
  let token, soapUser, soapSecret, privateValues = [], bootstrap = '';
  try {
    if (lane === 'odc') token = await (services.getOdcDebugToken ?? odcDebugToken)(input);
    const selected = input.o11Auth ? await (services.selectedO11Studio ?? selectedO11Studio)() : null;
    const studioDir = selected?.studioDir ?? await (services.installation ?? installation)(lane);
    const dll = await (services.worker ?? worker)(lane, studioDir);
    if (!appUser) {
      const prepared = await (services.prepareAppUser ?? prepareDebugAppUser)(input, { sessionId });
      if (!prepared.ok) {
        write(receiptPath, { ...prepared, sessionId, lane }); fs.unlinkSync(lock);
        return { ...prepared, sessionId, receiptPath };
      }
      appUser = prepared.descriptor;
    }
    privateValues = await privateAppUserValues(appUser, binding, { vault: services.privateAppUserVault ?? privateAppUserVault });
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
    if (Date.parse(appUser.expiresAt) <= Date.now()) throw new Error('debug_app_user_expired');
    // Match native SSO: distinct debug bearer plus username/server-call ID token, privately over stdin.
    // The fourth SOAP argument controls exception pauses and stays false.
    bootstrap = JSON.stringify({ sessionId, runtimeUrl, module, moduleKey, nodeKeys, token, soapUser, soapSecret, credentials, privateValues, seconds, pauseSeconds, autoContinue, paths, receiptPath, ...(input.trace ? { trace: input.trace } : {}) });
    token = null; soapUser = null; soapSecret = null;
    if (bootstrap.length > 65536) throw new Error('debug_o11_bootstrap_too_large');
    const child = (services.spawn ?? spawn)('dotnet', [dll, studioDir], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); spawned = true;
    const initial = new Promise((resolve, reject) => {
      let data = ''; const timer = setTimeout(() => { detach(); reject(new Error('debug_start_uncertain: inspect receipt ' + receiptPath)); }, 40000);
      function detach() { clearTimeout(timer); child.stdout.destroy(); child.stdin.destroy(); child.unref(); }
      child.once('error', () => { spawned = false; detach(); reject(new Error('debug_worker_start_failed')); });
      child.stdout.on('data', b => { data += b; if (data.length > 1048576) { detach(); reject(new Error('debug_invalid_bootstrap_response')); return; } const end = data.indexOf('\n'); if (end >= 0) { try { const result = JSON.parse(data.slice(0, end)); detach(); resolve(result); } catch { detach(); reject(new Error('debug_invalid_bootstrap_response')); } } });
      child.once('exit', () => { if (!data.includes('\n')) { detach(); reject(new Error('debug_worker_exited: inspect receipt ' + receiptPath)); } });
    });
    child.stdin.on('error', () => {}); // Exit before bootstrap is reported by the process/receipt, never raw pipe text.
    // Private parent/child bootstrap. No secrets in args, environment, files, stdout or journal.
    child.stdin.end(bootstrap + '\n');
    bootstrap = ''; privateValues.fill(''); privateValues = [];
    const result = { ...await initial, sessionId, receiptPath, appUser: appUserSummary(appUser) };
    // The worker writes its final receipt before reporting a failed start; a definite rejection (state stopped) leaves nothing on the server.
    if (!result.ok && fs.existsSync(receiptPath) && read(receiptPath).state === 'stopped') {
      fs.unlinkSync(lock); await releaseAppUser(appUser).catch(() => {});
    }
    // A failed native start names its cause, the next step and the receipt read, never a bare private code.
    return nativeFailure(result, input);
  } catch (error) {
    if (!spawned) {
      const phase = authority && tokenRequested ? (services.authOperationPhase ?? authOperationPhase)(authority.request.operationId) : null;
      if (tokenRequested && o11TokenFailureIsUncertain(error, phase)) {
        const result = { ok: false, state: 'token-uncertain', error: safeO11Error(error), sessionId, lane, receiptPath,
          o11Auth: manifest.o11Auth, appUser: appUserSummary(appUser) };
        write(receiptPath, result);
        return result; // No child exists, but the token operation and target lock must be reconciled.
      }
      write(receiptPath, { ok: false, state: 'not-started', sessionId }); fs.unlinkSync(lock); await releaseAppUser(appUser).catch(() => {});
      // A refused app-user sign-in ran nothing: the answer says which user, provider and environment, and the next step.
      const failure = signInFailureOf(error, { lane, runtimeUrl, tenant: input.tenant }, { tool: 'ssam_debug', arguments: repeatArguments(input) });
      if (failure) return { ...failure, sessionId, receiptPath };
    }
    throw error;
  } finally {
    token = null; soapUser = null; soapSecret = null; bootstrap = '';
    privateValues.fill(''); privateValues = [];
  }
}
// Watch decorates native results only. It does not select an app user's request or execute application logic.
function watchResult(result, manifest) {
  if (manifest.mode !== 'watch') return result;
  const count = result.trace?.count ?? 0, steps = result.trace?.steps ?? manifest.trace?.steps;
  const state = result.state === 'stopped' ? 'stopped'
    : ['stop-uncertain', 'token-uncertain', 'starting', 'authenticating-debugger', 'unknown'].includes(result.state) ? 'uncertain'
    : result.ok !== true || result.state !== 'connected' ? 'not-watching'
    : Number.isFinite(steps) && count >= steps ? 'trace-limit-reached'
    : count > 0 ? 'tracing' : 'waiting-for-app-use';
  return { ...result, mode: 'watch', watch: { state, seconds: manifest.seconds,
    automaticInvocation: false, userRequestIsolationProved: false, appRequestIdentityProved: false } };
}
export async function sessionCommand(input, services = {}) {
  const manifest = read(path.join(services.sessionRoot ?? sessionRoot, input.sessionId, 'manifest.json'));
  if (input.lane && input.lane !== manifest.lane) throw new Error('debug_session_lane_mismatch');
  let result;
  try { result = await (services.pipeRequest ?? pipeRequest)(input.sessionId, { op: input.op, threadId: input.threadId, eventId: input.eventId, frame: input.frame, depth: input.depth, paths: input.paths }); }
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
  if (result.state === 'stopped') {
    if (fs.existsSync(manifest.lock) && read(manifest.lock).sessionId === input.sessionId) fs.unlinkSync(manifest.lock);
    const released = await (services.releaseAppUser ?? releaseDebugAppUser)(manifest.appUser).catch(() => ({ ok: false }));
    if (manifest.appUser) result = { ...result, credentialCleanup: { state: released.ok ? 'released' : 'uncertain' } };
  }
  if (manifest.appUser) result = { ...result, appUser: result.state === 'stopped'
    ? { state: result.credentialCleanup.state === 'released' ? 'released' : 'cleanup-uncertain', authenticated: false } : appUserSummary(manifest.appUser) };
  return watchResult(result, manifest);
}
export async function headlessDebug(raw, { appUser, appUserEntry, services = {} } = {}) {
  const parsed = debugSchema.parse(raw);
  const input = parsed.op === 'watch' ? { ...parsed, trace: parsed.trace ?? traceSchema.parse({}) } : parsed;
  const began = new Date().toISOString(); let result;
  try {
    result = ['start', 'watch'].includes(input.op) ? await start(input, appUser, services, appUserEntry) : await sessionCommand(input, services);
    if (input.op === 'watch') result = watchResult(result, { mode: 'watch', trace: input.trace, seconds: input.seconds });
    return result;
  } finally {
    const journal = services.journal ?? (await import('./lib.mjs')).journal;
    journal({ start: began, tool: 'ssam_debug', command: input.op, module: input.module, outcome: result?.ok ? 'ok' : 'failed-or-uncertain', note: result?.sessionId ?? input.sessionId });
  }
}

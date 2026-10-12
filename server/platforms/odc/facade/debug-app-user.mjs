// App credentials are collected by a native dialog and opened only by the private authentication worker.
// Public callers receive an opaque, exact-target session descriptor; no password, cookie or token is returned.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { debugStateBase, legacyDebugStateRoots } from './debug-state-root.mjs';

const helper = fileURLToPath(new URL('./debug-app-user-vault.ps1', import.meta.url));
const worker = fileURLToPath(new URL('./debug-app-user-worker.mjs', import.meta.url));
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{32}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,198}$/;
const KEY = /^[A-Za-z0-9_+]{22}$/;
const failure = code => { throw new Error(code); };

export function appUserBinding(input, sessionId = randomUUID().replaceAll('-', '')) {
  let url; try { url = new URL(input.runtimeUrl); } catch { failure('debug_app_user_invalid_target'); }
  const app = url.pathname.split('/').filter(Boolean)[0];
  if (!['odc', 'o11'].includes(input.lane) || !ID.test(sessionId) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !NAME.test(app ?? '') || !NAME.test(input.module ?? '') || !KEY.test(input.moduleKey ?? '') || ![ '/' + app, '/' + app + '/' ].includes(url.pathname)) failure('debug_app_user_invalid_target');
  return { lane: input.lane, runtimeUrl: url.origin + '/' + app + '/', app, sessionId, module: input.module, moduleKey: input.moduleKey };
}

export function sameAppUserTarget(left, right) {
  return ['lane', 'runtimeUrl', 'app', 'sessionId', 'module', 'moduleKey'].every(key => left?.[key] === right?.[key]);
}

// Endpoint credential for a qualified Custom REST OnAuthentication. Header names come from
// the published contract; their values exist only in the private dialog and vault record.
// scheme 'basic' (RFC 7617) binds the Authorization header to a username/password record; the
// header scheme carries no scheme field, so its bindings and records stay byte-compatible.
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
export function endpointCredentialBinding(input, sessionId = randomUUID().replaceAll('-', '')) {
  const scheme = input?.scheme === 'header' ? undefined : input?.scheme, headers = scheme === 'basic' ? input.headers ?? ['Authorization'] : input?.headers;
  if (!Number.isSafeInteger(input?.revision) || input.revision < 1 || !KEY.test(input.serviceKey ?? '') || !Array.isArray(headers) ||
      !headers.length || headers.length > 8 || headers.some(name => typeof name !== 'string' || !HEADER.test(name)) ||
      new Set(headers.map(name => name.toLowerCase())).size !== headers.length || input.use !== undefined ||
      ![undefined, 'basic'].includes(scheme) || scheme === 'basic' && (headers.length !== 1 || headers[0] !== 'Authorization')) failure('debug_app_user_endpoint_credential_invalid_target');
  let base; try { base = appUserBinding(input, sessionId); } catch { failure('debug_app_user_endpoint_credential_invalid_target'); }
  return { ...base, revision: input.revision, serviceKey: input.serviceKey, headers: [...headers], ...(scheme ? { scheme } : {}) };
}

export function sameEndpointCredentialTarget(left, right) {
  return sameAppUserTarget(left, right) && left.revision === right.revision && left.serviceKey === right.serviceKey &&
    left.scheme === right.scheme && left.use === undefined && right.use === undefined &&
    Array.isArray(left.headers) && Array.isArray(right.headers) && left.headers.length === right.headers.length &&
    left.headers.every((name, i) => name === right.headers[i]);
}

// Explicit endpoint profile key. A profile is written or read only on an explicit remember/resolve request.
export function endpointProfileKey(binding) {
  let safe; try { safe = endpointCredentialBinding(binding, binding?.sessionId); } catch { failure('debug_app_user_endpoint_credential_invalid_target'); }
  return [safe.lane, safe.runtimeUrl, safe.module, safe.serviceKey, safe.scheme ?? 'header'].join('|');
}

// Redaction-only record (same vault family, use:'redact-only'): user-typed values used solely to redact
// frames and to prove receipts clean. Bound to the run's revision and session; no worker sends it.
const ROLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export function redactionSecretBinding(input, sessionId = randomUUID().replaceAll('-', '')) {
  const roles = input?.roles;
  if (![undefined, 'redact-only'].includes(input?.use) || !Number.isSafeInteger(input?.revision) || input.revision < 1 || !Array.isArray(roles) ||
      !roles.length || roles.length > 8 || roles.some(role => typeof role !== 'string' || !ROLE.test(role)) ||
      new Set(roles.map(role => role.toLowerCase())).size !== roles.length || ['serviceKey', 'headers', 'scheme'].some(key => input[key] !== undefined))
    failure('debug_app_user_redaction_secret_invalid_target');
  let base; try { base = appUserBinding(input, sessionId); } catch { failure('debug_app_user_redaction_secret_invalid_target'); }
  return { ...base, revision: input.revision, use: 'redact-only', roles: [...roles] };
}

export function sameRedactionSecretTarget(left, right) {
  return sameAppUserTarget(left, right) && left.revision === right.revision && left.use === 'redact-only' && right.use === 'redact-only' &&
    left.serviceKey === undefined && right.serviceKey === undefined && Array.isArray(left.roles) && Array.isArray(right.roles) &&
    left.roles.length === right.roles.length && left.roles.every((role, i) => role === right.roles[i]);
}

// Saved profiles written before the debugger state root existed resolve read only from every legacy copy.
const legacyProfiles = () => { try { return legacyDebugStateRoots('app-user-profiles').filter(r => !r.unreadable).map(({ origin, path }) => ({ origin, path })); } catch { return []; } };

// Used only inside this host's private processes. Do not call read/seal-session through MCP or print their result.
// The helper stores under the debugger state root (-StateRoot, debug-state-root.mjs); legacy copies are never written.
export function privateAppUserVault(mode, input, { spawnImpl = spawn, timeoutMs = ['prompt', 'prompt-endpoint'].includes(mode) ? 300000 : 15000, legacyProfileRoots } = {}) {
  if (!['prompt', 'prompt-endpoint', 'read', 'seal-session', 'forget', 'import-profile', 'remember-profile', 'resolve-profile', 'remember-environment-profile', 'resolve-environment-profile',
    'remember-endpoint-profile', 'resolve-endpoint-profile', 'forget-endpoint-profile'].includes(mode)) failure('debug_app_user_invalid_operation');
  const interactive = mode === 'prompt' || mode === 'prompt-endpoint';
  let stateRoot; try { stateRoot = debugStateBase(); } catch { return Promise.reject(new Error('debug_app_user_credentials_unavailable')); }
  if (mode === 'resolve-profile' || mode === 'resolve-environment-profile') input = { ...input, legacyProfileRoots: legacyProfileRoots ?? legacyProfiles() };
  return new Promise((resolve, reject) => {
    // The helper exceeds Windows' command-line limit when embedded as UTF-16 base64.
    // Only the trusted script path and public mode belong in argv; private input stays on stdin.
    // SW_HIDE supplied by CreateProcess also suppresses the first WinForms window.
    // Hide the PowerShell console itself for an interactive prompt instead.
    const args = ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    if (interactive) args.push('-WindowStyle', 'Hidden');
    args.push('-File', helper, '-StateRoot', stateRoot, '-Mode', mode);
    const child = spawnImpl('powershell.exe', args, {
      windowsHide: !interactive, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', settled = false, timedOut = false, outputOverflow = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); output = '';
      const code = interactive && timedOut && !outputOverflow ? 'debug_app_user_prompt_timeout' : 'debug_app_user_credentials_unavailable';
      error ? reject(new Error(code)) : resolve(result);
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', () => finish(true)); child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 1048576) { outputOverflow = true; output = ''; child.kill(); } });
    child.once('close', code => {
      if (timedOut || outputOverflow) { finish(true); return; }
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '')); output = '';
        if (code !== 0 || result.ok !== true && result.cancelled !== true) finish(true);
        else finish(false, result);
      } catch { finish(true); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// The authentication/invocation process reads the vault privately; only its safe public result crosses this pipe.
export function appUserWorker(op, input, { spawnImpl = spawn, timeoutMs = 120000 } = {}) {
  if (!['authenticate', 'invoke'].includes(op)) failure('debug_app_user_invalid_operation');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [worker, op], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(new Error('debug_app_user_worker_unavailable')) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(true); }, timeoutMs);
    child.once('error', () => finish(true)); child.stdin.on('error', () => {}); child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 4194304) { child.kill(); finish(true); } });
    child.once('close', code => {
      try { const result = JSON.parse(output); output = ''; code === 0 && typeof result.ok === 'boolean' ? finish(false, result) : finish(true); }
      catch { finish(true); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function descriptorOf(record, binding) {
  if (!GUID.test(record.credentialRef ?? '') || !sameAppUserTarget(record.binding, binding) || !Number.isFinite(Date.parse(record.expiresAt))) failure('debug_app_user_scope_mismatch');
  return { credentialRef: record.credentialRef, binding, expiresAt: record.expiresAt };
}

export async function releaseDebugAppUser(descriptor, { vault = privateAppUserVault } = {}) {
  if (!descriptor) return { ok: true };
  const safe = descriptorOf(descriptor, descriptor.binding);
  return vault('forget', safe);
}

export function armExpiry(descriptor, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [worker, 'expire'], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = failed => { if (settled) return; settled = true; child.unref(); failed ? reject(new Error('debug_app_user_expiry_unavailable')) : resolve(); };
    child.once('error', () => finish(true)); child.stdin.once('error', () => finish(true));
    child.once('spawn', () => child.stdin.end(JSON.stringify(descriptor), () => finish(false)));
  });
}

export async function prepareDebugAppUser(input, { vault = privateAppUserVault, authenticate = appUserWorker, expire = armExpiry, sessionId, selectedProfile } = {}) {
  const binding = appUserBinding(input, sessionId), ttlSeconds = Math.max(30, Math.min(600, input.seconds ?? 120));
  // Know the reference before showing the dialog so an interrupted helper can always be cleaned up.
  const credentialRef = randomUUID(), provisional = { credentialRef, binding, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  let descriptor = provisional, userHint = null;
  try {
    // Exact app selection takes precedence over an explicitly authorized
    // environment selection. Import still binds credentials to this exact run.
    if (!selectedProfile && vault === privateAppUserVault) {
      let saved = await vault('resolve-profile', { binding, credentialRef });
      if (saved.found !== true)
        saved = await vault('resolve-environment-profile', { binding, credentialRef });
      if (saved.found === true) selectedProfile = { lane: binding.lane, runtimeUrl: binding.runtimeUrl,
        host: saved.profileHost, target: saved.profileTarget, appUserAuthorized: true };
    }
    // Private integration option only. No automatic promotion of a Studio/Portal
    // identity to app-user; an explicitly selected profile must be supplied.
    if (selectedProfile && (selectedProfile.appUserAuthorized !== true || selectedProfile.lane !== binding.lane ||
      selectedProfile.runtimeUrl !== binding.runtimeUrl || typeof selectedProfile.target !== 'string' || typeof selectedProfile.host !== 'string'))
      failure('debug_app_user_profile_scope_mismatch');
    const entered = await vault(selectedProfile ? 'import-profile' : 'prompt', { binding, ttlSeconds, credentialRef,
      ...(selectedProfile ? { profileTarget: selectedProfile.target, profileHost: selectedProfile.host } : {}) });
    if (entered.cancelled === true) {
      await releaseDebugAppUser(provisional, { vault }).catch(() => {});
      return { ok: false, state: 'cancelled', error: 'debug_app_user_cancelled' };
    }
    descriptor = descriptorOf(entered, binding);
    if (descriptor.credentialRef !== credentialRef) failure('debug_app_user_scope_mismatch');
    await expire(descriptor); // Cleanup is armed before authentication can be interrupted.
    const verified = await authenticate('authenticate', descriptor);
    // The private worker names the user it opened only masked (debug-guidance.mjs maskUser), for the answers.
    if (typeof verified?.userHint === 'string' && verified.userHint.length <= 200) userHint = verified.userHint;
    if (!verified.ok) failure(/^debug_app_user_[a-z_]+$/.test(verified.error ?? '') ? verified.error : 'debug_app_user_authentication_failed');
    if (!['authenticated', 'credentials-entered'].includes(verified.state) || !sameAppUserTarget(verified.binding, binding)) failure('debug_app_user_scope_mismatch');
    if (binding.lane === 'odc' && (verified.state !== 'authenticated' || !GUID.test(verified.userKey ?? ''))) failure('debug_app_user_authentication_failed');
    const verifiedExpiry = verified.expiresAt ? Date.parse(verified.expiresAt) : Date.parse(descriptor.expiresAt);
    if (!Number.isFinite(verifiedExpiry) || verifiedExpiry <= Date.now()) failure('debug_app_user_expired');
    const safe = { ...descriptor, expiresAt: new Date(Math.min(verifiedExpiry, Date.parse(descriptor.expiresAt))).toISOString(), state: verified.state, authenticated: verified.state === 'authenticated',
      ...(verified.userKey ? { userKey: verified.userKey } : {}), ...(userHint ? { userHint } : {}) };
    if (safe.expiresAt !== descriptor.expiresAt) await expire(safe);
    return { ok: true, credentialSource: selectedProfile ? 'selected-profile' : 'private-dialog', descriptor: safe };
  } catch (error) {
    await releaseDebugAppUser(provisional, { vault }).catch(() => {});
    // The message stays the private code; signIn says where the sign-in went, for DEBUG_APP_USER_SIGN_IN_FAILED.
    const thrown = new Error(/^debug_app_user_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_app_user_authentication_failed');
    thrown.signIn = { lane: binding.lane, runtimeUrl: binding.runtimeUrl, app: binding.app, module: binding.module, ...(userHint ? { user: userHint } : {}) };
    throw thrown;
  }
}

export async function releaseEndpointCredential(descriptor, { vault = privateAppUserVault } = {}) {
  if (!descriptor) return { ok: true };
  let binding; try { binding = endpointCredentialBinding(descriptor.binding ?? {}, descriptor.binding?.sessionId); } catch { failure('debug_app_user_scope_mismatch'); }
  if (!GUID.test(descriptor.credentialRef ?? '') || !sameEndpointCredentialTarget(binding, descriptor.binding) || !Number.isFinite(Date.parse(descriptor.expiresAt)))
    failure('debug_app_user_scope_mismatch');
  return vault('forget', { credentialRef: descriptor.credentialRef, binding, expiresAt: descriptor.expiresAt });
}

// One masked field per declared header (Basic: a username box and one masked password box), in the
// private dialog. Request JSON carries names only. profile 'resolve' first imports an explicitly
// remembered endpoint profile; profile 'remember' saves the entered record for later runs. Never implicit.
export async function prepareEndpointCredential(input, { vault = privateAppUserVault, expire = armExpiry, sessionId, profile } = {}) {
  if (['values', 'credentials', 'secrets', 'password', 'token', 'username'].some(key => Object.hasOwn(input ?? {}, key)) ||
      ![undefined, 'remember', 'resolve'].includes(profile)) failure('debug_app_user_endpoint_credential_invalid_target');
  const binding = endpointCredentialBinding(input, sessionId), ttlSeconds = Math.max(30, Math.min(600, input.seconds ?? 120));
  const credentialRef = randomUUID(), provisional = { credentialRef, binding, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  try {
    let entered = profile === 'resolve' ? await vault('resolve-endpoint-profile', { binding, ttlSeconds, credentialRef }) : null;
    const credentialSource = entered?.found === true ? 'endpoint-profile' : 'private-dialog';
    if (entered?.found !== true) entered = await vault('prompt-endpoint', { binding, ttlSeconds, credentialRef });
    if (entered.cancelled === true) {
      await releaseEndpointCredential(provisional, { vault }).catch(() => {});
      return { ok: false, state: 'cancelled', error: 'debug_app_user_cancelled' };
    }
    if (entered.ok !== true || entered.kind !== 'endpoint-credential' || entered.credentialRef !== credentialRef ||
        !sameEndpointCredentialTarget(entered.binding, binding) || !(Date.parse(entered.expiresAt) > Date.now())) failure('debug_app_user_scope_mismatch');
    const descriptor = { credentialRef, binding, expiresAt: new Date(Math.min(Date.parse(entered.expiresAt), Date.parse(provisional.expiresAt))).toISOString(),
      kind: 'endpoint-credential', state: 'credentials-entered', authenticated: false };
    await expire(descriptor); // The record is forgotten at expiry even if the runner is interrupted.
    if (profile !== 'remember' || credentialSource !== 'private-dialog') return { ok: true, credentialSource, descriptor };
    // The helper copies the entered record privately; this request carries the reference and binding only.
    const saved = await vault('remember-endpoint-profile', { binding, credentialRef }).catch(() => null);
    return { ok: true, credentialSource, descriptor, profileRemembered: saved?.ok === true && saved.remembered === true };
  } catch (error) {
    await releaseEndpointCredential(provisional, { vault }).catch(() => {});
    throw new Error(/^debug_app_user_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_app_user_endpoint_credential_unavailable');
  }
}

// Removes an explicitly remembered endpoint profile (lane|runtimeUrl|module|serviceKey|scheme).
export async function forgetEndpointProfile(input, { vault = privateAppUserVault } = {}) {
  const binding = endpointCredentialBinding(input, input?.sessionId);
  return vault('forget-endpoint-profile', { binding, credentialRef: randomUUID() });
}

export async function rememberDebugAppUserProfile(input, profile, { vault = privateAppUserVault } = {}) {
  const binding = appUserBinding(input);
  if (profile?.appUserAuthorized !== true || profile.lane !== binding.lane || profile.runtimeUrl !== binding.runtimeUrl)
    failure('debug_app_user_profile_scope_mismatch');
  return vault('remember-profile', { binding, credentialRef: randomUUID(), profileHost: profile.host, profileTarget: profile.target });
}

export async function rememberO11EnvironmentAppUserProfile(input, profile, { vault = privateAppUserVault } = {}) {
  const binding = appUserBinding(input);
  if (binding.lane !== 'o11' || profile?.lane !== 'o11' || profile.environmentAppUserAuthorized !== true ||
      profile.host !== new URL(binding.runtimeUrl).hostname)
    failure('debug_app_user_profile_scope_mismatch');
  return vault('remember-environment-profile', { binding, credentialRef: randomUUID(), profileHost: profile.host, profileTarget: profile.target });
}

export async function rememberOdcEnvironmentAppUserProfile(input, profile, { vault = privateAppUserVault } = {}) {
  const binding = appUserBinding(input);
  if (binding.lane !== 'odc' || profile?.lane !== 'odc' || profile.environmentAppUserAuthorized !== true ||
      profile.runtimeOrigin !== new URL(binding.runtimeUrl).origin ||
      typeof input.tenant !== 'string' || profile.host !== input.tenant)
    failure('debug_app_user_profile_scope_mismatch');
  return vault('remember-environment-profile', { binding, credentialRef: randomUUID(), profileHost: profile.host, profileTarget: profile.target });
}

export function appUserSummary(descriptor) {
  if (!descriptor) return null;
  const expired = !Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= Date.now();
  return { state: expired ? 'expired' : descriptor.state, authenticated: !expired && descriptor.authenticated === true, expiresAt: descriptor.expiresAt,
    ...(descriptor.userKey ? { userKey: descriptor.userKey } : {}) };
}

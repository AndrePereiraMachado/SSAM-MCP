// App credentials are collected by a native dialog and opened only by the private authentication worker.
// Public callers receive an opaque, exact-target session descriptor; no password, cookie or token is returned.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

// Used only inside this host's private processes. Do not call read/seal-session through MCP or print their result.
export function privateAppUserVault(mode, input, { spawnImpl = spawn, timeoutMs = mode === 'prompt' ? 300000 : 15000 } = {}) {
  if (!['prompt', 'read', 'seal-session', 'forget'].includes(mode)) failure('debug_app_user_invalid_operation');
  return new Promise((resolve, reject) => {
    // The helper exceeds Windows' command-line limit when embedded as UTF-16 base64.
    // Only the trusted script path and public mode belong in argv; private input stays on stdin.
    // SW_HIDE supplied by CreateProcess also suppresses the first WinForms window.
    // Hide the PowerShell console itself for an interactive prompt instead.
    const args = ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    if (mode === 'prompt') args.push('-WindowStyle', 'Hidden');
    args.push('-File', helper, '-Mode', mode);
    const child = spawnImpl('powershell.exe', args, {
      windowsHide: mode !== 'prompt', stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', settled = false, timedOut = false, outputOverflow = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); output = '';
      const code = mode === 'prompt' && timedOut && !outputOverflow ? 'debug_app_user_prompt_timeout' : 'debug_app_user_credentials_unavailable';
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

function armExpiry(descriptor, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [worker, 'expire'], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = failed => { if (settled) return; settled = true; child.unref(); failed ? reject(new Error('debug_app_user_expiry_unavailable')) : resolve(); };
    child.once('error', () => finish(true)); child.stdin.once('error', () => finish(true));
    child.once('spawn', () => child.stdin.end(JSON.stringify(descriptor), () => finish(false)));
  });
}

export async function prepareDebugAppUser(input, { vault = privateAppUserVault, authenticate = appUserWorker, expire = armExpiry, sessionId } = {}) {
  const binding = appUserBinding(input, sessionId), ttlSeconds = Math.max(30, Math.min(600, input.seconds ?? 120));
  // Know the reference before showing the dialog so an interrupted helper can always be cleaned up.
  const credentialRef = randomUUID(), provisional = { credentialRef, binding, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  let descriptor = provisional, userHint = null;
  try {
    const entered = await vault('prompt', { binding, ttlSeconds, credentialRef });
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
    return { ok: true, descriptor: safe };
  } catch (error) {
    await releaseDebugAppUser(provisional, { vault }).catch(() => {});
    // The message stays the private code; signIn says where the sign-in went, for DEBUG_APP_USER_SIGN_IN_FAILED.
    const thrown = new Error(/^debug_app_user_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_app_user_authentication_failed');
    thrown.signIn = { lane: binding.lane, runtimeUrl: binding.runtimeUrl, app: binding.app, module: binding.module, ...(userHint ? { user: userHint } : {}) };
    throw thrown;
  }
}

export function appUserSummary(descriptor) {
  if (!descriptor) return null;
  const expired = !Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= Date.now();
  return { state: expired ? 'expired' : descriptor.state, authenticated: !expired && descriptor.authenticated === true, expiresAt: descriptor.expiresAt,
    ...(descriptor.userKey ? { userKey: descriptor.userKey } : {}) };
}

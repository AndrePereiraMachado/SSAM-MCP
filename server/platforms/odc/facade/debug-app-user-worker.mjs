// Private app authentication and wrapper transport. Never expose the opened vault record on stdout.
import { pathToFileURL } from 'node:url';
import { privateAppUserVault, appUserBinding, sameAppUserTarget, endpointCredentialBinding, sameEndpointCredentialTarget,
  redactionSecretBinding, sameRedactionSecretTarget } from './debug-app-user.mjs';
import { APP_USER_HEADERS, APP_USER_FIELDS } from './debug-wrapper.mjs';
import { maskUser } from './debug-guidance.mjs';
import { createAppUserAuthDiagnostic } from './debug-app-user-diagnostic.mjs';

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const fail = code => { throw new Error(code); };

export function validatePrivateDescriptor(descriptor) {
  if (!GUID.test(descriptor?.credentialRef ?? '')) fail('debug_app_user_scope_mismatch');
  const binding = appUserBinding(descriptor.binding ?? {}, descriptor.binding?.sessionId);
  if (!sameAppUserTarget(binding, descriptor.binding) || !Number.isFinite(Date.parse(descriptor.expiresAt))) fail('debug_app_user_scope_mismatch');
  return { credentialRef: descriptor.credentialRef, binding, expiresAt: descriptor.expiresAt };
}

// Endpoint-credential descriptor: the app binding plus revision, service key and exact header names.
// A redact-only descriptor never validates here, so no endpoint worker can place it in a request.
// A sendable record carries no use; an explicit use:'send' is the same thing.
const SENDABLE = [undefined, 'send'];
export function validateEndpointCredentialDescriptor(descriptor) {
  if (!GUID.test(descriptor?.credentialRef ?? '') || !SENDABLE.includes(descriptor.use) || descriptor.binding?.use !== undefined) fail('debug_app_user_scope_mismatch');
  let binding; try { binding = endpointCredentialBinding(descriptor.binding ?? {}, descriptor.binding?.sessionId); } catch { fail('debug_app_user_scope_mismatch'); }
  if (!sameEndpointCredentialTarget(binding, descriptor.binding) || !Number.isFinite(Date.parse(descriptor.expiresAt))) fail('debug_app_user_scope_mismatch');
  return { credentialRef: descriptor.credentialRef, binding, expiresAt: descriptor.expiresAt };
}

// Redact-only descriptor: the app binding plus revision and the exact declared role names.
export function validateRedactionSecretDescriptor(descriptor) {
  if (!GUID.test(descriptor?.credentialRef ?? '') || ![undefined, 'redact-only'].includes(descriptor.use)) fail('debug_app_user_scope_mismatch');
  let binding; try { binding = redactionSecretBinding(descriptor.binding ?? {}, descriptor.binding?.sessionId); } catch { fail('debug_app_user_scope_mismatch'); }
  if (descriptor.binding?.use !== 'redact-only' || !sameRedactionSecretTarget(binding, descriptor.binding) || !Number.isFinite(Date.parse(descriptor.expiresAt))) fail('debug_app_user_scope_mismatch');
  return { credentialRef: descriptor.credentialRef, binding, expiresAt: descriptor.expiresAt };
}

// RFC 7617: the user-id holds no ':' and neither part holds a control character. Private callers only.
export function basicAuthorizationForms(username, password) {
  if (typeof username !== 'string' || !username.trim() || username.length > 512 || /[:\x00-\x1f\x7f]/.test(username) ||
      typeof password !== 'string' || !password || password.length > 4096 || /[\x00-\x1f\x7f]/.test(password)) fail('debug_app_user_credentials_unavailable');
  const b64 = Buffer.from(username + ':' + password, 'utf8').toString('base64');
  return { username, password, b64, authorization: 'Basic ' + b64 };
}

function openedEndpointRecord(record, safe, now) {
  if (!record?.ok || record.kind !== 'endpoint-credential' || !SENDABLE.includes(record.use) || record.scheme !== safe.binding.scheme ||
      !sameEndpointCredentialTarget(record.binding, safe.binding) || !(Date.parse(record.expiresAt) > now)) fail('debug_app_user_credentials_unavailable');
  return record;
}

// Private callers only: the opened record's headers, in the bound order, or a fixed refusal. A Basic record
// composes its one Authorization header here and keeps it on record.headers, where the caller's finally zeroes it.
export function endpointCredentialRecordHeaders(record, safe, now = Date.now()) {
  const names = safe.binding.headers;
  openedEndpointRecord(record, safe, now);
  if (safe.binding.scheme === 'basic') {
    if (record.headers !== undefined) fail('debug_app_user_credentials_unavailable');
    record.headers = [{ name: 'Authorization', value: basicAuthorizationForms(record.username, record.password).authorization }];
    return record.headers;
  }
  if (!Array.isArray(record.headers) || record.headers.length !== names.length ||
      record.headers.some((header, i) => header?.name !== names[i] || typeof header.value !== 'string' || !header.value ||
        header.value.length > 4096 || /[\x00-\x1f\x7f]/.test(header.value))) fail('debug_app_user_credentials_unavailable');
  return record.headers;
}

// Private callers only: every private form of an opened endpoint record (Basic: username, password, b64, 'Basic '+b64).
export function endpointCredentialRecordValues(record, safe, now = Date.now()) {
  const values = [], add = value => { if (!values.includes(value)) values.push(value); };
  openedEndpointRecord(record, safe, now);
  if (safe.binding.scheme === 'basic') { const forms = basicAuthorizationForms(record.username, record.password); for (const key of ['username', 'password', 'b64', 'authorization']) add(forms[key]); }
  else for (const header of endpointCredentialRecordHeaders(record, safe, now)) add(header.value);
  return values;
}

// Private callers only: the opened redact-only record's values, in the declared role order.
export function redactionSecretRecordValues(record, safe, now = Date.now()) {
  const roles = safe.binding.roles, values = [];
  if (!record?.ok || record.kind !== 'endpoint-credential' || record.use !== 'redact-only' || !sameRedactionSecretTarget(record.binding, safe.binding) ||
      !(Date.parse(record.expiresAt) > now) || !Array.isArray(record.secrets) || record.secrets.length !== roles.length ||
      record.secrets.some((item, i) => item?.role !== roles[i] || typeof item.value !== 'string' || !item.value || item.value.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(item.value))) fail('debug_app_user_credentials_unavailable');
  for (const item of record.secrets) if (!values.includes(item.value)) values.push(item.value);
  return values;
}

// Redaction evidence for a debugger session bound to an endpoint credential (header or Basic) or to a
// redact-only record. Never public output, never a request value for the redact-only family.
export async function privateEndpointCredentialValues(descriptor, { vault = privateAppUserVault, now = Date.now } = {}) {
  const redactOnly = descriptor?.use === 'redact-only' || descriptor?.binding?.use === 'redact-only';
  const safe = redactOnly ? validateRedactionSecretDescriptor(descriptor) : validateEndpointCredentialDescriptor(descriptor);
  if (!(Date.parse(safe.expiresAt) > now())) fail('debug_app_user_credentials_unavailable');
  let record, values = [];
  try {
    record = await vault('read', safe);
    values = (redactOnly ? redactionSecretRecordValues : endpointCredentialRecordValues)(record, safe, now());
    return values;
  } catch { values.fill(''); fail('debug_app_user_credentials_unavailable'); }
  finally {
    if (record && typeof record === 'object') {
      record.username = ''; record.password = '';
      for (const list of [record.headers, record.secrets]) if (Array.isArray(list)) for (const item of list) if (item && typeof item === 'object') item.value = '';
    }
    record = null;
  }
}

async function openRecord(descriptor, vault) {
  const safe = validatePrivateDescriptor(descriptor), record = await vault('read', safe);
  if (!record.ok || !sameAppUserTarget(record.binding, safe.binding) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) fail('debug_app_user_credentials_unavailable');
  return record;
}

// Private callers only: the native token must never be printed or returned through MCP.
export async function openOdcAppUserSession(descriptor, { vault = privateAppUserVault } = {}) {
  const safe = validatePrivateDescriptor(descriptor);
  if (safe.binding.lane !== 'odc' || Date.parse(safe.expiresAt) <= Date.now()) fail('debug_app_user_expired');
  const record = await openRecord(safe, vault), session = record.kind === 'session' ? record.session : null;
  if (!session || !sameAppUserTarget(session.binding, safe.binding) || !GUID.test(session.userKey ?? '') || !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now() || typeof session.accessToken !== 'string' || !session.accessToken || /[\x00-\x1f\x7f]/.test(session.accessToken)) fail('debug_app_user_authentication_required');
  return session;
}

// A failure that also names the user, masked (maskUser): the answers say which account could not sign in.
const failAs = (code, userHint) => { const error = new Error(code); if (userHint) error.userHint = userHint; throw error; };

export async function authenticatePrivateAppUser(descriptor, { vault = privateAppUserVault, login, diagnosticsRoot } = {}) {
  const safe = validatePrivateDescriptor(descriptor), record = await openRecord(safe, vault);
  if (record.kind !== 'credentials' || typeof record.username !== 'string' || !record.username || typeof record.password !== 'string' || !record.password) fail('debug_app_user_credentials_unavailable');
  const userHint = maskUser(record.username);
  if (safe.binding.lane === 'o11') {
    // Users.User_Login validates these credentials inside the wrapper's request before the target action.
    // A debug connection alone is never represented as app authentication.
    record.username = ''; record.password = '';
    return { ok: true, state: 'credentials-entered', binding: safe.binding, expiresAt: record.expiresAt, ...(userHint ? { userHint } : {}) };
  }
  const authenticate = login ?? (await import('./debug-app-user-odc.mjs')).authenticateOdcAppUser;
  const diagnostic = createAppUserAuthDiagnostic(safe.binding.sessionId, { root: diagnosticsRoot });
  let session;
  try { session = await authenticate({ binding: safe.binding, credentials: { username: record.username, password: record.password }, observer: diagnostic.observe }); }
  catch (error) {
    const codes = { debug_app_auth_rejected: 'debug_app_user_authentication_rejected', debug_app_auth_challenge_required: 'debug_app_user_challenge_required',
      debug_app_auth_provider_unsupported: 'debug_app_user_provider_unsupported', debug_app_auth_scope_mismatch: 'debug_app_user_scope_mismatch',
      debug_app_auth_expired: 'debug_app_user_expired', debug_app_auth_unavailable: 'debug_app_user_authentication_unavailable' };
    failAs(codes[error?.code] ?? 'debug_app_user_authentication_failed', userHint);
  }
  finally { record.username = ''; record.password = ''; diagnostic.finish(); }
  if (!GUID.test(session?.userKey ?? '') || typeof session.accessToken !== 'string' || !session.accessToken || !sameAppUserTarget(session.binding, safe.binding)) failAs('debug_app_user_authentication_failed', userHint);
  const saved = await vault('seal-session', { ...safe, session });
  if (!saved.ok) fail('debug_app_user_credentials_unavailable');
  return { ok: true, state: 'authenticated', binding: safe.binding, userKey: session.userKey,
    expiresAt: new Date(Math.min(Date.parse(record.expiresAt), Date.parse(session.expiresAt))).toISOString(), ...(userHint ? { userHint } : {}) };
}

// Redact actual private values as well as sensitive field names, including exceptions that echo a login input.
export function publicWrapperBody(value, privateValues = [], depth = 0) {
  if (depth > 20) return '[withheld]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    let text = value;
    for (const secret of privateValues.filter(secret => typeof secret === 'string' && secret.length)) text = text.split(secret).join('[private]');
    return text.slice(0, 10000);
  }
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => publicWrapperBody(item, privateValues, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 1000)
    .filter(([key]) => !privateValues.some(secret => typeof secret === 'string' && secret.length && key.includes(secret)))
    .map(([key, item]) => [key.slice(0, 1000), /password|token|secret|cookie|credential|authorization|username/i.test(key) ? '[private]' : publicWrapperBody(item, privateValues, depth + 1)]));
  return '[withheld]';
}

export async function invokePrivateWrapper(input, { vault = privateAppUserVault, fetchImpl = fetch } = {}) {
  const safe = validatePrivateDescriptor(input.descriptor);
  if (Date.parse(safe.expiresAt) <= Date.now()) fail('debug_app_user_expired');
  if (!NAME.test(input.action ?? '') || input.module !== safe.binding.module || !/^[a-f0-9]{48}$/.test(input.token ?? '') || !input.body || typeof input.body !== 'object' || Array.isArray(input.body) ||
      !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 5 || input.timeoutSeconds > 300) fail('debug_app_user_scope_mismatch');
  const record = await openRecord(safe, vault), headers = { 'Content-Type': 'text/plain; charset=utf-8', 'X-SSAM-Debug-Token': input.token };
  const bodyInput = structuredClone(input.body);
  const secrets = [input.token];
  if (safe.binding.lane === 'odc') {
    const session = record.kind === 'session' ? record.session : null;
    if (!session || !sameAppUserTarget(session.binding, safe.binding) || !GUID.test(session.userKey ?? '') || Date.parse(session.expiresAt) <= Date.now() || !session.accessToken || /[\r\n]/.test(session.accessToken)) fail('debug_app_user_authentication_required');
    headers.Authorization = 'Bearer ' + session.accessToken;
    headers[APP_USER_HEADERS.expectedUserId] = session.userKey;
    secrets.push(session.accessToken, session.idToken, session.refreshToken);
  } else {
    if (record.kind !== 'credentials' || !record.username || !record.password || Object.keys(bodyInput).some(key => Object.values(APP_USER_FIELDS).some(field => key.toLowerCase() === field.toLowerCase()))) fail('debug_app_user_credentials_unavailable');
    bodyInput[APP_USER_FIELDS.username] = record.username;
    bodyInput[APP_USER_FIELDS.password] = record.password;
    secrets.push(record.username, record.password);
  }
  const url = new URL(safe.binding.runtimeUrl).origin + '/' + safe.binding.module + '/rest/SSAMDebug/' + input.action;
  const began = performance.now();
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(bodyInput), redirect: 'error', signal: AbortSignal.timeout(input.timeoutSeconds * 1000) });
    const reader = response.body?.getReader(); let size = 0; const chunks = [];
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > 4194304) { await reader.cancel(); fail('debug_app_user_response_limit'); }
      chunks.push(Buffer.from(chunk.value));
    }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: response.status, state: 'invalid-response', body: null,
      error: 'debug_app_user_invalid_response', elapsedMs: Math.round(performance.now() - began) };
    return { ok: true, status: response.status, state: 'completed', body: publicWrapperBody(body, secrets), elapsedMs: Math.round(performance.now() - began) };
  } catch {
    // A lost answer may have executed the action. Never repeat this request automatically.
    return { ok: false, status: null, state: 'uncertain', error: 'debug_call_outcome_uncertain', elapsedMs: Math.round(performance.now() - began) };
  } finally {
    for (const key of Object.keys(headers)) headers[key] = '';
    delete bodyInput[APP_USER_FIELDS.username]; delete bodyInput[APP_USER_FIELDS.password];
    record.username = ''; record.password = ''; secrets.fill('');
  }
}

async function stdinJson() {
  const chunks = []; let size = 0;
  for await (const bytes of process.stdin) { size += bytes.length; if (size > 4194304) fail('debug_app_user_invalid_request'); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('debug_app_user_invalid_request'); }
}

async function main() {
  let result;
  try {
    const input = await stdinJson(), op = process.argv[2];
    if (op === 'expire') {
      // An endpoint or redact-only record is forgotten only with its full binding.
      const descriptor = input?.binding?.use !== undefined ? validateRedactionSecretDescriptor(input)
        : input?.binding?.serviceKey !== undefined ? validateEndpointCredentialDescriptor(input) : validatePrivateDescriptor(input);
      const ms = Math.max(0, Math.min(3600000, Date.parse(descriptor.expiresAt) - Date.now()));
      await new Promise(resolve => setTimeout(resolve, ms));
      await privateAppUserVault('forget', descriptor).catch(() => {});
      return;
    }
    if (op === 'authenticate') result = await authenticatePrivateAppUser(input);
    else if (op === 'invoke') result = await invokePrivateWrapper(input);
    else fail('debug_app_user_invalid_operation');
  } catch (error) {
    result = { ok: false, error: /^debug_app_user_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_app_user_authentication_failed',
      ...(typeof error.userHint === 'string' ? { userHint: error.userHint } : {}) };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

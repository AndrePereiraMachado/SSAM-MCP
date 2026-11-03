// Machine-private authentication for hosted calls. The server supplies a public
// request, never credentials. Only this process and its private helper see the
// authentication state; every result is projected onto a closed public shape.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { refuse, AgentError } from './errors.mjs';
import { validateUsersRequest, isPrivateAddress } from './users.mjs';
import { createPrivateRuntime, createSecretRedactor, createLoginBrake, createPrivateCredentialMemory, capturePrivatePrompt } from './private-runtime.mjs';
import { macPrivateCommand } from './mac-private-helper.mjs';

export const CREDENTIAL_KIND = 'credential.session';
export const CREDENTIAL_HELPER = fileURLToPath(new URL('./credential-vault.ps1', import.meta.url));
const BASE_KEYS = ['op', 'host', 'service', 'auth', 'profile'];
const REQUEST_KEYS = ['url', 'method', 'body', 'contentType', 'accept', 'write', 'operationId', 'authorizeSha256', 'secretRefs'];
const OPS = new Set(['status', 'prompt', 'login', 'request', 'forget', 'sign-out']);
const PROFILE = /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const MAX_BODY = 4 * 1024 * 1024;
const invalid = text => refuse('PARAMS_INVALID', text);
const validText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const isB64 = (value, max) => typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
const RESPONSE_TYPES = new Set(['text/html', 'text/plain', 'text/xml', 'text/javascript', 'application/json', 'application/xml', 'application/javascript', 'application/x-www-form-urlencoded', 'application/octet-stream', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/pdf', 'image/png', 'image/jpeg']);
const RESPONSE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii', 'windows-1252', 'iso-8859-1', 'utf-16', 'utf-16le', 'utf-16be']);
function responseType(value) {
  const match = /^([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:\s*;\s*charset\s*=\s*(?:"([a-z0-9-]+)"|'([a-z0-9-]+)'|([a-z0-9-]+)))?\s*$/i.exec(value.trim());
  if (!match || !RESPONSE_TYPES.has(match[1].toLowerCase())) return null;
  const charset = (match[2] ?? match[3] ?? match[4])?.toLowerCase();
  if (charset && !RESPONSE_CHARSETS.has(charset)) return null;
  return match[1].toLowerCase() + (charset ? '; charset=' + charset : '');
}
function responseLocation(value, requestUrl, clean) {
  if (!value) return '';
  try {
    const url = new URL(value, requestUrl), request = new URL(requestUrl);
    if (url.origin !== request.origin || url.username || url.password) return '';
    for (const field of ['pathname', 'search', 'hash']) url[field] = clean(url[field]).replaceAll('[redacted]', '%5Bredacted%5D');
    return url.href;
  } catch { return ''; }
}
const secretField = /^(?:password|passwd|client_secret|access_token|refresh_token|id_token|authorization|cookie|set-cookie|csrf|csrfToken|x-csrftoken)$/i;
function hasSecretField(value) {
  if (Array.isArray(value)) return value.some(hasSecretField);
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) => secretField.test(key) || hasSecretField(child));
}
function rememberSessionSecrets(redactor, state) {
  if (!state || typeof state !== 'object') return;
  const cookie = value => {
    if (Array.isArray(value)) { value.forEach(cookie); return; }
    if (typeof value === 'string') {
      redactor.add(value);
      for (const pair of value.split(';')) { const mark = pair.indexOf('='); if (mark >= 0 && !/^(?:path|domain|expires|max-age|samesite)$/i.test(pair.slice(0, mark).trim())) redactor.add(pair.slice(mark + 1).trim()); }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if ('value' in value || 'Value' in value) { redactor.add(value.value ?? value.Value); return; }
    for (const entry of Object.values(value)) cookie(entry);
  };
  for (const [key, value] of Object.entries(state)) {
    if (/^(?:secretValues|password|token|accessToken|refreshToken|idToken|access_token|refresh_token|id_token|clientSecret)$/i.test(key)) redactor.add(value);
    else if (/^(?:cookie|cookies|cookieHeader)$/i.test(key)) cookie(value);
  }
}

export function validateCredentialRequest(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !OPS.has(p.op)) throw invalid('op must be status, prompt, login, request, forget or sign-out');
  const keys = [...BASE_KEYS, ...(p.op === 'prompt' ? ['mode'] : []), ...(p.op === 'request' ? REQUEST_KEYS : [])];
  for (const key of Object.keys(p)) if (!keys.includes(key)) throw invalid('Unknown credential request parameter.');
  try { validateUsersRequest({ op: 'status', host: p.host }); }
  catch (error) { throw error.code === 'USERS_HOST_INTERNAL' ? refuse('CREDENTIAL_HOST_INTERNAL', 'Private credential requests require a public environment host.') : invalid('host must be a plain public DNS name without a scheme, port or address'); }
  if (!['service-center', 'odc-portal'].includes(p.service)) throw invalid('service must be service-center or odc-portal');
  if (!(p.service === 'service-center' ? ['credential', 'basic', 'service-token'] : ['credential', 'api-client']).includes(p.auth)) throw invalid('auth must match the selected service');
  if (p.profile !== undefined && (typeof p.profile !== 'string' || !PROFILE.test(p.profile))) throw invalid('profile must be an opaque profile identifier returned by this agent');
  if (p.mode !== undefined && !['credential', 'select-profile'].includes(p.mode)) throw invalid('mode must be credential or select-profile');
  if (p.op !== 'request') return;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(p.method)) throw invalid('method must be GET, POST, PUT, PATCH or DELETE');
  if (!validText(p.url, 8192) || /[\\\s]|%2e|%2f|%5c/i.test(p.url)) throw invalid('url must be an HTTPS URL on the selected host');
  let url;
  try { url = new URL(p.url); } catch { throw invalid('url must be an HTTPS URL on the selected host'); }
  if (url.origin !== 'https://' + p.host || url.username || url.password || url.hash || url.href !== p.url) throw invalid('url must be an HTTPS URL on the selected host without credentials or a fragment');
  if (p.service === 'service-center') {
    if (p.auth === 'credential') {
      if (!/^\/ServiceCenter(?:\/|$)/i.test(url.pathname)) throw invalid('Service Center requests stay under /ServiceCenter/');
    } else {
      const names = ['EventNames', 'StartInstant', 'EndInstant', 'NumberOfResults'];
      const since = url.searchParams.get('StartInstant'), until = url.searchParams.get('EndInstant');
      const startAt = Date.parse(since), endAt = Date.parse(until), limit = url.searchParams.get('NumberOfResults');
      if (p.method !== 'GET' || url.pathname !== '/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/' || p.body || p.write === true ||
        [...url.searchParams.keys()].length !== names.length || names.some(name => url.searchParams.getAll(name).length !== 1) ||
        url.searchParams.get('EventNames') !== 'TimerExecuted' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(since ?? '') || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(until ?? '') ||
        !Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt || endAt - startAt > 3600000 || !/^(?:[1-9][0-9]?|100)$/.test(limit ?? ''))
        throw invalid('Monitoring authentication is limited to a TimerExecuted GET with a UTC window up to one hour and limit 1..100');
    }
  }
  if (p.service === 'odc-portal') {
    const module = /^\/([a-zA-Z][a-zA-Z0-9_-]*)\//.exec(url.pathname)?.[1];
    const privateRoute = /^\/(?:api\/|[a-zA-Z][a-zA-Z0-9_-]*\/(?:screenservices|moduleservices)\/)/.test(url.pathname);
    const metadata = p.method === 'GET' && module && !['authentication', 'identity', 'api'].includes(module.toLowerCase()) &&
      (url.pathname === '/' + module + '/' || new RegExp('^/' + module + '/scripts/[^\\\\]+\\.js$').test(url.pathname));
    if (!privateRoute && !metadata) throw invalid('Portal requests must use a Portal API, screen service or read-only module metadata route');
  }
  for (const key of url.searchParams.keys()) if (secretField.test(key)) throw invalid('Authentication values belong only to the private agent session');
  if (p.body !== undefined && !isB64(p.body, MAX_BODY)) throw invalid('body must be canonical base64 within the request limit');
  if (p.method === 'GET' && p.body) throw invalid('GET requests cannot include a body');
  if (p.contentType !== undefined && !['application/json', 'application/x-www-form-urlencoded'].includes(p.contentType)) throw invalid('contentType must be application/json or application/x-www-form-urlencoded');
  if (p.body && !p.contentType) throw invalid('A request body needs its contentType');
  if (p.accept !== undefined && !validText(p.accept, 200)) throw invalid('accept must be a plain content type');
  if (p.write !== undefined && typeof p.write !== 'boolean') throw invalid('write must be true or false');
  if (p.operationId !== undefined && (typeof p.operationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(p.operationId))) throw invalid('operationId must name the checked server operation');
  if (p.authorizeSha256 !== undefined && (typeof p.authorizeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.authorizeSha256))) throw invalid('authorizeSha256 must be a SHA-256 digest');
  if (['PUT', 'PATCH', 'DELETE'].includes(p.method) && p.write !== true) throw invalid('A modifying request needs write authorization');
  if (p.write === true && (!p.operationId || !p.authorizeSha256)) throw invalid('A modifying request needs its operation and authorization digest');
  if (p.secretRefs !== undefined && (!Array.isArray(p.secretRefs) || p.secretRefs.length)) throw refuse('CREDENTIAL_SECRET_REFS_UNAVAILABLE', 'Private field injection is not available through this credential session. No request was sent.');
  if (p.body) {
    const body = Buffer.from(p.body, 'base64').toString('utf8');
    if (Buffer.from(body).toString('base64') !== p.body) throw invalid('The request body must contain valid UTF-8');
    if (p.contentType === 'application/json') {
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw invalid('The request body must be valid JSON'); }
      if (hasSecretField(parsed)) throw invalid('Authentication values belong only to the private agent session');
    } else for (const key of new URLSearchParams(body).keys()) if (secretField.test(key)) throw invalid('Authentication values belong only to the private agent session');
  }
}

const FIXED_ERRORS = {
  CREDENTIAL_PERMISSION_DENIED: 'The private credential store denied access. Unlock or allow access to this SSAM Agent and try again.',
  CREDENTIAL_STORE_FAILED: 'The private credential could not be stored. No successful save was reported.',
  CREDENTIAL_HELPER_UNAVAILABLE: 'This installation is missing its private helper. Reinstall the SSAM Agent app.',
  CREDENTIAL_PRIVATE_HELPER_FAILED: 'The private credential helper did not complete safely. No automatic retry was made.',
  CREDENTIAL_NOT_FOUND: 'No credential is stored for this service on this machine. Open the private credential window.',
  CREDENTIAL_SIGN_IN_REQUIRED: 'Sign in through the private credential window on this machine.',
  CREDENTIAL_LOGIN_FAILED: 'The private sign-in did not succeed. Check the account in the private credential window.',
  CREDENTIAL_LOGIN_PAUSED: 'Sign-in attempts are paused. Check the account in the private credential window.',
  CREDENTIAL_AUTH_UNSUPPORTED: 'This authentication method is not supported by this agent.',
  CREDENTIAL_AUTH_CONTRACT_CHANGED: 'The sign-in service contract changed. No credentials were sent to an unrecognized endpoint.',
  CREDENTIAL_AUTH_INTERACTIVE_REQUIRED: 'This account requires interactive sign-in. Complete sign-in with the identity provider.',
  CREDENTIAL_AUTH_ORIGIN_REFUSED: 'The sign-in service requested an unapproved origin. Authentication stopped.',
  CREDENTIAL_AUTH_PRINCIPAL_MISMATCH: 'The signed-in account does not match the selected private credential.',
  CREDENTIAL_AUTH_REDIRECT_INCOMPLETE: 'The sign-in redirect did not complete.',
  CREDENTIAL_AUTH_REDIRECT_LIMIT: 'The sign-in redirect limit was reached.',
  CREDENTIAL_AUTH_RESPONSE_INVALID: 'The sign-in service returned an invalid response.',
  CREDENTIAL_AUTH_RESPONSE_TOO_LARGE: 'The sign-in response exceeded the private response limit.',
  CREDENTIAL_AUTH_ROLE_REQUIRED: 'This account does not have the required role for the selected service.',
  CREDENTIAL_AUTH_STATE_INVALID: 'The sign-in state could not be verified.',
  CREDENTIAL_AUTH_TIMEOUT: 'The private sign-in timed out.',
  CREDENTIAL_AUTH_TRANSPORT_FAILED: 'The private sign-in could not reach the service.',
  CREDENTIAL_IDENTITY_TOKEN_INVALID: 'The identity token could not be verified.',
  CREDENTIAL_LOGIN_LAYOUT_CHANGED: 'The sign-in page changed. No credentials were sent through an unrecognized form.',
  CREDENTIAL_PROFILE_NOT_FOUND: 'That profile is not available for this service and account.',
  CREDENTIAL_PROFILE_REQUIRED: 'Choose a profile in the private credential window.',
  CREDENTIAL_CONFIRMATION_DECLINED: 'The person on this machine declined. No request was sent.',
  CREDENTIAL_SESSION_EXPIRED: 'The private session expired. Sign in again in the private credential window.',
  CREDENTIAL_SESSION_CHANGED: 'The private credential selection changed during the request. Repeat the request with the selected profile.',
  CREDENTIAL_RESPONSE_INVALID: 'The private response was not valid JSON after private processing. No response content was released.',
  CREDENTIAL_RESPONSE_METADATA_INVALID: 'The private response contained unsupported metadata. No response content was released.',
  CREDENTIAL_RESPONSE_STRUCTURE_REDACTED: 'Sensitive authentication values were removed, but the response structure could not be preserved. No response content was released.',
  CREDENTIAL_PROMPT_FAILED: 'The private credential window did not complete safely. No new credential was accepted.',
  CREDENTIAL_HOST_PRIVATE: 'The environment resolves to a private address. No request was sent.',
  CREDENTIAL_REQUEST_FAILED: 'The private request failed. No automatic retry was made.',
  CREDENTIAL_SECRET_REFS_UNAVAILABLE: 'Private field injection is not available through this credential session. No request was sent.',
};
const fault = (code = 'CREDENTIAL_REQUEST_FAILED', executed = false) => new AgentError(Object.hasOwn(FIXED_ERRORS, code) ? code : 'CREDENTIAL_REQUEST_FAILED', FIXED_ERRORS[code] ?? FIXED_ERRORS.CREDENTIAL_REQUEST_FAILED, { executed });

export function createCredentialSession({ dataRoot, runtimeRoot = path.resolve(path.dirname(CREDENTIAL_HELPER), '../..'), account = '', platform = process.platform, env = process.env, helper = CREDENTIAL_HELPER,
  privateRuntime, exec, start, lookup = name => dns.promises.lookup(name, { all: true }), now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const runtime = privateRuntime ?? createPrivateRuntime({ dataRoot, account, now });
  const sessions = new Map(), prompts = new Map(), pending = new Map(), generations = new Map(), promptFailures = new Set();
  const memory = createPrivateCredentialMemory();
  let confirming = false;
  const promptDir = path.join(dataRoot, 'private', 'credential-session');
  const legacyDir = path.join(dataRoot, 'private', 'credential');
  // Keep an existing retry brake; never treat the installed connection file as a directory.
  const brakeDir = fs.statSync(legacyDir, { throwIfNoEntry: false })?.isDirectory() ? legacyDir : promptDir;
  const brake = createLoginBrake({ file: path.join(brakeDir, 'sign-in-failures.json'), scope: runtime.scope });
  const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = (p, extra = []) => ['-NoLogo', '-NoProfile', ...(['prompt', 'forget'].includes(p.op) ? ['-STA'] : ['-NonInteractive']), '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', p.op, '-Scope', runtime.scope, '-HostName', p.host, ...extra];
  const command = (argv, input) => platform === 'darwin'
    ? macPrivateCommand({ runtimeRoot, dataRoot, family: 'credential', argv, input })
    : { file: powershell, args: argv, input };
  const run = exec ?? ((file, argv, input, timeout) => new Promise((resolve, reject) => {
    const child = execFile(file, argv, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => stdout ? resolve(String(stdout)) : error ? reject(new Error('private helper failed')) : resolve(''));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  }));
  const launch = start ?? ((file, argv, input) => { const child = spawn(file, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); child.stdin?.on('error', () => {}); child.stdin?.end(input); return child; });
  const keyOf = p => [p.service, p.auth, p.host, p.profile ?? 'default'].join('|');
  const groupOf = p => [p.service, p.service === 'service-center' && p.auth === 'basic' ? 'credential' : p.auth, p.host].join('|');
  const memoryKey = (p, profile = p.profile ?? 'default') => groupOf(p) + '|' + profile;
  const groupPrefixes = p => (p.service === 'service-center' && ['basic', 'credential'].includes(p.auth) ? ['basic', 'credential'] : [p.auth]).map(auth => [p.service, auth, p.host].join('|') + '|');
  function invalidate(p) {
    const group = groupOf(p), prefixes = groupPrefixes(p);
    generations.set(group, (generations.get(group) ?? 0) + 1);
    // Do not clear a redactor still held by an in-flight response. That response
    // is rejected by the generation check; its secret set then becomes garbage.
    for (const key of sessions.keys()) if (prefixes.some(prefix => key.startsWith(prefix))) sessions.delete(key);
  }
  function settle() {
    for (const [key, record] of prompts) {
      try { if (fs.readFileSync(record.status, 'utf8') === 'visible') record.phase = 'visible'; } catch { /* not shown yet */ }
      if (record.capture.done) {
        const result = record.capture.value;
        const current = record.generation === (generations.get(groupOf(record.request)) ?? 0);
        if (current && !record.capture.failed && result?.saved && typeof result.profile === 'string' && PROFILE.test(result.profile)) {
          record.applied = true;
          invalidate(record.request);
          memory.delete(memoryKey(record.request));
          memory.delete(memoryKey(record.request, result.profile));
          if (!result.remembered) memory.set([memoryKey(record.request), memoryKey(record.request, result.profile)], { profile: result.profile, credential: result.privateCredential });
          record.remembered = result.remembered;
          record.phase = 'saved';
          for (const prefix of groupPrefixes(record.request)) brake.clearPrefix(prefix);
        } else if (current && (record.capture.failed || result?.saved)) promptFailures.add(key);
        if (!record.applied) runtime.windowRefused();
        record.capture.value = null;
        prompts.delete(key);
        fs.rmSync(record.status, { force: true });
      }
    }
  }
  runtime.registerBusy(() => { settle(); return confirming || prompts.size > 0; });
  async function publicHost(host) {
    let addresses;
    try { addresses = await lookup(host); } catch { throw refuse('CREDENTIAL_HOST_UNRESOLVED', 'The environment host could not be resolved. No request was sent.'); }
    if (!addresses?.length || addresses.some(item => isPrivateAddress(item.address))) throw fault('CREDENTIAL_HOST_PRIVATE');
  }
  async function call(p) {
    if (!sessions.has(keyOf(p)) && sessions.size >= 128) throw refuse('CREDENTIAL_SESSION_LIMIT', 'Too many private credential sessions are active. Sign out of an unused session first.');
    const key = keyOf(p);
    let session = sessions.get(key) ?? { redactor: createSecretRedactor(), value: null };
    const generation = generations.get(groupOf(p)) ?? 0;
    const temporary = memory.get(memoryKey(p));
    if (temporary) session.redactor.add(temporary.credential.password);
    let value;
    try {
      const cmd = command(args(p), JSON.stringify({ ...p, ...(temporary ? { profile: temporary.profile, privateCredential: temporary.credential } : {}), privateSession: session.value }));
      value = JSON.parse(await run(cmd.file, cmd.args, cmd.input, p.op === 'forget' ? 130000 : 90000));
      if (p.op === 'status' && !p.profile && value?.ok && value.available && PROFILE.test(value.profile ?? '')) {
        const active = sessions.get(keyOf({ ...p, profile: value.profile }));
        if (active?.value && active !== session) {
          session = active;
          const selected = command(args(p), JSON.stringify({ ...p, ...(temporary ? { profile: temporary.profile, privateCredential: temporary.credential } : {}), privateSession: session.value }));
          value = JSON.parse(await run(selected.file, selected.args, selected.input, 90000));
        }
      }
    }
    catch (error) {
      if (error?.code === 'CREDENTIAL_HELPER_UNAVAILABLE') throw fault(error.code, false);
      throw fault('CREDENTIAL_REQUEST_FAILED', p.op === 'request' && p.method !== 'GET' ? null : false);
    }
    if (!value || typeof value !== 'object' || value.ok !== true) throw fault(value?.code, p.op === 'request' && p.method !== 'GET' ? null : false);
    settle();
    if (generation !== (generations.get(groupOf(p)) ?? 0)) throw fault('CREDENTIAL_SESSION_CHANGED', p.op === 'request' && p.method !== 'GET' ? null : false);
    if (value.privateSession !== undefined) session.value = value.privateSession;
    session.redactor.add(value.secretValues);
    // Known private fields are also registered defensively. A helper cannot make
    // them public simply by accidentally echoing them in a page or a header.
    rememberSessionSecrets(session.redactor, value.privateSession);
    sessions.set(key, session);
    return { value, session };
  }
  async function prompt(p) {
    settle();
    const key = keyOf(p);
    if (prompts.has(key)) return { opened: false, alreadyOpen: true };
    promptFailures.delete(key);
    runtime.takeWindow('CREDENTIAL');
    const status = path.join(promptDir, 'prompt-' + randomUUID() + '.status');
    let child;
    try { fs.mkdirSync(promptDir, { recursive: true }); const cmd = command(args(p, ['-PromptStatusPath', status]), JSON.stringify(p)); child = launch(cmd.file, cmd.args, cmd.input); }
    catch { runtime.windowRefused(); throw refuse('CREDENTIAL_PROMPT_NOT_VISIBLE', 'The private credential window could not be confirmed visible.'); }
    const record = { child, status, phase: null, request: p, generation: generations.get(groupOf(p)) ?? 0, capture: capturePrivatePrompt(child) };
    prompts.set(key, record);
    child.on?.('error', () => { record.failed = true; prompts.delete(key); runtime.windowRefused(); fs.rmSync(status, { force: true }); });
    child.on?.('close', () => { try { settle(); } catch { /* a damaged brake remains fail-closed on the next call */ } });
    child.unref?.();
    for (let elapsed = 0; elapsed < 12000; elapsed += 100) {
      settle();
      if (record.capture.done && record.capture.failed) throw fault('CREDENTIAL_PROMPT_FAILED');
      if (record.phase === 'visible' || record.phase === 'saved') return { opened: true, alreadyOpen: false, visible: true, ...(record.phase === 'saved' ? { saved: true, remembered: record.remembered } : {}) };
      if (record.failed || record.capture.done) break;
      await wait(100);
    }
    // Keep a live process registered. A late window must still count as busy.
    throw refuse('CREDENTIAL_PROMPT_NOT_VISIBLE', 'The private credential window could not be confirmed visible.');
  }
  function project(value, session, p) {
    const clean = text => session.redactor.text(text);
    if (p.op === 'status') {
      const result = { available: value.available === true, authenticated: value.authenticated === true, principal: validText(value.principal, 320) ? clean(value.principal) : null,
        profile: typeof value.profile === 'string' && PROFILE.test(value.profile) ? value.profile : null, remembered: value.available === true && !memory.get(memoryKey(p)) };
      if (Array.isArray(value.profiles)) result.profiles = value.profiles.slice(0, 100).filter(x => x && typeof x.profile === 'string' && PROFILE.test(x.profile) && validText(x.principal, 320)).map(x => ({ profile: x.profile, principal: clean(x.principal) }));
      const temporary = memory.get(memoryKey(p));
      if (temporary) {
        result.available = true; result.profile = temporary.profile; result.principal = clean(temporary.credential.username); result.remembered = false;
        result.profiles = [...(result.profiles ?? []).filter(item => item.profile !== temporary.profile), { profile: temporary.profile, principal: result.principal }];
      }
      return result;
    }
    if (p.op === 'login') return { authenticated: value.authenticated === true };
    if (p.op === 'forget' || p.op === 'sign-out') {
      invalidate(p);
      memory.deletePrefix(groupOf(p) + '|');
      session.redactor.clear();
      return p.op === 'forget' ? { forgotten: true } : { signedOut: true };
    }
    if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599 || !isB64(value.body, MAX_BODY) || !validText(value.contentType, 200)) throw fault();
    const body = Buffer.from(value.body, 'base64');
    let contentType = responseType(value.contentType);
    if (!contentType) throw fault('CREDENTIAL_RESPONSE_METADATA_INVALID', p.method !== 'GET' ? null : false);
    // Textual API/page responses are scrubbed before base64 encoding. Binary
    // responses cannot safely be rewritten; refuse an echoed secret instead.
    const textual = /(?:json|text|xml|javascript|x-www-form-urlencoded)/i.test(contentType);
    let decoded, encoding = 'utf-8';
    if (textual) {
      const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
      try { const decoder = new TextDecoder(charset, { fatal: true }); encoding = decoder.encoding; decoded = decoder.decode(body); }
      catch { throw fault(); }
    } else decoded = body.toString('utf8');
    const scrubbed = clean(decoded), notes = [];
    if (!textual && (decoded !== scrubbed || body.toString('utf16le') !== clean(body.toString('utf16le')))) throw fault();
    if (/json/i.test(contentType) && scrubbed.trim()) {
      try { JSON.parse(decoded); } catch { throw fault('CREDENTIAL_RESPONSE_INVALID', p.method !== 'GET' ? null : false); }
      try { JSON.parse(scrubbed); } catch { throw fault('CREDENTIAL_RESPONSE_STRUCTURE_REDACTED', p.method !== 'GET' ? null : false); }
    }
    // The helper never follows redirects. This URL is public validated input, not response data.
    const url = p.url, rawLocation = validText(value.location, 8192) ? value.location : '';
    const location = responseLocation(rawLocation, p.url, clean);
    if (value.redacted === true || decoded !== scrubbed) notes.push('Sensitive authentication values were removed from the response.');
    if (contentType !== value.contentType) notes.push('Response content type was normalized to a recognized media type and charset.');
    if (location !== rawLocation) notes.push('Response redirect metadata was normalized or withheld to preserve the approved origin.');
    if (textual && decoded !== scrubbed && encoding !== 'utf-8') {
      contentType = contentType.replace(/;\s*charset\s*=\s*(?:"[^"]*"|'[^']*'|[^;\s]*)/ig, '') + '; charset=utf-8';
      notes.push('Response text was converted from ' + encoding + ' to UTF-8 to remove sensitive authentication values.');
    }
    return { status: value.status, contentType, body: textual && decoded !== scrubbed ? Buffer.from(scrubbed).toString('base64') : value.body, url, location,
      ...(notes.length ? { notes } : {}) };
  }
  return {
    async execute(p) {
      if (!['win32', 'darwin'].includes(platform)) throw refuse('CREDENTIAL_PLATFORM_UNAVAILABLE', 'Private credential sessions are not available on this platform.');
      validateCredentialRequest(p);
      settle();
      if (promptFailures.delete(keyOf(p)) && !['prompt', 'sign-out', 'forget'].includes(p.op)) throw fault('CREDENTIAL_PROMPT_FAILED');
      if (['prompt', 'login', 'request'].includes(p.op)) await publicHost(p.host);
      if (p.op === 'prompt') return prompt(p);
      const key = keyOf(p), before = pending.get(key) ?? Promise.resolve();
      const operation = before.catch(() => {}).then(async () => {
        if (p.op === 'forget') { runtime.takeWindow('CREDENTIAL'); confirming = true; }
        if (p.op === 'forget' || p.op === 'sign-out') invalidate(p);
        if (p.op === 'login') {
          if (brake.count(key) >= 2) throw fault('CREDENTIAL_LOGIN_PAUSED');
          brake.set(key, brake.count(key) + 1);
        }
        try {
          const { value, session } = await call(p);
          if (p.op === 'login' && value.authenticated === true) brake.set(key, 0);
          if (p.op === 'forget' || p.op === 'sign-out') brake.set(key, 0);
          if (value.status === 401 || (p.op === 'login' && value.authenticated !== true)) sessions.delete(key);
          return project(value, session, p);
        } catch (error) {
          if (p.op === 'forget') runtime.windowRefused();
          if (error.code === 'CREDENTIAL_SESSION_EXPIRED') sessions.delete(key);
          if (p.op === 'login' && ['CREDENTIAL_NOT_FOUND', 'CREDENTIAL_PROFILE_NOT_FOUND', 'CREDENTIAL_PROFILE_REQUIRED', 'CREDENTIAL_AUTH_UNSUPPORTED'].includes(error.code)) brake.set(key, Math.max(0, brake.count(key) - 1));
          throw error;
        } finally { if (p.op === 'forget') confirming = false; }
      });
      pending.set(key, operation);
      try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
    },
  };
}

// The kind o11.users (fase4-28 r4, docs/FASE2-AGENTE.md 4.4): the Users application of an O11 environment through this
// machine. What can sign in never leaves it: the administrator's password and new passwords are entries of this Windows
// account's Credential Manager, typed only in a private window (users-vault.ps1), and the session cookies live in this
// process's memory. The server reads the pages and keeps the receipts; no field of this kind carries a password or a cookie,
// in either direction. The HTTP requests go only to https://<host>/Users/ of a host whose administrator the person stored
// here (the helper checks the vault before any request), never redirected. Windows only: elsewhere the kind answers
// USERS_PLATFORM_UNAVAILABLE, and the Hello still lists it, so the server can say that instead of "update your agent".
//
// params: {op:'status', host, kind?, entry?} -> {available, principal}
//         {op:'prompt', host, kind?, entry?, subject?} -> {opened, alreadyOpen, visible?, saved?}
//         {op:'request', host, url, method, fields:[[name, value]], secretRefs?:[{field, kind, entry?, part}]}
//             -> {status, location, contentType, body} (the three texts in base64)
//         {op:'forget', host, kind:'password', entry} -> {}
// Refusals happen before anything is started. The table of what passes is shared with the native core (check-users-request).
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentError, refuse } from './errors.mjs';

export const USERS_KIND = 'o11.users';
export const USERS_HELPER = fileURLToPath(new URL('./users-vault.ps1', import.meta.url));
const OPS = new Set(['status', 'prompt', 'request', 'forget']);
const KEYS = Object.freeze({ status: ['op', 'host', 'kind', 'entry'], prompt: ['op', 'host', 'kind', 'entry', 'subject'], request: ['op', 'host', 'url', 'method', 'fields', 'secretRefs'], forget: ['op', 'host', 'kind', 'entry'] });
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ENTRY = /^[a-f0-9]{64}$/;
const FIELD = /^[A-Za-z0-9_$]{1,256}$/;
const PAGE = /^\/Users\/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\.aspx)?$/;
const QUERY = /^(?:(?:UserId|GroupId|RoleId|ApplicationId)=[1-9][0-9]{0,18})?$/;
const MAX_FIELDS = 2000, MAX_FIELD_BYTES = 8 * 1024 * 1024, MAX_SUBJECT = 256;
const PROMPT_WAIT_MS = 12000, HELPER_MS = 45000;

const invalid = message => refuse('PARAMS_INVALID', message);
const text = value => typeof value === 'string';
// A DNS name of an environment: never an address of this network by number, and never this machine.
const hostOk = host => text(host) && HOST.test(host) && !/^[0-9]+$|^0x/.test(host.split('.').at(-1)) && !host.endsWith('.localhost');
const requestUrl = (url, host) => {
  if (!text(url) || url.length > 2048 || !url.startsWith(`https://${host}/`) || /[\\\s\u0000-\u001f]|%2e|%2f|%5c/i.test(url)) throw invalid('url is not a Users page of the host');
  const rest = url.slice(`https://${host}`.length), mark = rest.indexOf('?');
  const page = mark < 0 ? rest : rest.slice(0, mark), query = mark < 0 ? '' : rest.slice(mark + 1);
  if (rest.includes('#') || !PAGE.test(page) || !QUERY.test(query)) throw invalid('url is not a Users page of the host');
  return { page };
};

// What may run, checked before anything is started (the table tests/native/users.test.mjs shares with the native core).
export function validateUsersRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
  if (!OPS.has(params.op)) throw invalid('op must be status, prompt, request or forget');
  for (const key of Object.keys(params)) if (!KEYS[params.op].includes(key)) throw invalid('unknown parameter ' + key);
  if (!hostOk(params.host)) throw invalid('host must be the DNS name of an environment');
  if (params.op !== 'request') {
    const kind = params.kind ?? 'login';
    if (kind !== 'login' && kind !== 'password') throw invalid('kind must be login or password');
    if (kind === 'password' ? !(text(params.entry) && ENTRY.test(params.entry)) : params.entry !== undefined) throw invalid('entry belongs to kind password, 64 hex');
    if (params.op === 'forget' && kind !== 'password') throw invalid('only a new password is forgotten');
    if (params.subject !== undefined && (!text(params.subject) || params.subject.length > MAX_SUBJECT || /[\u0000-\u001f\u007f]/.test(params.subject))) throw invalid('subject must be one line of at most 256 characters');
    return;
  }
  const { page } = requestUrl(params.url, params.host);
  if (params.method !== 'GET' && params.method !== 'POST') throw invalid('method must be GET or POST');
  const { fields = [], secretRefs = [] } = params;
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS || !fields.every(f => Array.isArray(f) && f.length === 2 && text(f[0]) && text(f[1]))) throw invalid('fields must be [name, value] texts');
  if (fields.reduce((n, f) => n + f[0].length + f[1].length, 0) > MAX_FIELD_BYTES) throw invalid('fields are too large');
  if (!Array.isArray(secretRefs) || secretRefs.length > 2) throw invalid('at most 2 secretRefs');
  for (const ref of secretRefs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['field', 'kind', 'entry', 'part'].includes(k))) throw invalid('secretRefs take field, kind, entry and part');
    if (!text(ref.field) || !FIELD.test(ref.field) || (ref.part !== 'username' && ref.part !== 'password')) throw invalid('invalid secret field');
    if (ref.kind === 'login') { if (ref.entry !== undefined || page !== '/Users/Login.aspx' || params.method !== 'POST') throw invalid('the login goes only to the login page'); }
    else if (ref.kind !== 'password' || !text(ref.entry) || !ENTRY.test(ref.entry) || ref.part !== 'password' || params.method !== 'POST') throw invalid('invalid secret reference');
  }
}

// The vault scope of this installation: its entries are its own, apart from an SSAM installed on the same Windows account.
export const usersScope = dataRoot => createHash('sha256').update(path.resolve(dataRoot).toLowerCase()).digest('hex').slice(0, 16);
const powershell = env => path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const FAILURES = Object.freeze({ USERS_HOST_NOT_AUTHENTICATED: 'No Users administrator is stored for this environment on this machine; nothing was sent.' });

// exec(file, args, input) -> stdout, start(file, args) -> a child: the tests' seams.
export function createUsersKind({ dataRoot, platform = process.platform, env = process.env, helper = USERS_HELPER, exec, start, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const jars = new Map(), prompts = new Map();
  const scope = usersScope(dataRoot);
  const promptDir = path.join(dataRoot, 'private', 'users');
  const runHelper = exec ?? ((file, args, input) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: HELPER_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (stdout ? resolve(String(stdout)) : reject(error ?? new Error('no answer'))));
    child.stdin?.end(input ?? '');
  }));
  const startHelper = start ?? ((file, args) => spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }));
  const base = (mode, host) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', mode, '-HostName', host, '-Scope', scope];
  const entryArgs = p => [...(p.kind ? ['-Kind', p.kind] : []), ...(p.entry ? ['-Entry', p.entry] : [])];
  async function helperCall(args, input, executed) {
    let stdout;
    try { stdout = await runHelper(powershell(env), args, input); }
    catch { throw new AgentError('USERS_PRIVATE_REQUEST_FAILED', 'The private Users helper did not finish; no automatic retry.', { executed }); }
    let value = null;
    try { value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch { /* below */ }
    if (value?.ok === true) return value;
    const code = typeof value?.code === 'string' && /^USERS_[A-Z_]{1,60}$/.test(value.code) ? value.code : 'USERS_PRIVATE_REQUEST_FAILED';
    throw new AgentError(code, FAILURES[code] ?? 'The private Users request failed; no automatic retry.', { executed: code === 'USERS_HOST_NOT_AUTHENTICATED' ? false : executed });
  }
  const cookieHeader = host => [...(jars.get(host)?.entries() ?? [])].map(([name, value]) => name + '=' + value).join('; ');
  function storeCookies(host, encoded) {
    for (const item of Array.isArray(encoded) ? encoded : []) {
      const first = Buffer.from(String(item), 'base64').toString('utf8').split(';')[0], mark = first.indexOf('=');
      if (mark <= 0) continue;
      const jar = jars.get(host) ?? new Map(), name = first.slice(0, mark).trim(), value = first.slice(mark + 1).trim();
      if (value) jar.set(name, value); else jar.delete(name);
      jars.set(host, jar);
    }
  }
  async function openPrompt(p) {
    const key = [p.host, p.kind ?? 'login', p.entry ?? ''].join('|');
    const pending = prompts.get(key);
    if (pending && pending.exitCode === null) return { opened: false, alreadyOpen: true };
    fs.mkdirSync(promptDir, { recursive: true });
    const statusFile = path.join(promptDir, 'prompt-' + randomUUID() + '.status');
    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'prompt', '-HostName', p.host, '-Scope', scope, ...entryArgs(p),
      '-Subject', p.subject ?? '', '-PromptStatusPath', statusFile];
    const child = startHelper(powershell(env), args);
    prompts.set(key, child);
    child.on?.('error', () => prompts.delete(key));
    child.on?.('exit', () => prompts.delete(key));
    child.unref?.();
    try {
      for (let waited = 0; waited < PROMPT_WAIT_MS; waited += 100) {
        if (fs.existsSync(statusFile)) {
          const phase = fs.readFileSync(statusFile, 'utf8');
          if (phase === 'visible' || phase === 'saved') return { opened: true, alreadyOpen: false, visible: true, ...(phase === 'saved' ? { saved: true } : {}) };
        }
        if ((child.exitCode ?? null) !== null) break;
        await wait(100);
      }
    } finally { fs.rmSync(statusFile, { force: true }); }
    throw new AgentError('USERS_PROMPT_NOT_VISIBLE', 'The private window could not be confirmed visible.', { executed: null });
  }
  return {
    async execute(params) {
      if (platform !== 'win32') throw refuse('USERS_PLATFORM_UNAVAILABLE', 'Users administration is not available on this platform.');
      validateUsersRequest(params);
      const { op, host } = params;
      if (op === 'status') {
        const value = await helperCall([...base('status', host), ...entryArgs(params)], '', false);
        return { available: value.available === true, principal: typeof value.principal === 'string' ? value.principal : null };
      }
      if (op === 'forget') { await helperCall([...base('forget', host), ...entryArgs(params)], '', false); return {}; }
      if (op === 'prompt') {
        if ((params.kind ?? 'login') === 'login') jars.delete(host);
        return openPrompt(params);
      }
      const input = Buffer.from(JSON.stringify({ url: params.url, method: params.method, fields: params.fields ?? [], secretRefs: params.secretRefs ?? [], cookie: cookieHeader(host) })).toString('base64');
      const value = await helperCall(base('request', host), input, null);
      storeCookies(host, value.setCookie);
      // The session stays here: the answer has no setCookie.
      return { status: value.status, location: value.location ?? '', contentType: value.contentType ?? '', body: value.body ?? '' };
    },
  };
}

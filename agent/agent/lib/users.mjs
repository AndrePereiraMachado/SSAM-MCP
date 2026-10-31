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
//         {op:'confirm', host, action, userId?, targetId?, labels?, changes?} -> {approved:true}: a window here, the person's yes. Without it
//         the sign-in and every write are refused here (USERS_LOGIN_CONSENT_REQUIRED, USERS_CONSENT_REQUIRED): no answer is no, and the kind
//         has no other way to get a yes. The rows are this agent's words and checked values; what comes from a page says so.
//         {op:'login', host} -> {authenticated}: the helper signs in by itself; the server chooses no field and sees no page
//         {op:'request', host, url, method, fields:[[name, value]], secretRefs?:[{field, kind:'password', entry, part:'password'}]}
//             -> {status, location, contentType, body} (the three texts in base64)
//         {op:'forget', host, kind:'password', entry} -> {}
// Refusals happen before anything is started. The table of what passes is shared with the native core (check-users-request).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentError, refuse } from './errors.mjs';

export const USERS_KIND = 'o11.users';
export const USERS_HELPER = fileURLToPath(new URL('./users-vault.ps1', import.meta.url));
const OPS = new Set(['status', 'prompt', 'confirm', 'login', 'request', 'forget']);
const KEYS = Object.freeze({ status: ['op', 'host', 'kind', 'entry'], prompt: ['op', 'host', 'kind', 'entry', 'subject', 'action', 'userId'], confirm: ['op', 'host', 'action', 'userId', 'targetId', 'labels', 'changes'], login: ['op', 'host'], request: ['op', 'host', 'url', 'method', 'fields', 'secretRefs'], forget: ['op', 'host', 'kind', 'entry'] });
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ENTRY = /^[a-f0-9]{64}$/;
const FIELD = /^(?:[A-Za-z0-9_$]{1,200}[$_])?wt(?:Password|ConfirmPassword|NewPassword)Input$/;
const PASSWORD_PAGE = /^\/Users\/(?:User_Edit|User_Show)\.aspx$/;
const PAGE = /^\/Users\/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\.aspx)?$/;
const QUERY = /^(?:(?:UserId|GroupId|RoleId|ApplicationId)=[1-9][0-9]{0,18})?$/;
const MAX_FIELDS = 2000, MAX_FIELD_BYTES = 8 * 1024 * 1024, MAX_SUBJECT = 256;
const PROMPT_WAIT_MS = 12000, HELPER_MS = 45000;

const ID = /^[1-9][0-9]{0,18}$/;
// What a person can approve: only these. Deleting and taking access away are not on the list, whatever a server asks.
const CONFIRM = Object.freeze({
  'sign-in': { text: 'Sign in to the Users application of this environment' },
  update: { text: 'Change the details of this user', page: 'User_Edit', user: true },
  activate: { text: 'Activate this user', page: 'User_Show', user: true },
  deactivate: { text: 'Deactivate this user: the user loses access', page: 'User_Show', user: true },
  'grant-role': { text: 'Give this role to this user', page: 'User_Show', user: true, target: 'Role id' },
  'add-group': { text: 'Add this user to this group: the user gets its roles', page: 'User_Show', user: true, target: 'Group id' },
});
const CHANGES = new Set(['name', 'username', 'email', 'phone']);
const CONSENT_MS = 8 * 3600 * 1000, PERMIT_MS = 120000, PASSWORD_PERMIT_MS = 300000, CONFIRM_MS = 130000;
// A shown value: one line, no control or direction characters.
const shown = (value, max) => text(value) && value.length <= max && !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
const invalid = message => refuse('PARAMS_INVALID', message);
const text = value => typeof value === 'string';
// A DNS name of an environment: never an address by number, this machine, a name only an internal network resolves, a service that
// resolves to any address it is given, or a name written in another alphabet.
const INTERNAL = /\.(?:localhost|local|localdomain|internal|intranet|lan|home|corp|svc|arpa|nip\.io|sslip\.io|xip\.io)$/;
const hostOk = host => {
  if (!text(host) || !HOST.test(host) || INTERNAL.test(host) || host.split('.').some(label => label.startsWith('xn--'))) return false;
  const last = host.split('.').at(-1);
  return last.length >= 2 && !/^[0-9]+$|^0x/.test(last);
};
// A resolved address that is not on the internet: this machine, a private network, link-local (cloud metadata), multicast.
export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (kind !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}
const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length];
};
// A new host that reads like one already approved: inside it, around it, the same first label elsewhere, or one letter away.
export function lookalikeOf(host, approved) {
  const [first, ...rest] = host.split('.');
  return approved.find(other => {
    if (other === host) return false;
    const [otherFirst, ...otherRest] = other.split('.');
    return host.includes(other) || other.includes(host) || first === otherFirst || (rest.join('.') === otherRest.join('.') && distance(first, otherFirst) <= 1);
  }) ?? null;
}
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
  if (!OPS.has(params.op)) throw invalid('op must be status, prompt, login, request or forget');
  for (const key of Object.keys(params)) if (!KEYS[params.op].includes(key)) throw invalid('unknown parameter ' + key);
  if (!hostOk(params.host)) throw invalid('host must be the DNS name of an environment');
  if (params.op === 'login') return;
  if (params.op === 'confirm') {
    const rule = text(params.action) && Object.hasOwn(CONFIRM, params.action) ? CONFIRM[params.action] : null;
    if (!rule) throw invalid('action is not one a person can approve here');
    if (rule.user ? !(text(params.userId) && ID.test(params.userId)) : params.userId !== undefined) throw invalid('userId is a number as text, on a write');
    if (rule.target ? !(text(params.targetId) && ID.test(params.targetId)) : params.targetId !== undefined) throw invalid('targetId is a number as text, on a role or a group');
    for (const [key, value] of Object.entries(params.labels ?? {})) if (!['user', 'target'].includes(key) || !shown(value, 120)) throw invalid('labels are one short line each');
    if (params.changes !== undefined && params.action !== 'update') throw invalid('changes belong to update');
    for (const [key, value] of Object.entries(params.changes ?? {})) if (!CHANGES.has(key) || !shown(value, 256)) throw invalid('changes are name, username, email and phone, one line each');
    return;
  }
  if (params.op !== 'request') {
    const kind = params.kind ?? 'login';
    if (kind !== 'login' && kind !== 'password') throw invalid('kind must be login or password');
    if (kind === 'password' ? !(text(params.entry) && ENTRY.test(params.entry)) : params.entry !== undefined) throw invalid('entry belongs to kind password, 64 hex');
    if (params.op === 'forget' && kind !== 'password') throw invalid('only a new password is forgotten');
    if (params.op === 'prompt') {
      if (kind === 'password' && params.action !== 'create' && params.action !== 'set-password') throw invalid('a new password is for create or set-password');
      if (kind === 'login' && (params.action !== undefined || params.userId !== undefined)) throw invalid('the sign-in window takes only a host');
      if (params.action === 'set-password' ? !(text(params.userId) && ID.test(params.userId)) : params.userId !== undefined) throw invalid('userId is a number as text, on set-password');
    }
    if (params.subject !== undefined && (!text(params.subject) || params.subject.length > MAX_SUBJECT || /[\u0000-\u001f\u007f]/.test(params.subject))) throw invalid('subject must be one line of at most 256 characters');
    return;
  }
  const { page } = requestUrl(params.url, params.host);
  if (params.method !== 'GET' && params.method !== 'POST') throw invalid('method must be GET or POST');
  const { fields = [], secretRefs = [] } = params;
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS || !fields.every(f => Array.isArray(f) && f.length === 2 && text(f[0]) && text(f[1]))) throw invalid('fields must be [name, value] texts');
  if (page === '/Users/Login.aspx' && params.method === 'POST') throw invalid('the sign-in is op login');
  if (fields.reduce((n, f) => n + f[0].length + f[1].length, 0) > MAX_FIELD_BYTES) throw invalid('fields are too large');
  if (!Array.isArray(secretRefs) || secretRefs.length > 2) throw invalid('at most 2 secretRefs');
  for (const ref of secretRefs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['field', 'kind', 'entry', 'part'].includes(k))) throw invalid('secretRefs take field, kind, entry and part');
    if (!text(ref.field) || !FIELD.test(ref.field) || ref.part !== 'password') throw invalid('a new password goes only into a password field');
    if (ref.kind !== 'password' || !text(ref.entry) || !ENTRY.test(ref.entry) || params.method !== 'POST' || !PASSWORD_PAGE.test(page)) throw invalid('a new password goes only into the form of a user');
  }
}

// The vault scope of this installation: its entries are its own, apart from an SSAM installed on the same Windows account.
export const usersScope = dataRoot => createHash('sha256').update(path.resolve(dataRoot).toLowerCase()).digest('hex').slice(0, 16);
const powershell = env => path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const FAILURES = Object.freeze({
  USERS_PAGE_TOO_LARGE: 'This page is larger than a Users page can be; it was not read.',
  USERS_LOGIN_LAYOUT_CHANGED: 'The sign-in page of this environment is not the one this agent knows; nothing was sent.',
  USERS_HOST_LOOKALIKE: 'This name reads like an environment already approved on this machine, so no window was opened and nothing was sent.',
  USERS_HOST_PRIVATE: 'This environment resolves to an address that is not on the internet, so nothing was sent.',
  USERS_HOST_UNRESOLVED: 'This environment does not resolve, so nothing was sent.', USERS_HOST_NOT_AUTHENTICATED: 'No Users administrator is stored for this environment on this machine; nothing was sent.' });

// exec(file, args, input) -> stdout, start(file, args) -> a child: the tests' seams.
export function createUsersKind({ dataRoot, platform = process.platform, env = process.env, helper = USERS_HELPER, exec, start, wait = ms => new Promise(r => setTimeout(r, ms)), lookup = name => dns.promises.lookup(name, { all: true }), now = Date.now } = {}) {
  const jars = new Map(), prompts = new Map(), consents = new Map();
  let permits = [];
  const scope = usersScope(dataRoot);
  const promptDir = path.join(dataRoot, 'private', 'users');
  const runHelper = exec ?? ((file, args, input, timeoutMs) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (stdout ? resolve(String(stdout)) : reject(error ?? new Error('no answer'))));
    child.stdin?.end(input ?? '');
  }));
  const startHelper = start ?? ((file, args) => spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }));
  const base = (mode, host) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', mode, '-HostName', host, '-Scope', scope];
  const entryArgs = p => [...(p.kind ? ['-Kind', p.kind] : []), ...(p.entry ? ['-Entry', p.entry] : [])];
  async function helperCall(args, input, executed, timeoutMs = HELPER_MS) {
    let stdout;
    try { stdout = await runHelper(powershell(env), args, input, timeoutMs); }
    catch { throw new AgentError('USERS_PRIVATE_REQUEST_FAILED', 'The private Users helper did not finish; no automatic retry.', { executed }); }
    let value = null;
    try { value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch { /* below */ }
    if (value?.ok === true) return value;
    const code = typeof value?.code === 'string' && /^USERS_[A-Z_]{1,60}$/.test(value.code) ? value.code : 'USERS_PRIVATE_REQUEST_FAILED';
    throw new AgentError(code, FAILURES[code] ?? 'The private Users request failed; no automatic retry.', { executed: code === 'USERS_HOST_NOT_AUTHENTICATED' ? false : executed });
  }
  // Every request: what the name resolves to now. A short cache, so a page's requests do not each ask.
  const resolved = new Map();
  async function publicHost(host) {
    const known = resolved.get(host);
    if (known && now() - known < 60000) return;
    let addresses;
    try { addresses = await lookup(host); } catch { throw refuse('USERS_HOST_UNRESOLVED', FAILURES.USERS_HOST_UNRESOLVED); }
    if (!addresses?.length) throw refuse('USERS_HOST_UNRESOLVED', FAILURES.USERS_HOST_UNRESOLVED);
    if (addresses.some(item => isPrivateAddress(item.address))) throw refuse('USERS_HOST_PRIVATE', FAILURES.USERS_HOST_PRIVATE);
    resolved.set(host, now());
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
  const hasConsent = host => (consents.get(host) ?? 0) > now();
  // What a window the person filled gives: a prompt's status file says saved only after the vault has it.
  function settle() {
    for (const [key, record] of prompts) {
      let phase = null;
      try { phase = fs.readFileSync(record.statusFile, 'utf8'); } catch { /* not yet, or gone */ }
      if (phase === 'saved' && !record.applied) {
        record.applied = true;
        if (record.kind === 'password') permits.push({ host: record.host, page: record.action === 'create' ? '/Users/User_Edit.aspx' : `/Users/User_Show.aspx?UserId=${record.userId}`, posts: 3, until: now() + PASSWORD_PERMIT_MS, entry: record.entry });
        else consents.set(record.host, now() + CONSENT_MS);
      }
      if ((record.child.exitCode ?? null) !== null) { fs.rmSync(record.statusFile, { force: true }); prompts.delete(key); }
    }
  }
  function usePermit(host, page, entries) {
    permits = permits.filter(item => item.until > now() && item.posts > 0);
    const permit = permits.find(item => item.host === host && item.page === page && entries.every(entry => item.entry === entry) && (entries.length > 0 || true));
    if (!permit) throw refuse('USERS_CONSENT_REQUIRED', 'No person on this machine approved this change, so it was not sent.');
    permit.posts -= 1;
    if (entries.length) permit.posts = 0;
  }
  async function confirm(p) {
    await publicHost(p.host);
    const stored = await helperCall(base('status', p.host), '', false);
    if (stored.available !== true) throw refuse('USERS_HOST_NOT_AUTHENTICATED', FAILURES.USERS_HOST_NOT_AUTHENTICATED);
    const rule = CONFIRM[p.action];
    const rows = [{ label: 'Environment', value: p.host }, { label: 'Signed in as', value: stored.principal ?? '' }, { label: 'What will happen', value: rule.text }];
    if (rule.user) rows.push({ label: 'User id', value: p.userId });
    if (p.labels?.user) rows.push({ label: 'User name', value: p.labels.user, data: true });
    if (rule.target) rows.push({ label: rule.target, value: p.targetId });
    if (p.labels?.target) rows.push({ label: rule.target.replace(' id', ' name'), value: p.labels.target, data: true });
    for (const [key, value] of Object.entries(p.changes ?? {})) rows.push({ label: 'New ' + key, value });
    const input = Buffer.from(JSON.stringify({ rows })).toString('base64');
    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'confirm', '-HostName', p.host, '-Scope', scope];
    let answer;
    try { answer = await helperCall(args, input, false, CONFIRM_MS); }
    catch { throw refuse('USERS_CONFIRMATION_TIMEOUT', 'No answer from the person on this machine, so nothing was sent.'); }
    if (answer.approved !== true) throw refuse(answer.timedOut ? 'USERS_CONFIRMATION_TIMEOUT' : 'USERS_CONFIRMATION_DECLINED', answer.timedOut ? 'No answer from the person on this machine, so nothing was sent.' : 'The person on this machine declined, so nothing was sent.');
    if (p.action === 'sign-in') consents.set(p.host, now() + CONSENT_MS);
    else permits.push({ host: p.host, page: `/Users/${rule.page}.aspx?UserId=${p.userId}`, posts: 3, until: now() + PERMIT_MS });
    return { approved: true };
  }
  async function openPrompt(p) {
    const key = [p.host, p.kind ?? 'login', p.entry ?? ''].join('|');
    settle();
    if (prompts.has(key)) return { opened: false, alreadyOpen: true };
    fs.mkdirSync(promptDir, { recursive: true });
    const statusFile = path.join(promptDir, 'prompt-' + randomUUID() + '.status');
    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'prompt', '-HostName', p.host, '-Scope', scope, ...entryArgs(p),
      '-Subject', p.subject ?? '', '-PromptStatusPath', statusFile];
    const child = startHelper(powershell(env), args);
    prompts.set(key, { child, statusFile, host: p.host, kind: p.kind ?? 'login', entry: p.entry, action: p.action, userId: p.userId, applied: false });
    child.on?.('error', () => prompts.delete(key));
    // The status file stays until the window closes: it says saved only then.
    child.on?.('exit', () => settle());
    child.unref?.();
    for (let waited = 0; waited < PROMPT_WAIT_MS; waited += 100) {
      if (fs.existsSync(statusFile)) {
        const phase = fs.readFileSync(statusFile, 'utf8');
        if (phase === 'visible' || phase === 'saved') { settle(); return { opened: true, alreadyOpen: false, visible: true, ...(phase === 'saved' ? { saved: true } : {}) }; }
      }
      if ((child.exitCode ?? null) !== null) break;
      await wait(100);
    }
    settle();
    fs.rmSync(statusFile, { force: true });
    prompts.delete(key);
    throw new AgentError('USERS_PROMPT_NOT_VISIBLE', 'The private window could not be confirmed visible.', { executed: null });
  }
  const forget = (host, entry) => helperCall([...base('forget', host), '-Kind', 'password', '-Entry', entry], '', false);
  return {
    async execute(params) {
      if (platform !== 'win32') throw refuse('USERS_PLATFORM_UNAVAILABLE', 'Users administration is not available on this platform.');
      validateUsersRequest(params);
      settle();
      const { op, host } = params;
      if (op === 'status') {
        const value = await helperCall([...base('status', host), ...entryArgs(params)], '', false);
        return { available: value.available === true, principal: typeof value.principal === 'string' ? value.principal : null, consent: hasConsent(host) };
      }
      if (op === 'confirm') return confirm(params);
      if (op === 'login') {
        if (!hasConsent(host)) throw refuse('USERS_LOGIN_CONSENT_REQUIRED', 'No person on this machine approved signing in to this environment, so nothing was sent.');
        await publicHost(host);
        const value = await helperCall(base('login', host), '', null);
        storeCookies(host, value.setCookie);
        return { authenticated: value.authenticated === true };
      }
      if (op === 'forget') { await helperCall([...base('forget', host), ...entryArgs(params)], '', false); return {}; }
      if (op === 'prompt') {
        await publicHost(host);
        if ((params.kind ?? 'login') === 'login') {
          // The person decides on a window; a name built to pass for an approved one never gets a window.
          const { hosts = [] } = await helperCall(base('hosts', host), '', false);
          if (lookalikeOf(host, hosts)) throw refuse('USERS_HOST_LOOKALIKE', FAILURES.USERS_HOST_LOOKALIKE);
          jars.delete(host);
        } else {
          const stored = await helperCall(base('status', host), '', false);
          if (stored.available !== true) throw refuse('USERS_HOST_NOT_AUTHENTICATED', FAILURES.USERS_HOST_NOT_AUTHENTICATED);
        }
        return openPrompt(params);
      }
      if (!hasConsent(host)) throw refuse('USERS_LOGIN_CONSENT_REQUIRED', 'No person on this machine approved signing in to this environment, so nothing was sent.');
      await publicHost(host);
      // Only the two searches post without a yes. Every other form needs the person's yes for this page.
      if (params.method === 'POST') {
        const target = new URL(params.url);
        if (!/^\/Users\/(?:User_List|Inactive_Users)\.aspx$/.test(target.pathname) || params.secretRefs?.length)
          usePermit(host, target.pathname + target.search, [...new Set((params.secretRefs ?? []).map(ref => ref.entry))]);
      }
      let forgotten = true;
      const input = Buffer.from(JSON.stringify({ url: params.url, method: params.method, fields: params.fields ?? [], secretRefs: params.secretRefs ?? [], cookie: cookieHeader(host) })).toString('base64');
      const passwords = [...new Set((params.secretRefs ?? []).filter(ref => ref.kind === 'password').map(ref => ref.entry))];
      let value;
      try { value = await helperCall(base('request', host), input, null); }
      finally { for (const entry of passwords) await forget(host, entry).catch(() => { forgotten = false; }); }
      storeCookies(host, value.setCookie);
      // The session stays here: the answer has no setCookie. A new password was for this one POST, whatever the server does next.
      return { status: value.status, location: value.location ?? '', contentType: value.contentType ?? '', body: value.body ?? '', ...(passwords.length ? { passwordForgotten: forgotten } : {}) };
    },
  };
}

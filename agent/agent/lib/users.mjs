// The kind o11.users (fase4-28 r4, docs/FASE2-AGENTE.md 4.4): the Users application of an O11 environment through this machine. What can
// sign in never leaves it: the administrator's password and new passwords are entries of this Windows account's Credential Manager, typed
// only in a private window (users-vault.ps1), and the session cookies live in this process's memory. The server reads pages and keeps
// receipts, and it never builds a POST: it names an operation and its ids, and the agent reads the real page, builds the request from
// the table of users-page.mjs and shows the person what it will send. No field carries a password or a cookie, in either direction.
// The HTTP goes only to https://<host>/Users/ of a host the person approved in a window, never redirected. Windows only: elsewhere the kind
// answers USERS_PLATFORM_UNAVAILABLE, and the Hello still lists it, so the server can say that instead of "update your agent".
//
// params: {op:'status', host, kind?, entry?} -> {available, principal, consent}
//         {op:'prompt', host, kind?, entry?, action?, userId?, changes?} -> {opened, alreadyOpen, visible?, saved?}
//         {op:'confirm', host, action:'sign-in'} -> {approved:true}: the person's yes to signing in, for 8 hours, in memory
//         {op:'login', host} -> {authenticated}: the helper signs in by itself; the server chooses no field and sees no page
//         {op:'request', host, url} -> {status, location, contentType, body} (the three texts in base64): a GET of a mapped page
//         {op:'search', host, inactive?, text?} -> the same: the one POST without a window
//         {op:'write', host, action, userId?, targetId?, changes?, entry?} -> the same: a window with what will be sent, then that POST.
//              Without a yes nothing goes (USERS_CONFIRMATION_DECLINED, USERS_CONFIRMATION_TIMEOUT). create and set-password have the window that
//              took the password for that exact user, or nothing goes (USERS_CONSENT_REQUIRED).
//         {op:'forget', host, kind:'password', entry} -> {}
//         {op:'sign-out', host} -> {signedOut}
// Refusals happen before anything is started. The table of what passes is shared with the native core (check-users-request).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentError, refuse } from './errors.mjs';
import { ACTIONS, PageNotKnown, planWrite, planSavePassword, planSearch, plainValue, isLoginPage, userPage, parsePage } from './users-page.mjs';

export const USERS_KIND = 'o11.users';
export const USERS_HELPER = fileURLToPath(new URL('./users-vault.ps1', import.meta.url));
const KEYS = Object.freeze({ status: ['op', 'host', 'kind', 'entry'], prompt: ['op', 'host', 'kind', 'entry', 'action', 'userId', 'changes'], confirm: ['op', 'host', 'action'],
  login: ['op', 'host'], 'sign-out': ['op', 'host'], request: ['op', 'host', 'url'], search: ['op', 'host', 'inactive', 'text'],
  write: ['op', 'host', 'action', 'userId', 'targetId', 'changes', 'entry'], forget: ['op', 'host', 'kind', 'entry'] });
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ENTRY = /^[a-f0-9]{64}$/;
const PAGE = /^\/Users\/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\.aspx)?$/;
const QUERY = /^(?:(?:UserId|GroupId|RoleId|ApplicationId)=[1-9][0-9]{0,18})?$/;
const MAX_PAGE_BASE64 = Math.ceil(262144 / 3) * 4 + 8;
const PROMPT_WAIT_MS = 12000, HELPER_MS = 45000;
const ID = /^[1-9][0-9]{0,18}$/;
const CHANGE_LIMITS = Object.freeze({ name: 256, username: 250, email: 250, phone: 20 });
const CONSENT_MS = 8 * 3600 * 1000, PASSWORD_PERMIT_MS = 300000, CONFIRM_MS = 130000;
const WINDOWS_MAX = 20, REFUSALS_MAX = 3, WINDOWS_MS = 600000;
// Stops well before the lockout of the Users application: two wrong passwords, then a person.
const LOGIN_FAILURES_MAX = 2;
const SWEEP_HOST = 'sweep.invalid';

const invalid = message => refuse('PARAMS_INVALID', message);
const text = value => typeof value === 'string';
// A name only a private network can resolve, a service that resolves to any address it is given.
const INTERNAL = /\.(?:localhost|local|localdomain|internal|intranet|lan|home|corp|svc|arpa|nip\.io|sslip\.io|xip\.io)$/;
const INTERNAL_TEXT = 'This name is only reachable inside a private network, and Users administration through the agent works only with environments on the internet. Nothing was sent. Use the Users application of that environment directly.';
const hostProblem = host => {
  if (!text(host) || !HOST.test(host) || host.split('.').some(label => label.startsWith('xn--'))) return invalid('host must be the plain DNS name of an environment, like name.example.com: no scheme, port, address or other alphabet');
  const last = host.split('.').at(-1);
  if (last.length < 2 || /^[0-9]+$|^0x/.test(last)) return invalid('host must be the plain DNS name of an environment, like name.example.com: no scheme, port, address or other alphabet');
  if (INTERNAL.test(host)) return refuse('USERS_HOST_INTERNAL', INTERNAL_TEXT);
  return null;
};
// The sixteen bytes of an IPv6 address.
function ipv6Bytes(address) {
  let head = address.toLowerCase(), v4 = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(head);
  if (dotted) { head = dotted[1] + '0:0'; v4 = dotted[2].split('.').map(Number); }
  const [left, right] = head.split('::');
  const part = value => (value ? value.split(':').flatMap(group => { const n = parseInt(group, 16); return [n >> 8, n & 255]; }) : []);
  const a = part(left), b = right === undefined ? [] : part(right);
  const bytes = [...a, ...new Array(Math.max(0, 16 - a.length - b.length)).fill(0), ...b];
  if (v4.length) bytes.splice(12, 4, ...v4);
  return bytes;
}
const privateV4 = ([a, b, c]) => a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
// A resolved address that is not on the internet: this machine, a private network, link-local (cloud metadata), multicast, or an IPv6 form
// that carries one of those inside it (mapped, compatible, NAT64, 6to4).
export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) return privateV4(address.split('.').map(Number));
  if (kind !== 6) return true;
  const b = ipv6Bytes(address);
  const zeros = n => b.slice(0, n).every(x => x === 0);
  if (zeros(16) || (zeros(15) && b[15] === 1)) return true;
  if ((zeros(10) && b[10] === 255 && b[11] === 255) || zeros(12)) return privateV4(b.slice(12));
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return privateV4(b.slice(12));
  if (b[0] === 0x20 && b[1] === 0x02) return privateV4(b.slice(2, 6));
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) || b[0] === 0xff;
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
function validChanges(changes, needsNew) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('changes are name, username, email and phone');
  const keys = Object.keys(changes);
  if (keys.length === 0) throw invalid('changes are name, username, email and phone');
  for (const key of keys) {
    if (!Object.hasOwn(CHANGE_LIMITS, key)) throw invalid('changes are name, username, email and phone');
    if (!plainValue(changes[key], CHANGE_LIMITS[key])) throw invalid(`changes.${key} must be plain text: within its limit, one line, no invisible characters or repeated spaces, because the window shows exactly what is sent`);
  }
  if (needsNew && (!changes.username || !changes.name)) throw invalid('a new user needs its name and username');
}

// What may run, checked before anything is started (the table tests/native/users.test.mjs shares with the native core).
export function validateUsersRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
  if (!text(params.op) || !Object.hasOwn(KEYS, params.op)) throw invalid('op must be status, prompt, confirm, login, request, search, write, forget or sign-out');
  for (const key of Object.keys(params)) if (!KEYS[params.op].includes(key)) throw invalid('unknown parameter ' + key);
  const problem = hostProblem(params.host);
  if (problem) throw problem;
  const op = params.op;
  if (op === 'login' || op === 'sign-out') return;
  if (op === 'confirm') { if (params.action !== 'sign-in') throw invalid('the only yes asked by itself is the sign-in: a write opens its own window'); return; }
  if (op === 'request') {
    const url = params.url;
    if (!text(url) || url.length > 2048 || !url.startsWith(`https://${params.host}/`) || /[\\\s\u0000-\u001f]|%2e|%2f|%5c/i.test(url)) throw invalid('url is not a Users page of the host');
    const rest = url.slice(`https://${params.host}`.length), mark = rest.indexOf('?');
    if (rest.includes('#') || !PAGE.test(mark < 0 ? rest : rest.slice(0, mark)) || !QUERY.test(mark < 0 ? '' : rest.slice(mark + 1))) throw invalid('url is not a Users page of the host');
    return;
  }
  if (op === 'search') {
    if (params.inactive !== undefined && typeof params.inactive !== 'boolean') throw invalid('inactive is true or false');
    if (params.text !== undefined && (!text(params.text) || params.text.length > 256)) throw invalid('text is what to search for');
    return;
  }
  if (op === 'write') {
    if (!text(params.action) || !Object.hasOwn(ACTIONS, params.action)) throw invalid('this operation does not exist in this agent');
    const action = params.action;
    if (action === 'create' ? params.userId !== undefined : !(text(params.userId) && ID.test(params.userId))) throw invalid('userId is a number as text');
    if (['grant-role', 'add-group'].includes(action) ? !(text(params.targetId) && ID.test(params.targetId)) : params.targetId !== undefined) throw invalid('targetId is a number as text, on a role or a group');
    if (action === 'update' || action === 'create') validChanges(params.changes, action === 'create'); else if (params.changes !== undefined) throw invalid('changes belong to update and create');
    if (action === 'create' || action === 'set-password' ? !(text(params.entry) && ENTRY.test(params.entry)) : params.entry !== undefined) throw invalid('entry names the new password of create or set-password');
    return;
  }
  const kind = params.kind ?? 'login';
  if (kind !== 'login' && kind !== 'password') throw invalid('kind must be login or password');
  if (kind === 'password' ? !(text(params.entry) && ENTRY.test(params.entry)) : params.entry !== undefined) throw invalid('entry belongs to kind password, 64 hex');
  if (op === 'forget' && kind !== 'password') throw invalid('only a new password is forgotten');
  if (op === 'prompt') {
    if (kind === 'login') { if (params.action !== undefined || params.userId !== undefined || params.changes !== undefined) throw invalid('the sign-in window takes only a host'); return; }
    if (params.action === 'set-password') { if (!(text(params.userId) && ID.test(params.userId)) || params.changes !== undefined) throw invalid('set-password names the user by its id, and the agent reads who that is'); return; }
    if (params.action !== 'create') throw invalid('a new password is for create or set-password');
    if (params.userId !== undefined) throw invalid('a new user has no id');
    validChanges(params.changes, true);
  }
}

// The vault scope: this installation and this account of the server. Its entries are its own: another token on this installation inherits
// nothing, and an SSAM installed on the same Windows account is apart. No account in tests.
const short = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
export const usersScope = (dataRoot, account = '') => short(path.resolve(dataRoot).toLowerCase()) + short('account|' + account);
const powershell = env => path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const FAILURES = Object.freeze({
  USERS_PAGE_TOO_LARGE: 'This page is larger than a Users page can be; it was not read.',
  USERS_LOGIN_LAYOUT_CHANGED: 'The sign-in page of this environment is not the one this agent knows; nothing was sent.',
  USERS_HOST_LOOKALIKE: 'This name reads like an environment already approved on this machine, so no window was opened and nothing was sent. If it really is another environment, sign out of the other one first.',
  USERS_HOST_PRIVATE: 'This environment resolves to an address that is not on the internet, so nothing was sent.',
  USERS_HOST_UNRESOLVED: 'This environment does not resolve, so nothing was sent.',
  USERS_HOST_NOT_AUTHENTICATED: 'No Users administrator is stored for this environment on this machine; nothing was sent.',
});
const LOGIN_PAUSED = 'Signing in failed twice, so it stopped before the Users application locks this administrator. A person signs in again in the window of this agent, or checks the account in the Users application first.';

// exec(file, args, input, timeoutMs) -> stdout, start(file, args) -> a child: the tests' seams.
export function createUsersKind({ dataRoot, account = '', platform = process.platform, env = process.env, helper = USERS_HELPER, exec, start, wait = ms => new Promise(r => setTimeout(r, ms)), lookup = name => dns.promises.lookup(name, { all: true }), now = Date.now, permitMs = PASSWORD_PERMIT_MS } = {}) {
  const jars = new Map(), prompts = new Map(), consents = new Map();
  let permits = [];
  const scope = usersScope(dataRoot, account);
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
    throw new AgentError(code, FAILURES[code] ?? 'The private Users request failed; no automatic retry.', { executed: code === 'USERS_HOST_NOT_AUTHENTICATED' || code === 'USERS_LOGIN_LAYOUT_CHANGED' ? false : executed });
  }
  // What a name resolves to now, with a short cache so a page's requests do not each ask.
  const resolved = new Map();
  async function publicHost(host) {
    const known = resolved.get(host);
    if (known !== undefined && now() - known < 60000) return;
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
  // One window at a time; a person who keeps saying no is not asked again for a while; and a ceiling, so a window is never a way to wear a
  // person down. A yes does not count against the second: approving seven changes is work, not pressure. A closed window is a no.
  let confirming = false, opened = [], refusals = [];
  function takeWindow() {
    settle();
    if (confirming || prompts.size > 0) throw refuse('USERS_WINDOW_BUSY', 'Another window of this agent is open: answer that one first.');
    opened = opened.filter(at => now() - at < WINDOWS_MS);
    refusals = refusals.filter(at => now() - at < WINDOWS_MS);
    if (opened.length >= WINDOWS_MAX || refusals.length >= REFUSALS_MAX) throw refuse('USERS_WINDOW_LIMIT', 'Too many windows in a few minutes, so no other was opened.');
    opened.push(now());
  }
  const hasConsent = host => (consents.get(host) ?? 0) > now();
  const needConsent = host => { if (!hasConsent(host)) throw refuse('USERS_LOGIN_CONSENT_REQUIRED', 'No person on this machine approved signing in to this environment, so nothing was sent.'); };
  // The sign-in brake survives a restart: a file of this agent, with a host and a count and nothing else. A try counts before it leaves, whatever
  // happens after, since the password may have reached the site. Only a person's window, or a sign-in that a page then proves, resets it: an answer
  // of the helper can be wrong (a redirect to an error page), and a page alone says nothing about the tries in between.
  const failuresFile = path.join(promptDir, 'sign-in-failures.json');
  const readFailures = () => { try { return JSON.parse(fs.readFileSync(failuresFile, 'utf8')); } catch { return {}; } };
  const failuresOf = host => Number(readFailures()[scope + '|' + host]) || 0;
  function setFailures(host, count) {
    const all = readFailures();
    if ((Number(all[scope + '|' + host]) || 0) === count) return;
    if (count > 0) all[scope + '|' + host] = count; else delete all[scope + '|' + host];
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(failuresFile, JSON.stringify(all));
  }
  const unproven = new Set();
  // A sign-in that said yes may read the page that proves it, even as the last try.
  const notPaused = (host, tryingAgain = false) => { if (failuresOf(host) >= LOGIN_FAILURES_MAX && (tryingAgain || !unproven.has(host))) throw refuse('USERS_LOGIN_PAUSED', LOGIN_PAUSED); };
  // A new password in the vault is useful only under its permit. So it leaves by itself when the permit ends, with no other call; and a mark on
  // disk says one may be there, so an agent that closed before that removes it when it starts. Without a mark, starting runs nothing.
  const pendingFile = path.join(promptDir, 'passwords-pending');
  let forgetFailed = false, writing = 0;
  function clearPending() {
    if (forgetFailed || writing > 0 || permits.length > 0 || [...prompts.values()].some(record => record.kind === 'password')) return;
    fs.rmSync(pendingFile, { force: true });
  }
  async function forgetEntry(host, entry) {
    permits = permits.filter(item => !(item.host === host && item.entry === entry));
    try { await helperCall([...base('forget', host), '-Kind', 'password', '-Entry', entry], '', false); } catch (error) { forgetFailed = true; throw error; }
    clearPending();
  }
  async function expire(permit) {
    if (!permits.includes(permit)) return;
    try { await forgetEntry(permit.host, permit.entry); } catch { /* the mark stays, and the next start sweeps */ }
  }
  let started = null;
  const startup = () => (started ??= (async () => {
    if (platform !== 'win32' || !fs.existsSync(pendingFile)) return;
    try { await helperCall(base('sweep', SWEEP_HOST), '', false); fs.rmSync(pendingFile, { force: true }); } catch { /* the next start */ }
  })());
  // What a window the person filled gives: a prompt's status file says saved only after the vault has it.
  function settle() {
    for (const [key, record] of prompts) {
      let phase = null;
      try { phase = fs.readFileSync(record.statusFile, 'utf8'); } catch { /* not yet, or gone */ }
      if (phase) record.phase = phase;
      if (phase === 'saved' && !record.applied) {
        record.applied = true;
        if (record.kind === 'password') {
          // A second window for the same password replaces the first, and the first one's timer finds nothing.
          permits = permits.filter(item => !(item.host === record.host && item.entry === record.entry));
          const permit = { host: record.host, action: record.action, userId: record.userId, changes: record.changes, entry: record.entry, until: now() + permitMs };
          permits.push(permit);
          setTimeout(() => expire(permit), permitMs).unref?.();
        }
        else { consents.set(record.host, now() + CONSENT_MS); setFailures(record.host, 0); }
      }
      if ((record.child.exitCode ?? null) !== null) {
        if (!record.applied) refusals.push(now());
        fs.rmSync(record.statusFile, { force: true });
        prompts.delete(key);
        if (record.kind === 'password') clearPending();
      }
    }
  }
  function usePermit(p) {
    const at = permits.findIndex(item => item.until > now() && item.host === p.host && item.action === p.action && item.entry === p.entry && item.userId === p.userId && JSON.stringify(item.changes ?? null) === JSON.stringify(p.changes ?? null));
    if (at < 0) throw refuse('USERS_CONSENT_REQUIRED', 'No person on this machine approved this exact change in a window, so it was not sent.');
    permits.splice(at, 1);
  }
  async function ask(host, rows) {
    const input = Buffer.from(JSON.stringify({ rows })).toString('base64');
    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'confirm', '-HostName', host, '-Scope', scope];
    takeWindow();
    confirming = true;
    let answer;
    try { answer = await helperCall(args, input, false, CONFIRM_MS); }
    catch { refusals.push(now()); throw refuse('USERS_CONFIRMATION_TIMEOUT', 'No answer from the person on this machine, so nothing was sent.'); }
    finally { confirming = false; }
    if (answer.approved === true) return;
    refusals.push(now());
    throw refuse(answer.timedOut ? 'USERS_CONFIRMATION_TIMEOUT' : 'USERS_CONFIRMATION_DECLINED', answer.timedOut ? 'No answer from the person on this machine, so nothing was sent.' : 'The person on this machine declined, so nothing was sent.');
  }
  async function storedLogin(host) {
    const stored = await helperCall(base('status', host), '', false);
    if (stored.available !== true) throw refuse('USERS_HOST_NOT_AUTHENTICATED', FAILURES.USERS_HOST_NOT_AUTHENTICATED);
    return stored;
  }
  async function confirmSignIn(host) {
    await publicHost(host);
    const stored = await storedLogin(host);
    await ask(host, [{ label: 'Environment', value: host }, { label: 'Signed in as', value: stored.principal ?? '' }, { label: 'What will happen', value: 'Sign in to the Users application of this environment' }]);
    consents.set(host, now() + CONSENT_MS);
    return { approved: true };
  }
  async function openPrompt(p) {
    const key = [p.host, p.kind ?? 'login', p.entry ?? ''].join('|');
    settle();
    if (prompts.has(key)) return { opened: false, alreadyOpen: true };
    let subject = '', rows = [];
    if ((p.kind ?? 'login') === 'password') {
      if (p.action === 'set-password') {
        // Who this is comes from the environment's own page of that id, never from the request.
        const page = await readPage(p.host, userPage(p.userId));
        const plan = planWrite({ action: 'set-password', host: p.host, userId: p.userId }, [page]);
        subject = plan.username;
        rows = plan.rows;
      } else {
        subject = p.changes.username;
        rows = [{ label: 'What will happen', value: ACTIONS.create.text }, ...Object.entries(p.changes).map(([name, value]) => ({ label: 'New ' + name, value }))];
      }
    }
    takeWindow();
    fs.mkdirSync(promptDir, { recursive: true });
    const statusFile = path.join(promptDir, 'prompt-' + randomUUID() + '.status');
    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'prompt', '-HostName', p.host, '-Scope', scope, ...entryArgs(p),
      '-Subject', subject, '-Rows', Buffer.from(JSON.stringify(rows)).toString('base64'), '-PromptStatusPath', statusFile];
    if ((p.kind ?? 'login') === 'password') fs.writeFileSync(pendingFile, '');
    const child = startHelper(powershell(env), args);
    const record = { child, statusFile, host: p.host, kind: p.kind ?? 'login', entry: p.entry, action: p.action, userId: p.userId, changes: p.changes, applied: false, phase: null };
    prompts.set(key, record);
    child.on?.('error', () => prompts.delete(key));
    // The status file stays until the window closes: it says saved only then.
    child.on?.('exit', () => settle());
    child.unref?.();
    // A window that was shown counts, even if it has already closed by the time this looks.
    for (let waited = 0; waited < PROMPT_WAIT_MS; waited += 100) {
      settle();
      if (record.phase === 'visible' || record.phase === 'saved') return { opened: true, alreadyOpen: false, visible: true, ...(record.phase === 'saved' ? { saved: true } : {}) };
      if ((child.exitCode ?? null) !== null) break;
      await wait(100);
    }
    fs.rmSync(statusFile, { force: true });
    prompts.delete(key);
    throw new AgentError('USERS_PROMPT_NOT_VISIBLE', 'The private window could not be confirmed visible.', { executed: null });
  }
  // One request of this agent, with this agent's session. A page that asks to sign in again ends that session.
  async function send(host, url, method, fields = [], secretRefs = []) {
    const input = Buffer.from(JSON.stringify({ url, method, fields, secretRefs, cookie: cookieHeader(host) })).toString('base64');
    const value = await helperCall(base('request', host), input, method === 'POST' ? null : false);
    // A larger answer would go through the server's disk as a blob, and stop the server that reads it.
    if ((value.body ?? '').length > MAX_PAGE_BASE64) throw new AgentError('USERS_PAGE_TOO_LARGE', FAILURES.USERS_PAGE_TOO_LARGE, { executed: method === 'POST' ? null : false });
    storeCookies(host, value.setCookie);
    const html = Buffer.from(value.body ?? '', 'base64').toString('utf8');
    if (isLoginPage(html)) { jars.delete(host); unproven.delete(host); } else if (value.status === 200 && unproven.delete(host)) setFailures(host, 0);
    return { status: value.status, location: value.location ?? '', contentType: value.contentType ?? '', body: value.body ?? '', html };
  }
  const answerOf = ({ status, location, contentType, body }) => ({ status, location, contentType, body });
  async function readPage(host, route) {
    const page = await send(host, `https://${host}${route}`, 'GET');
    if (page.status !== 200 || isLoginPage(page.html)) throw new PageNotKnown(route);
    return page.html;
  }
  const secretRefsOf = (plan, entry) => plan.secretFields.map(field => ({ field, kind: 'password', entry, part: 'password' }));
  // The operation as this agent will send it. The window comes from this same plan.
  async function write(p) {
    const { host, action } = p;
    needConsent(host);
    notPaused(host);
    await publicHost(host);
    const passwordOp = action === 'create' || action === 'set-password';
    if (passwordOp) { usePermit(p); writing++; }
    // From here a new password has had its one chance: it leaves the vault however this ends.
    let pending = passwordOp;
    const forgetPassword = async () => { pending = false; writing--; try { await forgetEntry(host, p.entry); return true; } catch { return false; } };
    try {
    const stored = passwordOp ? null : await storedLogin(host);
    const routes = ACTIONS[action].read(p);
    const pages = [];
    for (const route of routes) pages.push(await readPage(host, route));
    const plan = planWrite(p, pages);
    if (action === 'deactivate' && stored.principal && plan.username.toLowerCase() === String(stored.principal).toLowerCase()) throw refuse('USERS_SELF_LOCKOUT_REFUSED', 'The administrator signed in here cannot be deactivated from here.');
    if (!passwordOp) await ask(host, [{ label: 'Environment', value: host }, { label: 'Signed in as', value: stored.principal ?? '' }, ...plan.rows]);
    let answer;
    if (action === 'set-password') {
      const shown = await send(host, plan.url, 'POST', plan.fields);
      const save = planSavePassword(p, pages[0], shown.html);
      answer = await send(host, save.url, 'POST', save.fields, secretRefsOf(save, p.entry));
    } else answer = await send(host, plan.url, 'POST', plan.fields, passwordOp ? secretRefsOf(plan, p.entry) : []);
    const value = answerOf(answer);
    if (passwordOp) value.passwordForgotten = await forgetPassword();
    return value;
    } finally { if (pending) await forgetPassword(); }
  }
  return {
    startup,
    async execute(params) {
      if (platform !== 'win32') throw refuse('USERS_PLATFORM_UNAVAILABLE', 'Users administration is not available on this platform.');
      validateUsersRequest(params);
      await startup();
      settle();
      for (const permit of permits.filter(item => item.until <= now())) await expire(permit);
      const { op, host } = params;
      if (op === 'status') {
        const value = await helperCall([...base('status', host), ...entryArgs(params)], '', false);
        return { available: value.available === true, principal: typeof value.principal === 'string' ? value.principal : null, consent: hasConsent(host) };
      }
      if (op === 'sign-out') {
        jars.delete(host); consents.delete(host); permits = permits.filter(item => item.host !== host); setFailures(host, 0);
        await helperCall(base('sign-out', host), '', false);
        clearPending();
        return { signedOut: true };
      }
      if (op === 'confirm') return confirmSignIn(host);
      if (op === 'forget') { await forgetEntry(host, params.entry); return {}; }
      if (op === 'prompt') {
        await publicHost(host);
        if ((params.kind ?? 'login') === 'login') {
          // The person decides on a window; a name built to pass for an approved one never gets a window.
          const { hosts = [] } = await helperCall(base('hosts', host), '', false);
          if (lookalikeOf(host, hosts)) throw refuse('USERS_HOST_LOOKALIKE', FAILURES.USERS_HOST_LOOKALIKE);
          jars.delete(host);
        } else await storedLogin(host);
        return openPrompt(params);
      }
      needConsent(host);
      notPaused(host);
      if (op === 'write') return write(params);
      await publicHost(host);
      if (op === 'login') {
        notPaused(host, true);
        setFailures(host, failuresOf(host) + 1);
        unproven.delete(host);
        let value;
        // Only a helper that says it sent nothing gives the try back.
        try { value = await helperCall(base('login', host), '', null); } catch (error) { if (error.executed === false) setFailures(host, Math.max(0, failuresOf(host) - 1)); throw error; }
        storeCookies(host, value.setCookie);
        const authenticated = value.authenticated === true;
        if (authenticated) unproven.add(host);
        return { authenticated };
      }
      if (op === 'request') return answerOf(await send(host, params.url, 'GET'));
      const route = `/Users/${params.inactive ? 'Inactive_Users' : 'User_List'}.aspx`;
      const plan = planSearch({ host, inactive: params.inactive === true, text: params.text ?? '' }, await readPage(host, route));
      return answerOf(await send(host, plan.url, 'POST', plan.fields));
    },
  };
}
// parsePage is here for the checks of the shared tables.
export { parsePage };

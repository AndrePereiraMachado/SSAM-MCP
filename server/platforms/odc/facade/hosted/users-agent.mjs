// o11_users on a hosted server (fase4-28 r4). The Users application has no API: it is a WebForms site, its administrator
// signs in with a password, and the session is a cookie. The split:
//   - The user's SSAM agent holds what can sign in: the administrator's password and new passwords (its own Windows vault
//     entries, typed only in a private window on that machine) and the session cookies (in the agent's memory). It runs the
//     HTTP requests itself, only to the environment the person signed in to in that vault (kind o11.users).
//   - This server reads the pages and keeps the receipts. Neither a password nor a cookie ever reaches it: the kind has no
//     field that carries one, in either direction, and setCookie is dropped here even if an agent sends it.
//   - The pages and the people in them (names, e-mails, roles) pass through and go in the answer of the call. They are not
//     kept: a receipt on disk has ids and hashes only (minimalReceipt) and leaves after RECEIPT_TTL_MS (sweepUsersState).
//   - Everything is per token: the folder is <workspace>/state/users, outside what ws: paths can name, the sessions of
//     o11-users.mjs are keyed by the token, and the call goes to this token's own agent link.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { guardWrite } from '../service-center/auth.mjs';
import { UsersError, AgentUsersClient } from '../users/client.mjs';

export const USERS_KIND = 'o11.users';
// The SSAM agents that run the kind. Older agents get USERS_AGENT_UPDATE_REQUIRED and nothing runs.
export const USERS_AGENT_VERSIONS = Object.freeze({ node: '0.3.5', native: '0.4.2-native' });
// A receipt keeps its operation UUID from being sent twice, so it must outlive a weekend with an unanswered "uncertain";
// after 7 days nobody resends that UUID, and the receipt holds nothing but ids and hashes until then. A deletion preview
// (local only: T2 keeps deletes off here) lasts its own 10 minutes and is swept with the rest.
export const RECEIPT_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_PAGE_BASE64 = Math.ceil(262144 / 3) * 4 + 8;
const NO_AGENT_NEEDED = new Set(['capabilities', 'receipt']);
const CONTINUATION = Object.freeze({ tool: 'o11_access', arguments: { action: 'users' },
  why: 'Reads the end users of the environment and their roles without administering them; it changes nothing.' });

// The parsed sessions of one hosted session: they go with it, and with it the link to its agent.
const sessionsOf = new WeakMap(), typedOf = new WeakMap();
export const usersRootOf = context => path.join(context.workspace, 'state', 'users');

// What keys the hashes of an account (receipts, password references). It is not in the account's folder: a copy of a workspace, an export
// or a path out of it carries the hashes without what opens them. One secret of the server, beside tokens.json, and one key per token from
// it. Who reads the whole disk of the server has it too, as with tokens.json: this does not defend against that.
//
// A receipt is found by this key, so a new key finds none, and a UUID sent before would run again. So while a receipt of another key can exist,
// no new key is made and nothing that needs one runs: not the key missing, not a different one. It clears by itself when those receipts end
// (sweepUsersState), or when the key comes back. .key-check says which key wrote this folder, and opens nothing.
const KEY_MISSING = 'This server has receipts of Users changes that it cannot read: the key they were written with is missing or is another one. So no Users change runs, because a recent one could be sent twice. Nothing was sent. The owner of the server restores that key; otherwise this clears by itself when those receipts end, within 7 days. Reading users still works.';
const keyMissing = () => Object.assign(new UsersError('USERS_RECEIPT_KEY_MISSING', KEY_MISSING), { notSent: true });
function holdsReceipts(root) {
  let items;
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  return items.some(item => (item.isDirectory() ? holdsReceipts(path.join(root, item.name)) : item.name.endsWith('.json')));
}
const anyReceipts = serverFolder => {
  let accounts = [];
  try { accounts = fs.readdirSync(path.join(serverFolder, 'customers'), { withFileTypes: true }).filter(item => item.isDirectory()); } catch { /* none */ }
  return accounts.some(item => holdsReceipts(path.join(serverFolder, 'customers', item.name, 'state', 'users')));
};
const readSecret = serverFolder => { try { const known = fs.readFileSync(path.join(serverFolder, 'users-hmac.key')); return known.length === 32 ? known : null; } catch { return null; } };
// For the server's own log: the owner hears of it before a customer does. Only what the disk shows: another key is seen when it refuses.
export const usersKeyLost = serverFolder => !readSecret(serverFolder) && anyReceipts(serverFolder);
export const USERS_KEY_LINE = 'o11_users changes are refused (USERS_RECEIPT_KEY_MISSING): receipts exist that users-hmac.key does not open, or the key is missing. Restore that key from the same backup as customers/. Otherwise this clears by itself when those receipts end, within 7 days. See docs/USERS-ENDPOINTS-O11.md, Backup.';
function serverUsersSecret(serverFolder) {
  const file = path.join(serverFolder, 'users-hmac.key'), known = readSecret(serverFolder);
  if (known) return known;
  if (anyReceipts(serverFolder)) throw keyMissing();
  fs.mkdirSync(serverFolder, { recursive: true });
  try { fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFileSync(file);
}
export function usersKeyOf(context) {
  const key = createHmac('sha256', serverUsersSecret(path.dirname(path.dirname(context.workspace)))).update('users|' + (context.tokenId ?? context.id)).digest();
  const root = usersRootOf(context), check = path.join(root, '.key-check'), expected = createHmac('sha256', key).update('check').digest('hex');
  let known = null;
  try { known = fs.readFileSync(check, 'utf8'); } catch { /* first use */ }
  if (known !== expected) {
    if (holdsReceipts(root)) throw keyMissing();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(check, expected, { mode: 0o600 });
  }
  return key;
}

// Why this call cannot run on the account's agent, or null. Nothing here falls back to this machine.
export function usersAgentRefusal(context, operation) {
  if (NO_AGENT_NEEDED.has(operation)) return null;
  if (Array.isArray(context.lanes) && !context.lanes.includes('o11'))
    return { ok: false, code: 'HOSTED_LANE_OFF', outcome: 'not-sent', error: 'The O11 lane is off for this account, so Users administration did not run.' };
  let version = null, supported = false;
  try { version = context.agent?.info?.()?.agentVersion ?? null; supported = context.agent?.supports?.(USERS_KIND) === true; } catch { supported = false; }
  if (supported) return null;
  return { ok: false, code: 'USERS_AGENT_UPDATE_REQUIRED', outcome: 'not-sent',
    error: `The SSAM agent of this account (${version ?? 'an older version'}) does not run Users administration yet, so nothing was sent. Update the SSAM agent, then call this again.`,
    continuation: CONTINUATION };
}

const FIXED = Object.freeze({
  'USERS_PLATFORM_UNAVAILABLE': 'Users administration is not available on this platform: it needs the Windows Credential Manager of the machine that runs the SSAM agent. Use the Users application of the environment.',
  'USERS_HOST_NOT_AUTHENTICATED': 'The SSAM agent has no Users administrator stored for this environment, so nothing was sent. Sign in first (operation sign-in with prompt:true).',
  'USERS_HOST_LOOKALIKE': 'This name reads like an environment already approved on the user\'s machine, so no window was opened and nothing was sent. Check the host; if this really is another environment, end the approved one first (operation sign-out on that host).',
  'USERS_HOST_INTERNAL': 'This is an internal name, reachable only inside a private network, and Users administration through the SSAM agent works only with environments on the internet, so no window was opened and nothing was sent. Use the public DNS name of the environment if it has one, or its Users application directly.',
  'USERS_HOST_PRIVATE': 'This environment resolves to an address that is not on the internet, so nothing was sent.',
  'USERS_HOST_UNRESOLVED': 'This environment does not resolve, so nothing was sent. Check the host.',
  'USERS_PAGE_TOO_LARGE': 'This page is larger than a Users page can be; it was not read.',
  'USERS_LOGIN_LAYOUT_CHANGED': 'The sign-in page of this environment is not the one the SSAM agent knows; nothing was sent.',
  'USERS_CONFIRMATION_DECLINED': 'The person on the machine of the SSAM agent declined, so nothing was sent. Do not ask again unless the person says so.',
  'USERS_CONFIRMATION_TIMEOUT': 'No answer from the person on the machine of the SSAM agent, so nothing was sent. Do not ask again unless the person says so.',
  'USERS_LOGIN_CONSENT_REQUIRED': 'No person on the machine of the SSAM agent approved signing in to this environment, so nothing was sent. Call without prompt:false to ask for it in a window there.',
  'USERS_CONSENT_REQUIRED': 'No person on the machine of the SSAM agent approved this exact change in its password window, so it was not sent. Ask for the window again.',
  'USERS_PAGE_NOT_KNOWN': 'The page of this environment does not have exactly what the SSAM agent knows for this operation, so no window was opened and nothing was sent. Use the Users application of the environment.',
  'USERS_PASSWORD_FORM_NOT_KNOWN': 'The Set Password button was sent, but what came back is not the password form the SSAM agent knows. The new password was not sent, and it left the vault. Read the user; never resend this operation.',
  'USERS_SELF_LOCKOUT_REFUSED': 'The administrator signed in on the SSAM agent cannot be deactivated through it.',
  'USERS_WINDOW_BUSY': 'Another window of the SSAM agent is open on the user\'s machine: the person answers that one first. Nothing was sent.',
  'USERS_WINDOW_LIMIT': 'Too many windows of the SSAM agent in a few minutes, so no other was opened and nothing was sent. Wait, and ask the person.',
  'USERS_PROMPT_NOT_VISIBLE': 'The private window could not be confirmed visible on the user\'s machine. No credential was requested in chat.',
  'USERS_PRIVATE_REQUEST_FAILED': 'The helper of the SSAM agent on the user\'s machine could not finish this step. No automatic retry was sent.',
  'USERS_LOGIN_PAUSED': 'Two sign-ins failed, so the SSAM agent stopped trying, to keep the administrator from being locked out. Nothing was sent. The person checks the account in the Users application, then saves it again in the window (operation sign-in with prompt:true), or ends it (operation sign-out).',
  'PARAMS_INVALID': 'The SSAM agent refused this Users request before anything was sent.',
});
// One fixed text per code: what the agent or a page said never becomes an error here.
function agentFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'USERS_AGENT_FAILED';
  const failure = new UsersError(/^[A-Z][A-Z0-9_]{1,60}$/.test(code) ? code : 'USERS_AGENT_FAILED',
    FIXED[code] ?? 'The SSAM agent could not finish this Users request. No automatic retry was sent.');
  if (code === 'USERS_PLATFORM_UNAVAILABLE') failure.continuation = CONTINUATION;
  // The agent said nothing went out: the receipt of this write has nothing to keep.
  if (error?.executed === false) failure.notSent = true;
  return failure;
}

// What o11-users.mjs takes in deps, on the account's own agent and folder.
export function hostedUsersDeps(context) {
  const root = usersRootOf(context);
  const call = async (params, timeoutMs = 60000) => {
    try { return await context.agent.call(USERS_KIND, params, { timeoutMs }); } catch (error) { throw agentFailure(error); }
  };
  // Whatever an agent sends: a page over the limit is not read, so one account cannot stop the process the others share, and the session stays
  // in the agent: the request carries no cookie and any setCookie in the answer is dropped here.
  const pageOf = async answer => {
    const value = await answer;
    if (String(value?.body ?? '').length > MAX_PAGE_BASE64) throw new UsersError('USERS_PAGE_TOO_LARGE', FIXED.USERS_PAGE_TOO_LARGE);
    return { status: value?.status, location: value?.location, contentType: value?.contentType, body: value?.body, setCookie: [], ...(value?.passwordForgotten === false ? { passwordForgotten: false } : {}) };
  };
  if (!sessionsOf.has(context)) sessionsOf.set(context, new Map());
  if (!typedOf.has(context)) typedOf.set(context, new Map());
  return { root, key: () => usersKeyOf(context), sessionScope: 'token:' + (context.tokenId ?? context.id), sessions: sessionsOf.get(context), typed: typedOf.get(context), minimalReceipts: true,
    confirm: host => call({ op: 'confirm', host, action: 'sign-in' }, 135000),
    // A write opens its window on the agent's machine, so it can wait for the person: two minutes and a little.
    makeClient: (http, host) => new AgentUsersClient(http, {
      search: request => pageOf(call({ op: 'search', host, ...request })),
      write: request => pageOf(call({ op: 'write', host, ...request }, 200000)),
    }),
    // No registry of this server decides anything about a customer's environment: every host needs its name in the words.
    guardWrite: (host, words, confirmHost) => guardWrite(host, words, confirmHost, [], path.join(root, 'no-hosts-registry.json')),
    privateCall: async (mode, host, extra = {}, input = null) => {
      if (mode === 'status') {
        const value = await call({ op: 'status', host, kind: extra.Kind ?? 'login', ...(extra.Entry ? { entry: extra.Entry } : {}) });
        return { ok: true, available: value?.available === true, consent: value?.consent === true, principal: typeof value?.principal === 'string' ? value.principal : null };
      }
      if (mode === 'sign-out') { await call({ op: 'sign-out', host }); return { ok: true }; }
      if (mode === 'login') { const value = await call({ op: 'login', host }); return { ok: true, authenticated: value?.authenticated === true }; }
      if (mode === 'forget') { await call({ op: 'forget', host, kind: extra.Kind ?? 'password', entry: extra.Entry }); return { ok: true }; }
      // Only pages are read through here: every POST of this tool is the agent's, under its table.
      if (mode !== 'request' || input?.method !== 'GET') throw new UsersError('USERS_AGENT_FAILED', 'Unknown mode of the private Users call.');
      return { ok: true, ...await pageOf(call({ op: 'request', host, url: input.url })) };
    },
    openPrompt: async (host, { kind = 'login', entry, action, userId, changes } = {}) => {
      const value = await call({ op: 'prompt', host, kind, ...(entry ? { entry } : {}), ...(action ? { action } : {}), ...(userId ? { userId } : {}), ...(changes ? { changes } : {}) }, 30000);
      return { opened: value?.opened === true, alreadyOpen: value?.alreadyOpen === true, ...(value?.visible === true ? { visible: true } : {}), ...(value?.saved === true ? { saved: true } : {}) };
    } };
}

// A receipt as it is kept: what stops a second send and says what happened, no person and no page, and no hash of who signed in or of the
// words, which nothing here asks for. The request's hash is keyed (usersKeyOf); the host is not kept (the folder is its keyed name).
export function minimalReceipt(receipt, { now = Date.now() } = {}) {
  const { result } = receipt;
  return { schema: receipt.schema, operation: receipt.operation, operationId: receipt.operationId, requestHash: receipt.requestHash,
    state: receipt.state, ...(receipt.ok !== undefined ? { ok: receipt.ok } : {}),
    ...(receipt.code ? { code: receipt.code } : {}), startedAt: receipt.startedAt, ...(receipt.finishedAt ? { finishedAt: receipt.finishedAt } : {}),
    ...(typeof result?.changed === 'boolean' ? { changed: result.changed } : {}), ...(result?.passwordVerified === false ? { passwordVerified: false } : {}),
    ...(typeof (result?.user?.id) === 'string' ? { userId: result.user.id } : {}), ...(typeof receipt.passwordForgotten === 'boolean' ? { passwordForgotten: receipt.passwordForgotten } : {}), expiresAt: new Date(now + RECEIPT_TTL_MS).toISOString(), detailsKept: false };
}

// An answer over its budget would be kept in a file of the workspace (answer-size.mjs): a read with people in it is cut to fit
// and says so, so it is never kept. The narrower search brings the rest.
export const USERS_ANSWER_BYTES = 3584;
const bytesOf = value => Buffer.byteLength(JSON.stringify(value));
const MAX_TEXT = 256;
const capped = value => typeof value === 'string' ? (value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '...' : value)
  : Array.isArray(value) ? value.map(capped) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capped(v)])) : value;
export function fitHostedAnswer(answer) {
  if (!answer || typeof answer !== 'object' || bytesOf(answer) <= USERS_ANSWER_BYTES) return answer;
  const fitted = capped(answer);
  if (bytesOf(fitted) <= USERS_ANSWER_BYTES) return fitted;
  const lists = [fitted.users, fitted.user?.roles, fitted.user?.groups].filter(Array.isArray);
  let cut = 0;
  for (const list of lists) while (list.length && bytesOf(fitted) > USERS_ANSWER_BYTES - 120) { list.pop(); cut++; }
  if (Array.isArray(fitted.validation)) fitted.validation = fitted.validation.slice(0, 1);
  return { ...fitted, complete: false, truncated: cut, next: 'Narrow it with search, or read one user with get.' };
}

// The whole server, on a timer of the HTTP server (http-server.mjs): the term of a receipt does not wait for its account to come back.
export function sweepAllUsersState(customersRoot, options = {}) {
  let removed = 0, accounts = [];
  try { accounts = fs.readdirSync(customersRoot, { withFileTypes: true }).filter(item => item.isDirectory()); } catch { return 0; }
  for (const account of accounts) removed += sweepUsersState(path.join(customersRoot, account.name, 'state', 'users'), options);
  return removed;
}

// The one way out of this tool on a hosted server: nothing of it goes to a kept answer, whatever it is. A value that does not fit even so
// (arguments echoed by a refusal) is replaced, not kept.
export function answerNeverKept(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  let value = result.structuredContent;
  if (value === undefined) { try { value = JSON.parse(result.content.find(item => item?.type === 'text')?.text); } catch { value = null; } }
  if (!value || typeof value !== 'object') value = { ok: false, code: 'USERS_ANSWER_TOO_LARGE', error: 'This answer could not be read back; nothing of it was kept.' };
  let fitted = fitHostedAnswer(value);
  if (bytesOf(fitted) > USERS_ANSWER_BYTES) fitted = { ok: false, code: value.code ?? 'USERS_ANSWER_TOO_LARGE', error: 'This answer is too large to show and is never kept. Send shorter arguments, or narrow the search.' };
  return { content: [{ type: 'text', text: JSON.stringify(fitted) }], structuredContent: fitted, ...(fitted.ok === false ? { isError: true } : {}) };
}

// Removes what has expired under the account's folder, a temporary file of a dead write and the folders left empty. Only this tool's
// own files; a failure removes nothing more. The key of the folder stays while the folder has anything else.
export function sweepUsersState(root, { now = Date.now(), ttlMs = RECEIPT_TTL_MS } = {}) {
  let removed = 0;
  const walk = dir => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { walk(file); try { fs.rmdirSync(file); } catch { /* not empty */ } continue; }
      const age = (() => { try { return now - fs.statSync(file).mtimeMs; } catch { return -1; } })();
      const expired = item.name.endsWith('.json') ? age > ttlMs : item.name.endsWith('.tmp') ? age > 3600000 : false;
      if (expired) try { fs.rmSync(file, { force: true }); removed++; } catch { /* the next sweep */ }
    }
  };
  walk(root);
  return removed;
}

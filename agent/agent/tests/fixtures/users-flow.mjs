// The behaviour of the kind o11.users as a table of steps, run on the Node agent (tests/users.test.mjs) and on the native core
// (tests/native/users.test.mjs, check-users-flow) against the same stand-in for the helper. Each run compares its answers and what went out
// with the table. A change to either agent that lets a POST out without its window fails here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOST = 'tenant-a.example.test';
const SCRIPT = fileURLToPath(new URL('./users-fake-helper.mjs', import.meta.url));
const ENTRY = 'a'.repeat(64);
const url = rest => `https://${HOST}/Users/${rest}`;
const signIn = { params: { op: 'confirm', host: HOST, action: 'sign-in' } }, login = { params: { op: 'login', host: HOST }, expect: { authenticated: true } };
const ready = [signIn, login];
const write = (action, over = {}) => ({ params: { op: 'write', host: HOST, action, ...over } });
// Every window of this flow has closed, and the agent has seen it: an event, not a time, so a loaded machine cannot change the answer.
const WAIT = { settled: true };
// Starting state of the stand-in: an approved environment, a person who says yes, two users.
export const initialState = () => ({ vault: { login: { [HOST]: { user: 'admin@example.invalid', secret: 'x' } }, passwords: {} }, answers: [], promptAnswers: [], loginAnswers: [], windows: [], http: [], calls: [],
  users: { 42: { id: '42', name: 'Ana Silva', username: 'ana.silva', email: 'ana@example.invalid', active: true }, 7: { id: '7', name: 'Administrator', username: 'admin@example.invalid', email: 'admin@example.invalid', active: true } } });
const windowsLabelled = rows => Object.fromEntries(rows.map(row => [row.label, row.value + (row.data ? ' (data)' : '')]));

export const flows = () => [
  { name: 'M2: no window, no sign-in and no page', steps: [
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
    { params: { op: 'search', host: HOST }, expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
    { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
  ], check: s => { if (s.logins || s.http.length) throw new Error('something went out'); } },
  { name: 'M2: the yes to sign in, and then a page; no ends it', state: { answers: ['no'] }, steps: [
    { ...signIn, expect: { code: 'USERS_CONFIRMATION_DECLINED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
    { ...signIn, expect: { approved: true } }, login,
    { params: { op: 'status', host: HOST }, expect: { available: true, principal: 'admin@example.invalid', consent: true } },
    { params: { op: 'request', host: HOST, url: url('User_Show.aspx?UserId=42') }, expect: { status: 200 } },
    { advanceMs: 8 * 3600 * 1000 + 1000 },
    { params: { op: 'request', host: HOST, url: url('User_Show.aspx?UserId=42') }, expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
  ] },
  { name: 'P1: a yes for what the agent will send: the window comes from the page, one POST, exactly that', steps: [...ready, { ...write('deactivate', { userId: '42' }), expect: { status: 200 } }], check: s => {
    const w = windowsLabelled(s.windows.at(-1));
    same(w, { Environment: HOST, 'Signed in as': 'admin@example.invalid', 'What will happen': 'Deactivate this user: the user loses access', 'User id': '42', Username: 'ana.silva (data)', Name: 'Ana Silva (data)' });
    same(s.http, [{ path: '/Users/User_Show.aspx?UserId=42', state: 'state-of-User_Show.aspx?UserId=42', fields: { 'x$wtNewRole': '', 'x$role': '', 'x$wtNewGroupInput': '', 'x$group': '', __EVENTTARGET: 'x$toggle', __EVENTARGUMENT: '', __AJAX: '1280,1024,x_wtEnableDisableLink,0,0,0,0,0,0,' }, secretFields: [], cookie: 'ASP.NET_SessionId=s1' }]);
    if (s.users[42].active) throw new Error('not applied');
  } },
  { name: 'P1: no is no, nothing goes and nothing retries', state: { answers: ['yes', 'no'] }, steps: [...ready, { ...write('grant-role', { userId: '42', targetId: '8' }), expect: { code: 'USERS_CONFIRMATION_DECLINED' } }], check: s => same(s.http, []) },
  { name: 'P1: no answer is no', state: { answers: ['yes', 'timeout'] }, steps: [...ready, { ...write('update', { userId: '42', changes: { email: 'n@example.invalid' } }), expect: { code: 'USERS_CONFIRMATION_TIMEOUT' } }], check: s => same(s.http, []) },
  { name: 'P1: a role: the name comes from the role page, and the POST carries that id and that name', steps: [...ready, { ...write('grant-role', { userId: '42', targetId: '8' }), expect: { status: 200 } }], check: s => {
    const w = windowsLabelled(s.windows.at(-1));
    same(w['Role id'], '8'); same(w.Role, 'Role 8 name (data)'); same(w.Username, 'ana.silva (data)');
    same(s.http[0].fields['x$role'], '8'); same(s.http[0].fields['x$wtNewRole'], 'Role 8 name'); same(s.http[0].fields['x$addRoleBtn'], 'Add');
    same(s.http[0].fields.__EVENTTARGET, undefined);
  } },
  { name: 'P1: a group goes to the fields of the group, never of the role', steps: [...ready, { ...write('add-group', { userId: '42', targetId: '4' }), expect: { status: 200 } }], check: s => {
    same(s.http[0].fields['x$group'], '4'); same(s.http[0].fields['x$role'], ''); same(s.http[0].fields['x$addGroupBtn'], 'Add'); same(s.http[0].fields['x$addRoleBtn'], undefined);
  } },
  { name: 'P1: update sends Save with the values shown, never Delete', steps: [...ready, { ...write('update', { userId: '42', changes: { email: 'n@example.invalid' } }), expect: { status: 200 } }], check: s => {
    const w = windowsLabelled(s.windows.at(-1));
    same(w['New email'], 'n@example.invalid'); same(w['Username now'], 'ana.silva (data)');
    same(s.http[0].path, '/Users/User_Edit.aspx?UserId=42'); same(s.http[0].fields['x$wtUser_Email'], 'n@example.invalid'); same(s.http[0].fields['x$wtUser_Name'], 'Ana Silva'); same(s.http[0].fields['x$save'], 'Save'); same(s.http[0].fields['x$del'], undefined);
  } },
  { name: 'P1: a page without what the table expects: no window and nothing sent, never a generic window', state: { noStatusLink: true }, steps: [...ready, { ...write('activate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.windows.length, 1); same(s.http, []); } },
  { name: 'P1: no Add for the role, even with the Add of the group next to it: no window and nothing sent', state: { noAdd: true }, steps: [...ready, { ...write('grant-role', { userId: '42', targetId: '8' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.windows.length, 1); same(s.http, []); } },
  { name: 'P1: the status it asks for is not the one on the page: nothing sent', steps: [...ready, { ...write('activate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => same(s.http, []) },
  { name: 'P1: the administrator of the session cannot be deactivated', steps: [...ready, { ...write('deactivate', { userId: '7' }), expect: { code: 'USERS_SELF_LOCKOUT_REFUSED' } }], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'P1: nothing the server names can post', steps: [...ready,
    { params: { op: 'request', host: HOST, url: url('User_Edit.aspx?UserId=42'), method: 'POST', fields: [['__EVENTTARGET', 'x$del']] }, expect: { code: 'PARAMS_INVALID' } },
    { params: { op: 'write', host: HOST, action: 'delete', userId: '42' }, expect: { code: 'PARAMS_INVALID' } },
    { params: { op: 'write', host: HOST, action: 'revoke-role', userId: '42', targetId: '8' }, expect: { code: 'PARAMS_INVALID' } },
    { params: { op: 'write', host: HOST, action: 'remove-group', userId: '42', targetId: '8' }, expect: { code: 'PARAMS_INVALID' } },
    { params: { op: 'write', host: HOST, action: 'activate', userId: '42', url: url('User_Edit.aspx?UserId=42') }, expect: { code: 'PARAMS_INVALID' } },
    { params: { op: 'write', host: HOST, action: 'activate', userId: '42', fields: [] }, expect: { code: 'PARAMS_INVALID' } },
  ], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'P1: the search is the one POST without a window, and it is built here', steps: [...ready, { params: { op: 'search', host: HOST, text: 'ana' }, expect: { status: 200 } }, { params: { op: 'search', host: HOST, inactive: true, text: 'x' }, expect: { status: 200 } }], check: s => {
    same(s.http.map(h => h.path), ['/Users/User_List.aspx', '/Users/Inactive_Users.aspx']); same(s.http[0].fields['x$wtSearchInput'], 'ana'); same(s.windows.length, 1);
  } },
  { name: 'R1: the password window names who the id really is, from the page', steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '7' }, expect: { opened: true, alreadyOpen: false, visible: true, saved: true } }, WAIT,
  ], check: s => { const w = s.windows.at(-1); same(w.subject, 'admin@example.invalid'); const rows = windowsLabelled(w.rows); same(rows['User id'], '7'); same(rows.Username, 'admin@example.invalid (data)'); } },
  { name: 'R1: a window for one user is no yes for another, and the request cannot name who it is', steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42', subject: 'someone' }, expect: { code: 'PARAMS_INVALID' } },
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' }, expect: { opened: true, alreadyOpen: false, visible: true, saved: true } }, WAIT,
    { ...write('set-password', { userId: '7', entry: ENTRY }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
    { ...write('set-password', { userId: '42', entry: 'b'.repeat(64) }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
  ], check: s => same(s.http, []) },
  { name: 'P4 and A1: set-password: two POSTs that the window paid for, the new password goes to its form, and leaves', steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' } }, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { status: 200, passwordForgotten: true } },
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
  ], check: s => {
    same(s.http.map(h => h.fields.__EVENTTARGET ?? null), ['x$setpw', null]); same(s.http[1].secretFields, ['x$wtNewPasswordInput', 'x$wtConfirmPasswordInput']); same(s.http[1].fields['x$savepw'], 'Save');
    same(Object.keys(s.vault.passwords), []);
  } },
  { name: 'P1: the password form that comes in an OsAjax reply', state: { ajaxPassword: true }, steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' } }, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { status: 200, passwordForgotten: true } },
  ], check: s => { same(s.http[1].state, 'new-state'); same(s.http[1].secretFields, ['x$wtNewPasswordInput', 'x$wtConfirmPasswordInput']); } },
  { name: 'P4: a create sends what the password window showed, and only that', steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'create', changes: { name: 'New Person', username: 'new.person', email: 'new@example.invalid' } } }, WAIT,
    { ...write('create', { entry: ENTRY, changes: { name: 'New Person', username: 'new.person', email: 'other@evil.example' } }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
    { ...write('create', { entry: ENTRY, changes: { name: 'New Person', username: 'new.person', email: 'new@example.invalid' } }), expect: { status: 200, passwordForgotten: true } },
  ], check: s => {
    const w = s.windows.at(-1); same(w.subject, 'new.person'); same(windowsLabelled(w.rows)['New email'], 'new@example.invalid');
    same(s.http.length, 1); same(s.http[0].path, '/Users/User_Edit.aspx'); same(s.http[0].fields['x$wtUser_Email'], 'new@example.invalid'); same(s.http[0].secretFields, ['x$wtPasswordInput', 'x$wtConfirmPasswordInput']); same(s.http[0].fields['x$wtPasswordInput'], undefined);
  } },
  { name: 'A1: a page that stops the write takes the password out too', steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' } }, WAIT,
    { set: { hugePage: true } },
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_PAGE_TOO_LARGE' } },
  ], check: s => same(Object.keys(s.vault.passwords), []) },
  { name: 'A1: a forget that fails is said', state: { forgetFails: true }, steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' } }, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { status: 200, passwordForgotten: false } },
  ] },
  { name: 'M5: three no in ten minutes stop the asking, and it comes back', state: { answers: ['yes', 'no', 'no', 'no'] }, steps: [...ready,
    { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_CONFIRMATION_DECLINED' } },
    { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_CONFIRMATION_DECLINED' } },
    { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_CONFIRMATION_DECLINED' } },
    { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_WINDOW_LIMIT' } },
    { advanceMs: 600001 },
    { ...write('deactivate', { userId: '42' }), expect: { status: 200 } },
  ] },
  { name: 'P4: closing a password window counts as a no', state: { promptAnswers: ['cancel', 'cancel', 'cancel'] }, steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' }, expect: { opened: true, alreadyOpen: false, visible: true } }, WAIT,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' }, expect: { opened: true, alreadyOpen: false, visible: true } }, WAIT,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' }, expect: { opened: true, alreadyOpen: false, visible: true } }, WAIT,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' }, expect: { code: 'USERS_WINDOW_LIMIT' } },
  ] },
  { name: 'A3: an approved host, a lookalike, an unresolved and a private one', steps: [
    { params: { op: 'prompt', host: 'tenant-a.example.test.evil.example' }, expect: { code: 'USERS_HOST_LOOKALIKE' } },
    { dns: ['10.0.0.5'] },
    { params: { op: 'prompt', host: 'other-company.example.test' }, expect: { code: 'USERS_HOST_PRIVATE' } },
    { dns: [] },
    { params: { op: 'prompt', host: 'other-company.example.test' }, expect: { code: 'USERS_HOST_UNRESOLVED' } },
    { dns: ['93.184.216.34'] },
    { params: { op: 'prompt', host: 'other-company.example.test' }, expect: { opened: true, alreadyOpen: false, visible: true, saved: true } }, WAIT,
  ], check: s => same(Object.keys(s.vault.login).sort(), ['other-company.example.test', HOST]) },
  { name: 'A3: the address is asked again after a minute: the cache has an end', steps: [...ready,
    { params: { op: 'request', host: HOST, url: url('User_Show.aspx?UserId=42') }, expect: { status: 200 } },
    { dns: ['10.0.0.5'] },
    { params: { op: 'request', host: HOST, url: url('User_Show.aspx?UserId=42') }, expect: { status: 200 } },
    { advanceMs: 61000 },
    { params: { op: 'request', host: HOST, url: url('User_Show.aspx?UserId=42') }, expect: { code: 'USERS_HOST_PRIVATE' } },
  ] },
  { name: 'M3: sign-out ends the stored administrator, and the next sign-in needs a new window', steps: [...ready,
    { params: { op: 'sign-out', host: HOST }, expect: { signedOut: true } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_CONSENT_REQUIRED' } },
    { ...signIn, expect: { code: 'USERS_HOST_NOT_AUTHENTICATED' } },
  ], check: s => same(s.vault.login[HOST], undefined) },
  { name: 'M9: a page over the limit does not leave the agent', state: { hugePage: true }, steps: [...ready, { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { code: 'USERS_PAGE_TOO_LARGE' } }] },
  { name: 'R4: two failed sign-ins stop the tries, without asking the site; a new password window goes on', state: { loginAnswers: [false, false, true] }, steps: [signIn,
    { params: { op: 'login', host: HOST }, expect: { authenticated: false } },
    { params: { op: 'login', host: HOST }, expect: { authenticated: false } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_PAUSED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_PAUSED' } },
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { code: 'USERS_LOGIN_PAUSED' } },
    { ...write('activate', { userId: '42' }), expect: { code: 'USERS_LOGIN_PAUSED' } },
    { params: { op: 'prompt', host: HOST }, expect: { opened: true, alreadyOpen: false, visible: true, saved: true } }, WAIT,
    { params: { op: 'login', host: HOST }, expect: { authenticated: true } },
  ], check: s => same(s.logins, 3) },
  { name: 'R4: a sign-in that says yes and a site that asks again count too', state: { loginAnswers: [true, true] }, steps: [signIn, login,
    { set: { loginPageNext: true } },
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } },
    login,
    { set: { loginPageNext: true } },
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_PAUSED' } },
  ], check: s => same(s.logins, 2) },
];
export function same(actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}
// A step's answer without the bytes of a page.
const normal = value => { if (value && Object.hasOwn(value, 'body')) { const { status, passwordForgotten } = value; return { status, ...(passwordForgotten !== undefined ? { passwordForgotten } : {}) }; } return value; };
export const stateFile = dir => path.join(dir, 'state.json');
export function prepare(dir, flow) {
  const base = initialState();
  fs.writeFileSync(stateFile(dir), JSON.stringify({ ...base, ...(flow.state ?? {}) }));
  return { ...process.env, SSAM_USERS_FAKE_STATE: stateFile(dir) };
}
export const readState = dir => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
export const patchState = (dir, patch) => fs.writeFileSync(stateFile(dir), JSON.stringify({ ...readState(dir), ...patch }));
// Checks the answers and the state against the table. results: {value} | {code} per step, with the bookkeeping steps as null.
export function verify(flow, results, state) {
  flow.steps.forEach((step, i) => {
    if (step.expect === undefined || !step.params) return;
    const got = results[i];
    same(got?.code ? { code: got.code } : normal(got?.value), step.expect);
  });
  flow.check?.(state);
}
// The Node agent over the stand-in.
export async function runNode(flow, createUsersKind, dir) {
  const env = prepare(dir, flow);
  let offset = 0, addresses = ['93.184.216.34'];
  const windows = [];
  const users = createUsersKind({ dataRoot: path.join(dir, 'data'), account: 'ssam_agent_flow', platform: 'win32', helper: 'fake', now: () => Date.now() + offset, wait: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))), lookup: async () => addresses.map(address => ({ address })),
    exec: (file, args, input) => new Promise((resolve, reject) => { const child = execFile(process.execPath, [SCRIPT, ...args], { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (stdout ? resolve(String(stdout)) : reject(error ?? new Error('no answer')))); child.stdin?.end(input ?? ''); }),
    start: (file, args) => { const child = spawn(process.execPath, [SCRIPT, ...args], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); windows.push(new Promise(done => child.on('exit', done))); return child; } });
  const results = [];
  for (const step of flow.steps) {
    if (step.advanceMs) { offset += step.advanceMs; results.push(null); continue; }
    if (step.dns) { addresses = step.dns; results.push(null); continue; }
    if (step.set) { patchState(dir, step.set); results.push(null); continue; }
    if (step.settled) { await Promise.all(windows); results.push(null); continue; }
    try { results.push({ value: await users.execute(step.params) }); } catch (error) { results.push({ code: error.code ?? 'THROWN ' + error.message }); }
  }
  return { results, state: readState(dir) };
}
// What the native core's check-users-flow reads: the same steps, without the checks.
export const nativeInput = (flow, dir) => ({ helper: [process.execPath, SCRIPT], root: path.join(dir, 'data'), account: 'ssam_agent_flow', statePath: stateFile(dir), steps: flow.steps.map(({ params, advanceMs, dns, set, settled }) => ({ params, advanceMs, dns, set, settled })) });
export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-users-flow-'));

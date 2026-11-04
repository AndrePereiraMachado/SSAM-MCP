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
const PASSWORD_WINDOW = { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'set-password', userId: '42' } };
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
    { params: { op: 'status', host: HOST }, expect: { available: true, principal: 'admin@example.invalid', consent: true, remembered: true } },
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
    { params: { op: 'prompt', host: 'other-company.example.test' }, expect: { opened: true, alreadyOpen: false, visible: true, saved: true, remembered: true } }, WAIT,
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
    { params: { op: 'prompt', host: HOST }, expect: { opened: true, alreadyOpen: false, visible: true, saved: true, remembered: true } }, WAIT,
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
  { name: 'C1: a helper that dies after the POST counts: the password may have reached the site', state: { loginAnswers: ['die', 'die', 'die'] }, steps: [signIn,
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_PRIVATE_REQUEST_FAILED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_PRIVATE_REQUEST_FAILED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_PAUSED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_PAUSED' } },
  ], check: s => same(s.logins, 2) },
  { name: 'C1: a page that answers 200 resets nothing: a live session and failing tries still stop', state: { loginAnswers: [true, false, false, true] }, steps: [signIn, login,
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } },
    { params: { op: 'login', host: HOST }, expect: { authenticated: false } },
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } },
    { params: { op: 'login', host: HOST }, expect: { authenticated: false } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_PAUSED' } },
  ], check: s => same(s.logins, 3) },
  { name: 'C1: a sign-in that a page proves clears the count: expiring sessions are not failures', state: { loginAnswers: [true, true, true, true] }, steps: [signIn, login,
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } }, login,
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } }, login,
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } }, login,
  ], check: s => same(s.logins, 4) },
  { name: 'C1: one wrong try and then the right one goes on: the page that proves it is read, and the count clears', state: { loginAnswers: [false, true, false] }, steps: [signIn,
    { params: { op: 'login', host: HOST }, expect: { authenticated: false } },
    login,
    { params: { op: 'request', host: HOST, url: url('User_List.aspx') }, expect: { status: 200 } },
    { params: { op: 'login', host: HOST }, expect: { authenticated: false } },
  ], check: s => same(s.logins, 3) },
  { name: 'C1: reading the login page is no try: it does not pause anybody', state: { loginAnswers: [true, true] }, steps: [signIn, login,
    { set: { loginPageNext: true } },
    { params: { op: 'request', host: HOST, url: url('Login.aspx') }, expect: { status: 200 } },
    { params: { op: 'request', host: HOST, url: url('Login.aspx') }, expect: { status: 200 } },
    { params: { op: 'request', host: HOST, url: url('Login.aspx') }, expect: { status: 200 } },
    login,
  ], check: s => same(s.logins, 2) },
  { name: 'C1: a sign-in page it does not know sent nothing, so it is no try', state: { loginAnswers: ['layout', 'layout', 'layout', true] }, steps: [signIn,
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_LAYOUT_CHANGED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_LAYOUT_CHANGED' } },
    { params: { op: 'login', host: HOST }, expect: { code: 'USERS_LOGIN_LAYOUT_CHANGED' } },
    login,
  ] },
  { name: 'C2: a saved window nobody used leaves by itself, with no other call', permitMs: 200, steps: [...ready, PASSWORD_WINDOW, WAIT,
    { waitFor: { forgets: 1 } },
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
  ], check: s => { same(Object.keys(s.vault.passwords), []); same(s.http, []); } },
  { name: 'C2: past its term it also leaves at the next call, whatever that call is', steps: [...ready, PASSWORD_WINDOW, WAIT,
    { advanceMs: 300001 },
    { params: { op: 'status', host: HOST }, expect: { available: true, principal: 'admin@example.invalid', consent: true, remembered: true } },
  ], check: s => same(Object.keys(s.vault.passwords), []) },
  { name: 'C2: a password forgotten is no permit: nothing can use the window after it', steps: [...ready, PASSWORD_WINDOW, WAIT,
    { params: { op: 'forget', host: HOST, kind: 'password', entry: ENTRY }, expect: {} },
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
  ], check: s => { same(Object.keys(s.vault.passwords), []); same(s.http, []); } },
  { name: 'C2: an agent that closed with a password in the vault removes it when it starts, once', steps: [...ready, PASSWORD_WINDOW, WAIT,
    { restart: true },
    { params: { op: 'status', host: HOST }, expect: { available: true, principal: 'admin@example.invalid', consent: false, remembered: true } },
    { restart: true },
    { params: { op: 'status', host: HOST }, expect: { available: true, principal: 'admin@example.invalid', consent: false, remembered: true } },
  ], check: s => { same(Object.keys(s.vault.passwords), []); same(s.sweeps, 1); } },
  { name: 'C2: nothing to sweep when no password window was open, was closed unsaved, or was used', state: { promptAnswers: ['cancel'] }, steps: [...ready,
    { restart: true }, { params: { op: 'status', host: HOST } },
    { ...signIn }, login, PASSWORD_WINDOW, WAIT,
    { restart: true }, { params: { op: 'status', host: HOST } },
    { ...signIn }, login, PASSWORD_WINDOW, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { status: 200, passwordForgotten: true } },
    { restart: true }, { params: { op: 'status', host: HOST } },
  ], check: s => same(s.sweeps, undefined) },
  { name: 'C2: a forget that failed leaves the mark, so the next start sweeps', state: { forgetFails: true }, steps: [...ready, PASSWORD_WINDOW, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { status: 200, passwordForgotten: false } },
    { set: { forgetFails: false } },
    { restart: true }, { waitFor: { sweeps: 1 } },
  ], check: s => same(Object.keys(s.vault.passwords), []) },
  { name: 'the button of set-password went and what came back is not the form: it says so, nothing more goes, and the password leaves', state: { noPasswordForm: true }, steps: [...ready, PASSWORD_WINDOW, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_PASSWORD_FORM_NOT_KNOWN', executed: null } },
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_CONSENT_REQUIRED' } },
  ], check: s => { same(s.http.length, 1); same(s.http[0].secretFields, []); same(Object.keys(s.vault.passwords), []); } },
  { name: 'a password box that is not one, in the form of the second step: the same, and the password goes nowhere', state: { textPassword: true }, steps: [...ready, PASSWORD_WINDOW, WAIT,
    { ...write('set-password', { userId: '42', entry: ENTRY }), expect: { code: 'USERS_PASSWORD_FORM_NOT_KNOWN', executed: null } },
  ], check: s => { same(s.http.length, 1); same(Object.keys(s.vault.passwords), []); } },
  // Pages of the review's attack table: a form or a control that is not exactly the table's sends nothing, on both agents.
  { name: 'R2: a form that posts to another user sends nothing', state: { formOf: 'User_Show.aspx?UserId=7' }, steps: [...ready, { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'R2: a form that posts to another page sends nothing', state: { formOf: 'User_Edit.aspx?UserId=42' }, steps: [...ready, { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'R2: a form that posts to another host sends nothing', state: { formOf: 'https://evil.example/Users/User_Show.aspx?UserId=42' }, steps: [...ready, { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'R2: two status links: nothing is chosen, nothing is sent', state: { twoStatusLinks: true }, steps: [...ready, { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'R2: two Save buttons: nothing is chosen, nothing is sent', state: { twoSaves: true }, steps: [...ready, { ...write('update', { userId: '42', changes: { email: 'n@example.invalid' } }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } }], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'R2: event fields the page brings do not go: only the event of the table', state: { hiddenEvent: true }, steps: [...ready, { ...write('deactivate', { userId: '42' }), expect: { status: 200 } }, { ...write('grant-role', { userId: '42', targetId: '8' }), expect: { status: 200 } }], check: s => {
    same(s.http[0].fields.__EVENTTARGET, 'x$toggle'); same(s.http[0].repeated, undefined);
    same(s.http[1].fields.__EVENTTARGET, undefined); same(s.http[1].fields.__EVENTARGUMENT, undefined); same(s.http[1].fields.__AJAX, undefined); same(s.http[1].repeated, undefined);
  } },
  { name: 'R2: no username on the page: no window with an invented one, and nothing sent', state: { noUsername: true }, steps: [...ready,
    { ...write('deactivate', { userId: '42' }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } },
    { ...PASSWORD_WINDOW, expect: { code: 'USERS_PAGE_NOT_KNOWN' } },
  ], check: s => { same(s.http, []); same(s.windows.length, 1); } },
  { name: 'R2: a create whose password box is not one sends nothing, and the password leaves', steps: [...ready,
    { params: { op: 'prompt', host: HOST, kind: 'password', entry: ENTRY, action: 'create', changes: { name: 'New Person', username: 'new.person' } } }, WAIT,
    { set: { textPasswordOnCreate: true } },
    { ...write('create', { entry: ENTRY, changes: { name: 'New Person', username: 'new.person' } }), expect: { code: 'USERS_PAGE_NOT_KNOWN' } },
  ], check: s => { same(s.http, []); same(Object.keys(s.vault.passwords), []); } },
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
    same(got?.code ? { code: got.code, ...(Object.hasOwn(step.expect, 'executed') ? { executed: got.executed ?? null } : {}) } : normal(got?.value), step.expect);
  });
  flow.check?.(state);
}
// Until the stand-in's state says so: an event again, with a limit only for a flow that is wrong.
async function reached(dir, target) {
  for (let waited = 0; waited < 60000; waited += 20) {
    let state = null;
    try { state = readState(dir); } catch { /* being written */ }
    if (state && Object.entries(target).every(([key, value]) => JSON.stringify(state[key]) === JSON.stringify(value))) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('never reached ' + JSON.stringify(target));
}
// The Node agent over the stand-in.
export async function runNode(flow, createUsersKind, dir) {
  const env = prepare(dir, flow);
  let offset = 0, addresses = ['93.184.216.34'];
  const windows = [];
  const make = () => createUsersKind({ dataRoot: path.join(dir, 'data'), account: 'ssam_agent_flow', platform: 'win32', helper: 'fake', permitMs: flow.permitMs, now: () => Date.now() + offset, wait: ms => new Promise(r => setTimeout(r, Math.min(ms, 20))), lookup: async () => addresses.map(address => ({ address })),
    exec: (file, args, input) => new Promise((resolve, reject) => { const child = execFile(process.execPath, [SCRIPT, ...args], { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (stdout ? resolve(String(stdout)) : reject(error ?? new Error('no answer')))); child.stdin?.end(input ?? ''); }),
    start: (file, args) => { const child = spawn(process.execPath, [SCRIPT, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); windows.push(new Promise(done => child.on('close', done))); return child; } });
  let users = make();
  const results = [];
  for (const step of flow.steps) {
    if (step.advanceMs) { offset += step.advanceMs; results.push(null); continue; }
    if (step.dns) { addresses = step.dns; results.push(null); continue; }
    if (step.set) { patchState(dir, step.set); results.push(null); continue; }
    if (step.settled) { await Promise.all(windows); results.push(null); continue; }
    if (step.restart) { users = make(); users.startup(); results.push(null); continue; }
    if (step.waitFor) { await reached(dir, step.waitFor); results.push(null); continue; }
    try { results.push({ value: await users.execute(step.params) }); } catch (error) { results.push({ code: error.code ?? 'THROWN ' + error.message, executed: error.executed }); }
  }
  return { results, state: readState(dir) };
}
// What the native core's check-users-flow reads: the same steps, without the checks.
export const nativeInput = (flow, dir) => ({ helper: [process.execPath, SCRIPT], root: path.join(dir, 'data'), account: 'ssam_agent_flow', statePath: stateFile(dir), permitMs: flow.permitMs, steps: flow.steps.map(({ params, advanceMs, dns, set, settled, restart, waitFor }) => ({ params, advanceMs, dns, set, settled, restart, waitFor })) });
export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-users-flow-'));

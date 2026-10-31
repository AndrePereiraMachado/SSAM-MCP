// A stand-in for users-vault.ps1, run as a process by the Node agent's and the native core's tests alike: a vault, a person and a Users site in a
// JSON file (SSAM_USERS_FAKE_STATE). No vault, no window and no network. It answers what the real helper answers, and logs what it was asked.
import fs from 'node:fs';

const file = process.env.SSAM_USERS_FAKE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
const arg = flag => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
const mode = arg('-Mode'), host = arg('-HostName'), kind = arg('-Kind') ?? 'login', entry = arg('-Entry');
const b64 = text => Buffer.from(text).toString('base64');
const done = value => { fs.writeFileSync(file, JSON.stringify(state)); process.stdout.write(JSON.stringify(value) + '\n'); process.exit(0); };
const input = () => Buffer.from(fs.readFileSync(0, 'utf8').trim(), 'base64').toString('utf8');
state.calls.push(mode);

const form = (action, body) => `<html><body><!-- <input name="commented" value="x"> --><form method="post" action="${action}"><input type="hidden" name="__OSVSTATE" value="state-of-${action}">${body}</form></body></html>`;
function show(u) {
  const link = state.noStatusLink ? '' : `<a id="x_wtEnableDisableLink" href="#" onclick="OsAjax(event,'x_wtEnableDisableLink','x$toggle','','__OSVSTATE,','');">${u.active ? 'Set as Inactive' : 'Set as Active'}</a>`;
  return form(`User_Show.aspx?UserId=${u.id}`, `<h1>${u.name}</h1>${link}<a id="x_wtSetPassword" href="#" onclick="OsAjax(event,'x_wtSetPassword','x$setpw','','__OSVSTATE,','');">Set Password</a>`
    + `<table id="x_wtUserShow"><tr><td>Username</td><td>${u.username}</td></tr><tr><td>Email</td><td>${u.email}</td></tr></table>`
    + `<div><input id="x_wtNewRole" name="x$wtNewRole"><input id="x_wttxtAutoCompleteValue" name="x$role">${state.noAdd ? '' : '<input id="x_addRole" type="submit" name="x$addRoleBtn" value="Add">'}</div>`
    + `<div><input id="x_wtNewGroupInput" name="x$wtNewGroupInput"><input id="y_wttxtAutoCompleteValue" name="x$group"><input id="y_add" type="submit" name="x$addGroupBtn" value="Add"></div>`);
}
const edit = u => form(`User_Edit.aspx${u ? '?UserId=' + u.id : ''}`, `<input id="x_wtUser_Name" name="x$wtUser_Name" value="${u?.name ?? ''}"><input id="x_wtUser_Username" name="x$wtUser_Username" value="${u?.username ?? ''}"><input id="x_wtUser_Email" name="x$wtUser_Email" value="${u?.email ?? ''}"><input id="x_wtUser_Phone" name="x$wtUser_Phone" value=""><input id="x_wtPasswordInput" name="x$wtPasswordInput" type="password"><input id="x_wtConfirmPasswordInput" name="x$wtConfirmPasswordInput" type="password"><input type="submit" name="x$save" value="Save"><input type="submit" name="x$del" value="Delete this User">`);
const list = page => form(page, `<input id="x_wtSearchInput" name="x$wtSearchInput"><input type="submit" name="x$search" value="Search"><table id="x_wtUserTable"></table>`);
const PASSWORD_INPUTS = `<input id="x_wtNewPasswordInput" name="x$wtNewPasswordInput" type="${state.textPassword ? 'text' : 'password'}"><input id="x_wtConfirmPasswordInput" name="x$wtConfirmPasswordInput" type="password"><input type="submit" name="x$savepw" value="Save">`;
const passwordForm = u => form(`User_Show.aspx?UserId=${u.id}`, PASSWORD_INPUTS);
const login = () => form('Login.aspx', '<input type="text" name="u"><input type="password" name="p"><input type="submit" name="go" value="Log In">');

if (mode === 'status') {
  if (kind === 'password') done({ ok: true, available: Boolean(state.vault.passwords[host + '|' + entry]), principal: null });
  const found = state.vault.login[host];
  done({ ok: true, available: Boolean(found), principal: found?.user ?? null });
}
if (mode === 'hosts') done({ ok: true, hosts: Object.keys(state.vault.login) });
if (mode === 'forget') {
  state.forgets = (state.forgets ?? 0) + 1;
  if (state.forgetFails) done({ ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED' });
  delete state.vault.passwords[host + '|' + entry];
  done({ ok: true });
}
if (mode === 'sweep') {
  state.sweeps = (state.sweeps ?? 0) + 1;
  state.vault.passwords = {};
  done({ ok: true });
}
if (mode === 'sign-out') {
  delete state.vault.login[host];
  for (const key of Object.keys(state.vault.passwords)) if (key.startsWith(host + '|')) delete state.vault.passwords[key];
  done({ ok: true });
}
if (mode === 'confirm') {
  const rows = JSON.parse(input()).rows;
  state.windows.push(rows);
  const answer = state.answers.shift() ?? 'yes';
  done({ ok: true, approved: answer === 'yes', timedOut: answer === 'timeout' });
}
if (mode === 'prompt') {
  const statusFile = arg('-PromptStatusPath');
  state.windows.push({ prompt: kind, subject: arg('-Subject'), rows: JSON.parse(Buffer.from(arg('-Rows') ?? 'W10=', 'base64').toString('utf8')) });
  const answer = state.promptAnswers.shift() ?? 'saved';
  // One write of the status: an agent that looks between two writes would answer differently on a loaded machine.
  if (answer === 'saved') {
    if (kind === 'login') state.vault.login[host] = { user: 'admin@example.invalid', secret: 'x' };
    else state.vault.passwords[host + '|' + entry] = true;
  }
  fs.writeFileSync(statusFile, answer === 'saved' ? 'saved' : 'visible');
  done({ ok: true });
}
if (!state.vault.login[host]) done({ ok: false, code: 'USERS_HOST_NOT_AUTHENTICATED' });
if (mode === 'login') {
  const signed = state.loginAnswers.shift() ?? true;
  if (signed === 'layout') done({ ok: false, code: 'USERS_LOGIN_LAYOUT_CHANGED' });
  state.logins = (state.logins ?? 0) + 1;
  // The POST went out, and the process dies before it can say so.
  if (signed === 'die') { fs.writeFileSync(file, JSON.stringify(state)); process.exit(1); }
  done({ ok: true, authenticated: signed, setCookie: signed ? [b64('ASP.NET_SessionId=s' + state.logins + '; path=/')] : [] });
}
if (mode === 'request') {
  const r = JSON.parse(input());
  const url = new URL(r.url), id = url.searchParams.get('UserId'), fields = new Map(r.fields ?? []);
  const named = Object.fromEntries((r.fields ?? []).filter(([k]) => k !== '__OSVSTATE'));
  if (r.method === 'POST') state.http.push({ path: url.pathname + url.search, state: fields.get('__OSVSTATE'), fields: named, secretFields: (r.secretRefs ?? []).map(ref => ref.field), cookie: r.cookie });
  const reply = (html, status = 200, location = '') => done({ ok: true, status, location: b64(location), contentType: b64('text/html'), setCookie: [], body: b64(html) });
  if (state.loginPageNext) { state.loginPageNext = false; reply(login()); }
  if (!r.cookie) reply(login());
  if (state.hugePage) reply('x'.repeat(400000));
  const u = id ? state.users[id] : null;
  if (url.pathname.endsWith('/Role_Show.aspx')) reply(form('Role_Show.aspx', `<h1>Role ${url.searchParams.get('RoleId')} name</h1>`));
  if (url.pathname.endsWith('/Group_Show.aspx')) reply(form('Group_Show.aspx', `<h1>Group ${url.searchParams.get('GroupId')} name</h1>`));
  if (/\/(?:User_List|Inactive_Users)\.aspx$/.test(url.pathname)) reply(list(url.pathname.split('/').at(-1)));
  if (url.pathname.endsWith('/User_Edit.aspx')) reply(edit(u));
  if (url.pathname.endsWith('/User_Show.aspx')) {
    if (r.method === 'POST') {
      if (fields.get('__EVENTTARGET') === 'x$toggle') u.active = !u.active;
      if (fields.get('__EVENTTARGET') === 'x$setpw' && !state.noPasswordForm) reply(state.ajaxPassword ? `OsJSONUpdate(${JSON.stringify({ hidden: { __OSVSTATE: 'new-state' }, html: PASSWORD_INPUTS })});` : passwordForm(u));
    }
    reply(show(u));
  }
  reply('', 404);
}
done({ ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED' });

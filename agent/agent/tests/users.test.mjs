// The kind o11.users (agent/lib/users.mjs, users-page.mjs): the table of what passes, the behaviour as a table of steps (fixtures/users-flow.mjs,
// the same one the native core runs), the session that stays here, the platform answer and the vault helper shared with the server by its
// sha. The helper's pure parts run in Windows PowerShell with no vault, window or network. The real vault test only runs on request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createUsersKind, validateUsersRequest, usersScope, isPrivateAddress, lookalikeOf, USERS_KIND, USERS_HELPER } from '../lib/users.mjs';
import { planWrite, planSearch, parsePage, ACTIONS, cleanText, plainValue } from '../lib/users-page.mjs';
import { createAgent } from '../lib/agent.mjs';
import { KINDS, helloKinds } from '../lib/kinds.mjs';
import { usersRows, addressRows, lookalikeRows, HOST, b64 } from './fixtures/users-table.mjs';
import { flows, runNode, verify, tempDir } from './fixtures/users-flow.mjs';

// The sha both sides name: here and platforms/odc/facade/tests/o11-users-hosted.test.mjs in the server line.
const VAULT_SHA256 = 'b7e6b8a27dee3d8d433bfb318ecc07bfb3fc55cd2ca6c59941e8059941480214';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-users-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const codeOf = fn => { try { fn(); return 'ok'; } catch (error) { return error.code; } };

test('the kind is in the closed list and the Hello', () => {
  assert.equal(USERS_KIND, 'o11.users');
  assert.ok(KINDS.includes(USERS_KIND));
  assert.ok(helloKinds(null).includes(USERS_KIND));
});
test('the vault helper is the one the server line carries, byte for byte (sha)', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(USERS_HELPER)).digest('hex'), VAULT_SHA256);
});
test('M10: the closed list of the server box is this agent\'s: no pass when it cannot be read, or when one side has a kind the other lacks', async () => {
  const file = new URL('../../../server/platforms/odc/facade/call-kinds.mjs', import.meta.url);
  assert.ok(fs.existsSync(file), 'the server box must be next to the agent box: ' + file.href);
  const { CALL_KINDS, HELLO_ONLY_KINDS } = await import(file.href);
  assert.deepEqual([...CALL_KINDS].sort(), [...helloKinds({ path: 'renderer' })].sort());
  assert.ok(HELLO_ONLY_KINDS.has(USERS_KIND));
});

for (const row of usersRows()) test('table: ' + row.label, () => assert.equal(codeOf(() => validateUsersRequest(row.request)), row.expected));
for (const [address, expected] of addressRows()) test('address: ' + address, () => assert.equal(isPrivateAddress(address), expected));
for (const [host, approved, expected] of lookalikeRows()) test(`lookalike: ${host} after ${approved.join(', ') || 'nothing'}`, () => assert.equal(lookalikeOf(host, approved), expected));

for (const flow of flows()) test('flow: ' + flow.name, { timeout: 120000 }, async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { results, state } = await runNode(flow, createUsersKind, dir);
  verify(flow, results, state);
});

// A kind with a helper that answers in-process, for what a table of steps cannot see.
function kind(t, { answers = [], platform = 'win32', lookup = async () => [{ address: '93.184.216.34', family: 4 }], consent = true } = {}) {
  const dataRoot = tmp(t), calls = [];
  let seeding = false;
  const users = createUsersKind({ dataRoot, platform, lookup, env: { SystemRoot: 'C:\\Windows' }, exec: async (file, args, input) => {
    const mode = args[args.indexOf('-Mode') + 1];
    if (seeding) return JSON.stringify(mode === 'confirm' ? { ok: true, approved: true } : { ok: true, available: true, principal: 'admin' });
    calls.push({ file, args, input });
    return JSON.stringify(answers.shift() ?? { ok: true });
  } });
  const approve = async request => { seeding = true; try { return await users.execute(request); } finally { seeding = false; } };
  const ready = platform === 'win32' && consent ? approve({ op: 'confirm', host: HOST, action: 'sign-in' }) : Promise.resolve();
  return { users: { execute: async request => { await ready; return users.execute(request); } }, calls, dataRoot, approve: async request => { await ready; return approve(request); } };
}
const page = (extra = {}) => ({ ok: true, status: 200, location: '', contentType: b64('text/html'), body: b64('<html></html>'), setCookie: [], ...extra });
const request = (over = {}) => ({ op: 'request', host: HOST, url: `https://${HOST}/Users/User_List.aspx`, ...over });
const decoded = call => JSON.parse(Buffer.from(call.input, 'base64').toString('utf8'));

test('the session stays here: setCookie never leaves, and the next request carries it to the same host only', async t => {
  const other = 'other-company.example.test';
  const k = kind(t, { answers: [page({ setCookie: [b64('ASP.NET_SessionId=abc; path=/'), b64('osVisitor=v1; path=/')] }), page(), page(), page({ setCookie: [b64('osVisitor=; path=/')] }), page()] });
  const first = await k.users.execute(request());
  assert.deepEqual(Object.keys(first).sort(), ['body', 'contentType', 'location', 'status']);
  assert.ok(!JSON.stringify(first).includes(b64('ASP.NET_SessionId=abc; path=/')));
  await k.users.execute(request());
  assert.equal(decoded(k.calls[1]).cookie, 'ASP.NET_SessionId=abc; osVisitor=v1');
  await k.approve({ op: 'confirm', host: other, action: 'sign-in' });
  await k.users.execute(request({ host: other, url: `https://${other}/Users/User_List.aspx` }));
  assert.equal(decoded(k.calls[2]).cookie, '', 'another environment never gets it');
  await k.users.execute(request());
  await k.users.execute(request());
  assert.equal(decoded(k.calls[4]).cookie, 'ASP.NET_SessionId=abc', 'an emptied cookie leaves the jar');
});
test('the helper runs hidden, with this installation\'s scope, and takes no secret in its arguments', async t => {
  const k = kind(t, { answers: [{ ok: true, available: true, principal: 'admin' }] });
  assert.deepEqual(await k.users.execute({ op: 'status', host: HOST }), { available: true, principal: 'admin', consent: true });
  const { file, args } = k.calls[0];
  assert.match(file, /powershell\.exe$/i);
  assert.equal(args[args.indexOf('-Scope') + 1], usersScope(k.dataRoot));
  assert.equal(args[args.indexOf('-HostName') + 1], HOST);
  assert.notEqual(usersScope(k.dataRoot), usersScope(k.dataRoot + '-other'), 'each installation has its own entries');
  assert.notEqual(usersScope(k.dataRoot, 'ssam_agent_a'), usersScope(k.dataRoot, 'ssam_agent_b'), 'each account has its own entries');
  assert.equal(usersScope(k.dataRoot, 'ssam_agent_a').slice(0, 16), usersScope(k.dataRoot, 'ssam_agent_b').slice(0, 16), 'the sweep finds the other accounts of this installation by the first half');
});
test('M3: the agent gives the kind its credential as the account: another token on this installation reads another vault key', async t => {
  const scopes = [];
  for (const credential of ['ssam_agent_' + 'a'.repeat(43), 'ssam_agent_' + 'b'.repeat(43)]) {
    const root = tmp(t);
    const agent = createAgent({ root, config: { credential, server: 'http://127.0.0.1:9' }, deps: { machine: null, locate: async () => null, processes: async () => [], platform: 'win32', fetch: async () => { throw new Error('no network here'); },
      users: { exec: async (file, args) => { scopes.push({ scope: args[args.indexOf('-Scope') + 1], expected: usersScope(root, credential) }); return JSON.stringify({ ok: true, available: false }); }, lookup: async () => [{ address: '93.184.216.34' }] } } });
    await agent.execute('o11.users', { op: 'status', host: HOST });
  }
  assert.equal(scopes.length, 2);
  for (const { scope, expected } of scopes) assert.equal(scope, expected);
  assert.equal(scopes[0].scope.slice(0, 16) === scopes[1].scope.slice(0, 16), false, 'two folders here');
  assert.notEqual(scopes[0].scope.slice(16), scopes[1].scope.slice(16), 'and two accounts');
});
test('the helper\'s refusal is a code and a fixed text', async t => {
  const failed = kind(t, { answers: [{ ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED', extra: 'page text' }] });
  await assert.rejects(failed.users.execute(request()), e => e.code === 'USERS_PRIVATE_REQUEST_FAILED' && e.executed === false && !e.message.includes('page text'));
  const odd = kind(t, { answers: [{ ok: false, code: 'NOT A CODE page text' }] });
  await assert.rejects(odd.users.execute(request()), e => e.code === 'USERS_PRIVATE_REQUEST_FAILED');
});
test('another platform answers in plain words before anything, whatever the request', async t => {
  for (const params of [request(), { op: 'status', host: HOST }, { op: 'nonsense' }]) {
    const k = kind(t, { platform: 'darwin' });
    await assert.rejects(k.users.execute(params), e => e.code === 'USERS_PLATFORM_UNAVAILABLE' && e.executed === false && /not available on this platform/.test(e.message));
    assert.equal(k.calls.length, 0);
  }
});
test('the prompt: its status file is under the agent\'s own folder and goes when the window closes; a second one is not opened', async t => {
  const dataRoot = tmp(t);
  const started = [];
  const child = { exitCode: null, on() {}, unref() {} };
  const users = createUsersKind({ dataRoot, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }],
    exec: async () => JSON.stringify({ ok: true, hosts: [], available: true }),
    start: (file, args) => { started.push(args); fs.writeFileSync(args[args.indexOf('-PromptStatusPath') + 1], 'visible'); return child; } });
  assert.deepEqual(await users.execute({ op: 'prompt', host: HOST }), { opened: true, alreadyOpen: false, visible: true });
  const statusFile = started[0][started[0].indexOf('-PromptStatusPath') + 1];
  assert.ok(statusFile.startsWith(path.join(dataRoot, 'private', 'users') + path.sep));
  assert.deepEqual(await users.execute({ op: 'prompt', host: HOST }), { opened: false, alreadyOpen: true });
  assert.equal(started.length, 1);
  assert.equal((await users.execute({ op: 'status', host: HOST })).consent, false);
  fs.writeFileSync(statusFile, 'saved');
  child.exitCode = 0;
  assert.equal((await users.execute({ op: 'status', host: HOST })).consent, true, 'saving the window is the yes to sign in');
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'private', 'users')), []);
});
test('the prompt that never shows is an answer, not a wait', async t => {
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }], exec: async () => JSON.stringify({ ok: true, hosts: [] }), start: () => ({ exitCode: 1, on() {}, unref() {} }) });
  await assert.rejects(users.execute({ op: 'prompt', host: HOST }), e => e.code === 'USERS_PROMPT_NOT_VISIBLE');
});
test('M5: one window at a time and a ceiling in ten minutes (the probe of the review opened 25)', async t => {
  let clock = 1000, open = null, starts = 0;
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', now: () => clock, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }], env: { SystemRoot: 'C:\\Windows' },
    exec: async () => JSON.stringify({ ok: true, hosts: [], available: true }),
    start: (file, args) => { starts++; fs.writeFileSync(args[args.indexOf('-PromptStatusPath') + 1], 'saved'); open = { exitCode: null, on() {}, unref() {} }; return open; } });
  const prompt = i => users.execute({ op: 'prompt', host: `tenant${i}x${i * 7}y.example${i}.test` });
  await prompt(0);
  await assert.rejects(prompt(1), e => e.code === 'USERS_WINDOW_BUSY');
  await assert.rejects(users.execute({ op: 'confirm', host: HOST, action: 'sign-in' }), e => e.code === 'USERS_WINDOW_BUSY');
  assert.equal(starts, 1);
  for (let i = 1; i < 20; i++) { open.exitCode = 0; await prompt(i); }
  open.exitCode = 0;
  await assert.rejects(prompt(20), e => e.code === 'USERS_WINDOW_LIMIT');
  assert.equal(starts, 20);
  clock += 600001;
  await prompt(21);
  assert.equal(starts, 21);
});
test('P1: what is read from a page for a window is one line and hides nothing', () => {
  assert.equal(cleanText('<b>Ana</b>\u202e\u200b  Silva &amp; co\n' + ' '.repeat(50) + 'x'), 'Ana Silva & co x');
  assert.ok(cleanText('n'.repeat(500)).length <= 123);
  assert.equal(plainValue('ana@example.invalid', 250), true);
  assert.equal(plainValue('', 250), false);
  assert.equal(plainValue('x'.repeat(21), 20), false);
});
test('P1: the table has no operation beyond the ones a person can see', () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['activate', 'add-group', 'create', 'deactivate', 'grant-role', 'set-password', 'update']);
  const source = fs.readFileSync(new URL('../lib/users-page.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../lib/users.mjs', import.meta.url), 'utf8');
  for (const word of ['DeleteUser', 'RemoveRole', 'RemoveGroup', 'Delete this User']) assert.ok(!source.includes(word), word);
});
test('P1: the plan reads only its own page: another form, two forms or a comment do not change what goes out', () => {
  const form = body => `<html><form method="post" action="User_List.aspx"><input type="hidden" name="__OSVSTATE" value="s">${body}</form></html>`;
  const search = '<input id="x_wtSearchInput" name="s"><input type="submit" name="b" value="Search">';
  assert.deepEqual(planSearch({ host: HOST, text: 'ana' }, form(search)).fields, [['__OSVSTATE', 's'], ['s', 'ana'], ['b', 'Search']]);
  assert.deepEqual(planSearch({ host: HOST, text: 'ana' }, form(search + '<!-- <input name="hidden" value="x"> -->')).fields, [['__OSVSTATE', 's'], ['s', 'ana'], ['b', 'Search']]);
  assert.throws(() => planSearch({ host: HOST, text: 'a' }, form(search) + form(search)), e => e.code === 'USERS_PAGE_NOT_KNOWN');
  assert.throws(() => planSearch({ host: HOST, text: 'a' }, form('')), e => e.code === 'USERS_PAGE_NOT_KNOWN');
  assert.throws(() => planSearch({ host: HOST, text: 'a' }, form(search + search)), e => e.code === 'USERS_PAGE_NOT_KNOWN');
  assert.throws(() => planSearch({ host: HOST, text: 'a' }, form(search).replace('User_List.aspx', 'https://evil.example/Users/User_List.aspx')), e => e.code === 'USERS_PAGE_NOT_KNOWN');
  assert.throws(() => planSearch({ host: HOST, text: 'a' }, form(search).replace('User_List.aspx', 'User_Edit.aspx?UserId=7')), e => e.code === 'USERS_PAGE_NOT_KNOWN');
  assert.throws(() => planWrite({ action: 'activate', host: HOST, userId: '42' }, ['<html></html>']), e => e.code === 'USERS_PAGE_NOT_KNOWN');
  assert.equal(parsePage(form('')).action, 'User_List.aspx');
});

// The helper's own parts, run in Windows PowerShell: no vault, no window shown and no network. They are taken out of the script by its parser.
function helperFunctions(t, body) {
  const script = path.join(tmp(t), 'run.ps1');
  fs.writeFileSync(script, `$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(USERS_HELPER).replace(/^"|"$/g, "'").replace(/\\\\/g, '\\')},[ref]$null,[ref]$null)
foreach($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){ if($fn.Name -in 'Attr','Form','Redact','LoginPlan','LoginResult','LoginAnswer','ConfirmForm','ReadCapped','Prefix','Sweep','SweepPasswords','SweepAllPasswords'){ . ([ScriptBlock]::Create($fn.Extent.Text)) } }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${body}
`);
  return JSON.parse(execFileSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 120000 }).trim().split(/\r?\n/).at(-1));
}
const windowsOnly = { skip: process.platform !== 'win32' && 'the helper is Windows PowerShell', timeout: 180000 };
test('the window of a yes: Enter and Escape decline, Approve is asleep at first, and it ends by itself', windowsOnly, t => {
  const w = helperFunctions(t, `$w=ConfirmForm ([pscustomobject]@{rows=@([pscustomobject]@{label='Email';value=('x'*400);data=$true},[pscustomobject]@{label='Environment';value='h.example'})})
@{accept=($w.Form.AcceptButton -eq $w.No);cancel=($w.Form.CancelButton -eq $w.No);yesEnabled=$w.Yes.Enabled;arm=$w.Arm.Interval;end=$w.End.Interval;top=$w.Form.TopMost;visible=$w.Form.Visible;multi=@($w.Form.Controls|Where-Object{$_ -is [Windows.Forms.TextBox]}|ForEach-Object{$_.Multiline}|Select-Object -Unique);tall=@($w.Form.Controls|Where-Object{$_ -is [Windows.Forms.TextBox]})[0].Height;marked=@($w.Form.Controls|Where-Object{$_ -is [Windows.Forms.Label] -and $_.Text -match 'from the page'}).Count}|ConvertTo-Json -Compress`);
  assert.equal(w.accept, true, 'Enter is Decline');
  assert.equal(w.cancel, true);
  assert.equal(w.yesEnabled, false, 'Approve is asleep');
  assert.ok(w.arm >= 1000);
  assert.equal(w.end, 120000);
  assert.equal(w.top, true);
  assert.equal(w.visible, false, 'the test shows no window');
  assert.ok(w.tall > 100, 'a long value shows whole: ' + w.tall);
  assert.equal(w.marked, 1, 'what comes from a page says so');
});
test('the redaction takes out every form a page can give the value', windowsOnly, t => {
  const shapes = helperFunctions(t, `$s='P@ss w0rd<&>"''e'
$html=[Net.WebUtility]::HtmlEncode($s)
$forms=@($s,$html,$html.Replace('&#39;','&apos;'),(Form $s),[Uri]::EscapeDataString($s),([regex]::Replace([Uri]::EscapeDataString($s),'%[0-9A-F]{2}',{param($m) $m.Value.ToLower()})),$s.ToUpperInvariant(),[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)),[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s)))
@(foreach($form in $forms){ (Redact ('<input value="'+$form+'">') $s) -match 'redacted' })|ConvertTo-Json -Compress`);
  assert.deepEqual(shapes, shapes.map(() => true));
  assert.ok(shapes.length >= 9);
});
test('the sign-in form: exactly one user box, one password box and one Log In, outside comments and scripts', windowsOnly, t => {
  const r = helperFunctions(t, `$good='<form action="Login.aspx"><input type="hidden" name="__OSVSTATE" value="a&amp;b"><input type="text" name="u"><input type="password" name="p"><input type="submit" name="go" value="Log In"></form>'
$plan=LoginPlan $good
@{user=$plan.User;password=$plan.Password;submit=$plan.Submit;hidden=$plan.Hidden[0][1];
 commented=($null -ne (LoginPlan ($good+'<!-- <input type="text" name="v"> --><script>var a="<input type=text name=w>";</script>')));
 twoUsers=($null -eq (LoginPlan ($good+'<input type="text" name="v">')));
 twoPasswords=($null -eq (LoginPlan ($good+'<input type="password" name="q">')));
 noSubmit=($null -eq (LoginPlan $good.Replace('Log In','Entrar')));
 button=($null -eq (LoginPlan $good.Replace('<input type="submit" name="go" value="Log In">','<button>Log In</button>')));
 sso=($null -eq (LoginPlan '<form action="Login.aspx"><a href="/sso">Sign in with SSO</a></form>'))}|ConvertTo-Json -Compress`);
  assert.deepEqual(r, { user: 'u', password: 'p', submit: 'go', hidden: 'a&b', commented: true, twoUsers: true, twoPasswords: true, noSubmit: true, button: true, sso: true });
});
test('signed in means a cookie, and an answer that left the login page on this host: nothing else counts', windowsOnly, t => {
  const r = helperFunctions(t, `$h='tenant-a.example.test'
@(
 (LoginResult 302 'https://tenant-a.example.test/Users/User_List.aspx' '' 1 $h),
 (LoginResult 302 '/Users/User_List.aspx' '' 1 $h),
 (LoginResult 200 '' '<html>welcome</html>' 1 $h),
 (LoginResult 302 '/Users/Login.aspx?error=1' '' 1 $h),
 (LoginResult 302 'https://evil.example/Users/User_List.aspx' '' 1 $h),
 (LoginResult 302 '' '' 1 $h),
 (LoginResult 200 '' '<input type="password" name="p">' 1 $h),
 (LoginResult 500 '' 'error' 1 $h),
 (LoginResult 200 '' '<html>blocked</html>' 0 $h),
 (LoginResult 302 '/Users/User_List.aspx' '' 0 $h)
)|ConvertTo-Json -Compress`);
  assert.deepEqual(r, [true, true, true, false, false, false, false, false, false, false]);
});
test('C2: the sweep of a start takes every new password of this account, and only those', windowsOnly, t => {
  const r = helperFunctions(t, `Add-Type -TypeDefinition 'public static class UsersVault { public static System.Collections.Generic.List<string> Gone=new System.Collections.Generic.List<string>(); public static bool Delete(string n,int a,int b){Gone.Add(n);return true;} }'
$Scope='0123456789abcdefmine'
$script:asked=$null
function Names($filter){ $script:asked=$filter; @([pscustomobject]@{Name='one'},[pscustomobject]@{Name='two'}) }
SweepAllPasswords
@{asked=$script:asked;gone=@([UsersVault]::Gone)}|ConvertTo-Json -Compress`);
  assert.equal(r.asked, 'SSAM/Agent/0123456789abcdef/mine/O11/*/UsersPassword/*');
  assert.deepEqual(r.gone, ['one', 'two']);
  assert.match(fs.readFileSync(USERS_HELPER, 'utf8'), /\$Mode -eq 'sweep'\) \{\r?\n  SweepAllPasswords/);
});
test('C2: the agent starts the sweep when a mark says a password may be there, and runs nothing without one', async t => {
  for (const marked of [true, false]) {
    const root = tmp(t), modes = [];
    if (marked) { fs.mkdirSync(path.join(root, 'private', 'users'), { recursive: true }); fs.writeFileSync(path.join(root, 'private', 'users', 'passwords-pending'), ''); }
    const agent = createAgent({ root, config: { credential: 'ssam_agent_' + 'a'.repeat(43), server: 'http://127.0.0.1:9' }, deps: { machine: null, locate: async () => null, processes: async () => [], platform: 'win32', fetch: async () => { throw new Error('no network here'); },
      users: { exec: async (file, args) => { modes.push(args[args.indexOf('-Mode') + 1]); return JSON.stringify({ ok: true, available: false }); }, lookup: async () => [{ address: '93.184.216.34' }] } } });
    assert.ok(agent);
    for (let i = 0; i < 100 && marked && !modes.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(modes, marked ? ['sweep'] : []);
  }
});
test('what the sign-in answers is what LoginResult decided, never a yes by itself', windowsOnly, t => {
  const r = helperFunctions(t, `$h='tenant-a.example.test'
function A($s,$l,$b,$c){ (LoginAnswer ([pscustomobject]@{Status=$s;Location=$l;Body=$b}) $c $h)|ConvertFrom-Json }
@((A 302 '/Users/User_List.aspx' '' @('x')).authenticated,(A 200 '' '<input type="password" name="p">' @('x')).authenticated,(A 302 '/Users/User_List.aspx' '' @()).authenticated,(A 302 '/Users/Login.aspx' '' @('x')).authenticated)|ConvertTo-Json -Compress`);
  assert.deepEqual(r, [true, false, false, false]);
});
test('a page over the limit is not read whole: it answers nothing, and the stream is closed', windowsOnly, t => {
  const r = helperFunctions(t, `function S($n){ New-Object IO.MemoryStream (,(New-Object byte[] $n)) }
$fits=S 1000;$over=S 200000
@{fits=(ReadCapped $fits 1000).Length;exact=($null -ne (ReadCapped (S 65536) 65536));over=($null -eq (ReadCapped $over 1000));closed=(-not $over.CanRead)}|ConvertTo-Json -Compress`);
  assert.deepEqual(r, { fits: 1000, exact: true, over: true, closed: true });
});
test('the helper sweeps what no longer belongs and nothing else: another account of this installation, a new password nobody used', windowsOnly, t => {
  const r = helperFunctions(t, `Add-Type -TypeDefinition 'public static class UsersVault { public static System.Collections.Generic.List<string> Gone=new System.Collections.Generic.List<string>(); public static bool Delete(string n,int a,int b){Gone.Add(n);return true;} }'
$Scope='0123456789abcdefmine'
function Names($filter){ if($filter -like '*UsersPassword*'){ @([pscustomobject]@{Name='stale';Written=[DateTime]::UtcNow.AddMinutes(-16)},[pscustomobject]@{Name='fresh';Written=[DateTime]::UtcNow.AddMinutes(-14)}) } else { @([pscustomobject]@{Name='SSAM/Agent/0123456789abcdef/mine/O11/x'},[pscustomobject]@{Name='SSAM/Agent/0123456789abcdef/other/O11/x'}) } }
Sweep;SweepPasswords
@{gone=@([UsersVault]::Gone)}|ConvertTo-Json -Compress`);
  assert.deepEqual(r.gone, ['SSAM/Agent/0123456789abcdef/other/O11/x', 'stale']);
  // That the modes call them is read from the text: a run of a mode needs the vault.
  assert.match(fs.readFileSync(USERS_HELPER, 'utf8'), /\$Mode -ne 'prompt' -and \$Mode -ne 'confirm'\) \{ Sweep; SweepPasswords \}/);
  assert.match(fs.readFileSync(USERS_HELPER, 'utf8'), /\$memory=ReadCapped [^\n]*\n if\(\$null -eq \$memory\)\{\$response\.Close\(\);Fail 'USERS_PAGE_TOO_LARGE'\}/);
  assert.match(fs.readFileSync(USERS_HELPER, 'utf8'), /\n  LoginAnswer \$after \$cookies \$HostName\r?\n/);
});
test('the helper keeps its own rules: no redirect, no page over the limit, the vault read before any request', () => {
  const text = fs.readFileSync(USERS_HELPER, 'utf8');
  assert.match(text, /\$web\.AllowAutoRedirect=\$false/);
  assert.match(text, /\$MaxPage=262144/);
  assert.ok(text.indexOf("Fail 'USERS_HOST_NOT_AUTHENTICATED'") < text.indexOf("$page=Http $uri 'GET'"), 'the vault is read before the sign-in');
  assert.ok(text.indexOf("code='USERS_HOST_NOT_AUTHENTICATED'") < text.indexOf('$page=Http $uri $r.method'), 'the vault is read before any request');
  assert.match(text, /\$approving=\(\$Kind -eq 'login'\) -and \(\$null -eq \(ReadVault \(Target 'login' ''\) \$false\)\)/);
  assert.match(text, /\$again\.Text\.Trim\(\) -cne \$HostName/);
  assert.ok(text.indexOf('-cne $HostName') < text.indexOf('[UsersVault]::Write([ref]$c,0)'));
  assert.match(text, /function SweepPasswords/);
  assert.match(text, /AddMinutes\(-15\)/);
  assert.match(text, /\$ref\.field -notmatch/);
  assert.match(text, /\$memory=ReadCapped \$response\.GetResponseStream\(\) \$MaxPage/);
});
// It reaches the Windows vault API, even on a scope nobody has: never by default, only with SSAM_USERS_REAL_VAULT_TEST=1.
test('the real helper: an environment with no administrator stored is refused before any request', { skip: (process.platform !== 'win32' || process.env.SSAM_USERS_REAL_VAULT_TEST !== '1') && 'only with SSAM_USERS_REAL_VAULT_TEST=1 on Windows: it touches the vault API', timeout: 120000 }, async t => {
  const users = createUsersKind({ dataRoot: tmp(t) });
  assert.deepEqual(await users.execute({ op: 'status', host: HOST }), { available: false, principal: null, consent: false });
  assert.deepEqual(await users.execute({ op: 'status', host: HOST, kind: 'password', entry: 'a'.repeat(64) }), { available: false, principal: null, consent: false });
  assert.deepEqual(await users.execute({ op: 'forget', host: HOST, kind: 'password', entry: 'a'.repeat(64) }), {});
});

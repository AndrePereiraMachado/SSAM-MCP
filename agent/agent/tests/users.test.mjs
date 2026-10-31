// The kind o11.users (agent/lib/users.mjs): the table of what passes (the native core answers the same rows, tests/native/
// users.test.mjs), the session that stays here, the helper's arguments, the platform answer and the vault helper shared with the
// server by its sha. A fake helper: no vault, window or network here. The vault and the window are proved live (the release gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUsersKind, validateUsersRequest, usersScope, isPrivateAddress, lookalikeOf, USERS_KIND, USERS_HELPER } from '../lib/users.mjs';
import { KINDS, helloKinds } from '../lib/kinds.mjs';
import { usersRows, addressRows, lookalikeRows, HOST, b64 } from './fixtures/users-table.mjs';

// The sha both sides name: here and platforms/odc/facade/tests/o11-users-hosted.test.mjs in the server line.
const VAULT_SHA256 = '80790a0f739e65c2ac65c51eae6d5e0b0fdfcbad5f2ad59234ce3c17d6a3e879';
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

// consent: the person already said yes to signing in, through the confirm window; its helper calls are not counted.
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
  const ready = platform === 'win32' && consent && lookupOk(lookup) ? approve({ op: 'confirm', host: HOST, action: 'sign-in' }) : Promise.resolve();
  return { users: { execute: async request => { await ready; return users.execute(request); } }, calls, dataRoot, approve: async request => { await ready; return approve(request); } };
}
const lookupOk = lookup => lookup.ok !== false;
const page = (extra = {}) => ({ ok: true, status: 200, location: '', contentType: b64('text/html'), body: b64('<html></html>'), setCookie: [], ...extra });
const request = (over = {}) => ({ op: 'request', host: HOST, url: `https://${HOST}/Users/User_List.aspx`, method: 'GET', fields: [], ...over });
const decoded = call => JSON.parse(Buffer.from(call.input, 'base64').toString('utf8'));

test('the session stays here: setCookie never leaves, and the next request carries it to the same host only', async t => {
  const other = 'tenant-b.example.test';
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

// The person typed a new password in the window for this user: its status file says saved, and the permit comes from that alone.
async function kindWithPassword(t, entry, options = {}) {
  const dataRoot = tmp(t), calls = [], answers = options.answers ?? [];
  let seeding = true;
  const users = createUsersKind({ dataRoot, platform: 'win32', lookup: async () => [{ address: '93.184.216.34' }], wait: async () => {}, env: { SystemRoot: 'C:\\Windows' },
    exec: async (file, args, input) => {
      const mode = args[args.indexOf('-Mode') + 1];
      if (seeding) return JSON.stringify(mode === 'confirm' ? { ok: true, approved: true } : { ok: true, available: true, principal: 'admin', hosts: [] });
      calls.push({ file, args, input });
      return JSON.stringify(answers.shift() ?? { ok: true });
    },
    start: (file, args) => { fs.writeFileSync(args[args.indexOf('-PromptStatusPath') + 1], 'saved'); return { exitCode: 0, on() {}, unref() {} }; } });
  await users.execute({ op: 'confirm', host: HOST, action: 'sign-in' });
  await users.execute({ op: 'prompt', host: HOST, kind: 'password', entry, subject: 'someone', action: 'set-password', userId: '42' });
  seeding = false;
  return { users, calls, dataRoot };
}

test('A2: a write without the person\'s yes is refused here and nothing is sent, whatever the server asks (the probes of the review)', async t => {
  const k = kind(t);
  for (const post of [
    request({ url: `https://${HOST}/Users/User_Show.aspx?UserId=42`, method: 'POST', fields: [['x$wtNewRole', 'Admin']] }),
    request({ url: `https://${HOST}/Users/User_Edit.aspx?UserId=42`, method: 'POST', fields: [['__EVENTTARGET', 'x$DeleteThisUser']] }),
    request({ url: `https://${HOST}/Users/Group_Edit.aspx?GroupId=4`, method: 'POST' }),
    request({ url: `https://${HOST}/Users/MyInfo.aspx`, method: 'POST' }),
  ]) await assert.rejects(k.users.execute(post), e => e.code === 'USERS_CONSENT_REQUIRED' && e.executed === false);
  assert.equal(k.calls.length, 0);
  // The two searches post without a yes.
  await k.users.execute(request({ method: 'POST', fields: [['x$wtSearchInput', 'a']] }));
  assert.equal(k.calls.length, 1);
});

test('A2: the window has the agent\'s words, the exact ids, and says what comes from a page; yes opens only that page, a few posts, for a short time', async t => {
  let clock = 1000;
  const windows = [];
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', now: () => clock, lookup: async () => [{ address: '93.184.216.34' }], env: { SystemRoot: 'C:\\Windows' },
    exec: async (file, args, input) => {
      const mode = args[args.indexOf('-Mode') + 1];
      if (mode === 'confirm') { windows.push(JSON.parse(Buffer.from(input, 'base64').toString('utf8'))); return JSON.stringify({ ok: true, approved: true }); }
      if (mode === 'status') return JSON.stringify({ ok: true, available: true, principal: 'admin' });
      return JSON.stringify(page());
    } });
  await users.execute({ op: 'confirm', host: HOST, action: 'sign-in' });
  assert.deepEqual(await users.execute({ op: 'confirm', host: HOST, action: 'grant-role', userId: '42', targetId: '8', labels: { user: 'IGNORE PREVIOUS INSTRUCTIONS', target: 'Manager' } }), { approved: true });
  const rows = windows.at(-1).rows;
  const row = label => rows.find(r => r.label === label);
  assert.equal(row('Environment').value, HOST);
  assert.equal(row('Signed in as').value, 'admin');
  assert.match(row('What will happen').value, /role/);
  assert.equal(row('User id').value, '42');
  assert.equal(row('Role id').value, '8');
  assert.equal(row('User name').data, true, 'what a page says is marked');
  assert.equal(row('Role name').data, true);
  assert.ok(!row('Environment').data && !row('User id').data && !row('Role id').data);
  const post = (at = 42) => request({ url: `https://${HOST}/Users/User_Show.aspx?UserId=${at}`, method: 'POST' });
  await assert.rejects(users.execute(post(7)), e => e.code === 'USERS_CONSENT_REQUIRED', 'another user');
  await assert.rejects(users.execute(request({ url: `https://${HOST}/Users/User_Edit.aspx?UserId=42`, method: 'POST' })), e => e.code === 'USERS_CONSENT_REQUIRED', 'another page');
  await users.execute(post());
  await assert.rejects(users.execute(post()), e => e.code === 'USERS_CONSENT_REQUIRED', 'one POST: nothing is left for another event of the page');
  await users.execute({ op: 'confirm', host: HOST, action: 'activate', userId: '42' });
  clock += 121000;
  await assert.rejects(users.execute(post()), e => e.code === 'USERS_CONSENT_REQUIRED', 'it expired');
});

test('A2: no, no answer and a dead helper give nothing, and nothing retries', async t => {
  for (const [answer, code] of [[{ ok: true, approved: false }, 'USERS_CONFIRMATION_DECLINED'], [{ ok: true, approved: false, timedOut: true }, 'USERS_CONFIRMATION_TIMEOUT'], [null, 'USERS_CONFIRMATION_TIMEOUT']]) {
    let windows = 0;
    const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', lookup: async () => [{ address: '93.184.216.34' }], env: { SystemRoot: 'C:\\Windows' },
      exec: async (file, args) => {
        const mode = args[args.indexOf('-Mode') + 1];
        if (mode === 'status') return JSON.stringify({ ok: true, available: true });
        windows++;
        if (!answer) throw new Error('killed');
        return JSON.stringify(answer);
      } });
    await assert.rejects(users.execute({ op: 'confirm', host: HOST, action: 'deactivate', userId: '42' }), e => e.code === code && e.executed === false);
    assert.equal(windows, 1);
    await assert.rejects(users.execute(request({ url: `https://${HOST}/Users/User_Show.aspx?UserId=42`, method: 'POST' })), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED');
  }
});

test('M2: nothing goes to the site until a person here approved signing in, and that ends', async t => {
  let clock = 1000;
  const calls = [];
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', now: () => clock, lookup: async () => [{ address: '93.184.216.34' }], env: { SystemRoot: 'C:\\Windows' },
    exec: async (file, args) => { const mode = args[args.indexOf('-Mode') + 1]; calls.push(mode); return JSON.stringify(mode === 'confirm' ? { ok: true, approved: true } : mode === 'status' ? { ok: true, available: true } : mode === 'login' ? { ok: true, authenticated: true } : page()); } });
  await assert.rejects(users.execute({ op: 'login', host: HOST }), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED' && e.executed === false);
  await assert.rejects(users.execute(request()), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED');
  assert.deepEqual(calls, []);
  assert.equal((await users.execute({ op: 'status', host: HOST })).consent, false);
  await users.execute({ op: 'confirm', host: HOST, action: 'sign-in' });
  assert.equal((await users.execute({ op: 'status', host: HOST })).consent, true);
  assert.deepEqual(await users.execute({ op: 'login', host: HOST }), { authenticated: true });
  await users.execute(request());
  await assert.rejects(users.execute(request({ host: 'other-tenant.example.test', url: 'https://other-tenant.example.test/Users/User_List.aspx' })), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED', 'per environment');
  clock += 8 * 3600 * 1000 + 1;
  await assert.rejects(users.execute(request()), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED');
});

test('A3: a name that reads like an approved environment gets no window and no request (the phishing probe of the review)', async t => {
  const started = [];
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }],
    exec: async (file, args) => JSON.stringify(args[args.indexOf('-Mode') + 1] === 'hosts' ? { ok: true, hosts: [HOST] } : { ok: true, available: false }),
    start: (file, args) => { started.push(args); return { exitCode: 1, on() {}, unref() {} }; } });
  await assert.rejects(users.execute({ op: 'prompt', host: 'tenant-a.example.test.evil.example' }), e => e.code === 'USERS_HOST_LOOKALIKE' && e.executed === false);
  assert.equal(started.length, 0);
});

test('A3: a name that resolves inside a network, or nowhere, gets no window and no request', async t => {
  for (const [lookup, code] of [[async () => [{ address: '169.254.169.254' }], 'USERS_HOST_PRIVATE'], [async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }], 'USERS_HOST_PRIVATE'], [async () => { throw new Error('ENOTFOUND'); }, 'USERS_HOST_UNRESOLVED'], [async () => [], 'USERS_HOST_UNRESOLVED']]) {
    const k = kind(t, { lookup });
    await assert.rejects(k.users.execute({ op: 'prompt', host: HOST }), e => e.code === code);
    await assert.rejects(k.users.execute(request()), e => e.code === code);
    assert.equal(k.calls.length, 0);
  }
});

test('A3: the first window of an environment asks for its name again, and the helper writes the vault only then', () => {
  const text = fs.readFileSync(USERS_HELPER, 'utf8');
  assert.match(text, /\$approving=\(\$Kind -eq 'login'\) -and \(\$null -eq \(ReadVault \(Target 'login' ''\) \$false\)\)/);
  assert.match(text, /\$again\.Text\.Trim\(\) -cne \$HostName/);
  assert.ok(text.indexOf('-cne $HostName') < text.indexOf('[UsersVault]::Write([ref]$c,0)'));
});

test('A1: the new password of a POST leaves the vault there, also when the POST fails; a failed forget is said', async t => {
  const entry = 'b'.repeat(64);
  const refs = [{ field: 'x$wtNewPasswordInput', kind: 'password', entry, part: 'password' }];
  const post = request({ url: `https://${HOST}/Users/User_Show.aspx?UserId=42`, method: 'POST', secretRefs: refs });
  const prompted = kindWithPassword(t, entry, { answers: [page(), { ok: true }] });
  const k = await prompted;
  assert.equal((await k.users.execute(post)).passwordForgotten, true);
  const forgets = k.calls.filter(c => c.args[c.args.indexOf('-Mode') + 1] === 'forget');
  assert.equal(forgets.length, 1);
  assert.equal(forgets[0].args[forgets[0].args.indexOf('-Entry') + 1], entry);
  const failed = await kindWithPassword(t, entry, { answers: [{ ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED' }, { ok: true }] });
  await assert.rejects(failed.users.execute(post), e => e.code === 'USERS_PRIVATE_REQUEST_FAILED');
  assert.equal(failed.calls.filter(c => c.args[c.args.indexOf('-Mode') + 1] === 'forget').length, 1);
  const stuck = await kindWithPassword(t, entry, { answers: [page(), { ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED' }] });
  assert.equal((await stuck.users.execute(post)).passwordForgotten, false);
  const plain = kind(t, { answers: [page()] });
  assert.equal(Object.hasOwn(await plain.users.execute(request()), 'passwordForgotten'), false);
  assert.equal(plain.calls.length, 1);
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
  assert.match(usersScope(k.dataRoot, 'x'), /^[a-f0-9]{32}$/);
});

test('A2: a new password goes only under the window that took it, to that form, once', async t => {
  const entry = 'c'.repeat(64);
  const refs = [{ field: 'x$wtNewPasswordInput', kind: 'password', entry, part: 'password' }];
  const k = await kindWithPassword(t, entry, { answers: [page(), page(), page(), { ok: true }] });
  const post = (over = {}) => request({ url: `https://${HOST}/Users/User_Show.aspx?UserId=42`, method: 'POST', ...over });
  await assert.rejects(k.users.execute(post({ url: `https://${HOST}/Users/User_Show.aspx?UserId=7`, secretRefs: refs })), e => e.code === 'USERS_CONSENT_REQUIRED', 'another user');
  await assert.rejects(k.users.execute(post({ secretRefs: [{ ...refs[0], entry: 'd'.repeat(64) }] })), e => e.code === 'USERS_CONSENT_REQUIRED', 'another password');
  await k.users.execute(post());
  await k.users.execute(post({ secretRefs: refs }));
  await assert.rejects(k.users.execute(post({ secretRefs: refs })), e => e.code === 'USERS_CONSENT_REQUIRED', 'once');
});

test('M5: one window at a time and a limit in ten minutes (the probe of the review opened 25)', async t => {
  let clock = 1000, open = null, starts = 0;
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', now: () => clock, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }], env: { SystemRoot: 'C:\\Windows' },
    exec: async () => JSON.stringify({ ok: true, hosts: [], available: true }),
    start: (file, args) => { starts++; fs.writeFileSync(args[args.indexOf('-PromptStatusPath') + 1], 'visible'); open = { exitCode: null, on() {}, unref() {} }; return open; } });
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

test('M5: seven yes in a row are work, three no in a row stop the asking for a while', async t => {
  let clock = 1000, answer = true, windows = 0;
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', now: () => clock, lookup: async () => [{ address: '93.184.216.34' }], env: { SystemRoot: 'C:\\Windows' },
    exec: async (file, args) => { const mode = args[args.indexOf('-Mode') + 1]; if (mode === 'confirm') windows++; return JSON.stringify(mode === 'confirm' ? { ok: true, approved: answer } : { ok: true, available: true }); } });
  const ask = () => users.execute({ op: 'confirm', host: HOST, action: 'activate', userId: '42' });
  for (let i = 0; i < 7; i++) await ask();
  answer = false;
  for (let i = 0; i < 3; i++) await assert.rejects(ask(), e => e.code === 'USERS_CONFIRMATION_DECLINED');
  await assert.rejects(ask(), e => e.code === 'USERS_WINDOW_LIMIT');
  assert.equal(windows, 10);
  clock += 600001;
  answer = true;
  assert.deepEqual(await ask(), { approved: true });
});

test('M4: the helper removes a new password nobody used in a quarter of an hour', () => {
  const text = fs.readFileSync(USERS_HELPER, 'utf8');
  assert.match(text, /function SweepPasswords/);
  assert.match(text, /AddMinutes\(-15\)/);
  assert.match(text, /\{ Sweep; SweepPasswords \}/);
});

test('M3: sign-out ends what this agent holds for the host, and the next sign-in asks a person again', async t => {
  const k = kind(t, { answers: [{ ok: true }] });
  assert.equal((await k.users.execute({ op: 'status', host: HOST })).consent, true);
  k.calls.length = 0;
  assert.deepEqual(await k.users.execute({ op: 'sign-out', host: HOST }), { signedOut: true });
  assert.equal(k.calls[0].args[k.calls[0].args.indexOf('-Mode') + 1], 'sign-out');
  await assert.rejects(k.users.execute({ op: 'login', host: HOST }), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED');
  await assert.rejects(k.users.execute(request()), e => e.code === 'USERS_LOGIN_CONSENT_REQUIRED');
});

test('M1: the sign-in sends nothing the server chose, gives back only yes or no, and keeps the session here', async t => {
  const k = kind(t, { answers: [{ ok: true, authenticated: true, setCookie: [b64('ASP.NET_SessionId=abc; path=/')] }, page()] });
  assert.deepEqual(await k.users.execute({ op: 'login', host: HOST }), { authenticated: true });
  assert.equal(k.calls[0].input, '');
  await k.users.execute(request());
  assert.equal(decoded(k.calls[1]).cookie, 'ASP.NET_SessionId=abc');
});

test('M1 and M9: the helper signs in by itself, redacts every form of a value and refuses a large page', () => {
  const text = fs.readFileSync(USERS_HELPER, 'utf8');
  assert.match(text, /\$MaxPage=262144/);
  assert.match(text, /USERS_PAGE_TOO_LARGE/);
  for (const form of ["'IgnoreCase'", 'EscapeDataString($secret)', 'UTF8.GetBytes($secret)', 'Unicode.GetBytes($secret)', '\\u003c', '&apos;']) assert.ok(text.includes(form), form);
  assert.match(text, /Administrator's goes only through -Mode login|administrator's goes only through -Mode login/i);
  assert.ok(!/kind -eq 'login' -and \$uri\.AbsolutePath/.test(text));
});

test('M9: a page larger than the limit does not leave the agent', async t => {
  const k = kind(t, { answers: [page({ body: 'A'.repeat(400000) })] });
  await assert.rejects(k.users.execute(request()), e => e.code === 'USERS_PAGE_TOO_LARGE');
});

test('the helper\'s refusal is a code and a fixed text, and a host without an administrator ran nothing', async t => {
  const k = kind(t, { answers: [{ ok: false, code: 'USERS_HOST_NOT_AUTHENTICATED' }] });
  await assert.rejects(k.users.execute(request()), e => e.code === 'USERS_HOST_NOT_AUTHENTICATED' && e.executed === false);
  const failed = kind(t, { answers: [{ ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED', extra: 'page text' }] });
  await assert.rejects(failed.users.execute(request()), e => e.code === 'USERS_PRIVATE_REQUEST_FAILED' && e.executed === null && !e.message.includes('page text'));
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

test('a macOS agent without the helper file answers the same, before it would look for the file', async t => {
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'darwin', helper: path.join(os.tmpdir(), 'no-such-helper-here.ps1') });
  await assert.rejects(users.execute({ op: 'status', host: HOST }), e => e.code === 'USERS_PLATFORM_UNAVAILABLE');
});

test('the prompt: its status file is under the agent\'s own folder and is removed; a second one is not opened', async t => {
  const dataRoot = tmp(t);
  const started = [];
  const child = { exitCode: null, on() {}, unref() {} };
  const users = createUsersKind({ dataRoot, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }],
    exec: async () => JSON.stringify({ ok: true, hosts: [], available: true }),
    start: (file, args) => {
      started.push(args);
      fs.writeFileSync(args[args.indexOf('-PromptStatusPath') + 1], 'visible');
      return child;
    } });
  assert.deepEqual(await users.execute({ op: 'prompt', host: HOST }), { opened: true, alreadyOpen: false, visible: true });
  const statusFile = started[0][started[0].indexOf('-PromptStatusPath') + 1];
  assert.ok(statusFile.startsWith(path.join(dataRoot, 'private', 'users') + path.sep));
  assert.deepEqual(await users.execute({ op: 'prompt', host: HOST }), { opened: false, alreadyOpen: true });
  assert.equal(started.length, 1);
  // The person saves and the window closes: that alone is the yes to sign in, and the file goes.
  assert.equal((await users.execute({ op: 'status', host: HOST })).consent, false);
  fs.writeFileSync(statusFile, 'saved');
  child.exitCode = 0;
  assert.equal((await users.execute({ op: 'status', host: HOST })).consent, true);
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'private', 'users')), []);
});

test('the prompt that never shows is an answer, not a wait', async t => {
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }], exec: async () => JSON.stringify({ ok: true, hosts: [] }), start: () => ({ exitCode: 1, on() {}, unref() {} }) });
  await assert.rejects(users.execute({ op: 'prompt', host: HOST }), e => e.code === 'USERS_PROMPT_NOT_VISIBLE');
});

test('the helper carries the rules of its own side: closed modes and routes, the vault before any request, no redirect', () => {
  const text = fs.readFileSync(USERS_HELPER, 'utf8');
  assert.match(text, /\$web\.AllowAutoRedirect=\$false/);
  assert.match(text, /USERS_HOST_NOT_AUTHENTICATED/);
  assert.ok(text.indexOf("Fail 'USERS_HOST_NOT_AUTHENTICATED'") < text.indexOf("$page=Http $uri 'GET'"), 'the vault is read before the sign-in');
  assert.ok(text.indexOf("code='USERS_HOST_NOT_AUTHENTICATED'") < text.indexOf('$page=Http $uri $r.method'), 'the vault is read before any request');
  assert.match(text, /\$ref\.field -notmatch/);
  assert.match(text, /\$uri\.Scheme -ne 'https' -or \$uri\.Host -ne \$HostName/);
});

// The real helper, on a scope nobody has: the vault is only looked up, no window opens and nothing goes out.
// It reaches the Windows vault API, even on a scope nobody has: never by default, only with SSAM_USERS_REAL_VAULT_TEST=1.
test('the real helper: an environment with no administrator stored is refused before any request', { skip: (process.platform !== 'win32' || process.env.SSAM_USERS_REAL_VAULT_TEST !== '1') && 'only with SSAM_USERS_REAL_VAULT_TEST=1 on Windows: it touches the vault API', timeout: 120000 }, async t => {
  const users = createUsersKind({ dataRoot: tmp(t) });
  assert.deepEqual(await users.execute({ op: 'status', host: HOST }), { available: false, principal: null });
  assert.deepEqual(await users.execute({ op: 'status', host: HOST, kind: 'password', entry: 'a'.repeat(64) }), { available: false, principal: null });
  assert.deepEqual(await users.execute({ op: 'forget', host: HOST, kind: 'password', entry: 'a'.repeat(64) }), {});
  await assert.rejects(users.execute(request()), e => e.code === 'USERS_HOST_NOT_AUTHENTICATED' && e.executed === false);
  await assert.rejects(users.execute({ op: 'login', host: HOST }), e => e.code === 'USERS_HOST_NOT_AUTHENTICATED');
});

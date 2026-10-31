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
const VAULT_SHA256 = '8b7bccbefa07fb6b44256f493eb262b110a9ae41a5b1c894657ac7559549c304';
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

test('when the server box has the kind, it is the same word in its closed list', async t => {
  const file = new URL('../../../server/platforms/odc/facade/call-kinds.mjs', import.meta.url);
  if (!fs.existsSync(file)) return t.skip('no server box here');
  const { CALL_KINDS } = await import(file.href);
  if (!CALL_KINDS.some(kind => kind.includes('users'))) return t.skip('the server box has not received the kind yet');
  assert.ok(CALL_KINDS.includes(USERS_KIND));
});

for (const row of usersRows()) test('table: ' + row.label, () => assert.equal(codeOf(() => validateUsersRequest(row.request)), row.expected));

for (const [address, expected] of addressRows()) test('address: ' + address, () => assert.equal(isPrivateAddress(address), expected));
for (const [host, approved, expected] of lookalikeRows()) test(`lookalike: ${host} after ${approved.join(', ') || 'nothing'}`, () => assert.equal(lookalikeOf(host, approved), expected));

function kind(t, { answers = [], platform = 'win32', lookup = async () => [{ address: '93.184.216.34', family: 4 }] } = {}) {
  const dataRoot = tmp(t), calls = [];
  const users = createUsersKind({ dataRoot, platform, lookup, env: { SystemRoot: 'C:\\Windows' }, exec: async (file, args, input) => { calls.push({ file, args, input }); return JSON.stringify(answers.shift() ?? { ok: true }); } });
  return { users, calls, dataRoot };
}
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
  await k.users.execute(request({ host: other, url: `https://${other}/Users/User_List.aspx` }));
  assert.equal(decoded(k.calls[2]).cookie, '', 'another environment never gets it');
  await k.users.execute(request());
  await k.users.execute(request());
  assert.equal(decoded(k.calls[4]).cookie, 'ASP.NET_SessionId=abc', 'an emptied cookie leaves the jar');
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
  const k = kind(t, { answers: [page(), { ok: true }] });
  assert.equal((await k.users.execute(post)).passwordForgotten, true);
  const forgets = k.calls.filter(c => c.args[c.args.indexOf('-Mode') + 1] === 'forget');
  assert.equal(forgets.length, 1);
  assert.equal(forgets[0].args[forgets[0].args.indexOf('-Entry') + 1], entry);
  const failed = kind(t, { answers: [{ ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED' }, { ok: true }] });
  await assert.rejects(failed.users.execute(post), e => e.code === 'USERS_PRIVATE_REQUEST_FAILED');
  assert.equal(failed.calls.filter(c => c.args[c.args.indexOf('-Mode') + 1] === 'forget').length, 1);
  const stuck = kind(t, { answers: [page(), { ok: false, code: 'USERS_PRIVATE_REQUEST_FAILED' }] });
  assert.equal((await stuck.users.execute(post)).passwordForgotten, false);
  const plain = kind(t, { answers: [page()] });
  assert.equal(Object.hasOwn(await plain.users.execute(request()), 'passwordForgotten'), false);
  assert.equal(plain.calls.length, 1);
});

test('the helper runs hidden, with this installation\'s scope, and takes no secret in its arguments', async t => {
  const k = kind(t, { answers: [{ ok: true, available: true, principal: 'admin' }] });
  assert.deepEqual(await k.users.execute({ op: 'status', host: HOST }), { available: true, principal: 'admin' });
  const { file, args } = k.calls[0];
  assert.match(file, /powershell\.exe$/i);
  assert.equal(args[args.indexOf('-Scope') + 1], usersScope(k.dataRoot));
  assert.equal(args[args.indexOf('-HostName') + 1], HOST);
  assert.notEqual(usersScope(k.dataRoot), usersScope(k.dataRoot + '-other'), 'each installation has its own entries');
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
  const users = createUsersKind({ dataRoot, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }],
    exec: async () => JSON.stringify({ ok: true, hosts: [] }),
    start: (file, args) => {
      started.push(args);
      const statusFile = args[args.indexOf('-PromptStatusPath') + 1];
      fs.writeFileSync(statusFile, 'visible');
      return { exitCode: null, on() {}, unref() {} };
    } });
  assert.deepEqual(await users.execute({ op: 'prompt', host: HOST }), { opened: true, alreadyOpen: false, visible: true });
  const statusFile = started[0][started[0].indexOf('-PromptStatusPath') + 1];
  assert.ok(statusFile.startsWith(path.join(dataRoot, 'private', 'users') + path.sep));
  assert.equal(fs.existsSync(statusFile), false);
  assert.deepEqual(await users.execute({ op: 'prompt', host: HOST }), { opened: false, alreadyOpen: true });
  assert.equal(started.length, 1);
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

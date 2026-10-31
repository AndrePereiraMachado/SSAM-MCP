// The kind o11.users (agent/lib/users.mjs): the table of what passes (the native core answers the same rows, tests/native/
// users.test.mjs), the session that stays here, the helper's arguments, the platform answer and the vault helper shared with the
// server by its sha. A fake helper: no vault, window or network here. The vault and the window are proved live (the release gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUsersKind, validateUsersRequest, usersScope, USERS_KIND, USERS_HELPER } from '../lib/users.mjs';
import { KINDS, helloKinds } from '../lib/kinds.mjs';
import { usersRows, HOST, b64 } from './fixtures/users-table.mjs';

// The sha both sides name: here and platforms/odc/facade/tests/o11-users-hosted.test.mjs in the server line.
const VAULT_SHA256 = 'd60442f8bb527a2acd9d34b7d33dde601e6654389f40b3de41780112d916c57a';
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

function kind(t, { answers = [], platform = 'win32' } = {}) {
  const dataRoot = tmp(t), calls = [];
  const users = createUsersKind({ dataRoot, platform, env: { SystemRoot: 'C:\\Windows' }, exec: async (file, args, input) => { calls.push({ file, args, input }); return JSON.stringify(answers.shift() ?? { ok: true }); } });
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

test('the helper runs hidden, with this installation\'s scope, and takes no secret in its arguments', async t => {
  const k = kind(t, { answers: [{ ok: true, available: true, principal: 'admin' }] });
  assert.deepEqual(await k.users.execute({ op: 'status', host: HOST }), { available: true, principal: 'admin' });
  const { file, args } = k.calls[0];
  assert.match(file, /powershell\.exe$/i);
  assert.equal(args[args.indexOf('-Scope') + 1], usersScope(k.dataRoot));
  assert.equal(args[args.indexOf('-HostName') + 1], HOST);
  assert.notEqual(usersScope(k.dataRoot), usersScope(k.dataRoot + '-other'), 'each installation has its own entries');
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

test('the prompt: its status file is under the agent\'s own folder and is removed; a second one is not opened', async t => {
  const dataRoot = tmp(t);
  const started = [];
  const users = createUsersKind({ dataRoot, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {},
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
  const users = createUsersKind({ dataRoot: tmp(t), platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, wait: async () => {}, start: () => ({ exitCode: 1, on() {}, unref() {} }) });
  await assert.rejects(users.execute({ op: 'prompt', host: HOST }), e => e.code === 'USERS_PROMPT_NOT_VISIBLE');
});

test('the helper carries the rules of its own side: closed modes and routes, the vault before any request, no redirect', () => {
  const text = fs.readFileSync(USERS_HELPER, 'utf8');
  assert.match(text, /\$web\.AllowAutoRedirect=\$false/);
  assert.match(text, /USERS_HOST_NOT_AUTHENTICATED/);
  assert.ok(text.indexOf('USERS_HOST_NOT_AUTHENTICATED') < text.indexOf('[Net.HttpWebRequest]::Create'), 'the vault is read before any request');
  assert.match(text, /Login credential outside login route/);
  assert.match(text, /\$uri\.Scheme -ne 'https' -or \$uri\.Host -ne \$HostName/);
});

// The real helper, on a scope nobody has: the vault is only looked up, no window opens and nothing goes out.
test('the real helper: an environment with no administrator stored is refused before any request', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const users = createUsersKind({ dataRoot: tmp(t) });
  assert.deepEqual(await users.execute({ op: 'status', host: HOST }), { available: false, principal: null });
  assert.deepEqual(await users.execute({ op: 'status', host: HOST, kind: 'password', entry: 'a'.repeat(64) }), { available: false, principal: null });
  assert.deepEqual(await users.execute({ op: 'forget', host: HOST, kind: 'password', entry: 'a'.repeat(64) }), {});
  await assert.rejects(users.execute(request()), e => e.code === 'USERS_HOST_NOT_AUTHENTICATED' && e.executed === false);
  await assert.rejects(users.execute(request({ url: `https://${HOST}/Users/Login.aspx`, method: 'POST', secretRefs: [{ field: 'p', kind: 'login', part: 'password' }] })), e => e.code === 'USERS_HOST_NOT_AUTHENTICATED');
});

// Lane F8 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md, A13): the session asked the user for the numeric id of a
// test user and for an exception to open the Users app, after o11_data answered "Users and roles are out of reach of
// Edit Data here" (cx-0e61, 06/10 01:05). o11_access {action:"users"} is the read-only lookup of users and roles through
// the Studio's own login (CLI `users`, UserDirectory): a closed list of fields, never a password or hash, no words.
// The CLI is a fake; no Studio, no dotnet.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Access, usersArguments, usersOutcome } from '../o11-access.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f8-access-'));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home');
  for (const dir of [root, home]) fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, env: { USERPROFILE: home, HOME: home, ANVIL_AUTHORITY_DIR: path.join(base, 'authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' } };
}

async function serve(t, runAnvil, { selected = async () => {} } = {}) {
  const box = sandbox(t);
  const server = new McpServer({ name: 'pa2-f8-access', version: '1.0.0' });
  registerO11Access(server, { root: box.root, env: box.env, lane: 'ss4', runAnvil, assertSelected: selected });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f8-access-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async args => { const r = await client.callTool({ name: 'o11_access', arguments: args }); return { ...JSON.parse(r.content[0].text), isError: r.isError === true }; };
  return { ...box, client, call };
}

// What the kernel answers for `users` (UserDirectory.Lookup); a field the closed list does not name must never pass.
const kernelUsers = (extra = {}) => ({ ok: true, command: 'users', data: { ok: true, host: 'personal-0000test.outsystemscloud.com', total: 1,
  users: [{ id: '7', username: 'tester', name: 'Tester', email: 'tester@example.test', isActive: true, roles: ['Technician'], password: 'pbkdf2$SYNTHETIC', ...extra }] } });

test('users {email} answers the user and its role names without any password field, through a read-only lease and no words', async t => {
  const runAnvil = fakeAnvil({ users: () => kernelUsers() });
  const h = await serve(t, runAnvil);
  const value = await h.call({ action: 'users', email: 'tester@example.test' });
  assert.equal(value.ok, true);
  assert.deepEqual(value.users, [{ id: '7', username: 'tester', name: 'Tester', email: 'tester@example.test', isActive: true, roles: ['Technician'] }]);
  assert.equal(value.total, 1);
  assert.doesNotMatch(JSON.stringify(value), /password|pbkdf2|hash/i);
  const argv = runAnvil.calls[0].args;
  assert.deepEqual(argv.slice(0, 4), ['users', '--read-only', '--email', 'tester@example.test']);
  assert.deepEqual(argv.slice(4, 6), ['--max', '20']);
  assert.equal(argv[6], '--work');
  assert.ok(!argv.some(a => /credential|words/i.test(a)));
});

test('users takes only its read fields: words, a manifest or a flag-like value are refused before the CLI', async t => {
  const runAnvil = fakeAnvil({ users: () => kernelUsers() });
  const h = await serve(t, runAnvil);
  const words = await h.call({ action: 'users', email: 'a@b.test', words: 'sim' });
  assert.deepEqual([words.ok, words.code], [false, 'UNKNOWN_ARGUMENT']);
  assert.deepEqual(words.continuation.arguments, { action: 'users', email: 'a@b.test' });
  assert.equal((await h.call({ action: 'users', manifestPath: 'C:\\x.json' })).code, 'UNKNOWN_ARGUMENT');
  assert.equal((await h.call({ action: 'users', role: '--confirm' })).code, 'BAD_VALUE');
  assert.equal(runAnvil.calls.length, 0);
  // plan and apply refuse the users fields (their own contract stays as it was).
  assert.equal((await h.call({ action: 'plan', manifestPath: 'C:\\x.json', email: 'a@b.test' })).code, 'UNKNOWN_ARGUMENT');
});

test('users by role and max: the role goes to the CLI, max is kept within 1..100 and reported', async t => {
  const runAnvil = fakeAnvil({ users: () => ({ ok: true, command: 'users', data: { ok: true, users: [], total: 0, unknownRole: 'Auditor', roles: ['Manager', 'Technician'] } }) });
  const h = await serve(t, runAnvil);
  const value = await h.call({ action: 'users', role: 'Auditor', max: 500, host: 'personal-0000test.outsystemscloud.com' });
  assert.deepEqual([value.ok, value.unknownRole, value.roles], [true, 'Auditor', ['Manager', 'Technician']]);
  assert.deepEqual(value.inputAdjusted, [{ path: 'max', from: 500, to: 100, rule: 'clamp' }]);
  assert.deepEqual(runAnvil.calls[0].args.slice(0, 8), ['users', '--read-only', '--host', 'personal-0000test.outsystemscloud.com', '--role', 'Auditor', '--max', '100']);
});

test('an older bridge answers STUDIO_BRIDGE_OUTDATED with the reconnect continuation; no Studio selected refuses before the CLI', async t => {
  const old = fakeAnvil({ users: () => ({ ok: false, command: 'users', code: 'STUDIO_BRIDGE_OUTDATED',
    error: 'KernelRefusalException: The bridge loaded in the Studio has no users lookup (environment_session:users-read); open the Service Studio through the "Service Studio (SSAM)" shortcut so the current bridge loads, then reconnect it; nothing was read' }) });
  const h = await serve(t, old);
  const value = await h.call({ action: 'users', username: 'tester' });
  assert.deepEqual([value.ok, value.code, value.continuation.tool], [false, 'STUDIO_BRIDGE_OUTDATED', 'ssam_connect']);
  const none = fakeAnvil({ users: () => kernelUsers() });
  const h2 = await serve(t, none, { selected: async () => { throw new Error('no Studio selected'); } });
  assert.equal((await h2.call({ action: 'users', email: 'a@b.test' })).code, 'STUDIO_NOT_SELECTED');
  assert.equal(none.calls.length, 0);
  // usersOutcome alone: an unknown failure keeps its code, else USERS_LOOKUP_FAILED with the doctor.
  assert.equal(usersOutcome({ envelope: { ok: false, error: 'boom' } }, {}).code, 'USERS_LOOKUP_FAILED');
  assert.deepEqual(usersArguments({ email: ' a@b.test ' }), ['users', '--read-only', '--email', 'a@b.test', '--max', '20']);
});

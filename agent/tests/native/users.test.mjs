// o11.users in the native core, which is what ships in the app. check-users-request answers the Node table row by row. check-users-flow runs the
// behaviour table of fixtures/users-flow.mjs on the real UsersKinds and UsersPage, over the same stand-in for the helper as the Node agent:
// the same answers and the same requests. No vault, window or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { usersRows, addressRows, lookalikeRows } from '../../agent/tests/fixtures/users-table.mjs';
import { flows, prepare, verify, readState, nativeInput, runNode, tempDir } from '../../agent/tests/fixtures/users-flow.mjs';
import { createUsersKind, validateUsersRequest, isPrivateAddress, lookalikeOf, usersScope, USERS_HELPER } from '../../agent/lib/users.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const dll = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll');
const native = (args, options = {}) => {
  const exe = process.env.SSAM_NATIVE_EXE;
  return spawnSync(exe || 'dotnet', exe ? args : [dll, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
};

test('native check-users-request answers the Node table row by row', { timeout: 120000 }, () => {
  const rows = usersRows();
  const expected = rows.map(row => { try { validateUsersRequest(row.request); return { ok: true }; } catch (error) { return { error: error.code }; } });
  const result = native(['check-users-request'], { input: JSON.stringify(rows.map(row => row.request)) });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  rows.forEach((row, i) => {
    assert.deepEqual(actual[i], expected[i], row.label);
    assert.deepEqual(actual[i], row.expected === 'ok' ? { ok: true } : { error: row.expected }, row.label);
  });
});
test('native check-users-address and check-users-lookalike answer as the Node agent', { timeout: 120000 }, () => {
  const addresses = addressRows();
  const a = native(['check-users-address'], { input: JSON.stringify(addresses.map(([address]) => address)) });
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(JSON.parse(a.stdout), addresses.map(([address]) => isPrivateAddress(address)));
  assert.deepEqual(JSON.parse(a.stdout), addresses.map(([, expected]) => expected));
  const rows = lookalikeRows();
  const l = native(['check-users-lookalike'], { input: JSON.stringify(rows.map(([host, approved]) => [host, approved])) });
  assert.equal(l.status, 0, l.stderr);
  assert.deepEqual(JSON.parse(l.stdout), rows.map(([host, approved]) => lookalikeOf(host, approved)));
  assert.deepEqual(JSON.parse(l.stdout), rows.map(row => row[2]));
});
test('M3: the vault scope is the same in the native core and the Node agent', { timeout: 120000 }, () => {
  for (const [root, account] of [['C:\\agent\\data', 'ssam_agent_a'], ['C:\\agent\\data', 'ssam_agent_b'], ['C:\\Other\\Place', 'ssam_agent_a']]) {
    const result = native(['users-scope', root, account]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), usersScope(root, account));
  }
});
test('the helper embedded in the native core is the Node agent\'s file, byte for byte', { timeout: 120000 }, () => {
  const result = native(['users-helper-sha256']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), createHash('sha256').update(fs.readFileSync(USERS_HELPER)).digest('hex'));
});
test('the native channel lists the kind in both Hello forms, runs it, and gives it the credential as the account', () => {
  const channel = fs.readFileSync(path.join(app, 'native/Ssam.Agent/AgentChannel.cs'), 'utf8');
  assert.match(channel, /"file\.sync", UploadKinds\.Name, UsersKinds\.Name, DocumentFetch\.Name \}/); // r40: document.fetch after it
  assert.match(channel, /\.Append\(UsersKinds\.Name\)/);
  assert.match(channel, /new UsersKinds\(state\.Root, credential, runtime\);\s*_ = users\.Startup\(\);/);
  assert.match(channel, /kind == UsersKinds\.Name\) value = await users\.Execute/);
  const kind = fs.readFileSync(path.join(app, 'native/Ssam.Agent/UsersKinds.cs'), 'utf8');
  assert.match(kind, /USERS_PLATFORM_UNAVAILABLE", "Users administration is not available on this platform\./);
});
for (const flow of flows()) test('native flow: ' + flow.name, { timeout: 180000 }, async t => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  prepare(dir, flow);
  const result = native(['check-users-flow'], { input: JSON.stringify(nativeInput(flow, dir)), env: { ...process.env, SSAM_USERS_FAKE_STATE: path.join(dir, 'state.json') } });
  assert.equal(result.status, 0, result.stderr);
  const results = JSON.parse(result.stdout);
  const state = readState(dir);
  verify(flow, results, state);
  // The Node agent, over the same steps: the same requests leave.
  const other = tempDir();
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const node = await runNode(flow, createUsersKind, other);
  assert.deepEqual(state.http, node.state.http, 'the same requests');
  assert.deepEqual(state.windows, node.state.windows, 'the same windows');
  assert.deepEqual(results.map(r => r?.code ?? null), node.results.map(r => r?.code ?? null), 'the same refusals');
});

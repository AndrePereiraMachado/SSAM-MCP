// o11.users in the native core: check-users-request answers the Node table row by row, the embedded helper is the Node agent's
// file byte for byte, and the sources list the kind in both Hello forms and answer a clear refusal outside Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { usersRows, addressRows, lookalikeRows } from '../../agent/tests/fixtures/users-table.mjs';
import { validateUsersRequest, isPrivateAddress, lookalikeOf, USERS_HELPER } from '../../agent/lib/users.mjs';

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

test('the helper embedded in the native core is the Node agent\'s file, byte for byte', { timeout: 120000 }, () => {
  const result = native(['users-helper-sha256']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), createHash('sha256').update(fs.readFileSync(USERS_HELPER)).digest('hex'));
});

test('the sources list the kind in both Hello forms and refuse it elsewhere than Windows', () => {
  const channel = fs.readFileSync(path.join(app, 'native/Ssam.Agent/AgentChannel.cs'), 'utf8');
  assert.match(channel, /"file\.sync", UploadKinds\.Name, UsersKinds\.Name \}/);
  assert.match(channel, /\.Append\(UsersKinds\.Name\)/);
  const kind = fs.readFileSync(path.join(app, 'native/Ssam.Agent/UsersKinds.cs'), 'utf8');
  assert.match(kind, /USERS_PLATFORM_UNAVAILABLE", "Users administration is not available on this platform\./);
});

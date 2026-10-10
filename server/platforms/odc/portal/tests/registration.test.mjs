import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registrationCommand, matchesRegistration, unrelatedServersDigest, nonTargetConfigDigest, safeRegistrationSummary } from '../runtime/registration.mjs';

const nodePath = path.resolve('node.exe');
const entryPath = path.resolve('runtime/odc3-host.mjs');
const entry = { name: 'odc3', enabled: true, transport: { type: 'stdio', command: nodePath, args: [entryPath] } };

test('registration is one exact stdio ODC3 entry, with no inline secrets', () => {
  assert.deepEqual(registrationCommand(nodePath, entryPath), ['mcp', 'add', 'odc3', '--', nodePath, entryPath]);
  assert.throws(() => registrationCommand('node', entryPath));
  assert.equal(matchesRegistration(entry, nodePath, entryPath), true);
  assert.equal(matchesRegistration({ ...entry, transport: { ...entry.transport, env: { SECRET: 'test-only' } } }, nodePath, entryPath), false);
  assert.equal(matchesRegistration({ ...entry, transport: { ...entry.transport, args: [entryPath, '--other'] } }, nodePath, entryPath), false);
});

test('registration verification preserves other MCP and excludes only exact ODC3 config tables', () => {
  const unrelated = { name: 'ssam_hybrid', enabled: false, transport: { type: 'stdio', command: 'existing' } };
  assert.equal(unrelatedServersDigest([unrelated]), unrelatedServersDigest([entry, unrelated]));
  assert.notEqual(unrelatedServersDigest([unrelated]), unrelatedServersDigest([{ ...unrelated, enabled: true }]));
  const before = 'model="existing"\n\n[mcp_servers.ssam_hybrid]\nenabled=false\n[other]\nkey="preserve"\n';
  const after = before + '\n[mcp_servers.odc3]\ncommand="node"\nargs=["entry"]\n';
  assert.equal(nonTargetConfigDigest(before), nonTargetConfigDigest(after));
  assert.notEqual(nonTargetConfigDigest(before), nonTargetConfigDigest(after.replace('enabled=false', 'enabled=true')));
  assert.deepEqual(safeRegistrationSummary([{ ...entry, transport: { ...entry.transport, env: { SECRET: 'hidden' } } }]),
    [{ name: 'odc3', enabled: true, transport: 'stdio' }]);
});

import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMcpConnectionReadiness } from '../runtime/mcp-connection-readiness.mjs';

const id = 'connection-one';
const connection = { connectionId: id, providerId: 'mcp', name: 'Proof', updatedOn: '2026-10-08T10:00:00Z', externalMetadata: { selectedActionCount: 0 } };
function reader(overrides = {}) {
  const calls = [];
  const replies = {
    'connections.detail': { NotFound: false, Connection: connection },
    'connections.connection': { LastSuccessfulMetadataUpdateTimestamp: '2026-10-08T10:00:00Z' },
    'connections.actions': { ActionList: { List: [{ OriginalName: 'lookup', IsNotSupported: false,
      ApiKey: 'must-not-leak', Schema: 'private-schema' }] } },
    'connections.selectedActions': { ActionList: { List: [] } }, ...overrides,
  };
  return { calls, read: async (operation, input) => {
    calls.push({ operation, input });
    const reply = typeof replies[operation] === 'function' ? replies[operation](calls.length) : replies[operation];
    return reply?.ok === false ? reply : { ok: true, data: reply };
  } };
}

test('reads exactly the selected connection, verifies version and excludes raw metadata', async () => {
  const { read, calls } = reader();
  const result = await readMcpConnectionReadiness({ connectionId: id }, read);
  assert.equal(result.readyForToolImport, true);
  assert.equal(result.hasImportedTools, false);
  assert.deepEqual(result.availableActions, [{ name: 'lookup', supported: true }]);
  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(call.input.connectionId ?? call.input.screenVariables.ConnectionId, id);
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
  assert.ok(!JSON.stringify(result).includes('private-schema'));
});

test('missing connection never queries actions', async () => {
  const { read, calls } = reader({ 'connections.detail': { NotFound: true, Connection: null } });
  const result = await readMcpConnectionReadiness({ connectionId: id }, read);
  assert.equal(result.exists, false);
  assert.equal(result.readyForToolImport, false);
  assert.equal(calls.length, 1);
});

for (const [name, overrides, reason] of [
  ['sentinel metadata date', { 'connections.connection': { LastSuccessfulMetadataUpdateTimestamp: '1900-01-01T00:00:00Z' } }, 'successful-metadata-update-unverified'],
  ['unsupported action', { 'connections.actions': { ActionList: [{ Name: 'lookup', IsNotSupported: true }] } }, 'no-supported-actions'],
  ['unknown action support', { 'connections.actions': { ActionList: [{ Name: 'lookup' }] } }, 'action-support-unverified'],
  ['selected metadata error', { 'connections.selectedActions': { ErrorMessage: 'private error' } }, 'selected-actions-error'],
  ['changed connection', { 'connections.detail': n => ({ NotFound: false, Connection: { ...connection, updatedOn: n === 1 ? connection.updatedOn : 'later' } }) }, 'connection-version-unverified-or-changed'],
  ['incomplete selected actions', { 'connections.detail': { NotFound: false, Connection: { ...connection, externalMetadata: { selectedActionCount: 2 } } } }, 'selected-action-count-unverified'],
  ['selected count changed without timestamp change', { 'connections.detail': n => ({ NotFound: false, Connection: { ...connection, externalMetadata: { selectedActionCount: n === 1 ? 0 : 1 } } }) }, 'selected-action-count-unverified'],
]) test(name + ' cannot report import readiness', async () => {
  const { read } = reader(overrides);
  const result = await readMcpConnectionReadiness({ connectionId: id }, read);
  assert.equal(result.readyForToolImport, false);
  assert.ok(result.blockedReasons.includes(reason));
  assert.ok(!JSON.stringify(result).includes('private error'));
  if (name === 'selected metadata error') assert.equal(result.hasImportedTools, null);
});

test('ambiguous action names and malformed list fail closed', async () => {
  for (const data of [{}, { ActionList: [{ Name: 'same' }, { Name: 'same' }] }]) {
    const { read } = reader({ 'connections.actions': data });
    await assert.rejects(readMcpConnectionReadiness({ connectionId: id }, read), { code: 'PORTAL_CONTRACT_CHANGED' });
  }
});

test('wrong connection identity and invalid selectors are refused before action reads', async () => {
  const { read, calls } = reader({ 'connections.detail': { NotFound: false, Connection: { ...connection, connectionId: 'other' } } });
  await assert.rejects(readMcpConnectionReadiness({ connectionId: id }, read), { code: 'PORTAL_CONTRACT_CHANGED' });
  assert.equal(calls.length, 1);
  await assert.rejects(readMcpConnectionReadiness({ connectionId: '../other' }, read), { code: 'INPUT_INVALID' });
  assert.equal(calls.length, 1);
});

test('upstream read failure is preserved, never treated as an empty successful list', async () => {
  const failure = { ok: false, error: { code: 'READ_DEADLINE_EXCEEDED' } };
  const { read, calls } = reader({ 'connections.actions': failure });
  assert.deepEqual(await readMcpConnectionReadiness({ connectionId: id }, read), failure);
  assert.equal(calls.length, 3);
});

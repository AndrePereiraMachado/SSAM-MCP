import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeMcpImport, observeMcpImport, planMcpImport } from '../runtime/mcp-import.mjs';
import { WriteJournal } from '../runtime/write-journal.mjs';
import { OdcAccess } from '../runtime/access.mjs';
import { isWrite } from '../../facade/studio-write-lock.mjs';

async function fixture(t, mode = 'success') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receipts = new WriteJournal(dir), state = { sent: 0, selected: [], readFails: false, version: '2026-10-09T00:00:00Z' };
  const action = { ActionId: 'a', ConnectionId: 'c', Name: 'lookup', OriginalName: 'lookup',
    Description: '', IsNotSupported: false, Parameters: { List: [] } };
  const read = async operationId => {
    if (state.readFails) throw Error('read failed');
    return { ok: true, data: {
      'connections.detail': { NotFound: false, Connection: { connectionId: 'c', providerId: 'mcp', name: 'Fixture',
        updatedOn: state.version, externalMetadata: { selectedActionCount: state.selected.length, selectedObjectCount: 0 } } },
      'connections.connection': { LastSuccessfulMetadataUpdateTimestamp: state.version, ConnectionUpdateTimestamp: state.version },
      'connections.actions': { ActionList: [action] }, 'connections.selectedActions': { ActionList: state.selected },
    }[operationId] };
  };
  const input = { tenant: 'corp.outsystems.dev', connectionId: 'c', toolNames: ['lookup'],
    operationUuid: crypto.randomUUID(), authorize: 'Import lookup on corp.outsystems.dev', confirmTenant: 'corp.outsystems.dev' };
  input.expectedPlanSha256 = planMcpImport(input, await observeMcpImport(input, read)).preview.planSha256;
  const access = { receipts, now: Date.now, journal: () => {}, pickTenant: async host => host,
    tenantInfo: host => ({ host, class: 'corporate' }), resolvePortal: async host => ({ path: 'vault', host,
      broker: { callScreenservice: async request => {
        state.sent++;
        const durable = receipts.lookup(request.operationUuid);
        assert.equal(durable.state, 'uncertain');
        assert.equal(durable.reconciliation.mcpImport.planSha256, input.expectedPlanSha256);
        if (mode !== 'not-applied') state.selected = structuredClone(request.input.inputParameters.DatabaseObjects.Actions.List);
        if (mode === 'assigned-ids') state.selected[0].ActionId = 'server-assigned';
        if (mode === 'changed-definition') state.selected[0].Name = 'unexpected-alias';
        if (mode === 'read-failure') state.readFails = true;
        if (mode === 'lost-response' || mode === 'not-applied') throw Object.assign(Error('lost response'), { code: 'HTTP_FAILED', sent: true });
        return { data: {} };
      } } }) };
  const deps = { receipts, read, write: (request, options) => OdcAccess.prototype.portalWrite.call(access, request, options) };
  return { input, deps, state, receipts };
}
test('sends once, records plan before send and confirms full selection by read-back', async t => {
  const h = await fixture(t);
  const result = await executeMcpImport(h.input, h.deps);
  assert.equal(result.receipt.state, 'confirmed');
  assert.equal(result.selectionConfirmed, true);
  const repeated = await executeMcpImport(h.input, h.deps);
  assert.equal(repeated.existingReceipt, true);
  assert.equal(repeated.replayed, false);
  assert.equal(h.state.sent, 1);
  assert.equal(isWrite('odc_mcp_import', h.input), true);
});
test('lost response is reconciled without resending', async t => {
  const h = await fixture(t, 'lost-response');
  assert.equal((await executeMcpImport(h.input, h.deps)).receipt.state, 'confirmed');
  assert.equal(h.state.sent, 1);
});
test('server-assigned IDs do not hide an otherwise matching definition', async t => {
  const h = await fixture(t, 'assigned-ids');
  assert.equal((await executeMcpImport(h.input, h.deps)).selectionConfirmed, true);
});
test('a changed imported definition is not confirmed by matching names or counts alone', async t => {
  const h = await fixture(t, 'changed-definition');
  const result = await executeMcpImport(h.input, h.deps);
  assert.equal(result.selectionConfirmed, false); assert.equal(result.ok, false);
});
test('unknown outcome holds target lock and does not turn absence into failure proof', async t => {
  const h = await fixture(t, 'not-applied');
  const first = await executeMcpImport(h.input, h.deps);
  assert.equal(first.ok, false); assert.equal(first.receipt.state, 'uncertain');
  await executeMcpImport(h.input, h.deps);
  const another = await executeMcpImport({ ...h.input, operationUuid: crypto.randomUUID() }, h.deps);
  assert.equal(another.error.code, 'TARGET_PENDING');
  assert.equal(h.state.sent, 1);
});
test('read failure preserves accepted receipt and later resumes observation only', async t => {
  const h = await fixture(t, 'read-failure');
  const first = await executeMcpImport(h.input, h.deps);
  assert.equal(first.receipt.state, 'accepted'); assert.equal(first.ok, false);
  h.state.readFails = false;
  assert.equal((await executeMcpImport(h.input, h.deps)).receipt.state, 'confirmed');
  assert.equal(h.state.sent, 1);
});
test('changed plan is refused before write', async t => {
  const h = await fixture(t); h.state.version = '2026-10-09T00:00:01Z';
  await assert.rejects(executeMcpImport(h.input, h.deps), { code: 'MCP_IMPORT_PLAN_CHANGED' });
  assert.equal(h.state.sent, 0);
});
test('UUID cannot be reused for a different reviewed plan', async t => {
  const h = await fixture(t); await executeMcpImport(h.input, h.deps);
  await assert.rejects(executeMcpImport({ ...h.input, expectedPlanSha256: '0'.repeat(64) }, h.deps), { code: 'OPERATION_UUID_REUSED' });
  assert.equal(h.state.sent, 1);
});
test('corporate authorization guard remains enforced by the real writer', async t => {
  const h = await fixture(t); h.input.authorize = 'import lookup';
  const result = await executeMcpImport(h.input, h.deps);
  assert.equal(result.error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal(h.state.sent, 0);
});
test('interruption immediately after reservation retains reconciliation evidence without a second local write', async t => {
  const h = await fixture(t);
  const reserve = h.receipts.reserve.bind(h.receipts);
  h.receipts.reserve = options => { reserve(options); throw Error('simulated process interruption'); };
  const result = await executeMcpImport(h.input, h.deps);
  assert.equal(result.receipt.state, 'uncertain');
  const durable = h.receipts.lookup(h.input.operationUuid);
  assert.equal(durable.reconciliation.mcpImport.planSha256, h.input.expectedPlanSha256);
  const resumed = await executeMcpImport(h.input, h.deps);
  assert.equal(resumed.existingReceipt, true);
  assert.equal(h.state.sent, 0);
});

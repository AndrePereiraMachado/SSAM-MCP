import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpImportPlan } from '../runtime/mcp-import-plan.mjs';
import { OdcAccess } from '../runtime/access.mjs';

const parameter = { ParameterId: 'p', Name: 'custom', OriginalName: 'query', Description: '',
  DataType: 'Text', OriginalDataType: 'Text', DefaultDataType: 'Text', DefaultValue: 'private-default',
  IsArrayOfPrimitive: false, IsNotSupported: false, IsMandatory: false,
  ParameterType: 'Input', ChangeStatus: 'Unchanged', Fields: { List: [] } };
const action = key => ({ ActionId: key, ConnectionId: 'c', Name: key, OriginalName: key,
  Description: '', IsNotSupported: false, Parameters: { List: [] } });
function input() {
  return { connectionId: 'c', toolNames: ['new'], selectedObjectCount: 0,
    connectionUpdateTimestamp: '2026-10-09T00:00:00Z',
    readiness: { ok: true, readyForToolImport: true, connection: { connectionId: 'c', providerId: 'mcp' },
      availableActions: [{ name: 'old' }, { name: 'new' }], selectedActions: [{ name: 'old' }] },
    availableActions: [action('old'), action('new')],
    selectedActions: [{ ...action('old'), Parameters: { List: [structuredClone(parameter)] } }] };
}

test('adds requested tools while preserving selected customizations, without leaking defaults in preview', () => {
  const source = input(), before = structuredClone(source);
  const result = buildMcpImportPlan(source);
  assert.deepEqual(result.payload.inputParameters.DatabaseObjects.Actions.List.map(a => a.Name), ['old', 'new']);
  assert.deepEqual(result.payload.inputParameters.DatabaseObjects.Actions.List[0].Parameters.List[0], parameter);
  assert.deepEqual(result.preview.preservedTools, ['old']);
  assert.deepEqual(result.preview.addedTools, ['new']);
  assert.equal(result.preview.noOp, false);
  assert.ok(!JSON.stringify(result.preview).includes('private-default'));
  assert.deepEqual(source, before);
});
test('already imported request is a no-op and retains the selected definition', () => {
  const source = input(); source.toolNames = ['old'];
  const result = buildMcpImportPlan(source);
  assert.equal(result.preview.noOp, true);
  assert.equal(result.payload.inputParameters.DatabaseObjects.Actions.List.length, 1);
});
test('access plans from five headless reads and exposes only the public preview', async () => {
  const source = input(), calls = [];
  const data = {
    'connections.detail': { NotFound: false, Connection: { connectionId: 'c', providerId: 'mcp', name: 'Proof',
      updatedOn: source.connectionUpdateTimestamp, externalMetadata: { selectedActionCount: 1, selectedObjectCount: 0 } } },
    'connections.connection': { LastSuccessfulMetadataUpdateTimestamp: source.connectionUpdateTimestamp,
      ConnectionUpdateTimestamp: source.connectionUpdateTimestamp },
    'connections.actions': { ActionList: source.availableActions },
    'connections.selectedActions': { ActionList: source.selectedActions },
  };
  const access = { pickTenant: async tenant => tenant, portalRead: async request => {
    calls.push(request); return { ok: true, data: data[request.operationId] };
  }, portalWrite: () => assert.fail('planning must never write') };
  const result = await OdcAccess.prototype.mcpConnection.call(access, {
    tenant: 'wrightflood.outsystems.dev', action: 'import-plan', connectionId: 'c', toolNames: ['new'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.addedTools, ['new']);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.tenant === 'wrightflood.outsystems.dev' && call.auth === 'auto'));
  assert.ok(!JSON.stringify(result).includes('private-default'));
  assert.equal(result.payload, undefined);
});
test('plan hash binds defaults and version and ignores object property order', () => {
  const source = input(), hash = buildMcpImportPlan(source).preview.planSha256;
  source.selectedActions[0] = Object.fromEntries(Object.entries(source.selectedActions[0]).reverse());
  assert.equal(buildMcpImportPlan(source).preview.planSha256, hash);
  source.selectedActions[0].Parameters.List[0].DefaultValue = 'changed';
  assert.notEqual(buildMcpImportPlan(source).preview.planSha256, hash);
  source.selectedActions[0].Parameters.List[0].DefaultValue = 'private-default';
  source.connectionUpdateTimestamp = '2026-10-09T00:00:01Z';
  assert.notEqual(buildMcpImportPlan(source).preview.planSha256, hash);
});
for (const [label, change, code] of [
  ['implicit all', i => { i.toolNames = []; }, 'INPUT_INVALID'],
  ['duplicate request', i => { i.toolNames = ['new', 'new']; }, 'INPUT_INVALID'],
  ['unknown tool', i => { i.toolNames = ['absent']; }, 'INPUT_INVALID'],
  ['unsupported tool', i => { i.availableActions[1].IsNotSupported = true; }, 'INPUT_INVALID'],
  ['unverified readiness', i => { i.readiness.readyForToolImport = false; }, 'PORTAL_CONTRACT_CHANGED'],
  ['other connection', i => { i.selectedActions[0].ConnectionId = 'other'; }, 'PORTAL_CONTRACT_CHANGED'],
  ['existing entities', i => { i.selectedObjectCount = 1; }, 'PORTAL_CONTRACT_CHANGED'],
  ['unknown entity count', i => { delete i.selectedObjectCount; }, 'PORTAL_CONTRACT_CHANGED'],
  ['missing version', i => { delete i.connectionUpdateTimestamp; }, 'PORTAL_CONTRACT_CHANGED'],
  ['sentinel version', i => { i.connectionUpdateTimestamp = '1900-01-01T00:00:00Z'; }, 'PORTAL_CONTRACT_CHANGED'],
  ['missing selected parameters', i => { delete i.selectedActions[0].Parameters; }, 'PORTAL_CONTRACT_CHANGED'],
  ['missing selected parameter field', i => { delete i.selectedActions[0].Parameters.List[0].DefaultValue; }, 'PORTAL_CONTRACT_CHANGED'],
  ['ambiguous metadata', i => { i.availableActions.push(action('new')); }, 'PORTAL_CONTRACT_CHANGED'],
  ['incomplete selection', i => { i.selectedActions = []; }, 'PORTAL_CONTRACT_CHANGED'],
]) test('refuses ' + label, () => {
  const source = input(); change(source);
  assert.throws(() => buildMcpImportPlan(source), { code });
});

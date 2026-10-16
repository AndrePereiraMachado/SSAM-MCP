import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_CLASSIFICATIONS, classifyTool, declareToolClassification, isMutation, isStudioWrite } from '../tool-classification.mjs';
import { relayFailure } from '../ssam.mjs';

// Synthetic names/values only; no handler or external service is executed.
test('classification defaults unknown tools and unknown mixed operations to mutation', () => {
  const name = 'synthetic_future_write';
  assert.equal(TOOL_CLASSIFICATIONS.has(name), false);
  assert.deepEqual(classifyTool(name), { declared: false, isWrite: true, isReadOnly: false, destructive: false, source: 'default-mutation' });
  for (const tool of ['ssam_code', 'ssam_preview', 'odc_configurations', 'odc_external_db_connection'])
    assert.equal(isMutation(tool, { action: 'future-operation' }), true, tool);
});

test('classification derives declared pure reads, mutations and destructive hints consistently', t => {
  const cases = [
    ['synthetic_pure_read', { readOnlyHint: true, destructiveHint: false }, false],
    ['synthetic_hint_write', { readOnlyHint: false, destructiveHint: false }, true],
    ['synthetic_no_hint', {}, true],
    ['synthetic_destructive', { readOnlyHint: true, destructiveHint: true }, true],
  ];
  t.after(() => { for (const [name] of cases) TOOL_CLASSIFICATIONS.delete(name); });
  for (const [name, annotations, write] of cases) {
    declareToolClassification(name, { annotations });
    assert.equal(classifyTool(name).declared, true, name);
    assert.equal(isMutation(name), write, name);
  }
  assert.equal(classifyTool('synthetic_destructive').destructive, true);
});

test('classification matches ODC configurations get/set and its schema default', () => {
  assert.equal(isMutation('odc_configurations', { action: 'get' }), false);
  assert.equal(isMutation('odc_configurations'), false);
  assert.equal(isMutation('odc_configurations', { action: 'set' }), true);
  assert.equal(isMutation('odc_configurations', { action: 'list' }), true, 'unsupported action remains conservative');
});

test('classification matches external database connection read and write operations', () => {
  for (const action of ['providers', 'list', 'entities', 'plan-entities', 'plan-header'])
    assert.equal(isMutation('odc_external_db_connection', { action }), false, action);
  for (const action of ['edit-header', 'test', 'create', 'import-entities', 'get'])
    assert.equal(isMutation('odc_external_db_connection', { action }), true, action);
  // Junction CX12 x CX15 (M6-1): the destructive actions are a preview (a read) without their confirmationToken and a write with it.
  for (const action of ['remove-entities', 'delete']) {
    assert.equal(isMutation('odc_external_db_connection', { action }), false, action + ' preview');
    assert.equal(isMutation('odc_external_db_connection', { action, confirmationToken: '00000000-0000-4000-8000-00000000c12a.00000000000000c1' }), true, action + ' execution');
  }
});

test('classification keeps job/code/preview/debug and environment executions mutating', () => {
  for (const [tool, args] of [
    ['ssam_job', {}], ['ssam_code', { action: 'write' }], ['ssam_code', { action: 'plan' }],
    ['ssam_preview', { action: 'open' }], ['ssam_preview', { action: 'start' }],
    ['ssam_debug_run', {}], ['ssam_debug_server', { op: 'start' }], ['ssam_debug_client', { op: 'continue' }],
    ['odc_write', {}], ['odc_portal_write', {}], ['odc_deploy', {}], ['odc_asset_delete', { confirmationToken: '00000000-0000-4000-8000-00000000c12a.00000000000000c1' }],
    ['odc_asset_revision', {}], ['odc_a2a_connection_delete', { confirmationToken: '00000000-0000-4000-8000-00000000c12a.00000000000000c1' }],
  ]) assert.equal(isMutation(tool, args), true, tool);
  // Junction CX12 x CX15 (M6-1): a destructive call without its confirmationToken is the preview, a read.
  for (const [tool, args] of [['ssam_code', { action: 'read' }], ['ssam_preview', { action: 'status' }], ['ssam_debug_server', { op: 'status' }],
    ['odc_asset_delete', {}], ['odc_a2a_connection_delete', {}]])
    assert.equal(isMutation(tool, args), false, tool);
});

test('classification doctor and task close mutate, ordinary task reads remain pure', () => {
  assert.equal(isMutation('ssam_doctor', { task: { id: 'synthetic' } }), false);
  assert.equal(isMutation('ssam_doctor', { task: { id: 'synthetic', close: { reason: 'synthetic reconciliation' } } }), true);
  assert.equal(isMutation('ssam_doctor', { release: { reservation: 'synthetic' } }), true);
  assert.equal(isMutation('ssam_task', { id: 'synthetic' }), false);
  assert.equal(isMutation('ssam_task', { id: 'synthetic', close: { reason: 'synthetic reconciliation' } }), true);
});

test('classification does not put Portal and local mutations into the Studio queue', () => {
  assert.equal(isMutation('odc_asset_delete', { confirmationToken: '00000000-0000-4000-8000-00000000c12a.00000000000000c1' }), true); // junction (M6-1): the execution
  assert.equal(isStudioWrite('odc_asset_delete', { confirmationToken: '00000000-0000-4000-8000-00000000c12a.00000000000000c1' }), false);
  assert.equal(isMutation('ssam_grant', { action: 'grant' }), true);
  assert.equal(isStudioWrite('ssam_grant', { action: 'grant' }), false);
  assert.equal(isStudioWrite('studio_publish'), true);
});

test('relay failure uses the shared classification for uncertain mutation outcomes', () => {
  const error = Object.assign(new Error('synthetic relay timeout'), { code: 'REQUEST_TIMEOUT' });
  for (const [tool, args] of [['odc_deploy', {}], ['ssam_job', {}], ['odc_configurations', { action: 'set' }]])
    assert.equal(relayFailure(error, { tool, args }).outcome, 'uncertain', tool);
  for (const [tool, args] of [['studio_status', {}], ['odc_configurations', { action: 'get' }]])
    assert.equal(relayFailure(error, { tool, args }).outcome, undefined, tool);
});

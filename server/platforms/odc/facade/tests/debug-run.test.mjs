import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../debug-wrapper.mjs';
import { assetKeyOf } from '../debug-odc-portal.mjs';
import { moduleKeyOf, runSchema, compactMap, normalizeScenarios, validateNativeScenarios } from '../debug-run.mjs';

test('scenario user context survives normalization (anonymous and role overrides)', () => {
  const input = runSchema.parse({ op: 'run', tenant: 'wrightflood.outsystems.dev', module: 'M', action: 'A', scenarios: [
    { name: 'me', inputs: {} }, { name: 'no-role', as: { roles: { FloodQuotes: false } } }, { name: 'anon', as: { user: null }, trace: false }] });
  const s = normalizeScenarios(input);
  assert.deepEqual(s.map(x => [x.name, x.as ?? null, x.trace]), [['me', null, true], ['no-role', { roles: { FloodQuotes: false } }, true], ['anon', { user: null }, false]]);
});

test('a native session refuses anonymous, different-user and simulated-role scenarios before wrapper creation', () => {
  const userKey = '11111111-2222-3333-4444-555555555555';
  for (const as of [{ user: null }, { user: 'other@example.test' }, { roles: { FloodQuotes: true } }, { roles: { FloodQuotes: false } }])
    assert.throws(() => validateNativeScenarios({ scenarios: [{ inputs: {}, as }] }, { userKey }), /requires_separate_login/);
  assert.doesNotThrow(() => validateNativeScenarios({ scenarios: [{ inputs: {} }, { inputs: {}, as: { user: userKey } }] }, { userKey }));
});
import { debugSchema } from '../debug.mjs';

// Inspect shape seen live (ServerAction:ValidateQuoteInputs of FloodServices r80): parameters with DataType
// references, nodes with Target/TrueTarget/FalseTarget and ActionConnector children.
const ref = (kind, key, label = '') => ({ kind, key, label });
const tree = {
  kind: 'ServerAction', name: 'ValidateQuoteInputs', key: '0_BvP6sfKEuxdosGwFliGQ', properties: { Public: 'False' },
  children: [
    { kind: 'InputParameter', name: 'Request', key: 'sqP7Dn0M6EitdhXGSdqHbQ', properties: { DataType: 'RestStructure:PatchQuoteRequest', IsMandatory: 'False' }, propertyReferences: { DataType: ref('RestStructure', 'u+mMX9Iun0qU8s2yG8VaFA', 'PatchQuoteRequest') } },
    { kind: 'OutputParameter', name: 'Count', key: 'AAAAAAAAAAAAAAAAAAAAAA', properties: { DataType: 'BasicType:Integer' }, propertyReferences: { DataType: ref('BasicType', 'oD0fxvc7hUOX_305zIXIlg', 'Integer') } },
    { kind: 'IfNode', label: 'Any required field missing?', key: 'xXZHlIammkOy1nd6heT1mw', properties: {}, propertyReferences: { TrueTarget: ref('RaiseExceptionNode', 'LPtZbh4bCkOpxOii9wKubw'), FalseTarget: ref('EndNode', 'qr3rHl9FXUmacwtgJ3eoEQ') },
      children: [{ kind: 'ActionConnector', propertyReferences: { Target: ref('RaiseExceptionNode', 'LPtZbh4bCkOpxOii9wKubw') } }] },
    { kind: 'RaiseExceptionNode', label: 'MissingQuoteFields', key: 'LPtZbh4bCkOpxOii9wKubw', properties: {}, propertyReferences: {} },
    { kind: 'EndNode', label: 'End', key: 'qr3rHl9FXUmacwtgJ3eoEQ', properties: {}, propertyReferences: {} },
    { kind: 'StartNode', label: 'Start', key: '75vDi+ifMkyxGB5u87GdOQ', properties: {}, propertyReferences: { Target: ref('IfNode', 'xXZHlIammkOy1nd6heT1mw') } },
    { kind: 'ExecuteServerActionNode', label: 'GetQuote', key: 'BBBBBBBBBBBBBBBBBBBBBB', properties: { Name: 'GetQuote' }, propertyReferences: { Target: ref('EndNode', 'qr3rHl9FXUmacwtgJ3eoEQ') } },
  ],
};

test('the action model carries signature types, the flow graph and the start node', () => {
  const m = W.actionModel(tree);
  assert.equal(m.start, '75vDi+ifMkyxGB5u87GdOQ');
  assert.deepEqual(m.inputs.map(p => [p.name, W.jobType(p)]), [['Request', '@u+mMX9Iun0qU8s2yG8VaFA']]);
  assert.deepEqual(m.outputs.map(p => [p.name, W.jobType(p)]), [['Count', 'Integer']]);
  assert.deepEqual(m.nodes.find(n => n.kind === 'IfNode').targets.sort(), ['LPtZbh4bCkOpxOii9wKubw', 'qr3rHl9FXUmacwtgJ3eoEQ'].sort());
  assert.deepEqual(W.scopeRoots(m), ['Request', 'Count', 'GetQuote']);
});

test('a window starts at every node `before` steps upstream, or at the Start node of a shorter path', () => {
  const m = W.actionModel(tree);
  assert.deepEqual(W.traceWindow(m, { around: 'LPtZbh4bCkOpxOii9wKubw', before: 1, after: 2 }), { anchor: 'LPtZbh4bCkOpxOii9wKubw', entries: ['xXZHlIammkOy1nd6heT1mw'], steps: 4 });
  assert.deepEqual(W.traceWindow(m, { around: 'LPtZbh4bCkOpxOii9wKubw', before: 5, after: 0 }).entries, ['75vDi+ifMkyxGB5u87GdOQ']);
  assert.throws(() => W.traceWindow(m, { around: 'CCCCCCCCCCCCCCCCCCCCCC' }), /anchor_not_in_action/);
});

test('wrapper jobs are a pure function of the action: names, endpoint, token check and removal of every derived type', () => {
  const m = W.actionModel(tree), token = 'b'.repeat(48);
  const job = W.createJob({ actions: [m], token });
  assert.deepEqual(job, W.createJob({ actions: [m], token }));
  const text = JSON.stringify(job);
  for (const piece of ['"IRestService"', '"name":"SSAMDebug"', '"value":"/ValidateQuoteInputs"', '"value":"POST"', '"value":"X-SSAM-Debug-Token"',
    `SSAMDebugToken = \\"${token}\\"`, '"value":"@0_BvP6sfKEuxdosGwFliGQ"', '"value":"SSAMDebugInputs.Data.Request"', '"value":"SSAMDebugSerialize.JSON"', '"connector":"FalseTarget"'])
    assert.ok(text.includes(piece), piece);
  assert.ok(W.createJob({ lane: 'o11', actions: [m], token }).ops.some(o => o.value === 'SSAMDebugSerialize.JSONText'), 'O11 serialize output');
  assert.throws(() => W.createJob({ actions: [m], token: 'short' }), /token_invalid/);
  const removal = W.removeJob({ actions: [m] }).ops.map(o => o.target);
  assert.deepEqual(removal, ['IRestService:SSAMDebug',
    'IListType:SSAMDebug_ValidateQuoteInputs_Request Record List', 'IAnonymousStructure:SSAMDebug_ValidateQuoteInputs_Request Record', 'IStructure:SSAMDebug_ValidateQuoteInputs_Request',
    'IListType:SSAMDebug_ValidateQuoteInputs_Response Record List', 'IAnonymousStructure:SSAMDebug_ValidateQuoteInputs_Response Record', 'IStructure:SSAMDebug_ValidateQuoteInputs_Response']);
  assert.equal(W.wrapperUrl('https://wrightflood-dev.outsystems.app/FloodQuotes/', 'FloodQuotes', 'GetX'), 'https://wrightflood-dev.outsystems.app/FloodQuotes/rest/SSAMDebug/GetX');
});

test('module key and asset key are the same 16 bytes (live pairs from the Portal)', () => {
  assert.equal(assetKeyOf('a1v50MRqQEeD1eGUlx3SzQ'), 'd0f95b6b-6ac4-4740-83d5-e194971dd2cd');
  assert.equal(moduleKeyOf('d0f95b6b-6ac4-4740-83d5-e194971dd2cd'), 'a1v50MRqQEeD1eGUlx3SzQ');
  assert.equal(moduleKeyOf(assetKeyOf('5k3l5ig9HUmkOwedKzNQ9A')), '5k3l5ig9HUmkOwedKzNQ9A');
});

test('schemas: trace windows may exceed 20 breakpoints; run needs module and action', () => {
  const keys = Array.from({ length: 21 }, (_, i) => String.fromCharCode(65 + i).repeat(22));
  const base = { op: 'start', lane: 'odc', tenant: 't', module: 'M', moduleKey: 'A'.repeat(22), runtimeUrl: 'https://x.outsystems.app/M/', nodeKeys: keys };
  assert.throws(() => debugSchema.parse(base), /More than 20 breakpoints/);
  assert.equal(debugSchema.parse({ ...base, trace: { scopes: { ['A'.repeat(22)]: ['Request'] } } }).trace.mode, 'step');
  assert.throws(() => runSchema.parse({ op: 'run', tenant: 'wrightflood.outsystems.dev', module: 'FloodQuotes' }), /action is required/);
  const run = runSchema.parse({ op: 'run', tenant: 'wrightflood.outsystems.dev', module: 'FloodQuotes', action: 'X', scenarios: [{ inputs: { A: 1 } }, { name: 'b', inputs: { A: 2 }, trace: false }] });
  assert.equal(run.keep, true); assert.equal(run.idleMinutes, 30); assert.equal(run.trace, 'all'); assert.equal(run.scenarios.length, 2);
  assert.throws(() => runSchema.parse({ op: 'run', tenant: 't', module: 'M', action: 'X', inputs: { A: 1 }, scenarios: [{ inputs: { A: 2 } }] }), /either inputs/);
  // Credentials are collected in the native window, not accepted in the public request.
  for (const removed of ['via', 'trigger', 'callerNode']) assert.throws(() => runSchema.parse({ op: 'run', tenant: 't', module: 'M', action: 'X', [removed]: 'caller' }));
});

test('compact map: the first visit of each action in a call carries every value, later visits only what changed', () => {
  const v = (path, value) => ({ path, type: 'Text', value, children: [] });
  const map = compactMap([
    { seq: 1, threadId: 'T1', action: 'Validate', node: 'Start', values: [v('A', '1'), v('IsValid', 'False')] },
    { seq: 2, threadId: 'T1', action: 'Validate', node: 'If', values: [v('A', '1'), v('IsValid', 'False')] },
    { seq: 3, threadId: 'T1', action: 'Validate', node: 'Assign', values: [v('A', '1'), v('IsValid', 'True')] },
    { seq: 4, threadId: 'T2', action: 'Validate', node: 'Start', values: [v('A', '2'), v('IsValid', 'False')] },
  ]);
  assert.deepEqual(map.map(e => e.values?.length ?? null), [2, null, null, 2]);
  assert.deepEqual(map.map(e => e.changed?.map(c => c.path) ?? null), [null, [], ['IsValid'], null]);
  assert.ok(map.every(e => !('threadId' in e)));
});

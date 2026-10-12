import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyIdentityWitnesses, nativeBuiltin, nativeExpressionMap } from '../debug-identity-witness.mjs';
import { buildIdentityEvidence } from '../debug-identity-evidence.mjs';

// Synthetic published capture + native witness binding (ssam-native-witness-bindings/1 shape).
const K = p => (p + 'x'.repeat(22)).slice(0, 22);
const node = (kind, extra = {}) => ({ kind, functionCall: false, builtin: null, originalBuiltin: false, role: null, functionObject: null, operator: null,
  booleanValue: null, usedObjects: [], children: [], ...extra });
const builtin = (name, original = true) => node('FunctionCall', { functionCall: true, builtin: name, originalBuiltin: original });
const binary = (operator, a, b) => node('BinaryOperation', { operator, children: [a, b] });
const ident = (key, kind = 'InputParameter') => node('Identifier', { usedObjects: [{ key, kind }] });
const literal = value => node('BooleanLiteral', { booleanValue: value });
const userFunction = key => node('FunctionCall', { functionCall: true, functionObject: { key, kind: 'Action' }, usedObjects: [{ key, kind: 'Action' }] });
const ROLE = { roleKey: K('Role'), ownerModuleKey: K('RoleMod'), name: 'SSAMIdentityRole20261010', persistent: true, public: true, check: 'server', system: null };
const roleCall = (role = ROLE, args = [builtin('GetUserId')]) => node('FunctionCall', { functionCall: true, role, usedObjects: [{ key: K('Check'), kind: 'CheckRole' }], children: args });
const USER_TYPE = { DataType: 'IdentifierType:User Identifier' };

let seq = 0;
function fixture({ kind = 'user-present', value, captureKind = 'consumer', moduleKey, sha = 'a'.repeat(64), varProps = { DataType: 'BasicType:Boolean' },
  varKind = 'LocalVariable', extra = {} } = {}) {
  const id = ++seq, key = p => K(p + id); moduleKey ??= key('Mod');
  const n = (k, kind, children = [], properties = {}, propertyReferences = {}) => ({ key: k, kind, name: '', children, properties, propertyReferences });
  const input = n(key('In'), 'InputParameter', [], USER_TYPE), variable = n(key('Var'), varKind, [], varProps);
  const assignment = n(key('Asg'), 'Assignment', [], { Variable: 'W', Value: 'V' });
  assignment.children = [n(assignment.key + '.#Variable', 'TextBasedExpression'), n(assignment.key + '.#Value', 'TextBasedExpression')];
  const start = n(key('Start'), 'StartNode'), assign = n(key('Assign'), 'AssignNode', [assignment]), end = n(key('End'), 'EndNode');
  for (const [from, to] of [[start, assign], [assign, end]]) { from.propertyReferences.Target = { key: to.key }; from.children.push(n(key('C') + from.key.slice(0, 3), 'ActionConnector', [], {}, { Target: { key: to.key } })); }
  const fn = n(key('Fn'), 'ServerAction', [input, variable, start, assign, end]);
  value ??= { 'user-present': binary('NotEqual', builtin('GetUserId'), builtin('NullIdentifier')), 'user-equals-input': binary('Equal', builtin('GetUserId'), ident(input.key)),
    role: roleCall(), 'user-id': builtin('GetUserId'), 'caller-user-id': builtin('GetUserId') }[kind];
  const binding = { schema: 'ssam-native-witness-bindings/1', available: true, authority: 'installed-model-expression-tree', contract: 'o11-v1-expression-elements',
    runtimeValuesEvaluated: false, identity: { moduleKey, functionKey: fn.key, sourceSha256: sha },
    expressions: [{ key: assignment.key + '.#Variable', root: ident(variable.key, varKind) }, { key: assignment.key + '.#Value', root: value }] };
  const declared = { id: 'w' + id, moduleKey, functionKey: fn.key, nodeKey: assign.key, variable: variable.key, kind, sourceSha256: sha,
    ...(kind === 'role' ? { role: ROLE.name, roleKey: ROLE.roleKey, roleModuleKey: ROLE.ownerModuleKey } : {}), ...extra };
  return { capture: { moduleKey, sourceSha256: sha, kind: captureKind, trees: [{ schema: 'ssam-reading/1', tree: fn }] }, binding, declared, fn, input, variable, assign, end, assignment, start };
}
const typed = kind => ['user-id', 'caller-user-id'].includes(kind) ? { varProps: USER_TYPE } : {};
const run = (fs, reader) => qualifyIdentityWitnesses(fs.map(f => f.declared), fs.map(f => f.capture), reader ?? fs.map(f => f.binding));
const refusal = (f, reader) => { const r = run([f], reader); assert.equal(r.qualified.length, 0, JSON.stringify(r)); return r.refused[0].reason; };

test('declared witnesses qualify only on a matching native binding, across consumer, service-app and library captures', () => {
  const kinds = ['user-present', 'user-equals-input', 'role', 'user-id', 'caller-user-id'], captures = ['consumer', 'service-app', 'library'];
  const fs = kinds.flatMap((kind, i) => [fixture({ kind, captureKind: captures[i % 3], ...typed(kind) })]);
  const r = run(fs, ({ moduleKey, functionKey, sourceSha256 }) => fs.find(f => f.binding.identity.functionKey === functionKey && f.binding.identity.moduleKey === moduleKey &&
    f.binding.identity.sourceSha256 === sourceSha256).binding);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.qualified.map(w => w.kind), ['user-present', 'user-equals-caller', 'role', 'user-id', 'caller-user-id']);
  for (const [i, w] of r.qualified.entries()) {
    assert.equal(w.qualified, true); assert.equal(w.assignmentNodeKey, fs[i].assign.key); assert.deepEqual(w.afterNodeKeys, [fs[i].end.key]);
    assert.equal(w.sourceSha256, 'a'.repeat(64)); assert.equal(w.variableKey, fs[i].variable.key); assert.equal(w.captureKind, captures[i % 3]);
    assert.equal(w.provenance.valueExpressionKey, fs[i].assignment.key + '.#Value'); assert.equal(w.provenance.runtimeValuesEvaluated, false);
  }
  assert.equal(r.qualified[1].inputKey, fs[1].input.key);
  assert.equal(r.qualified[2].role, ROLE.name); assert.equal(r.qualified[2].roleBinding.roleKey, ROLE.roleKey); assert.equal(r.qualified[2].roleBinding.persistent, true);
  assert.ok(Object.isFrozen(r.qualified[0]));
  // ODC: NullTextIdentifier and a client-side role check of the app role are native too
  const odc = fixture({ value: binary('NotEqual', builtin('NullTextIdentifier'), builtin('GetUserId')) });
  assert.equal(run([odc]).qualified.length, 1);
  assert.equal(run([fixture({ kind: 'role', value: roleCall({ ...ROLE, check: 'client', persistent: null }, []) })]).qualified.length, 1);
});

test('literal, foreign function, substituted builtin and role of another module are refused', () => {
  assert.equal(refusal(fixture({ value: literal(true) })), 'witness-value-literal');
  assert.equal(refusal(fixture({ kind: 'role', value: literal(true) })), 'witness-value-literal');
  assert.equal(refusal(fixture({ kind: 'role', value: userFunction(K('CheckFake')) })), 'witness-value-foreign-function');
  assert.equal(refusal(fixture({ kind: 'user-id', value: userFunction(K('GetUserId')), varProps: USER_TYPE })), 'witness-value-foreign-function');
  assert.equal(refusal(fixture({ kind: 'user-id', value: builtin('GetUserId', false), varProps: USER_TYPE })), 'witness-value-substituted-builtin');
  assert.equal(refusal(fixture({ value: binary('NotEqual', builtin('GetUserId', false), builtin('NullIdentifier')) })), 'witness-value-substituted-builtin');
  assert.equal(refusal(fixture({ value: binary('NotEqual', builtin('GetUserId'), builtin('CurrDate')) })), 'witness-value-foreign-function');
  assert.equal(refusal(fixture({ kind: 'role', value: roleCall({ ...ROLE, ownerModuleKey: K('Other') }) })), 'witness-role-foreign-module');
  assert.equal(refusal(fixture({ kind: 'role', value: roleCall({ ...ROLE, roleKey: K('Other') }) })), 'witness-role-key-mismatch');
  assert.equal(refusal(fixture({ kind: 'role', value: roleCall({ ...ROLE, name: 'Admin' }) })), 'witness-role-name-mismatch');
  assert.equal(refusal(fixture({ kind: 'role', extra: { roleKey: undefined } })), 'witness-role-unpinned');
  assert.equal(refusal(fixture({ kind: 'role', value: roleCall(ROLE, [ident(K('Someone'))]) })), 'witness-role-other-user');
});

test('shape, source pin, binding authority, flow and variable are all native and complete', () => {
  assert.equal(refusal(fixture({ value: binary('NotEqual', builtin('GetUserId'), builtin('GetUserId')) })), 'witness-value-shape-mismatch');
  assert.equal(refusal(fixture({ value: binary('Equal', builtin('GetUserId'), builtin('NullIdentifier')) })), 'witness-value-shape-mismatch');
  assert.equal(refusal(fixture({ kind: 'user-equals-input', value: binary('Equal', builtin('GetUserId'), ident(K('Local'), 'LocalVariable')) })), 'witness-value-shape-mismatch');
  const sha = fixture(); sha.binding.identity.sourceSha256 = 'b'.repeat(64); assert.equal(refusal(sha), 'witness-source-mismatch');
  const pin = fixture({ extra: { sourceSha256: undefined } }); assert.equal(refusal(pin), 'witness-source-unpinned');
  const other = fixture(); other.declared.sourceSha256 = 'c'.repeat(64); assert.equal(refusal(other), 'witness-source-mismatch');
  for (const change of [b => { b.runtimeValuesEvaluated = true; }, b => { b.available = false; }, b => { b.authority = 'regex'; }, b => { b.expressions.push(b.expressions[0]); }]) {
    const f = fixture(); change(f.binding); assert.equal(refusal(f), 'witness-binding-unqualified');
  }
  const missing = fixture(); missing.binding.expressions.pop(); assert.equal(refusal(missing), 'witness-binding-incomplete');
  assert.equal(refusal(fixture(), () => { throw new Error('no reader'); }), 'witness-binding-unavailable');
  const again = fixture(), copy = structuredClone(again.assign); copy.key = K('Again'); copy.children[0].key = K('Asg2');
  copy.children[0].children = [{ key: K('Asg2') + '.#Variable', kind: 'TextBasedExpression', children: [] }, { key: K('Asg2') + '.#Value', kind: 'TextBasedExpression', children: [] }];
  copy.children = [copy.children[0]]; delete copy.propertyReferences.Target; again.fn.children.push(copy);
  again.binding.expressions.push({ key: K('Asg2') + '.#Variable', root: ident(again.variable.key, 'LocalVariable') }, { key: K('Asg2') + '.#Value', root: literal(true) });
  assert.equal(refusal(again), 'witness-variable-reassigned');
  assert.equal(refusal(fixture({ varKind: 'InputParameter' })), 'witness-variable-invalid');
  assert.equal(refusal(fixture({ varProps: { DataType: 'BasicType:Integer' } })), 'witness-variable-type');
  assert.equal(refusal(fixture({ kind: 'user-id' })), 'witness-variable-type');
  const disabled = fixture(); disabled.assign.properties.IsDisabled = 'True'; assert.equal(refusal(disabled), 'witness-node-invalid');
  const orphan = fixture(); orphan.start.propertyReferences = {}; orphan.start.children = []; assert.equal(refusal(orphan), 'witness-node-unreachable');
  const last = fixture(); last.assign.propertyReferences = {}; last.assign.children = [last.assignment]; assert.equal(refusal(last), 'witness-no-node-after-assignment');
  assert.equal(refusal(fixture({ kind: 'run-marker' })), 'witness-kind-unsupported');
  assert.equal(refusal(fixture({ captureKind: 'browser' })), 'witness-capture-invalid');
  const a = fixture(), b = fixture(); b.declared.id = a.declared.id;
  const dup = run([a, b]); assert.equal(dup.qualified.length, 0); assert.deepEqual(dup.refused.map(r => r.reason), ['witness-duplicate-id', 'witness-duplicate-id']);
  // refusals carry reason codes, never expressions or identity values
  assert.deepEqual(Object.keys(run([fixture({ value: literal(true) })]).refused[0]).sort(), ['id', 'kind', 'reason']);
});

test('qualified witnesses are the declarations the deterministic evidence builder accepts', () => {
  const f = fixture({ captureKind: 'service-app' }), [w] = run([f]).qualified;
  const evidence = buildIdentityEvidence({ boundary: { kind: 'service-action', actionKey: f.fn.key, producerModuleKey: f.capture.moduleKey, callerModuleKey: K('Caller') },
    witnesses: [w], witnessReads: [] });
  assert.ok(!evidence.reasons.appUserIdentityProved.includes('user-present-witness-undeclared'));
  assert.ok(evidence.reasons.appUserIdentityProved.includes('user-present-witness-not-true'));
});

test('native primitives: builtin recognition and pinned expression maps', () => {
  assert.equal(nativeBuiltin(builtin('GetUserId')), 'GetUserId');
  for (const root of [builtin('GetUserId', false), userFunction(K('X')), roleCall(), literal(true), { ...builtin('GetUserId'), children: [literal(true)] }, builtin('NullIdentifier')])
    assert.equal(nativeBuiltin(root), null);
  assert.equal(nativeBuiltin(builtin('NullTextIdentifier'), ['GetUserId', 'NullTextIdentifier']), 'NullTextIdentifier');
  // pre-witness bindings (NativeExpressionBindings) carry no role/functionObject fields and still count
  assert.equal(nativeBuiltin({ kind: 'FunctionCall', functionCall: true, builtin: 'GetUserId', originalBuiltin: true, usedObjects: [], children: [] }), 'GetUserId');
  const f = fixture(), identity = f.binding.identity;
  assert.equal(nativeExpressionMap(f.binding, identity).size, 2);
  assert.equal(nativeExpressionMap(f.binding, { ...identity, sourceSha256: 'b'.repeat(64) }), null);
  assert.equal(nativeExpressionMap({ ...f.binding, runtimeValuesEvaluated: true }, identity), null);
});

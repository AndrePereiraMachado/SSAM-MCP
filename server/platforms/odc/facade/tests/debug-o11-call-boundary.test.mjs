import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveO11TraceRuntime } from '../debug-o11-call-boundary.mjs';
const key = c => c.repeat(22);
function fixture(kinds) {
  const nodes = kinds.map(([kind, moduleKey], i) => ({ id: String(i), key: key(String(i)), kind, moduleKey, module: 'RepeatedName' }));
  const captures = [...new Set(nodes.map(n => n.moduleKey))].map((moduleKey, i) => ({ target: { module: 'RepeatedName', moduleKey }, versionId: i + 1 }));
  const graph = { nodes: new Map(nodes.map(n => [n.id, n])), edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })) };
  return { graph, resolution: { path: nodes.map(({ id }) => ({ id })) }, captures };
}
test('linked server actions retain the consumer runtime; exact keys distinguish repeated module names', () => {
  const f = fixture([['DataAction', key('a')], ['ServerAction', key('b')]]);
  const result = resolveO11TraceRuntime(f.graph, f.resolution, f.captures);
  assert.equal(result.runtimeCapture.target.moduleKey, key('a'));
  assert.equal(result.ownerCapture.target.moduleKey, key('b'));
  assert.equal(result.contract.boundaries[0].kind, 'linked-action');
  for (const flag of ['appUserIdentityProved', 'rolesProved', 'propagationProved']) assert.equal(result.contract[flag], false);
});
test('service hops switch runtime and a following linked library keeps the latest service runtime', () => {
  const f = fixture([['DataAction', key('a')], ['ServiceAction', key('b')], ['ServerAction', key('c')], ['ServiceAction', key('d')], ['ServerAction', key('e')]]);
  const result = resolveO11TraceRuntime(f.graph, f.resolution, f.captures);
  assert.equal(result.runtimeCapture.target.moduleKey, key('d')); assert.equal(result.ownerCapture.target.moduleKey, key('e'));
  assert.deepEqual(result.contract.boundaries.map(b => [b.kind, b.runtimeModuleKey]), [
    ['service-action', key('b')], ['linked-action', key('b')], ['service-action', key('d')], ['linked-action', key('d')] ]);
  assert.ok(result.contract.boundaries.every(b => b.producerFramesObserved === false && b.valuesObserved === false && b.propagationProved === false));
});
test('unobserved edges and missing/duplicated capture identities cannot select a debugger host', () => {
  const f = fixture([['DataAction', key('a')], ['ServiceAction', key('b')]]);
  assert.throws(() => resolveO11TraceRuntime({ ...f.graph, edges: [] }, f.resolution, f.captures), /trace_path_unresolved/);
  assert.throws(() => resolveO11TraceRuntime(f.graph, f.resolution, f.captures.slice(0, 1)), /trace_module_binding_ambiguous/);
  assert.throws(() => resolveO11TraceRuntime(f.graph, f.resolution, [...f.captures, f.captures[1]]), /trace_module_binding_ambiguous/);
});
test('defaults stay false without evidence; service-action boundary exposes callerModuleKey and an empty identityEvidence slot', () => {
  const f = fixture([['DataAction', key('a')], ['ServiceAction', key('b')]]);
  const result = resolveO11TraceRuntime(f.graph, f.resolution, f.captures), boundary = result.contract.boundaries[0];
  assert.equal(boundary.kind, 'service-action'); assert.equal(boundary.callerModuleKey, key('a')); assert.equal(boundary.producerModuleKey, key('b'));
  assert.ok(Object.hasOwn(boundary, 'identityEvidence')); assert.equal(boundary.identityEvidence, null);
  for (const flag of ['appUserIdentityProved', 'rolesProved', 'propagationProved']) { assert.equal(boundary[flag], false); assert.equal(result.contract[flag], false); }
});

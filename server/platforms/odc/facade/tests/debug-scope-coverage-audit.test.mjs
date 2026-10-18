import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWidgetKind, expectedScopeNode, coverageProjection, compareCoverage, auditScopeCoverage, syntheticScopeProof, parseTranscript,
  bindExpectedCoverage } from '../debug-scope-coverage-audit.mjs';

const M = 'M'.repeat(22), F = 'F'.repeat(22), N = 'N'.repeat(22), sha = 'a'.repeat(64);
const variable = (name, category, modelKind, key) => ({ moduleKey: M, variableKey: key, name, category, source: 'native-node-scope',
  nativePath: name, modelKind });
// Mirrors the installed reader output (NativeDebugScope.Read, schema ssam-native-debug-scope/1).
const scopeData = (runtime, nodeKey = N, functionKey = F) => ({ schema: 'ssam-native-debug-scope/1', sourceSha256: sha, moduleKey: M, nodeKey, functionKey,
  previousNodeKey: null, runtime, functionDebuggerHash: 'H'.repeat(22), authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true,
  automaticExpressionsEnumerated: true, automaticExpressionsError: null, previousExpressionsEnumerated: true, previousExpressionsError: null,
  runtimeValuesEvaluated: false, scopeComplete: false, pending: ['runtime-frame-binding', 'function-return'],
  variables: [variable('Count', 'local', 'ServiceStudio.Model.Variables+LocalVariable', 'A'.repeat(22)),
    variable('SeedInput', 'local', 'ServiceStudio.Plugin.NRWidgets.Input', 'B'.repeat(22)),
    variable('Badge', 'local', 'ServiceStudio.Model.NRWebWidgets+WebBlockInstance', 'C'.repeat(22)),
    variable('Client.Counter', runtime === 'client' ? 'client' : 'site', 'ServiceStudio.Model.Variables+ClientVariable', 'D'.repeat(22))] });
const node = (runtime, id = 'n1', nodeKey = N) => expectedScopeNode(scopeData(runtime, nodeKey), { id, functionName: 'ScreenOnReady', functionKind: 'IScreenAction',
  ownerName: 'PauseProbe', nodeLabel: 'RestoreClientVariables' });
const expected = (...nodes) => ({ schema: 'ssam-debug-scope-expected-coverage/1', lane: 'odc', nodes });

test('widget kinds come from the native NRWidgets/NRWebWidgets model classes only', () => {
  assert.equal(isWidgetKind('ServiceStudio.Plugin.NRWidgets.Input'), true);
  assert.equal(isWidgetKind('ServiceStudio.Model.NRWebWidgets+WebBlockInstance'), true);
  assert.equal(isWidgetKind('ServiceStudio.Model.Variables+LocalVariable'), false);
  assert.equal(isWidgetKind(undefined), false);
});

test('expected node projects counts and roots from the installed reader, independent of keys', () => {
  const n = node('client');
  assert.deepEqual(n.variableCounts, { input: 0, output: 0, local: 3, client: 1, session: 0, site: 0, setting: 0, timer: 0 });
  assert.deepEqual(n.roots.map(r => [r.name, r.category, r.widget]), [['Badge', 'local', true], ['Client.Counter', 'client', false],
    ['Count', 'local', false], ['SeedInput', 'local', true]]);
  assert.equal(n.functionKey, F); assert.equal(n.nodeKey, N); assert.equal(n.sourceSha256, sha);
  const rekeyed = node('client', 'n1', 'K'.repeat(22));
  assert.deepEqual(coverageProjection(rekeyed), coverageProjection(n));
  assert.equal(compareCoverage([n], [rekeyed]).identical, true);
  const fewer = expectedScopeNode({ ...scopeData('client'), variables: scopeData('client').variables.slice(1) }, { id: 'n1' });
  const diff = compareCoverage([n], [fewer]);
  assert.equal(diff.identical, false); assert.deepEqual(diff.differences.map(d => d.id), ['n1']);
  // The reader output must be the installed model enumeration; anything else is refused.
  assert.throws(() => expectedScopeNode({ ...scopeData('client'), runtimeValuesEvaluated: true }, { id: 'x' }), /model_incomplete/);
});

for (const runtime of ['client', 'server']) {
  test(`${runtime}: a synthetic proof that reads and expands every root passes`, () => {
    const plan = expected(node(runtime, 'n1'), node(runtime, 'n2', 'P'.repeat(22)));
    const proof = syntheticScopeProof(plan, { runtime });
    const verdict = auditScopeCoverage({ expected: plan, ...proof, runtime, lane: 'odc' });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
    assert.deepEqual(verdict.visitedNodes, ['n1', 'n2']); assert.deepEqual(verdict.missingNodes, []);
    assert.equal(verdict.stops.every(s => s.completeness.runtimeValuesComplete === true && s.widgetRoots.unexpanded.length === 0), true);
    assert.equal(verdict.valuesReturned, false);
  });

  test(`${runtime}: an unexpanded widget root fails the dry run`, () => {
    const plan = expected(node(runtime));
    const verdict = auditScopeCoverage({ expected: plan, ...syntheticScopeProof(plan, { runtime, unexpandWidget: 'SeedInput' }), runtime, lane: 'odc' });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.stops[0].widgetRoots.unexpanded, ['SeedInput']);
    assert.ok(verdict.failures.some(f => f.code === 'widget-root-unexpanded' && f.root === 'SeedInput'));
  });

  test(`${runtime}: a category count that differs from expected-coverage fails the dry run`, () => {
    const plan = expected(node(runtime));
    const verdict = auditScopeCoverage({ expected: plan, ...syntheticScopeProof(plan, { runtime, dropRoot: 'Count' }), runtime, lane: 'odc' });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.stops[0].countDifferences, [{ category: 'local', expected: 3, observed: 2 }]);
    assert.ok(verdict.failures.some(f => f.code === 'category-count-mismatch'));
  });
}

test('a planned node never reached, an unplanned stop and a failed surface run are failures', () => {
  const plan = expected(node('server', 'n1'), node('server', 'n2', 'P'.repeat(22)));
  const proof = syntheticScopeProof(expected(plan.nodes[0]), { runtime: 'server' });
  // The start request plans both nodes; only n1 is visited.
  const start = proof.transcript.find(r => r.kind === 'request' && r.request.op === 'start');
  start.request.scopes = [{ functionKey: F, nodeKeys: [N, 'P'.repeat(22)] }];
  const missing = auditScopeCoverage({ expected: plan, ...proof, runtime: 'server', lane: 'odc' });
  assert.deepEqual(missing.missingNodes, ['n2']); assert.ok(missing.failures.some(f => f.code === 'planned-node-not-visited'));
  const unplanned = auditScopeCoverage({ expected: expected(plan.nodes[1]), ...syntheticScopeProof(expected(plan.nodes[0]), { runtime: 'server' }),
    runtime: 'server', lane: 'odc' });
  assert.ok(unplanned.failures.some(f => f.code === 'node-unplanned'));
  const failed = auditScopeCoverage({ expected: expected(plan.nodes[0]), transcript: proof.transcript, audit: { surfaceCriteriaPassed: false },
    runtime: 'server', lane: 'odc' });
  assert.ok(failed.failures.some(f => f.code === 'surface-criteria-failed'));
});

test('private leaves must be matched by a private-read at the same stop', () => {
  const plan = expected(node('server'));
  const proof = syntheticScopeProof(plan, { runtime: 'server', redact: 'Count' });
  const unmatched = auditScopeCoverage({ expected: plan, ...proof, runtime: 'server', lane: 'odc' });
  assert.ok(unmatched.failures.some(f => f.code === 'private-read-unmatched'));
  const matched = auditScopeCoverage({ expected: plan, ...syntheticScopeProof(plan, { runtime: 'server', redact: 'Count', privateRead: true }),
    runtime: 'server', lane: 'odc' });
  assert.equal(matched.failures.some(f => f.code === 'private-read-unmatched'), false);
});

test('transcript text is parsed as JSON lines; responses pair with their request by seq', () => {
  const plan = expected(node('client'));
  const proof = syntheticScopeProof(plan, { runtime: 'client' });
  const text = proof.transcript.map(r => JSON.stringify(r)).join('\n') + '\n';
  assert.deepEqual(parseTranscript(text), proof.transcript);
  assert.throws(() => parseTranscript('{"seq":1,"kind":"response"\n'), /transcript_invalid/);
  assert.equal(auditScopeCoverage({ expected: plan, transcript: text, audit: proof.audit, runtime: 'client', lane: 'odc' }).ok, true);
});

test('a read-scope batch answer (reads[]) counts as the same native reads', () => {
  const plan = expected(node('server'));
  const proof = syntheticScopeProof(plan, { runtime: 'server' });
  // Fold every single read of the stop into one read-scope response.
  const rows = [], batch = [];
  for (let i = 0; i < proof.transcript.length; i += 2) {
    const [request, response] = [proof.transcript[i], proof.transcript[i + 1]];
    if (request.request.op === 'read') batch.push(response.result); else rows.push(request, response);
  }
  const at = rows.findIndex(r => r.kind === 'request' && r.request.op === 'continue');
  rows.splice(at, 0, { seq: 999, kind: 'request', channel: 'debug', request: { op: 'read-scope', sessionId: 'synthetic', threadId: 'T1', eventId: '1', generation: 2 } },
    { seq: 999, kind: 'response', result: { ok: true, reads: batch } });
  assert.equal(auditScopeCoverage({ expected: plan, transcript: rows, audit: proof.audit, runtime: 'server', lane: 'odc' }).ok, true);
});

test('bindExpectedCoverage rebinds nodes to a new capture by function and node names, keeping the projection', () => {
  const plan = expected(node('client', 'n1'));
  const bound = bindExpectedCoverage(plan, [{ id: 'n1', moduleKey: M, functionKey: 'G'.repeat(22), nodeKey: 'Q'.repeat(22), sourceSha256: 'b'.repeat(64) }]);
  assert.equal(bound.nodes[0].nodeKey, 'Q'.repeat(22)); assert.equal(bound.nodes[0].sourceSha256, 'b'.repeat(64));
  assert.deepEqual(coverageProjection(bound.nodes[0]), coverageProjection(plan.nodes[0]));
  assert.throws(() => bindExpectedCoverage(plan, []), /binding_missing/);
});

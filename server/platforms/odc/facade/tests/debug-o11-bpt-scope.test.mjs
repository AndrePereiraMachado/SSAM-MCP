import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activityFlowNodeKeys, buildO11BptScopePlan, o11BptValuesCoverage, readO11BptActivityScopes } from '../debug-o11-bpt-scope.mjs';
import { graphFromReadings, buildO11CallGraph, resolveO11Entry } from '../debug-o11-entry-graph.mjs';

// Built from the native process capture (read-only); process inputs/outputs, a preceding
// activity, a human activity and launch arguments are added as synthetic model elements.
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-bpt-native-reading.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
const module = { module: 'Headless_CS', moduleKey: 'Kawk_WFx5USxo7qFAB0lCQ' };
const NOTIFY = '4g5q+CpcFUqZEKg0sBKQDw', NOTIFY_START = 'tYnx5xiHeES0yb1JK_l9SQ', NOTIFY_END = 'd_pP+MGb0UiDR3p64BI+dA', START = 'M6PjIflXhUWQjwGGxM_I5w';
const SHA = createHash('sha256').update('bpt-scope-model').digest('hex');
const k = (prefix, i = 0) => (prefix + i).padEnd(22, 'x');
const ref = e => ({ kind: e.kind, name: e.name, key: e.key, path: e.path });
const coll = list => ({ items: list.map(ref), total: list.length, omitted: 0 });
const element = (kind, key, name, extra = {}) => ({ kind, name, key, path: kind + ':' + name, properties: { Name: name, DataType: 'Text' },
  propertyReferences: { DataType: { kind: 'BasicType', key: k('TXT'), name: 'Text' } }, propertyReferenceCollections: {},
  propertiesOmitted: {}, propertyErrors: {}, propertiesMissing: [], children: [], childrenTotal: 0, childrenOmitted: 0, ...extra });
const adopt = (parent, collection, list) => {
  parent.children.push(...list); parent.childrenTotal = parent.children.length;
  if (collection) parent.propertyReferenceCollections[collection] = coll([...(parent.propertyReferenceCollections[collection]?.items ?? []), ...list]);
};
const PI = ['BookingId', 'Note', 'Priority'].map((name, i) => ({ name, key: k('PI', i) }));
const PREPARE = k('PA'), REVIEW = k('HA');
// Both flow nodes of Notify (its native 'Nodes' collection): node outputs after later nodes are read too.
const ACT = [{ key: NOTIFY, nodeKeys: [NOTIFY_START, NOTIFY_END] }];

function processModel({ locals = 1, prepareTargets = true } = {}) {
  const p = structuredClone(captured.tree), sig = p.children.find(c => c.kind === 'ActionSignature');
  adopt(p, 'InputParameters', PI.map(i => element('InputParameter', i.key, i.name)));
  adopt(p, 'OutputParameters', [element('OutputParameter', k('PO'), 'Result')]);
  // Launch signature inputs carry the generated key <launchKey>.<process input key>.
  adopt(sig, 'InputParameters', PI.map(i => element('InputParameter', sig.key + '.' + i.key, i.name)));
  const notify = p.children.find(c => c.key === NOTIFY);
  adopt(notify, 'LocalVariables', Array.from({ length: locals }, (_, i) => element('LocalVariable', k('NL', i), i ? 'Local' + i : 'Counter')));
  adopt(notify, 'OutputParameters', [element('ActivityOutputParameter', k('NO'), 'Sent')]);
  // Start -> Prepare -> Notify -> End; Review (human) is disconnected.
  const connector = (key, source, target) => element('ActionConnector', key, '', { propertyReferences: { Source: ref(source), Target: ref(target) } });
  const prepare = element('AutomaticActivityNode', PREPARE, 'Prepare'), review = element('HumanActivityNode', REVIEW, 'Review');
  adopt(prepare, 'Connectors', [connector(k('PC'), prepare, notify)]);
  adopt(prepare, 'Nodes', [element('StartNode', k('PS'), '')]);
  if (prepareTargets) prepare.propertyReferenceCollections.Targets = coll([notify]);
  adopt(prepare, 'OutputParameters', [element('ActivityOutputParameter', k('PAO'), 'Ticket')]);
  for (const name of ['Connectors', 'Targets']) review.propertyReferenceCollections[name] = coll([]);
  adopt(review, 'OutputParameters', [element('ActivityOutputParameter', k('HAO'), 'Approved')]);
  const start = p.children.find(c => c.key === START);
  start.propertyReferenceCollections.Targets = coll([prepare]);
  start.children.find(c => c.kind === 'ActionConnector').propertyReferences.Target = ref(prepare);
  adopt(p, 'Nodes', [prepare, review]);
  return p;
}
const consumer = (p, argumentKey = (sig, i) => sig.key + '.' + i.key) => {
  const sig = p.children.find(c => c.kind === 'ActionSignature');
  const values = { BookingId: 'Id', Note: '"hello"', Priority: 'Id + 1' };
  return { kind: 'RestServiceAction', key: k('RS'), name: 'Submit', path: 'RestServiceAction:Submit', properties: {}, children: [
    element('InputParameter', k('RI'), 'Id'),
    { kind: 'ExecuteServerActionNode', key: k('EX'), name: 'Launch', propertyReferences: { Action: p.propertyReferences.LaunchProcessAction },
      children: PI.map((i, n) => ({ kind: 'Argument', key: k('AR', n), properties: { Value: values[i.name] },
        propertyReferences: { Parameter: { kind: 'InputParameter', name: i.name, key: argumentKey(sig, i) } } })) }] };
};
// Model-only native expression binding: the Priority argument is natively the original GetUserId() builtin.
const identityBinding = { available: true, authority: 'installed-model-expression-tree', runtimeValuesEvaluated: false,
  identity: { moduleKey: module.moduleKey, functionKey: k('RS'), sourceSha256: SHA },
  expressions: [{ key: k('AR', 2) + '.#Value', root: { kind: 'FunctionCall', functionCall: true, originalBuiltin: true, builtin: 'GetUserId', children: [] } }] };
function world(options) {
  const p = processModel(options), c = consumer(p, options?.argumentKey);
  const graph = buildO11CallGraph([graphFromReadings([p, c], { ...module, sourceSha256: SHA, ...(options?.identity ? { nativeBindings: [identityBinding] } : {}) })]);
  const resolution = resolveO11Entry(graph, 'Notify');
  assert.equal(resolution.state, 'background-trigger-resolved');
  return { p, graph, launchCall: resolution.originalLaunch };
}

// Native scope variables of a Notify node, as the installed model would enumerate them.
const variable = (variableKey, name, category, nativePath = name) => ({ moduleKey: module.moduleKey, variableKey, name, category, nativePath });
function notifyVariables(locals = 1) {
  return [...Array.from({ length: locals }, (_, i) => variable(k('NL', i), i ? 'Local' + i : 'Counter', 'local')),
    variable(k('NO'), 'Sent', 'output'), ...PI.map(i => variable(i.key, i.name, 'input')), variable(k('PO'), 'Result', 'output'),
    variable(k('PAO'), 'Ticket', 'output', 'Prepare.Ticket'), variable(k('HAO'), 'Approved', 'output', 'Review.Approved'),
    variable(k('SP'), 'Flag', 'site', 'Site.Flag')];
}
async function nativeScopes(t, scopes = { [NOTIFY]: notifyVariables() }, activities = ACT, processNode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-bpt-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'source.oml'), sha256: createHash('sha256').update('bpt-scope').digest('hex') };
  fs.writeFileSync(source.path, 'bpt-scope');
  const calls = [];
  const services = { build: async () => ({ dll: 'fixture.dll', studioDir: root }), exec: async (_, argv) => {
    const functionKey = argv[argv.indexOf('--function-key') + 1], nodeKey = argv[argv.indexOf('--node-key') + 1];
    calls.push([functionKey, nodeKey]);
    return { stdout: JSON.stringify({ ok: true, data: { schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
      modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: 'server', moduleKey: module.moduleKey, functionKey, nodeKey,
      sourceSha256: source.sha256, variables: scopes[functionKey] ?? [] } }) };
  } };
  const read = await readO11BptActivityScopes({ source, moduleKey: module.moduleKey, activityNodes: activities, processNode, directory: path.join(root, 'scope') }, services);
  return { read, calls };
}
// Server reads bound to one native stop.
const ctx = { runtime: 'server', threadId: 'T', eventId: '5', generation: 1 };
const value = (reference, over = {}) => ({ reference, type: 'Scalar', value: '1', textOffset: 0, textLength: 1, nextTextOffset: null, valueComplete: true,
  redacted: false, unavailable: false, undefined: false, trimmed: false, deferred: false, nativeSummary: false, hasChildren: false, ...over });
const serverRead = (reference, over) => ({ ok: true, context: ctx, reference, value: value(reference, over), children: [], offset: 0, nextOffset: null, availableChildren: 0 });
const stopFor = (roots, overrides = {}) => [{ scopeVariables: roots.map((r, i) => ({ reference: 'r' + i, name: r.path, category: r.nativeCategory })),
  reads: roots.map((r, i) => serverRead('r' + i, overrides[r.path])) }];

test('activity output, process input/output and preceding/human outputs become native roots classified by owner key', async t => {
  const { p, graph, launchCall } = world(), { read, calls } = await nativeScopes(t);
  assert.deepEqual(calls, [[NOTIFY, NOTIFY_START], [NOTIFY, NOTIFY_END]], 'one native server scope read per planned activity node');
  const plan = buildO11BptScopePlan({ graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall, reads: {} });
  const by = Object.fromEntries(plan.roots.map(r => [r.path, r]));
  assert.deepEqual(Object.fromEntries(plan.roots.map(r => [r.path, [r.category, r.ownerKey]])), {
    Counter: ['activityLocal', NOTIFY], Sent: ['activityOutput', NOTIFY], BookingId: ['processInput', p.key], Note: ['processInput', p.key],
    Priority: ['processInput', p.key], Result: ['processOutput', p.key], 'Prepare.Ticket': ['precedingActivityOutput', PREPARE],
    'Review.Approved': ['humanArgument', REVIEW], 'Site.Flag': ['moduleContext', module.moduleKey] });
  assert.equal(by['Prepare.Ticket'].precedes, true); assert.equal(by.Sent.nodeKey, NOTIFY_START); assert.equal(by.Sent.functionKey, NOTIFY);
  assert.deepEqual(by.Sent.nodeKeys, [NOTIFY_START, NOTIFY_END]); assert.deepEqual(plan.unreadNodeScopes, []);
  assert.equal(plan.authority, 'installed-model-scope-and-watchability'); assert.equal(plan.coverageSource, 'rootCoverage');
  assert.equal(plan.omitted, 0); assert.equal(plan.valuesComplete, false, 'no native reads: not complete');
  assert.ok(plan.roots.every(r => r.coverage.state !== 'complete'));
  // Every root completely read natively: completeness is computed, not hard false.
  const done = buildO11BptScopePlan({ graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall, reads: { [NOTIFY]: stopFor(plan.roots) } });
  assert.equal(done.valuesComplete, true); assert.ok(done.roots.every(r => r.coverage.state === 'complete'));
});

test('roots never come from model names: a model local the native scope does not show is not a root', async t => {
  // The model declares Counter and Local1; the native scope enumerates only Counter.
  const { p, graph, launchCall } = world({ locals: 2 }), { read } = await nativeScopes(t, { [NOTIFY]: notifyVariables(1) });
  assert.ok(p.children.find(c => c.key === NOTIFY).children.some(c => c.name === 'Local1'), 'the model has Local1');
  const plan = buildO11BptScopePlan({ graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall, reads: {} });
  assert.ok(plan.roots.some(r => r.path === 'Counter'));
  assert.ok(!plan.roots.some(r => r.path === 'Local1' || r.variableKey === k('NL', 1)));
});

test('activity flow nodes come from the native Nodes collection; unread node scopes keep valuesComplete false', async t => {
  const { p, graph, launchCall } = world();
  assert.deepEqual(activityFlowNodeKeys(p, NOTIFY), [NOTIFY_START, NOTIFY_END], 'start node first, then the rest of the activity flow');
  // An activity without nodeKeys is expanded to its whole flow when the process node is given.
  const { calls } = await nativeScopes(t, undefined, [{ key: NOTIFY, startNodeKey: NOTIFY_START }], p);
  assert.deepEqual(calls, [[NOTIFY, NOTIFY_START], [NOTIFY, NOTIFY_END]]);
  // Only the start node read: the End node scope stays unread, even with every root completely read.
  const startOnly = [{ key: NOTIFY, nodeKeys: [NOTIFY_START] }], { read } = await nativeScopes(t, undefined, startOnly);
  const roots = buildO11BptScopePlan({ graph, processNode: p, activityNodes: startOnly, nativeScopes: read, launchCall }).roots;
  const plan = buildO11BptScopePlan({ graph, processNode: p, activityNodes: startOnly, nativeScopes: read, launchCall, reads: { [NOTIFY]: stopFor(roots) } });
  assert.ok(plan.roots.every(r => r.coverage.state === 'complete'));
  assert.deepEqual(plan.unreadNodeScopes, [{ functionKey: NOTIFY, nodeKey: NOTIFY_END }]); assert.equal(plan.valuesComplete, false);
  // A node key outside the activity flow is refused.
  assert.throws(() => buildO11BptScopePlan({ graph, processNode: p, activityNodes: [{ key: NOTIFY, nodeKeys: [START] }], nativeScopes: null, launchCall }), /node_not_in_activity/);
});

test('more than 60 native roots are all kept, the trace budget records omitted and valuesComplete stays false', async t => {
  const { p, graph, launchCall } = world({ locals: 70 }), { read } = await nativeScopes(t, { [NOTIFY]: notifyVariables(70) });
  const plan = buildO11BptScopePlan({ graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall, reads: {} });
  assert.equal(plan.roots.length, 78); assert.equal(plan.traceScopes[NOTIFY].length, 60); assert.equal(plan.omitted, 18);
  assert.equal(plan.roots.filter(r => r.traced).length, 60);
  const allRead = buildO11BptScopePlan({ graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall, reads: { [NOTIFY]: stopFor(plan.roots) } });
  assert.ok(allRead.roots.every(r => r.coverage.state === 'complete'));
  assert.equal(allRead.valuesComplete, false, 'omitted trace roots keep the flag false');
  assert.equal(allRead.activities[0].omitted, 18);
});

test('redacted and native-unavailable roots are listed and never counted complete', async t => {
  const { p, graph, launchCall } = world(), { read } = await nativeScopes(t);
  const base = { graph, processNode: p, activityNodes: ACT, launchCall };
  const roots = buildO11BptScopePlan({ ...base, nativeScopes: read, reads: {} }).roots;
  const plan = buildO11BptScopePlan({ ...base, nativeScopes: read,
    reads: { [NOTIFY]: stopFor(roots, { Counter: { redacted: true }, Note: { valueComplete: false, unavailable: true } }) } });
  assert.deepEqual(plan.redacted.map(r => [r.path, r.category]), [['Counter', 'activityLocal']]);
  assert.deepEqual(plan.unavailable.map(r => [r.path, r.category]), [['Note', 'processInput']]);
  assert.equal(plan.roots.find(r => r.path === 'Counter').coverage.state, 'redacted');
  assert.equal(plan.roots.find(r => r.path === 'Note').coverage.state, 'native-unavailable');
  assert.equal(plan.valuesComplete, false);
  // A planned activity without a native scope is missing, never complete.
  const missing = buildO11BptScopePlan({ ...base, activityNodes: [...ACT, { key: PREPARE, nodeKeys: [k('PS')] }], nativeScopes: read, reads: { [NOTIFY]: stopFor(roots) } });
  assert.deepEqual(missing.missingScopes, [{ functionKey: PREPARE, nodeKey: k('PS') }]); assert.equal(missing.valuesComplete, false);
  assert.equal(buildO11BptScopePlan({ ...base, nativeScopes: null, reads: {} }).valuesComplete, false);
  // Foreign authority, unplanned functions and count disagreement are refused.
  assert.throws(() => buildO11BptScopePlan({ ...base, nativeScopes: { ...read, coverage: read.coverage.map(c => ({ ...c, authority: 'names' })) }, reads: {} }), /scope_authority_invalid/);
  assert.throws(() => buildO11BptScopePlan({ ...base, nativeScopes: { ...read, variables: read.variables.map(v => ({ ...v, functionKey: PREPARE })) }, reads: {} }), /scope_unplanned/);
  assert.throws(() => buildO11BptScopePlan({ ...base, nativeScopes: { ...read, variables: read.variables.slice(1) }, reads: {} }), /scope_counts_mismatch/);
  assert.throws(() => buildO11BptScopePlan({ ...base, activityNodes: [{ key: REVIEW, nodeKeys: [k('RV')] }], nativeScopes: read, reads: {} }), /activity_not_in_process/);
});

test('forged completeness flags are ignored: each case would be complete only by computation', async t => {
  const { p, graph, launchCall } = world(), { read } = await nativeScopes(t);
  const forgedScopes = { ...read, valuesComplete: true, coverage: read.coverage.map(c => ({ ...c, scopeComplete: true, valuesComplete: true })) };
  const base = { graph, processNode: p, activityNodes: ACT, launchCall, valuesComplete: true, omitted: 0 };
  const roots = buildO11BptScopePlan({ ...base, nativeScopes: read }).roots;
  // Forged flags and no reads at all.
  assert.equal(buildO11BptScopePlan({ ...base, nativeScopes: forgedScopes, reads: {} }).valuesComplete, false);
  // Forged flags on a stop that carries no reads, and on reads with no stop binding.
  assert.equal(buildO11BptScopePlan({ ...base, nativeScopes: forgedScopes, reads: { [NOTIFY]: [{ valuesComplete: true, scopeVariables: [], reads: [] }] } }).valuesComplete, false);
  assert.equal(buildO11BptScopePlan({ ...base, nativeScopes: forgedScopes, reads: { [NOTIFY]: [{ ...stopFor(roots)[0], reads: [], valuesComplete: true }] } }).valuesComplete, false);
  // Forged flags with every root completely read but trace roots omitted.
  const big = world({ locals: 70 }), { read: bigRead } = await nativeScopes(t, { [NOTIFY]: notifyVariables(70) });
  const bigRoots = buildO11BptScopePlan({ graph: big.graph, processNode: big.p, activityNodes: ACT, nativeScopes: bigRead, launchCall: big.launchCall }).roots;
  assert.equal(buildO11BptScopePlan({ ...base, graph: big.graph, processNode: big.p, launchCall: big.launchCall, traceBudget: 60,
    nativeScopes: { ...bigRead, valuesComplete: true }, reads: { [NOTIFY]: stopFor(bigRoots) } }).valuesComplete, false);
  // The same forged input with complete reads and nothing omitted: true, and only because rootCoverage computed it.
  const computed = buildO11BptScopePlan({ ...base, nativeScopes: forgedScopes, reads: { [NOTIFY]: stopFor(roots) } });
  assert.equal(computed.valuesComplete, true); assert.ok(computed.activities.every(a => a.stopsObserved === 1 && a.invalidStops === 0));
});

test('launch bindings map launcher input to process input by key: pass-through, literal, derived and identity', async t => {
  const { p, graph, launchCall } = world(), { read } = await nativeScopes(t);
  const base = { graph, processNode: p, activityNodes: ACT, nativeScopes: read, reads: {} };
  const plan = buildO11BptScopePlan({ ...base, launchCall });
  assert.deepEqual(plan.launchBindings.map(b => [b.processInput, b.launcherInput, b.processInputKey, b.mode, b.controllable]), [
    ['BookingId', 'Id', PI[0].key, 'pass-through', true], ['Note', null, PI[1].key, 'literal', false], ['Priority', null, PI[2].key, 'derived', false]]);
  assert.equal(plan.launchBindings[1].expression, '"hello"'); assert.equal(plan.launchBindings[2].expression, 'Id + 1');
  assert.ok(plan.launchBindings.every(b => b.keyMatch === 'launch-signature-key'));
  // Native GetUserId provenance keeps its class and provenance in the binding view; never controllable.
  const identity = world({ identity: true });
  const priority = buildO11BptScopePlan({ ...base, graph: identity.graph, processNode: identity.p, launchCall: identity.launchCall }).launchBindings[2];
  assert.deepEqual([priority.mode, priority.bindClass, priority.provenance, priority.controllable], ['derived', 'identity', 'native-builtin:GetUserId', false]);
  // The Argument may name the IProcess input directly.
  const direct = world({ argumentKey: (_, i) => i.key });
  assert.ok(buildO11BptScopePlan({ ...base, graph: direct.graph, processNode: direct.p, launchCall: direct.launchCall }).launchBindings
    .every(b => b.keyMatch === 'process-input'));
  // A parameter key that maps to no IProcess input is listed, never controllable.
  const foreign = world({ argumentKey: () => k('ZZ') });
  const unmapped = buildO11BptScopePlan({ ...base, graph: foreign.graph, processNode: foreign.p, launchCall: foreign.launchCall }).launchBindings;
  assert.ok(unmapped.every(b => b.processInputKey === null && b.controllable === false));
  // A launch call that does not end at this process's LaunchProcessAction is refused.
  assert.throws(() => buildO11BptScopePlan({ ...base, launchCall: { ...launchCall, path: launchCall.path.slice(0, 1), hops: [] } }), /launch_call_unproved/);
  assert.deepEqual(buildO11BptScopePlan({ ...base, launchCall: null }).launchBindings, []);
});

test('a process node without a Targets collection is refused, so precedes is never silently false', async t => {
  // The graph resolves through Prepare; the process node given to the plan lacks Prepare's Targets.
  const { graph, launchCall } = world(), p = processModel({ prepareTargets: false }), { read } = await nativeScopes(t);
  assert.throws(() => buildO11BptScopePlan({ graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall }), /native_targets_incomplete/);
  // The disconnected human activity has an empty Targets collection: its output is not a predecessor.
  const ok = buildO11BptScopePlan({ graph, processNode: processModel(), activityNodes: ACT, nativeScopes: read, launchCall });
  assert.equal(ok.roots.find(r => r.path === 'Prepare.Ticket').precedes, true);
});

test('values coverage degrades instead of throwing and is computed only from interactive native reads', async t => {
  const { p, graph, launchCall } = world(), { read } = await nativeScopes(t);
  const base = { graph, processNode: p, activityNodes: ACT, nativeScopes: read, launchCall };
  const roots = buildO11BptScopePlan(base).roots;
  // Automatic trace: rows only label which roots appeared; valuesComplete stays false.
  const traceRows = [{ functionKey: NOTIFY, values: [{ path: 'Counter', children: [], trimmed: false, deferred: false, childrenOmitted: 0 },
    { path: 'Note', children: [], trimmed: true, deferred: false, childrenOmitted: 0 }] }, { functionKey: k('OT'), values: [{ path: 'Sent', children: [] }] }];
  let evidenceCalls = 0;
  const automatic = await o11BptValuesCoverage({ ...base, interactive: false, traceRows, scopeEvidence: async () => { evidenceCalls++; return stopFor(roots); } });
  assert.equal(evidenceCalls, 0, 'automatic runs never treat session stops as native reads');
  assert.equal(automatic.valuesComplete, false); assert.equal(automatic.reason, 'bounded_trace_without_native_completeness');
  assert.deepEqual(Object.fromEntries(automatic.roots.filter(r => r.automaticTrace !== 'not-observed').map(r => [r.name, r.automaticTrace])),
    { Counter: 'observed', Note: 'observed-bounded' });
  assert.ok(automatic.roots.every(r => r.state !== 'complete')); assert.equal(automatic.valuesReturned, false);
  // Interactive native reads: computed true.
  const interactive = await o11BptValuesCoverage({ ...base, interactive: true, scopeEvidence: async () => stopFor(roots) });
  assert.equal(interactive.valuesComplete, true); assert.equal(interactive.coverageSource, 'rootCoverage'); assert.equal(interactive.reason, undefined);
  // Interactive without evidence, failing evidence and a refused plan: false, never a throw.
  assert.equal((await o11BptValuesCoverage({ ...base, interactive: true })).reason, 'bounded_trace_without_native_completeness');
  const failed = await o11BptValuesCoverage({ ...base, interactive: true, scopeEvidence: async () => { throw new Error('gone'); } });
  assert.deepEqual([failed.valuesComplete, failed.reason], [false, 'native_scope_reads_unavailable']);
  const refused = await o11BptValuesCoverage({ ...base, interactive: true, scopeEvidence: async () => stopFor(roots),
    nativeScopes: { ...read, coverage: read.coverage.map(c => ({ ...c, authority: 'names' })) } });
  assert.deepEqual([refused.valuesComplete, refused.reason, refused.error], [false, 'native_scope_plan_refused', 'debug_o11_bpt_scope_scope_authority_invalid']);
  const unproved = await o11BptValuesCoverage({ ...base, interactive: true, scopeEvidence: async () => stopFor(roots),
    launchCall: { ...launchCall, path: launchCall.path.slice(0, 1), hops: [] } });
  assert.deepEqual([unproved.valuesComplete, unproved.error], [false, 'debug_o11_bpt_scope_launch_call_unproved']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { o11RunSchema } from '../debug-o11-run.mjs';
import { debugRunToolSchema } from '../debug-run.mjs';
import { parseO11ActionSelector, isO11EntrySelector } from '../debug-o11-selectors.mjs';
import { findTarget, resolveO11Entry } from '../debug-o11-entry-graph.mjs';

const key = c => c.repeat(22);
const target = { lane: 'o11', host: 'dev.example.test', module: 'Probe', moduleKey: key('a'), applicationKey: key('b'),
  runtimeUrl: 'https://dev.example.test/Probe/', op: 'prepare', execution: 'native-entry' };

test('original process launch separates launcher inputs/context and refuses ambiguous target scenarios', () => {
  const input = { ...target, action: 'Target', contextMode: 'native-background', launch: {} };
  assert.deepEqual(o11RunSchema.parse(input).launch, { inputs: {}, contextMode: 'app-user' });
  assert.equal(debugRunToolSchema.safeParse(input).success, true);
  assert.deepEqual(o11RunSchema.parse({ ...input, launch: { contextMode: 'anonymous', inputs: { Count: 1 } } }).launch,
    { inputs: { Count: 1 }, contextMode: 'anonymous' });
  for (const patch of [{ execution: 'rest-wrapper' }, { contextMode: 'app-user' }, { contextMode: undefined },
    { inputs: { Count: 1 } }, { scenarios: [{ inputs: {} }] }, { launch: { contextMode: 'native-background' } }])
    assert.equal(o11RunSchema.safeParse({ ...input, ...patch }).success, false);
  assert.equal(o11RunSchema.safeParse({ ...input, op: 'run' }).success, false);
  assert.equal(o11RunSchema.safeParse({ ...input, op: 'run', words: 'Autorizar o processo DEV' }).success, true);
});
test('schema accepts only the two observed native action suffixes, bare or qualified and with or without @', () => {
  for (const suffix of ['.#Preparation', '.#LaunchProcess']) for (const at of ['', '@']) for (const module of ['', 'Probe.']) {
    const selector = module + at + key('c') + suffix;
    const parsed = o11RunSchema.parse({ ...target, action: selector, entry: selector });
    assert.equal(parsed.action, selector); assert.equal(parsed.entry, selector);
    assert.equal(parseO11ActionSelector(selector).key, key('c') + suffix);
  }
  for (const suffix of ['.#EndNode', '.#GetEntity', '.#Preparation.extra', '.#LaunchProcess.#Anything', '.#preparation', '.#']) {
    const selector = '@' + key('c') + suffix;
    assert.equal(parseO11ActionSelector(selector), null); assert.equal(isO11EntrySelector(selector), false);
    assert.equal(o11RunSchema.safeParse({ ...target, action: selector }).success, false);
    assert.equal(o11RunSchema.safeParse({ ...target, action: 'Existing', entry: selector }).success, false);
  }
  assert.equal(o11RunSchema.safeParse({ ...target, action: 'Existing', entry: 'screenservices/Probe/Common/Login/ActionLogin' }).success, true);
});

test('target lookup resolves native preparation/launch keys and qualified ordinary keys, without name guessing', () => {
  const nodes = ['Preparation', 'ProcessLaunchAction', 'ServerAction'].map((kind, i) => ({ id: 'id-' + i, module: 'Probe', kind,
    name: 'Action' + i, key: key(String.fromCharCode(99 + i)) + (i === 0 ? '.#Preparation' : i === 1 ? '.#LaunchProcess' : '') }));
  const graph = { nodes: new Map(nodes.map(n => [n.id, n])) };
  for (const node of nodes) for (const at of ['', '@']) for (const module of ['', 'Probe.'])
    assert.deepEqual(findTarget(graph, module + at + node.key), [node]);
  assert.deepEqual(findTarget(graph, 'Other.@' + nodes[0].key), []);
  assert.deepEqual(findTarget(graph, '@' + key('c') + '.#EndNode'), []);
});

test('entry overrides use the same scoped native key interpretation and still require a caller edge', () => {
  const entry = { id: 'entry', module: 'Probe', key: key('c') + '.#Preparation', name: 'Preparation', kind: 'Preparation', entry: 'client-action', sortKey: 'entry', inputs: [] };
  const targetNode = { id: 'target', module: 'Probe', key: key('d'), name: 'Target', kind: 'ServerAction', sortKey: 'target', inputs: [] };
  const edge = { from: entry.id, to: targetNode.id, via: { kind: 'execute' }, language: 'os', arguments: [] };
  const graph = { nodes: new Map([[entry.id, entry], [targetNode.id, targetNode]]), edges: [edge],
    callers: new Map([[targetNode.id, [edge]]]), callees: new Map([[entry.id, [edge]]]), graphSha256: 'synthetic' };
  for (const override of [entry.key, '@' + entry.key, 'Probe.' + entry.key, 'Probe.@' + entry.key])
    assert.equal(resolveO11Entry(graph, '@' + targetNode.key, { entry: override }).state, 'resolved');
  assert.equal(resolveO11Entry(graph, 'Target', { entry: 'Other.@' + entry.key }).state, 'override-refused');
});

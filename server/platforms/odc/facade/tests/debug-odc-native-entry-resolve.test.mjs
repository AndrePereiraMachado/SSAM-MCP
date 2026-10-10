import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntry, resolveOverride, compareEntries, entryKindOf, ENTRY_KIND_ORDER } from '../debug-odc-native-entry-resolve.mjs';

// A tiny in-memory graph builder shaped like the model adapter's output.
// elements: { key: { kind, name, public, ownerKind, roles, anonymous, authentication, inputs:[{name,key,dataType}] } }
// edges: [{ caller, callee, path, kind, arguments:[{parameter|parameterName, value}] }]
function makeGraph(elements, edges) {
  return {
    node: key => elements[key] ? { key, ...elements[key] } : null,
    inputs: key => elements[key]?.inputs ?? [],
    callers: callee => edges.filter(e => e.callee === callee).map(e => ({ key: e.caller, node: { key: e.caller, ...elements[e.caller] },
      edge: { path: e.path, kind: e.kind, arguments: e.arguments } })),
  };
}

test('entryKindOf admits externally invocable elements only', () => {
  assert.equal(entryKindOf({ kind: 'MobileScreen' }), 'screen');
  assert.equal(entryKindOf({ kind: 'DataAction', ownerKind: 'MobileBlock' }), 'block-data-action');
  assert.equal(entryKindOf({ kind: 'DataAction', ownerKind: 'MobileScreen' }), 'screen-data-action');
  assert.equal(entryKindOf({ kind: 'RestServiceAction' }), 'rest-method');
  assert.equal(entryKindOf({ kind: 'ServerAction', public: true }), 'public-server-action');
  assert.equal(entryKindOf({ kind: 'ServerAction', public: false }), null);
  assert.equal(entryKindOf({ kind: 'ClientAction', public: false }), null);
});

test('nearest public entry wins by distance', () => {
  const elements = {
    T: { kind: 'ServerAction', public: false, name: 'Target', inputs: [{ name: 'A', key: 'ia' }] },
    H: { kind: 'ServerAction', public: false, name: 'Helper', inputs: [{ name: 'A', key: 'ha' }] },
    S: { kind: 'MobileScreen', name: 'Screen' },
    P: { kind: 'ServerAction', public: true, name: 'PublicDirect', inputs: [{ name: 'A', key: 'pa' }] },
  };
  // P -> T directly (distance 1); S -> H -> T (distance 2).
  const edges = [
    { caller: 'P', callee: 'T', path: 'ServerAction:PublicDirect/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode', arguments: [{ parameterName: 'A', value: 'A' }] },
    { caller: 'H', callee: 'T', path: 'ServerAction:Helper/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode', arguments: [{ parameterName: 'A', value: 'A' }] },
    { caller: 'S', callee: 'H', path: 'MobileFlow:F/MobileScreen:Screen/DataAction:Load/ExecuteServerActionNode:H', kind: 'ExecuteServerActionNode', arguments: [{ parameterName: 'A', value: 'A' }] },
  ];
  const r = resolveEntry(makeGraph(elements, edges), 'T');
  assert.equal(r.ok, true);
  assert.equal(r.entry.key, 'P');
  assert.equal(r.entry.distance, 1);
  assert.deepEqual(r.path.map(s => s.key), ['P', 'T']);
  assert.equal(r.bindings[0].control, 'direct');
  assert.equal(r.bindings[0].entryInput, 'A');
});

test('ties at equal distance break by kind rank then key, deterministically', () => {
  // Two entries both at distance 1: a screen-data-action (key "Zzz") and a public server action (key "Aaa").
  const elements = {
    T: { kind: 'ServerAction', public: false, name: 'Target', inputs: [] },
    Aaa: { kind: 'ServerAction', public: true, name: 'PubA', inputs: [] },
    Zzz: { kind: 'DataAction', ownerKind: 'MobileScreen', name: 'DataZ', inputs: [] },
  };
  const edges = [
    { caller: 'Aaa', callee: 'T', path: 'ServerAction:PubA/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode' },
    { caller: 'Zzz', callee: 'T', path: 'MobileFlow:F/MobileScreen:X/DataAction:DataZ/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode' },
  ];
  const r = resolveEntry(makeGraph(elements, edges), 'T');
  // screen-data-action outranks public-server-action in ENTRY_KIND_ORDER, so Zzz wins despite the later key.
  assert.equal(r.entry.key, 'Zzz');
  assert.ok(ENTRY_KIND_ORDER.indexOf('screen-data-action') < ENTRY_KIND_ORDER.indexOf('public-server-action'));
  // Same inputs reversed -> same result (determinism).
  const r2 = resolveEntry(makeGraph(elements, [...edges].reverse()), 'T');
  assert.equal(r2.entry.key, 'Zzz');
});

test('same kind ties break by model key ascending', () => {
  const elements = {
    T: { kind: 'ServerAction', public: false, inputs: [] },
    Bkey: { kind: 'ServerAction', public: true, inputs: [] },
    Akey: { kind: 'ServerAction', public: true, inputs: [] },
  };
  const edges = [
    { caller: 'Bkey', callee: 'T', path: 'ServerAction:B/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode' },
    { caller: 'Akey', callee: 'T', path: 'ServerAction:A/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode' },
  ];
  assert.equal(resolveEntry(makeGraph(elements, edges), 'T').entry.key, 'Akey');
  assert.equal(resolveEntry(makeGraph(elements, [...edges].reverse()), 'T').entry.key, 'Akey');
});

test('dead code: a private action no public entry reaches is refused, not run', () => {
  const elements = {
    T: { kind: 'ServerAction', public: false, name: 'Orphan', inputs: [] },
    H: { kind: 'ServerAction', public: false, name: 'AlsoPrivate', inputs: [] },
  };
  const edges = [{ caller: 'H', callee: 'T', path: 'ServerAction:AlsoPrivate/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode' }];
  const r = resolveEntry(makeGraph(elements, edges), 'T');
  assert.equal(r.ok, false);
  assert.equal(r.deadCode, true);
  assert.equal(r.error, 'dead_code_no_public_entry');
});

test('binding classes: direct, fixed, derived, default, opaque', () => {
  const elements = {
    T: { kind: 'ServerAction', public: false, inputs: [{ name: 'A', dataType: 'Text' }, { name: 'B', dataType: 'Text' }, { name: 'C', dataType: 'Text' }, { name: 'D', dataType: 'Text' }] },
    P: { kind: 'ServerAction', public: true, inputs: [{ name: 'A', dataType: 'Text' }] },
  };
  const edges = [{ caller: 'P', callee: 'T', path: 'ServerAction:P/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode',
    arguments: [{ parameterName: 'A', value: 'A' }, { parameterName: 'B', value: '"fixed"' }, { parameterName: 'C', value: 'ToUpper(A)' }] }];
  const r = resolveEntry(makeGraph(elements, edges), 'T');
  const byInput = Object.fromEntries(r.bindings.map(b => [b.targetInput, b.control]));
  assert.equal(byInput.A, 'direct');
  assert.equal(byInput.B, 'fixed');
  assert.equal(byInput.C, 'derived');
  assert.equal(byInput.D, 'default'); // not passed by the caller
});

test('override: accepted only when a verified caller, otherwise refused', () => {
  const elements = {
    T: { kind: 'ServerAction', public: false, inputs: [] },
    P: { kind: 'ServerAction', public: true, name: 'Near', inputs: [] },
    S: { kind: 'MobileScreen', name: 'FarScreen' },
    X: { kind: 'MobileScreen', name: 'Unrelated' },
  };
  const edges = [
    { caller: 'P', callee: 'T', path: 'ServerAction:Near/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode' },
    { caller: 'S', callee: 'P', path: 'MobileFlow:F/MobileScreen:FarScreen/ClientAction:c/ExecuteServerActionNode:P', kind: 'ExecuteServerActionNode' },
  ];
  const graph = makeGraph(elements, edges);
  const ok = resolveOverride(graph, 'T', 'S'); // S reaches T through P at distance 2
  assert.equal(ok.ok, true);
  assert.equal(ok.overridden, true);
  assert.equal(ok.entry.key, 'S');
  assert.equal(ok.deterministicEntry.key, 'P'); // the algorithm still reports the nearest
  const no = resolveOverride(graph, 'T', 'X'); // X never calls anything on the path
  assert.equal(no.ok, false);
  assert.equal(no.error, 'entry_override_not_a_caller');
});

// The user's rule (2026-10-04): the CODE decides the entry, never the model. Same graph + same target => same entry,
// distance, call path and bindings, whatever order the reader lists callers in; a diamond (two equal-length routes)
// resolves to one fixed route.
test('determinism: every caller ordering of a diamond graph gives the same entry, path and bindings', () => {
  const elements = {
    T: { kind: 'ServerAction', public: false, name: 'Target', inputs: [{ name: 'A', dataType: 'Text' }, { name: 'B', dataType: 'Integer' }] },
    M1: { kind: 'ServerAction', public: false, name: 'Mid1', inputs: [{ name: 'A', dataType: 'Text' }] },
    M2: { kind: 'ServerAction', public: false, name: 'Mid2', inputs: [{ name: 'X', dataType: 'Text' }] },
    S: { kind: 'MobileScreen', name: 'Home' },
    R: { kind: 'RestServiceAction', name: 'Api', inputs: [{ name: 'A', dataType: 'Text' }] },
  };
  const edges = [
    { caller: 'M1', callee: 'T', path: 'ServerAction:Mid1/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode', arguments: [{ parameterName: 'A', value: 'A' }, { parameterName: 'B', value: '3' }] },
    { caller: 'M2', callee: 'T', path: 'ServerAction:Mid2/ExecuteServerActionNode:T', kind: 'ExecuteServerActionNode', arguments: [{ parameterName: 'A', value: 'X' }] },
    { caller: 'S', callee: 'M2', path: 'MobileScreen:Home/ExecuteServerActionNode:M2', kind: 'ExecuteServerActionNode' },
    { caller: 'S', callee: 'M1', path: 'MobileScreen:Home/ExecuteServerActionNode:M1', kind: 'ExecuteServerActionNode' },
    { caller: 'R', callee: 'M1', path: 'RestServiceAction:Api/ExecuteServerActionNode:M1', kind: 'ExecuteServerActionNode', arguments: [{ parameterName: 'A', value: 'A' }] },
  ];
  const permutations = list => list.length <= 1 ? [list] : list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(p => [x, ...p]));
  const answers = new Set();
  for (const order of permutations(edges)) {
    const r = resolveEntry(makeGraph(elements, order), 'T');
    answers.add(JSON.stringify({ entry: r.entry, path: r.path, callPath: r.callPath, bindings: r.bindings, alternatives: r.alternatives }));
  }
  assert.equal(answers.size, 1, '120 caller orderings, one answer');
  const r = resolveEntry(makeGraph(elements, edges), 'T');
  assert.equal(r.entry.key, 'S'); // screen outranks rest-method at distance 2
  assert.equal(r.entry.distance, 2);
  assert.equal(r.callPath, 'Home -> Mid1 -> Target'); // M1 < M2 by key: the fixed route through the diamond
  assert.match(r.algorithm, /^bfs-callers\/v1/);
  // the override is verified on the same graph and still reports the deterministic entry
  const o = resolveOverride(makeGraph(elements, [...edges].reverse()), 'T', 'R');
  assert.equal(o.ok, true); assert.equal(o.entry.key, 'R'); assert.equal(o.deterministicEntry.key, 'S');
  assert.equal(o.bindings.find(b => b.targetInput === 'A').control, 'direct');
  assert.equal(o.bindings.find(b => b.targetInput === 'B').control, 'fixed');
  // dead code answers in the user's words
  const dead = resolveEntry(makeGraph({ T: elements.T, M2: elements.M2 }, [edges[1]]), 'T');
  assert.equal(dead.deadCode, true); assert.equal(dead.message, 'dead code: no public entry reaches Target');
});

test('compareEntries is a strict deterministic order', () => {
  const a = { distance: 1, entryKind: 'screen', key: 'AAA' };
  const b = { distance: 1, entryKind: 'screen', key: 'BBB' };
  const c = { distance: 2, entryKind: 'screen', key: 'AAA' };
  assert.ok(compareEntries(a, b) < 0);
  assert.ok(compareEntries(b, a) > 0);
  assert.ok(compareEntries(a, c) < 0);
  assert.equal(compareEntries(a, { ...a }), 0);
});

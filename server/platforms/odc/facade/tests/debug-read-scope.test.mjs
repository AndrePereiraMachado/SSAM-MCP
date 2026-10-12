import test from 'node:test';
import assert from 'node:assert/strict';
import { readClientScope, readServerScope, serializeReadScope, readScopeDescription, READ_SCOPE_MAX_NODES } from '../debug-read-scope.mjs';

// Client fake mirrors debug-native-client-inspection-core: read-many/children/slice
// responses carry the flat context (stop, generation); children get fresh refs.
const M = 'M'.repeat(22), sha = 'a'.repeat(64);
function clientFake({ stop = 3, generation = 1, rows = 260, staleAfter = Infinity, alwaysDeferred = false, delay = 0 } = {}) {
  const list = n => ({ type: 'RecordList', items: Array.from({ length: n }, (_, i) =>
    ({ type: 'Record', fields: { Id: { type: 'Integer', value: i }, Name: { type: 'Text', value: 'n' + i } } })) });
  const tree = {
    Rows: list(rows),
    // Inner/Deep are deferred inline at detail 1; their own reads resolve them.
    Rec: { type: 'Record', fields: { Count: { type: 'Integer', value: 2 },
      Inner: { type: 'Record', fields: { Flag: { type: 'Boolean', value: true }, Deep: { type: 'Record', fields: { X: { type: 'Integer', value: 7 } } } } } } },
    $return: { type: 'Text', value: 'x'.repeat(20000), omitted: true },
    ...(alwaysDeferred ? { Lazy: { type: 'Record', alwaysDeferred: true, fields: { A: { type: 'Integer', value: 1 } } } } : {}),
  };
  const ctx = () => ({ sessionId: 's'.repeat(32), platform: 'o11', runtime: 'client', stop, generation, callContextId: 5, frame: 0 });
  const refs = new Map(), calls = []; let seq = 0, commands = 0;
  const makeRef = (path, name, category = 'local') => { const ref = (++seq).toString(16).padStart(48, '0'); refs.set(ref, { path, category });
    return { ref, name, category, nativePath: path, moduleKey: M, sourceSha256: sha, ...ctx() }; };
  const nodeAt = path => {
    const root = /^[^.[]+/.exec(path)[0]; let node = tree[root];
    for (const [, field, index] of path.slice(root.length).matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
      if (node.type === 'RecordList') node = field === 'Length' ? { type: 'Integer', value: node.items.length } : node.items[Number(index)];
      else node = node.fields[field];
      if (!node) throw new Error('fake_path_' + path);
    }
    return node;
  };
  const wire = (node, detail) => {
    if (node.type === 'Record') return { type: 'Record', value: detail <= 0 || node.alwaysDeferred ? null
      : Object.fromEntries(Object.entries(node.fields).map(([k, v]) => [k, wire(v, detail - 1)])) };
    if (node.type === 'RecordList') return { type: 'RecordList', value: detail <= 0 ? null : { Length: { type: 'Integer', value: node.items.length },
      ...Object.fromEntries(node.items.map((v, i) => ['[' + i + ']', wire(v, detail - 1)])) } };
    return { type: node.type, value: node.value };
  };
  const evaluate = (ref, detail) => {
    const { path, category } = refs.get(ref), node = nodeAt(path);
    if (node.omitted) return { ...ctx(), ref, omitted: true, reason: 'transport_budget', expandable: true, nativeValueProjection: true,
      continuation: { op: 'slice', ref, offset: 0 }, evaluation: 1 };
    const value = wire(node, detail), nested = ['Record', 'RecordList'].includes(value.type);
    const expandable = nested && !(category === 'return' && value.value === null);
    return { ...ctx(), ref, evaluation: 1, changed: null, value, deferred: nested && value.value === null, expandable, redacted: false,
      valueComplete: !nested, ...(expandable ? { continuation: { op: 'expand', ref }, nativePathAccess: true } : {}) };
  };
  const handle = {
    current: () => commands < staleAfter,
    async scope() {
      commands++; calls.push({ op: 'scope' });
      const variables = Object.keys(tree).map(name => makeRef(name === '$return' ? '$return' : name, name, name === '$return' ? 'return' : 'local'));
      return { ok: true, ...ctx(), variables, metadataBound: true, context: { moduleKey: M, functionKey: 'F'.repeat(22), nodeKey: 'N'.repeat(22), previousNodeKey: null },
        metadataCoverage: { sourceSha256: sha, authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true, runtimeFrameBound: true,
          variableCounts: { input: 0, output: 0, local: variables.filter(v => v.category === 'local').length, client: 0 }, runtimeValuesComplete: false } };
    },
    async inspection(command) {
      commands++; calls.push(command);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (command.op === 'read-many') {
        assert.ok(command.refs.length >= 1 && command.refs.length <= 500, 'read-many batch of at most 500');
        return { ...ctx(), values: command.refs.map(ref => evaluate(ref, command.detail ?? 1)), evaluationFailures: 0 };
      }
      if (command.op === 'children') {
        assert.ok(command.limit >= 1 && command.limit <= 150, 'children limit is 150');
        const { path } = refs.get(command.ref), w = wire(nodeAt(path), 1);
        if (w.value === null) throw new Error('debug_native_client_return_children_unavailable');
        const keys = Object.keys(w.value), end = Math.min(keys.length, command.offset + command.limit);
        const children = keys.slice(command.offset, end).map(k => ({ ...makeRef(path + (/^\[\d+\]$/.test(k) ? k : '.' + k), k), name: k }));
        return { ...ctx(), ref: command.ref, offset: command.offset, total: keys.length, nextOffset: end < keys.length ? end : null, children,
          redacted: false, evaluation: 2, valueSha256: 'c'.repeat(64), nativeValueProjection: true, scopeComplete: false, nativePathAccess: true,
          continuation: end < keys.length ? { op: 'children', ref: command.ref, offset: end, limit: command.limit } : null };
      }
      if (command.op === 'slice') {
        const text = nodeAt(refs.get(command.ref).path).value, end = Math.min(text.length, command.offset + command.limit);
        return { ...ctx(), ref: command.ref, value: { type: 'Text', value: text.slice(command.offset, end) }, offset: command.offset, total: text.length,
          nextOffset: end < text.length ? end : null, unit: 'utf16-code-unit', redacted: false,
          valueComplete: command.offset === 0 && end === text.length, evaluation: 3, valueSha256: 'd'.repeat(64), nativeValueProjection: true };
      }
      throw new Error('debug_native_client_operation_invalid');
    },
  };
  return { handle, calls, stop, generation };
}

test('client read-scope pages nested Record/RecordList >150 children, deferred children and multi-page text to completeness', async () => {
  const f = clientFake();
  const r = await readClientScope(f.handle, { lane: 'o11', stop: 3, generation: 1, textLimit: 8192 });
  assert.equal(r.ok, true); assert.equal(r.op, 'read-scope'); assert.equal(r.runtime, 'client');
  assert.equal(r.scopeCompleteness.ok, true);
  assert.deepEqual(r.scopeCompleteness.incompleteLeaves, []);
  assert.equal(r.runtimeValuesComplete, true); assert.equal(r.complete, true); assert.equal(r.budget.exhausted, false);
  assert.equal(r.metadataCoverage.runtimeValuesComplete, true, 'bound to the same stop, generation and counts');
  // RecordList Rows: Length + 260 items paged at 150.
  const rowsRef = r.scope.variables.find(v => v.name === 'Rows').ref;
  assert.deepEqual(f.calls.filter(c => c.op === 'children' && c.ref === rowsRef).map(c => [c.offset, c.limit]), [[0, 150], [150, 150]]);
  // Every text page of the omitted native return was requested.
  const retRef = r.scope.variables.find(v => v.category === 'return').ref;
  assert.deepEqual(f.calls.filter(c => c.op === 'slice' && c.ref === retRef).map(c => [c.offset, c.limit]), [[0, 8192], [8192, 8192], [16384, 8192]]);
  // Item fields (520) exceed one batch: read-many is split at 500.
  assert.ok(f.calls.some(c => c.op === 'read-many' && c.refs.length === 500));
  // The deferred inline child was read through its own reference.
  const deepReads = r.reads.flatMap(x => x.values ?? []).filter(v => v.value?.type === 'Record' && v.value.value?.X);
  assert.equal(deepReads.length, 1); assert.equal(deepReads[0].deferred, false);
  // Values are the native responses only.
  assert.ok(r.reads.every(x => x.stop === 3 && x.generation === 1));
});

test('client read-scope keeps a natively deferred value as deferred and never pages it', async () => {
  const f = clientFake({ rows: 2, alwaysDeferred: true });
  const r = await readClientScope(f.handle, { lane: 'odc', stop: 3, generation: 1 });
  const lazy = r.scope.variables.find(v => v.name === 'Lazy').ref;
  assert.equal(f.calls.some(c => c.op === 'children' && c.ref === lazy), false);
  assert.deepEqual(r.scopeCompleteness.incompleteLeaves.map(l => [l.reference, l.reason]), [[lazy, 'deferred']]);
  assert.equal(r.complete, false); assert.equal(r.runtimeValuesComplete, false);
});

test('client stale stop mid-traversal refuses without a partial complete result', async () => {
  const f = clientFake({ staleAfter: 4 });
  await assert.rejects(readClientScope(f.handle, { lane: 'o11', stop: 3, generation: 1 }), /^Error: debug_read_scope_stale_stop$/);
  // A reply bound to another stop or generation is also stale.
  const g = clientFake({ generation: 2 });
  await assert.rejects(readClientScope(g.handle, { lane: 'o11', stop: 3, generation: 1 }), /debug_read_scope_stale_stop/);
  const expired = clientFake();
  const inspection = expired.handle.inspection;
  expired.handle.inspection = async c => c.op === 'children' ? { ok: false, error: 'debug_native_client_expired' } : inspection(c);
  await assert.rejects(readClientScope(expired.handle, { lane: 'o11', stop: 3, generation: 1 }), /debug_read_scope_expired/);
});

test('client budget overrun is budget-omitted, never complete', async () => {
  const f = clientFake();
  const r = await readClientScope(f.handle, { lane: 'o11', stop: 3, generation: 1, maxNodes: 50 });
  assert.equal(r.ok, true); assert.equal(r.complete, false); assert.equal(r.runtimeValuesComplete, false);
  assert.equal(r.budget.exhausted, true); assert.equal(r.budget.reason, 'maxNodes'); assert.ok(r.budget.omitted > 0);
  const reasons = new Set(r.scopeCompleteness.incompleteLeaves.map(l => l.reason));
  assert.ok(reasons.has('budget-omitted'));
  for (const l of r.scopeCompleteness.incompleteLeaves.filter(l => l.reason === 'budget-omitted')) assert.equal(l.detail.budget, 'maxNodes');
  assert.ok(f.calls.filter(c => c.op === 'children').every(c => c.limit <= 47));
  await assert.rejects(readClientScope(f.handle, { lane: 'o11', stop: 3, generation: 1, maxNodes: READ_SCOPE_MAX_NODES + 1 }), /debug_read_scope_input_invalid/);
});

test('a step queued during read-scope waits until the traversal settles', async () => {
  const f = clientFake({ rows: 3, delay: 2 }), holder = { commands: Promise.resolve() }, order = [];
  const reading = serializeReadScope(holder, async () => { const r = await readClientScope(f.handle, { lane: 'o11', stop: 3, generation: 1 }); order.push('read-scope'); return r; });
  const stepping = serializeReadScope(holder, async () => { order.push('stepOver'); return { ok: true }; });
  const [r] = await Promise.all([reading, stepping]);
  assert.deepEqual(order, ['read-scope', 'stepOver']); assert.equal(r.complete, true);
  // A failed read does not block the queue.
  const bad = serializeReadScope(holder, async () => { throw new Error('debug_read_scope_stale_stop'); });
  await assert.rejects(bad, /stale_stop/);
  assert.deepEqual(await serializeReadScope(holder, async () => 'next'), 'next');
});

// Server fake mirrors NativeInspection.ReadEvaluated/Describe/ReadFrame; references are stable per path.
function serverFake({ refLimit = 20000, frame = 'none', frameCap = Infinity, stale = () => false, admit } = {}) {
  const ctx = { runtime: 'server', threadId: 'T1', eventId: '9', frame: 0, generation: 2, moduleKey: M, functionKey: 'F'.repeat(22), nodeKey: 'N'.repeat(22) };
  const tree = {
    Rows: { type: 'RecordList', items: Array.from({ length: 200 }, (_, i) => ({ type: 'Scalar', value: String(i) })) },
    Big: { type: 'Scalar', value: 'b'.repeat(40000) },
    Rec: { type: 'Record', fields: { Note: { type: 'Scalar', value: '"' + 'n'.repeat(5000) + '"' },
      Inner: { type: 'Record', fields: { A: { type: 'Scalar', value: '1' } } } } },
  };
  const ids = new Map(), paths = new Map(), calls = [];
  const reference = path => { if (ids.has(path)) return ids.get(path);
    if (ids.size >= refLimit) throw new Error('debug_inspection_reference_limit');
    const id = (ids.size + 1).toString(16).padStart(32, '0'); ids.set(path, id); paths.set(id, path); return id; };
  const nodeAt = path => { const [root, ...rest] = path.split('.'); let node = tree[root];
    for (const seg of rest) node = node.type === 'RecordList' ? (seg === 'Length' ? { type: 'Scalar', value: String(node.items.length) } : node.items[Number(seg.slice(1, -1))]) : node.fields[seg];
    return node; };
  const kids = (path, node) => node.type === 'Record' ? Object.keys(node.fields).map(k => path + '.' + k)
    : node.type === 'RecordList' ? [path + '.Length', ...node.items.map((_, i) => path + '.[' + i + ']')] : [];
  const describe = (path, textOffset = 0, textLimit = 4096) => {
    const node = nodeAt(path), scalar = node.type === 'Scalar';
    const len = scalar ? Math.min(textLimit, node.value.length - textOffset) : 0, next = textOffset + len;
    return { reference: reference(path), path, category: 'local', type: node.type, value: scalar ? node.value.substr(textOffset, len) : null, textOffset,
      textLength: scalar ? node.value.length : null, nextTextOffset: scalar && next < node.value.length ? next : null,
      valueComplete: scalar && textOffset === 0 && next === node.value.length, nativeSummary: false, redacted: false, fullEvaluationDetail: null,
      unavailable: false, undefined: false, trimmed: false, deferred: false, hasChildren: !scalar };
  };
  const readEvaluated = (path, { offset = 0, limit = 50, textOffset = 0, textLimit = 4096 } = {}) => {
    const node = nodeAt(path), all = kids(path, node), page = all.slice(offset, offset + limit), next = offset + page.length;
    return { ok: true, context: ctx, reference: reference(path), evaluationRevision: 1, evaluatedAt: 'now', changed: null,
      value: describe(path, textOffset, textLimit), children: page.map(p => describe(p)), offset, nextOffset: next < all.length ? next : null,
      availableChildren: all.length, nativeEvaluationDetail: 1, collectionCoverage: node.type === 'RecordList'
        ? { declaredLength: node.items.length, enumeratedItems: node.items.length, complete: true, missingItems: 0, source: 'native-container-length-and-indexed-children' } : null,
      deferred: false, nativeTrimmed: false, redacted: false };
  };
  const guard = (op, input, work) => { calls.push({ op, ...input }); if (stale()) return { ok: false, error: 'debug_stale_stop' };
    try { return work(); } catch (error) { return { ok: false, error: error.message }; } };
  const ops = {
    current: () => !stale(),
    async scope() { calls.push({ op: 'scope' });
      return { ok: true, context: ctx, scopeComplete: false, metadataBound: true,
        variables: Object.keys(tree).map(name => ({ reference: reference(name), name, category: 'local', moduleKey: M, functionKey: ctx.functionKey,
          variableKey: 'V'.repeat(22), source: 'published-model', sourceSha256: sha })),
        metadataCoverage: { sourceSha256: sha, authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true, runtimeFrameBound: true,
          variableCounts: { input: 0, output: 0, local: 3, session: 0, site: 0 }, runtimeValuesComplete: false } }; },
    async readMany(input) { return guard('read-many', input, () => {
      assert.ok(input.references.length <= 500 && input.limit <= 150);
      return { ok: true, context: ctx, values: input.references.map(r => readEvaluated(paths.get(r), input)) }; }); },
    async read(input) { return guard('read', input, () => { assert.ok(input.limit <= 150); return readEvaluated(paths.get(input.reference), input); }); },
    ...(admit ? { admit } : {}),
  };
  if (frame === 'unknown') ops.readFrame = async input => { calls.push({ op: 'read-frame', ...input }); return { ok: false, error: 'debug_unknown_operation' }; };
  if (frame === 'native') ops.readFrame = async input => guard('read-frame', input, () => {
    // Level by level like NativeInspection.ReadFrame; frameCap stands for its level/char cut.
    const roots = Object.keys(tree), values = [], pending = []; let level = roots, nodes = roots.length;
    while (level.length) {
      const next = [];
      for (const path of level) {
        if (values.length >= frameCap) { pending.push(reference(path)); continue; }
        const limit = Math.max(0, Math.min(input.maxNodes - nodes, kids(path, nodeAt(path)).length));
        const v = readEvaluated(path, { offset: 0, limit, textLimit: input.textLimit }); values.push(v); nodes += v.children.length;
        for (const c of v.children) if (c.hasChildren) next.push(c.path);
      }
      level = next;
    }
    return { ok: true, op: 'read-frame', context: ctx, scopeComplete: false, maxNodes: input.maxNodes, nodesRead: nodes, budgetExhausted: nodes >= input.maxNodes,
      rootOffset: 0, nextOffset: null, roots: roots.map(reference), values, pending, complete: pending.length === 0 && values.every(v => v.nextOffset == null), nativeCommands: 2 };
  });
  return { ops, calls };
}
const serverInput = { lane: 'o11', threadId: 'T1', eventId: '9', generation: 4 };

test('server read-scope without read-frame: read-many(500), children offset/limit 150 and textOffset pages', async () => {
  const f = serverFake();
  const r = await readServerScope(f.ops, serverInput);
  assert.equal(r.ok, true); assert.equal(r.runtime, 'server'); assert.equal(r.readFrameUsed, false);
  assert.deepEqual(r.scopeCompleteness.incompleteLeaves, []); assert.equal(r.complete, true); assert.equal(r.runtimeValuesComplete, true);
  assert.equal(r.metadataCoverage.runtimeValuesComplete, true);
  assert.ok(f.calls.filter(c => c.op === 'read-many').every(c => c.limit === 150 && c.offset === 0 && c.references.length <= 500));
  const rows = r.scope.variables.find(v => v.name === 'Rows').reference;
  assert.deepEqual(f.calls.filter(c => c.op === 'read' && c.reference === rows).map(c => [c.offset, c.limit]), [[150, 150]]);
  const big = r.scope.variables.find(v => v.name === 'Big').reference;
  assert.deepEqual(f.calls.filter(c => c.op === 'read' && c.reference === big).map(c => c.textOffset), [16384, 32768]);
  // A long child text continues from its page description (4096) through its own reference.
  assert.ok(f.calls.some(c => c.op === 'read' && c.textOffset === 4096));
});

test('server read-scope uses native read-frame first and continues only what it left pending', async () => {
  const done = serverFake({ frame: 'native' });
  const r = await readServerScope(done.ops, serverInput);
  assert.equal(r.readFrameUsed, true); assert.equal(done.calls.filter(c => c.op === 'read-frame').length, 1);
  assert.equal(done.calls.filter(c => c.op === 'read-many').length, 0, 'nothing pending after a complete native frame read');
  assert.equal(r.complete, true);
  const partial = serverFake({ frame: 'native', frameCap: 2 });
  const p = await readServerScope(partial.ops, serverInput);
  assert.equal(p.readFrameUsed, true); assert.ok(partial.calls.some(c => c.op === 'read-many')); assert.equal(p.complete, true);
  const unknown = serverFake({ frame: 'unknown' });
  const u = await readServerScope(unknown.ops, serverInput);
  assert.equal(u.readFrameUsed, false); assert.equal(u.complete, true);
});

test('server reference limit (20000) and hold budget are budget-omitted, never success', async () => {
  const f = serverFake({ refLimit: 100 });
  const r = await readServerScope(f.ops, serverInput);
  assert.equal(r.ok, true); assert.equal(r.complete, false); assert.equal(r.runtimeValuesComplete, false);
  assert.equal(r.budget.exhausted, true); assert.equal(r.budget.reason, 'reference-limit');
  assert.ok(r.scopeCompleteness.incompleteLeaves.length > 0);
  assert.ok(r.scopeCompleteness.incompleteLeaves.every(l => l.reason === 'budget-omitted' && l.detail.budget === 'reference-limit'));
  let n = 0;
  const h = serverFake({ admit: () => ++n <= 2 });
  const held = await readServerScope(h.ops, serverInput);
  assert.equal(held.complete, false); assert.equal(held.budget.reason, 'request-hold');
  assert.ok(held.scopeCompleteness.incompleteLeaves.some(l => l.reason === 'budget-omitted'));
  const small = await readServerScope(serverFake().ops, { ...serverInput, maxNodes: 20 });
  assert.equal(small.complete, false); assert.equal(small.budget.reason, 'maxNodes');
  assert.ok(small.scopeCompleteness.incompleteLeaves.every(l => !['not-read', 'page-pending', 'text-pending'].includes(l.reason)));
});

test('server stale stop aborts the read', async () => {
  let calls = 0;
  const f = serverFake({ stale: () => ++calls > 3 });
  await assert.rejects(readServerScope(f.ops, serverInput), /debug_read_scope_stale_stop/);
  await assert.rejects(readServerScope(serverFake().ops, { ...serverInput, threadId: '' }), /debug_read_scope_input_invalid/);
});

test('tool description text names the operation for both runtimes', () => {
  assert.match(readScopeDescription.client, /read-scope/); assert.match(readScopeDescription.server, /read-scope/);
  assert.match(readScopeDescription.server, /budget-omitted/);
});

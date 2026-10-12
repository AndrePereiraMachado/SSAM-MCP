// Full-scope fixture audit (P18): expected per-node coverage from the installed model-only debug-scope reader, and a
// verdict over a public proof transcript (debug-surface-proof.mjs) computed with scopeCompleteness only. It never
// reads a value: counts, root names, read evidence and native/policy reasons are all it compares.
import { nativeInspectionScopeMetadata } from './debug-native-inspection-metadata.mjs';
import { scopeCompleteness } from './debug-scope-completeness.mjs';

export const EXPECTED_SCHEMA = 'ssam-debug-scope-expected-coverage/1';
const CATEGORIES = ['input', 'output', 'local', 'client', 'session', 'site', 'setting', 'timer'];
const READ_OPS = new Set(['read', 'read-many', 'refresh', 'expand', 'children', 'slice', 'read-scope', 'private-read']);
const nativeReasons = new Set(['native-unavailable-in-context', 'native-undefined', 'native-binary-summary']);
const fail = code => { throw new Error('debug_scope_coverage_' + code); };
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : plain(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v ?? null);

// Widgets are the installed NRWidgets plugin classes and NRWebWidgets nested classes (block instances included).
export const isWidgetKind = kind => typeof kind === 'string' && /(?:^|\.)(?:NRWidgets|NRWebWidgets)[.+][A-Za-z]/.test(kind);
const shortKind = kind => typeof kind === 'string' ? kind.split(/[.+]/).at(-1) : null;

// One planned breakpoint node from a ssam-native-debug-scope/1 reader result. nativeInspectionScopeMetadata is the
// same validation the sessions apply, so a count here is exactly the frame-bound metadataCoverage count live.
export function expectedScopeNode(scope, { id, functionName = null, functionKind = null, ownerName = null, nodeLabel = null } = {}) {
  if (typeof id !== 'string' || !id) fail('node_id_invalid');
  const metadata = nativeInspectionScopeMetadata({ scope, moduleKey: scope?.moduleKey, sourceSha256: scope?.sourceSha256,
    functionKey: scope?.functionKey, nodeKey: scope?.nodeKey, previousNodeKey: scope?.previousNodeKey ?? null });
  const roots = scope.variables.map(v => ({ name: v.name, category: v.category, kind: shortKind(v.modelKind), widget: isWidgetKind(v.modelKind) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.category.localeCompare(b.category));
  return { id, module: null, moduleKey: scope.moduleKey, sourceSha256: scope.sourceSha256, runtime: scope.runtime,
    functionKey: scope.functionKey, nodeKey: scope.nodeKey, previousNodeKey: scope.previousNodeKey ?? null,
    functionName, functionKind, ownerName, nodeLabel, functionDebuggerHash: scope.functionDebuggerHash ?? null,
    variableCounts: metadata.coverage.variableCounts, roots,
    automaticExpressionsEnumerated: scope.automaticExpressionsEnumerated === true, automaticExpressionsError: scope.automaticExpressionsError ?? null,
    pending: scope.pending ?? [] };
}

// Key-independent view: what a rebuilt or republished capture must reproduce for the same planned node.
export const coverageProjection = n => ({ id: n.id, runtime: n.runtime, variableCounts: Object.fromEntries(CATEGORIES.map(c => [c, n.variableCounts?.[c] ?? 0])),
  roots: (n.roots ?? []).map(({ name, category, kind, widget }) => ({ name, category, kind, widget })) });
export function compareCoverage(expectedNodes, observedNodes) {
  const byId = new Map(observedNodes.map(n => [n.id, n])), differences = [];
  for (const n of expectedNodes) {
    const o = byId.get(n.id);
    if (!o) { differences.push({ id: n.id, reason: 'missing' }); continue; }
    if (canonical(coverageProjection(n)) !== canonical(coverageProjection(o))) differences.push({ id: n.id, reason: 'projection-differs',
      expected: coverageProjection(n), observed: coverageProjection(o) });
  }
  for (const o of observedNodes) if (!expectedNodes.some(n => n.id === o.id)) differences.push({ id: o.id, reason: 'unexpected' });
  return { identical: differences.length === 0, differences };
}

// A republished capture re-keys every created element: bind each planned node to its new keys (resolved by name).
export function bindExpectedCoverage(expected, bindings) {
  if (expected?.schema !== EXPECTED_SCHEMA || !Array.isArray(expected.nodes)) fail('expected_invalid');
  const byId = new Map((bindings ?? []).map(b => [b.id, b]));
  return { ...expected, bound: true, nodes: expected.nodes.map(n => {
    const b = byId.get(n.id);
    if (!b || !/^[A-Za-z0-9_+]{22}$/.test(b.nodeKey ?? '') || !/^[A-Za-z0-9_+]{22}(?:\.\#FlowExceptionHandler)?$/.test(b.functionKey ?? '') ||
        !/^[a-f0-9]{64}$/.test(b.sourceSha256 ?? '')) fail('binding_missing:' + n.id);
    return { ...n, moduleKey: b.moduleKey ?? n.moduleKey, functionKey: b.functionKey, nodeKey: b.nodeKey, sourceSha256: b.sourceSha256 };
  }) };
}

export function parseTranscript(input) {
  if (Array.isArray(input)) return input;
  if (typeof input !== 'string') fail('transcript_invalid');
  return input.split(/\r?\n/).filter(line => line.trim()).map(line => { try { return JSON.parse(line); } catch { return fail('transcript_invalid'); } });
}

const stopKey = (runtime, request) => runtime === 'server' ? (request.threadId != null && request.eventId != null ? request.threadId + ':' + request.eventId : null)
  : Number.isSafeInteger(request.stop) ? String(request.stop) : null;
const generationOf = (runtime, r) => runtime === 'server' ? r?.context?.generation : r?.generation;
const scopeIdentity = (runtime, scope) => { const c = scope?.context ?? {}; return { functionKey: c.functionKey ?? null, nodeKey: c.nodeKey ?? null }; };

// Stops in transcript order: the latest successful scope per stop and every public read answered at that stop.
function proofStops(rows, runtime) {
  const requests = new Map(), stops = new Map();
  let start = null;
  for (const row of rows) {
    if (!plain(row)) fail('transcript_invalid');
    if (row.kind === 'request') { requests.set(row.seq, row.request ?? {}); if (row.request?.op === 'start' && !start) start = row.request; continue; }
    if (row.kind !== 'response') continue;
    const request = requests.get(row.seq), result = row.result;
    if (!request || !plain(result)) continue;
    const key = stopKey(runtime, request);
    if (!key) continue;
    if (!stops.has(key)) stops.set(key, { stop: key, scope: null, reads: [], privateReads: 0 });
    const s = stops.get(key);
    if (request.op === 'scope' && result.ok === true) { s.scope = result; s.reads = []; }
    else if (READ_OPS.has(request.op) && result.ok !== false) {
      // read-scope (P28) may answer a batch: each native read in `reads` is judged like a single read.
      if (Array.isArray(result.reads)) s.reads.push(...result.reads.filter(plain)); else s.reads.push(result);
      if (request.op === 'private-read') s.privateReads++;
    }
  }
  return { start, stops: [...stops.values()] };
}

export function auditScopeCoverage({ expected, transcript, audit = null, runtime, lane } = {}) {
  if (expected?.schema !== EXPECTED_SCHEMA || !Array.isArray(expected.nodes) || !['client', 'server'].includes(runtime) || !['o11', 'odc'].includes(lane))
    fail('input_invalid');
  const rows = parseTranscript(transcript), { start, stops } = proofStops(rows, runtime);
  const nodes = expected.nodes.filter(n => n.runtime === runtime);
  const find = (functionKey, nodeKey) => nodes.find(n => n.functionKey === functionKey && n.nodeKey === nodeKey) ?? null;
  // Planned = the nodes this script's start asked for (all expected nodes of the runtime when the start is unknown).
  const planned = Array.isArray(start?.scopes) ? start.scopes.flatMap(s => (s.nodeKeys ?? []).map(k => find(s.functionKey, k))).filter(Boolean) : nodes;
  const failures = [], verdicts = [], visited = new Set();
  stops.forEach((s, index) => {
    const at = index + 1, push = (code, extra = {}) => failures.push({ code, stop: at, ...extra });
    const v = { index: at, stop: s.stop, nodeId: null, countsMatch: false, countDifferences: [], completeness: null,
      widgetRoots: { expected: 0, expanded: 0, unexpanded: [], missing: [] }, privateUnmatched: [], pass: false };
    verdicts.push(v);
    if (!s.scope) return push('scope-missing');
    const { functionKey, nodeKey } = scopeIdentity(runtime, s.scope), n = find(functionKey, nodeKey);
    if (!n) return push('node-unplanned', { functionKey, nodeKey });
    v.nodeId = n.id; visited.add(n.id);
    const observed = s.scope.metadataCoverage?.runtimeFrameBound === true ? s.scope.metadataCoverage.variableCounts ?? {} : null;
    if (!observed) push('metadata-coverage-unbound');
    else for (const c of CATEGORIES) if ((observed[c] ?? 0) !== (n.variableCounts[c] ?? 0))
      v.countDifferences.push({ category: c, expected: n.variableCounts[c] ?? 0, observed: observed[c] ?? 0 });
    v.countsMatch = !!observed && v.countDifferences.length === 0;
    if (observed && !v.countsMatch) push('category-count-mismatch', { differences: v.countDifferences });
    const generation = generationOf(runtime, s.scope);
    const reads = s.reads.filter(r => (runtime === 'server' ? (r.context ? r.context.generation : r.values?.[0]?.context?.generation) : r.generation ?? r.values?.[0]?.generation) === generation);
    let c;
    try {
      c = scopeCompleteness({ lane, runtime, stop: runtime === 'server' ? s.stop : Number(s.stop), generation, metadataCoverage: s.scope.metadataCoverage,
        scopeVariables: s.scope, reads });
    } catch (error) { c = { ok: false, refused: String(error?.message ?? 'debug_scope_completeness_failed') }; }
    v.completeness = { ok: c.ok === true, refused: c.refused ?? null, runtimeValuesComplete: c.runtimeValuesComplete === true,
      residualNativeLimitsOnly: c.residualNativeLimitsOnly === true, incompleteLeaves: (c.incompleteLeaves ?? []).map(({ root, path, reason }) => ({ root, path, reason })) };
    if (c.ok !== true) push('completeness-refused', { refused: c.refused ?? null });
    else if (!c.runtimeValuesComplete && !c.residualNativeLimitsOnly) push('values-incomplete', { reasons: [...new Set(c.incompleteLeaves.map(l => l.reason))] });
    // Every widget root of the plan must be enumerated, expanded and read to its leaves at this stop.
    const variables = Array.isArray(s.scope.variables) ? s.scope.variables : [];
    for (const root of n.roots.filter(r => r.widget)) {
      v.widgetRoots.expected++;
      const ref = variables.find(x => x?.name === root.name && x?.category === root.category)?.[runtime === 'server' ? 'reference' : 'ref'];
      const summary = ref && (c.roots ?? []).find(r => r.reference === ref);
      if (!summary) { v.widgetRoots.missing.push(root.name); push('widget-root-missing', { root: root.name }); continue; }
      const leaves = (c.incompleteLeaves ?? []).filter(l => l.root === ref);
      if (summary.treeComplete || leaves.every(l => nativeReasons.has(l.reason))) v.widgetRoots.expanded++;
      else { v.widgetRoots.unexpanded.push(root.name); push('widget-root-unexpanded', { root: root.name, reasons: [...new Set(leaves.map(l => l.reason))] }); }
    }
    v.privateUnmatched = (c.policyRedactions ?? []).filter(p => !p.privateReadObserved).map(p => p.path ?? p.reference);
    if (v.privateUnmatched.length) push('private-read-unmatched', { paths: v.privateUnmatched });
    v.pass = !failures.some(f => f.stop === at);
  });
  const missingNodes = planned.map(n => n.id).filter(id => !visited.has(id));
  for (const id of missingNodes) failures.push({ code: 'planned-node-not-visited', node: id });
  const surfaceCriteriaPassed = audit ? audit.surfaceCriteriaPassed === true : null;
  if (audit && !surfaceCriteriaPassed) failures.push({ code: 'surface-criteria-failed' });
  return { ok: failures.length === 0 && stops.length > 0, lane, runtime, stops: verdicts, visitedNodes: [...visited], missingNodes,
    plannedNodes: planned.map(n => n.id), surfaceCriteriaPassed, failures, valuesReturned: false };
}

// Synthetic public transcript for a dry run of the audit: every root read and expanded, unless an option breaks one.
// Shapes mirror debug-scope-completeness tests (NativeInspection Describe on the server, client core evaluate/children).
export function syntheticScopeProof(expected, { runtime, unexpandWidget = null, dropRoot = null, redact = null, privateRead = false } = {}) {
  const nodes = expected.nodes.filter(n => n.runtime === runtime), rows = [];
  let seq = 0;
  const send = (request, result) => { seq++; rows.push({ seq, kind: 'request', channel: 'debug', request }); rows.push({ seq, kind: 'response', result }); };
  const byFunction = new Map();
  for (const n of nodes) byFunction.set(n.functionKey, [...(byFunction.get(n.functionKey) ?? []), n.nodeKey]);
  send({ op: 'start', run: { lane: expected.lane }, scopes: [...byFunction].map(([functionKey, nodeKeys]) => ({ functionKey, nodeKeys })) },
    { ok: true, sessionId: 'synthetic' });
  nodes.forEach((n, i) => {
    const generation = runtime === 'server' ? 2 : 1, server = runtime === 'server';
    const token = server ? { sessionId: 'synthetic', threadId: 'T1', eventId: String(i + 1), generation } : { sessionId: 'synthetic', stop: i + 1, generation };
    const ctx = server ? { threadId: 'T1', eventId: String(i + 1), generation, frame: 0, moduleKey: n.moduleKey, functionKey: n.functionKey, nodeKey: n.nodeKey } : null;
    const flat = server ? {} : { stop: i + 1, generation };
    const counts = { ...n.variableCounts }, roots = n.roots.filter(r => r.name !== dropRoot);
    const dropped = n.roots.find(r => r.name === dropRoot);
    if (dropped) counts[dropped.category]--;
    const refOf = (r, j) => 'r' + i + '_' + j, refKey = server ? 'reference' : 'ref';
    const variables = roots.map((r, j) => ({ [refKey]: refOf(r, j), name: r.name, category: r.category, ...(server ? {} : { nativePath: r.name, ...flat }) }));
    send({ op: 'scope', ...token }, { ok: true, ...flat, ...(server ? { context: ctx } : { context: { moduleKey: n.moduleKey, functionKey: n.functionKey, nodeKey: n.nodeKey } }),
      variables, metadataCoverage: { modelScopeEnumerated: true, runtimeFrameBound: true, variableCounts: counts, runtimeValuesComplete: false } });
    roots.forEach((r, j) => {
      const ref = refOf(r, j), child = ref + 'c';
      const scalar = (reference, path, over = {}) => server
        ? { reference, path, type: 'Scalar', value: '1', textOffset: 0, textLength: 1, nextTextOffset: null, valueComplete: true, redacted: false, hasChildren: false, ...over }
        : null;
      if (r.name === redact) {
        if (server) send({ op: 'read', ...token, reference: ref }, { ok: true, context: ctx, reference: ref, value: scalar(ref, r.name, { redacted: true, valueComplete: false }), children: [] });
        else send({ op: 'read', ...token, ref }, { ...flat, ref, value: null, redacted: true });
        if (privateRead) send({ op: 'private-read', ...token, [refKey]: ref }, { ...(server ? { context: ctx } : flat), [refKey]: ref, privateValueReturnedPublicly: false });
        return;
      }
      if (!r.widget) {
        if (server) send({ op: 'read', ...token, reference: ref }, { ok: true, context: ctx, reference: ref, value: scalar(ref, r.name), children: [] });
        else send({ op: 'read', ...token, ref }, { ...flat, ref, value: { type: 'Integer', value: 1 }, valueComplete: true });
        return;
      }
      // A widget is a native compound: its container read, one children page, and each child read.
      const unexpanded = r.name === unexpandWidget;
      if (server) {
        const value = { reference: ref, path: r.name, type: 'Record', valueComplete: false, hasChildren: true };
        send({ op: 'read', ...token, reference: ref }, unexpanded ? { ok: true, context: ctx, reference: ref, value, children: [], deferred: true }
          : { ok: true, context: ctx, reference: ref, value, children: [scalar(child, r.name + '.Value')], offset: 0, nextOffset: null, availableChildren: 1 });
      } else {
        send({ op: 'read', ...token, ref }, { ...flat, ref, value: { type: 'Record', value: null }, deferred: true, expandable: true, valueComplete: false });
        if (!unexpanded) {
          send({ op: 'children', ...token, ref }, { ...flat, ref, offset: 0, total: 1, nextOffset: null, children: [{ ref: child, name: 'Value', nativePath: r.name + '.Value' }] });
          send({ op: 'read', ...token, ref: child }, { ...flat, ref: child, value: { type: 'Integer', value: 1 }, valueComplete: true });
        }
      }
    });
    send({ op: 'continue', ...token }, { ok: true });
  });
  return { transcript: rows, audit: { surfaceCriteriaPassed: true, runtime, lane: expected.lane } };
}

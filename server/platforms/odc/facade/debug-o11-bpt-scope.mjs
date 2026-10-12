// BPT activity scope plan from the installed model's native debugger scope, never from names.
// Each root is classified by the key of the model element that owns it; per-root coverage comes
// only from rootCoverage over native reads (backgroundValuesCoverage) and is never forced.
// Launch bindings reuse the bindInputs rules and map each argument by key to IProcess.InputParameters.
import { readNativeInspectionScopes } from './debug-native-scope-reader.mjs';
import { backgroundValuesCoverage } from './debug-background-correlation.mjs';
import { bindInputs } from './debug-o11-entry-graph.mjs';
import { nativeO11Process } from './debug-o11-bpt.mjs';

const KEY = /^[A-Za-z0-9_+]{22}$/, AUTHORITY = 'installed-model-scope-and-watchability';
const fail = code => { throw new Error('debug_o11_bpt_scope_' + code); };
export const BPT_SCOPE_CATEGORIES = Object.freeze(['activityLocal', 'activityOutput', 'processInput', 'processOutput',
  'precedingActivityOutput', 'humanArgument', 'moduleContext', 'unclassified']);
// The tracer's per-function scope budget; roots past it stay listed and count as omitted.
export const TRACE_ROOT_BUDGET = 60;
const MODULE_CONTEXT = new Set(['client', 'session', 'site', 'setting', 'timer']);

function planned(activityNodes) {
  if (!Array.isArray(activityNodes) || !activityNodes.length) fail('activities_required');
  const list = activityNodes.map(a => ({ key: a?.key, nodeKeys: a?.nodeKeys ?? (a?.startNodeKey ? [a.startNodeKey] : []) }));
  if (list.some(a => !KEY.test(a.key ?? '') || !Array.isArray(a.nodeKeys) || !a.nodeKeys.length || a.nodeKeys.some(n => !KEY.test(n ?? '')) ||
      new Set(a.nodeKeys).size !== a.nodeKeys.length) || new Set(list.map(a => a.key)).size !== list.length) fail('activities_invalid');
  return list;
}
// One native server scope read per planned activity node (automatic and interactive plans alike). With the
// process node, an activity without nodeKeys is read at every node of its flow, so later node outputs appear.
export function readO11BptActivityScopes({ source, moduleKey, activityNodes, processNode, directory }, services) {
  const expanded = processNode && Array.isArray(activityNodes)
    ? activityNodes.map(a => a?.nodeKeys ? a : { ...a, nodeKeys: activityFlowNodeKeys(processNode, a?.key) }) : activityNodes;
  return readNativeInspectionScopes({ lane: 'o11', runtime: 'server', source, moduleKey, directory,
    scopes: planned(expanded).map(a => ({ functionKey: a.key, nodeKeys: a.nodeKeys })) }, services);
}

// Owned element keys: the reader's reference collection (complete or refused) plus direct children of that kind.
function collection(node, name) {
  const list = node.propertyReferenceCollections?.[name];
  if (!list) return [];
  if (list.omitted !== 0 || !Array.isArray(list.items) || list.total !== list.items.length || list.items.some(i => typeof i?.key !== 'string' || !i.key))
    fail('owner_model_incomplete');
  return list.items.map(i => i.key);
}
// The activity's own flow nodes (its native 'Nodes' collection), start node first.
export function activityFlowNodeKeys(processNode, activityKey) {
  const activity = (processNode?.children ?? []).find(c => c?.key === activityKey && collection(processNode, 'Nodes').includes(c.key));
  if (!activity || !activity.propertyReferenceCollections?.Nodes) fail('owner_model_incomplete');
  const keys = collection(activity, 'Nodes'), kinds = new Map((activity.children ?? []).map(c => [c?.key, c?.kind]));
  if (!keys.length || keys.some(n => !KEY.test(n) || !kinds.has(n))) fail('owner_model_incomplete');
  return [...keys.filter(n => kinds.get(n) === 'StartNode'), ...keys.filter(n => kinds.get(n) !== 'StartNode')];
}
const owned = (node, name, kind) => new Set([...collection(node, name), ...(node.children ?? []).filter(c => kind.test(c?.kind ?? '')).map(c => c.key)]);
function subtree(node, keys = new Set()) {
  if (node.childrenOmitted || Number.isInteger(node.childrenTotal) && node.childrenTotal !== node.children?.length) fail('owner_model_incomplete');
  for (const child of node.children ?? []) { if (child?.key) keys.add(child.key); subtree(child, keys); }
  return keys;
}
function ownerIndex(processNode) {
  const children = new Map((processNode.children ?? []).map(c => [c.key, c]));
  const nodes = new Map(collection(processNode, 'Nodes').map(key => [key, children.get(key)]));
  const index = { processKey: processNode.key, inputs: owned(processNode, 'InputParameters', /^InputParameter$/),
    outputs: owned(processNode, 'OutputParameters', /^OutputParameter$/), nodes: new Map(), incoming: new Map() };
  for (const [key, node] of nodes) {
    index.nodes.set(key, { kind: node.kind, human: node.kind === 'HumanActivityNode', locals: owned(node, 'LocalVariables', /LocalVariable$/),
      outputs: owned(node, 'OutputParameters', /OutputParameter$/), all: subtree(node) });
    for (const target of collection(node, 'Targets')) { if (!index.incoming.has(target)) index.incoming.set(target, []); index.incoming.get(target).push(key); }
  }
  return index;
}
function predecessors(index, key) {
  const seen = new Set(), queue = [key];
  for (let i = 0; i < queue.length; i++) for (const from of index.incoming.get(queue[i]) ?? []) if (!seen.has(from)) { seen.add(from); queue.push(from); }
  return seen;
}
function classify(index, functionKey, v, moduleKey) {
  if (MODULE_CONTEXT.has(v.category)) return { category: 'moduleContext', ownerKey: moduleKey };
  const own = index.nodes.get(functionKey);
  if (own.locals.has(v.variableKey)) return { category: 'activityLocal', ownerKey: functionKey };
  if (own.outputs.has(v.variableKey)) return { category: 'activityOutput', ownerKey: functionKey };
  if (index.inputs.has(v.variableKey)) return { category: 'processInput', ownerKey: index.processKey };
  if (index.outputs.has(v.variableKey)) return { category: 'processOutput', ownerKey: index.processKey };
  // Native node scope entries (node outputs) inside the activity flow belong to the activity.
  if (own.all.has(v.variableKey)) return { category: 'activityLocal', ownerKey: functionKey };
  for (const [key, other] of index.nodes) {
    if (key === functionKey) continue;
    if (other.human && other.all.has(v.variableKey)) return { category: 'humanArgument', ownerKey: key };
    // Targets reachability; nativeO11Process already refused any non-End node without its Targets collection.
    if (other.outputs.has(v.variableKey)) return { category: 'precedingActivityOutput', ownerKey: key, precedes: predecessors(index, functionKey).has(key) };
  }
  return { category: 'unclassified', ownerKey: null };
}

// Native scope metadata (readNativeInspectionScopes runtime 'server'): every variable must belong to a planned
// (functionKey, nodeKey) whose coverage carries the installed-model authority and the same category counts.
function nativeVariables(nativeScopes, activities) {
  const missing = [], byFunction = new Map(activities.map(a => [a.key, []]));
  if (!nativeScopes) { for (const a of activities) for (const nodeKey of a.nodeKeys) missing.push({ functionKey: a.key, nodeKey }); return { missing, byFunction, moduleKey: null }; }
  const modules = nativeScopes.modules, moduleKey = modules?.[0]?.moduleKey;
  if (!Array.isArray(modules) || modules.length !== 1 || !KEY.test(moduleKey ?? '') || !Array.isArray(nativeScopes.variables) || !Array.isArray(nativeScopes.coverage))
    fail('scope_invalid');
  for (const v of nativeScopes.variables) {
    const a = activities.find(x => x.key === v?.functionKey);
    if (!a || !a.nodeKeys.includes(v.nodeKey)) fail('scope_unplanned');
    if (v.moduleKey !== moduleKey || !KEY.test(v.variableKey ?? '') || typeof v.path !== 'string' || !v.path) fail('scope_invalid');
  }
  for (const c of nativeScopes.coverage) if (c?.authority !== AUTHORITY || c.modelScopeEnumerated !== true || c.moduleKey !== moduleKey) fail('scope_authority_invalid');
  for (const a of activities) for (const nodeKey of a.nodeKeys) {
    const found = nativeScopes.coverage.filter(c => c.functionKey === a.key && c.nodeKey === nodeKey);
    if (!found.length) { missing.push({ functionKey: a.key, nodeKey }); continue; }
    const vars = nativeScopes.variables.filter(v => v.functionKey === a.key && v.nodeKey === nodeKey);
    const counts = Object.values(found[0].variableCounts ?? {});
    if (found.length !== 1 || counts.some(n => !Number.isSafeInteger(n) || n < 0) || counts.reduce((s, n) => s + n, 0) !== vars.length) fail('scope_counts_mismatch');
    byFunction.get(a.key).push(...vars);
  }
  return { missing, byFunction, moduleKey };
}

// Launch bindings: the Argument expressions of the Execute node calling LaunchProcessAction (bindInputs
// rules), mapped by key to IProcess.InputParameters. Only a pass-through mapped by key is controllable.
function launchBindings(graph, index, process, launchCall) {
  if (!launchCall) return [];
  const path = (launchCall.path ?? []).map(n => graph.nodes.get(n?.id ?? n)), hops = launchCall.hops ?? [];
  const launch = path.at(-1), last = hops.at(-1), processId = launch?.moduleKey + '*' + index.processKey;
  if (path.length < 2 || path.some(n => !n) || hops.length !== path.length - 1 || hops.some((h, i) => h?.from !== path[i].id || h.to !== path[i + 1].id) ||
      launch.kind !== 'ProcessLaunchAction' || launch.key !== process.launchActionKey || last.via?.kind !== 'execute' ||
      !graph.edges.some(e => e.from === launch.id && e.to === processId && e.via?.kind === 'process-launch')) fail('launch_call_unproved');
  const edge = graph.edges.find(e => e.from === last.from && e.to === last.to);
  if (edge?.language !== 'os') fail('launch_call_unproved');
  return bindInputs(graph, path, hops).map(b => {
    const parameter = (launch.inputs ?? []).find(i => i.name === b.input), argument = edge.arguments.find(a => a.parameter === b.input);
    // An IProcess input key, or the generated launch-signature key <launchKey>.<input key>.
    const resolve = key => typeof key !== 'string' ? null : index.inputs.has(key) ? [key, 'process-input']
      : key.startsWith(launch.key + '.') && index.inputs.has(key.slice(launch.key.length + 1)) ? [key.slice(launch.key.length + 1), 'launch-signature-key'] : null;
    // The Argument's Parameter key decides; the launch input, when keyed, must name the same process input.
    const byArgument = resolve(argument?.parameterKey ?? parameter?.key), byParameter = parameter?.key ? resolve(parameter.key) : byArgument;
    const [processInputKey, keyMatch] = byArgument && byParameter?.[0] === byArgument[0] ? byArgument : [null, null];
    const mode = ['controlled', 'direct'].includes(b.class) ? 'pass-through' : ['fixed', 'default'].includes(b.class) ? 'literal' : 'derived';
    return { launcherInput: mode === 'pass-through' ? b.entryInput + (b.attributePath ? '.' + b.attributePath : '') : null,
      processInput: b.input, processInputKey, keyMatch, mode, controllable: mode === 'pass-through' && b.controllable === true && processInputKey !== null,
      // identity (native GetUserId provenance) and screen-variable stay derived here but keep class and provenance.
      bindClass: b.class, ...(b.expression ? { expression: b.expression } : {}), ...(b.provenance ? { provenance: b.provenance } : {}),
      ...(b.screenVariable ? { screenVariable: b.screenVariable } : {}), ...(b.class === 'default' ? { defaulted: true } : {}), ...(b.at ? { at: b.at } : {}) };
  });
}

const ORDER = BPT_SCOPE_CATEGORIES;
export function buildO11BptScopePlan({ graph, processNode, activityNodes, nativeScopes, launchCall, reads = {}, traceBudget = TRACE_ROOT_BUDGET } = {}) {
  if (!graph?.nodes || !Array.isArray(graph.edges) || !processNode) fail('input_invalid');
  if (!Number.isSafeInteger(traceBudget) || traceBudget < 1) fail('input_invalid');
  const process = nativeO11Process(processNode), index = ownerIndex(processNode), activities = planned(activityNodes);
  if (activities.some(a => index.nodes.get(a.key)?.kind !== 'AutomaticActivityNode')) fail('activity_not_in_process');
  // Every planned node belongs to the activity flow; flow nodes left unplanned keep valuesComplete false.
  const unread = [];
  for (const a of activities) {
    const flow = activityFlowNodeKeys(processNode, a.key);
    if (a.nodeKeys.some(n => !flow.includes(n))) fail('node_not_in_activity');
    for (const nodeKey of flow) if (!a.nodeKeys.includes(nodeKey)) unread.push({ functionKey: a.key, nodeKey });
  }
  const { missing, byFunction, moduleKey } = nativeVariables(nativeScopes, activities);
  if (moduleKey && graph.nodes.get(moduleKey + '*' + processNode.key)?.kind !== 'Process') fail('process_not_in_graph');
  const stopsOf = key => Array.isArray(reads) ? (activities.length === 1 ? reads : fail('reads_ambiguous')) : reads?.[key] ?? [];
  const roots = [], traceScopes = {}, summaries = [], observedOutsidePlan = [];
  let omitted = 0, coverageComplete = true;
  for (const a of activities) {
    // One root per native variable identity; the first node that showed it is its nodeKey.
    const mine = new Map();
    for (const v of byFunction.get(a.key)) {
      const id = v.variableKey + '\n' + v.path, current = mine.get(id);
      if (current) { if (!current.nodeKeys.includes(v.nodeKey)) current.nodeKeys.push(v.nodeKey); continue; }
      mine.set(id, { name: v.name, path: v.path, ...classify(index, a.key, v, moduleKey), functionKey: a.key, nodeKey: v.nodeKey, nodeKeys: [v.nodeKey],
        variableKey: v.variableKey, nativeCategory: v.category });
    }
    const list = [...mine.values()].map((r, i) => [r, i]).sort((x, y) => ORDER.indexOf(x[0].category) - ORDER.indexOf(y[0].category) || x[1] - y[1]).map(x => x[0]);
    const cut = Math.max(0, list.length - traceBudget); omitted += cut;
    list.forEach((r, i) => { r.traced = i < traceBudget; });
    traceScopes[a.key] = list.slice(0, traceBudget).map(r => r.path);
    const coverage = backgroundValuesCoverage({ modelRoots: list.map(r => r.path), omittedRoots: cut, stops: stopsOf(a.key) });
    const byName = new Map(coverage.roots.map(r => [r.name, r])), names = new Set();
    for (const r of list) {
      const unique = list.filter(x => x.name === r.name).length === 1;
      // Stops name a root by native path; a unique model name is the fallback.
      const byPath = byName.get(r.path), found = byPath && byPath.state !== 'not-enumerated' ? byPath : (unique && byName.get(r.name)) || byPath;
      names.add(r.path); if (unique) names.add(r.name);
      r.coverage = found ? { state: found.state, ...(found.reasons ? { reasons: found.reasons } : {}), ...(found.evidence ? { evidence: found.evidence } : {}) }
        : { state: 'not-enumerated' };
    }
    for (const r of coverage.roots) if (!names.has(r.name)) observedOutsidePlan.push({ functionKey: a.key, name: r.name, state: r.state });
    coverageComplete &&= coverage.valuesComplete === true;
    summaries.push({ key: a.key, nodeKeys: a.nodeKeys, roots: list.length, omitted: cut, valuesComplete: coverage.valuesComplete === true,
      stopsObserved: coverage.stopsObserved, invalidStops: coverage.invalidStops });
    roots.push(...list);
  }
  const view = r => ({ name: r.name, path: r.path, category: r.category, ownerKey: r.ownerKey, functionKey: r.functionKey, nodeKey: r.nodeKey });
  const valuesComplete = !missing.length && !unread.length && coverageComplete && omitted === 0 && roots.length > 0 && roots.every(r => r.coverage.state === 'complete');
  return { schema: 'ssam-o11-bpt-scope/1', authority: AUTHORITY, coverageSource: 'rootCoverage', moduleKey, processKey: processNode.key,
    roots, omitted, traceScopes, valuesComplete, missingScopes: missing, unreadNodeScopes: unread,
    unavailable: roots.filter(r => r.coverage.state === 'native-unavailable').map(r => ({ ...view(r), evidence: r.coverage.evidence ?? [] })),
    redacted: roots.filter(r => r.coverage.state === 'redacted').map(view),
    incomplete: roots.filter(r => !['complete', 'native-unavailable', 'redacted'].includes(r.coverage.state)).map(r => ({ ...view(r), state: r.coverage.state })),
    observedOutsidePlan, activities: summaries, launchBindings: launchBindings(graph, index, process, launchCall), valuesReturned: false };
}

// Values coverage of a BPT run for result.valuesCoverage; it never throws after the launch. Only interactive
// native reads (scopeEvidence of an inspection session) feed rootCoverage. Automatic trace rows (DebugSession
// TraceStop path projections, no native reference/completeness flags) only label which roots appeared.
const boundedValue = (v, depth = 0) => !v || typeof v !== 'object' || depth > 8 || v.trimmed === true || v.deferred === true || v.nativeSummary === true ||
  (v.childrenOmitted ?? 0) !== 0 || (Array.isArray(v.children) ? v.children : []).some(c => boundedValue(c, depth + 1));
function automaticTrace(rows, r) {
  const seen = rows.filter(row => row?.functionKey === r.functionKey).flatMap(row => Array.isArray(row.values) ? row.values : []).filter(v => v?.path === r.path);
  return !seen.length ? 'not-observed' : seen.some(v => !boundedValue(v)) ? 'observed' : 'observed-bounded';
}
export async function o11BptValuesCoverage({ interactive = false, scopeEvidence, traceRows, ...planInput } = {}) {
  let reads = {}, reason = null;
  if (interactive === true && typeof scopeEvidence === 'function') {
    try { reads = await scopeEvidence(); } catch { reads = {}; reason = 'native_scope_reads_unavailable'; }
  } else reason = 'bounded_trace_without_native_completeness';
  let plan;
  try { plan = buildO11BptScopePlan({ ...planInput, reads }); }
  catch (error) {
    return { coverageSource: 'rootCoverage', valuesComplete: false, reason: reason === 'native_scope_reads_unavailable' ? reason : 'native_scope_plan_refused',
      error: /^debug_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'debug_o11_bpt_scope_failed', valuesReturned: false };
  }
  const rows = Array.isArray(traceRows) ? traceRows : null;
  return { coverageSource: plan.coverageSource, authority: plan.authority,
    roots: plan.roots.map(r => ({ name: r.path, category: r.category, ownerKey: r.ownerKey, functionKey: r.functionKey, state: r.coverage.state, traced: r.traced,
      ...(rows ? { automaticTrace: automaticTrace(rows, r) } : {}) })),
    redactedRoots: plan.redacted, nativeUnavailableRoots: plan.unavailable, incompleteRoots: plan.incomplete, missingScopes: plan.missingScopes,
    unreadNodeScopes: plan.unreadNodeScopes, omittedRoots: plan.omitted, valuesComplete: reason ? false : plan.valuesComplete,
    ...(reason ? { reason } : {}), valuesReturned: false };
}

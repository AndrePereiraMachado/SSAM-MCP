// Deterministic entry resolution for the ODC native-entry debugger.
//
// Given a target action, the CODE (never the model) chooses the nearest PUBLIC (externally invocable) entry that
// reaches it. A private action with no public entry is dead code and is refused. The algorithm is a breadth-first
// search over callers: distance = number of call edges from the entry down to the target. Ties at the same distance
// are broken by a FIXED total order written here (entry-kind priority, then model key ascending), so the same model
// and target always yield the same entry. The result carries the chosen entry, its distance, the exact call path
// entry -> ... -> target, and the input binding of each entry input to a target input (direct / fixed / derived).
//
// The resolver is pure: it takes a `graph` object and a target key. The model adapter (debug-odc-native-extract.mjs)
// builds that graph from the published model reader; tests build it from fixtures. No names are used to admit an entry.

const fail = code => { throw new Error('debug_odc_native_' + code); };

// Entry kinds, most-preferred first. This order is the tie-break AFTER distance and is frozen: changing it changes
// which entry a model resolves to. A screen (its events/data actions reach actions with the real screen context) is
// preferred, then data actions, then the explicitly exposed callables, then background triggers.
export const ENTRY_KIND_ORDER = Object.freeze([
  'server-stub',       // original published client-to-server callable
  'screen',            // MobileScreen / WebScreen (a screen event or aggregate reaches the action)
  'screen-data-action',// DataAction owned by a screen
  'block-data-action', // DataAction owned by a block
  'client-action',     // public/exposed client action callable from outside
  'public-server-action',
  'service-action',
  'rest-method',
  'soap-method',
  'timer',
  'process',
]);
const KIND_RANK = new Map(ENTRY_KIND_ORDER.map((k, i) => [k, i]));

// Is this graph node an externally invocable entry, and of which kind? Returns null for an internal action that only
// matters as a step on the path. Decided purely from the node's declared shape, never its name.
// Consumed REST methods and REST callback flows run inside another request (the consumer's Execute or the exposed
// method's request): never entries, whatever a runtime index claims for their key.
const NEVER_ENTRY = new Set(['RestAction', 'RestServiceAuthenticationFlow', 'RestServiceCallbackActionFlow', 'RestCallbackActionFlow']);
export function entryKindOf(node) {
  if (NEVER_ENTRY.has(node.kind)) return null;
  if (['server-stub', 'screen-data-action', 'block-data-action', 'client-action'].includes(node.nativeEntryKind)) return node.nativeEntryKind;
  switch (node.kind) {
    case 'MobileScreen': case 'WebScreen': return 'screen';
    case 'DataAction': return node.ownerKind === 'MobileBlock' || node.ownerKind === 'WebBlock' ? 'block-data-action' : 'screen-data-action';
    case 'RestServiceAction': return 'rest-method';
    case 'SoapServiceAction': case 'SOAPServiceAction': return 'soap-method';
    case 'Timer': return 'timer';
    case 'Process': case 'ProcessFlow': return 'process';
    // Public means reusable by a consumer, not externally invocable. Only the
    // published runtime's nativeEntryKind above proves a direct callable.
    case 'ClientAction': case 'ServerAction': case 'ServiceAction': return null;
    default: return null;
  }
}

// Fixed total order for two candidate entries at equal distance: kind rank, then model key ascending (byte order of
// the base64 key string). Returns <0 if a should come before b.
export function compareEntries(a, b) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  const ra = KIND_RANK.get(a.entryKind) ?? 99, rb = KIND_RANK.get(b.entryKind) ?? 99;
  if (ra !== rb) return ra - rb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// graph.callers(key) -> [{ key, node, edge }]  where node is the caller element and edge describes the call node
//   (its path/kind, and for an ExecuteServerAction/ClientAction the argument bindings it passes).
// graph.node(key) -> the element { key, kind, public, ownerKind, roles, anonymous, authentication, inputs: [...] }
// graph.inputs(key) -> ordered input parameters of an action [{ name, key, dataType }]
//
// BFS from the target over callers. Every element visited at distance d whose entryKind is non-null is a candidate.
// Search continues through non-entry actions (and also past entries, since a closer caller could itself be an entry).
// The order the reader returns callers in never matters: callers are visited in (caller key, call-node path) order and
// each level in key order, so the parent link of every element (hence the call path and the bindings) is a function
// of the graph alone.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const callerOrder = (a, b) => byText(a.key, b.key) || byText(a.edge?.path ?? '', b.edge?.path ?? '');
function searchCallers(graph, targetKey, { maxDepth = 12, maxNodes = 2000 } = {}) {
  const seen = new Map([[targetKey, { distance: 0, from: null, edge: null }]]);
  const reached = new Map(); // entry key -> { entryKind, distance, node } (first = shortest distance)
  const target = graph.node(targetKey), ownKind = entryKindOf(target);
  if (ownKind) reached.set(targetKey, { key: targetKey, node: target, entryKind: ownKind, distance: 0 });
  let frontier = [targetKey];
  for (let distance = 1; frontier.length; distance++) {
    if (distance > maxDepth) fail('graph_depth_limit');
    const next = [];
    for (const key of frontier) {
      let callers;
      try { callers = [...graph.callers(key)].filter(c => c?.key && c.node).sort(callerOrder); } catch (error) { fail('graph_unreadable:' + (error.message ?? '')); }
      for (const caller of callers) {
        if (!seen.has(caller.key)) {
          if (seen.size >= maxNodes) fail('graph_node_limit');
          seen.set(caller.key, { distance, from: key, edge: caller.edge }); next.push(caller.key);
        }
        const entryKind = entryKindOf(caller.node);
        if (entryKind && !reached.has(caller.key)) reached.set(caller.key, { key: caller.key, node: caller.node, entryKind, distance: seen.get(caller.key).distance });
      }
    }
    frontier = next.sort(byText);
  }
  // The exact call path from an entry down to the target, rebuilt from the BFS parent links: [entry, ..., target].
  const pathOf = key => {
    const steps = []; let cursor = key;
    while (cursor != null) { const info = seen.get(cursor); steps.push({ key: cursor, kind: graph.node(cursor)?.kind ?? null, edge: info?.edge ?? null }); cursor = info?.from ?? null; }
    return steps;
  };
  return { reached, pathOf };
}
const pathView = path => path.map(step => ({ key: step.key, kind: step.kind, ...(step.edge ? { via: step.edge.path, callKind: step.edge.kind } : {}) }));
const entryView = (graph, candidate) => ({ ...describe(graph, candidate.key), entryKind: candidate.entryKind, distance: candidate.distance,
  roles: candidate.node.roles ?? null, anonymous: candidate.node.anonymous ?? null, authentication: candidate.node.authentication ?? null });

export function resolveEntry(graph, targetKey, options = {}) {
  if (!graph.node(targetKey)) fail('target_action_unknown');
  const { reached, pathOf } = searchCallers(graph, targetKey, options);
  const ranked = [...reached.values()].sort(compareEntries);
  const target = describe(graph, targetKey);
  if (!ranked.length) return { ok: false, deadCode: true, error: 'dead_code_no_public_entry', message: 'dead code: no public entry reaches ' + (target.name ?? targetKey), target };
  return resolveRanked(graph, target, ranked, pathOf);
}
function resolveRanked(graph, target, ranked, pathOf, eligibility = null) {
  const chosen = ranked[0], path = pathOf(chosen.key);
  return {
    ok: true, deadCode: false, algorithm: ALGORITHM + (eligibility ? '; eligibility=' + eligibility : ''),
    ...(eligibility ? { entryEligibility: eligibility } : {}), target, entry: entryView(graph, chosen),
    path: pathView(path), callPath: path.map(step => graph.node(step.key)?.name ?? step.key).join(' -> '),
    bindings: bindInputs(graph, path),
    alternatives: ranked.slice(1, 8).map(c => ({ ...describe(graph, c.key), entryKind: c.entryKind, distance: c.distance })),
  };
}
export const ALGORITHM = 'bfs-callers/v2 (self or caller distance, ENTRY_KIND_ORDER, model key ascending; complete graph required)';

const originalScreenCandidate = candidate => candidate.node.kind === 'ScreenAction' && candidate.entryKind === 'client-action' &&
  /(?:^|\/)(?:MobileScreen|WebScreen):/.test(candidate.node.path ?? '');

// Apply an eligibility constraint, keeping the existing distance/key order and
// complete original caller path. This is an automatic resolution, not an override.
export function resolveOriginalScreenEntry(graph, targetKey, options = {}) {
  if (!graph.node(targetKey)) fail('target_action_unknown');
  const { reached, pathOf } = searchCallers(graph, targetKey, options);
  const ranked = [...reached.values()].filter(originalScreenCandidate).sort(compareEntries), target = describe(graph, targetKey);
  if (!ranked.length) return { ok: false, error: 'debug_odc_native_original_screen_entry_required', target };
  return resolveRanked(graph, target, ranked, pathOf, 'original-screen-for-server-request/v1');
}

// A global function that sends a server request needs an original screen caller;
// copying the screen's security context while skipping that caller is not valid.
export function originalScreenEntries(graph, targetKey, options = {}) {
  return [...searchCallers(graph, targetKey, options).reached.values()]
    .filter(originalScreenCandidate)
    .sort(compareEntries).map(candidate => entryView(graph, candidate));
}

// An override entry (user-supplied) is accepted only when it is a verified caller on the graph that reaches the
// target and is itself an external entry. It never lets the LLM pick an entry the algorithm would not reach.
export function resolveOverride(graph, targetKey, overrideKey, options = {}) {
  if (/^@[A-Za-z0-9_+]{22}$/.test(overrideKey)) overrideKey = overrideKey.slice(1);
  const full = resolveEntry(graph, targetKey, options);
  if (!full.ok) return full;
  const { reached, pathOf } = searchCallers(graph, targetKey, options);
  const match = reached.get(overrideKey);
  if (!match) return { ok: false, error: 'entry_override_not_a_caller', requested: overrideKey, resolved: full.entry };
  const path = pathOf(overrideKey);
  return { ok: true, deadCode: false, overridden: true, algorithm: ALGORITHM, target: full.target, entry: entryView(graph, match),
    path: pathView(path), callPath: path.map(step => graph.node(step.key)?.name ?? step.key).join(' -> '),
    bindings: bindInputs(graph, path), deterministicEntry: full.entry };
}
function describe(graph, key) {
  const node = graph.node(key);
  return { key, kind: node?.kind ?? null, name: node?.name ?? null, public: node?.public ?? null, path: node?.path ?? null };
}

// Input binding: which of the entry's inputs the target inputs are controlled by. The path carries, per call edge,
// the argument expressions the caller passes. An argument that is exactly the entry input (or a chain of such) is a
// direct binding; a literal/constant is fixed; anything else is derived (the debugger cannot set it from the entry).
export function bindInputs(graph, path) {
  // path is [entry, ..., target]; walk from the target UP, carrying for each target input the expression that feeds it.
  let current = null;
  const targetKey = path.at(-1).key;
  try { current = graph.inputs(targetKey).map(input => ({ target: input, source: { kind: 'input', name: input.name } })); }
  catch { fail('input_signature_unreadable'); }
  // path[i].edge is the call from path[i] INTO path[i+1] (BFS parent links, rebuilt entry-first). Walking up from the
  // target, the edge feeding path[i] comes from its caller path[i-1], i.e. path[i-1].edge.
  for (let i = path.length - 1; i >= 1; i--) {
    const edge = path[i - 1].edge; // the call from path[i-1] into path[i]
    if (!edge?.arguments) { // no argument map on this edge (e.g. a screen owning its action): cannot trace further
      current = current.map(row => ({ target: row.target, source: ['input', 'entry-input'].includes(row.source?.kind) ? { kind: 'opaque' } : row.source }));
      continue;
    }
    const argByParam = new Map(edge.arguments.filter(a => a.parameter != null).map(a => [a.parameter, a]));
    current = current.map(row => {
      if (row.source?.kind !== 'input') return row;
      const parameter = graph.inputs(path[i].key).find(p => p.name === row.source.name);
      // A bare caller local (for example a native GetUserId assignment) is not
      // an input of that caller. Preserve its derivation when walking through
      // an outer ScreenAction instead of turning it into an omitted default.
      if (!parameter) return { target: row.target, source: { kind: 'derived', expression: row.source.name } };
      const arg = argByParam.get(parameter?.key) ?? argByParam.get(row.source.name) ?? edge.arguments.find(a => a.parameterName === row.source.name);
      if (!arg) return { target: row.target, source: { kind: 'default' } };
      return { target: row.target, source: classifyArgument(arg) };
    });
  }
  const entryInputs = (() => { try { return graph.inputs(path[0].key).map(i => i.name); } catch { return []; } })();
  return current.map(row => ({
    targetInput: row.target.name, targetKey: row.target.key ?? null, dataType: row.target.dataType ?? null,
    ...(row.target.identifierBase ? { identifierBase: row.target.identifierBase } : {}),
    control: row.source.kind === 'input' && entryInputs.includes(row.source.name) ? 'direct'
      : row.source.kind === 'constant' ? 'fixed' : row.source.kind === 'default' ? 'default'
      : row.source.kind === 'opaque' ? 'opaque' : 'derived',
    ...(row.source.name ? { entryInput: row.source.name } : {}), ...(row.source.expression ? { expression: row.source.expression } : {}),
  }));
}

// An argument expression into a called action: a bare entry input name -> entry-input; a literal -> constant;
// anything else (function call, member access, operator) -> derived.
function classifyArgument(arg) {
  const value = (arg.value ?? '').trim();
  if (/^(true|false)$/i.test(value)) return { kind: 'constant', expression: value };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return { kind: 'input', name: value };
  if (/^(?:-?\d+(?:\.\d+)?|"(?:[^"]|"")*"|'[^']*'|#[^#]*#)$/.test(value) || value === '') return { kind: 'constant', expression: value };
  return { kind: 'derived', expression: value };
}

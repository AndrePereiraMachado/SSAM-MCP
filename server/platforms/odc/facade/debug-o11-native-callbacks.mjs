// Runner-derived breakpoint scopes for O11 platform callbacks of REST/SOAP integrations.
//
// The graph (debug-o11-entry-graph.mjs) holds 'native-callback' edges taken by key from the
// published capture: exposed RestServiceAction -> OnAuthentication/OnRequest/OnResponse, and the
// Execute of a consumed REST/SOAP method -> OnBeforeRequest(/Advanced)/OnAfterResponse. Only
// callbacks reachable from the runner's resolved entry, in the runner's own module and with a
// read start node, become scopes. A caller may never name a callback the runner did not derive.
import { NATIVE_CALLBACKS } from './debug-o11-entry-graph.mjs';
import { actionModel, scopeRoots } from './debug-wrapper.mjs'; // pure model helpers only

const KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error('debug_o11_native_callback_' + code); };
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isCallback = node => Object.hasOwn(NATIVE_CALLBACKS, node?.kind ?? '');

export function deriveO11CallbackScopes(graph, resolution, { moduleKey, max = 10 } = {}) {
  if (!KEY.test(moduleKey ?? '') || !graph?.nodes?.has(resolution?.entry?.id)) fail('resolution_required');
  // Synchronous callees of the entry: the callbacks the original request can run.
  const seen = new Set(), pending = [resolution.entry.id];
  for (let i = 0; i < pending.length; i++) {
    if (seen.has(pending[i])) continue; seen.add(pending[i]);
    for (const edge of graph.callees.get(pending[i]) ?? []) if (!edge.via.asynchronous) pending.push(edge.to);
  }
  const scopes = [], excluded = [];
  for (const node of [...seen].map(id => graph.nodes.get(id)).filter(isCallback).sort((a, b) => cmp(a.id, b.id))) {
    const edge = graph.edges.find(e => e.to === node.id && e.via.kind === 'native-callback' && seen.has(e.from));
    if (!edge) continue;
    const base = { moduleKey: node.moduleKey, functionKey: node.key, callback: edge.via.callback, kind: node.kind };
    const reason = node.moduleKey !== moduleKey ? 'cross_module_callback'
      : !KEY.test(node.key ?? '') || node.id !== moduleKey + '*' + node.key ? 'callback_key_unresolved'
      : !KEY.test(node.startNodeKey ?? '') ? 'callback_start_node_unread' : scopes.length >= max ? 'callback_scope_limit' : null;
    if (reason) excluded.push({ ...base, reason });
    else scopes.push({ ...base, nodeKeys: [node.startNodeKey], source: 'runner-derived', via: edge.from });
  }
  return { schema: 'ssam-o11-callback-scopes/1', moduleKey, entryId: resolution.entry.id, scopes, excluded };
}

// Every callback function of the graph as '<moduleKey>:<key>' (for a session that holds no graph).
export const o11CallbackFunctionKeys = graph => [...graph.nodes.values()].filter(isCallback).map(n => n.moduleKey + ':' + n.key).sort();

// Caller scopes plus the runner-derived callbacks. A caller scope naming any callback function of
// the graph (another service, another module, or a node the runner did not derive) is refused.
// modules: the module keys whose published capture was read (default: the graph's modules, or the
// runner module plus the modules of callbackKeys); a scope of any other module cannot be checked
// for callbacks and is refused. A caller-side `callback` label is accepted only on a derived callback.
export function admitO11CallbackScopes({ requested = [], derived, graph, callbackKeys, modules, moduleKey }) {
  const scopes = derived?.scopes ?? [];
  if (!KEY.test(moduleKey ?? '') || derived?.moduleKey !== undefined && derived.moduleKey !== moduleKey || !graph && !Array.isArray(callbackKeys) ||
      !Array.isArray(requested) || modules !== undefined && !Array.isArray(modules) ||
      scopes.some(s => s.source !== 'runner-derived' || s.moduleKey !== moduleKey || !KEY.test(s.functionKey ?? '') ||
        !Array.isArray(s.nodeKeys) || !s.nodeKeys.length || !s.nodeKeys.every(k => KEY.test(k)))) fail('scope_not_derived');
  const callbacks = new Set(graph ? o11CallbackFunctionKeys(graph) : callbackKeys);
  const read = new Set(modules ?? (graph ? [...graph.nodes.values()].map(n => n.moduleKey).filter(Boolean) : [...callbacks].map(c => c.split(':')[0])));
  read.add(moduleKey);
  const same = (a, b) => (a.moduleKey ?? moduleKey) === b.moduleKey && a.functionKey === b.functionKey;
  for (const scope of requested) {
    if (!read.has(scope?.moduleKey ?? moduleKey)) fail('scope_not_derived');
    const labelled = scope.callback !== undefined;
    if (!labelled && !callbacks.has((scope.moduleKey ?? moduleKey) + ':' + scope.functionKey)) continue;
    const match = scopes.find(d => same(scope, d));
    if (!match || !Array.isArray(scope.nodeKeys) || !scope.nodeKeys.length || !scope.nodeKeys.every(k => match.nodeKeys.includes(k)) ||
        labelled && scope.callback !== match.callback && !(scope.callback?.name === match.callback && scope.callback?.kind === match.kind)) fail('scope_not_derived');
  }
  return [...requested, ...scopes.filter(d => !requested.some(scope => same(scope, d)))
    .map(({ moduleKey: owner, functionKey, nodeKeys, callback, kind, source }) => ({ moduleKey: owner, functionKey, nodeKeys: [...nodeKeys], callback, kind, source }))];
}

// Server trace plan with the derived callback start nodes as extra breakpoints. Scope roots are added
// only from a read callback model (full mode); an unread callback keeps its breakpoint without roots.
export function withO11CallbackTrace(server, derived, { mode = 'none', readings = [] } = {}) {
  const out = { ...server, nodeKeys: [...(server.nodeKeys ?? [])], scopes: { ...(server.scopes ?? {}) }, callbacks: [] };
  for (const scope of derived?.scopes ?? []) {
    if (scope.source !== 'runner-derived' || scope.moduleKey !== server.moduleKey) continue;
    for (const key of scope.nodeKeys) if (!out.nodeKeys.includes(key)) out.nodeKeys.push(key);
    out.callbacks.push({ callback: scope.callback, kind: scope.kind, functionKey: scope.functionKey, startNodeKey: scope.nodeKeys[0] });
    if (mode !== 'full') continue;
    const tree = readings.map(r => r?.tree ?? r).find(t => t?.key === scope.functionKey && t.kind === scope.kind);
    // Callback parameters have their own model kinds (<Flow>Input/<Flow>Output).
    if (tree) out.scopes[scope.functionKey] = scopeRoots(actionModel({ ...tree, children: (tree.children ?? []).map(c =>
      /Flow(?:Input|Output)(?:Signature)?$/.test(c.kind) ? { ...c, kind: /Output/.test(c.kind) ? 'OutputParameter' : 'InputParameter' } : c) }));
  }
  return out;
}

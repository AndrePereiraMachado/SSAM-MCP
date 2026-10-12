// Build the static call graph of a published ODC model for the deterministic entry resolver.
// It wraps the lane reader (the same `usages` + `properties` projections used by ssam_map / inspect) behind the
// { node, inputs, callers } interface resolveEntry expects. Every caller is a real reference in the published model;
// no name is used. The graph is lazy and cached, so BFS reads only the slice of the model it needs.
//
// readers:
//   usages(key)        -> [{ consumer: { kind, key, path } }]   (direct callers of the element with this key)
//   properties(path)   -> { key, kind, public, properties }     (an element's own properties)
//   inputs(path)       -> [{ name, key, dataType }]              (ordered input parameters)
//   argumentsOf(nodePath) -> [{ parameterName, value }]         (arguments a call node passes), optional

const kindOf = segment => (segment ?? '').split(':')[0];
const CALL_NODE = /^Execute\w*ActionNode$/;
const MEMBER = /^(ScreenAction|Preparation|DataAction|Aggregate|UILifeCycleEvent)$/;
const INSTANCE = /^(MobileBlockInstanceWidget|WebBlockInstanceWidget)$/;
function callerLocation(consumer) {
  return consumer.kind === 'Timer' ? { containerPath: consumer.path, containerKind: 'Timer' } : containerOf(consumer.path);
}

// From a call-node path, the innermost action/flow CONTAINER that holds it, and the owning screen/block if any.
// e.g. MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty/ExecuteServerActionNode:GetProperty
//   -> container MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty, owner the MobileScreen.
export function containerOf(nodePath) {
  const parts = (nodePath ?? '').split('/');
  const parentParts = parts.slice(0, -1);
  const screenAt = parentParts.map(kindOf).findIndex(k => /^(MobileScreen|WebScreen)$/.test(k));
  const blockAt = parentParts.map(kindOf).findIndex(k => /^(MobileBlock|WebBlock)$/.test(k));
  const ownerAt = screenAt >= 0 ? screenAt : blockAt;
  return {
    containerPath: parentParts.join('/'), containerKind: kindOf(parentParts.at(-1)),
    ownerPath: ownerAt >= 0 ? parentParts.slice(0, ownerAt + 1).join('/') : null,
    ownerKind: ownerAt >= 0 ? kindOf(parentParts[ownerAt]) : null,
  };
}

export function buildModelGraph({ usages, properties, inputs, argumentsOf } = {}) {
  if (typeof usages !== 'function' || typeof properties !== 'function') throw new Error('debug_odc_native_graph_readers_missing');
  const nodeCache = new Map(), inputCache = new Map(), callerCache = new Map();
  const propsByKey = new Map(); // key -> {path, props}

  const readProps = path => properties(path);
  function nodeByPath(path) {
    if (!path) return null;
    const props = readProps(path);
    if (!props?.key) return null;
    const kind = props.kind ?? kindOf(path.split('/').at(-1));
    const owner = kind === 'DataAction' ? containerOfElement(path) : null;
    const node = { key: props.key, kind, name: props.properties?.Name ?? path.split('/').at(-1).split(':').slice(1).join(':') ?? null,
      path, public: props.public === true || props.properties?.Public === 'True', nativeEntryKind: props.nativeEntryKind ?? null,
      ownerKind: owner?.ownerKind ?? null, ownerKey: owner?.ownerKey ?? null,
      roles: parseRoles(props.properties?.Roles), anonymous: props.properties?.AnonymousAccess === 'True',
      authentication: props.properties?.Authentication ?? null };
    nodeCache.set(props.key, node); propsByKey.set(props.key, { path, props });
    return node;
  }
  // DataAction owner: the screen/block whose path prefixes the data action's path.
  function containerOfElement(path) {
    const parts = path.split('/'), ownerAt = parts.map(kindOf).findIndex(k => /^(MobileScreen|WebScreen|MobileBlock|WebBlock)$/.test(k));
    if (ownerAt < 0) return null;
    const ownerPath = parts.slice(0, ownerAt + 1).join('/'), props = readProps(ownerPath);
    return props?.key ? { ownerKind: kindOf(parts[ownerAt]), ownerKey: props.key, ownerPath } : null;
  }

  function node(key) {
    if (nodeCache.has(key)) return nodeCache.get(key);
    return null; // only known once discovered through a path (callers populate it)
  }

  function callers(calleeKey) {
    if (callerCache.has(calleeKey)) return callerCache.get(calleeKey);
    const list = [];
    const callee = node(calleeKey), owned = callee?.path && containerOf(callee.path + '/_');
    if (MEMBER.test(callee?.kind) && owned?.ownerPath && owned.ownerPath !== callee.path) {
      const owner = nodeByPath(owned.ownerPath);
      if (owner) list.push({ key: owner.key, node: owner, edge: { path: callee.path, kind: 'OwnedBy', arguments: null } });
    }
    for (const usage of usages(calleeKey) ?? []) {
      const consumer = usage.consumer; if (!consumer?.path) continue;
      if (!CALL_NODE.test(consumer.kind) && !INSTANCE.test(consumer.kind) && consumer.kind !== 'DataAction' && consumer.kind !== 'Timer') continue;
      const where = callerLocation(consumer);
      const container = nodeByPath(INSTANCE.test(consumer.kind) ? where.ownerPath : where.containerPath);
      if (!container) continue;
      const edge = { path: consumer.path, kind: consumer.kind,
        arguments: typeof argumentsOf === 'function' ? (argumentsOf(consumer.path) ?? null) : null };
      list.push({ key: container.key, node: container, edge });
    }
    callerCache.set(calleeKey, list);
    return list;
  }

  function actionInputs(key) {
    if (inputCache.has(key)) return inputCache.get(key);
    const path = propsByKey.get(key)?.path;
    const list = (typeof inputs === 'function' && path) ? (inputs(path) ?? []) : [];
    inputCache.set(key, list);
    return list;
  }

  // Seed the target node from its path so node(targetKey) is known before BFS.
  return { node, inputs: actionInputs, callers, seed: path => nodeByPath(path) };
}

// Live readers are async (Portal/reader), but the deterministic resolver is a pure synchronous function so its result
// never depends on timing. This prefetches the whole reachable caller graph of the target with the async readers,
// into plain maps, and returns a SYNCHRONOUS graph over them that resolveEntry/resolveOverride consume unchanged.
export async function materializeGraph({ usages, properties, inputs, argumentsOf }, targetPath, { maxDepth = 12, maxNodes = 4000 } = {}) {
  const nodesByKey = new Map(), nodesByPath = new Map(), inputsByKey = new Map(), callersByKey = new Map();
  const propsOf = async p => { if (nodesByPath.has(p)) return nodesByPath.get(p); const v = await properties(p); nodesByPath.set(p, v); return v; };
  async function elementAt(p) {
    if (!p) return null;
    const props = await propsOf(p); if (!props?.key) return null;
    const kind = props.kind ?? (p.split('/').at(-1).split(':')[0]);
    let ownerKind = null, ownerKey = null;
    if (kind === 'DataAction') {
      const parts = p.split('/'), oa = parts.map(s => s.split(':')[0]).findIndex(k => /^(MobileScreen|WebScreen|MobileBlock|WebBlock)$/.test(k));
      if (oa >= 0) { const op = await propsOf(parts.slice(0, oa + 1).join('/')); if (op?.key) { ownerKind = parts[oa].split(':')[0]; ownerKey = op.key; } }
    }
    const node = { key: props.key, kind, name: props.properties?.Name ?? p.split('/').at(-1).split(':').slice(1).join(':'), path: p,
      public: props.public === true || props.properties?.Public === 'True', nativeEntryKind: props.nativeEntryKind ?? null, ownerKind, ownerKey,
      roles: parseRoles(props.properties?.Roles), anonymous: props.properties?.AnonymousAccess === 'True', authentication: props.properties?.Authentication ?? null };
    nodesByKey.set(node.key, node);
    if (typeof inputs === 'function') inputsByKey.set(node.key, (await inputs(p)) ?? []);
    return node;
  }
  const target = await elementAt(targetPath);
  if (!target) throw new Error('debug_odc_native_target_unreadable');
  const seen = new Set([target.key]); let frontier = [target.key];
  for (let depth = 1; frontier.length; depth++) {
    if (depth > maxDepth) throw new Error('debug_odc_native_graph_depth_limit');
    const next = [];
    for (const key of frontier) {
      const list = [];
      const callee = nodesByKey.get(key), owned = containerOf(callee.path + '/_');
      if (MEMBER.test(callee.kind) && owned.ownerPath && owned.ownerPath !== callee.path) {
        const owner = await elementAt(owned.ownerPath);
        if (owner) list.push({ key: owner.key, node: owner, edge: { path: callee.path, kind: 'OwnedBy', arguments: null } });
      }
      for (const usage of (await usages(key)) ?? []) {
        const consumer = usage.consumer; if (!consumer?.path) continue;
        if (!CALL_NODE.test(consumer.kind) && !INSTANCE.test(consumer.kind) && consumer.kind !== 'DataAction' && consumer.kind !== 'Timer') continue;
        const where = callerLocation(consumer), container = await elementAt(INSTANCE.test(consumer.kind) ? where.ownerPath : where.containerPath);
        if (!container) continue;
        const edge = { path: consumer.path, kind: consumer.kind, arguments: typeof argumentsOf === 'function' ? ((await argumentsOf(consumer.path)) ?? null) : null };
        list.push({ key: container.key, node: container, edge });
      }
      callersByKey.set(key, list);
      for (const caller of list) if (!seen.has(caller.key)) {
        if (seen.size >= maxNodes) throw new Error('debug_odc_native_graph_node_limit');
        seen.add(caller.key); next.push(caller.key);
      }
    }
    frontier = next;
  }
  return { node: key => nodesByKey.get(key) ?? null, inputs: key => inputsByKey.get(key) ?? [],
    callers: key => callersByKey.get(key) ?? [], seed: () => target, target };
}

export function parseRoles(text) {
  if (!text || typeof text !== 'string') return [];
  return [...text.matchAll(/(?:AppRole|Role):([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
}

// ---- REST platform callbacks (published RESTService/REST plugin kinds of the ODC model) ----
// They run inside the request of their exposed RestServiceAction (OnAuthentication for Basic/Custom, OnRequest,
// OnResponse) or of the Execute of a consumed RestAction (OnBeforeRequest(/Advanced), OnAfterResponse(/Advanced)).
// They are never entries; the runner derives them by key from the published model, never from a caller.
export const ODC_NATIVE_CALLBACKS = Object.freeze({ RestServiceAuthenticationFlow: ['OnAuthentication'],
  RestServiceCallbackActionFlow: ['OnRequest', 'OnResponse'],
  RestCallbackActionFlow: ['OnBeforeRequest', 'OnBeforeRequestAdvanced', 'OnAfterResponse', 'OnAfterResponseAdvanced'] });
const CALLBACK_OWNER = { RestServiceAuthenticationFlow: 'RestService', RestServiceCallbackActionFlow: 'RestService', RestCallbackActionFlow: 'RestClient' };
const KEY = /^[A-Za-z0-9_+]{22}$/;
const callbackFail = code => { throw new Error('debug_odc_native_callback_' + code); };
const parentOf = p => typeof p === 'string' && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
const byKey = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// read(selector) -> element { key, kind, name, path, properties, children } (the reader's `properties` projection:
// the element with its children and their Start nodes). entry: the resolved entry; calls: the entry's closure calls.
export async function odcCallbackEdges(read, { entry, calls = [] } = {}) {
  const owners = [];
  if (entry?.kind === 'RestServiceAction' && KEY.test(entry.key ?? '') && parentOf(entry.path))
    owners.push({ from: entry.key, path: parentOf(entry.path), kind: 'RestService', consumed: false });
  // Same-module consumed methods only: a producer (Reference) method's callbacks run in its own module.
  for (const call of calls) if (call?.actionKind === 'RestAction' && call.external !== true && !call.producer && KEY.test(call.actionKey ?? '')) {
    if (owners.some(o => o.consumed && o.from === call.actionKey)) continue;
    const method = await read('@' + call.actionKey);
    if (method?.kind !== 'RestAction' || method.key !== call.actionKey || !parentOf(method.path)) callbackFail('integration_unresolved');
    owners.push({ from: method.key, path: parentOf(method.path), kind: 'RestClient', consumed: true });
  }
  const edges = [];
  for (const owner of owners) {
    const integration = await read(owner.path);
    if (integration?.kind !== owner.kind || !KEY.test(integration.key ?? '') || !Array.isArray(integration.children)) callbackFail('integration_unresolved');
    for (const flow of integration.children) {
      const names = ODC_NATIVE_CALLBACKS[flow?.kind];
      if (!names || CALLBACK_OWNER[flow.kind] !== owner.kind) continue;
      const callback = names.includes(flow.name) ? flow.name : names.includes(flow.properties?.CallbackType) ? flow.properties.CallbackType : null;
      if (!callback) continue;
      if (flow.kind === 'RestServiceAuthenticationFlow' &&
          !['Basic', 'Custom'].includes(integration.properties?.Authentication ?? flow.properties?.AuthenticationCallbackType)) continue;
      // An unset callback has no Start node: nothing runs, no edge. A paged projection is re-read, never assumed unset.
      const own = flow.childrenOmitted || !Array.isArray(flow.children) ? await read('@' + flow.key) : flow;
      const startNodeKey = (own?.children ?? []).find(c => c?.kind === 'StartNode')?.key ?? null;
      if (!startNodeKey) continue;
      edges.push({ from: owner.from, to: flow.key, kind: 'native-callback', callback, callbackKind: flow.kind, startNodeKey,
        integrationKey: integration.key, integrationKind: owner.kind, integrationPath: owner.path, path: flow.path ?? null, consumed: owner.consumed,
        ...(owner.consumed ? { baseURL: typeof integration.properties?.BaseURL === 'string' ? integration.properties.BaseURL : null } : {}) });
    }
  }
  return edges.sort((a, b) => byKey(a.from, b.from) || byKey(a.to, b.to));
}

// Breakpoint scopes for the derived callbacks: same module (flow path directly under its integration, no Reference),
// a readable key and Start node; at most `max`. Anything else is excluded with a reason, never guessed.
export function deriveOdcCallbackScopes(edges, { moduleKey, max = 10 } = {}) {
  if (!KEY.test(moduleKey ?? '')) callbackFail('module_required');
  const scopes = [], excluded = [], seen = new Set();
  for (const edge of [...(edges ?? [])].sort((a, b) => byKey(String(a.to), String(b.to)) || byKey(a.from, b.from))) {
    if (seen.has(edge.to)) continue; seen.add(edge.to);
    const base = { moduleKey, functionKey: edge.to, callback: edge.callback, kind: edge.callbackKind, via: edge.from,
      integrationKey: edge.integrationKey, consumed: edge.consumed === true, ...(edge.consumed ? { baseURL: edge.baseURL ?? null } : {}) };
    const reason = edge.path != null && (/^Reference:/.test(edge.path) || parentOf(edge.path) !== edge.integrationPath) ? 'cross_module_callback'
      : !KEY.test(edge.to ?? '') ? 'callback_key_unresolved' : !KEY.test(edge.startNodeKey ?? '') ? 'callback_start_node_unread'
      : scopes.length >= max ? 'callback_scope_limit' : null;
    if (reason) excluded.push({ ...base, reason });
    else scopes.push({ ...base, nodeKeys: [edge.startNodeKey], source: 'runner-derived' });
  }
  return { schema: 'ssam-odc-callback-scopes/1', moduleKey, scopes, excluded };
}

// Every callback flow of the module as '<moduleKey>:<key>' (the coordinator refuses a caller scope naming one that
// the runner did not derive). list(kind) is the reader's complete local inventory; edges add what was read here.
export async function odcCallbackFunctionKeys({ list, edges = [], moduleKey }) {
  const keys = new Set(edges.map(e => e.to).filter(k => KEY.test(k ?? '')));
  if (typeof list === 'function') for (const kind of Object.keys(ODC_NATIVE_CALLBACKS))
    for (const entry of (await list(kind)) ?? []) if (KEY.test(entry?.key ?? '')) keys.add(entry.key);
  return [...keys].sort().map(key => moduleKey + ':' + key);
}

// Runner plan: derived scopes, the module's callback inventory and the typed refusal for a consumed callback whose
// RestClient does not target the binding's own runtime origin, or whose external-http effect is not acknowledged.
export async function planOdcCallbackScopes({ read, list }, { entry, calls = [], binding, acknowledgeEffects = [] }) {
  const edges = await odcCallbackEdges(read, { entry, calls });
  const derived = deriveOdcCallbackScopes(edges, { moduleKey: binding?.moduleKey });
  const callbackKeys = await odcCallbackFunctionKeys({ list, edges, moduleKey: binding.moduleKey });
  let own = null; try { own = new URL(binding.runtimeUrl).origin; } catch { /* refused below */ }
  const consumed = derived.scopes.filter(s => s.consumed);
  for (const scope of consumed) {
    let origin = null; try { origin = new URL(scope.baseURL).origin; } catch { /* not an absolute URL */ }
    if (!own || origin !== own) return { derived, callbackKeys, refusal: { state: 'callback-unqualified', error: 'debug_odc_native_consumed_callback_foreign_origin',
      integrationKey: scope.integrationKey, functionKey: scope.functionKey, origin: origin && origin !== 'null' ? origin : null, runtimeOrigin: own } };
  }
  if (consumed.length && !acknowledgeEffects.includes('external-http'))
    return { derived, callbackKeys, refusal: { state: 'effects-not-acknowledged', missing: ['external-http'],
      message: 'run may cause external-http; pass acknowledgeEffects with these classes to run in DEV' } };
  return { derived, callbackKeys, refusal: null };
}

// A trace target naming a callback function the runner did not derive (another service, another client, a node
// outside the entry's request) is refused.
export function assertOdcCallbackScopesDerived(target, derived, callbackKeys, moduleKey) {
  const inventory = new Set(callbackKeys), allowed = new Set((derived?.scopes ?? []).map(s => s.functionKey));
  for (const functionKey of new Set([target?.actionKey, ...Object.keys(target?.scopes ?? {})].filter(Boolean)))
    if (inventory.has(moduleKey + ':' + functionKey) && !allowed.has(functionKey)) callbackFail('scope_not_derived');
}

// Trace plan with the derived callback Start nodes as extra breakpoints. Scope roots come only from the read callback
// flow (full mode); its <Flow>Input/Output parameters count as inputs/outputs.
export async function withOdcCallbackTrace(target, derived, { mode = 'none', read, actionModel, scopeRoots } = {}) {
  const out = { ...target, nodeKeys: [...(target.nodeKeys ?? [])], scopes: { ...(target.scopes ?? {}) } }, callbacks = [];
  for (const scope of derived?.scopes ?? []) {
    if (scope.source !== 'runner-derived') continue;
    for (const key of scope.nodeKeys) if (!out.nodeKeys.includes(key)) out.nodeKeys.push(key);
    callbacks.push({ callback: scope.callback, kind: scope.kind, functionKey: scope.functionKey, startNodeKey: scope.nodeKeys[0], consumed: scope.consumed });
    if (mode !== 'full' || typeof read !== 'function' || typeof actionModel !== 'function') continue;
    const tree = await read('@' + scope.functionKey);
    if (tree?.key !== scope.functionKey || tree.kind !== scope.kind) continue;
    out.scopes[scope.functionKey] = scopeRoots(actionModel({ ...tree, children: (tree.children ?? []).map(c =>
      /Flow(?:Input|Output)(?:Signature)?$/.test(c.kind ?? '') ? { ...c, kind: /Output/.test(c.kind) ? 'OutputParameter' : 'InputParameter' } : c) }));
  }
  return { target: out, callbacks };
}

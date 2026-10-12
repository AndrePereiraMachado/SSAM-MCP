// Deterministic entry resolution for the O11 native-entry debugger.
//
// The user's rule: a private action with no public entry is dead code; every action that matters is reached from an
// existing entry of the published app. So the debugger never asks the model (LLM) which entry to use: it builds the
// static call graph of the PUBLISHED model (ssam-reading/1 trees of the published capture) and the PUBLISHED Reactive
// assets (AMD controllers), then picks the nearest externally invocable entry with one fixed algorithm:
//
//   1. Breadth-first search over CALLERS starting at the target; distance = number of call edges.
//   2. Candidates = invocable entries at the minimum distance.
//   3. Ties: ENTRY_PRIORITY (server-stub < data-action < client-action < rest-method), then sortKey ascending
//      (the model ObjectKey, or the screenservices endpoint for a stub), compared by UTF-16 code units.
//   4. The call path is rebuilt forward from the entry, choosing at each step the callee one step closer to the
//      target with the smallest sortKey. Same graph + same target => same entry, same path, same bindings.
//
// Answers: resolved | dead-code ("dead code: no public entry reaches <action>") | no-invocable-entry (reached only
// by a timer/process) | public-without-consumer (public action, no consumer in the modules given) | target-not-found
// | target-ambiguous. An explicit `entry` is only an override: it must be an invocable caller on this graph.
import { createHash } from 'node:crypto';
import { nativeO11Process } from './debug-o11-bpt.mjs';
import { nativeO11Timer } from './debug-o11-timer.mjs';
import { o11SelectorMatches } from './debug-o11-selectors.mjs';
import { nativeBuiltin, nativeExpressionMap } from './debug-identity-witness.mjs';

export const ENTRY_PRIORITY = Object.freeze(['server-stub', 'data-action', 'client-action', 'rest-method', 'soap-method', 'traditional-preparation', 'traditional-screen-action']);
export const RUNNABLE_ENTRIES = Object.freeze(['server-stub', 'data-action', 'client-action']);
export const ALGORITHM = 'bfs-callers/v1 (distance, ENTRY_PRIORITY, sortKey)';
// Platform callback flows (published capture kinds). They run inside the request of their
// exposed RestServiceAction or of the Execute of a consumed REST/SOAP method; never entries.
export const NATIVE_CALLBACKS = Object.freeze({ RestServiceAuthenticationFlow: ['OnAuthentication'], RestServiceCallbackActionFlow: ['OnRequest', 'OnResponse'],
  RestCallbackActionFlow: ['OnBeforeRequest', 'OnBeforeRequestAdvanced', 'OnAfterResponse'], SOAPCallbackActionFlow: ['OnBeforeRequest', 'OnBeforeRequestAdvanced', 'OnAfterResponse'] });
const CALLBACK_KINDS = new Set(Object.keys(NATIVE_CALLBACKS)), CONSUMED_KINDS = new Set(['RestAction', 'SOAPAction']);
const INTEGRATION_KINDS = new Set(['RestService', 'RestClient', 'SOAPClient']);
const ACTION_KINDS = new Set(['ServerAction', 'ServiceAction', 'ClientAction', 'ScreenAction', 'Preparation', 'DataAction', 'Timer', 'RestServiceAction',
  'RestAPIMethod', 'RestMethod', 'SoapServiceAction', 'SOAPServiceAction', 'WebServiceMethod', 'Process', 'ProcessFlow', 'AutomaticActivityNode', 'ProcessLaunchAction', 'TimerWakeAction',
  ...CALLBACK_KINDS]);
const SIGNATURE_KINDS = new Set(['ServerActionSignature', 'ServiceActionSignature', 'ClientActionSignature']);
const SERVER_KINDS = new Set(['ServerAction', 'ServiceAction', 'ServerActionSignature', 'ServiceActionSignature']);
const TARGET_KINDS = new Set(ACTION_KINDS);
const COMPONENT = /^(MobileScreen|MobileBlock|WebScreen|WebBlock)$/, FLOW = /^(MobileFlow|WebFlow|UIFlow)$/;
const KEY = /^[A-Za-z0-9_+]{22}$/;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Consumed REST/SOAP methods (RestAction/SOAPAction, IConsumedAction in the published capture) and
// callback flows are executed by the platform inside another request: never entries.
export const o11EntryKindOf = kind => entryKindOf(kind);
// Traditional (WebFlow) screen actions run on the server through the original form postback.
const TRADITIONAL_ACTION = /(?:^|\/)WebFlow:[^/]+\/Web(?:Screen|Block):[^/]+\/ScreenAction:[^/]+$/;
const parentPath = p => typeof p === 'string' && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
function entryKindOf(kind) {
  if (CONSUMED_KINDS.has(kind) || CALLBACK_KINDS.has(kind)) return null;
  if (kind === 'DataAction') return 'data-action';
  if (kind === 'ClientAction' || kind === 'ScreenAction') return 'client-action';
  if (['RestServiceAction', 'RestAPIMethod', 'RestMethod'].includes(kind)) return 'rest-method';
  if (['SoapServiceAction', 'SOAPServiceAction', 'WebServiceMethod'].includes(kind)) return 'soap-method';
  return null;
}
const entryOf = (kind, path) => kind === 'Preparation' && /(?:^|\/)WebScreen:/.test(path ?? '') ? 'traditional-preparation'
  : kind === 'ScreenAction' && TRADITIONAL_ACTION.test(path ?? '') ? 'traditional-screen-action' : entryKindOf(kind);
const livenessOf = kind => kind === 'Timer' ? 'timer' : ['Process', 'ProcessFlow', 'AutomaticActivityNode'].includes(kind) ? 'process' : null;

// "MobileFlow:Common/MobileBlock:UserInfo/DataAction:X" -> "Common.UserInfo"; module-level -> "@module".
export function ownerViewOf(path) {
  const segments = (path ?? '').split('/').map(s => { const i = s.indexOf(':'); return { kind: s.slice(0, i), name: s.slice(i + 1) }; });
  const flow = segments.find(s => FLOW.test(s.kind)), component = segments.find(s => COMPONENT.test(s.kind));
  return flow && component ? flow.name + '.' + component.name : '@module';
}
const stubId = (moduleKey, owner, callee) => `stub:${moduleKey}:${owner}:${callee}`;
const stubEndpoint = (module, owner, callee) => `screenservices/${module}/${owner === '@module' ? '' : owner.replace('.', '/') + '/'}Action${callee}`;

// Base of an entity identifier from the reference type the model records on the parameter (EntityReferenceLongInteger |
// EntityReferenceInteger | EntityReferenceText). Producer signatures carry the same property. Anything else is unresolved.
export const o11IdentifierBase = type => /^EntityReference(LongInteger|Integer|Text)$/.exec(typeof type === 'string' ? type : '')?.[1] ?? null;
const parameterOf = c => ({ name: c.name, key: c.key, modelType: c.properties?.DataType ?? null,
  mandatory: c.properties?.IsMandatory === 'True', identifierBase: o11IdentifierBase(c.properties?.Type) });

function emptyGraph() { return { nodes: new Map(), edges: new Map(), aliases: new Map(), pending: [] }; }
function putNode(graph, node) {
  const current = graph.nodes.get(node.id);
  if (!current) { graph.nodes.set(node.id, { sources: [], inputs: [], outputs: [], ...node, sources: [...(node.sources ?? [])] }); return; }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'sources') { for (const s of v ?? []) if (!current.sources.includes(s)) current.sources.push(s); continue; }
    if (k === 'inputs' || k === 'outputs') { if (v?.length && (!current[k]?.length || node.sources?.includes('model'))) current[k] = v; continue; }
    if (k === 'abi') { current.abi = { ...(current.abi ?? {}), ...v }; continue; }
    if (v !== null && v !== undefined && (current[k] === null || current[k] === undefined)) current[k] = v;
  }
}
function putEdge(graph, edge) {
  const id = edge.from + '>' + edge.to;
  const current = graph.edges.get(id);
  // One edge per caller/callee pair: model (OutSystems expression) arguments win over the compiled JS ones.
  if (!current || (current.language !== 'os' && edge.language === 'os')) graph.edges.set(id, edge);
}

// ---- model side: ssam-reading/1 trees of the published capture ---------------------------------------------
// nativeBindings: model-only expression bindings of this capture (pinned by sourceSha256); an argument is 'identity'
// only when its published value is natively the original GetUserId() builtin.
export function graphFromReadings(readings, { module, moduleKey, sourceSha256 = null, nativeBindings = [] }) {
  if (!KEY.test(moduleKey ?? '') || !/^[A-Za-z_]\w*$/.test(module ?? '')) throw new Error('debug_o11_graph_module_invalid');
  const natives = new Map(), nativeOf = functionKey => {
    if (!natives.has(functionKey)) { const found = (Array.isArray(nativeBindings) ? nativeBindings : []).filter(b => b?.identity?.functionKey === functionKey);
      natives.set(functionKey, found.length === 1 ? nativeExpressionMap(found[0], { moduleKey, functionKey, sourceSha256 }) : null); }
    return natives.get(functionKey);
  };
  const graph = emptyGraph(), launches = new Map(), wakes = new Map();
  // Integration containers by path, their callback flows and exposed REST methods (bound by path).
  const integrations = new Map(), callbacks = [], exposed = [], renders = [];
  const visit = (node, container, integration = null) => {
    if (!node || typeof node !== 'object') return;
    let own = container, process = null, timer = null;
    if (node.kind === 'WebBlockInstanceWidget') renders.push({ key: node.key, owner: node.propertyReferences?.Owner, block: node.propertyReferences?.SourceBlock });
    if (INTEGRATION_KINDS.has(node.kind) && node.path) {
      integrations.set(node.path, { kind: node.kind, key: node.key ?? null, authentication: node.properties?.Authentication ?? null });
      integration = node.path;
    }
    if (node.kind === 'Process') {
      try { process = nativeO11Process(node); launches.set(process.launchActionKey, node.key); }
      catch (error) { process = { error: error.message, processKey: node.key }; }
    }
    if (launches.has(node.key)) node = { ...node, kind: 'ProcessLaunchAction' };
    if (node.kind === 'Timer') {
      try { timer = nativeO11Timer(node); wakes.set(timer.wakeActionKey, node.key); }
      catch (error) { timer = { error: error.message, timerKey: node.key }; }
    }
    if (wakes.has(node.key)) node = { ...node, kind: 'TimerWakeAction' };
    if (ACTION_KINDS.has(node.kind) || SIGNATURE_KINDS.has(node.kind)) {
      const id = node.properties?.GlobalKey && /\*/.test(node.properties.GlobalKey) && !SIGNATURE_KINDS.has(node.kind)
        ? node.properties.GlobalKey : moduleKey + '*' + node.key;
      const children = node.children ?? [];
      const inputs = children.filter(c => ['InputParameter', 'InputParameterSignature', 'RestServiceActionInput'].includes(c.kind)).map(parameterOf);
      const outputs = children.filter(c => ['OutputParameter', 'OutputParameterSignature', 'RestServiceActionOutput'].includes(c.kind)).map(parameterOf);
      const signature = SIGNATURE_KINDS.has(node.kind);
      const producer = signature ? /^Reference:([^/]+)\//.exec(node.path ?? '')?.[1] ?? null : null;
      putNode(graph, { id, module, moduleKey, key: node.key, kind: node.kind, name: node.name, path: node.path ?? null,
        owner: ownerViewOf(node.path), public: node.properties?.Public === 'True' || node.kind === 'ServiceAction',
        entry: signature ? null : entryOf(node.kind, node.path), liveness: livenessOf(node.kind), producer,
        startNodeKey: children.find(c => c.kind === 'StartNode')?.key ?? null, sortKey: node.key, inputs, outputs, sources: ['model'],
        ...(node.kind === 'AutomaticActivityNode' && container?.kind === 'Process' ? { processOwnerKey: container.key } : {}),
        ...(process ? { process } : {}), ...(timer ? { timer } : {}) });
      if (signature && /\*/.test(node.properties?.GlobalKey ?? '')) graph.aliases.set(id, node.properties.GlobalKey);
      own = graph.nodes.get(id);
      const owner = parentPath(node.path) ?? integration;
      if (CALLBACK_KINDS.has(node.kind)) callbacks.push({ id, kind: node.kind, owner, startNodeKey: own.startNodeKey,
        name: NATIVE_CALLBACKS[node.kind].includes(node.name) ? node.name : NATIVE_CALLBACKS[node.kind].includes(node.properties?.CallbackType) ? node.properties.CallbackType : null,
        authType: node.properties?.AuthenticationCallbackType ?? null });
      if (node.kind === 'RestServiceAction') exposed.push({ id, owner });
      if (node.kind === 'Timer' && node.propertyReferences?.Action?.key) graph.pending.push({ from: id, ref: node.propertyReferences.Action, via: { kind: 'timer' }, args: [] });
    }
    if (own && own.id !== container?.id) { /* entered a new container */ }
    if (own && /^Execute\w*Node$/.test(node.kind) && node.propertyReferences?.Action?.key) {
      const native = nativeOf(own.key);
      const args = (node.children ?? []).filter(c => c.kind === 'Argument').map(a => ({ parameter: a.propertyReferences?.Parameter?.name ?? null,
        parameterKey: a.propertyReferences?.Parameter?.key ?? null, expression: a.properties?.Value ?? '',
        identity: nativeBuiltin(native?.get(a.key + '.#Value')) ? 'native-builtin:GetUserId' : null }));
      graph.pending.push({ from: own.id, ref: node.propertyReferences.Action, via: { kind: 'execute', nodeKey: node.key, nodeName: node.name || null }, args });
    }
    if (own && /^Refresh\w*Node$/.test(node.kind))
      for (const ref of Object.values(node.propertyReferences ?? {})) if (ref?.kind === 'DataAction' && ref.key)
        graph.pending.push({ from: own.id, ref, via: { kind: 'refresh', nodeKey: node.key }, args: [] });
    for (const child of node.children ?? []) visit(child, own, integration);
    if (timer && !timer.error) putEdge(graph, { from: moduleKey + '*' + timer.wakeActionKey, to: moduleKey + '*' + node.key,
      via: { kind: 'timer-wake', asynchronous: true, timerKey: node.key }, language: 'native-timer', arguments: [] });
    if (process && !process.error) {
      const id = moduleKey + '*' + node.key;
      putEdge(graph, { from: moduleKey + '*' + process.launchActionKey, to: id,
        via: { kind: 'process-launch', asynchronous: true, processKey: node.key }, language: 'native-process', arguments: [] });
      for (const activity of process.activities.filter(a => a.reachable && !a.disabled))
        putEdge(graph, { from: id, to: moduleKey + '*' + activity.key,
          via: { kind: 'process-flow', asynchronous: true, processKey: node.key, flowPath: activity.flowPath }, language: 'native-process', arguments: [] });
    }
  };
  for (const reading of readings) visit(reading?.tree ?? reading, null);
  // Resolve pending model calls now that every container of this module is known.
  for (const p of graph.pending.splice(0)) {
    const caller = graph.nodes.get(p.from), ref = p.ref;
    const calleeId = moduleKey + '*' + ref.key;
    const calleeName = ref.name;
    if (!graph.nodes.has(calleeId)) putNode(graph, { id: calleeId, module, moduleKey, key: ref.key, kind: ref.kind, name: calleeName,
      path: ref.path ?? null, owner: ownerViewOf(ref.path), public: false, entry: SIGNATURE_KINDS.has(ref.kind) ? null : entryOf(ref.kind, ref.path),
      liveness: livenessOf(ref.kind), producer: /^Reference:([^/]+)\//.exec(ref.path ?? '')?.[1] ?? null, sortKey: ref.key, sources: ['model-reference'],
      ...(CONSUMED_KINDS.has(ref.kind) ? { integrationPath: ref.owner?.path ?? parentPath(ref.path) } : {}) });
    // A Traditional screen action runs on the server: its server calls are direct, no screenservices stub.
    if (['ClientAction', 'ScreenAction'].includes(caller.kind) && SERVER_KINDS.has(ref.kind) && caller.entry !== 'traditional-screen-action') {
      // A client action reaches a server action only through the compiled screenservices stub of its screen/block
      // (or of the module for module-level client actions). The stub is the externally invocable entry.
      const owner = caller.owner ?? '@module', id = stubId(moduleKey, owner, calleeName);
      putNode(graph, { id, module, moduleKey, key: null, kind: 'ServerActionStub', name: 'Action' + calleeName, path: null, owner,
        public: true, entry: 'server-stub', liveness: null, sortKey: stubEndpoint(module, owner, calleeName), calleeId, sources: ['model'] });
      putEdge(graph, { from: caller.id, to: id, via: p.via, language: 'os', arguments: p.args });
      putEdge(graph, { from: id, to: calleeId, via: { kind: 'stub' }, language: 'stub', arguments: [] });
    } else putEdge(graph, { from: caller.id, to: calleeId, via: p.via, language: 'os', arguments: p.args });
  }
  // Native callbacks, by key from the published capture: exposed RestServiceAction -> its RestService
  // OnAuthentication (Basic/Custom only) and set OnRequest/OnResponse; Execute of a consumed REST/SOAP
  // method -> that integration's set OnBeforeRequest(/Advanced)/OnAfterResponse. Unset flows (no start node) are skipped.
  const callback = (from, cb, integrationPath) => putEdge(graph, { from, to: cb.id, arguments: [], language: 'native-callback',
    via: { kind: 'native-callback', callback: cb.name, callbackKind: cb.kind, integrationKey: integrations.get(integrationPath)?.key ?? null } });
  const set = (cb, owner, kinds) => cb.owner && cb.owner === owner && kinds.includes(cb.kind) && cb.name && KEY.test(cb.startNodeKey ?? '');
  for (const action of exposed) for (const cb of callbacks.filter(c => set(c, action.owner, ['RestServiceAuthenticationFlow', 'RestServiceCallbackActionFlow']))) {
    if (cb.kind === 'RestServiceAuthenticationFlow' && !['Basic', 'Custom'].includes(integrations.get(action.owner)?.authentication ?? cb.authType)) continue;
    callback(action.id, cb, action.owner);
  }
  for (const method of [...graph.nodes.values()].filter(n => CONSUMED_KINDS.has(n.kind) && n.integrationPath))
    for (const cb of callbacks.filter(c => set(c, method.integrationPath, [method.kind === 'RestAction' ? 'RestCallbackActionFlow' : 'SOAPCallbackActionFlow'])))
      callback(method.id, cb, method.integrationPath);
  // Traditional rendering: a same-module WebBlockInstanceWidget runs its block's '<block>.#Preparation'
  // inside the request of its owner (screen or block) Preparation. Producer (Reference) blocks run in
  // their own module and get no edge. Edges between Preparations not read here are dropped at build.
  const local = ref => KEY.test(ref?.key ?? '') && typeof ref.path === 'string' && !/^Reference:/.test(ref.path);
  for (const r of renders) if (KEY.test(r.key ?? '') && local(r.owner) && /^Web(?:Screen|Block)$/.test(r.owner.kind) && local(r.block) && r.block.kind === 'WebBlock')
    putEdge(graph, { from: moduleKey + '*' + r.owner.key + '.#Preparation', to: moduleKey + '*' + r.block.key + '.#Preparation', arguments: [], language: 'native-render',
      via: { kind: 'block-render', instanceKey: r.key, blockKey: r.block.key } });
  return graph;
}

// ---- asset side: parsed AMD controllers (debug-o11-native-abi.mjs parseO11Assets) --------------------------
export function graphFromAssets(parsed, { moduleKey }) {
  const module = parsed.module, graph = emptyGraph();
  const byController = new Map();
  for (const s of parsed.stubs) {
    const id = stubId(moduleKey, s.owner, s.serverAction);
    putNode(graph, { id, module, moduleKey, key: null, kind: 'ServerActionStub', name: 'Action' + s.serverAction, path: null, owner: s.owner,
      public: true, entry: 'server-stub', liveness: null, sortKey: s.endpoint.replace(/^\/+/, ''),
      calleeName: s.serverAction, referenced: s.referenced, producerHint: s.producerHint,
      inputs: s.inputs.map(i => ({ name: i.name, dataType: i.dataType, param: i.param, mandatory: false })),
      outputs: s.outputs.map(o => ({ name: o.name, dataType: o.dataType, attribute: o.attribute })),
      abi: { kind: 'server-stub', controller: s.controller, owner: s.owner, method: s.method, endpoint: s.endpoint, apiVersion: s.apiVersion,
        params: s.params, inputs: s.inputs, outputs: s.outputs }, sources: ['asset'] });
    byController.set(s.controller + '#' + s.method, id);
  }
  for (const d of parsed.dataActions) {
    const id = d.moduleKey + '*' + d.key;
    putNode(graph, { id, module, moduleKey: d.moduleKey, key: d.key, kind: 'DataAction', name: d.name, path: null, owner: d.owner,
      public: false, entry: 'data-action', liveness: null, sortKey: d.key,
      abi: { kind: 'data-action', controller: d.controller, owner: d.owner, method: d.method, endpoint: d.endpoint, apiVersion: d.apiVersion,
        dataProperty: d.dataProperty }, sources: ['asset'] });
    byController.set(d.controller + '#' + d.method, id);
  }
  for (const c of parsed.clientActions) {
    const id = c.moduleKey + '*' + c.key;
    putNode(graph, { id, module, moduleKey: c.moduleKey, key: c.key, kind: 'ClientAction', name: c.name, path: null, owner: c.owner,
      public: false, entry: 'client-action', liveness: null, sortKey: c.key,
      inputs: c.inputs.map(i => ({ name: i.name, dataType: i.dataType, param: i.param, mandatory: i.mandatory })),
      outputs: c.outputs.map(o => ({ name: o.name, dataType: o.dataType, attribute: o.attribute })),
      abi: { kind: 'client-action', controller: c.controller, owner: c.owner, method: c.method, implementation: c.implementation,
        moduleLevel: c.moduleLevel, params: c.params, inputs: c.inputs, outputs: c.outputs, nodes: c.nodes }, sources: ['asset'] });
    byController.set((c.moduleLevel ? '@module' : c.controller) + '#' + c.method, id);
  }
  for (const c of parsed.clientActions) {
    const from = c.moduleKey + '*' + c.key;
    for (const call of c.calls) {
      const method = call.target + '$' + call.kind;
      let to = null;
      if (call.via === 'self') to = byController.get(c.controller + '#' + method) ?? (c.moduleLevel ? byController.get('@module#' + method) : null);
      else if (call.via === module + '.controller') to = byController.get('@module#' + method);
      if (!to && call.via === 'self' && call.kind === 'ServerAction' && c.moduleLevel) to = parsed.stubs.filter(s => s.owner === '@module' && s.method === method)
        .map(s => stubId(moduleKey, '@module', s.serverAction))[0] ?? null;
      if (!to) {
        to = `ext:${call.via ?? 'unknown'}:${method}`;
        putNode(graph, { id: to, module: null, moduleKey: null, key: null, kind: 'ExternalClientCall', name: method, path: null, owner: null,
          public: false, entry: null, liveness: null, sortKey: to, sources: ['asset'] });
      }
      putEdge(graph, { from, to, via: { kind: call.kind === 'ServerAction' ? 'stub-call' : call.kind === 'DataActRefresh' ? 'refresh' : 'client-call' },
        language: 'js', arguments: call.args.map((expression, i) => ({ position: i, expression })) });
    }
  }
  graph.components = parsed.components;
  return graph;
}

// Merge model and asset graphs of one or more modules, resolve stubs/signatures, freeze a canonical form.
export function buildO11CallGraph(parts) {
  const graph = emptyGraph(), components = {};
  for (const part of parts) {
    for (const node of part.nodes.values()) putNode(graph, structuredClone(node));
    for (const edge of part.edges.values()) putEdge(graph, structuredClone(edge));
    for (const [from, to] of part.aliases) graph.aliases.set(from, to);
    Object.assign(components, part.components ?? {});
  }
  // Asset stubs -> the server action they call (by name; referenced stubs through the reference signature).
  const nodes = [...graph.nodes.values()];
  const unresolved = [];
  for (const stub of nodes.filter(n => n.kind === 'ServerActionStub')) {
    if (stub.calleeId) { putEdge(graph, { from: stub.id, to: stub.calleeId, via: { kind: 'stub' }, language: 'stub', arguments: [] }); continue; }
    let candidates = nodes.filter(n => n.moduleKey === stub.moduleKey && n.name === stub.calleeName &&
      (stub.referenced ? SIGNATURE_KINDS.has(n.kind) || n.producer : ['ServerAction', 'ServiceAction', 'ProcessLaunchAction'].includes(n.kind) && !n.producer));
    if (candidates.length > 1 && stub.producerHint)
      candidates = candidates.filter(n => (n.producer ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(stub.producerHint));
    let to;
    if (candidates.length === 1) to = candidates[0].id;
    else {
      to = `name:${stub.moduleKey}:${stub.calleeName}`; unresolved.push({ stub: stub.id, callee: stub.calleeName, candidates: candidates.length });
      putNode(graph, { id: to, module: stub.module, moduleKey: stub.moduleKey, key: null, kind: 'UnresolvedServerAction', name: stub.calleeName,
        path: null, owner: null, public: false, entry: null, liveness: null, sortKey: to, sources: ['asset'] });
    }
    stub.calleeId = to;
    putEdge(graph, { from: stub.id, to, via: { kind: 'stub' }, language: 'stub', arguments: [] });
  }
  // Reference signatures are the producer's action seen from the consumer: fold them into the producer node.
  const alias = id => { let seen = 0; while (graph.aliases.has(id) && graph.nodes.has(graph.aliases.get(id)) && seen++ < 8) id = graph.aliases.get(id); return id; };
  const edges = new Map();
  for (const e of graph.edges.values()) {
    const edge = { ...e, from: alias(e.from), to: alias(e.to) };
    if (edge.from === edge.to) continue;
    const id = edge.from + '>' + edge.to, current = edges.get(id);
    if (!current || (current.language !== 'os' && edge.language === 'os')) edges.set(id, edge);
  }
  const folded = new Map();
  for (const node of graph.nodes.values()) {
    const target = alias(node.id);
    if (target !== node.id) { const t = graph.nodes.get(target); t.consumerSignatures = [...new Set([...(t.consumerSignatures ?? []), node.id])].sort(); continue; }
    folded.set(node.id, node);
  }
  // A stub's inputs are its server action's inputs (model types when the model was read).
  for (const node of folded.values()) if (node.kind === 'ServerActionStub') {
    const callee = folded.get(alias(node.calleeId)) ?? folded.get(node.calleeId);
    if (callee) node.calleeId = callee.id;
    if (callee?.inputs?.length) node.inputs = callee.inputs.map(i => ({ ...i,
      dataType: node.abi?.inputs?.find(a => a.name === i.name)?.dataType ?? i.dataType ?? null,
      param: node.abi?.inputs?.find(a => a.name === i.name)?.param ?? null }));
    if (callee?.outputs?.length && !node.outputs?.length) node.outputs = callee.outputs;
  }
  const sortedNodes = [...folded.values()].sort((a, b) => cmp(a.id, b.id));
  const sortedEdges = [...edges.values()].filter(e => folded.has(e.from) && folded.has(e.to)).sort((a, b) => cmp(a.from + '>' + a.to, b.from + '>' + b.to));
  const canonical = { nodes: sortedNodes.map(n => canonicalNode(n)), edges: sortedEdges.map(e => ({ from: e.from, to: e.to, via: e.via.kind,
    ...(e.via.kind === 'native-callback' ? { callback: e.via.callback } : {}),
    ...(e.via.asynchronous ? { asynchronous: true, processKey: e.via.processKey, flowPath: e.via.flowPath ?? null } : {}) })) };
  const graphSha256 = createHash('sha256').update(stableStringify(canonical)).digest('hex');
  const callers = new Map(), callees = new Map();
  for (const e of sortedEdges) {
    if (!callers.has(e.to)) callers.set(e.to, []); callers.get(e.to).push(e);
    if (!callees.has(e.from)) callees.set(e.from, []); callees.get(e.from).push(e);
  }
  return { schema: 'ssam-o11-call-graph/1', nodes: new Map(sortedNodes.map(n => [n.id, n])), edges: sortedEdges, callers, callees,
    components, unresolved: unresolved.sort((a, b) => cmp(a.stub, b.stub)), graphSha256 };
}
const canonicalNode = n => ({ id: n.id, kind: n.kind, name: n.name, entry: n.entry ?? null, liveness: n.liveness ?? null, public: !!n.public, sortKey: n.sortKey,
  ...(n.process ? { process: n.process } : {}), ...(n.timer ? { timer: n.timer } : {}) });
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  return JSON.stringify(value ?? null);
}

// ---- target selection -------------------------------------------------------------------------------------
export function findTarget(graph, selector) {
  const all = [...graph.nodes.values()].filter(n => TARGET_KINDS.has(n.kind));
  let found;
  if (/\*/.test(selector ?? '')) found = all.filter(n => n.id === selector);
  else found = all.filter(n => o11SelectorMatches(n, selector));
  return found.sort((a, b) => cmp(a.id, b.id));
}

const invocable = node => !!node?.entry && ENTRY_PRIORITY.includes(node.entry);
const nodeView = n => n && { id: n.id, kind: n.kind, name: n.name, module: n.module, key: n.key ?? null, owner: n.owner ?? null,
  entry: n.entry ?? null, sortKey: n.sortKey, ...(n.abi?.endpoint ? { endpoint: n.abi.endpoint } : {}),
  ...(n.processOwnerKey ? { processOwnerKey: n.processOwnerKey } : {}) };

export function resolveO11Entry(graph, selector, { entry: override } = {}) {
  const base = { schema: 'ssam-o11-entry-resolution/1', algorithm: ALGORITHM, priority: ENTRY_PRIORITY, graphSha256: graph.graphSha256, selector };
  const targets = findTarget(graph, selector);
  if (!targets.length) {
    const reference = [...graph.nodes.values()].find(n => n.producer && n.name === selector);
    return { ...base, state: 'target-not-found', message: reference
      ? selector + ' is a reference of ' + reference.producer + ' here; add that producer module to modules[] so its published model is in the graph'
      : 'no action named ' + selector + ' in the published model given' };
  }
  if (targets.length > 1) return { ...base, state: 'target-ambiguous', candidates: targets.map(nodeView),
    message: 'several actions match ' + selector + '; pass action as @<key> or <Module>.<Name>' };
  const target = targets[0];
  // 1. BFS over callers, level by level, in sortKey order.
  let distance = new Map([[target.id, 0]]), level = [target.id];
  while (level.length) {
    const next = [];
    for (const id of level) for (const e of [...(graph.callers.get(id) ?? [])].sort((a, b) => cmp(graph.nodes.get(a.from).sortKey, graph.nodes.get(b.from).sortKey)))
      if (!distance.has(e.from)) { distance.set(e.from, distance.get(id) + 1); next.push(e.from); }
    level = next.sort((a, b) => cmp(graph.nodes.get(a).sortKey, graph.nodes.get(b).sortKey));
  }
  // An ordinary synchronous caller takes precedence over a possible scheduler path.
  // Crossing process-launch/process-flow never makes the activity a synchronous return value.
  if (graph.edges.some(e => e.via.asynchronous)) {
    const synchronous = new Map([[target.id, 0]]), queue = [target.id];
    for (let i = 0; i < queue.length; i++) for (const edge of graph.callers.get(queue[i]) ?? [])
      if (!edge.via.asynchronous && !synchronous.has(edge.from)) {
        synchronous.set(edge.from, synchronous.get(queue[i]) + 1); queue.push(edge.from);
      }
    if ([...synchronous.keys()].some(id => invocable(graph.nodes.get(id)))) distance = synchronous;
  }
  const reached = [...distance.keys()].map(id => graph.nodes.get(id));
  const rank = n => [distance.get(n.id), ENTRY_PRIORITY.indexOf(n.entry), n.sortKey];
  const order = (a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || cmp(x[2], y[2]); };
  const entries = reached.filter(invocable).sort(order);
  const summary = { target: nodeView(target), reachedFrom: entries.slice(0, 20).map(n => ({ ...nodeView(n), distance: distance.get(n.id) })) };
  let chosen;
  if (override !== undefined) {
    const matches = [...graph.nodes.values()].filter(n => n.id === override || n.sortKey === override ||
      (n.abi?.endpoint && n.abi.endpoint === override) || o11SelectorMatches(n, override)).sort((a, b) => cmp(a.id, b.id));
    if (matches.length !== 1 || !invocable(matches[0]) || !distance.has(matches[0].id))
      return { ...base, ...summary, state: 'override-refused', message: 'entry ' + override + ' is not an invocable caller of ' + target.name + ' on this graph' };
    chosen = matches[0];
  } else if (entries.length) chosen = entries[0];
  if (!chosen) {
    const live = reached.filter(n => n.liveness).sort((a, b) => distance.get(a.id) - distance.get(b.id) || cmp(a.sortKey, b.sortKey));
    if (live.length) return { ...base, ...summary, state: 'no-invocable-entry', reachedOnlyBy: live.map(n => ({ ...nodeView(n), liveness: n.liveness, distance: distance.get(n.id) })),
      message: 'no invocable entry reaches ' + target.name + '; it runs only from ' + live.map(n => n.liveness + ' ' + n.name).join(', ') };
    const exposed = reached.filter(n => n.public && ['ServerAction', 'ServiceAction'].includes(n.kind) && !(graph.callers.get(n.id)?.length));
    if (exposed.length) return { ...base, ...summary, state: 'public-without-consumer', publicRoots: exposed.map(nodeView),
      message: 'no consumer of ' + exposed.map(n => n.module + '.' + n.name).join(', ') + ' in the modules given; add the consumer module to the graph' };
    return { ...base, ...summary, state: 'dead-code', message: 'dead code: no public entry reaches ' + target.name };
  }
  // 2. Forward path, one step closer to the target each time, smallest sortKey first.
  const path = [chosen], hops = [];
  for (let current = chosen; current.id !== target.id;) {
    const d = distance.get(current.id);
    const step = [...(graph.callees.get(current.id) ?? [])].filter(e => distance.get(e.to) === d - 1)
      .sort((a, b) => cmp(graph.nodes.get(a.to).sortKey, graph.nodes.get(b.to).sortKey))[0];
    hops.push(step); current = graph.nodes.get(step.to); path.push(current);
  }
  const candidates = entries.filter(n => distance.get(n.id) === distance.get(chosen.id)).map(n => ({ ...nodeView(n), distance: distance.get(n.id) }));
  const launchHop = hops.find(h => ['process-launch', 'timer-wake'].includes(h.via.kind));
  if (hops.some(h => h.via.asynchronous)) {
    const originalLaunch = launchHop ? resolveO11Entry(graph, launchHop.from, { entry: chosen.id }) : null;
    return { ...base, ...summary, state: 'background-trigger-resolved', override: override !== undefined,
      entry: { ...nodeView(chosen), runnable: false }, distance: distance.get(chosen.id), path: path.map(nodeView),
      callPath: path.map(n => n.module ? n.module + '.' + n.name : n.name).join(' -> '),
      hops: hops.map(h => ({ from: h.from, to: h.to, via: h.via })), candidatesAtDistance: candidates, bindings: [],
      originalLaunch: originalLaunch?.state === 'resolved' ? { ...originalLaunch,
        entryInputs: graph.nodes.get(originalLaunch.entry.id).inputs,
        entryAbiObserved: !!graph.nodes.get(originalLaunch.entry.id).abi } : null,
      background: { kind: launchHop?.via.kind === 'timer-wake' ? 'timer-original-wake' : 'process-original-launch',
        processKey: launchHop?.via.processKey ?? null, timerKey: launchHop?.via.timerKey ?? null, launcherContext: 'app-user', activityContext: 'native-background',
        inputsReferTo: 'original launcher entry; never activity variables', directActivityInvocation: false,
        requestOwnershipProved: false, appUserIdentityProved: false, rolesProved: false, executionCompleted: false },
      message: 'the original app entry can trigger native background work; execution is asynchronous and must be observed separately' };
  }
  return { ...base, ...summary, state: 'resolved', override: override !== undefined, entry: { ...nodeView(chosen), runnable: RUNNABLE_ENTRIES.includes(chosen.entry) },
    distance: distance.get(chosen.id), path: path.map(nodeView), callPath: path.map(n => n.module ? n.module + '.' + n.name : n.name).join(' -> '),
    hops: hops.map(h => ({ from: h.from, to: h.to, via: h.via })), candidatesAtDistance: candidates,
    bindings: bindInputs(graph, path, hops) };
}

// ---- input bindings ---------------------------------------------------------------------------------------
// For each target input, compose the call arguments from the target back to the entry. Only trivial, structural
// patterns are recognized; anything else is "derived" (observed, never claimed controllable). 'identity' comes only
// from native provenance of the published argument (graphFromReadings nativeBindings), never from its text.
const OS_LITERAL = /^(?:"(?:[^"]|"")*"|-?\d+(?:\.\d+)?|True|False|Null\w*\(\)|#[^#]+#)$/;
const JS_LITERAL = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null|OS\.BuiltinFunctions\.null\w*\(\))$/;
function classify(edge, callerNode, expression, argument) {
  const inputs = (callerNode.inputs ?? []).map(i => i.name).filter(Boolean);
  if (edge.language === 'stub') return { class: 'pass-through', input: expression.slice('$self.'.length) };
  // The platform builds callback inputs (request/response, credentials): observed, never controllable.
  if (edge.language === 'native-callback') return { class: 'derived', expression: 'platform ' + edge.via.callback + ' input' };
  // A block Preparation reads the block's inputs bound by the rendering widget: observed only.
  if (edge.language === 'native-render') return { class: 'derived', expression: 'block instance ' + edge.via.instanceKey + ' arguments' };
  if (edge.language === 'os') {
    const text = (expression ?? '').trim();
    if (!text) return { class: 'default' };
    if (argument?.identity) return { class: 'identity', expression: text, provenance: argument.identity };
    if (OS_LITERAL.test(text)) return { class: 'fixed', expression: text };
    if (inputs.includes(text)) return { class: 'pass-through', input: text };
    const attribute = /^([A-Za-z_]\w*)\.([A-Za-z_][\w.]*)$/.exec(text);
    if (attribute && inputs.includes(attribute[1])) return { class: 'pass-through', input: attribute[1], attribute: attribute[2] };
    return { class: 'derived', expression: text };
  }
  const text = (expression ?? '').trim();
  if (JS_LITERAL.test(text)) return { class: 'fixed', expression: text };
  const params = callerNode.abi?.inputs ?? callerNode.inputs ?? [];
  const param = /^(\w+)In$/.exec(text)?.[0] ?? (/^vars\.value\.(\w+In)Local$/.exec(text)?.[1]);
  const byParam = param && params.find(p => p.param === param);
  if (byParam?.name) return { class: 'pass-through', input: byParam.name };
  const variable = /^model\.variables\.(\w+)$/.exec(text);
  if (variable) return { class: 'screen-variable', attribute: variable[1], expression: text };
  return { class: 'derived', expression: text };
}
function argumentFor(edge, calleeNode, parameter) {
  if (edge.language === 'stub') return '$self.' + parameter.name;
  if (edge.language === 'os') return edge.arguments.find(a => a.parameter === parameter.name)?.expression ?? '';
  // JS: positional against the callee's ABI parameter order.
  const order = calleeNode.abi?.inputs ?? calleeNode.inputs ?? [];
  const index = order.findIndex(p => p.name === parameter.name);
  return index >= 0 ? edge.arguments.find(a => a.position === index)?.expression ?? '' : '';
}
export function bindInputs(graph, path, hops) {
  const target = path.at(-1), entry = path[0];
  return (target.inputs ?? []).filter(i => i.name).map(input => {
    let parameter = input, attributePath = [], trail = [];
    for (let i = hops.length - 1; i >= 0; i--) {
      const edge = graph.edges.find(e => e.from === hops[i].from && e.to === hops[i].to), caller = path[i], callee = path[i + 1];
      const expression = argumentFor(edge, callee, parameter);
      const verdict = classify(edge, caller, expression, edge.language === 'os' ? edge.arguments.find(a => a.parameter === parameter.name) : null);
      trail.push({ at: caller.name, class: verdict.class });
      if (verdict.class === 'pass-through') {
        if (verdict.attribute) attributePath = [verdict.attribute, ...attributePath];
        parameter = (caller.inputs ?? []).find(p => p.name === verdict.input) ?? { name: verdict.input };
        continue;
      }
      const settable = verdict.class === 'screen-variable' && i === 0 && entry.entry === 'client-action';
      return { input: input.name, class: verdict.class, controllable: settable, ...(settable ? { screenVariable: verdict.attribute } : {}),
        ...(verdict.expression ? { expression: verdict.expression } : {}), ...(verdict.provenance ? { provenance: verdict.provenance } : {}), at: caller.name };
    }
    return { input: input.name, class: hops.length ? 'controlled' : 'direct', controllable: true, entryInput: parameter.name,
      ...(attributePath.length ? { attributePath: attributePath.join('.') } : {}) };
  });
}

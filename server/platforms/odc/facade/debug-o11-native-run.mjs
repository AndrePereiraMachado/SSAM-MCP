// O11 native-entry runner, graph-driven (no wrapper, no publication).
//
//   prepare: read the PUBLISHED capture of the module(s) and the PUBLIC runtime assets, build the static call graph,
//            resolve the nearest public entry deterministically (debug-o11-entry-graph.mjs), validate the scenarios
//            against the entry's typed inputs and say what the run needs (login window, binding, server trace).
//   run:     same resolution, then one secure App User Sign In window (debug-app-user*.mjs; the original
//            Users.User_Login through the app's own Login screen stub), N scenarios through the ORIGINAL entry inside
//            the private worker, optional client trace (original OutSystemsDebugger hooks) and optional server trace
//            (SOAP debugger on the target's module, breakpoint at the target's start node). Stop, dispose, release.
//   status:  last receipt of the binding.
//
// Assumptions (DEV environments): a server breakpoint may also catch another user's request on the same action;
// request isolation is not proved. The 4c binding (Headless_UI on personal-2qqw9srv) never gets a debug session.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { o11Read, o11Write, o11Hash } from './debug-o11-lifecycle.mjs';
import { parseO11Assets, hostViewName, amdClosure, canonicalScenario, o11SensitiveName } from './debug-o11-native-abi.mjs';
import { graphFromReadings, graphFromAssets, buildO11CallGraph, resolveO11Entry, RUNNABLE_ENTRIES } from './debug-o11-entry-graph.mjs';
import { appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { o11NativePublicCode } from './debug-o11-native-entry.mjs';
import { SIGN_IN_FAILURES } from './debug-guidance.mjs';
import { actionModel, traceWindow, scopeRoots } from './debug-wrapper.mjs'; // pure model helpers only; no wrapper path

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/, KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SERVER_TARGETS = new Set(['ServerAction', 'ServiceAction', 'DataAction']);
// These lifecycle codes contain no SDK text or credentials. Do not replace them
// with a generic execution error when capture fails before the login window.
const CAPTURE_ERRORS = new Set([
  'debug_o11_run_inventory_stale_or_mismatched', 'debug_o11_run_module_scope_mismatch',
  'debug_o11_run_snapshot_scope_mismatch', 'debug_o11_run_cli_unavailable',
  'debug_o11_run_cli_invalid_response', 'debug_o11_run_cli_refused',
  'debug_o11_run_model_read_incomplete', 'debug_o11_run_source_changed',
]);

// Bindings where no debug session may start (uncertain operation 4c7016f0a51445108b185fdcd0109586, 2026-10-03).
// The user lifts this, not the code. A local registry under .local/debugger/blocked-bindings adds more.
export const BLOCKED_BINDINGS = Object.freeze([
  Object.freeze({ host: 'personal-2qqw9srv.outsystemscloud.com', moduleKey: 'Mif02PxcH0K7KiABEHTwMg', module: 'Headless_UI',
    operationId: '4c7016f0a51445108b185fdcd0109586', reason: 'uncertain native Start/Stop; never repeat, never start on this binding until the user decides',
    // The breakpoint that uncertain Start asked for (StartNode of Common/UserInfo/DataAction:SSAM_DebugServiceContextFromServer):
    // a call path through it is refused even without trace, so a stale server session could never suspend our request.
    nodeKeys: Object.freeze(['LiCk5pmr6Ueb45499t9tNw']) }),
]);
export const bindingHash = (host, moduleKey) => sha('o11|https://' + host.toLowerCase() + '|' + moduleKey);
export function blockedBinding(root, host, moduleKey) {
  const fixed = BLOCKED_BINDINGS.find(b => b.host === host && b.moduleKey === moduleKey);
  if (fixed) return { ...fixed, source: 'code' };
  const file = path.join(root, '.local', 'debugger', 'blocked-bindings', bindingHash(host, moduleKey) + '.json');
  if (fs.existsSync(file)) { let value = {}; try { value = o11Read(file); } catch { /* unreadable stays blocked */ }
    return { host, moduleKey, operationId: value.operationId ?? null, reason: 'local blocked-bindings registry', source: 'registry' }; }
  return null;
}

// ---- contract (worker policy v2) from the resolution ------------------------------------------------------
export function appDefinitionOf(text) {
  const guid = /applicationKey: "([a-f0-9-]{36})"/.exec(text)?.[1], provider = /userProviderName: "([A-Za-z_][A-Za-z0-9_]*)"/.exec(text)?.[1];
  if (!guid || !provider) fail('debug_o11_native_app_definition_unresolved');
  return { nativeApplicationGuid: guid, userProvider: provider };
}
export function loginSpec(parsed, module) {
  const stubs = parsed.stubs.filter(s => s.owner !== '@module' && parsed.components[s.owner]?.screen &&
    s.inputs.map(i => i.name).sort().join(',') === 'Password,RememberLogin,Username');
  if (stubs.length !== 1) fail('debug_o11_native_login_contract_unresolved');
  const s = stubs[0], component = parsed.components[s.owner];
  return { modelFactory: component.amd + '.mvc$model', controllerFactory: component.amd + '.mvc$controller', method: s.method,
    viewName: component.viewName, apiVersion: s.apiVersion, endpoint: '/' + module + '/' + s.endpoint };
}
function recordClassFor(parsed, module, input) {
  const of = (input.modelType ?? '').split(':')[1]?.replace(/ (Record|List)$/, '');
  if (!['Record', 'RecordList'].includes(input.dataType)) return undefined;
  const candidates = input.dataType === 'Record' ? [of + 'Rec', of + 'Record'] : [of + 'List', of + 'RecordList'];
  const found = candidates.map(c => module + '.model$' + c).find(name => parsed.defines[name]);
  if (!of || !found) fail('debug_o11_native_record_class_unresolved:' + input.name);
  return found;
}
// Endpoints a client-action entry may POST: the stubs and data actions it reaches through client calls (same module).
function reachableEndpoints(graph, startId) {
  const seen = new Set([startId]), stack = [startId], endpoints = {};
  while (stack.length) {
    const id = stack.pop(), node = graph.nodes.get(id);
    if (node?.abi?.endpoint && node.abi.apiVersion) endpoints[node.abi.endpoint] = node.abi.apiVersion;
    if (node && node.kind !== 'ClientAction' && id !== startId) continue; // stop at server boundaries
    for (const e of graph.callees.get(id) ?? []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return endpoints;
}
export function entrySpec(graph, resolution, parsed, module) {
  const node = graph.nodes.get(resolution.entry.id), abi = node?.abi;
  if (!abi || !RUNNABLE_ENTRIES.includes(node.entry)) fail('debug_o11_native_entry_abi_unresolved');
  const owner = abi.owner, moduleLevel = owner === '@module', component = parsed.components[owner];
  const factories = moduleLevel ? {} : { modelFactory: component.amd + '.mvc$model', controllerFactory: component.amd + '.mvc$controller',
    viewName: hostViewName(parsed, owner) };
  if (!moduleLevel && !factories.viewName) fail('debug_o11_native_host_screen_unresolved');
  const typed = list => (list ?? []).map(i => {
    const model = node.inputs?.find(m => m.name === i.name);
    const recordClass = recordClassFor(parsed, module, { ...i, modelType: model?.modelType });
    return { name: i.name, param: i.param, dataType: i.dataType, ...(recordClass ? { recordClass } : {}) };
  });
  const absolute = endpoint => '/' + module + '/' + endpoint.replace(/^\/+/, '');
  if (node.entry === 'client-action') {
    const reach = reachableEndpoints(graph, node.id);
    const screenVariables = (resolution.bindings ?? []).filter(b => b.class === 'screen-variable' && b.controllable)
      .map(b => component?.variables?.find(v => v.attribute === b.screenVariable)).filter(Boolean)
      .map(v => ({ name: v.name, attribute: v.attribute, dataType: v.dataType }));
    return { kind: 'client-action', controller: abi.controller, moduleLevel, ...factories, method: abi.method, actionKey: node.key,
      endpoints: Object.keys(reach).map(absolute).sort(), endpointVersions: Object.fromEntries(Object.entries(reach).map(([e, v]) => [absolute(e), v])),
      inputs: typed(abi.inputs), outputs: (abi.outputs ?? []).map(o => ({ name: o.name, attribute: o.attribute, dataType: o.dataType })), screenVariables };
  }
  const endpoint = absolute(abi.endpoint);
  return { kind: node.entry, controller: abi.controller, moduleLevel, ...factories, method: abi.method, actionKey: node.key ?? null,
    endpoint, apiVersion: abi.apiVersion, endpoints: [endpoint], endpointVersions: { [endpoint]: abi.apiVersion },
    ...(node.entry === 'data-action' ? { dataProperty: abi.dataProperty, inputs: [], outputs: [] }
      : { inputs: typed(abi.inputs), outputs: (abi.outputs ?? []).map(o => ({ name: o.name, attribute: o.attribute, dataType: o.dataType })) }) };
}
export function contractAssets(parsed, pins, module, login, entry) {
  const roots = [login.modelFactory, login.controllerFactory, module + '.appDefinition', module + '.controller',
    'OutSystems/ClientRuntime/Main', 'OutSystems/ClientRuntime/Debugger',
    ...(entry.moduleLevel ? [entry.controller] : [entry.modelFactory, entry.controllerFactory]),
    ...entry.inputs.map(i => i.recordClass).filter(Boolean)];
  const closure = amdClosure(parsed, roots);
  if (closure.missing.length) fail('debug_o11_native_asset_dependency_missing:' + closure.missing[0]);
  const first = ['OutSystems.js', 'OutSystemsSettings.js', 'Debugger.js'];
  const names = [...new Set([...first.filter(n => closure.assets.includes(n) || n === 'OutSystems.js'), ...closure.assets])];
  return names.map(name => { const pin = pins.find(p => p.name === name); if (!pin) fail('debug_o11_native_assets_invalid');
    return { name, path: pin.path, sha256: pin.sha256, urlPath: pin.urlPath, query: pin.query, execute: true }; });
}

// Scenario inputs are named after the TARGET's inputs; bindings say which entry input (or screen variable) carries each.
export function scenarioPlan(resolution, input) {
  const target = resolution.path.at(-1), bindings = resolution.bindings ?? [];
  const raw = input.scenarios ?? [{ name: 'call', inputs: input.inputs ?? {} }];
  const names = raw.map((s, i) => s.name ?? 'scenario-' + (i + 1));
  if (new Set(names).size !== names.length) fail('debug_o11_native_duplicate_scenarios');
  const parameters = bindings.map(b => ({ name: b.input, modelType: resolution.targetInputs?.find(t => t.name === b.input)?.modelType ?? null,
    dataType: resolution.targetInputs?.find(t => t.name === b.input)?.dataType ?? null, mandatory: false, controllable: b.controllable }));
  return raw.map((scenario, i) => {
    for (const name of Object.keys(scenario.inputs ?? {})) if (o11SensitiveName(name)) fail('debug_o11_native_input_private_or_invalid:' + name);
    const { values, presence } = canonicalScenario(parameters, scenario.inputs ?? {});
    const entryValues = {}, screen = {};
    for (const [name, value] of Object.entries(values)) {
      const b = bindings.find(x => x.input === name);
      if (b.screenVariable) screen[name] = value;
      else if (b.attributePath) {
        let cursor = entryValues[b.entryInput] ??= {};
        const parts = b.attributePath.split('.');
        for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
        cursor[parts.at(-1)] = value;
      } else entryValues[b.entryInput] = value;
    }
    return { name: names[i], target: target.name, values: entryValues, screen, presence };
  });
}

// ---- default live services (not exercised offline) --------------------------------------------------------
const MODEL_KINDS = ['ServerAction', 'ServiceAction', 'ClientAction', 'DataAction', 'Timer', 'ServerActionSignature', 'ServiceActionSignature'];
// Collections are traversed through children. Reading reflected collection getters
// (notably ScreenAction.OutputParameters) can throw even on valid native models.
export const GRAPH_PROPERTIES = 'Name,GlobalKey,Public,DataType,Type,IsMandatory,Action,Parameter,Value,Target,TrueTarget,FalseTarget,DataSource';
export async function readO11GraphTree(base, selector, reader) {
  if (!reader) {
    const { kernelReading } = await import('./kernel-reading.mjs');
    const { LANES } = await import('./lanes.mjs');
    reader = args => kernelReading(LANES.o11, args);
  }
  const result = await reader(['--oml', base.file, '--path', selector, '--depth', '4', '--max', '500',
    '--properties', GRAPH_PROPERTIES, '--full', '--budget', '1000000', '--expectedSourceSha256', base.sha256]);
  const data = result.data?.out ? o11Read(result.data.out) : result.data;
  const complete = node => node && !node.childrenOmitted && !Object.keys(node.propertyErrors ?? {}).length &&
    !Object.keys(node.propertiesOmitted ?? {}).length && (node.children ?? []).every(complete);
  if (!result.ok || data?.sourceSha256?.toLowerCase() !== base.sha256.toLowerCase() || !complete(data.tree))
    fail('debug_o11_native_model_read_incomplete');
  return data.tree;
}
async function defaultCapture(root, target, directory) {
  const { createO11Lifecycle } = await import('./debug-o11-lifecycle.mjs');
  const { kernelReading } = await import('./kernel-reading.mjs');
  const { LANES } = await import('./lanes.mjs');
  const lifecycle = createO11Lifecycle({ root });
  const base = await lifecycle.snapshot(target, directory);
  // The published capture is immutable per sha256: its readings are reused by later prepare/run calls.
  const cache = path.join(root, '.local', 'debugger', 'native-runs', 'o11', 'model-cache', base.sha256 + '-graph-v2.json');
  if (fs.existsSync(cache)) {
    const cached = o11Read(cache);
    if (cached.sourceSha256 === base.sha256 && Array.isArray(cached.readings))
      return { versionId: base.versionId, snapshot: { path: base.file, sha256: base.sha256 }, inventoryProof: base.proof, readings: cached.readings };
  }
  const readings = [];
  for (const kind of MODEL_KINDS) {
    for (let offset = 0, guard = 0; offset !== null && guard < 40; guard++) {
      const listed = await kernelReading(LANES.o11, ['--oml', base.file, '--kind', kind, '--depth', '0', '--max', '500', '--offset', String(offset),
        '--properties', 'Name', '--expectedSourceSha256', base.sha256]);
      const data = listed.data?.out ? o11Read(listed.data.out) : listed.data;
      if (!listed.ok || data?.searchComplete !== true) fail('debug_o11_native_model_read_incomplete');
      for (const entry of data.entries ?? []) if (KEY.test(entry.key ?? '')) readings.push(await readO11GraphTree(base, '@' + entry.key));
      offset = Number.isSafeInteger(data.nextOffset) ? data.nextOffset : null;
      if (offset !== null && guard === 39) fail('debug_o11_native_model_read_incomplete');
    }
  }
  o11Write(cache, { schema: 'ssam-o11-native-model-cache/1', sourceSha256: base.sha256, module: target.module, moduleKey: target.moduleKey, readings });
  return { versionId: base.versionId, snapshot: { path: base.file, sha256: base.sha256 }, inventoryProof: base.proof, readings };
}
export async function acquireO11PublicAssets({ target, versionId, directory, fetchImpl = fetch, now = Date.now }) {
  const origin = new URL(target.runtimeUrl).origin, get = async (urlPath, limit) => {
    const response = await fetchImpl(origin + urlPath, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: '*/*' } });
    if (response.status !== 200 || (response.url && response.url !== origin + urlPath)) fail('debug_o11_native_assets_invalid');
    const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > limit) fail('debug_o11_native_response_limit');
    return bytes;
  };
  fs.mkdirSync(directory, { recursive: true });
  const infoBytes = await get('/' + target.module + '/moduleservices/moduleinfo?' + now(), 5 * 1024 * 1024);
  const manifest = JSON.parse(infoBytes.toString('utf8'));
  if (manifest.manifest?.versionSequence !== versionId) fail('debug_o11_native_publication_changed');
  const infoPath = path.join(directory, 'moduleinfo.json'); fs.writeFileSync(infoPath, infoBytes);
  const scripts = Object.entries(manifest.manifest.urlVersions ?? {}).filter(([p, q]) =>
    new RegExp('^/' + target.module + '/scripts/[A-Za-z_][A-Za-z0-9_.-]{0,240}\\.js$').test(p) && typeof q === 'string' && q.startsWith('?'))
    .sort(([a], [b]) => a < b ? -1 : 1);
  if (scripts.length > 400) fail('debug_o11_native_assets_invalid');
  const pins = [];
  for (const [urlPath, query] of scripts) {
    const bytes = await get(urlPath + query, 8 * 1024 * 1024), name = urlPath.split('/').pop(), file = path.join(directory, name);
    fs.writeFileSync(file, bytes); pins.push({ name, path: file, sha256: sha(bytes), urlPath, query });
  }
  return { moduleInfo: { path: infoPath, sha256: sha(infoBytes) }, manifest, pins };
}

// O11 runs a producer's public server action inside the caller's process (the consumer is compiled against the
// producer's code); only a service action call moves execution to its own module's process. The entry runs in the
// entry module. Returns the module key whose process executes the last node of the call path.
export function executingModuleKey(graph, callPath, entryModuleKey) {
  let moduleKey = entryModuleKey;
  for (const step of callPath ?? []) { const node = graph.nodes.get(step.id); if (node?.kind === 'ServiceAction') moduleKey = node.moduleKey; }
  return moduleKey;
}

// ---- runner -----------------------------------------------------------------------------------------------
export function createO11NativeRun(services = {}) {
  const root = services.root ?? workspaceRoot;
  const capture = services.capture ?? ((target, directory) => defaultCapture(root, target, directory));
  const assets = services.assets ?? (input => acquireO11PublicAssets(input));
  const prepareUser = services.prepareUser ?? (async (...a) => (await import('./debug-app-user.mjs')).prepareDebugAppUser(...a));
  const releaseUser = services.releaseUser ?? (async (...a) => (await import('./debug-app-user.mjs')).releaseDebugAppUser(...a));
  const debug = services.debug ?? (async (input, context) => (await import('./debug-runtime.mjs')).headlessDebug(input, context));
  // Producer-module trace (entry in the consumer, target in the producer) needs debug-runtime to accept the consumer's
  // app-user descriptor for redaction only (appUserEntry); the runtime announces it with O11_CROSS_MODULE_REDACTION = true.
  let crossModuleTrace = services.crossModuleTrace;
  const crossModuleHook = async () => {
    if (typeof crossModuleTrace === 'boolean') return crossModuleTrace;
    try { crossModuleTrace = (await import('./debug-runtime.mjs')).O11_CROSS_MODULE_REDACTION === true; } catch { crossModuleTrace = false; }
    return crossModuleTrace;
  };
  const traceRead = services.traceRead ?? (sessionId => {
    const file = path.join(root, '.local', 'debugger', sessionId, 'trace.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  });
  // A scenario's server map ends at the kernel's thread-end marker; without one (no breakpoint hit), wait for silence.
  const settle = services.settle ?? (async (sessionId, before) => {
    let previous = -1, stable = 0;
    for (let i = 0; i < 60 && stable < 2; i++) {
      await new Promise(r => setTimeout(r, 500));
      const lines = traceRead(sessionId); if (lines.slice(before).some(l => l.kind === 'thread-end')) return;
      stable = lines.length === previous ? stable + 1 : 0; previous = lines.length;
    }
  });
  const folder = target => path.join(root, '.local', 'debugger', 'native-runs', 'o11', target.host);

  async function resolve(input, target, directory, progress) {
    const moduleTargets = [{ ...target }, ...(input.modules ?? []).map(m => ({ host: target.host, module: m.module, moduleKey: m.moduleKey,
      applicationKey: m.applicationKey, runtimeUrl: new URL(target.runtimeUrl).origin + '/' + m.module + '/' }))];
    if (new Set(moduleTargets.map(m => m.moduleKey)).size !== moduleTargets.length) fail('debug_o11_native_modules_duplicated');
    const captures = [];
    for (const m of moduleTargets) {
      progress('published-model', m.module);
      captures.push({ target: m, ...(await capture(m, path.join(directory, 'model', m.module))) });
    }
    const entryCapture = captures[0];
    progress('published-assets', target.module);
    const published = await assets({ target, versionId: entryCapture.versionId, directory: path.join(directory, 'assets') });
    progress('entry-resolution', target.module);
    const parsed = parseO11Assets(published.pins.map(p => ({ name: p.name, text: fs.readFileSync(p.path, 'utf8') })), target.module);
    const graph = buildO11CallGraph([...captures.map(c => graphFromReadings(c.readings, { module: c.target.module, moduleKey: c.target.moduleKey })),
      graphFromAssets(parsed, { moduleKey: target.moduleKey })]);
    const resolution = resolveO11Entry(graph, input.action, input.entry !== undefined ? { entry: input.entry } : {});
    return { captures, entryCapture, published, parsed, graph, resolution };
  }
  function tracePlan(input, target, resolution, graph, captures, mode) {
    const node = graph.nodes.get(resolution.path.at(-1).id), entryNode = graph.nodes.get(resolution.entry.id);
    const plan = { mode, client: mode !== 'none' && entryNode.entry === 'client-action', server: null };
    if (mode === 'none' || !SERVER_TARGETS.has(node.kind)) return plan;
    const owner = captures.find(c => c.target.moduleKey === node.moduleKey);
    const server = { module: node.module, moduleKey: node.moduleKey, functionKey: node.key, startNodeKey: node.startNodeKey ?? null,
      crossModule: node.moduleKey !== target.moduleKey, runsInModuleKey: executingModuleKey(graph, resolution.path, target.moduleKey), allowed: true, reason: null };
    const blocked = blockedBinding(root, target.host, node.moduleKey);
    if (blocked) Object.assign(server, { allowed: false, reason: 'binding_blocked', blockedBy: blocked.operationId });
    else if (!owner) Object.assign(server, { allowed: false, reason: 'target_module_not_captured' });
    else if (server.crossModule && !crossModuleTrace) Object.assign(server, { allowed: false, reason: 'cross_module_runtime_hook_missing' });
    // The SOAP session of a module only sees requests running in that module's process; a breakpoint there would never hit.
    else if (server.runsInModuleKey !== node.moduleKey) Object.assign(server, { allowed: false, reason: 'target_runs_in_caller_process' });
    else if (!KEY.test(server.startNodeKey ?? '')) Object.assign(server, { allowed: false, reason: 'target_start_node_unread' });
    if (server.allowed) {
      const tree = owner.readings.map(r => r.tree ?? r).find(t => t?.key === node.key);
      const model = tree ? actionModel(tree) : null;
      const window = input.window && model ? traceWindow(model, input.window) : null;
      Object.assign(server, { nodeKeys: window?.entries ?? [server.startNodeKey], stepsPerScenario: window?.steps ?? 300,
        scopes: mode === 'full' && model ? { [node.key]: scopeRoots(model) } : {},
        applicationKey: owner.target.applicationKey, runtimeUrl: owner.target.runtimeUrl, publishedVersionId: owner.versionId, publishedProof: owner.inventoryProof });
    }
    plan.server = server;
    return plan;
  }

  return async function runNative(input, { traceExplicit = false } = {}) {
    const target = { host: input.host, module: input.module, moduleKey: input.moduleKey, applicationKey: input.applicationKey,
      runtimeUrl: new URL(input.runtimeUrl).origin + '/' + input.module + '/' };
    const base = folder(target), latestPath = path.join(base, target.moduleKey + '.json'), lockPath = path.join(base, target.moduleKey + '.lock');
    if (input.op === 'status') return { ok: true, lane: 'o11', execution: 'native-entry', operation: fs.existsSync(latestPath) ? o11Read(latestPath) : null,
      busy: fs.existsSync(lockPath) };
    const operationId = randomUUID(), directory = path.join(base, operationId), receiptPath = path.join(directory, 'receipt.json');
    // none|nodes|full; omitted -> none; the legacy 'all' given explicitly -> full.
    const mode = !input.trace ? 'none' : input.trace === 'all' ? (traceExplicit ? 'full' : 'none') : input.trace;
    const report = { schema: 'ssam-o11-native-run/1', operationId, lane: 'o11', execution: 'native-entry', op: input.op, state: 'resolving',
      target, receiptPath, trace: mode, assumptions: ['DEV environment: a server breakpoint may also catch another user request on the same action',
        'request isolation not proved'], results: [] };
    const save = () => { o11Write(receiptPath, report); o11Write(latestPath, report); };
    let ownsLock = false, handle, descriptor, sessionId, traceSession = null, uncertain = false;
    try {
      if (fs.existsSync(lockPath)) fail('debug_o11_native_binding_busy');
      fs.mkdirSync(directory, { recursive: true });
      if (input.op === 'run') { const fd = fs.openSync(lockPath, 'wx'); ownsLock = true;
        fs.writeFileSync(fd, JSON.stringify({ operationId, pid: process.pid })); fs.closeSync(fd); }
      const { captures, entryCapture, published, parsed, graph, resolution } = await resolve(input, target, directory,
        (stage, module) => { report.preparation = { stage, module }; });
      Object.assign(report, { graphSha256: graph.graphSha256, resolution: { state: resolution.state, message: resolution.message ?? null,
        entry: resolution.entry ?? null, distance: resolution.distance ?? null, callPath: resolution.callPath ?? null, path: resolution.path ?? null,
        bindings: resolution.bindings ?? [], candidatesAtDistance: resolution.candidatesAtDistance ?? [], algorithm: resolution.algorithm,
        priority: resolution.priority, override: resolution.override ?? false, ...(resolution.reachedOnlyBy ? { reachedOnlyBy: resolution.reachedOnlyBy } : {}),
        ...(resolution.candidates ? { candidates: resolution.candidates } : {}) } });
      if (resolution.state !== 'resolved') { report.state = resolution.state; report.error = 'debug_o11_native_' + resolution.state.replaceAll('-', '_'); return report; }
      if (!resolution.entry.runnable) { report.state = 'entry-not-runnable'; report.error = 'debug_o11_native_entry_kind_not_runnable:' + resolution.entry.entry; return report; }
      resolution.targetInputs = graph.nodes.get(resolution.path.at(-1).id).inputs;
      // A path through a breakpoint left by an uncertain debugger operation is refused, traced or not.
      for (const node of resolution.path.map(p => graph.nodes.get(p.id))) {
        const blocked = node?.moduleKey && BLOCKED_BINDINGS.find(b => b.host === target.host && b.moduleKey === node.moduleKey);
        if (blocked?.nodeKeys?.includes(node.startNodeKey)) fail('debug_o11_native_path_crosses_uncertain_breakpoint:' + blocked.operationId);
      }
      const entryBlocked = blockedBinding(root, target.host, target.moduleKey);
      if (entryBlocked) report.warnings = ['binding ' + target.module + ' has the uncertain debugger operation ' + entryBlocked.operationId +
        ': no debug session is started on it; trace=none and client trace run without one'];
      const scenarios = scenarioPlan(resolution, input);
      if (mode !== 'none') await crossModuleHook();
      const trace = tracePlan(input, target, resolution, graph, captures, mode);
      const login = loginSpec(parsed, target.module), entry = entrySpec(graph, resolution, parsed, target.module);
      const appDefinition = published.pins.find(p => p.name === target.module + '.appDefinition.js');
      if (!appDefinition) fail('debug_o11_native_app_definition_unresolved');
      const contract = { schema: 'ssam-o11-native-entry-source/2', selector: input.action,
        target: { lane: 'o11', host: target.host, runtimeUrl: target.runtimeUrl, module: target.module, moduleKey: target.moduleKey,
          applicationKey: target.applicationKey, publishedVersionId: entryCapture.versionId, sourceSha256: entryCapture.snapshot.sha256 },
        ...appDefinitionOf(fs.readFileSync(appDefinition.path, 'utf8')), applicationDefinition: target.module + '.appDefinition',
        snapshot: entryCapture.snapshot, inventoryProof: entryCapture.inventoryProof, moduleInfo: published.moduleInfo,
        assets: contractAssets(parsed, published.pins, target.module, login, entry), login, entry, graphSha256: graph.graphSha256 };
      const contractPath = path.join(directory, 'native-entry-source.json'); o11Write(contractPath, contract);
      const sourceContract = { path: contractPath, sha256: o11Hash(fs.readFileSync(contractPath)) };
      Object.assign(report, { sourceContract, published: { versionId: entryCapture.versionId, sourceSha256: entryCapture.snapshot.sha256 },
        entryAbi: { kind: entry.kind, method: entry.method, viewName: entry.viewName ?? null, endpoints: entry.endpoints,
          inputs: entry.inputs.map(i => ({ name: i.name, dataType: i.dataType })), outputs: entry.outputs.map(o => ({ name: o.name, dataType: o.dataType })) },
        scenarios: scenarios.map(s => ({ name: s.name, presence: s.presence })), tracePlan: trace,
        needs: { loginWindow: true, appUser: target.module + ' app user (original ' + login.viewName + ' login)', binding: { host: target.host, module: target.module, moduleKey: target.moduleKey },
          serverTrace: trace.server ? { module: trace.server.module, allowed: trace.server.allowed, reason: trace.server.reason } : null } });
      // A requested trace with no observable source refuses before any window; a partial one runs and says what is missing.
      if (mode !== 'none' && !trace.client && !trace.server?.allowed) {
        report.state = 'refused'; report.error = 'debug_o11_native_trace_unavailable:' + (trace.server?.reason ?? 'no_client_or_server_frames'); return report;
      }
      if (input.op === 'prepare') { report.state = 'prepared'; return report; }

      // ---- run ----
      sessionId = randomUUID().replaceAll('-', '');
      report.state = 'sign-in'; save();
      const entered = await prepareUser({ lane: 'o11', ...target, seconds: 600 }, { sessionId });
      if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; report.error = entered?.error ?? 'debug_app_user_failed'; return report; }
      descriptor = entered.descriptor;
      const binding = appUserBinding({ lane: 'o11', ...target }, sessionId);
      if (descriptor?.state !== 'credentials-entered' || !sameAppUserTarget(descriptor.binding, binding) || !(Date.parse(descriptor.expiresAt) > Date.now()))
        fail('debug_o11_native_app_user_scope_mismatch');
      const broker = services.nativeBroker ?? (await import('./debug-o11-native-entry.mjs')).createO11NativeEntryBroker({ root });
      handle = await broker.prepare({ target: { lane: 'o11', ...target }, sourceContract, action: input.action, sessionId,
        timeoutSeconds: input.timeoutSeconds, directory });
      report.state = 'authenticating'; save();
      const authenticated = await handle.authenticate(descriptor);
      if (!authenticated?.ok || authenticated.authenticated !== true) fail('debug_o11_native_login_rejected');
      report.appUserAuthenticated = true;
      if (trace.server?.allowed) {
        const traced = scenarios.length;
        const started = await debug({ op: 'start', lane: 'o11', tenant: target.host, module: trace.server.module, moduleKey: trace.server.moduleKey,
          runtimeUrl: trace.server.runtimeUrl, o11Auth: { applicationKey: trace.server.applicationKey, publishedVersionId: trace.server.publishedVersionId,
            publishedProof: trace.server.publishedProof }, nodeKeys: trace.server.nodeKeys, seconds: Math.min(600, 60 + traced * (input.timeoutSeconds + 15)),
          pauseSeconds: 5, autoContinue: true, paths: [], trace: { mode: 'step', steps: Math.min(2000, trace.server.stepsPerScenario * traced),
            depth: 2, fullValues: mode === 'full', focusFunctionKey: trace.server.functionKey, requireFunctionKey: trace.server.functionKey,
            scopes: trace.server.scopes } }, { appUser: descriptor,
          ...(trace.server.crossModule ? { appUserEntry: { module: target.module, moduleKey: target.moduleKey } } : {}) });
        traceSession = started?.sessionId ?? null;
        report.serverTrace = { sessionId: traceSession, state: started?.state ?? null };
        if (!started?.ok || started.state !== 'connected') { if (traceSession) uncertain = true; fail('debug_o11_native_server_trace_not_connected'); }
      }
      report.state = 'invoking'; save();
      const allowed = new Set(entry.endpoints);
      for (const scenario of scenarios) {
        const before = traceSession ? traceRead(traceSession).length : 0;
        let reply;
        try {
          reply = await handle.invoke({ scenario: { name: scenario.name, values: scenario.values, screen: scenario.screen, trace: trace.client ? mode : 'none' },
            beforeRequest: async submission => {
              if (!sameAppUserTarget(submission?.binding, binding) || submission.sessionId !== sessionId || submission.sourceContractSha256 !== sourceContract.sha256 ||
                  submission.scenario !== scenario.name || !allowed.has(submission.endpoint) || !(Date.parse(descriptor.expiresAt) > Date.now()))
                fail('debug_o11_native_request_scope_mismatch');
            } });
        } catch (error) {
          report.results.push({ name: scenario.name, ok: false, uncertain: true, error: o11NativePublicCode(error?.message, 'debug_o11_native_execution_failed') });
          uncertain = true; break;
        }
        const result = reply?.scenario ?? { name: scenario.name, ok: false, uncertain: true };
        if (traceSession) { await settle(traceSession, before); const lines = traceRead(traceSession).slice(before);
          result.serverMap = compactServerMap(lines); result.serverThreadEnded = lines.some(l => l.kind === 'thread-end'); }
        result.presence = scenario.presence;
        report.results.push(result);
        if (result.uncertain) { uncertain = true; break; } // never resend; remaining scenarios are not sent
      }
      report.notSent = scenarios.slice(report.results.length).map(s => s.name);
      report.state = 'answered';
      return report;
    } catch (error) {
      report.error = CAPTURE_ERRORS.has(error?.message) || /^(debug_o11_native_|debug_app_user_)[a-z0-9_:.@-]+$/i.test(error?.message ?? '') ? error.message : o11NativePublicCode(error?.message, 'debug_o11_native_execution_failed');
      // A refused sign-in names the account it tried, masked (debug-guidance.mjs maskUser), for DEBUG_APP_USER_SIGN_IN_FAILED.
      const user = descriptor?.userHint ?? error?.signIn?.user;
      if (typeof user === 'string' && SIGN_IN_FAILURES.includes(report.error)) report.signInUser = user;
      report.state = report.state === 'resolving' ? 'refused' : 'failed-or-uncertain';
      return report;
    } finally {
      if (traceSession) { let stopped; try { stopped = await debug({ op: 'stop', sessionId: traceSession }); } catch { stopped = { ok: false }; }
        report.serverTrace.stopped = stopped?.ok === true; if (!stopped?.ok) uncertain = true; }
      if (handle) { try { await handle.dispose(); } catch { uncertain = true; }
        try { const r = handle.receipt(); report.worker = { memoryCleared: r.memoryCleared === true, requestUncertain: r.requestUncertain === true,
          loginUncertain: r.loginUncertain === true, submitted: r.requestSubmittedCount ?? 0, answered: r.requestAnsweredCount ?? 0 };
          if (r.requestUncertain || r.loginUncertain) uncertain = true; } catch { uncertain = true; } }
      if (descriptor) { try { report.credentialsReleased = (await releaseUser(descriptor))?.ok === true; } catch { report.credentialsReleased = false; } }
      report.uncertain = uncertain;
      report.ok = ['answered', 'prepared'].includes(report.state) && !uncertain && (report.credentialsReleased !== false) &&
        report.results.every(r => r.ok !== false || r.exception);
      if (ownsLock) { report.lockRetained = uncertain; if (!uncertain) try { fs.unlinkSync(lockPath); } catch { report.lockRetained = true; } }
      if (fs.existsSync(directory)) save();
    }
  };
}

// Server trace lines (kernel trace.jsonl) of one scenario -> visits with value deltas per frame.
export function compactServerMap(entries) {
  const last = new Map();
  return entries.filter(e => e.kind !== 'thread-end').map(entry => {
    const scope = [entry.threadId, entry.functionKey ?? entry.action].join('|');
    const previous = last.get(scope), current = new Map((entry.values ?? []).map(v => [v.path, JSON.stringify(v)]));
    last.set(scope, current);
    const values = previous ? (entry.values ?? []).filter(v => previous.get(v.path) !== current.get(v.path)) : entry.values ?? [];
    const { values: _, threadId: __, eventId: ___, ...rest } = entry;
    return { ...rest, ...(previous ? { changed: values } : { values }) };
  });
}

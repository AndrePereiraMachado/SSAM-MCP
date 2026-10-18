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
// request isolation is not proved. A historical uncertain binding requires a verified native neutralization record.
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { o11Read, o11Write, o11Hash } from './debug-o11-lifecycle.mjs';
import { parseO11Assets, hostViewName, amdClosure, canonicalScenario, o11SensitiveName, o11InputClassFor } from './debug-o11-native-abi.mjs';
import { classifyEntryResponse } from './debug-o11-request-hold.mjs';
import { graphFromReadings, graphFromAssets, buildO11CallGraph, resolveO11Entry, RUNNABLE_ENTRIES } from './debug-o11-entry-graph.mjs';
import { appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { o11NativePublicCode } from './debug-o11-native-entry.mjs';
import { SIGN_IN_FAILURES } from './debug-guidance.mjs';
import { validateO11PublicationProof } from './debug-o11-auth.mjs';
import { actionModel, traceWindow, scopeRoots } from './debug-wrapper.mjs'; // pure model helpers only; no wrapper path
import { canonicalO11Context } from './debug-o11-native-context.mjs';
import { buildNativeEndpointRequest } from './debug-native-endpoint.mjs';
import { buildNativeSoapRequest } from './debug-native-endpoint-soap.mjs';
import { hasO11NativeNeutralization } from './debug-o11-native-neutralization.mjs';
import { resolveO11TraceRuntime } from './debug-o11-call-boundary.mjs';
import { acquireTraditionalPreparation, acquireTraditionalScreenAction, traditionalRequest } from './debug-o11-traditional.mjs';
import { prepareTraditionalInteractive } from './debug-o11-traditional-interactive.mjs';
import { deriveO11CallbackScopes, withO11CallbackTrace, o11CallbackFunctionKeys } from './debug-o11-native-callbacks.mjs';
import { backgroundThreadOutcome } from './debug-background-correlation.mjs';
import { deriveServiceCaller } from './debug-o11-service-caller.mjs';
import { nativeTreeComplete } from './debug-native-model.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/, KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SERVER_TARGETS = new Set(['ServerAction', 'ServiceAction', 'DataAction', 'Preparation', 'RestServiceAction', 'RestAPIMethod', 'RestMethod', 'SOAPServiceAction', 'SoapServiceAction', 'WebServiceMethod']);
// Lifecycle capture codes carry no SDK text or credentials: kept as-is, never replaced by a generic execution error.
const CAPTURE_ERRORS = new Set([
  'debug_o11_run_inventory_stale_or_mismatched', 'debug_o11_run_module_scope_mismatch',
  'debug_o11_run_snapshot_scope_mismatch', 'debug_o11_run_cli_unavailable',
  'debug_o11_run_cli_invalid_response', 'debug_o11_run_cli_refused',
  'debug_o11_run_model_read_incomplete', 'debug_o11_run_source_changed',
]);
const MODEL_ACTION_KEY = /^[A-Za-z0-9_+]{22}(?:\.#Preparation)?$/;
const NATIVE_ENTRIES_PROJECTION = 'callbacks-and-block-instances/2';
// Kinds added after 'soap-webservice-and-preparation/1': REST/SOAP callback flows (native-callback edges) and
// same-module block instances (block-render edges). An older v4 cache re-reads only these and the entry kinds.
const PROJECTION_KINDS = ['Preparation', 'WebServiceMethod', 'RestService', 'RestServiceAuthenticationFlow', 'RestServiceCallbackActionFlow',
  'RestCallbackActionFlow', 'SOAPCallbackActionFlow', 'WebBlockInstanceWidget'];

// The operation remains non-replayable. A pinned observation may establish that
// its former native debugger is inactive, permitting NEW operations only.
// Independent local blocked-bindings entries remain authoritative.
export const BLOCKED_BINDINGS = Object.freeze([
  Object.freeze({ host: 'personal-2qqw9srv.outsystemscloud.com', moduleKey: 'Mif02PxcH0K7KiABEHTwMg', module: 'Headless_UI',
    operationId: '4c7016f0a51445108b185fdcd0109586', reason: 'uncertain native Start/Stop; never repeat; new operations require verified native neutralization',
    // The breakpoint that uncertain Start asked for (StartNode of Common/UserInfo/DataAction:SSAM_DebugServiceContextFromServer):
    // a call path through it is refused even without trace, so a stale server session could never suspend our request.
    nodeKeys: Object.freeze(['LiCk5pmr6Ueb45499t9tNw']) }),
]);
export const bindingHash = (host, moduleKey) => sha('o11|https://' + host.toLowerCase() + '|' + moduleKey);
export function blockedBinding(root, host, moduleKey) {
  const fixed = BLOCKED_BINDINGS.find(b => b.host === host && b.moduleKey === moduleKey);
  const neutralized = fixed && hasO11NativeNeutralization(root, { lane: 'o11', host, moduleKey, operationId: fixed.operationId });
  if (fixed && !neutralized) return { ...fixed, source: 'code' };
  const file = path.join(root, '.local', 'debugger', 'blocked-bindings', bindingHash(host, moduleKey) + '.json');
  if (fs.existsSync(file)) { let value = {}; try { value = o11Read(file); } catch { /* unreadable stays blocked */ }
    if (neutralized && value.operationId === fixed.operationId) return null;
    return { host, moduleKey, operationId: value.operationId ?? null, reason: 'local blocked-bindings registry', source: 'registry' }; }
  return null;
}
export function rejectUncertainCallPath(graph, startId, host, root = workspaceRoot) {
  const seen = new Set(), pending = [startId];
  while (pending.length) {
    const id = pending.pop(); if (seen.has(id)) continue; seen.add(id);
    const node = graph.nodes.get(id);
    const blocked = node?.moduleKey && blockedBinding(root, host, node.moduleKey);
    if (blocked?.nodeKeys?.includes(node.startNodeKey)) fail('debug_o11_native_path_crosses_uncertain_breakpoint:' + blocked.operationId);
    for (const edge of graph.callees.get(id) ?? []) pending.push(edge.to);
  }
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
// Endpoints a client-action entry may POST: the stubs and data actions it reaches through client calls (same module).
function reachableEndpoints(graph, startId) {
  const seen = new Set([startId]), stack = [startId], endpoints = {};
  while (stack.length) {
    const id = stack.pop(), node = graph.nodes.get(id);
    if (node?.abi?.endpoint && node.abi.apiVersion) endpoints[node.abi.endpoint] = node.abi.apiVersion;
    if (node && !['ClientAction', 'ScreenAction'].includes(node.kind) && id !== startId) continue; // stop at server boundaries
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
  if (!moduleLevel) {
    const screen = Object.values(parsed.components).filter(c => c.screen && c.viewName === factories.viewName);
    if (screen.length !== 1) fail('debug_o11_native_host_screen_unresolved');
    factories.hostScreen = { modelFactory: screen[0].amd + '.mvc$model', controllerFactory: screen[0].amd + '.mvc$controller', viewName: factories.viewName };
    factories.context = { screen: screen[0].context ?? { inputs: [], variables: [] },
      ...(!component.screen ? { block: component.context ?? { inputs: [], variables: [] } } : {}) };
  }
  // A basic list resolves to the runtime OS.DataTypes.<X>List ({runtimeList, element}); records to their published class.
  const typed = list => (list ?? []).map(i => {
    const model = node.inputs?.find(m => m.name === i.name);
    const cls = o11InputClassFor(parsed, module, { name: i.name, dataType: i.dataType, modelType: model?.modelType, complexType: i.complexType });
    return { name: i.name, param: i.param, dataType: i.dataType, ...(cls ?? {}) };
  });
  const absolute = endpoint => '/' + module + '/' + endpoint.replace(/^\/+/, '');
  if (node.entry === 'client-action') {
    const reach = reachableEndpoints(graph, node.id);
    const screenVariables = (resolution.bindings ?? []).filter(b => b.class === 'screen-variable' && b.controllable)
      .map(b => { const v = component?.variables?.find(v => v.attribute === b.screenVariable);
        return v ? { ...v, name: b.input, ownerName: v.name } : null; }).filter(Boolean);
    const events = (component?.lifecycle ?? []).filter(e => e.method === abi.method);
    const lifecycle = events.length === 1 && !(abi.inputs?.length || abi.outputs?.length) ? events[0] : null;
    return { kind: 'client-action', controller: abi.controller, moduleLevel, ...factories, method: abi.method, actionKey: node.key,
      endpoints: Object.keys(reach).map(absolute).sort(), endpointVersions: Object.fromEntries(Object.entries(reach).map(([e, v]) => [absolute(e), v])),
      inputs: typed(abi.inputs), outputs: (abi.outputs ?? []).map(o => ({ name: o.name, attribute: o.attribute, dataType: o.dataType })), screenVariables,
      ...(lifecycle ? { lifecycle } : {}) };
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
    ...(entry.hostScreen ? [entry.hostScreen.modelFactory, entry.hostScreen.controllerFactory] : []),
    ...entry.inputs.map(i => i.recordClass).filter(Boolean),
    ...(entry.screenVariables ?? []).map(i => i.recordClass).filter(Boolean),
    ...Object.values(entry.context ?? {}).flatMap(c => [...c.inputs, ...c.variables].map(i => i.recordClass).filter(Boolean))];
  const closure = amdClosure(parsed, roots);
  if (closure.missing.length) fail('debug_o11_native_asset_dependency_missing:' + closure.missing[0]);
  const first = ['OutSystems.js', 'OutSystemsSettings.js', 'Debugger.js'];
  const names = [...new Set([...first.filter(n => closure.assets.includes(n) || n === 'OutSystems.js'), ...closure.assets])];
  return names.map(name => { const pin = pins.find(p => p.name === name); if (!pin) fail('debug_o11_native_assets_invalid');
    return { name, path: pin.path, sha256: pin.sha256, urlPath: pin.urlPath, query: pin.query, execute: true }; });
}

// Scenario inputs are named after the TARGET's inputs; bindings say which entry input (or screen variable) carries each.
// With the published assets, records are typed by their schema; identifiers always by the recorded entity base.
export function scenarioPlan(resolution, input, entry, { parsed, module } = {}) {
  const target = resolution.path.at(-1), bindings = resolution.bindings ?? [];
  const raw = input.scenarios ?? [{ name: 'call', inputs: input.inputs ?? {} }];
  const names = raw.map((s, i) => s.name ?? 'scenario-' + (i + 1));
  if (new Set(names).size !== names.length) fail('debug_o11_native_duplicate_scenarios');
  const parameters = bindings.map(b => { const t = resolution.targetInputs?.find(x => x.name === b.input);
    return { name: b.input, modelType: t?.modelType ?? null, dataType: t?.dataType ?? null, identifierBase: t?.identifierBase ?? null,
      mandatory: false, controllable: b.controllable }; });
  const typing = parsed ? { schemas: parsed.classes, classFor: p => o11InputClassFor(parsed, module, p) } : {};
  return raw.map((scenario, i) => {
    for (const name of Object.keys(scenario.inputs ?? {})) if (o11SensitiveName(name)) fail('debug_o11_native_input_private_or_invalid:' + name);
    const { values, presence } = canonicalScenario(parameters, scenario.inputs ?? {}, typing);
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
    const context = canonicalO11Context(entry?.context, scenario.context ?? input.context);
    for (const variable of entry?.screenVariables ?? []) {
      const owner = entry.context?.block ? 'block' : 'screen';
      const explicit = context?.[owner]?.variables?.[variable.ownerName] ?? context?.[owner]?.inputs?.[variable.ownerName];
      if (Object.hasOwn(screen, variable.name) && explicit !== undefined && JSON.stringify(explicit) !== JSON.stringify(screen[variable.name]))
        fail('debug_o11_native_context_conflict');
    }
    return { name: names[i], target: target.name, values: entryValues, screen, presence, ...(context ? { context } : {}) };
  });
}

// ---- default live services (not exercised offline) --------------------------------------------------------
const MODEL_KINDS = ['ServerAction', 'ServiceAction', 'ClientAction', 'ScreenAction', 'Preparation', 'DataAction', 'Timer',
  'RestServiceAction', 'RestAPIMethod', 'RestMethod', 'SoapServiceAction', 'SOAPServiceAction', 'WebServiceMethod', 'Process', 'ProcessFlow', 'ServerActionSignature', 'ServiceActionSignature',
  'RestService', 'RestServiceAuthenticationFlow', 'RestServiceCallbackActionFlow', 'RestCallbackActionFlow', 'SOAPCallbackActionFlow', 'WebBlockInstanceWidget'];
// A per-entry projection is complete only without truncation markers at any depth (nativeTreeComplete) and, when it
// carries its source hash, for this capture. A silently truncated or foreign read never becomes a checkpoint or graph.
const completeReading = (reading, base) => !(reading?.sourceSha256 && String(reading.sourceSha256).toLowerCase() !== base.sha256.toLowerCase()) &&
  nativeTreeComplete(reading?.tree ?? reading, 'o11');
export async function captureO11NativeModel(root, target, directory, services = {}) {
  services.checkActive?.();
  const { createO11Lifecycle } = await import('./debug-o11-lifecycle.mjs');
  const { debugO11Reading, selectedO11DebugReader } = await import('./debug-o11-reader.mjs');
  const readerGeneration = (services.selectReader ?? selectedO11DebugReader)({ root }).generation;
  const lifecycle = services.lifecycle ?? createO11Lifecycle({ root });
  const base = await lifecycle.snapshot(target, directory);
  services.checkActive?.();
  // The published capture is immutable per sha256: its readings are reused by later prepare/run calls.
  const cache = path.join(root, '.local', 'debugger', 'native-runs', 'o11', 'model-cache', base.sha256 + '.json');
  let previousReadings = [], kinds = MODEL_KINDS;
  if (fs.existsSync(cache)) {
    const cached = o11Read(cache), kindOf = r => (r.tree ?? r)?.kind;
    // Cached projections are re-verified: a truncated or foreign one is re-read (its kind relisted), never reused.
    const incomplete = new Set(Array.isArray(cached.readings) ? cached.readings.filter(r => !completeReading(r, base)) : []);
    const stale = [...new Set([...incomplete].map(kindOf))], retry = stale.every(k => MODEL_KINDS.includes(k)) ? stale : MODEL_KINDS;
    const kept = drop => cached.readings.filter(r => !incomplete.has(r) && !drop.includes(kindOf(r)));
    const v4 = cached.schema === 'ssam-o11-native-model-cache/4' && cached.readerGeneration === readerGeneration && cached.sourceSha256 === base.sha256 && Array.isArray(cached.readings);
    if (v4 && cached.nativeEntriesProjection === NATIVE_ENTRIES_PROJECTION) {
      if (!incomplete.size) return { versionId: base.versionId, snapshot: { path: base.file, sha256: base.sha256 }, inventoryProof: base.proof, readings: cached.readings };
      previousReadings = kept([]); kinds = retry;
    } else if (v4) {
      previousReadings = kept(PROJECTION_KINDS);
      kinds = [...new Set([...PROJECTION_KINDS, ...retry])];
    }
    if (['ssam-o11-native-model-cache/2', 'ssam-o11-native-model-cache/3'].includes(cached.schema) && cached.sourceSha256 === base.sha256 && Array.isArray(cached.readings)) {
      // Old readers omitted owned process nodes and native trigger identities. Preserve unrelated immutable trees.
      previousReadings = kept(['Process', 'ProcessFlow', 'Timer', ...PROJECTION_KINDS]);
      kinds = [...new Set(['Process', 'ProcessFlow', 'Timer', ...PROJECTION_KINDS, ...(cached.schema.endsWith('/2') ? ['SOAPServiceAction'] : []), ...retry])];
    }
    // A v4 generation mismatch may change any projection, so reread all kinds.
  }
  const readings = [...previousReadings], seen = new Set(readings.map(r => (r.tree ?? r)?.key).filter(Boolean));
  // A cold producer may take longer than the client's preparation deadline.
  // Preserve each completed, immutable action projection without treating a
  // partial capture as a complete call graph. Separate files avoid rewriting
  // the entire growing model on every checkpoint.
  const parts = path.join(cache + '.parts', sha(JSON.stringify([readerGeneration, NATIVE_ENTRIES_PROJECTION])));
  for (const kind of kinds) {
    for (let offset = 0, guard = 0; offset !== null && guard < 40; guard++) {
      services.checkActive?.();
      const listed = await (services.modelRead ?? debugO11Reading)(['--oml', base.file, '--kind', kind, '--depth', '0', '--max', '500', '--offset', String(offset),
        '--properties', 'Name', '--expectedSourceSha256', base.sha256]);
      const data = listed.data?.out ? o11Read(listed.data.out) : listed.data;
      if (!listed.ok || data?.searchComplete !== true) fail('debug_o11_native_model_read_incomplete');
      for (const entry of data.entries ?? []) if (MODEL_ACTION_KEY.test(entry.key ?? '') && !seen.has(entry.key)) {
        services.checkActive?.();
        const partFile = path.join(parts, sha(entry.key) + '.json');
        let tree;
        if (fs.existsSync(partFile)) {
          const part = o11Read(partFile);
          if (part.schema === 'ssam-o11-native-model-part/1' && part.readerGeneration === readerGeneration &&
              part.nativeEntriesProjection === NATIVE_ENTRIES_PROJECTION && part.sourceSha256 === base.sha256 &&
              (part.tree?.tree ?? part.tree)?.key === entry.key && completeReading(part.tree, base)) tree = part.tree;
        }
        if (!tree) {
          tree = await lifecycle.readTree(base, '@' + entry.key);
          if ((tree?.tree ?? tree)?.key !== entry.key) fail('debug_o11_native_model_read_identity_mismatch');
          if (!completeReading(tree, base)) fail('debug_o11_native_model_read_incomplete');
          o11Write(partFile, { schema: 'ssam-o11-native-model-part/1', readerGeneration,
            nativeEntriesProjection: NATIVE_ENTRIES_PROJECTION, sourceSha256: base.sha256, tree });
        }
        seen.add(entry.key); readings.push(tree);
      }
      offset = Number.isSafeInteger(data.nextOffset) ? data.nextOffset : null;
      if (offset !== null && guard === 39) fail('debug_o11_native_model_read_incomplete');
    }
  }
  o11Write(cache, { schema: 'ssam-o11-native-model-cache/4', readerGeneration, nativeEntriesProjection: NATIVE_ENTRIES_PROJECTION, sourceSha256: base.sha256, module: target.module, moduleKey: target.moduleKey, readings });
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

// ---- runner -----------------------------------------------------------------------------------------------
export function createO11NativeRun(services = {}) {
  const root = services.root ?? workspaceRoot;
  const capture = services.capture ?? ((target, directory) => captureO11NativeModel(root, target, directory, services));
  const assets = services.assets ?? (input => acquireO11PublicAssets(input));
  async function refreshExpiredProofs(captures, directory) {
    for (const owner of captures) {
      const read = pin => {
        const bytes = fs.readFileSync(pin.path);
        if (o11Hash(bytes) !== pin.sha256) fail('debug_o11_native_inventory_changed');
        return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      };
      const binding = { ...owner.target, publishedVersionId: owner.versionId };
      const previous = read(owner.inventoryProof);
      try { validateO11PublicationProof(binding, previous); continue; }
      catch (error) { if (error.message !== 'debug_o11_publication_proof_stale') throw error; }
      const captured = Date.parse(Object.entries(previous).find(([key]) => key.toLowerCase() === 'capturedatutc')?.[1]);
      // Renew elapsed evidence only. Malformed/future dates or a different model
      // identity must never be repaired by silently adopting the current module.
      if (!Number.isFinite(captured) || captured > Date.now()) fail('debug_o11_publication_proof_stale');
      validateO11PublicationProof(binding, previous, captured);
      const lifecycle = services.lifecycle ?? (await import('./debug-o11-lifecycle.mjs')).createO11Lifecycle({ root });
      const current = await lifecycle.inventory(owner.target, path.join(directory, 'refreshed-publication', owner.target.module));
      if (current.versionId !== owner.versionId) fail('debug_o11_native_published_version_changed');
      validateO11PublicationProof(binding, read(current.proof));
      owner.inventoryProof = current.proof;
    }
  }
  const prepareUser = services.prepareUser ?? (async (...a) => (await import('./debug-app-user.mjs')).prepareDebugAppUser(...a));
  const releaseUser = services.releaseUser ?? (async (...a) => (await import('./debug-app-user.mjs')).releaseDebugAppUser(...a));
  const prepareEndpointCredential = services.prepareEndpointCredential ?? (async (...a) => (await import('./debug-app-user.mjs')).prepareEndpointCredential(...a));
  const releaseEndpointCredential = services.releaseEndpointCredential ?? (async (...a) => (await import('./debug-app-user.mjs')).releaseEndpointCredential(...a));
  const debug = services.debug ?? (async (input, context) => (await import('./debug-runtime.mjs')).headlessDebug(input, context));
  const acquireEndpoint = services.acquireEndpoint ?? (async ({ owner, entry, binding }) => {
    const { acquireNativeRestEntry } = await import('./debug-native-endpoint-acquire.mjs');
    const { acquireNativeSoapEntry } = await import('./debug-native-endpoint-soap.mjs');
    const { createO11Lifecycle } = await import('./debug-o11-lifecycle.mjs');
    const lifecycle = createO11Lifecycle({ root });
    const acquire = entry.entry === 'soap-method' ? acquireNativeSoapEntry : acquireNativeRestEntry;
    if (typeof acquire !== 'function') fail('debug_native_endpoint_published_wsdl_acquisition_unavailable');
    return acquire({ binding, entry, sourceContract: owner.snapshot,
      readTree: selector => lifecycle.readTree({ file: owner.snapshot.path, sha256: owner.snapshot.sha256 }, selector) });
  });
  const endpointPublicationCheck = services.endpointPublicationCheck ?? (async (owner, directory) => {
    const { createO11Lifecycle } = await import('./debug-o11-lifecycle.mjs');
    const current = await createO11Lifecycle({ root }).inventory(owner.target, directory);
    if (current.versionId !== owner.versionId) fail('debug_o11_native_publication_changed');
  });
  const invokeEndpoint = services.invokeEndpoint ?? (async input => (await import('./debug-native-endpoint-worker.mjs')).invokeNativeEndpointWorker(input));
  const acquireTraditional = services.acquireTraditional ?? (input => acquireTraditionalPreparation({ ...input, root }));
  const acquireTraditionalAction = services.acquireTraditionalScreenAction ?? (input => acquireTraditionalScreenAction({ ...input, root }));
  // options.inspection: the coordinator's pause/resume events (pause-aware request timer, interactive only).
  const invokeTraditional = services.invokeTraditional ?? (async (input, options) => (await import('./debug-o11-traditional-worker.mjs')).invokeTraditionalWorker(input, options));
  // Producer-module trace (entry in the consumer, target in the producer) needs debug-runtime to accept the consumer's
  // app-user descriptor for redaction only; the runtime announces it with O11_CROSS_MODULE_REDACTION = true.
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
  const observeBackground = services.observeBackground ?? (async (sessionId, functionKey, seconds) => {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(500, deadline - Date.now())));
      // A ThreadEnd counts only for the same (threadId, native request fingerprint) and a later eventId.
      if (backgroundThreadOutcome(traceRead(sessionId), functionKey).observedThreadEnds > 0) return;
    }
  });
  const folder = target => path.join(root, '.local', 'debugger', 'native-runs', 'o11', target.host);

  // progress(stage, module): published-model (per module), entry-resolution, published-assets; the receipt names the last one.
  async function resolve(input, target, directory, progress = () => {}) {
    const moduleTargets = [{ ...target }, ...(input.modules ?? []).map(m => ({ host: target.host, module: m.module, moduleKey: m.moduleKey,
      applicationKey: m.applicationKey, runtimeUrl: new URL(target.runtimeUrl).origin + '/' + m.module + '/' }))];
    if (new Set(moduleTargets.map(m => m.moduleKey)).size !== moduleTargets.length) fail('debug_o11_native_modules_duplicated');
    const captures = [];
    for (const m of moduleTargets) {
      progress('published-model', m.module);
      captures.push({ target: m, ...(await capture(m, path.join(directory, 'model', m.module))) });
    }
    const entryCapture = captures[0];
    progress('entry-resolution', target.module);
    // An argument is 'identity' only when its published binding is natively the original GetUserId() (witnessBindings, pinned
    // to module/function/source); without them every GetUserId argument stays 'derived', never controllable.
    const modelParts = captures.map(c => graphFromReadings(c.readings, { module: c.target.module, moduleKey: c.target.moduleKey,
      sourceSha256: c.snapshot?.sha256?.toLowerCase(), nativeBindings: c.witnessBindings ?? [] }));
    const modelGraph = buildO11CallGraph(modelParts), options = input.entry !== undefined ? { entry: input.entry } : {};
    const modelResolution = resolveO11Entry(modelGraph, input.action, options);
    // REST entries do not depend on a Reactive AMD runtime; Service and Traditional modules have no such assets.
    if (modelResolution.state === 'resolved' && ['rest-method', 'soap-method', 'traditional-preparation', 'traditional-screen-action'].includes(modelResolution.entry.entry))
      return { captures, entryCapture, published: null, parsed: null, graph: modelGraph, resolution: modelResolution };
    if (modelResolution.state === 'background-trigger-resolved' && ['rest-method', 'soap-method'].includes(modelResolution.originalLaunch?.entry?.entry))
      return { captures, entryCapture, published: null, parsed: null, graph: modelGraph, resolution: modelResolution };
    if (modelResolution.state === 'no-invocable-entry' && modelResolution.reachedOnlyBy?.length)
      return { captures, entryCapture, published: null, parsed: null, graph: modelGraph, resolution: modelResolution };
    progress('published-assets', target.module);
    const published = await assets({ target, versionId: entryCapture.versionId, directory: path.join(directory, 'assets') });
    progress('entry-resolution', target.module);
    const parsed = parseO11Assets(published.pins.map(p => ({ name: p.name, text: fs.readFileSync(p.path, 'utf8') })), target.module);
    const graph = buildO11CallGraph([...modelParts,
      graphFromAssets(parsed, { moduleKey: target.moduleKey })]);
    const resolution = resolveO11Entry(graph, input.action, options);
    return { captures, entryCapture, published, parsed, graph, resolution };
  }
  function tracePlan(input, target, resolution, graph, captures, mode) {
    const node = graph.nodes.get(resolution.path.at(-1).id), entryNode = graph.nodes.get(resolution.entry.id);
    const plan = { mode, client: mode !== 'none' && entryNode.entry === 'client-action', server: null };
    // A Traditional WebFlow screen action runs on the server inside its postback.
    if (mode === 'none' || !SERVER_TARGETS.has(node.kind) && !(node.kind === 'ScreenAction' && node.entry === 'traditional-screen-action')) return plan;
    const boundary = resolveO11TraceRuntime(graph, resolution, captures);
    const owner = boundary.ownerCapture, runtimeCapture = boundary.runtimeCapture;
    const server = { module: node.module, moduleKey: node.moduleKey, functionKey: node.key, startNodeKey: node.startNodeKey ?? null,
      crossModule: node.moduleKey !== target.moduleKey, allowed: true, reason: null, boundary: boundary.contract };
    const blocked = blockedBinding(root, target.host, node.moduleKey) ?? (runtimeCapture && blockedBinding(root, target.host, runtimeCapture.target.moduleKey));
    if (blocked) Object.assign(server, { allowed: false, reason: 'binding_blocked', blockedBy: blocked.operationId });
    else if (!owner || !runtimeCapture) Object.assign(server, { allowed: false, reason: 'target_module_not_captured' });
    else if (server.crossModule && !crossModuleTrace) Object.assign(server, { allowed: false, reason: 'cross_module_runtime_hook_missing' });
    else if (!KEY.test(server.startNodeKey ?? '')) Object.assign(server, { allowed: false, reason: 'target_start_node_unread' });
    if (server.allowed) {
      const tree = owner.readings.map(r => r.tree ?? r).find(t => t?.key === node.key);
      const model = tree ? actionModel(tree) : null;
      if (model && ['RestServiceAction', 'RestAPIMethod', 'RestMethod'].includes(node.kind)) {
        model.inputs = node.inputs; model.outputs = node.outputs; // Native REST parameters have their own model kinds.
      }
      const window = input.window && model ? traceWindow(model, input.window) : null;
      Object.assign(server, { nodeKeys: window?.entries ?? [server.startNodeKey], stepsPerScenario: window?.steps ?? 300,
        scopes: mode === 'full' && model ? { [node.key]: scopeRoots(model) } : {},
        applicationKey: owner.target.applicationKey, runtimeUrl: runtimeCapture.target.runtimeUrl, publishedVersionId: owner.versionId, publishedProof: owner.inventoryProof });
      if (runtimeCapture.target.moduleKey !== owner.target.moduleKey) {
        server.entry = { module: runtimeCapture.target.module, moduleKey: runtimeCapture.target.moduleKey,
          applicationKey: runtimeCapture.target.applicationKey, publishedVersionId: runtimeCapture.versionId };
        const proofs = [owner, runtimeCapture].map(c => {
          const bytes = fs.readFileSync(c.inventoryProof.path);
          if (o11Hash(bytes) !== c.inventoryProof.sha256) fail('debug_o11_native_inventory_changed');
          const proof = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
          validateO11PublicationProof({ ...c.target, publishedVersionId: c.versionId }, proof);
          const field = (value, name) => Object.entries(value).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
          return { capturedAtUtc: field(proof, 'capturedAtUtc'), modules: field(proof, 'modules').filter(row => field(row, 'Key') === c.target.moduleKey) };
        });
        const proofFile = path.join(path.dirname(owner.inventoryProof.path), 'debug-entry-inventory.json');
        o11Write(proofFile, { host: target.host, capturedAtUtc: new Date(Math.min(...proofs.map(p => Date.parse(p.capturedAtUtc)))).toISOString(),
          modules: proofs.flatMap(p => p.modules) });
        server.publishedProof = { path: proofFile, sha256: o11Hash(fs.readFileSync(proofFile)) };
      } else {
        // A Service hop with consumer scopes: the consumer keeps its own runtime URL and published row (never
        // o11Auth.entry); the Service session keeps /Service/ and its own row (debug-o11-session-group service-action).
        const caller = deriveServiceCaller(boundary, services.serverScopes, captures, { serverSession: !!services.prepareServerInspection,
          host: target.host, blocked: key => blockedBinding(root, target.host, key) });
        if (caller?.refusal) Object.assign(server, { allowed: false, reason: caller.refusal.reason, ...(caller.refusal.blockedBy ? { blockedBy: caller.refusal.blockedBy } : {}) });
        else if (caller) Object.assign(server, { serviceCaller: caller.serviceCaller, boundaryKind: 'service-action' });
      }
    }
    if (server.allowed) {
      // Runner-derived REST/SOAP callback flows reachable from the entry (same module, start node read).
      const callbacks = deriveO11CallbackScopes(graph, resolution, { moduleKey: node.moduleKey });
      Object.assign(server, withO11CallbackTrace(server, callbacks, { mode, readings: owner.readings }),
        { callbackScopes: callbacks, callbackKeys: o11CallbackFunctionKeys(graph) });
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
    const invokeDebuggerStart = async (request, context) => {
      // A returned preflight refusal is known not to own a session. A thrown
      // transport result has no such proof and must retain the runner lock.
      try {
        const result = await debug(request, context);
        if (result?.ok === false && result.state === 'not-started' && result.workerStarted === false && result.uncertain === false) {
          report.debuggerStartFailure = { sessionId: result.sessionId, receiptPath: result.receiptPath,
            state: result.state, workerStarted: false,
            error: /^debug_[a-z0-9_]{1,100}$/.test(result.error ?? '') ? result.error : 'debug_local_start_failed' };
          // Keep the failed attempt addressable without claiming a live session
          // that would require Stop or retain the execution mutex.
          return { ...result, sessionId: undefined };
        }
        return result;
      }
      catch { uncertain = true; fail('debug_o11_native_server_trace_start_uncertain'); }
    };
    // Submission time of one scenario for the coordinator's request hold: the fixed native lease end is the interactive
    // request deadline (inspection deadline bounded by the credential); outside interactive mode it is absent (NaN).
    const submission = requestId => ({ requestId, nativeDeadlineAt: Date.parse(report.serverTrace?.requestDeadline) });
    const workerUncertain = reply => !reply || typeof reply.sent !== 'boolean' || typeof reply.answered !== 'boolean' ||
      typeof reply.uncertain !== 'boolean' || reply.uncertain || reply.sent && !reply.answered ||
      reply.answered && !reply.sent || reply.ok === true && (!reply.sent || !reply.answered) ||
      reply.loginSubmitted === true && reply.loginAnswered !== true || reply.memoryReferencesReleased !== true;
    const startServerTrace = async (trace, count, { anonymous = false, endpoint = false } = {}) => {
      if (!trace.server?.allowed) return;
      if (anonymous && (trace.server.entry || trace.server.serviceCaller)) fail('debug_native_endpoint_anonymous_cross_module_trace_unqualified');
      const started = await invokeDebuggerStart({ op: anonymous ? 'watch' : 'start', lane: 'o11', tenant: target.host, module: trace.server.module, moduleKey: trace.server.moduleKey,
        runtimeUrl: trace.server.runtimeUrl, o11Auth: { applicationKey: trace.server.applicationKey, publishedVersionId: trace.server.publishedVersionId,
          publishedProof: trace.server.publishedProof, ...(trace.server.entry ? { entry: trace.server.entry } : {}) }, nodeKeys: trace.server.nodeKeys,
        seconds: endpoint && services.prepareServerInspection ? 600 : Math.min(600, 60 + count * (input.timeoutSeconds + 15)), pauseSeconds: 5, autoContinue: true, paths: [],
        trace: { mode: 'step', steps: Math.min(2000, trace.server.stepsPerScenario * count), depth: input.depth ?? 2, fullValues: mode === 'full',
          focusFunctionKey: trace.server.functionKey, requireFunctionKey: trace.server.functionKey, scopes: trace.server.scopes } },
      anonymous ? { anonymousWatch: true, contextMode: 'anonymous' } : { appUser: descriptor, redactionOnly: true });
      traceSession = started?.sessionId ?? null;
      report.serverTrace = { sessionId: traceSession, state: started?.state ?? null };
      if (!started?.ok || started.state !== 'connected') { if (traceSession) uncertain = true; fail('debug_o11_native_server_trace_not_connected'); }
      if (started.inspectionMode === 'interactive') {
        if (started.autoContinue !== false || !endpoint && typeof handle?.configureServerInspection !== 'function')
          fail('debug_o11_native_inspection_deadline_invalid');
        const deadline = Math.min(Date.parse(started.expiresAt), anonymous && endpoint ? Infinity : Date.parse(descriptor?.expiresAt));
        if (!Number.isFinite(deadline) || deadline <= Date.now()) fail('debug_o11_native_inspection_deadline_invalid');
        const expiresAt = new Date(deadline).toISOString();
        if (!endpoint) {
          const configured = await handle.configureServerInspection({ expiresAt });
          if (configured?.configured !== true || configured.expiresAt !== expiresAt) fail('debug_o11_native_inspection_deadline_invalid');
        }
        Object.assign(report.serverTrace, { inspectionMode: 'interactive', requestDeadline: expiresAt });
      }
    };
    try {
      if (input.contextMode === 'native-background') (await import('./debug-o11-bpt-run.mjs')).refuseRetainedBackgroundBinding({ host: target.host,
        moduleKey: target.moduleKey, kind: input.trigger === 'service-center-run-now' ? 'timer' : undefined });
      if (fs.existsSync(lockPath)) fail('debug_o11_native_binding_busy');
      fs.mkdirSync(directory, { recursive: true });
      if (input.op === 'run') { const fd = fs.openSync(lockPath, 'wx'); ownsLock = true;
        fs.writeFileSync(fd, JSON.stringify({ operationId, pid: process.pid })); fs.closeSync(fd); }
      save();
      const { captures, entryCapture, published, parsed, graph, resolution } = await resolve(input, target, directory,
        (stage, module) => { report.preparation = { stage, module }; save(); });
      services.checkActive?.();
      if (services.requireClientInspection && resolution.entry?.entry !== 'client-action')
        fail('debug_o11_native_client_inspection_entry_required');
      const interactiveTimer = services.prepareServerInspection && input.contextMode === 'native-background' && (input.launch &&
        resolution.state === 'background-trigger-resolved' && resolution.background?.timerKey ||
        // A Timer without a REST/SOAP caller, triggered once by Service Center Run Now (debug-o11-runnow-interactive).
        input.trigger === 'service-center-run-now' && !input.launch && resolution.state === 'no-invocable-entry' && resolution.reachedOnlyBy?.length);
      if (services.prepareServerInspection && !interactiveTimer && (resolution.state !== 'resolved' ||
          !['server-stub', 'data-action', 'client-action', 'rest-method', 'soap-method', 'traditional-preparation', 'traditional-screen-action'].includes(resolution.entry?.entry)))
        fail('debug_o11_native_server_inspection_entry_required');
      Object.assign(report, { graphSha256: graph.graphSha256, resolution: { state: resolution.state, message: resolution.message ?? null,
        entry: resolution.entry ?? null, distance: resolution.distance ?? null, callPath: resolution.callPath ?? null, path: resolution.path ?? null,
        bindings: resolution.bindings ?? [], candidatesAtDistance: resolution.candidatesAtDistance ?? [], algorithm: resolution.algorithm,
        priority: resolution.priority, override: resolution.override ?? false, ...(resolution.reachedOnlyBy ? { reachedOnlyBy: resolution.reachedOnlyBy } : {}),
        ...(resolution.candidates ? { candidates: resolution.candidates } : {}),
        ...(resolution.originalLaunch ? { originalLaunch: resolution.originalLaunch } : {}),
        ...(resolution.background ? { background: resolution.background } : {}) } });
      if (input.launch && resolution.state !== 'background-trigger-resolved')
        fail('debug_native_background_bpt_automatic_flow_required');
      if (input.launch && resolution.state === 'background-trigger-resolved') {
        // The launcher may make side calls outside the selected asynchronous
        // path. Apply the same historical-breakpoint guard as interactive runs.
        rejectUncertainCallPath(graph, resolution.originalLaunch?.entry?.id, target.host, root);
        const { runO11BptOriginalLaunch } = await import('./debug-o11-bpt-run.mjs');
        const outcome = await runO11BptOriginalLaunch({ input, target, resolution, graph, captures, mode, root, directory, operationId,
          report, save, debug, acquireEndpoint, invokeEndpoint, endpointPublicationCheck,
          prepareUser, releaseUser, traceRead, observeBackground, compactServerMap,
          prepareServerInspection: services.prepareServerInspection, beforeServerInvocation: services.beforeServerInvocation,
          timerInstance: services.timerInstance, scopeEvidence: services.scopeEvidence, bptNativeScopes: services.bptNativeScopes });
        uncertain ||= outcome.uncertain;
        return report;
      }
      if (resolution.state === 'background-trigger-resolved' || resolution.state === 'resolved' && resolution.target?.kind === 'ProcessLaunchAction') {
        // A scheduler launcher and the eventual activity have different inputs, lifetimes and user contexts.
        // Publish a reviewable launch plan; never feed activity inputs into an arbitrary app entry.
        const originalLaunch = resolution.originalLaunch ?? { ...resolution,
          entryInputs: graph.nodes.get(resolution.entry.id).inputs, entryAbiObserved: !!graph.nodes.get(resolution.entry.id).abi };
        const timerWake = resolution.background?.kind === 'timer-original-wake';
        report.background = { kind: timerWake ? 'timer-original-wake' : 'process-original-launch', launcherContext: 'app-user', activityContext: 'native-background',
          directActivityInvocation: false, requestOwnershipProved: false, executionCompleted: false, ...resolution.background,
          originalLaunch, originalEntryResolved: !!originalLaunch,
          executable: false, missingCapability: timerWake ? 'explicit original-launcher input contract; timer execution ownership is not established by function frames'
            : 'explicit original-launcher input contract plus native ProcessId/instance correlation' };
        report.needs = { loginWindow: true, launcherContextMode: 'app-user', activityContextMode: 'native-background', words: true,
          inputContract: 'originalLaunch.entryInputs; activity inputs cannot be substituted' };
        if (input.op === 'prepare') report.state = 'prepared';
        else { report.state = 'entry-not-runnable'; report.error = timerWake ? 'debug_native_background_timer_original_launcher_contract_required'
          : 'debug_native_background_bpt_original_launcher_contract_required'; }
        return report;
      }
      if (resolution.state === 'no-invocable-entry' && resolution.reachedOnlyBy?.length) {
        const reached = graph.nodes.get(resolution.reachedOnlyBy[0].id);
        const candidate = reached?.processOwnerKey ? graph.nodes.get(reached.moduleKey + '*' + reached.processOwnerKey) : reached;
        const owner = captures.find(c => c.target.moduleKey === candidate?.moduleKey);
        if (!owner || candidate.moduleKey !== target.moduleKey) fail('debug_native_background_entry_module_must_be_runtime_target');
        const original = owner.readings.find(r => (r.tree ?? r)?.key === candidate.key);
        if (!original) fail('debug_native_background_model_unavailable');
        rejectUncertainCallPath(graph, candidate.id, target.host, root);
        await refreshExpiredProofs(captures, directory);
        let bytes = fs.readFileSync(owner.inventoryProof.path);
        if (o11Hash(bytes) !== owner.inventoryProof.sha256) fail('debug_o11_native_inventory_changed');
        let inventory = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        validateO11PublicationProof({ ...owner.target, publishedVersionId: owner.versionId }, inventory);
        const field = (value, name) => Object.entries(value).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
        let row = field(inventory, 'modules').find(row => field(row, 'Key') === candidate.moduleKey);
        if (candidate.kind === 'Timer' && field(row, 'ModuleId') == null) {
          const { createO11Lifecycle } = await import('./debug-o11-lifecycle.mjs');
          const lifecycle = services.lifecycle ?? createO11Lifecycle({ root });
          const fresh = await lifecycle.inventory(owner.target, path.join(directory, 'background-module-identity'), { requireModuleId: true });
          if (fresh.versionId !== owner.versionId) fail('debug_o11_native_published_version_changed');
          owner.inventoryProof = fresh.proof;
          bytes = fs.readFileSync(fresh.proof.path);
          if (o11Hash(bytes) !== fresh.proof.sha256) fail('debug_o11_native_inventory_changed');
          inventory = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
          validateO11PublicationProof({ ...owner.target, publishedVersionId: owner.versionId }, inventory);
          row = field(inventory, 'modules').find(row => field(row, 'Key') === candidate.moduleKey);
          if (field(row, 'ModuleId') == null) fail('debug_native_background_native_module_id_unavailable');
        }
        const { prepareNativeBackground, createNativeBackgroundAdapter } = await import('./debug-native-background.mjs');
        const model = original.schema === 'ssam-reading/1' ? original : {
          schema: 'ssam-reading/1', model: owner.target.module, sourceSha256: owner.snapshot.sha256, tree: original.tree ?? original,
        };
        let plan = prepareNativeBackground({ binding: { lane: 'o11', runtimeUrl: owner.target.runtimeUrl, module: owner.target.module,
          moduleKey: owner.target.moduleKey, revision: owner.versionId, sourceSha256: owner.snapshot.sha256 },
          model, entryKey: candidate.key, moduleId: field(row, 'ModuleId') });
        Object.assign(report, { background: plan, needs: { loginWindow: false, contextMode: 'native-background', words: true },
          entryAbi: { kind: plan.kind, context: 'native-background', applicationUserContext: false } });
        if (candidate.process) report.background.nativeProcess = { launchActionKey: candidate.process.launchActionKey ?? null,
          trigger: candidate.process.trigger ?? null, activities: candidate.process.activities ?? [], error: candidate.process.error ?? null };
        if (!plan.executable) { report.state = 'entry-not-runnable'; report.error = plan.error; return report; }
        if (blockedBinding(root, target.host, candidate.moduleKey)) fail('debug_native_background_binding_blocked');
        rejectUncertainCallPath(graph, candidate.id, target.host, root);
        if (input.contextMode !== 'native-background') fail('debug_native_background_explicit_context_required');
        if (input.context !== undefined || input.scenarios?.some(s => s.context !== undefined)) fail('debug_native_background_owner_context_unavailable');
        if ((input.scenarios?.length ?? 1) !== 1 || Object.keys(input.scenarios?.[0]?.inputs ?? input.inputs ?? {}).length)
          fail('debug_native_background_timer_has_no_direct_inputs');
        const requestedTarget = graph.nodes.get(resolution.target?.id);
        if (!requestedTarget || !['Timer', 'ServerAction'].includes(requestedTarget.kind) ||
            requestedTarget.kind === 'Timer' && requestedTarget.id !== candidate.id)
          fail('debug_native_background_target_kind_unsupported');
        const traceAction = requestedTarget.kind === 'Timer'
          ? graph.nodes.get(candidate.moduleKey + '*' + plan.actionKey) : requestedTarget;
        if (!traceAction || traceAction.kind !== 'ServerAction' || traceAction.moduleKey !== candidate.moduleKey ||
            traceAction.id !== candidate.moduleKey + '*' + traceAction.key || !traceAction.sources.includes('model'))
          fail('debug_native_background_target_module_or_model_unavailable');
        // Resolve the requested action through this Timer's original call graph, without crossing
        // a producer boundary. Triggering Run must not silently substitute Run for a requested Foo.
        const reachable = new Set(), pending = [candidate.id];
        while (pending.length) {
          const id = pending.pop(), node = graph.nodes.get(id);
          if (reachable.has(id) || node?.moduleKey !== candidate.moduleKey || id !== candidate.moduleKey + '*' + node.key) continue;
          reachable.add(id);
          for (const edge of graph.callees.get(id) ?? []) pending.push(edge.to);
        }
        if (!reachable.has(traceAction.id)) fail('debug_native_background_target_not_reachable');
        if (mode !== 'none' && (!traceAction || !KEY.test(traceAction.startNodeKey ?? '')))
          fail('debug_native_background_target_start_node_unread');
        let backgroundScopes = {}, omittedScopeRoots = 0;
        if (mode === 'full') {
          const matches = owner.readings.filter(r => (r.tree ?? r)?.key === traceAction.key);
          const actionReading = matches[0], actionTree = actionReading?.tree ?? actionReading;
          if (matches.length !== 1 || actionTree?.kind !== 'ServerAction' || traceAction.kind !== 'ServerAction' ||
              actionTree.reference === true || /^Reference:/.test(actionTree.path ?? '') ||
              actionReading.sourceSha256 && actionReading.sourceSha256 !== owner.snapshot.sha256 ||
              !Array.isArray(actionTree.children) || actionTree.childrenOmitted !== 0 || actionTree.childrenTotal !== actionTree.children.length ||
              [actionTree, ...actionTree.children].some(node => Object.keys(node.propertyErrors ?? {}).length ||
                Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length))
            fail('debug_native_background_target_scope_unread');
          const action = actionModel(actionTree);
          if (action.start !== traceAction.startNodeKey) fail('debug_native_background_target_scope_unread');
          const roots = scopeRoots(action, Number.MAX_SAFE_INTEGER);
          backgroundScopes = { [traceAction.key]: roots.slice(0, 60) }; omittedScopeRoots = Math.max(0, roots.length - 60);
        }
        if (mode !== 'none') report.tracePlan = { mode, contextMode: 'native-background',
          functionKey: traceAction.key, startNodeKey: traceAction.startNodeKey, fullValues: mode === 'full', depth: input.depth ?? 2,
          scopes: backgroundScopes, scopeSourceSha256: owner.snapshot.sha256, omittedScopeRoots, valuesComplete: false,
          observationSeconds: Math.min(60, input.timeoutSeconds ?? 30), requestOwnershipProved: false,
          applicationUserContext: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false, executionCompleted: false };
        if (input.op === 'run' && !wordsGiven(input.words)) // CX15 r7: one predicate
          fail('debug_native_background_explicit_background_authorization_required');
        // A Run Now never-list or registry-blocked binding gets no Service Center form read (adapter.prepare).
        if (input.trigger === 'service-center-run-now' &&
            (await import('./debug-o11-runnow-interactive.mjs')).runNowBindingRefused(root, target.host, owner.target.moduleKey))
          fail('debug_native_background_binding_blocked');
        const adapter = services.backgroundAdapter ?? createNativeBackgroundAdapter();
        plan = await adapter.prepare(plan); report.background = plan;
        if (input.trigger === 'service-center-run-now') {
          // Interactive Run Now: the helper owns and stops its debug session before the read-only correlation
          // (traceSession stays null here); no request hold is opened; an uncertain outcome keeps the lock.
          const { runO11TimerRunNowInteractive } = await import('./debug-o11-runnow-interactive.mjs');
          const outcome = await runO11TimerRunNowInteractive({ input, mode, target, owner, plan, traceAction, scopes: backgroundScopes, omittedScopeRoots,
            root, directory, operationId, report, save, adapter, debug, endpointPublicationCheck,
            prepareServerInspection: services.prepareServerInspection, beforeServerInvocation: services.beforeServerInvocation,
            traceRead, observeBackground, compactServerMap, timerInstance: services.timerInstance, scopeEvidence: services.scopeEvidence });
          uncertain ||= outcome.uncertain; return report;
        }
        if (input.op === 'prepare') { report.state = 'prepared'; return report; }
        await endpointPublicationCheck(owner, path.join(directory, 'publication-before-background'));
        if (mode !== 'none') {
          const started = await invokeDebuggerStart({ op: 'watch', lane: 'o11', tenant: target.host, module: owner.target.module,
            moduleKey: owner.target.moduleKey, runtimeUrl: owner.target.runtimeUrl,
            o11Auth: { applicationKey: owner.target.applicationKey, publishedVersionId: owner.versionId, publishedProof: owner.inventoryProof },
            nodeKeys: [traceAction.startNodeKey], seconds: report.tracePlan.observationSeconds + 30, pauseSeconds: 5, autoContinue: true, paths: [],
            trace: { mode: 'step', steps: 300, depth: report.tracePlan.depth, fullValues: mode === 'full', scopes: backgroundScopes,
              focusFunctionKey: traceAction.key, requireFunctionKey: traceAction.key } },
          { backgroundWatch: true, contextMode: 'native-background' });
          traceSession = started?.sessionId ?? null;
          report.serverTrace = { sessionId: traceSession, state: started?.state ?? null, contextMode: 'native-background', requestOwnershipProved: false };
          report.backgroundTrace = { functionKey: traceAction.key, captured: false, requestOwnershipProved: false,
            appUserIdentityProved: false, rolesProved: false, propagationProved: false, valuesComplete: false, executionCompleted: false };
          if (!started?.ok || started.state !== 'connected') { if (traceSession) uncertain = true; fail('debug_o11_native_server_trace_not_connected'); }
        }
        report.state = 'scheduling'; save();
        let result;
        try { result = await adapter.run(plan, { root, operationId, context: 'native-background', authorizationWords: input.words, inputs: {} }); }
        catch { uncertain = true; fail('debug_native_background_trigger_outcome_uncertain'); }
        report.background = { ...plan, result }; uncertain = result.outcome === 'uncertain';
        report.state = uncertain ? 'uncertain' : result.scheduled ? 'scheduled' : 'failed';
        report.executionCompleted = result.executionCompleted === true;
        if (traceSession && (result.scheduled || uncertain)) {
          report.state = 'observing-background'; save();
          await observeBackground(traceSession, traceAction.key, report.tracePlan.observationSeconds);
          report.state = uncertain ? 'uncertain' : 'scheduled';
        }
        return report;
      }
      if (resolution.state !== 'resolved') { report.state = resolution.state; report.error = 'debug_o11_native_' + resolution.state.replaceAll('-', '_'); return report; }
      if (!resolution.entry.runnable && !['rest-method', 'soap-method', 'traditional-preparation', 'traditional-screen-action'].includes(resolution.entry.entry)) {
        report.state = 'entry-not-runnable'; report.error = 'debug_o11_native_entry_kind_not_runnable:' + resolution.entry.entry; return report;
      }
      resolution.targetInputs = graph.nodes.get(resolution.path.at(-1).id).inputs;
      // Include side calls and JS proxies: an uncertain breakpoint is unsafe even outside the selected target path.
      rejectUncertainCallPath(graph, resolution.entry.id, target.host, root);
      await refreshExpiredProofs(captures, directory);
      const entryBlocked = blockedBinding(root, target.host, target.moduleKey);
      if (entryBlocked) report.warnings = ['binding ' + target.module + ' has the uncertain debugger operation ' + entryBlocked.operationId +
        ': no debug session is started on it; trace=none and client trace run without one'];
      if (mode !== 'none') await crossModuleHook();
      const trace = tracePlan(input, target, resolution, graph, captures, mode);
      const traditional = ['traditional-preparation', 'traditional-screen-action'].includes(resolution.entry.entry);
      if (services.prepareServerInspection) {
        if (!trace.server?.allowed) fail('debug_o11_native_server_inspection_trace_required');
        const owner = captures.find(c => c.target.moduleKey === trace.server.moduleKey);
        if (!owner?.snapshot) fail('debug_o11_native_server_inspection_source_required');
        // Traditional entries bind their Preparation/block/action scopes in prepareTraditionalInteractive.
        if (!traditional) await services.prepareServerInspection({ lane: 'o11', moduleKey: trace.server.moduleKey,
          source: owner.snapshot, functionKey: trace.server.functionKey,
          // Every frame must keep the runner's own published source binding.
          // A producer's keys must never be interpreted using the consumer OML.
          models: captures.map(capture => ({ moduleKey: capture.target.moduleKey, source: capture.snapshot })),
          ...(trace.server.serviceCaller ? { serviceCaller: trace.server.serviceCaller } : {}),
          // Runner-derived callback scopes; a caller scope naming another callback is refused by the coordinator.
          derivedScopes: trace.server.callbackScopes?.scopes ?? [], callbackKeys: trace.server.callbackKeys ?? [],
          modules: captures.map(capture => capture.target.moduleKey) });
      }
      if (traditional) {
        if (input.contextMode && input.contextMode !== 'app-user') fail('debug_o11_native_context_mode_unsupported');
        if (input.context !== undefined || input.scenarios?.some(s => s.context !== undefined)) fail('debug_o11_native_traditional_owner_state_unsupported');
        const entryNode = graph.nodes.get(resolution.entry.id), owner = captures.find(c => c.target.moduleKey === entryNode.moduleKey);
        if (!owner || entryNode.moduleKey !== target.moduleKey) fail('debug_o11_native_traditional_entry_module_mismatch');
        const { contract, plan } = await (resolution.entry.entry === 'traditional-screen-action' ? acquireTraditionalAction : acquireTraditional)({ owner, entry: entryNode, directory });
        if (mode === 'full' && trace.server?.functionKey === plan.entry.key) {
          const model = actionModel({ ...contract.preparation, children: [...contract.preparation.children,
            ...contract.screen.children.filter(c => ['InputParameter', 'LocalVariable'].includes(c.kind))] });
          trace.server.scopes = { [plan.entry.key]: scopeRoots(model) };
        }
        // Interactive (ssam_debug_server): screen/block Preparation and action scopes are bound before any request.
        let interactive = null;
        if (services.prepareServerInspection) {
          interactive = await prepareTraditionalInteractive({ input, trace, source: contract, plan, owner, captures, root, directory, operationId },
            { prepareServerInspection: services.prepareServerInspection, beforeServerInvocation: services.beforeServerInvocation,
              afterServerInvocation: services.afterServerInvocation, inspectionEvents: services.serverInspectionEvents, invokeTraditional });
          if (mode === 'full') Object.assign(trace.server.scopes ??= {}, interactive.traceScopes);
        }
        const scenarios = resolution.distance === 0 ? (input.scenarios ?? [{ name: 'call', inputs: input.inputs ?? {} }])
          .map((scenario, i) => ({ name: scenario.name ?? 'scenario-' + i, values: scenario.inputs ?? {} })) : scenarioPlan(resolution, input, undefined, { parsed, module: target.module });
        if (new Set(scenarios.map(s => s.name)).size !== scenarios.length) fail('debug_o11_native_duplicate_scenarios');
        for (const scenario of scenarios) traditionalRequest(plan, scenario.values);
        const contractPath = path.join(directory, 'traditional-source.json'); o11Write(contractPath, contract);
        Object.assign(report, { sourceContract: { path: contractPath, sha256: o11Hash(fs.readFileSync(contractPath)) },
          published: { versionId: owner.versionId, sourceSha256: owner.snapshot.sha256 }, tracePlan: trace,
          entryAbi: { kind: resolution.entry.entry, ...plan.entry, authentication: plan.authentication, effects: plan.effects },
          needs: { loginWindow: true, contextMode: 'app-user', appUser: 'Original ' + plan.login.provider + '.User_Login through the published WebForms login',
            serverTrace: trace.server ? { module: trace.server.module, allowed: trace.server.allowed, reason: trace.server.reason } : null } });
        report.resolution.entry.runnable = true;
        if (mode !== 'none' && !trace.server?.allowed) fail('debug_o11_native_traditional_trace_unavailable');
        if (input.op === 'prepare') { report.state = 'prepared'; return report; }
        sessionId = randomUUID().replaceAll('-', ''); report.state = 'sign-in'; save();
        const entered = await prepareUser({ lane: 'o11', ...target, seconds: 600 }, { sessionId });
        if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; report.error = entered?.error ?? 'debug_app_user_failed'; return report; }
        descriptor = entered.descriptor;
        if (!sameAppUserTarget(descriptor.binding, appUserBinding({ lane: 'o11', ...target }, sessionId))) fail('debug_app_user_scope_mismatch');
        // No client handle: interactive Traditional uses the endpoint deadline (min of native lease and credential).
        await startServerTrace(trace, scenarios.length, { endpoint: !!interactive }); report.state = 'invoking'; save();
        for (const [index, scenario] of scenarios.entries()) {
          await endpointPublicationCheck(owner, path.join(directory, 'publication-before-' + index));
          const before = traceSession ? traceRead(traceSession).length : 0;
          let reply;
          try { reply = interactive ? await interactive.invoke({ index, scenario, descriptor, requestDeadline: report.serverTrace?.requestDeadline })
            : await invokeTraditional({ root, directory, operationId, scenarioId: 'scenario-' + index,
              timeoutSeconds: input.timeoutSeconds, contract, inputs: scenario.values, context: 'app-user', descriptor }); }
          catch { reply = { ok: false, uncertain: true, error: 'debug_o11_native_traditional_worker_unavailable' }; }
          // A submitted postback without its answer is uncertain and never resent.
          const replyUncertain = workerUncertain(reply) || reply.actionSubmitted === true && reply.actionAnswered !== true; uncertain ||= replyUncertain;
          reply ??= { ok: false, error: 'debug_o11_native_traditional_worker_outcome_unavailable' };
          const result = { name: scenario.name, ok: reply.ok === true && !replyUncertain, uncertain: replyUncertain, status: reply.status ?? null,
            outputs: {}, requests: reply.requests ?? [], originalLoginForm: reply.originalLoginForm === true,
            appUserIdentityProved: false, rolesProved: false, propagationProved: false, requestOwnershipProved: false,
            ...(reply.error ? { error: reply.error } : {}) };
          if (traceSession && !replyUncertain) {
            await settle(traceSession, before); const lines = traceRead(traceSession).slice(before);
            result.serverMap = compactServerMap(lines);
            const threads = new Set(lines.filter(l => l.functionKey === trace.server.functionKey).map(l => l.threadId));
            result.targetObserved = threads.size > 0;
            result.serverThreadEnded = lines.some(l => l.kind === 'thread-end' && threads.has(l.threadId));
            result.traceVerified = result.targetObserved && result.serverThreadEnded;
            if (!result.traceVerified) { result.ok = false; result.error = 'debug_o11_native_trace_incomplete'; }
          }
          report.results.push(result); save();
          if (result.uncertain || reply.memoryReferencesReleased !== true) { uncertain = true; break; }
          if (!result.ok) break;
        }
        report.notSent = scenarios.slice(report.results.length).map(s => s.name); report.state = 'answered'; return report;
      }
      if (['rest-method', 'soap-method'].includes(resolution.entry.entry)) {
        const protocol = resolution.entry.entry === 'soap-method' ? 'soap' : 'rest';
        const entryNode = graph.nodes.get(resolution.entry.id), owner = captures.find(c => c.target.moduleKey === entryNode.moduleKey);
        if (!owner || entryNode.moduleKey !== target.moduleKey) fail('debug_native_endpoint_entry_module_must_be_runtime_target');
        if (blockedBinding(root, target.host, entryNode.moduleKey)) fail('debug_native_endpoint_binding_blocked');
        let acquired;
        try { acquired = await acquireEndpoint({ owner, entry: entryNode, binding: { lane: 'o11', runtimeUrl: target.runtimeUrl,
          module: target.module, moduleKey: target.moduleKey, revision: owner.versionId, sourceSha256: owner.snapshot.sha256 } }); }
        catch (error) {
          // Integrated/client-certificate SOAP is refused from the hash-bound model before any GET; the receipt keeps the typed code.
          // InternalAccess=Yes REST is refused the same way, before the documentation GET (platformRestriction).
          const refusal = protocol === 'soap' ? (await import('./debug-native-endpoint-soap.mjs')).nativeSoapAuthenticationRefusalFromError(error)
            : (await import('./debug-native-endpoint-worker.mjs')).nativeRestTransportRefusalFromError(error);
          if (!refusal) throw error;
          Object.assign(report, { published: { versionId: owner.versionId, sourceSha256: owner.snapshot.sha256 }, tracePlan: trace,
            entryAbi: { kind: resolution.entry.entry, protocol, authentication: { native: protocol, capability: refusal } } });
          report.resolution.entry.runnable = false; report.state = 'entry-not-runnable'; report.error = refusal.error;
          report.platformRestriction = refusal.platformRestriction === true; return report;
        }
        const { contract, plan } = acquired;
        const { nativeEndpointAuthenticationCapability } = await import('./debug-native-endpoint-worker.mjs');
        const capability = nativeEndpointAuthenticationCapability(plan), selectedContext = input.contextMode ?? 'app-user';
        const rawScenarios = input.scenarios ?? [{ name: 'call', inputs: input.inputs ?? {} }];
        // A direct REST entry is typed by the captured OpenAPI (including primitive arrays), not by the
        // Reactive AMD converter. Indirect calls still use the graph's target-to-entry parameter bindings.
        const scenarios = resolution.distance === 0 ? rawScenarios.map((scenario, index) => {
          if (scenario.context !== undefined || input.context !== undefined) fail('debug_native_endpoint_owner_context_unavailable');
          const values = scenario.inputs ?? {}, name = scenario.name ?? 'scenario-' + (index + 1);
          return { name, values, presence: Object.fromEntries(plan.entry.inputs.map(p => [p.name,
            !Object.hasOwn(values, p.name) ? 'omitted' : values[p.name] === null ? 'null' : 'value'])) };
        }) : scenarioPlan(resolution, input, undefined, { parsed, module: target.module });
        if (new Set(scenarios.map(s => s.name)).size !== scenarios.length) fail('debug_o11_native_duplicate_scenarios');
        // Validate every request before the secure dialog or the first execution. No URL/header is supplied by the caller.
        for (const scenario of scenarios) (protocol === 'soap' ? buildNativeSoapRequest : buildNativeEndpointRequest)(plan, scenario.values);
        const contractPath = path.join(directory, 'native-' + protocol + '-source.json'); o11Write(contractPath, contract);
        Object.assign(report, { sourceContract: { path: contractPath, sha256: o11Hash(fs.readFileSync(contractPath)) },
          published: { versionId: owner.versionId, sourceSha256: owner.snapshot.sha256 }, tracePlan: trace,
          entryAbi: { kind: resolution.entry.entry, protocol, method: plan.method, endpoint: plan.url, inputs: plan.entry.inputs, outputs: plan.entry.outputs,
            authentication: { ...plan.authentication, capability } },
          scenarios: scenarios.map(s => ({ name: s.name, presence: s.presence })),
          needs: { loginWindow: ['app-user', 'endpoint-credential'].includes(capability.requiredContext),
            contextMode: capability.requiredContext === 'explicit-anonymous' ? 'anonymous' : capability.requiredContext === 'endpoint-credential' ? 'endpoint-credential' : 'app-user',
            appUser: capability.requiredContext === 'app-user' ? 'App user for the original REST Basic authentication (O11 platform login ' +
              (capability.loginProvider ?? 'platform') + '.User_Login); UID and roles need server evidence' : null,
            ...(capability.requiredContext === 'endpoint-credential' ? { credentialScheme: capability.credentialScheme ?? 'header',
              endpointCredential: { dialog: 'SSAM Debug \u2014 O11 \u2014 ' + target.module + ' \u2014 Endpoint Credential' + (capability.credentialScheme === 'basic' ? ' (Basic)' : ''),
                headers: capability.headers, source: capability.source ?? 'published OnAuthentication', credentialScheme: capability.credentialScheme ?? 'header',
                ...(capability.limitation ? { limitation: capability.limitation } : {}) } } : {}),
            ...(capability.localActions ? { localActions: capability.localActions } : {}),
            serverTrace: trace.server ? { module: trace.server.module, allowed: trace.server.allowed, reason: trace.server.reason } : null } });
        report.resolution.entry.runnable = capability.executable;
        if (!capability.executable) { report.state = 'entry-not-runnable'; report.error = capability.error;
          report.platformRestriction = capability.platformRestriction === true; if (capability.reason) report.errorReason = capability.reason; return report; }
        if (selectedContext !== report.needs.contextMode) { report.state = 'refused'; report.error = 'debug_native_endpoint_context_explicit_required'; return report; }
        if (mode !== 'none' && (!trace.server?.allowed || selectedContext === 'anonymous' && trace.server?.entry)) {
          report.state = 'refused'; report.error = selectedContext === 'anonymous' ? 'debug_native_endpoint_anonymous_cross_module_trace_unqualified'
            : 'debug_o11_native_trace_unavailable:' + (trace.server?.reason ?? 'no_server_frames'); return report;
        }
        if (input.op === 'prepare') { report.state = 'prepared'; return report; }
        sessionId = randomUUID().replaceAll('-', '');
        if (selectedContext === 'app-user') {
          report.state = 'sign-in'; save();
          const entered = await prepareUser({ lane: 'o11', ...target, seconds: 600 }, { sessionId });
          if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; report.error = entered?.error ?? 'debug_app_user_failed'; return report; }
          descriptor = entered.descriptor;
          if (!sameAppUserTarget(descriptor.binding, appUserBinding({ lane: 'o11', ...target }, sessionId))) fail('debug_app_user_scope_mismatch');
        } else if (selectedContext === 'endpoint-credential') {
          // Header values exist only in the private dialog and vault record, never in this request.
          const { endpointCredentialBinding, sameEndpointCredentialTarget } = await import('./debug-app-user.mjs');
          const credentialTarget = { lane: 'o11', ...target, revision: owner.versionId, serviceKey: plan.entry.serviceKey, headers: capability.headers,
            scheme: capability.credentialScheme ?? 'header' };
          report.state = 'sign-in'; save();
          const entered = await prepareEndpointCredential({ ...credentialTarget, seconds: 600 }, { sessionId });
          if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; report.error = entered?.error ?? 'debug_app_user_failed'; return report; }
          descriptor = entered.descriptor;
          if (!sameEndpointCredentialTarget(descriptor?.binding, endpointCredentialBinding(credentialTarget, sessionId))) fail('debug_app_user_scope_mismatch');
        }
        await startServerTrace(trace, scenarios.length, { anonymous: selectedContext === 'anonymous', endpoint: true });
        report.state = 'invoking'; save();
        for (const [index, scenario] of scenarios.entries()) {
          await endpointPublicationCheck(owner, path.join(directory, 'publication-before-' + index));
          if (services.prepareServerInspection) await services.beforeServerInvocation?.(submission('scenario-' + index));
          const before = traceSession ? traceRead(traceSession).length : 0;
          let reply;
          try { reply = await invokeEndpoint({ root, directory, operationId, protocol, scenarioId: 'scenario-' + index, timeoutSeconds: input.timeoutSeconds,
            contract, inputs: scenario.values, context: selectedContext === 'anonymous' ? 'explicit-anonymous' : selectedContext, ...(descriptor ? { descriptor } : {}),
            ...(report.serverTrace?.inspectionMode === 'interactive' ? { inspectionExpiresAt: report.serverTrace.requestDeadline } : {}) }); }
          catch { reply = { ok: false, uncertain: true, error: 'debug_native_endpoint_worker_unavailable' }; }
          if (services.prepareServerInspection) services.afterServerInvocation?.({ requestId: 'scenario-' + index });
          const replyUncertain = workerUncertain(reply); uncertain ||= replyUncertain;
          reply ??= { ok: false, error: 'debug_native_endpoint_worker_outcome_unavailable' };
          const result = { name: scenario.name, ok: reply.ok === true && !replyUncertain, outputs: reply.result?.outputs ?? null,
            status: reply.status ?? null, presence: scenario.presence, uncertain: replyUncertain,
            requests: { submitted: reply.sent === true ? 1 : 0, answered: reply.answered === true ? 1 : 0 },
            authentication: reply.authentication, ...(reply.error ? { error: reply.error } : {}) };
          if (traceSession && !replyUncertain) {
            await settle(traceSession, before); const lines = traceRead(traceSession).slice(before);
            result.serverMap = compactServerMap(lines);
            result.requestObservation = nativeRequestObservation(lines, trace.server.functionKey);
            const targetThreads = new Set(lines.filter(l => l.kind !== 'thread-end' && l.functionKey === trace.server.functionKey).map(l => l.threadId).filter(Boolean));
            result.serverThreadEnded = lines.some(l => l.kind === 'thread-end' && targetThreads.has(l.threadId));
            result.targetObserved = targetThreads.size > 0;
            result.traceVerified = result.targetObserved && result.serverThreadEnded;
            if (!result.traceVerified) { result.ok = false; result.error = 'debug_o11_native_trace_incomplete'; }
          }
          report.results.push(result); save();
          if (result.uncertain || reply.memoryReferencesReleased !== true) { uncertain = true; break; }
          if (!result.ok) break;
        }
        report.notSent = scenarios.slice(report.results.length).map(s => s.name); report.state = 'answered'; return report;
      }
      if (input.contextMode && input.contextMode !== 'app-user') fail('debug_o11_native_context_mode_unsupported');
      const login = loginSpec(parsed, target.module), entry = entrySpec(graph, resolution, parsed, target.module);
      const scenarios = scenarioPlan(resolution, input, entry, { parsed, module: target.module });
      const appDefinition = published.pins.find(p => p.name === target.module + '.appDefinition.js');
      if (!appDefinition) fail('debug_o11_native_app_definition_unresolved');
      const contract = { schema: 'ssam-o11-native-entry-source/2', selector: input.action,
        target: { lane: 'o11', host: target.host, runtimeUrl: target.runtimeUrl, module: target.module, moduleKey: target.moduleKey,
          applicationKey: target.applicationKey, publishedVersionId: entryCapture.versionId, sourceSha256: entryCapture.snapshot.sha256 },
        ...appDefinitionOf(fs.readFileSync(appDefinition.path, 'utf8')), applicationDefinition: target.module + '.appDefinition',
        snapshot: entryCapture.snapshot, inventoryProof: entryCapture.inventoryProof, moduleInfo: published.moduleInfo,
        modelSources: captures.map(c => ({ moduleKey: c.target.moduleKey, source: c.snapshot })),
        assets: contractAssets(parsed, published.pins, target.module, login, entry), login, entry, graphSha256: graph.graphSha256 };
      const contractPath = path.join(directory, 'native-entry-source.json'); o11Write(contractPath, contract);
      const sourceContract = { path: contractPath, sha256: o11Hash(fs.readFileSync(contractPath)) };
      Object.assign(report, { sourceContract, published: { versionId: entryCapture.versionId, sourceSha256: entryCapture.snapshot.sha256 },
        entryAbi: { kind: entry.kind, method: entry.method, viewName: entry.viewName ?? null, endpoints: entry.endpoints,
          inputs: entry.inputs.map(i => ({ name: i.name, dataType: i.dataType, ...(i.element ? { element: i.element } : {}) })), outputs: entry.outputs.map(o => ({ name: o.name, dataType: o.dataType })),
          ...(entry.context ? { context: entry.context } : {}), ...(entry.lifecycle ? { lifecycle: { ...entry.lifecycle, mounted: false } } : {}) },
        scenarios: scenarios.map(s => ({ name: s.name, presence: s.presence })), tracePlan: trace,
        needs: { loginWindow: true, appUser: target.module + ' app user (original ' + login.viewName + ' login)', binding: { host: target.host, module: target.module, moduleKey: target.moduleKey },
          serverTrace: trace.server ? { module: trace.server.module, allowed: trace.server.allowed, reason: trace.server.reason } : null } });
      // A requested trace with no observable source refuses before any window; a partial one runs and says what is missing.
      if (mode !== 'none' && (trace.server ? !trace.server.allowed : !trace.client)) {
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
      await startServerTrace(trace, scenarios.length);
      report.state = 'invoking'; save();
      const allowed = new Set(entry.endpoints);
      for (const [index, scenario] of scenarios.entries()) {
        await services.beforeServerInvocation?.(submission('scenario-' + index));
        const before = traceSession ? traceRead(traceSession).length : 0;
        let reply;
        try {
          reply = await handle.invoke({ scenario: { name: scenario.name, values: scenario.values, screen: scenario.screen,
            ...(scenario.context ? { context: scenario.context } : {}), trace: trace.client ? mode : 'none' },
            beforeRequest: async submission => {
              if (!sameAppUserTarget(submission?.binding, binding) || submission.sessionId !== sessionId || submission.sourceContractSha256 !== sourceContract.sha256 ||
                  submission.scenario !== scenario.name || !allowed.has(submission.endpoint) || !(Date.parse(descriptor.expiresAt) > Date.now()))
                fail('debug_o11_native_request_scope_mismatch');
            } });
        } catch (error) {
          report.results.push({ name: scenario.name, ok: false, uncertain: true, error: o11NativePublicCode(error?.message, 'debug_o11_native_execution_failed') });
          uncertain = true; services.afterServerInvocation?.({ requestId: 'scenario-' + index }); break;
        }
        services.afterServerInvocation?.({ requestId: 'scenario-' + index });
        const result = reply?.scenario ?? { name: scenario.name, ok: false, uncertain: true };
        if (traceSession) { await settle(traceSession, before); const lines = traceRead(traceSession).slice(before);
          result.serverMap = compactServerMap(lines); result.serverThreadEnded = lines.some(l => l.kind === 'thread-end');
          result.targetObserved = lines.some(l => l.functionKey === trace.server.functionKey);
          result.traceVerified = result.targetObserved && result.serverThreadEnded;
          if (!result.traceVerified) { result.ok = false; result.error = 'debug_o11_native_trace_incomplete'; }
        } else if (trace.client && mode !== 'none') {
          result.targetObserved = result.visits?.some(v => v.functionKey === resolution.path.at(-1).key) === true;
          result.traceVerified = result.targetObserved;
          if (!result.traceVerified) { result.ok = false; result.error = 'debug_o11_native_trace_incomplete'; }
        }
        result.presence = scenario.presence;
        report.results.push(result);
        if (result.uncertain) { uncertain = true; break; } // never resend; remaining scenarios are not sent
        if (result.exception?.origin === 'harness' || result.exception?.type === 'Harness') break;
        if (mode !== 'none' && !result.traceVerified) break;
      }
      report.notSent = scenarios.slice(report.results.length).map(s => s.name);
      report.state = 'answered';
      return report;
    } catch (error) {
      report.error = CAPTURE_ERRORS.has(error?.message) || ['debug_o11_reader_selection_invalid', 'debug_o11_publication_proof_stale',
        'debug_o11_publication_proof_invalid', 'debug_o11_module_scope_mismatch'].includes(error?.message) ||
        /^(debug_o11_native_|debug_native_model_|debug_native_endpoint_|debug_native_background_|debug_app_user_)[a-z0-9_:.@-]+$/i.test(error?.message ?? '') ? error.message : o11NativePublicCode(error?.message, 'debug_o11_native_execution_failed');
      // A refused sign-in names the account it tried, masked (debug-guidance.mjs maskUser), for DEBUG_APP_USER_SIGN_IN_FAILED.
      const user = descriptor?.userHint ?? error?.signIn?.user;
      if (typeof user === 'string' && SIGN_IN_FAILURES.includes(report.error)) report.signInUser = user;
      report.state = report.state === 'resolving' ? 'refused' : 'failed-or-uncertain';
      return report;
    } finally {
      if (traceSession) { let stopped; try { stopped = await debug({ op: 'stop', sessionId: traceSession }); } catch { stopped = { ok: false }; }
        report.serverTrace.stopped = stopped?.ok === true && stopped.state === 'stopped'; if (!report.serverTrace.stopped) uncertain = true; }
      if (traceSession && report.backgroundTrace) {
        try { const lines = traceRead(traceSession), targetLines = lines.filter(l => l.kind !== 'thread-end' && l.functionKey === report.backgroundTrace.functionKey);
          // backgroundThreadOutcome keeps executionCompleted false; identity/values flags stay as set above.
          Object.assign(report.backgroundTrace, { ...backgroundThreadOutcome(lines, report.backgroundTrace.functionKey), visits: compactServerMap(targetLines) }); }
        catch { report.backgroundTrace.error = 'debug_native_background_trace_read_failed'; }
      }
      if (handle) { try { await handle.dispose(); } catch { uncertain = true; }
        try { const r = handle.receipt(); report.worker = { memoryCleared: r.memoryCleared === true, workerExited: r.workerExited === true, requestUncertain: r.requestUncertain === true,
          loginUncertain: r.loginUncertain === true, submitted: r.requestSubmittedCount ?? 0, answered: r.requestAnsweredCount ?? 0 };
          // The HTTP response is not necessarily an action response (for example,
          // a gateway's 504). Surface only bounded transport metadata, never the
          // body, headers or arbitrary fields from the private worker receipt.
          const response = r.lastEntryResponse;
          if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 &&
              Number.isSafeInteger(response.durationMs) && response.durationMs >= 0 &&
              Number.isSafeInteger(response.bytes) && response.bytes >= 0 &&
              /^[a-f0-9]{64}$/.test(response.sha256 ?? '') && typeof response.nativeEnvelopeAccepted === 'boolean') {
            report.worker.lastEntryResponse = { status: response.status, durationMs: response.durationMs,
              bytes: response.bytes, sha256: response.sha256, nativeEnvelopeAccepted: response.nativeEnvelopeAccepted };
            // A 504 without an accepted native envelope is gateway transport evidence: never an answer, never resent.
            report.worker.lastEntryClassification = classifyEntryResponse(response);
            if (report.worker.lastEntryClassification?.kind === 'gateway-limit') uncertain = true;
            if (Number.isInteger(r.serverInspection?.nativeTimeoutSeconds) &&
                r.serverInspection.nativeTimeoutSeconds >= 1 && r.serverInspection.nativeTimeoutSeconds <= 600)
              report.worker.nativeTimeoutSeconds = r.serverInspection.nativeTimeoutSeconds;
          }
          if (r.requestUncertain || r.loginUncertain || r.memoryCleared !== true) uncertain = true; } catch { uncertain = true; } }
      if (descriptor) { try { report.credentialsReleased = (await (descriptor.kind === 'endpoint-credential' ? releaseEndpointCredential : releaseUser)(descriptor))?.ok === true; } catch { report.credentialsReleased = false; } }
      uncertain ||= report.credentialsReleased === false || report.uncertain === true;
      report.uncertain = uncertain;
      report.ok = ['answered', 'prepared'].includes(report.state) && !uncertain && (report.credentialsReleased !== false) &&
        report.results.every(r => (r.ok === true || (r.exception && !['Harness', 'Error'].includes(r.exception.type) && r.exception.origin !== 'harness')) &&
          (mode === 'none' || r.traceVerified === true));
      if (ownsLock) { report.lockRetained = uncertain; if (!uncertain) try { fs.unlinkSync(lockPath); } catch { report.lockRetained = true; } }
      if (fs.existsSync(directory)) save();
    }
  };
}

// Server trace lines (kernel trace.jsonl) of one scenario -> visits with value deltas per frame.
export function nativeRequestObservation(entries, functionKey) {
  const pauses = entries.filter(e => e.kind !== 'thread-end' && e.functionKey === functionKey);
  const proven = pauses.filter(e => e.nativeRequestIdProvenance === true && /^[a-f0-9]{64}$/.test(e.nativeRequestIdSha256 ?? ''));
  const fingerprints = [...new Set(proven.map(e => e.nativeRequestIdSha256))];
  // An explicit native requestId may equal threadId. Provenance proves the
  // protocol field, not an independent HTTP execution or the submitting user.
  const threadAliases = new Set(proven.filter(e => typeof e.threadId === 'string' &&
    createHash('sha256').update(e.threadId).digest('hex') === e.nativeRequestIdSha256)
    .map(e => e.nativeRequestIdSha256));
  return { targetPauses: pauses.length, observedThreads: new Set(pauses.map(e => e.threadId)).size,
    nativeRequestFingerprints: fingerprints, observedRequestsAtLeast: fingerprints.length,
    requestIdentityScope: 'native-protocol-field', requestIdsMatchingThreadIds: threadAliases.size,
    independentRequestCorrelationProved: false,
    allTargetPausesHaveRequestProvenance: pauses.length > 0 && proven.length === pauses.length,
    multipleNativeRequestsObserved: fingerprints.length > 1, requestOwnershipProved: false };
}

export function compactServerMap(entries) {
  const last = new Map();
  return entries.filter(e => e.kind !== 'thread-end').map(entry => {
    const scope = [entry.threadId, entry.nativeRequestIdSha256 ?? '', entry.functionKey ?? entry.action].join('|');
    const previous = last.get(scope), current = new Map((entry.values ?? []).map(v => [v.path, JSON.stringify(v)]));
    last.set(scope, current);
    const values = previous ? (entry.values ?? []).filter(v => previous.get(v.path) !== current.get(v.path)) : entry.values ?? [];
    const { values: _, threadId: __, eventId: ___, ...rest } = entry;
    return { ...rest, ...(previous ? { changed: values } : { values }) };
  });
}

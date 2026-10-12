// ODC native-entry debugger: prepare / run / status.
//
// Decision of 2026-10-04: NO WRAPPER, NO PUBLISHING. A private action with no public entry is dead code, never
// called; so every action that matters is reachable from an existing entry (screen, block, data action, public
// action, REST, timer). We debug it by calling that ORIGINAL entry in the already-published app, with chosen inputs.
// The CODE, not the LLM, picks the nearest public entry deterministically (debug-odc-native-entry-resolve.mjs).
//
// prepare resolves and validates everything that can be checked offline, and reports what run needs (the secure
// login window and the one live binding). run executes each scenario through the original entry and returns, per
// scenario: typed outputs, a classified exception, the visited nodes/variables when traced, and the duration.
// Assumption (documented): DEV environments; a breakpoint set on an entry could also catch another user's request on
// the same action. One live session per binding; private values are filtered from every output.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { buildModelGraph, materializeGraph } from './debug-odc-native-graph.mjs';
import { resolveEntry, resolveOverride, resolveOriginalScreenEntry, originalScreenEntries } from './debug-odc-native-entry-resolve.mjs';
import { buildNativeEndpointRequest } from './debug-native-endpoint.mjs';
import { nativeEndpointAuthenticationCapability, nativeRestTransportRefusalFromError } from './debug-native-endpoint-worker.mjs';
import { prepareNativeBackground } from './debug-native-background.mjs';
import { describeOdcCallBoundaries } from './debug-odc-call-boundary.mjs';
import { qualifyOriginalDerivedInputs, canonicalizeOriginalScenarioInputs } from './debug-odc-native-derived-inputs.mjs';
import { resolveOdcRuntimeEntry } from './debug-odc-native-assets.mjs';
import { prepareOdcMountClosures, prepareOdcMountNavigation, prepareOdcMountInteractions } from './debug-odc-native-mount-plan.mjs';
import { externalLogicBoundaries } from './debug-odc-call-boundary.mjs';
import { inputCapabilities } from './debug-input-capabilities.mjs';
import { pendingForeign } from './debug-foreign-pending.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/, KEY = /^[A-Za-z0-9_+]{22}$/;
const root = path.join(workspaceRoot, '.local', 'debugger', 'native-entries', 'odc');
const now = () => new Date().toISOString();

// Port D7: the ODC Timer and Workflow runners (debug-odc-workflow-run, debug-odc-native-wake-run and
// debug-odc-native-background-run) load portal/runtime/timer-background.mjs, which the SC/Portal lane has not
// delivered to this build yet. Until it arrives they answer the registry's typed code (the session gates refuse the
// same rows with debug_adapter_dependency_pending), never a raw module error; when the file arrives this passes by itself.
export function odcBackgroundRunnerPending() {
  const pending = pendingForeign(['timer-background']);
  return pending.length ? 'debug_adapter_dependency_pending:' + pending.join(',') : null;
}
const backgroundRunnerAdapter = adapter => adapter?.kind === 'workflow-event' || adapter?.kind === 'timer-original-wake' ||
  adapter?.trigger === 'odc-portal-timer-wake';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1)); fs.renameSync(file + '.tmp', file); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Effect classes from the target's own call closure (best effort, read-only). entity-write / external-http / email /
// timer / process require the caller to acknowledge them; read-only needs nothing. Unknown calls are flagged.
export function classifyEffects(closureCalls = []) {
  const effects = new Set();
  for (const call of closureCalls) {
    const kind = call.kind, ref = call.action ?? '';
    if (/(?:#|:)(CreateOrUpdate|Create|Update|Delete)[A-Za-z0-9_]*$/.test(ref)) effects.add('entity-write');
    else if (/^(RestAction|RestServiceAction|SoapAction|SoapServiceAction)$/.test(call.actionKind ?? '')) effects.add('external-http');
    else if (/#GetEntityForUpdate$/.test(call.actionKey ?? '')) effects.add('entity-lock');
    else if (call.external === true && call.bodyRead !== true) effects.add('unknown-call');
    if (kind === 'SendEmailNode') effects.add('email');
    else if (/Timer/.test(kind)) effects.add('timer-wake');
    else if (/Launch\w*Process/.test(kind)) effects.add('process-launch');
    else if (kind === 'SQLNode') effects.add('unknown-sql');
    else if (kind === 'JavaScriptNode') effects.add('unknown-javascript');
  }
  return [...effects];
}

// Resolve the target and the deterministic entry, validate scenarios. `readers` is the model-graph adapter plus a
// target resolver; live code builds it from the Portal download, tests inject it.
export async function prepareNativeEntry(input, readers) {
  if (input.lifecycle === 'mounted' && (input.workflow || input.launch || input.contextMode === 'native-background'))
    throw new Error('debug_odc_native_mount_background_unsupported');
  if (input.navigate && input.lifecycle !== 'mounted') throw new Error('debug_odc_native_navigation_requires_mount');
  if (input.interactions && input.lifecycle !== 'mounted') throw new Error('debug_odc_native_interactions_require_mount');
  if (input.workflow || input.launch) {
    const pending = odcBackgroundRunnerPending();
    if (pending) throw new Error(pending);
    const prepare = input.workflow ? (await import('./debug-odc-workflow-run.mjs')).prepareOdcWorkflowEvent :
      (await import('./debug-odc-native-wake-run.mjs')).prepareOdcTimerWake;
    const prepared = await prepare(input, readers, { prepareEntry: prepareNativeEntry });
    if (input.persist !== false) {
      const file = receiptFile(readers.binding, prepared.action.key);
      const { scenarios: _drop, ...persistable } = prepared;
      write(file, { schema: 'ssam-odc-native-receipt/1', op: 'prepare', at: now(), prepared: persistable });
      prepared.receiptPath = file;
    }
    return prepared;
  }
  const target = await readers.resolveTarget(input.action);
  if (!target) throw new Error('debug_odc_native_action_not_found:' + input.action);
  // Live readers are async: prefetch the reachable graph into a synchronous one so the resolver stays pure. Synchronous
  // (test) readers are used directly.
  const graph = readers.async ? await materializeGraph(readers, target.path) : (() => { const g = buildModelGraph(readers); g.seed(target.path); return g; })();
  let resolution = input.entry
    ? resolveOverride(graph, target.key, input.entry)
    : resolveEntry(graph, target.key);
  if (!resolution.ok && resolution.deadCode)
    return { ok: false, state: 'dead-code', error: 'dead code: no public entry reaches ' + (target.name ?? input.action),
      target: { key: target.key, name: target.name, kind: target.kind } };
  if (!resolution.ok) return { ok: false, state: 'entry-unresolved', ...resolution };
  const isRest = resolution.entry.entryKind === 'rest-method';
  const isBackground = ['timer', 'process'].includes(resolution.entry.entryKind);
  if (!isRest && !isBackground && input.contextMode && input.contextMode !== 'app-user')
    throw new Error('debug_odc_native_context_mode_unsupported');
  let endpoint = null;
  if (isRest) {
    try { endpoint = await readers.prepareEndpoint?.(resolution.entry); }
    catch (error) { const refused = nativeRestTransportRefusalFromError(error); if (!refused) throw error; endpoint = { refused }; }
  }
  if (isRest && !endpoint) throw new Error('debug_native_endpoint_published_contract_unavailable');
  // A platform-restricted endpoint (InternalAccess=Yes) is refused from the hash-bound model before any GET or dialog.
  if (endpoint?.refused) return { ok: false, state: 'entry-not-runnable', error: endpoint.refused.error,
    platformRestriction: endpoint.refused.platformRestriction === true, entry: resolution.entry,
    adapter: { kind: 'rest-method', executable: false, authentication: endpoint.refused } };
  let entryCalls = readers.closure && resolution.entry.key !== target.key ? await readers.closure('@' + resolution.entry.key) : target.closureCalls ?? [];
  const globalEntry = ['ClientAction', 'ServerAction'].includes(resolution.entry.kind) && !/(?:^|\/)(?:MobileScreen|WebScreen|MobileBlock|WebBlock):/.test(resolution.entry.path ?? '');
  const sendsServerRequest = resolution.entry.entryKind === 'server-stub' || resolution.path.some(step =>
    /^(ServerAction|ServiceAction|ServerActionSignature|ServiceActionSignature)$/.test(step.kind ?? '')) || entryCalls.some(call =>
    /^Execute.*ActionNode$/.test(call.kind ?? '') && /^(ServerAction|ServiceAction|ServerActionSignature|ServiceActionSignature)$/.test(call.actionKind ?? ''));
  if (!isRest && !isBackground && globalEntry && sendsServerRequest) {
    const automatic = !input.entry && resolveOriginalScreenEntry(graph, target.key);
    if (!automatic?.ok) return { ok: false, state: 'entry-unavailable',
      error: 'debug_odc_native_original_screen_entry_required', entry: resolution.entry,
      originalScreenEntries: originalScreenEntries(graph, resolution.entry.key),
      reason: 'Execute the original screen handler so its guards, role validation and view call context run before the server request.' };
    resolution = automatic;
    // Include effects and requests of the complete original handler, not just
    // the previously selected global action. Its guards remain on the path.
    if (typeof readers.closure !== 'function') throw new Error('debug_odc_native_original_screen_closure_unavailable');
    entryCalls = await readers.closure('@' + resolution.entry.key);
  }
  // Canonicalize each scenario against the target signature, offline, before any login.
  const signature = (target.inputs ?? []).map(p => ({ ...p, name: p.name, dataType: p.dataType, mandatory: p.mandatory !== false }));
  // The deterministic entry is resolved regardless of inputs. Scenarios are validated only when supplied; prepare with
  // no inputs/scenarios still reports the entry, path and bindings (and that run will need inputs).
  const given = input.scenarios?.length ? input.scenarios : (input.inputs !== undefined || input.op === 'run' ? [{ name: 'scenario-1', inputs: input.inputs ?? {} }] : []);
  resolution.bindings = await qualifyOriginalDerivedInputs({ resolution, readers, contexts: given.map(s => s.context ?? input.context) });
  const scenarios = given.map((s, i) => ({ name: s.name ?? 'scenario-' + (i + 1), inputs: canonicalizeOriginalScenarioInputs(s.inputs ?? {}, signature, resolution.bindings, s.context ?? input.context),
    ...(s.context ?? input.context ? { context: s.context ?? input.context } : {}) }));
  if (new Set(scenarios.map(s => s.name)).size !== scenarios.length) throw new Error('debug_odc_native_scenario_names_not_unique');
  const effects = classifyEffects(entryCalls);
  const sourceContract = readers.sourceContract ?? null;
  // REST callback scopes, reported only: the endpoint runner derives them again before any send and never trusts this copy.
  let callbackPlan = null, callbackPlanError = null;
  if ((isRest || entryCalls.some(call => call.actionKind === 'RestAction')) && typeof readers.properties === 'function' && readers.binding?.moduleKey) {
    try { callbackPlan = await (await import('./debug-odc-native-graph.mjs')).planOdcCallbackScopes({ read: async selector => readers.properties(selector), list: readers.list },
      { entry: resolution.entry, calls: entryCalls, binding: readers.binding, acknowledgeEffects: input.acknowledgeEffects ?? [] }); }
    catch (error) { callbackPlanError = /^debug_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_native_callback_plan_unavailable'; }
  }
  // ExternalLibrary references are external logic outside the debugger model, never producer frames.
  const callBoundary = describeOdcCallBoundaries(entryCalls, target);
  const prepared = {
    ok: true, state: 'prepared', lane: 'odc', execution: 'native-entry',
    action: { key: target.key, name: target.name, kind: target.kind, inputs: signature },
    ...(target.producerTarget ? { producerTarget: target.producerTarget } : {}),
    algorithm: resolution.algorithm, entry: resolution.entry, distance: resolution.entry.distance, callPath: resolution.callPath,
    ...(resolution.entryEligibility ? { entryEligibility: resolution.entryEligibility } : {}),
    path: resolution.path, bindings: resolution.bindings,
    alternatives: resolution.alternatives ?? [], overridden: resolution.overridden ?? false,
    ...(resolution.deterministicEntry ? { deterministicEntry: resolution.deterministicEntry } : {}),
    scenarios, scenariosValidated: scenarios.length, effects,
    effectEvidence: entryCalls.map(({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable, producer, reference }) => ({ kind, actionKey, actionKind, external, bodyRead, bodyUnavailable, producer, reference })),
    callBoundary, externalLogic: externalLogicBoundaries(callBoundary),
    runtimeRequestKeys: [...new Set([resolution.entry.key, ...entryCalls.map(c => c.actionKey).filter(Boolean)])],
    needs: { login: 'secure app-user sign-in window', binding: resolution.entry.key, acknowledgeEffects: effects.filter(e => e !== 'read-only') },
    inputCapabilities: { server: inputCapabilities('odc', 'server'), client: inputCapabilities('odc', 'client') },
    assumptions: ['DEV environment; a breakpoint on the entry could also catch another user request on the same action'],
    ...(sourceContract ? { sourceContract } : {}),
    ...(callbackPlan ? { callbackScopes: callbackPlan.derived, ...(callbackPlan.refusal ? { callbackRefusal: callbackPlan.refusal } : {}) } : {}),
    ...(callbackPlanError ? { callbackScopesError: callbackPlanError } : {}),
  };
  if (input.lifecycle === 'mounted') {
    if (endpoint || isBackground || !readers.runtime) throw new Error('debug_odc_native_mount_runtime_required');
    const runtimeEntry = resolveOdcRuntimeEntry(prepared, readers.runtime);
    if (!runtimeEntry.screen) throw new Error('debug_odc_native_mount_screen_required');
    prepared.mount = await prepareOdcMountClosures(readers.runtime.index, runtimeEntry.screen.key, readers.closure, classifyEffects);
    // Navigation target (navigate) or initial deep link (inputs on a non-default screen): canonical URL query,
    // target closures and effects; the scenario inputs stay in context.screen.inputs, never in entry inputs.
    const owner = await readers.resolveTarget(input.navigate ? input.navigate.screen : '@' + runtimeEntry.screen.key);
    if (!owner) throw new Error('debug_odc_native_mount_screen_required');
    const navigated = await prepareOdcMountNavigation({ index: readers.runtime.index, mount: prepared.mount, navigate: input.navigate,
      targetInputs: (owner.inputs ?? []).map(p => ({ name: p.name, dataType: p.dataType, mandatory: p.mandatory !== false })),
      scenarios: prepared.scenarios, readClosure: readers.closure, classifyEffects });
    prepared.mount = navigated.mount; prepared.scenarios = navigated.scenarios;
    // Trusted clicks: targets from the published render inspection, the onClick handler closures and effects.
    if (input.interactions) prepared.mount = (await prepareOdcMountInteractions({ index: readers.runtime.index, mount: prepared.mount,
      moduleKey: readers.binding?.moduleKey, interactions: input.interactions,
      resolveWidget: async target => { const w = await readers.resolveTarget(target); return w?.name ? { name: w.name } : null; },
      readClosure: readers.closure, classifyEffects })).mount;
    prepared.effects = [...new Set([...prepared.effects, ...prepared.mount.effects])];
    prepared.needs.acknowledgeEffects = prepared.effects.filter(e => e !== 'read-only');
    prepared.runtimeRequestKeys = [...new Set([...prepared.runtimeRequestKeys, ...prepared.mount.runtimeRequestKeys])];
  }
  if (endpoint) {
    if (input.context !== undefined || scenarios.some(s => s.context !== undefined)) throw new Error('debug_native_endpoint_screen_context_unsupported');
    for (const scenario of scenarios) buildNativeEndpointRequest(endpoint.plan, nativeEndpointScenarioInputs(prepared, endpoint.plan, scenario));
    const authentication = nativeEndpointAuthenticationCapability(endpoint.plan);
    // An unqualified authentication (unqualified ODC Basic is an SSAM policy) selects no context and opens no dialog.
    const credential = authentication.executable && authentication.requiredContext === 'endpoint-credential';
    const scheme = authentication.credentialScheme ?? 'header';
    prepared.adapter = { kind: 'rest-method', source: endpoint.plan.source, entryKey: endpoint.plan.entry.entryKey,
      method: endpoint.plan.method, authentication, contextMode: authentication.executable ? credential ? 'endpoint-credential' : input.contextMode ?? 'app-user' : null,
      appUserIdentityProved: false, rolesProved: false, propagationProved: false };
    // Qualified ODC Basic (scheme basic) and OnRequest Request.Headers guards (scheme header) reach endpoint-credential;
    // ODC Custom stays unqualified. The private dialog replaces the app-user sign-in; the scheme comes from the capability only.
    if (credential) Object.assign(prepared.needs, { contextMode: 'endpoint-credential', credentialScheme: scheme, loginWindow: true, login: null,
      endpointCredential: { dialog: 'SSAM Debug — ODC — ' + readers.binding?.module + ' — Endpoint Credential' + (scheme === 'basic' ? ' (Basic)' : ''),
        headers: authentication.headers, source: authentication.source, credentialScheme: scheme,
        ...(authentication.limitation ? { limitation: authentication.limitation } : {}),
        ...(authentication.localActions ? { localActions: authentication.localActions } : {}) } });
    if (!authentication.executable) Object.assign(prepared.needs, { login: null, loginWindow: false,
      refusal: { error: authentication.error, ...(authentication.alias ? { alias: authentication.alias } : {}),
        ...(authentication.reason ? { reason: authentication.reason } : {}),
        ...(authentication.platformRestriction !== undefined ? { platformRestriction: authentication.platformRestriction === true } : {}),
        ...(authentication.policy ? { policy: authentication.policy, platformLimit: authentication.platformLimit === true } : {}) } });
    Object.defineProperty(prepared, 'endpointContract', { value: endpoint.contract, enumerable: false });
  }
  if (isBackground) {
    if (input.context !== undefined || scenarios.some(s => s.context !== undefined)) throw new Error('debug_odc_timer_owner_context_unsupported');
    const tree = await readers.tree?.('@' + resolution.entry.key);
    prepared.adapter = prepareNativeBackground({ binding: { ...readers.binding, lane: 'odc', sourceSha256: readers.sourceContract?.sha256 },
      entryKey: resolution.entry.key, model: { schema: 'ssam-reading/1', model: readers.binding?.module,
        sourceSha256: readers.sourceContract?.sha256, tree } });
    prepared.needs.login = null; prepared.needs.contextMode = 'native-background';
  } else if (resolution.entry.entryKind === 'soap-method') {
    prepared.adapter = { kind: 'soap-method', executable: false, error: 'debug_native_endpoint_odc_exposed_soap_unavailable',
      limitation: 'Consumed SOAP executes through its original app caller; an O11 exposed SOAP service is not an ODC entry.' };
  }
  if (input.persist !== false) {
    const file = receiptFile(readers.binding, target.key);
    // The receipt records the decision, not the chosen input values (scenario inputs are dropped from the persisted copy).
    const { scenarios: _drop, ...persistable } = prepared;
    write(file, { schema: 'ssam-odc-native-receipt/1', op: 'prepare', at: now(), prepared: persistable });
    prepared.receiptPath = file;
  }
  return prepared;
}

export function nativeEndpointScenarioInputs(prepared, plan, scenario) {
  const values = {};
  for (const [name, canonical] of Object.entries(scenario.inputs ?? {})) {
    if (canonical.omitted) continue;
    const binding = prepared.bindings.find(item => item.targetInput === name);
    const entryName = prepared.action.key === prepared.entry.key ? name : binding?.control === 'direct' ? binding.entryInput : null;
    if (!entryName || !plan.entry.inputs.some(item => item.name === entryName)) throw new Error('debug_native_endpoint_target_input_not_controllable');
    if (Object.hasOwn(values, entryName) && JSON.stringify(values[entryName]) !== JSON.stringify(canonical.value)) throw new Error('debug_native_endpoint_target_inputs_conflict');
    values[entryName] = canonical.value;
  }
  return values;
}

function receiptFile(binding, targetKey) {
  const tenant = (binding?.tenant ?? 'offline').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(root, tenant, (binding?.module ?? 'module') + '.' + targetKey.replace(/[^A-Za-z0-9_+]/g, '_') + '.' + randomUUID() + '.json');
}

function unacknowledgedEffects(input, prepared) {
  const missing = prepared.needs.acknowledgeEffects.filter(effect => !(input.acknowledgeEffects ?? []).includes(effect));
  return missing.length ? { ok: false, state: 'effects-not-acknowledged', missing, entry: prepared.entry,
    message: 'run may cause ' + missing.join(', ') + '; pass acknowledgeEffects with these classes to run in DEV' } : null;
}
// A mounted screen runs only through the authorized original-bootstrap runner,
// never through the isolated handler runner.
export async function runMountedNativeEntry(input, prepared, readers, services = {}) {
  const refused = unacknowledgedEffects(input, prepared);
  if (refused) return refused;
  const { runOdcNativeMount } = await import('./debug-odc-native-mount-run.mjs');
  return runOdcNativeMount(input, prepared, readers, services);
}

// run: execute each prepared scenario through the ORIGINAL entry. Live only: it needs the secure login window and one
// live session per binding. The default adapter uses an isolated private process.
export async function runNativeEntry(input, readers, { worker, login, ...services } = {}) {
  const prepared = await prepareNativeEntry({ ...input, op: 'run', persist: false }, readers);
  if (!prepared.ok) return prepared;
  // Only the isolated live runner renews its native session after a hold; others would ignore it.
  if (input.holdBetweenScenarios && (prepared.mount || prepared.endpointContract || prepared.adapter))
    return { ok: false, state: 'entry-unavailable', error: 'debug_odc_native_hold_entry_unsupported', prepared };
  if (prepared.mount) return runMountedNativeEntry(input, prepared, readers, services);
  if (services.requireClientInspection && (prepared.endpointContract || prepared.adapter ||
      !['ClientAction', 'ScreenAction'].includes(prepared.entry?.kind)))
    return { ok: false, state: 'entry-unavailable', error: 'debug_odc_native_client_inspection_entry_required', prepared };
  // The Portal wake binds its scope itself (runOdcNativeBackground: scope, fixed deadline, then the single POST).
  if (services.prepareServerInspection && !prepared.endpointContract && prepared.adapter && prepared.adapter.kind !== 'timer-original-wake' &&
      prepared.adapter.trigger !== 'odc-portal-timer-wake')
    return { ok: false, state: 'entry-unavailable', error: 'debug_odc_native_server_inspection_entry_required', prepared };
  if (prepared.producerTarget?.executable === false) return { ok: false, state: 'entry-unavailable',
    error: prepared.producerTarget.error, prepared };
  const refused = unacknowledgedEffects(input, prepared);
  if (refused) return refused;
  if (prepared.endpointContract) {
    const { runOdcNativeEndpoint } = await import('./debug-odc-native-endpoint-run.mjs');
    return runOdcNativeEndpoint(input, prepared, readers, services);
  }
  if (prepared.adapter?.executable === false) return { ok: false, state: 'entry-unavailable', error: prepared.adapter.error, prepared };
  // Before any watch, sign-in or wake (port D7).
  if (backgroundRunnerAdapter(prepared.adapter) && odcBackgroundRunnerPending())
    return { ok: false, state: 'entry-unavailable', error: odcBackgroundRunnerPending(), prepared };
  if (prepared.adapter?.kind === 'workflow-event') {
    const { runOdcWorkflowEvent } = await import('./debug-odc-workflow-run.mjs');
    return runOdcWorkflowEvent(input, prepared, readers, services);
  }
  if (prepared.adapter?.kind === 'timer-original-wake') {
    const { runOdcTimerWake } = await import('./debug-odc-native-wake-run.mjs');
    return runOdcTimerWake(input, prepared, readers, services);
  }
  if (prepared.adapter?.trigger === 'odc-portal-timer-wake') {
    const { runOdcNativeBackground } = await import('./debug-odc-native-background-run.mjs');
    return runOdcNativeBackground(input, prepared, readers, services);
  }
  if ((!worker || !login) && readers.binding?.runtimeUrl && readers.binding?.moduleKey) {
    const { runOdcNativeLive } = await import('./debug-odc-native-live.mjs');
    return runOdcNativeLive(input, prepared, readers, services);
  }
  if (!worker || !login) {
    return { ok: false, state: 'needs-live', prepared,
      livePlan: [
        'Open the secure app-user sign-in window for ' + (readers.binding?.app ?? prepared.entry.name) + ' (debug-app-user-odc.mjs).',
        'Bind one live session to the entry ' + prepared.entry.name + ' (' + prepared.entry.entryKind + ').',
        'For each of the ' + prepared.scenariosValidated + ' scenario(s): call the original entry with the bound inputs through the native host/transport, observe outputs/exception' + (input.trace && input.trace !== 'none' ? '/trace' : '') + ', one send.',
        'Filter private values from every output; confirm cleanup and release the session.',
      ] };
  }
  // Effects gate, before the login window: every effect class prepare reported must be acknowledged by the caller.
  const session = await login(readers.binding);
  const results = []; let cleanupConfirmed = true, uncertain = false;
  try {
    for (const scenario of prepared.scenarios ?? []) {
      const result = await worker.invoke({ session, entry: prepared.entry, path: prepared.path, bindings: prepared.bindings, scenario, trace: input.trace ?? 'none' });
      results.push(result);
      if (result.uncertain) { uncertain = true; break; }
    }
  } catch { uncertain = true; }
  finally {
    try { const r = await worker.dispose?.(); if (r?.completed === false) cleanupConfirmed = false; } catch { cleanupConfirmed = false; }
    try { const r = await session?.release?.(); if (r?.ok === false) cleanupConfirmed = false; } catch { cleanupConfirmed = false; }
  }
  return { ok: !uncertain && cleanupConfirmed && results.every(r => r.ok || r.exception), state: uncertain ? 'uncertain' : 'answered',
    entry: prepared.entry, results, cleanupConfirmed, uncertain: uncertain || !cleanupConfirmed,
    notSent: prepared.scenarios.slice(results.length).map(s => s.name) };
}

export function statusNativeEntry(binding, { dir = root, liveDir = path.join(workspaceRoot, '.local', 'debugger', 'native-runs', 'odc') } = {}) {
  const tenant = (binding?.tenant ?? 'offline').replace(/[^A-Za-z0-9_.-]/g, '_');
  const folder = path.join(dir, tenant);
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter(f => f.endsWith('.json') && (!binding?.module || f.startsWith(binding.module + '.'))).map(f => path.join(folder, f)) : [];
  const runs = fs.existsSync(liveDir) ? fs.readdirSync(liveDir).filter(f => f.endsWith('.json')).map(f => path.join(liveDir, f)).flatMap(file => {
    try { const r = read(file); return r.binding?.tenant === binding.tenant && r.binding?.module === binding.module ? [{ path: r.receiptPath,
      operationId: r.operationId, state: r.state, uncertain: r.uncertain, lockRetained: r.lockRetained, at: r.finishedAt ?? r.startedAt }] : []; }
    catch { return []; }
  }) : [];
  const latest = files.map(f => ({ f, at: fs.statSync(f).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 10);
  return { ok: true, runs, receipts: latest.map(({ f }) => { try { const r = read(f); return { path: f, op: r.op, at: r.at, state: r.prepared?.state ?? r.state ?? null }; } catch { return { path: f, error: 'unreadable' }; } }) };
}

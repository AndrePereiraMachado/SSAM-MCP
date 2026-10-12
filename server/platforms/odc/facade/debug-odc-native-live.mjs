import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { acquireOdcNativeAssets, resolveOdcRuntimeEntry } from './debug-odc-native-assets.mjs';
import { createOdcNativeBroker } from './debug-odc-native-broker.mjs';
import { prepareDebugAppUser, releaseDebugAppUser, appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { headlessDebug, debugSessionDiagnostic } from './debug-runtime.mjs';
import { compactServerMap } from './debug-o11-native-run.mjs';
import { qualifyClientLocalHistory, qualifyClientLocalModel, qualifyClientLocalRuntime } from './debug-odc-native-client-local.mjs';
import { qualifyClientListModel } from './debug-odc-native-client-list.mjs';
import { prepareClientFlowModel } from './debug-odc-native-client-flow.mjs';
import { clientFunctionNames, prepareClientFunctionsModel } from './debug-odc-native-client-functions.mjs';
import { prepareStaticReadQualification, qualifyStaticReadRuntime, qualifyStaticReadHistory } from './debug-odc-native-static-read.mjs';
import { qualifyScenarioHold, readOdcRuntimeVersion } from './debug-odc-scenario-hold.mjs';
import { combineOdcActiveBindings, createOdcActiveBinding } from './debug-odc-active-binding.mjs';
import { keyToGuid } from './debug-odc-native-runtime.mjs';
import { odcAppUserAnchor } from './debug-app-user-odc.mjs';
const fail = code => { throw new Error('debug_odc_native_' + code); };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };
export function odcDebuggerBudget(expiresAt, timeoutSeconds = 90, calls = 1, now = Date.now()) {
  const remaining = Math.floor((Date.parse(expiresAt) - now) / 1000), invocation = timeoutSeconds + 15;
  if (!Number.isFinite(remaining) || remaining < 110 + invocation) fail('debugger_budget_insufficient');
  return Math.min(600, remaining, 110 + 60 + calls * invocation);
}
export function requireOdcInvocationBudget(expiresAt, timeoutSeconds = 90, now = Date.now()) {
  if (Date.parse(expiresAt) - now < (timeoutSeconds + 15) * 1000 || !Number.isFinite(Date.parse(expiresAt)))
    fail('debugger_budget_insufficient');
}

export function markOdcTraceIncomplete(result) {
  // Trace collection is secondary evidence. A broker failure must retain its
  // sanitized execution error or native exception, not become a trace error.
  if (result.ok === true) result.error = 'debug_odc_native_trace_incomplete';
  result.ok = false;
  result.traceVerified = false;
  result.traceError = 'debug_odc_native_trace_incomplete';
}

// The worker's read-only preflight failed before StartDebugSession: no native session can exist (not 618c60ae's
// attempted-without-answer class, which stays uncertain). Only the exact worker diagnostic qualifies.
export function odcStartKnownNotStarted(started) {
  const t = started?.transport;
  return t?.startOutcome === 'not-attempted' && t.tokenObtained === false &&
    /^debug_start_unreachable:preflight(?::[A-Za-z0-9_]{1,80})?$/.test(started.startError ?? '');
}
// Failure class from the worker receipt (DebugSession.Status transportPreflight); never native text.
function workerPreflight(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).transportPreflight;
    if (!p || !['answered', 'failed'].includes(p.outcome)) return null;
    return { outcome: p.outcome, failure: /^[A-Za-z0-9_]{1,80}$/.test(p.failure ?? '') ? p.failure : null,
      ipv4Answered: typeof p.ipv4Answered === 'boolean' ? p.ipv4Answered : null, ipv6OnlyFailure: p.ipv6OnlyFailure === true, ipv6Disabled: p.ipv6Disabled === true };
  } catch { return null; }
}
// Consumer + library breakpoints in one native session (native ExtendedBreakpointId(OwnerESpace.Key, node), see
// .local/debugger/odc-library-breakpoint-contract/findings.json). Only the runner's library-reference pair, which
// runs inside the consumer runtime; owners select BreakpointIds and never prove identity or propagation.
const KEY = /^[A-Za-z0-9_+]{22}$/;
export function odcBreakpointOwners(traceTarget, binding, traceBinding) {
  if (traceTarget?.consumerNodeKeys === undefined) return null;
  const producer = traceTarget.producerTarget, library = traceTarget.nodeKeys ?? [], consumer = traceTarget.consumerNodeKeys;
  if (producer?.kind !== 'library-reference' || producer.producerModuleKey !== traceBinding.moduleKey || producer.consumer?.moduleKey !== binding.moduleKey ||
      traceBinding.moduleKey === binding.moduleKey || traceBinding.runtimeUrl !== binding.runtimeUrl || !Array.isArray(library) || !Array.isArray(consumer) ||
      !consumer.length || ![...library, ...consumer].every(key => KEY.test(key ?? '')) ||
      new Set([...library, ...consumer]).size !== library.length + consumer.length || library.length + consumer.length > 200) fail('breakpoint_owners_invalid');
  return { nodeKeys: [...library, ...consumer],
    nodeModuleKeys: Object.fromEntries([...library.map(key => [key, traceBinding.moduleKey]), ...consumer.map(key => [key, binding.moduleKey])]) };
}

export function nativeScenarioInputs(prepared, plan, scenario) {
  if (plan.member.key === prepared.action.key) return scenario.inputs;
  const values = {};
  for (const binding of prepared.bindings) {
    const input = scenario.inputs[binding.targetInput]; if (!input || input.omitted) continue;
    if (binding.control !== 'direct' || !binding.entryInput || !plan.inputs.some(i => i.name === binding.entryInput)) fail('target_input_not_controllable');
    if (values[binding.entryInput] && JSON.stringify(values[binding.entryInput]) !== JSON.stringify(input)) fail('target_inputs_conflict');
    values[binding.entryInput] = input;
  }
  return values;
}

export async function runOdcNativeLive(input, prepared, readers, services = {}) {
  const root = services.root ?? workspaceRoot, binding = readers.binding;
  // Private orchestration may collect the one-use app-user session before
  // preparing this run. The public input never selects or rebinds a session.
  const sessionId = services.sessionId === undefined ? randomUUID().replaceAll('-', '') : services.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) fail('session_id_invalid');
  const operationId = randomUUID();
  const base = path.join(root, '.local', 'debugger'), dir = path.join(base, 'native-runs', 'odc', operationId);
  const hash = createHash('sha256').update('odc|' + binding.runtimeUrl + '|' + binding.moduleKey).digest('hex');
  // An explicitly qualified client-local run has a separate journal and mutex.
  // It cannot replace the historical index or acquire/release its request lock.
  const localOnly = services.clientLocal !== undefined, staticOnly = services.independentStaticRead !== undefined;
  if (localOnly && staticOnly) fail('independent_mode_conflict');
  const suffix = localOnly ? '.client-local' : staticOnly ? '.static-read' : '';
  const lock = path.join(base, 'native-runs', hash + suffix + '.lock'), latest = path.join(base, 'native-runs', 'odc', hash + suffix + '.json');
  const report = { schema: 'ssam-odc-native-run/1', operationId, sessionId, lane: 'odc', execution: 'native-entry', state: 'preparing',
    binding, startedAt: new Date().toISOString(),
    entry: prepared.entry, path: prepared.path, callPath: prepared.callPath, bindings: prepared.bindings, results: [],
    assumptions: prepared.assumptions, callBoundary: prepared.callBoundary,
    ...(prepared.producerTarget ? { producerTarget: prepared.producerTarget } : {}),
    receiptPath: path.join(dir, 'receipt.json'), appRequestIdentityProved: false, userRequestIsolationProved: false };
  const save = () => { write(report.receiptPath, report); write(latest, report); };
  let ownsLock = false, descriptor, broker, traceSession, traceExpiresAt, uncertain = false, pendingRequests = 0, clientLocal, staticRead;
  let hold = false, active, requestDeadline; const sessions = [];
  const debug = services.debug ?? headlessDebug, parity = services.producerOutputParity;
  const traceRead = services.traceRead ?? (id => { const file = path.join(base, id, 'trace.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; });
  async function verifyPublication(phase, remainingCalls) {
    try { await readers.verifyPublication?.(); }
    catch (error) {
      // The developer session can expire while the user enters app credentials.
      // A failed publication read is a pre-invocation refusal, not an action
      // execution failure. Do not expose Portal error text or retry the read.
      report.failurePhase = phase;
      report.notSent = remainingCalls.map(call => call.name);
      if (/^debug_[a-z_]+$/.test(error?.message ?? '')) throw error;
      fail('publication_check_failed');
    }
  }
  function history() {
    if (staticOnly) return qualifyStaticReadHistory(root, binding, services.independentStaticRead, prepared);
    return qualifyClientLocalHistory(root, binding, services.clientLocal);
  }
  try {
    hold = qualifyScenarioHold(input, services, { localOnly, staticOnly });
    if (localOnly) report.independentClientLocal = history();
    if (staticOnly) {
      report.independentStaticRead = history();
      if (input.context !== undefined || prepared.scenarios.length !== 1 || prepared.scenarios.some(s => s.context !== undefined ||
        Object.values(s.inputs ?? {}).some(v => prepared.entry.kind !== 'ScreenAction' || v?.omitted !== true || v?.originalDerived !== true)))
        fail('static_read_scenario_unsupported');
    }
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.dirname(lock), { recursive: true });
    const fd = fs.openSync(lock, 'wx'); ownsLock = true; fs.writeFileSync(fd, JSON.stringify({ operationId, sessionId })); fs.closeSync(fd);
    const runtime = readers.runtime ?? await (services.acquire ?? acquireOdcNativeAssets)(binding, path.join(dir, 'assets'));
    const plan = resolveOdcRuntimeEntry(prepared, runtime);
    if (staticOnly) {
      staticRead = qualifyStaticReadRuntime(prepared, plan, await prepareStaticReadQualification(prepared, readers, path.join(dir, 'static-read-model'),
        { readScopes: services.staticReadScopes, plan }), binding, runtime);
      report.independentStaticRead = { ...report.independentStaticRead, qualification: staticRead };
    }
    if (localOnly) {
      const source = readers.sourceContract;
      if (!source?.path || !/^[a-f0-9]{64}$/i.test(source.sha256 ?? '') || typeof readers.tree !== 'function'
        || createHash('sha256').update(fs.readFileSync(source.path)).digest('hex') !== source.sha256.toLowerCase()) fail('client_local_model_source_changed');
      const tree = await readers.tree('@' + prepared.action.key);
      const owner = plan.view && prepared.action.kind === 'ScreenAction' ? await readers.properties('@' + plan.view.key) : undefined;
      const model = tree.kind === 'ClientAction' && tree.children.some(n => n.kind === 'ForEachNode')
        ? qualifyClientListModel(tree, prepared)
        : tree.kind === 'ClientAction' && clientFunctionNames(tree).length
        ? await prepareClientFunctionsModel(tree, readers, prepared)
        : tree.children.some(n => n.kind === 'ExecuteClientActionNode') || tree.kind === 'ScreenAction' &&
          (plan.lifecycle || tree.children.some(n => n.kind === 'LocalVariable'))
        ? await prepareClientFlowModel(tree, owner, readers, prepared)
        : qualifyClientLocalModel(tree, prepared, owner);
      if (createHash('sha256').update(fs.readFileSync(source.path)).digest('hex') !== source.sha256.toLowerCase()) fail('client_local_model_source_changed');
      clientLocal = qualifyClientLocalRuntime(prepared, runtime, model);
      report.independentClientLocal = { ...report.independentClientLocal, plan: { ...clientLocal, model: undefined },
        sourceSha256: source.sha256.toLowerCase(), historicalStateResolved: false };
    }
    const scenarios = prepared.scenarios;
    if (!scenarios.length) fail('scenarios_required');
    const calls = scenarios.map((s, i) => ({ id: 'scenario-' + (i + 1), name: s.name, inputs: nativeScenarioInputs(prepared, plan, s),
      ...(s.context ?? input.context ? { context: s.context ?? input.context } : {}), trace: input.trace, timeoutSeconds: input.timeoutSeconds ?? 90 }));
    const needsServerTrace = !localOnly && (!!plan.member.call || !!prepared.producerTarget || ['ServerAction', 'ServiceAction', 'DataAction', 'Aggregate'].includes(prepared.action.kind));
    const traceTarget = input.trace !== 'none' && needsServerTrace ? await readers.traceTarget?.(prepared, input.window) : null;
    if (input.trace !== 'none' && needsServerTrace && !traceTarget?.nodeKeys?.length) fail('server_trace_target_unresolved');
    if (hold && !traceTarget) fail('hold_server_trace_required');
    const traceBinding = traceTarget?.binding ?? binding, traceActionKey = traceTarget?.actionKey ?? prepared.action.key;
    const owners = odcBreakpointOwners(traceTarget, binding, traceBinding);
    if (services.prepareServerInspection) {
      if (!traceTarget) fail('server_inspection_trace_required');
      const source = traceTarget.producerTarget?.sourceContract ?? readers.sourceContract;
      const models = [...new Set([binding.moduleKey, traceBinding.moduleKey])].map(moduleKey => {
        const selected = readers.inspectionModel?.(moduleKey);
        const pinned = selected?.source ?? (moduleKey === traceBinding.moduleKey ? source : readers.sourceContract);
        return { moduleKey, source: pinned };
      });
      await services.prepareServerInspection({ lane: 'odc', moduleKey: traceBinding.moduleKey, source, functionKey: traceActionKey, models,
        ...(owners ? { nodeModuleKeys: owners.nodeModuleKeys } : {}) });
    }
    await verifyPublication('publication-before-authentication', calls);
    report.runtime = { moduleVersion: runtime.moduleVersion, revision: binding.revision, memberKey: plan.member.key, invocation: plan.invocation,
      owner: plan.view?.displayName ?? null, hostScreen: plan.screen ? { key: plan.screen.key, displayName: plan.screen.displayName } : null,
      lifecycle: plan.lifecycle, mounted: false, modelSha256: readers.sourceContract.sha256 };
    report.scenarios = calls.map(c => ({ id: c.id, name: c.name })); save();
    broker = (services.broker ?? createOdcNativeBroker)({ beforeRequest: async metadata => {
      if (localOnly) return false;
      if (staticOnly) {
        history();
        if (!staticRead || metadata.path !== staticRead.endpoint || (report.requestEvidence?.length ?? 0) !== 0) {
          report.staticReadRequestsRefused = (report.staticReadRequestsRefused ?? 0) + 1; save(); return false;
        }
      }
      if (!descriptor || metadata.bindingSessionId !== sessionId || !calls.some(c => metadata.probeId.startsWith(c.id + '-')) || Date.parse(descriptor.expiresAt) <= Date.now()
        || metadata.privateEvidenceConfirmed !== true || (metadata.nativeCallContextSha256 !== null && !/^[a-f0-9]{64}$/.test(metadata.nativeCallContextSha256 ?? ''))) return false;
      (report.requestEvidence ??= []).push({ probeId: metadata.probeId, nativeCallContextSha256: metadata.nativeCallContextSha256,
        privateEvidenceConfirmed: true, requestOwnershipProved: false });
      pendingRequests++; report.pendingRequests = pendingRequests; save(); return true;
    } });
    const modelSources = services.requireClientInspection ? await readers.clientInspectionModels?.() ?? [] : [];
    // The producer-parity key reaches the native host's response observer through the private broker channel only.
    await broker.prepare({ runtime, prepared, binding, calls, operationId, sessionId, modelSources, ...(clientLocal ? { clientLocal } : {}),
      ...(parity ? { responseParityKey: parity.responseKey() } : {}) }); // Native initialization and input conversion precede the window.
    if (localOnly || staticOnly) history();
    report.state = 'sign-in'; save();
    const entered = await (services.prepareUser ?? prepareDebugAppUser)({ ...binding, lane: 'odc', seconds: 600 }, { sessionId });
    if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; return report; }
    descriptor = entered.descriptor;
    if (!sameAppUserTarget(descriptor?.binding, appUserBinding({ ...binding, lane: 'odc' }, sessionId))) fail('app_user_scope_mismatch');
    const authenticated = await broker.authenticate(descriptor);
    if (!authenticated?.authenticated || !authenticated.identityMatches) fail('native_identity_unproved');
    report.authentication = authenticated;
    // ODC Service identity: the coordinator's 'app-user' private-compare anchor, from the private descriptor
    // of this proved login only. Never for anonymous/native-background, never returned or persisted.
    if (services.registerAppUserAnchor && !['anonymous', 'native-background'].includes(input.contextMode)) {
      let anchor; try { anchor = odcAppUserAnchor(descriptor, authenticated); } catch { fail('app_user_anchor_unavailable'); }
      services.registerAppUserAnchor(anchor); report.appUserAnchor = { registered: true, valueReturned: false };
    }
    // Starts the native session for `count` remaining scenarios; a hold calls it again.
    async function startNativeTrace(count, phase) {
      report.debuggerBudget = { remainingAppUserSeconds: Math.floor((Date.parse(descriptor.expiresAt) - Date.now()) / 1000),
        requestedInvocationSeconds: input.timeoutSeconds ?? 90, requiredStartSeconds: 110 + (input.timeoutSeconds ?? 90) + 15 };
      const seconds = odcDebuggerBudget(descriptor.expiresAt, input.timeoutSeconds ?? 90, count), previous = sessions.length ? { sessions } : {};
      let started;
      try { started = await debug({ op: 'start', lane: 'odc', tenant: traceBinding.tenant, module: traceBinding.module, moduleKey: traceBinding.moduleKey, runtimeUrl: traceBinding.runtimeUrl,
        nodeKeys: owners?.nodeKeys ?? traceTarget.nodeKeys, ...(owners ? { nodeModuleKeys: owners.nodeModuleKeys } : {}), seconds, pauseSeconds: 5, autoContinue: true,
        trace: { mode: 'step', steps: Math.min(2000, count * (traceTarget.steps ?? 300)), depth: input.depth ?? 2, fullValues: input.trace === 'full',
          focusFunctionKey: traceActionKey, requireFunctionKey: traceActionKey, scopes: traceTarget.scopes ?? {} } },
        { appUser: descriptor, ...(traceTarget.producerTarget ? { redactionOnly: true, odcProducerTrace: traceTarget.producerTarget } : {}) }); }
      catch (error) { uncertain = true; report.serverTrace = { ...previous, state: 'start-outcome-unknown' }; throw error; }
      traceSession = started?.sessionId; report.serverTrace = { ...previous, sessionId: traceSession, state: started?.state, ...debugSessionDiagnostic(started),
        ...(owners ? { breakpointOwners: owners.nodeModuleKeys } : {}) };
      if (!started?.ok || started.state !== 'connected') {
        if (odcStartKnownNotStarted(started)) {
          // Known not started: a refusal, not an uncertain start. A worker that confirmed its local stop needs none.
          report.startRefused = true;
          Object.assign(report.serverTrace, { state: 'not-started', knownNotStarted: true, preflight: workerPreflight(started.receiptPath) });
          if (started.state === 'stopped') { traceSession = undefined; report.serverTrace.stopped = true; }
        } else uncertain = !!traceSession && started?.state !== 'stopped';
        report.failurePhase = phase;
        // The primary error retains native HTTP/message-id codes; the higher-level
        // classification stays separate and never replaces the worker's failure.
        report.serverTrace.error = 'debug_odc_native_server_trace_not_connected';
        const error = new Error('debug_odc_native_server_trace_not_connected');
        error.debugStartError = report.serverTrace.startError;
        throw error;
      }
      // The native host keeps its first request deadline; a renewed session never extends it.
      const deadline = Math.min(Date.parse(descriptor.expiresAt), Date.parse(started.expiresAt), requestDeadline ?? Infinity);
      if (!Number.isFinite(deadline)) fail('debugger_budget_insufficient');
      traceExpiresAt = new Date(deadline).toISOString();
      report.serverTrace.expiresAt = traceExpiresAt;
      if (started.inspectionMode === 'interactive') {
        if (started.autoContinue !== false || typeof broker.configureServerInspection !== 'function') fail('inspection_deadline_unavailable');
        if (requestDeadline === undefined) {
          const configured = await broker.configureServerInspection({ expiresAt: traceExpiresAt });
          if (configured?.configured !== true || configured.expiresAt !== traceExpiresAt) fail('inspection_deadline_invalid');
          requestDeadline = deadline;
        }
        report.serverTrace.inspectionMode = 'interactive';
        report.serverTrace.requestDeadline = new Date(requestDeadline).toISOString();
      }
    }
    // After scenario `call` was answered and its thread ended: confirmed native stop,
    // coordinator hold, unchanged publication/version/lease, then a fresh native session.
    async function holdAfter(call, result, remaining) {
      report.notSent = remaining.map(c => c.name);
      if (result.serverThreadEnded !== true || pendingRequests !== 0) { report.failurePhase = 'hold'; fail('hold_request_not_settled'); }
      let stopped;
      try { stopped = await debug({ op: 'stop', sessionId: traceSession }); } catch { stopped = null; }
      const record = { scenario: call.id, sessionId: traceSession, stop: debugSessionDiagnostic(stopped), stopped: stopped?.state === 'stopped' && !stopped.stopError };
      // One stop attempt per native session: an uncertain stop is never repeated and never held.
      sessions.push(record); traceSession = undefined;
      report.serverTrace = { ...report.serverTrace, sessions, stop: record.stop, stopped: record.stopped };
      if (!record.stopped) { uncertain = true; report.failurePhase = 'native-stop-before-hold'; fail('stop_before_hold_unconfirmed'); }
      active?.mark('held'); report.state = 'held'; save();
      try { await services.holdBetweenScenarios({ scenario: call.id, next: remaining[0].id, notSent: report.notSent }); }
      catch (error) { report.failurePhase = 'hold'; if (error?.message === 'debug_server_session_cancelled') report.holdCancelled = true; throw error; }
      active?.mark('idle'); report.state = 'invoking'; save();
      await verifyPublication('publication-after-hold', remaining);
      let version;
      try { version = await (services.readRuntimeVersion ?? readOdcRuntimeVersion)(binding); }
      catch (error) { report.failurePhase = 'publication-after-hold'; if (/^debug_[a-z_]+$/.test(error?.message ?? '')) throw error; fail('publication_check_failed'); }
      if (version !== report.runtime.moduleVersion) { report.failurePhase = 'publication-after-hold'; fail('runtime_version_changed_after_hold'); }
      // The renewed session keeps the first request deadline: refuse here rather than open a native session for nothing.
      const kept = new Date(Math.min(Date.parse(descriptor.expiresAt), requestDeadline ?? Infinity)).toISOString();
      try { requireOdcInvocationBudget(kept, input.timeoutSeconds ?? 90); odcDebuggerBudget(descriptor.expiresAt, input.timeoutSeconds ?? 90, remaining.length); }
      catch (error) { report.failurePhase = 'debugger-budget-after-hold'; throw error; }
      await startNativeTrace(remaining.length, 'server-trace-renewal');
      services.nativeSessionRenewed?.(traceSession);
    }
    // Deployment writes for this app, and for a different server-trace app whose
    // native pause holds the request, are refused while it is in flight or paused.
    if (!localOnly) {
      const marked = [...new Map([binding, traceBinding].map(b => [keyToGuid(b.moduleKey), b])).entries()];
      active = combineOdcActiveBindings(marked.map(([applicationKey, b]) => createOdcActiveBinding({ root, applicationKey, operationId, sessionId,
        runtimeUrl: b.runtimeUrl, moduleKey: b.moduleKey, environmentKey: b.environmentKey })));
      active.mark('idle'); services.activeBinding?.(active);
    }
    if (traceTarget) await startNativeTrace(calls.length, 'server-trace-start');
    report.state = 'invoking'; save();
    for (const call of calls) {
      await verifyPublication('publication-before-invocation', calls.slice(report.results.length));
      await services.beforeServerInvocation?.();
      if (traceSession) {
        try { requireOdcInvocationBudget(traceExpiresAt, input.timeoutSeconds ?? 90); }
        catch (error) {
          report.failurePhase = 'debugger-budget-before-invocation';
          report.notSent = calls.slice(report.results.length).map(c => c.name);
          throw error;
        }
      }
      if (localOnly || staticOnly) history();
      const before = traceSession ? traceRead(traceSession).length : 0;
      active?.mark('request-in-flight');
      parity?.begin(call.id);
      const result = await broker.invoke(call);
      // Private response prints never reach the report; only the coordinator's counts do, beside the untouched response.
      const prints = result?.responseParity; if (result && typeof result === 'object') delete result.responseParity;
      if (parity && result && !result.uncertain) {
        // Secondary evidence: a parity failure never hides or fails the answered request.
        try { result.producerOutputParity = parity.compare(prints, call.id); }
        catch { result.producerOutputParity = { schema: 'ssam-producer-output-parity/1', complete: false, reason: 'parity-unavailable', parityEqual: false }; }
      }
      report.results.push(result);
      if (staticOnly && ((report.requestEvidence?.length ?? 0) !== 1 || report.staticReadRequestsRefused)) {
        result.ok = false; result.error = 'debug_odc_native_static_read_request_unproved';
        uncertain ||= result.uncertain === true; break;
      }
      if (localOnly && (result.clientLocal?.enabled !== true || result.clientLocal?.networkAttemptsBlocked !== 0)) {
        result.ok = false; result.error = 'debug_odc_native_client_local_isolation_unproved'; break;
      }
      if (result.uncertain) { uncertain = true; break; }
      pendingRequests = 0; report.pendingRequests = 0; active?.mark('idle');
      if (traceSession) {
        // Wait for the terminal trace marker of this invocation; no re-execution.
        const deadline = Date.now() + 5000;
        let lines;
        const targetEnd = values => {
          const threads = new Set(values.filter(l => l.functionKey === traceActionKey && l.threadId).map(l => l.threadId));
          return values.some(l => l.kind === 'thread-end' && threads.has(l.threadId));
        };
        do { lines = traceRead(traceSession).slice(before); if (targetEnd(lines)) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
        result.serverMap = compactServerMap(lines); result.serverThreadEnded = targetEnd(lines);
        result.targetObserved = lines.some(l => l.functionKey === traceActionKey);
        if (traceTarget.producerTarget) result.producerObservation = { actionKey: traceActionKey,
          moduleKey: traceBinding.moduleKey, framesObserved: result.targetObserved,
          requestOwnershipProved: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false };
        result.traceVerified = result.targetObserved && result.serverThreadEnded;
        if (!result.traceVerified) markOdcTraceIncomplete(result);
      } else if (input.trace !== 'none') {
        result.targetObserved = result.visits?.some(v => v.functionKey === prepared.action.key) === true;
        result.traceVerified = result.targetObserved;
        if (!result.traceVerified) markOdcTraceIncomplete(result);
      }
      save();
      if (input.trace !== 'none' && !result.traceVerified) break;
      if (hold && report.results.length < calls.length) await holdAfter(call, result, calls.slice(report.results.length));
    }
    report.notSent = calls.slice(report.results.length).map(c => c.name); report.state = 'answered';
    return report;
  } catch (error) {
    uncertain ||= pendingRequests > 0;
    report.state = uncertain ? 'uncertain' : report.holdCancelled ? 'cancelled' : report.startRefused ? 'refused' : 'failed';
    report.error = debugSessionDiagnostic({ startError: error?.debugStartError }).startError ??
      (error?.code === 'EEXIST' ? 'debug_odc_native_binding_busy' : /^debug_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_native_execution_failed');
    return report;
  } finally {
    if (traceSession) {
      try {
        const stopped = await debug({ op: 'stop', sessionId: traceSession });
        report.serverTrace.stop = debugSessionDiagnostic(stopped);
        report.serverTrace.stopped = stopped?.state === 'stopped' && !stopped.stopError;
      }
      catch { report.serverTrace.stopped = false; }
      uncertain ||= !report.serverTrace.stopped;
    }
    if (broker) {
      try { const cleanup = await broker.dispose(); report.cleanup = cleanup; uncertain ||= cleanup?.completed !== true || cleanup.receipt?.transport?.uncertain === true || cleanup.receipt?.authenticationSyncUncertain === true; }
      catch { report.cleanup = { completed: false }; uncertain = true; }
    }
    if (descriptor) {
      try { report.credentialsReleased = (await (services.releaseUser ?? releaseDebugAppUser)(descriptor))?.ok === true; }
      catch { report.credentialsReleased = false; }
      uncertain ||= !report.credentialsReleased;
    }
    if (staticOnly && report.independentStaticRead) {
      try { history(); report.independentStaticRead.historyUnchangedAfterRun = true; }
      catch { report.independentStaticRead.historyUnchangedAfterRun = false; uncertain = true; }
    }
    report.finishedAt = new Date().toISOString();
    if (uncertain) report.state = 'uncertain';
    report.uncertain = uncertain; report.ok = report.state === 'answered' && !uncertain && report.results.every(r => (r.ok || r.exception) && (input.trace === 'none' || r.traceVerified === true));
    // An uncertain run keeps its active marker so ApplyConfigs stays refused until reconciled.
    if (active) { report.activeBinding = active.release({ uncertain }); if (report.activeBinding.retained && !uncertain) report.ok = false; }
    if (ownsLock) { report.lockRetained = uncertain; if (!uncertain) { try { fs.unlinkSync(lock); } catch { report.lockRetained = true; report.ok = false; } } }
    if (ownsLock) save();
  }
}

// The original REST endpoint shares the native runner's binding lock and trace.
// Authentication capability is checked before the private dialog or any send.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { compileNativeRestEndpoint, buildNativeEndpointRequest } from './debug-native-endpoint.mjs';
import { invokeNativeEndpointWorker, nativeEndpointAuthenticationCapability } from './debug-native-endpoint-worker.mjs';
import { nativeEndpointScenarioInputs } from './debug-odc-native-run.mjs';
import { prepareDebugAppUser, releaseDebugAppUser, appUserBinding, sameAppUserTarget,
  prepareEndpointCredential, releaseEndpointCredential, endpointCredentialBinding, sameEndpointCredentialTarget } from './debug-app-user.mjs';
import { headlessDebug, DebugInspectionPreflightError } from './debug-runtime.mjs';
import { compactServerMap } from './debug-o11-native-run.mjs';
import { planOdcCallbackScopes, assertOdcCallbackScopesDerived, withOdcCallbackTrace } from './debug-odc-native-graph.mjs';
import { actionModel, scopeRoots } from './debug-wrapper.mjs'; // pure model helpers only

const fail = code => { throw new Error('debug_native_endpoint_' + code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp', fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
};

export async function runOdcNativeEndpoint(input, prepared, readers, services = {}) {
  const root = services.root ?? workspaceRoot, binding = readers.binding;
  // compileEndpoint is an offline-test seam only. In production the hash-bound contract compiles here and ODC Custom
  // stays refused (request_header_api_unqualified) until ODC's request-header API inside OnAuthentication is qualified.
  const plan = (services.compileEndpoint ?? compileNativeRestEndpoint)(prepared.endpointContract), capability = nativeEndpointAuthenticationCapability(plan);
  // Typed refusal before any dialog, lock, trace or send (ODC Basic is an SSAM policy, not a platform limit).
  if (!capability.executable) return { ok: false, state: 'authentication-unqualified', error: capability.error,
    ...(capability.alias ? { errorAlias: capability.alias } : {}), ...(capability.reason ? { reason: capability.reason } : {}),
    ...(capability.policy ? { policy: capability.policy, platformLimit: capability.platformLimit === true } : {}),
    ...(capability.limitation ? { limitation: capability.limitation } : {}),
    ...(capability.platformRestriction !== undefined ? { platformRestriction: capability.platformRestriction } : {}), adapter: prepared.adapter };
  const contextMode = input.contextMode ?? 'app-user', credential = capability.requiredContext === 'endpoint-credential';
  if (credential && contextMode !== 'endpoint-credential') return { ok: false, state: 'context-required', error: 'debug_native_endpoint_context_explicit_required',
    needs: { contextMode: 'endpoint-credential', endpointCredential: { headers: capability.headers, source: capability.source,
      credentialScheme: capability.credentialScheme ?? 'header' } }, adapter: prepared.adapter };
  if (!credential && (contextMode !== 'anonymous' || capability.requiredContext !== 'explicit-anonymous'))
    return { ok: false, state: 'context-required', error: 'debug_native_endpoint_anonymous_context_explicit_required', adapter: prepared.adapter };
  // Runner-derived same-module REST callback scopes (inspection only): the entry's RestService callbacks and those of
  // the consumed RestActions its closure reaches. A consumed callback is qualified only toward the binding's own
  // runtime origin and under acknowledged external-http; otherwise refused before any dialog, lock or send.
  const read = async selector => readers.properties(selector);
  let callbackPlan = null;
  if ((input.trace ?? 'none') !== 'none' && typeof readers.properties === 'function') {
    callbackPlan = await planOdcCallbackScopes({ read, list: readers.list }, { entry: prepared.entry, calls: prepared.effectEvidence ?? [],
      binding, acknowledgeEffects: input.acknowledgeEffects ?? [] });
    if (callbackPlan.refusal) return { ok: false, ...callbackPlan.refusal, entry: prepared.entry, callbackScopes: callbackPlan.derived, adapter: prepared.adapter };
  }
  const operationId = randomUUID(), sessionId = randomUUID().replaceAll('-', '');
  const base = path.join(root, '.local', 'debugger'), directory = path.join(base, 'native-runs', 'odc', operationId);
  const digest = hash('odc|' + binding.runtimeUrl + '|' + binding.moduleKey);
  const lock = path.join(base, 'native-runs', digest + '.lock'), latest = path.join(base, 'native-runs', 'odc', digest + '.json');
  const report = { schema: 'ssam-odc-native-run/1', operationId, sessionId, lane: 'odc', execution: 'native-entry',
    state: 'preparing', binding, entry: prepared.entry, path: prepared.path, callPath: prepared.callPath, bindings: prepared.bindings,
    adapter: prepared.adapter, contextMode, results: [], startedAt: new Date().toISOString(), receiptPath: path.join(directory, 'receipt.json'),
    appRequestIdentityProved: false, rolesProved: false, propagationProved: false, userRequestIsolationProved: false,
    ...(credential ? { endpointHeaders: capability.headers } : {}), ...(callbackPlan ? { callbackScopes: callbackPlan.derived } : {}) };
  const save = () => { write(report.receiptPath, report); write(latest, report); };
  const debug = services.debug ?? headlessDebug;
  const readTrace = services.traceRead ?? (id => {
    const file = path.join(base, id, 'trace.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  });
  const trace = input.trace ?? 'none';
  let ownsLock = false, descriptor, traceSession, uncertain = false, sending = false, traceActionKey = prepared.action.key;
  try {
    if (fs.existsSync(path.join(base, 'blocked-bindings', digest + '.json'))) fail('binding_blocked');
    fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.dirname(lock), { recursive: true });
    const fd = fs.openSync(lock, 'wx'); ownsLock = true;
    fs.writeFileSync(fd, JSON.stringify({ operationId, sessionId })); fs.closeSync(fd);
    const calls = prepared.scenarios.map((scenario, i) => ({ id: 'scenario-' + (i + 1), name: scenario.name,
      inputs: nativeEndpointScenarioInputs(prepared, plan, scenario) }));
    if (!calls.length) fail('scenarios_required');
    for (const call of calls) buildNativeEndpointRequest(plan, call.inputs);
    await readers.verifyPublication?.();
    report.scenarios = calls.map(({ id, name }) => ({ id, name })); save();
    if (credential) {
      // The private dialog runs before any trace. Header values stay in the vault record; the
      // descriptor carries names only and is bound to this revision, service and header set.
      const credentialTarget = { lane: 'odc', runtimeUrl: binding.runtimeUrl, module: binding.module, moduleKey: binding.moduleKey,
        revision: plan.binding.revision, serviceKey: plan.entry.serviceKey, headers: capability.headers, scheme: capability.credentialScheme ?? 'header' };
      report.state = 'sign-in'; save();
      const entered = await (services.prepareEndpointCredential ?? prepareEndpointCredential)({ ...credentialTarget, seconds: 600 }, { sessionId });
      if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; report.error = entered?.error ?? 'debug_app_user_failed'; return report; }
      descriptor = entered.descriptor;
      if (!sameEndpointCredentialTarget(descriptor?.binding, endpointCredentialBinding(credentialTarget, sessionId))) throw new Error('debug_app_user_scope_mismatch');
    }
    if (trace !== 'none') {
      const target = await readers.traceTarget?.(prepared, input.window);
      if (!target?.nodeKeys?.length) fail('trace_target_unresolved');
      const traceBinding = target.binding ?? binding;
      traceActionKey = target.actionKey ?? prepared.action.key;
      const interactive = typeof services.prepareServerInspection === 'function';
      // The endpoint credential is redaction evidence for the original application's own action only.
      if (credential && (traceBinding.moduleKey !== binding.moduleKey || target.producerTarget)) fail('endpoint_credential_cross_module_inspection_unqualified');
      if (interactive) {
        // Anonymous inspection is confined to the original application's captured action.
        // A producer boundary needs its own qualified owner/identity contract.
        if (traceBinding.moduleKey !== binding.moduleKey || target.producerTarget) fail('anonymous_cross_module_inspection_unqualified');
      }
      // Callback scopes: a target naming a callback the runner did not derive is refused; derived Start nodes become
      // breakpoints of the original application's own trace only (a producer trace keeps none).
      let traced = target, callbacks = [];
      if (callbackPlan) {
        assertOdcCallbackScopesDerived(target, callbackPlan.derived, callbackPlan.callbackKeys, binding.moduleKey);
        if (traceBinding.moduleKey === binding.moduleKey && !target.producerTarget)
          ({ target: traced, callbacks } = await withOdcCallbackTrace(target, callbackPlan.derived, { mode: trace, read, actionModel, scopeRoots }));
        else report.callbackScopes = { ...callbackPlan.derived, scopes: [],
          excluded: [...callbackPlan.derived.excluded, ...callbackPlan.derived.scopes.map(({ nodeKeys, source, ...s }) => ({ ...s, reason: 'cross_module_trace' }))] };
      }
      if (interactive) await services.prepareServerInspection({ lane: 'odc', moduleKey: binding.moduleKey,
        source: readers.sourceContract, functionKey: traceActionKey,
        ...(callbacks.length ? { derivedScopes: callbackPlan.derived.scopes.map(({ moduleKey, functionKey, nodeKeys, callback, kind, source }) =>
          ({ moduleKey, functionKey, nodeKeys: [...nodeKeys], callback, kind, source })), callbackKeys: callbackPlan.callbackKeys, modules: [binding.moduleKey] } : {}) });
      // The dialog's identity is used solely to redact debugger data. The
      // explicitly anonymous endpoint receives no token, cookie or credentials.
      // An endpoint credential is itself the redaction-only descriptor: no second dialog.
      const watch = interactive && !credential;
      if (!interactive && !credential) {
        const entered = await (services.prepareUser ?? prepareDebugAppUser)({ ...binding, lane: 'odc', seconds: 600 }, { sessionId });
        if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; return report; }
        descriptor = entered.descriptor;
        if (!sameAppUserTarget(descriptor?.binding, appUserBinding({ ...binding, lane: 'odc' }, sessionId))) fail('app_user_scope_mismatch');
      }
      let started;
      try { started = await debug({ op: watch ? 'watch' : 'start', lane: 'odc', tenant: traceBinding.tenant, module: traceBinding.module,
        moduleKey: traceBinding.moduleKey, runtimeUrl: traceBinding.runtimeUrl, nodeKeys: traced.nodeKeys,
        seconds: Math.min(600, 60 + calls.length * ((input.timeoutSeconds ?? 90) + 15)), pauseSeconds: 5, autoContinue: true,
        trace: { mode: 'step', steps: Math.min(2000, calls.length * (target.steps ?? 300)), depth: input.depth ?? 2, fullValues: trace === 'full',
          focusFunctionKey: traceActionKey, requireFunctionKey: traceActionKey, scopes: traced.scopes ?? {} } },
      watch ? { anonymousWatch: true, contextMode: 'anonymous' } :
        { appUser: descriptor, redactionOnly: true, ...(target.producerTarget ? { odcProducerTrace: target.producerTarget } : {}) }); }
      catch (error) {
        const preflight = error instanceof DebugInspectionPreflightError;
        uncertain = !preflight;
        report.serverTrace = preflight
          ? { state: 'not-started', failurePhase: 'inspection-preflight', workerStarted: false, uncertain: false }
          : { state: 'start-outcome-unknown' };
        throw error;
      }
      traceSession = started?.sessionId;
      report.serverTrace = { sessionId: traceSession, state: started?.state, identityUse: watch ? 'explicit-anonymous' : 'redaction-only',
        ...(callbacks.length ? { callbacks } : {}) };
      if (started?.ok && started.state === 'connected' && !traceSession) {
        uncertain = true; fail('trace_session_id_missing');
      }
      if (!started?.ok || started.state !== 'connected') { uncertain = !!traceSession; fail('trace_not_connected'); }
      if (interactive) {
        if (started.inspectionMode !== 'interactive' || started.autoContinue !== false ||
            !Number.isFinite(Date.parse(started.expiresAt)) || Date.parse(started.expiresAt) <= Date.now()) fail('inspection_deadline_unavailable');
        // The worker refuses a request deadline past the credential lease.
        const deadline = credential ? Math.min(Date.parse(started.expiresAt), Date.parse(descriptor.expiresAt)) : Date.parse(started.expiresAt);
        if (!(deadline > Date.now())) fail('inspection_deadline_unavailable');
        report.serverTrace.inspectionMode = 'interactive'; report.serverTrace.requestDeadline = credential ? new Date(deadline).toISOString() : started.expiresAt;
      }
    }
    for (const call of calls) {
      await readers.verifyPublication?.();
      if (readers.sourceContract?.path && hash(fs.readFileSync(readers.sourceContract.path)) !== plan.binding.sourceSha256) fail('source_changed');
      const before = traceSession ? readTrace(traceSession).length : 0;
      await services.beforeServerInvocation?.();
      report.state = 'invoking'; report.inFlight = call.id; save(); sending = true;
      const result = await (services.invokeEndpoint ?? invokeNativeEndpointWorker)({ root, directory, operationId,
        scenarioId: call.id, timeoutSeconds: input.timeoutSeconds ?? 90, contract: prepared.endpointContract,
        inputs: call.inputs, context: credential ? 'endpoint-credential' : 'explicit-anonymous', ...(credential ? { descriptor } : {}),
        ...(report.serverTrace?.inspectionMode === 'interactive' ? { inspectionExpiresAt: report.serverTrace.requestDeadline } : {}) });
      sending = false; delete report.inFlight;
      result.name = call.name; report.results.push(result); uncertain ||= result.uncertain === true;
      if (uncertain) break;
      if (traceSession && result.sent) {
        const deadline = Date.now() + 5000; let lines;
        const targetEnd = values => {
          const threads = new Set(values.filter(line => line.functionKey === traceActionKey && line.threadId).map(line => line.threadId));
          return values.some(line => line.kind === 'thread-end' && threads.has(line.threadId));
        };
        do { lines = readTrace(traceSession).slice(before); if (targetEnd(lines)) break;
          await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
        result.serverMap = compactServerMap(lines);
        result.targetObserved = lines.some(line => line.functionKey === traceActionKey);
        result.serverThreadEnded = targetEnd(lines);
        result.traceVerified = result.targetObserved && result.serverThreadEnded;
        if (!result.traceVerified) { result.ok = false; result.error = 'debug_native_endpoint_trace_incomplete'; }
      }
      save(); if (!result.ok) break;
    }
    report.notSent = calls.slice(report.results.length).map(call => call.name); report.state = 'answered';
    return report;
  } catch (error) {
    uncertain ||= sending;
    report.state = uncertain ? 'uncertain' : 'failed';
    report.error = error?.code === 'EEXIST' ? 'debug_odc_native_binding_busy' : /^debug_[a-z0-9_]{1,100}$/.test(error?.message ?? '') ? error.message : 'debug_native_endpoint_execution_failed';
    return report;
  } finally {
    if (traceSession) {
      try { const stopped = await debug({ op: 'stop', sessionId: traceSession }); report.serverTrace.stopped = stopped?.ok === true && stopped.state === 'stopped'; }
      catch { report.serverTrace.stopped = false; }
      uncertain ||= !report.serverTrace.stopped;
    }
    if (descriptor) {
      try { report.credentialsReleased = (await (credential ? services.releaseEndpointCredential ?? releaseEndpointCredential
        : services.releaseUser ?? releaseDebugAppUser)(descriptor))?.ok === true; }
      catch { report.credentialsReleased = false; }
      uncertain ||= !report.credentialsReleased;
    }
    report.uncertain = uncertain; if (uncertain) report.state = 'uncertain';
    report.finishedAt = new Date().toISOString();
    report.ok = report.state === 'answered' && !uncertain && report.results.length > 0 &&
      report.results.every(result => result.ok && (trace === 'none' || result.traceVerified));
    if (ownsLock) {
      report.lockRetained = uncertain;
      if (!uncertain) try { fs.unlinkSync(lock); } catch { report.lockRetained = true; report.ok = false; }
      save();
    }
  }
}

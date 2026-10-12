// Observe an automatic BPT flow or Timer while invoking its ORIGINAL published REST/SOAP
// launcher. Launch response, observed background frames and instance ownership
// are independent evidence. An activity is never invoked as an ordinary action.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { actionModel, scopeRoots } from './debug-wrapper.mjs';
import { buildNativeEndpointRequest, compileNativeRestEndpoint, nativeEndpointBinding } from './debug-native-endpoint.mjs';
import { buildNativeSoapRequest, compileNativeSoapEndpoint } from './debug-native-endpoint-soap.mjs';
import { nativeEndpointAuthenticationCapability } from './debug-native-endpoint-worker.mjs';
import { appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { backgroundThreadOutcome, backgroundValuesCoverage } from './debug-background-correlation.mjs';
import { retainedLock, publicationFolders } from './debug-retained-locks.mjs';
import { activityFlowNodeKeys, buildO11BptScopePlan, o11BptValuesCoverage, readO11BptActivityScopes } from './debug-o11-bpt-scope.mjs';
// Read-only translation of Timer-path codes written under the old single bpt prefix (historical receipts).
export { HISTORICAL_CODE_ALIASES, HISTORICAL_FOLDER_ALIASES } from './debug-retained-locks.mjs';

const KEY = /^[A-Za-z0-9_+]{22}$/;
// Kind-specific namespace: 'timer' for a Timer wake (resolution.background.timerKey), 'bpt' for a process launch.
const kindOf = resolution => resolution?.background?.timerKey ? 'timer' : 'bpt';
const fail = (kind, code) => { throw new Error('debug_native_background_' + kind + '_' + code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const noIdentity = Object.freeze({ applicationUserContext: false, appUserIdentityProved: false,
  rolesProved: false, propagationProved: false, requestOwnershipProved: false, executionCompleted: false, instanceCorrelationProved: false });
// Service Center logs lag the ThreadEnd; the read-only correlation poll is bounded.
const TIMER_LOG_SECONDS = 90;

function complete(node, kind) {
  if (!node || !Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length)
    fail(kind, 'target_projection_incomplete');
}

// A binding retained by user decision (debug-retained-locks.mjs) is refused before any capture or launcher read.
// Without a resolution yet (runner pre-capture wiring) the kind may be omitted: debug_native_background_binding_retained.
export function refuseRetainedBackgroundBinding({ host, moduleKey, kind }) {
  if (retainedLock({ host, moduleKey })) throw new Error('debug_native_background_' + (kind ? kind + '_' : '') + 'binding_retained');
}

export function prepareO11BptObservation({ input, target, resolution, graph, captures }) {
  const kind = kindOf(resolution), timerWake = kind === 'timer';
  refuseRetainedBackgroundBinding({ host: target?.host, moduleKey: target?.moduleKey, kind });
  if (resolution?.state !== 'background-trigger-resolved' || resolution.originalLaunch?.state !== 'resolved' ||
      !KEY.test((timerWake ? resolution.background.timerKey : resolution.background?.processKey) ?? '')) fail(kind, 'original_launcher_unresolved');
  if (input.contextMode !== 'native-background') fail(kind, 'explicit_background_context_required');
  if (!input.launch || !['app-user', 'anonymous'].includes(input.launch.contextMode) ||
      !input.launch.inputs || typeof input.launch.inputs !== 'object' || Array.isArray(input.launch.inputs)) fail(kind, 'explicit_launch_contract_required');
  if (input.context !== undefined || input.scenarios !== undefined || Object.keys(input.inputs ?? {}).length)
    fail(kind, 'ambiguous_activity_inputs');
  const entry = graph.nodes.get(resolution.originalLaunch.entry.id);
  const targetNode = graph.nodes.get(resolution.path.at(-1)?.id);
  const timer = timerWake ? graph.nodes.get(entry?.moduleKey + '*' + resolution.background.timerKey) : null;
  const activity = timerWake && targetNode?.id === timer?.id ? graph.nodes.get(timer.moduleKey + '*' + timer.timer?.actionKey) : targetNode;
  if (!entry || !['rest-method', 'soap-method'].includes(entry.entry)) fail(kind, 'original_launcher_protocol_unavailable');
  if (!activity || !(timerWake ? ['ServerAction'] : ['AutomaticActivityNode', 'ServerAction']).includes(activity.kind) || !KEY.test(activity.startNodeKey ?? ''))
    fail(kind, 'automatic_flow_required');
  const process = graph.nodes.get(entry.moduleKey + '*' + resolution.background.processKey);
  const launch = graph.nodes.get(resolution.originalLaunch.path.at(-1)?.id);
  const nativePath = resolution.path.map(node => graph.nodes.get(node.id));
  if (nativePath[0]?.id !== entry.id || !Array.isArray(graph.edges) ||
      nativePath.slice(1).some((node, index) => !graph.edges.some(edge => edge.from === nativePath[index]?.id && edge.to === node?.id)))
    fail(kind, 'native_process_path_unproved');
  if (timerWake) {
    const wakeEdge = graph.edges.find(edge => edge.from === launch?.id && edge.to === timer?.id);
    if (!timer?.timer || timer.timer.error || launch?.kind !== 'TimerWakeAction' || timer.timer.wakeActionKey !== launch.key ||
        wakeEdge?.via?.kind !== 'timer-wake' || wakeEdge.via.asynchronous !== true || wakeEdge.via.timerKey !== timer.key ||
        !nativePath.some(node => node?.id === timer.id) ||
        !graph.edges.some(edge => edge.from === timer.id && edge.to === timer.moduleKey + '*' + timer.timer.actionKey && edge.via?.kind === 'timer'))
      fail(kind, 'native_timer_path_unproved');
  } else if (!process?.process || process.process.error || launch?.kind !== 'ProcessLaunchAction' ||
      process.process.launchActionKey !== launch.key ||
      !nativePath.some(node => node?.kind === 'AutomaticActivityNode' && node.processOwnerKey === process.key))
    fail(kind, 'native_process_path_unproved');
  // Cross-service background traces require a separate runtime-bound contract.
  // This implementation follows native process execution in its own module.
  if (entry.moduleKey !== target.moduleKey || activity.moduleKey !== entry.moduleKey ||
      nativePath.some(node => !node || node.kind === 'ServiceAction' || node.moduleKey !== entry.moduleKey)) fail(kind, 'runtime_boundary_unqualified');
  const owners = captures.filter(c => c.target.moduleKey === activity.moduleKey);
  if (owners.length !== 1) fail(kind, 'published_module_unavailable');
  const owner = owners[0];
  if (owner.target.module !== target.module || owner.target.applicationKey !== target.applicationKey ||
      new URL(owner.target.runtimeUrl).href !== new URL(target.runtimeUrl).href ||
      new URL(owner.target.runtimeUrl).hostname !== target.host.toLowerCase()) fail(kind, 'runtime_boundary_unqualified');
  if (sha(fs.readFileSync(owner.snapshot.path)) !== owner.snapshot.sha256) fail(kind, 'published_source_changed');
  const found = new Map();
  const visit = node => { if (node?.key === activity.key) found.set(JSON.stringify(node), node); for (const child of node?.children ?? []) visit(child); };
  for (const reading of owner.readings) visit(reading.tree ?? reading);
  if (found.size !== 1) fail(kind, 'target_projection_ambiguous');
  const tree = [...found.values()][0]; complete(tree, kind);
  for (const child of tree.children) complete(child, kind);
  const model = actionModel(tree);
  if (model.key !== activity.key || model.start !== activity.startNodeKey) fail(kind, 'target_start_mismatch');
  const roots = scopeRoots(model, Number.MAX_SAFE_INTEGER);
  return { owner, entry, activity, plan: { schema: timerWake ? 'ssam-o11-timer-observation/1' : 'ssam-o11-bpt-observation/1',
    kind: timerWake ? 'timer-original-wake' : 'process-original-launch',
    ...(timerWake ? { timerKey: timer.key, wakeActionKey: timer.timer.wakeActionKey, schedulerActionKey: timer.timer.actionKey } : { processKey: resolution.background.processKey }),
    moduleKey: activity.moduleKey, sourceSha256: owner.snapshot.sha256,
    targetKey: activity.key, targetKind: activity.kind, startNodeKey: model.start,
    originalEntryKey: entry.key, originalEntryKind: entry.entry, launchContext: input.launch.contextMode,
    activityContext: 'native-background', directActivityInvocation: false,
    scopes: { [activity.key]: roots.slice(0, 60) }, omittedScopeRoots: Math.max(0, roots.length - 60),
    observationSeconds: Math.min(60, input.timeoutSeconds ?? 30), valuesComplete: false, ...noIdentity } };
}

// ThreadEnd matched by (threadId, request fingerprint) with a later eventId; never completion.
export function observeO11BptFrames(entries, functionKey) {
  const o = backgroundThreadOutcome(entries, functionKey);
  return { captured: o.captured, observedThreadEnds: o.observedThreadEnds, targetObserved: o.targetObserved, traceVerified: o.traceVerified,
    requestBound: o.requestBound, requestFingerprintConsistent: o.requestFingerprintConsistent, fingerprints: o.fingerprints,
    endedFingerprints: o.endedFingerprints, unmatchedEnds: o.unmatchedEnds, ...noIdentity };
}

// Correlation comes only from the Service Center correlator, and only for a fingerprint the trace bound.
async function correlateTimer(timerInstance, baseline, threadOutcome) {
  if (!timerInstance) return { state: 'unavailable', reason: 'service_center_observer_unwired', instanceCorrelationProved: false, executionCompleted: false };
  let found;
  try { found = await timerInstance.observe({ baseline, threadOutcome, deadlineAt: Date.now() + TIMER_LOG_SECONDS * 1000 }); }
  catch { return { state: 'unproved', reason: 'service_center_read_failed', instanceCorrelationProved: false, executionCompleted: false }; }
  const bound = found?.instanceCorrelationProved === true && threadOutcome.requestFingerprintConsistent === true &&
    threadOutcome.fingerprints.includes(found.matchedFingerprint);
  if (!bound) return { ...found, instanceCorrelationProved: false, executionCompleted: false,
    outcome: 'unproved', ...(found?.instanceCorrelationProved === true ? { reason: 'fingerprint_not_in_trace' } : {}) };
  const completed = found.executionCompleted === true && (found.outcome === 'failed' ? found.errorBound === true
    : found.outcome === 'completed' && threadOutcome.endedFingerprints.includes(found.matchedFingerprint));
  return { ...found, executionCompleted: completed, ...(completed ? {} : { outcome: 'unproved' }) };
}
async function valuesCoverage(scopeEvidence, roots, omittedRoots) {
  if (!scopeEvidence) return { valuesComplete: false, reason: 'bounded_trace_without_native_completeness' };
  try { return backgroundValuesCoverage({ modelRoots: roots, omittedRoots, stops: await scopeEvidence() }); }
  catch { return { valuesComplete: false, reason: 'native_scope_reads_unavailable' }; }
}

export async function runO11BptOriginalLaunch(args) {
  const { input, target, resolution, graph, captures, mode, root, directory, operationId,
    report, save, debug, acquireEndpoint, invokeEndpoint, endpointPublicationCheck,
    prepareUser, releaseUser, traceRead, observeBackground, compactServerMap, prepareServerInspection, beforeServerInvocation,
    timerInstance, scopeEvidence, bptNativeScopes } = args;
  const kind = kindOf(resolution), [publicationBefore, publicationBeforeSend] = publicationFolders(kind);
  const { owner, entry, activity, plan: observation } = prepareO11BptObservation(args);
  // Process launch, full trace: activity roots from the installed model's native scope at every flow node
  // (debug-o11-bpt-scope.mjs), categorized by owner key. Only with explicit native scope-reader services; a
  // read or plan failure keeps the actionModel roots and records why.
  let processNode = null, nativeScopes = null, scopeActivities = null, scopePlan = null;
  if (observation.kind === 'process-original-launch' && mode === 'full' && bptNativeScopes && typeof bptNativeScopes === 'object') {
    try {
      const found = [], visit = n => { if (n?.key === resolution.background.processKey && n.kind === 'Process') found.push(n); for (const c of n?.children ?? []) visit(c); };
      for (const reading of owner.readings) visit(reading.tree ?? reading);
      if (found.length !== 1) throw new Error('debug_o11_bpt_scope_process_unavailable');
      processNode = found[0];
      scopeActivities = [{ key: activity.key, nodeKeys: activityFlowNodeKeys(processNode, activity.key) }];
      nativeScopes = await readO11BptActivityScopes({ source: owner.snapshot, moduleKey: owner.target.moduleKey, activityNodes: scopeActivities,
        directory: path.join(directory, 'bpt-scope') }, bptNativeScopes);
      scopePlan = buildO11BptScopePlan({ graph, processNode, activityNodes: scopeActivities, nativeScopes, launchCall: resolution.originalLaunch });
      Object.assign(observation, { scopes: scopePlan.traceScopes, omittedScopeRoots: scopePlan.omitted, scopeRoots: scopePlan.roots,
        missingScopes: scopePlan.missingScopes, unreadNodeScopes: scopePlan.unreadNodeScopes, launchBindings: scopePlan.launchBindings });
    } catch (error) { scopePlan = null; observation.scopeReadError = /^debug_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'debug_o11_bpt_scope_read_failed'; }
  }
  report.background = observation;
  report.needs = { contextMode: 'native-background', launchContextMode: input.launch.contextMode,
    inputContract: 'launch.inputs refers only to the original published launcher entry', words: true };
  const protocol = entry.entry === 'soap-method' ? 'soap' : 'rest';
  const binding = nativeEndpointBinding({ lane: 'o11', runtimeUrl: owner.target.runtimeUrl,
    module: owner.target.module, moduleKey: owner.target.moduleKey, revision: owner.versionId, sourceSha256: owner.snapshot.sha256 });
  const { contract } = await acquireEndpoint({ owner, entry, binding });
  const plan = (protocol === 'soap' ? compileNativeSoapEndpoint : compileNativeRestEndpoint)(contract);
  if (JSON.stringify(plan.binding) !== JSON.stringify(binding) || plan.entry.entryKey !== entry.key ||
      sha(fs.readFileSync(owner.snapshot.path)) !== binding.sourceSha256) fail(kind, 'launcher_source_binding_mismatch');
  const capability = nativeEndpointAuthenticationCapability(plan);
  if (!capability.executable) fail(kind, 'launcher_authentication_unavailable');
  const expectedContext = capability.requiredContext === 'explicit-anonymous' ? 'anonymous' : 'app-user';
  if (input.launch.contextMode !== expectedContext) fail(kind, 'launcher_context_mismatch');
  (protocol === 'soap' ? buildNativeSoapRequest : buildNativeEndpointRequest)(plan, input.launch.inputs);
  const launchKind = observation.kind === 'timer-original-wake' ? 'timer-wake' : 'bpt-launch';
  const contractPath = path.join(directory, 'native-' + launchKind + '-source.json');
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
  report.sourceContract = { path: contractPath, sha256: sha(fs.readFileSync(contractPath)) };
  report.entryAbi = { kind: entry.entry, protocol, endpoint: plan.url, inputs: plan.entry.inputs, outputs: plan.entry.outputs };
  report.needs.loginWindow = expectedContext === 'app-user';
  report.tracePlan = { mode, ...observation, depth: input.depth ?? 2, fullValues: mode === 'full' };
  if (prepareServerInspection) {
    if (observation.kind !== 'timer-original-wake' || mode !== 'full') fail(kind, 'interactive_timer_required');
    await prepareServerInspection({ lane:'o11',moduleKey:owner.target.moduleKey,source:owner.snapshot,functionKey:activity.key });
  }
  if (input.op === 'prepare') { report.state = 'prepared'; return { uncertain: false }; }
  if (input.op !== 'run' || typeof input.words !== 'string' || !input.words.trim()) fail(kind, 'explicit_authorization_required');
  // Persist the approval text before either scheduler activity or the launch request.
  const authorization = path.join(directory, 'background-authorization.json');
  fs.writeFileSync(authorization, JSON.stringify({ operationId, contextMode: 'native-background',
    launchContextMode: expectedContext, words: input.words, plan: observation }, null, 2), { flag: 'wx' });
  report.background.authorizationWordsSha256 = sha(input.words);
  let descriptor, debugSession, uncertain = false, timerBaseline = null, stopping = null;
  const outcome = { uncertain: false };
  // Stopped once: before the read-only Service Center correlation (whose poll may outlive the native lease), or in finally.
  const stopDebugger = () => stopping ??= (async () => {
    let stopped; try { stopped = await debug({ op: 'stop', sessionId: debugSession }); } catch { stopped = null; }
    report.serverTrace.stopped = stopped?.ok === true && stopped.state === 'stopped'; uncertain ||= !report.serverTrace.stopped;
  })();
  const timerWake = observation.kind === 'timer-original-wake';
  try {
    await endpointPublicationCheck(owner, path.join(directory, publicationBefore));
    if (expectedContext === 'app-user') {
      const sessionId = randomUUID().replaceAll('-', ''); report.state = 'sign-in'; save();
      const entered = await prepareUser({ lane: 'o11', ...target, seconds: 600 }, { sessionId });
      if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; return outcome; }
      descriptor = entered.descriptor;
      if (descriptor?.state !== 'credentials-entered' || descriptor.authenticated !== false ||
          !sameAppUserTarget(descriptor.binding, appUserBinding({ lane: 'o11', ...target }, sessionId)) ||
          !(Date.parse(descriptor.expiresAt) > Date.now()) || Date.parse(descriptor.expiresAt) > Date.now() + 600000)
        fail(kind, 'launcher_credential_binding_invalid');
    }
    if (mode !== 'none') {
      report.state = 'starting-background-watch'; save();
      let started;
      try { started = await debug({ op: 'watch', lane: 'o11', tenant: target.host, module: owner.target.module,
        moduleKey: owner.target.moduleKey, runtimeUrl: owner.target.runtimeUrl,
        o11Auth: { applicationKey: owner.target.applicationKey, publishedVersionId: owner.versionId, publishedProof: owner.inventoryProof },
        nodeKeys: [activity.startNodeKey], seconds: prepareServerInspection ? 600 : Math.min(600, observation.observationSeconds + input.timeoutSeconds + 30),
        pauseSeconds: 5, autoContinue: true, paths: [], trace: { mode: 'step', steps: 300, depth: input.depth ?? 2,
          fullValues: mode === 'full', scopes: mode === 'full' ? observation.scopes : {},
          focusFunctionKey: activity.key, requireFunctionKey: activity.key } }, { backgroundWatch: true, contextMode: 'native-background' }); }
      catch { uncertain = true; fail(kind, 'watch_start_uncertain'); }
      debugSession = started?.sessionId;
      report.serverTrace = { sessionId: debugSession ?? null, state: started?.state ?? null };
      if (!started?.ok || started.state !== 'connected') { uncertain = !!debugSession; fail(kind, 'watch_not_connected'); }
      if (prepareServerInspection) {
        const deadline=Date.parse(started.expiresAt);
        if (started.inspectionMode !== 'interactive' || started.autoContinue !== false || !Number.isFinite(deadline) || deadline<=Date.now() || deadline>Date.now()+600000)
          fail(kind, 'interactive_deadline_invalid');
        Object.assign(report.serverTrace,{inspectionMode:'interactive',requestDeadline:started.expiresAt});
      }
    }
    // Read-only exact-row baseline before the launch; without it no instance can be correlated.
    if (timerWake && timerInstance && debugSession) {
      try { timerBaseline = await timerInstance.baseline(); } catch { timerBaseline = null; }
      if (timerBaseline?.available !== true) fail(kind, 'timer_instance_baseline_unavailable');
    }
    await endpointPublicationCheck(owner, path.join(directory, publicationBeforeSend));
    if (sha(fs.readFileSync(owner.snapshot.path)) !== binding.sourceSha256) fail(kind, 'published_source_changed');
    if (descriptor && !(Date.parse(descriptor.expiresAt) > Date.now())) fail(kind, 'launcher_credential_binding_invalid');
    if (prepareServerInspection) await beforeServerInvocation?.();
    report.state = 'launching-background'; save();
    let reply;
    try { reply = await invokeEndpoint({ root, directory, operationId, protocol, timeoutSeconds: input.timeoutSeconds, scenarioId: launchKind, contract,
      inputs: input.launch.inputs, context: expectedContext === 'anonymous' ? 'explicit-anonymous' : 'app-user', ...(descriptor ? { descriptor } : {}) }); }
    catch { uncertain = true; fail(kind, 'launch_outcome_uncertain'); }
    if (!reply || typeof reply.sent !== 'boolean' || typeof reply.uncertain !== 'boolean' ||
        reply.answered === true && reply.sent !== true || reply.ok === true && (reply.sent !== true || reply.answered !== true)) {
      uncertain = true; fail(kind, 'launch_outcome_uncertain');
    }
    uncertain ||= reply.uncertain === true || reply.sent === true && reply.answered !== true || reply.memoryReferencesReleased !== true;
    const result = { name: 'original-' + launchKind, ok: reply.ok === true, outputs: reply.result?.outputs ?? null,
      status: reply.status ?? null, uncertain, requests: { submitted: reply.sent === true ? 1 : 0, answered: reply.answered === true ? 1 : 0 },
      ...noIdentity, ...(reply.error ? { error: reply.error } : {}) };
    report.results.push(result); save();
    if (debugSession && reply.sent === true && !uncertain) {
      report.state = 'observing-background'; save();
      const seconds=prepareServerInspection ? Math.max(0,(Date.parse(report.serverTrace.requestDeadline)-Date.now())/1000) : observation.observationSeconds;
      await observeBackground(debugSession, activity.key, seconds);
      const lines = traceRead(debugSession), threadOutcome = backgroundThreadOutcome(lines, activity.key);
      Object.assign(result, observeO11BptFrames(lines, activity.key));
      result.serverMap = compactServerMap(lines.filter(row => row.functionKey === activity.key && row.kind !== 'thread-end'));
      report.backgroundTrace = { functionKey: activity.key, ...observeO11BptFrames(lines, activity.key), visits: result.serverMap };
      if (prepareServerInspection && !result.traceVerified) { result.ok=false; result.error='debug_native_background_timer_interactive_trace_incomplete'; }
      // Values coverage per scope root from native reads only; never forced.
      result.valuesCoverage = scopePlan
        ? await o11BptValuesCoverage({ graph, processNode, activityNodes: scopeActivities, nativeScopes, launchCall: resolution.originalLaunch,
          interactive: !!prepareServerInspection, scopeEvidence, traceRows: lines })
        : await valuesCoverage(prepareServerInspection ? scopeEvidence : null, observation.scopes[activity.key], observation.omittedScopeRoots);
      result.valuesComplete = report.background.valuesComplete = result.valuesCoverage.valuesComplete === true;
      if (timerWake) {
        // After ThreadEnd and after the debugger stop: the bounded read-only Service Center correlation.
        await stopDebugger(); report.state = 'correlating-background'; save();
        report.instanceCorrelation = await correlateTimer(timerBaseline && timerInstance, timerBaseline, threadOutcome);
        Object.assign(result, { instanceCorrelationProved: report.instanceCorrelation.instanceCorrelationProved === true,
          executionCompleted: report.instanceCorrelation.executionCompleted === true, outcome: report.instanceCorrelation.outcome ?? 'unproved' });
      }
    }
    report.state = uncertain ? 'uncertain' : 'answered';
    // Scheduling, ThreadEnd and completion stay separate; completion only from the correlator.
    report.executionCompleted = !uncertain && report.results.at(-1)?.executionCompleted === true;
    return outcome;
  } finally {
    if (debugSession) await stopDebugger();
    if (descriptor) {
      try { report.credentialsReleased = (await releaseUser(descriptor))?.ok === true; } catch { report.credentialsReleased = false; }
      uncertain ||= !report.credentialsReleased;
    }
    report.uncertain = uncertain;
    outcome.uncertain = uncertain;
    if (uncertain) report.state = 'uncertain';
    // The outer runner owns the binding lock; cleanup uncertainty must keep it.
    save();
  }
}

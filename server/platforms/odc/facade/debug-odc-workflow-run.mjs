// ODC Workflow starts through an ORIGINAL published Global Event producer.
// Event emission, service frames and Workflow instance completion are separate.
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { actionModel, scopeRoots, traceWindow } from './debug-wrapper.mjs';
import { resolveOdcRuntimeEntry, acquireOdcNativeAssets } from './debug-odc-native-assets.mjs';
import { nativeScenarioInputs } from './debug-odc-native-live.mjs';
import { createOdcNativeBroker } from './debug-odc-native-broker.mjs';
import { prepareDebugAppUser, releaseDebugAppUser, appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { headlessDebug } from './debug-runtime.mjs';
import { compactServerMap } from './debug-o11-native-run.mjs';
import { classifyEffects } from './debug-odc-native-run.mjs';
import { backgroundThreadOutcome, backgroundValuesCoverage } from './debug-background-correlation.mjs';
import { bindOdcTimerInstance, openOdcTimerInstance, requestIdShapeOf, INSTANCE_SECONDS } from './debug-odc-background-instance.mjs';

const KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error('debug_odc_workflow_' + code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unproved = { appUserIdentityProved: false, rolesProved: false, propagationProved: false,
  requestOwnershipProved: false, instanceCorrelationProved: false, executionCompleted: false, valuesComplete: false };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };
function complete(node) {
  if (!node || !Array.isArray(node.children) || node.childrenTotal !== node.children.length || node.childrenOmitted !== 0 ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length)
    fail('model_projection_incomplete');
  for (const child of node.children) complete(child);
}
function pin(source) {
  if (!source || !/^[a-f0-9]{64}$/i.test(source.sha256 ?? '') || sha(fs.readFileSync(source.path ?? source.file)) !== source.sha256.toLowerCase())
    fail('published_source_changed');
}
const one = (values, code) => { if (values.length !== 1) fail(code); return values[0]; };
const argumentsOf = node => (node.children ?? []).filter(child => child.kind === 'Argument').map(child => ({
  parameter: child.propertyReferences?.Parameter?.name, parameterKey: child.propertyReferences?.Parameter?.key,
  expression: child.properties?.Value }));

async function originalReference(reader, ref, binding, original, kind) {
  if (!ref?.key || !/^Reference:[^/]+\//.test(ref.path ?? '')) fail('original_reference_unavailable');
  const signature = await reader.tree('@' + ref.key);
  const reference = await reader.properties(ref.path.split('/')[0]);
  complete(signature);
  const p = reference.properties ?? {}, library = p.ModuleType === 'ReactiveLibrary';
  const importedRevision = typeof p.Revision === 'string' && /^[1-9][0-9]*$/.test(p.Revision) ? Number(p.Revision) : null;
  // App references are dynamic in the native SDK and may have no Revision.
  // Preserve that fact; the separately pinned, revalidated deployed producer
  // supplies the execution revision. A library still requires its exact lock.
  const revisionValid = Number.isSafeInteger(importedRevision) && (!library || importedRevision === binding.revision)
    || !library && (p.Revision == null || p.Revision === '');
  if (signature.kind !== kind || signature.properties?.OriginalKey !== original.key ||
      reference.kind !== 'Reference' || p.ModuleKey !== binding.moduleKey || !revisionValid ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 1) fail('original_reference_mismatch');
  const imported = signature.children.filter(p => /^(Input|Output)ParameterSignature$/.test(p.kind));
  const owned = original.children.filter(p => /^(Input|Output)Parameter$/.test(p.kind));
  if (imported.length !== owned.length || new Set(imported.map(p => p.properties?.OriginalKey)).size !== imported.length || imported.some(p => {
    const expected = owned.find(row => row.key === p.properties?.OriginalKey);
    return !expected || p.kind !== expected.kind + 'Signature' || p.name !== expected.name ||
      p.propertyReferences?.DataType?.key !== expected.propertyReferences?.DataType?.key ||
      p.properties?.IsMandatory !== expected.properties?.IsMandatory;
  })) fail('imported_signature_changed');
  return { key: signature.key, originalKey: original.key, moduleKey: binding.moduleKey,
    importedRevision, revision: binding.revision, revisionBinding: library ? 'fixed-library' : 'deployed-app', kind, signature };
}

function directArguments(args, destinations, sources, expressionFor, code) {
  if (args.length !== destinations.length || new Set(args.map(a => a.parameterKey)).size !== destinations.length || args.some(arg => {
    const destination = destinations.find(p => p.key === arg.parameterKey && p.name === arg.parameter);
    const source = sources.find(p => arg.expression === expressionFor(p));
    return !destination || !source || destination.propertyReferences?.DataType?.key !== source.propertyReferences?.DataType?.key;
  })) fail(code);
}

export async function prepareOdcWorkflowEvent(input, readers, { prepareEntry }) {
  if (!input.workflow || input.contextMode !== 'native-background' || input.launch?.contextMode !== 'app-user')
    fail('explicit_launch_context_required');
  if (input.context !== undefined || input.scenarios !== undefined || Object.keys(input.inputs ?? {}).length ||
      !input.launch.inputs || Array.isArray(input.launch.inputs)) fail('ambiguous_inputs');
  const attached = readers.workflow;
  if (!attached?.reader || !attached.binding || input.workflow.module !== attached.binding.module ||
      readers.binding.tenant !== attached.binding.tenant || readers.binding.environmentKey !== attached.binding.environmentKey)
    fail('published_workflow_binding_unavailable');
  pin(readers.sourceContract); pin(attached.sourceContract);
  const target = await readers.resolveTarget(input.action);
  if (target?.kind !== 'ServiceAction' || target.producerTarget) fail('owned_service_action_required');
  const targetTree = await readers.tree('@' + target.key); complete(targetTree);
  if (targetTree.key !== target.key || targetTree.kind !== 'ServiceAction' || /^Reference:/.test(targetTree.path ?? '')) fail('owned_service_action_required');
  const candidates = [];
  for (const row of await attached.reader.list('BusinessProcess')) {
    if (input.workflow.process && ![row.key, '@' + row.key, row.name].includes(input.workflow.process)) continue;
    const tree = await attached.reader.tree('@' + row.key); complete(tree);
    for (const activity of tree.children.filter(node => node.kind === 'AutomaticActivityNode')) {
      const ref = activity.propertyReferences?.ActionToTrigger;
      if (!ref?.key) continue;
      const signature = await attached.reader.properties('@' + ref.key);
      if (signature.properties?.OriginalKey === target.key) candidates.push({ tree, activity });
    }
  }
  const { tree: process, activity } = one(candidates, 'automatic_activity_ambiguous_or_absent');
  const start = one(process.children.filter(node => node.kind === 'StartNode'), 'event_start_unavailable');
  const end = one(process.children.filter(node => node.kind === 'EndNode'), 'workflow_end_unavailable');
  if (start.properties?.TriggerMode !== 'Event' || start.propertyReferences?.Target?.key !== activity.key ||
      activity.propertyReferences?.Target?.key !== end.key || process.children.filter(node => /Node$/.test(node.kind)).length !== 3)
    fail('native_event_flow_unqualified');
  const importedEvent = start.propertyReferences?.StartProcessOn;
  if (!importedEvent?.key) fail('original_event_unavailable');
  const eventSignature = await attached.reader.properties('@' + importedEvent.key);
  const eventKey = eventSignature.properties?.OriginalKey;
  if (!KEY.test(eventKey ?? '')) fail('original_event_unavailable');
  const eventTree = await readers.tree('@' + eventKey); complete(eventTree);
  if (eventTree.kind !== 'GlobalEvent' || /^Reference:/.test(eventTree.path ?? '')) fail('original_event_unavailable');
  const { signature: importedEventTree, ...eventReference } = await originalReference(attached.reader, importedEvent, readers.binding, eventTree, 'GlobalEventSignature');
  const { signature: importedServiceTree, ...serviceReference } = await originalReference(attached.reader, activity.propertyReferences.ActionToTrigger, readers.binding, targetTree, 'ServiceActionSignature');
  const eventInputs = eventTree.children.filter(p => p.kind === 'InputParameter'), activityArgs = argumentsOf(activity);
  directArguments(activityArgs, importedServiceTree.children.filter(p => p.kind === 'InputParameterSignature'),
    importedEventTree.children.filter(p => p.kind === 'InputParameterSignature'), p => start.name + '.' + importedEvent.name + '.' + p.name, 'event_to_activity_inputs_unqualified');
  const emitters = [];
  for (const usage of await readers.usages(eventKey)) {
    const consumer = usage.consumer;
    if (consumer?.kind !== 'TriggerGlobalNode') continue;
    const trigger = await readers.tree('@' + consumer.key); complete(trigger);
    if (trigger.propertyReferences?.Event?.key !== eventKey) continue;
    const parentPath = consumer.path?.split('/').slice(0, -1).join('/');
    const emitter = await readers.resolveTarget(parentPath);
    if (emitter?.kind === 'ServerAction') emitters.push({ emitter, trigger });
  }
  const { emitter, trigger } = one(emitters, 'event_emitter_ambiguous_or_absent');
  const emitterTree = await readers.tree('@' + emitter.key); complete(emitterTree);
  const emitterStart = one(emitterTree.children.filter(n => n.kind === 'StartNode'), 'emitter_flow_unqualified');
  const emitterEnd = one(emitterTree.children.filter(n => n.kind === 'EndNode'), 'emitter_flow_unqualified');
  if (emitterStart.propertyReferences?.Target?.key !== trigger.key || trigger.propertyReferences?.Target?.key !== emitterEnd.key ||
      emitterTree.children.filter(n => /Node$/.test(n.kind) && n.kind !== 'CommentNode').length !== 3 ||
      [start, activity, end, emitterStart, trigger, emitterEnd].some(n => n.properties?.IsDisabled !== 'False')) fail('emitter_flow_unqualified');
  const triggerArgs = argumentsOf(trigger);
  directArguments(triggerArgs, eventInputs, emitterTree.children.filter(p => p.kind === 'InputParameter'), p => p.name, 'emitter_event_inputs_unqualified');
  const { workflow: _w, launch: _l, ...originalInput } = input;
  const emission = await prepareEntry({ ...originalInput, action: '@' + emitter.key, contextMode: 'app-user', inputs: input.launch.inputs,
    trace: 'none', persist: false }, readers);
  if (!emission.ok || emission.adapter || !emission.entry || emission.scenarios.length !== 1) fail('original_emitter_entry_unavailable');
  const model = actionModel(targetTree), roots = scopeRoots(model, Number.MAX_SAFE_INTEGER), selected = traceWindow(model, input.window ?? {});
  if (!KEY.test(model.start ?? '') || !selected.entries.length) fail('service_trace_unavailable');
  const effects = [...new Set([...emission.effects, ...classifyEffects(target.closureCalls ?? await readers.closure('@' + target.key)), 'workflow-start'])];
  const prepared = { ok: true, state: 'prepared', lane: 'odc', execution: 'native-entry',
    action: { key: target.key, name: target.name, kind: target.kind, inputs: target.inputs }, entry: emission.entry,
    path: emission.path, callPath: emission.callPath, scenarios: emission.scenarios, scenariosValidated: 1, effects,
    sourceContract: readers.sourceContract,
    adapter: { kind: 'workflow-event', executable: true, processKey: process.key, activityKey: activity.key,
      workflow: { binding: attached.binding, sourceContract: attached.sourceContract }, eventKey, eventReference, serviceReference,
      emitterKey: emitter.key, triggerKey: trigger.key, eventArguments: triggerArgs, activityArguments: activityArgs,
      launchContext: 'app-user', activityContext: 'native-background', ...unproved },
    tracePlan: { mode: input.trace ?? 'none', functionKey: target.key, nodeKeys: selected.entries, steps: selected.steps,
      depth: input.depth ?? 2, fullValues: input.trace === 'full', scopes: input.trace === 'full' ? { [target.key]: roots.slice(0, 60) } : {},
      omittedScopeRoots: Math.max(0, roots.length - 60), observationSeconds: Math.min(60, input.timeoutSeconds ?? 30), ...unproved },
    needs: { login: 'secure app-user sign-in for original event emitter', contextMode: 'native-background', launchContextMode: 'app-user', words: true,
      acknowledgeEffects: effects, inputContract: 'launch.inputs belongs to the original event-emitting action' },
    assumptions: ['Event values and function frames do not establish exclusive Workflow instance ownership or completion'] };
  Object.defineProperty(prepared, 'emission', { value: emission, enumerable: false });
  return prepared;
}

// ThreadEnd matched by (threadId, native request fingerprint) with a later eventId: thread ids
// are reused across requests. Without a fingerprint it stays traceVerified, requestBound=false.
export function observeOdcWorkflow(lines, functionKey) {
  const frames = lines.filter(line => line.kind !== 'thread-end' && line.functionKey === functionKey);
  return { ...backgroundThreadOutcome(lines, functionKey), visits: compactServerMap(frames), ...unproved };
}
// Per-root coverage of the bound background scope from native reads of an interactive session only.
async function odcValuesCoverage(scopeEvidence, roots, omittedRoots) {
  if (!scopeEvidence) return { valuesComplete: false, reason: 'bounded_trace_without_native_completeness' };
  try { return backgroundValuesCoverage({ modelRoots: roots ?? [], omittedRoots: omittedRoots ?? 0, stops: await scopeEvidence() }); }
  catch { return { valuesComplete: false, reason: 'native_scope_reads_unavailable' }; }
}

// The original emitter is invoked once by the private native runtime host. The
// developer watch has no app-user descriptor: the automatic activity runs in
// the platform's background context, independently of the authenticated emitter.
export function runOdcWorkflowEvent(input, prepared, readers, services = {}) {
  if (prepared.adapter?.kind !== 'workflow-event') fail('original_emitter_entry_unavailable');
  return runOdcOriginalBackground(input, prepared, readers, services);
}

export async function runOdcOriginalBackground(input, prepared, readers, services = {}) {
  if (input.contextMode !== 'native-background' || input.launch?.contextMode !== 'app-user' ||
      !wordsGiven(input.words)) fail('explicit_authorization_required'); // CX15 r7: one predicate
  if (!['workflow-event', 'timer-original-wake'].includes(prepared.adapter?.kind) || !prepared.emission || prepared.emission.scenarios.length !== 1)
    fail('original_emitter_entry_unavailable');
  const workflow = prepared.adapter.kind === 'workflow-event', answeredState = workflow ? 'emitted' : 'scheduled';
  if (services.prepareServerInspection && (workflow || prepared.tracePlan?.mode !== 'full')) fail('interactive_timer_required');
  const binding = readers.binding, trace = prepared.tracePlan, root = services.root ?? workspaceRoot;
  const operationId = randomUUID(), sessionId = randomUUID().replaceAll('-', '');
  const base = path.join(root, '.local', 'debugger'), id = sha('odc|' + binding.runtimeUrl + '|' + binding.moduleKey);
  const directory = path.join(base, 'native-runs', 'odc', operationId), lock = path.join(base, 'native-runs', id + '.lock');
  const latest = path.join(base, 'native-runs', 'odc', id + '.json');
  const report = { schema: 'ssam-odc-native-run/1', operationId, sessionId, lane: 'odc', execution: 'native-entry',
    binding, contextMode: 'native-background', state: 'preparing', entry: prepared.entry, adapter: prepared.adapter,
    startedAt: new Date().toISOString(), receiptPath: path.join(directory, 'receipt.json'), results: [],
    // CX15 r5 (N-3): the receipt (and its latest copy) keeps wordsSha256 of the words, never the words.
    authorization: { wordsSha256: sha(input.words), scope: workflow ? 'original-event-emission' : 'original-timer-wake', replayAllowed: false },
    tracePlan: trace, ...unproved, ...(workflow ? {} : { wakeOwnershipProved: false }) };
  const save = () => { write(report.receiptPath, report); write(latest, report); };
  const debug = services.debug ?? headlessDebug;
  // Timer instance: read-only Portal correlator in the developer session (never the app user), only with a trace.
  const instance = workflow || trace.mode === 'none' ? null : services.timerInstance !== undefined ? services.timerInstance
    : openOdcTimerInstance({ binding, sourceSha256: readers.sourceContract.sha256?.toLowerCase(), timer: prepared.adapter,
      callerName: prepared.emission.action?.name ?? null, root });
  const traceRead = services.traceRead ?? (session => {
    const file = path.join(base, session, 'trace.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  });
  const observe = services.observeWorkflow ?? (async (session, functionKey, seconds) => {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (observeOdcWorkflow(traceRead(session), functionKey).traceVerified) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  });
  let ownsLock = false, uncertain = false, descriptor, broker, traceSession, inspectionDeadline, requestReserved = false, requestAnswered = false, reservedAt;
  const verify = async () => {
    pin(readers.sourceContract);
    if (typeof readers.verifyPublication !== 'function') fail('publication_verifier_unavailable');
    await readers.verifyPublication();
    if (workflow) {
      pin(readers.workflow.sourceContract);
      if (typeof readers.workflow.verifyPublication !== 'function') fail('publication_verifier_unavailable');
      await readers.workflow.verifyPublication();
    }
  };
  try {
    for (const [folder, suffix] of [['blocked-bindings', '.json'], ['native-background-bindings', '.lock'], ['native-endpoint-bindings', '.lock']])
      if (fs.existsSync(path.join(base, folder, id + suffix))) fail('binding_blocked');
    fs.mkdirSync(path.dirname(lock), { recursive: true }); const fd = fs.openSync(lock, 'wx'); ownsLock = true;
    try { fs.writeFileSync(fd, JSON.stringify({ operationId, sessionId, state: 'preparing' })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    save(); await verify();
    if (services.prepareServerInspection) await services.prepareServerInspection({ lane: 'odc', moduleKey: binding.moduleKey,
      source: readers.sourceContract, functionKey: trace.functionKey });
    const runtime = readers.runtime ?? await (services.acquire ?? acquireOdcNativeAssets)(binding, path.join(directory, 'assets'));
    const plan = (services.resolveRuntime ?? resolveOdcRuntimeEntry)(prepared.emission, runtime);
    const scenario = prepared.emission.scenarios[0];
    const call = { id: workflow ? 'event-1' : 'wake-1', name: scenario.name, inputs: nativeScenarioInputs(prepared.emission, plan, scenario),
      trace: 'none', timeoutSeconds: input.timeoutSeconds ?? 90 };
    report.runtime = { revision: binding.revision, moduleVersion: runtime.moduleVersion, memberKey: plan.member.key,
      modelSha256: readers.sourceContract.sha256, sourceBodiesChanged: false };
    broker = (services.broker ?? createOdcNativeBroker)({ beforeRequest: async metadata => {
      if (requestReserved || !descriptor || metadata.bindingSessionId !== sessionId || metadata.probeId !== call.id + '-1' ||
          Date.parse(descriptor.expiresAt) <= Date.now() || metadata.privateEvidenceConfirmed !== true ||
          metadata.nativeCallContextSha256 !== null && !/^[a-f0-9]{64}$/.test(metadata.nativeCallContextSha256 ?? '')) return false;
      // Recheck both publications after sign-in and debugger setup, immediately
      // before granting the only native transport reservation.
      await verify(); requestReserved = true; reservedAt = Date.now();
      report.requestEvidence = { probeId: metadata.probeId, nativeCallContextSha256: metadata.nativeCallContextSha256,
        privateEvidenceConfirmed: true, requestOwnershipProved: false };
      report.state = 'request-reserved'; save(); return true;
    } });
    await broker.prepare({ runtime, prepared: prepared.emission, binding, calls: [call], operationId, sessionId });
    // Read-only Timer state baseline before the app-user lease starts; never blocks the run.
    if (instance) {
      try { report.instanceBaseline = await instance.baseline(); } catch { report.instanceBaseline = { available: false, reason: 'portal_baseline_failed' }; }
    }
    report.state = 'sign-in'; save();
    const entered = await (services.prepareUser ?? prepareDebugAppUser)({ ...binding, lane: 'odc', seconds: 600 }, { sessionId });
    if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; return report; }
    descriptor = entered.descriptor;
    if (!sameAppUserTarget(descriptor?.binding, appUserBinding({ ...binding, lane: 'odc' }, sessionId))) fail('app_user_scope_mismatch');
    const authentication = await broker.authenticate(descriptor);
    if (authentication?.authenticated !== true || authentication.identityMatches !== true) fail('emitter_identity_unproved');
    report.launchAuthentication = { ...authentication, contextMode: 'app-user', backgroundIdentityProved: false, backgroundRolesProved: false };
    if (trace.mode !== 'none') {
      let started;
      try { started = await debug({ op: 'watch', lane: 'odc', tenant: binding.tenant, module: binding.module,
        moduleKey: binding.moduleKey, runtimeUrl: binding.runtimeUrl, nodeKeys: trace.nodeKeys,
        seconds: Math.min(600, call.timeoutSeconds + trace.observationSeconds + 30), pauseSeconds: 5, autoContinue: true, paths: [],
        trace: { mode: 'step', steps: trace.steps, depth: trace.depth, fullValues: trace.fullValues, scopes: trace.scopes,
          focusFunctionKey: trace.functionKey, requireFunctionKey: trace.functionKey } }, { backgroundWatch: true, contextMode: 'native-background' }); }
      catch { uncertain = true; fail('trace_start_uncertain'); }
      traceSession = started?.sessionId;
      report.serverTrace = { sessionId: traceSession, state: started?.state, contextMode: 'native-background', requestOwnershipProved: false };
      if (!started?.ok || started.state !== 'connected' || !traceSession) { uncertain ||= !!traceSession; fail('trace_not_connected'); }
      if (services.prepareServerInspection) {
        inspectionDeadline = Math.min(Date.parse(started.expiresAt), Date.parse(descriptor.expiresAt));
        if (started.inspectionMode !== 'interactive' || started.autoContinue !== false || !Number.isFinite(inspectionDeadline) ||
            inspectionDeadline <= Date.now() || inspectionDeadline > Date.now() + 600000 || typeof broker.configureServerInspection !== 'function')
          fail('interactive_deadline_invalid');
        const expiresAt = new Date(inspectionDeadline).toISOString();
        const configured = await broker.configureServerInspection({ expiresAt });
        if (configured?.configured !== true || configured.expiresAt !== expiresAt) fail('interactive_deadline_invalid');
        Object.assign(report.serverTrace, { inspectionMode: 'interactive', requestDeadline: expiresAt });
      }
    }
    await services.beforeServerInvocation?.();
    if (services.prepareServerInspection && Date.now() >= inspectionDeadline) fail('interactive_deadline_expired');
    report.state = 'emitting'; save();
    const result = await broker.invoke(call); report.results.push(result);
    if (typeof result?.uncertain !== 'boolean') { uncertain = true; fail('emission_outcome_unqualified'); }
    uncertain ||= result.uncertain;
    requestAnswered = !result.uncertain;
    report.state = uncertain ? 'uncertain' : result.ok ? answeredState : 'emission-failed'; save();
    if (!uncertain && result.ok && requestReserved && traceSession) {
      report.state = 'observing-background'; save();
      await observe(traceSession, trace.functionKey, services.prepareServerInspection ? Math.max(0, (inspectionDeadline - Date.now()) / 1000) : trace.observationSeconds);
      report.state = answeredState;
    }
    return report;
  } catch (error) {
    uncertain ||= requestReserved && !requestAnswered;
    report.state = uncertain ? 'uncertain' : 'refused';
    report.error = error?.code === 'EEXIST' ? 'debug_odc_workflow_binding_blocked' :
      /^debug_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_workflow_failed';
    return report;
  } finally {
    if (traceSession) {
      try { const stopped = await debug({ op: 'stop', sessionId: traceSession }); report.serverTrace.stopped = stopped?.ok === true && stopped.state === 'stopped'; }
      catch { report.serverTrace.stopped = false; }
      uncertain ||= !report.serverTrace.stopped;
      try {
        const lines = traceRead(traceSession);
        report.backgroundTrace = observeOdcWorkflow(lines, trace.functionKey);
        if (instance && report.backgroundTrace.fingerprints.length === 1) report.instanceRequestIdShape = requestIdShapeOf(lines, report.backgroundTrace.fingerprints[0]);
      } catch { report.traceReadFailed = true; }
      // Values coverage per scope root, from native reads only; never forced (Timers.* stay native-unavailable).
      report.valuesCoverage = await odcValuesCoverage(services.prepareServerInspection ? services.scopeEvidence : null, trace.scopes?.[trace.functionKey], trace.omittedScopeRoots);
      report.valuesComplete = report.valuesCoverage.valuesComplete === true;
      report.background = { kind: prepared.adapter.kind, launcherContext: 'app-user', activityContext: 'native-background', valuesComplete: report.valuesComplete };
      if (report.results.at(-1)) report.results.at(-1).valuesCoverage = report.valuesCoverage;
    }
    if (broker) {
      try {
        report.cleanup = await broker.dispose();
        const cleanup = report.cleanup, transport = cleanup?.receipt?.transport;
        uncertain ||= cleanup?.completed !== true || transport?.uncertain === true || transport?.longPollingCleanupUncertain === true ||
          cleanup?.receipt?.authenticationSyncUncertain === true ||
          requestReserved && !Number.isSafeInteger(transport?.executeRequestSubmissions) ||
          transport?.executeRequestSubmissions < 0 || transport?.executeRequestSubmissions > (requestReserved ? 1 : 0);
        report.triggerAnswered = requestReserved && requestAnswered && report.results[0]?.ok === true && transport?.executeRequestSubmissions === 1;
        if (workflow) report.eventEmissionAnswered = report.triggerAnswered;
        else { report.wakeRequestAnswered = report.triggerAnswered; report.scheduled = report.triggerAnswered; }
      } catch { report.cleanup = { completed: false }; uncertain = true; }
    }
    if (descriptor) {
      try { report.credentialsReleased = (await (services.releaseUser ?? releaseDebugAppUser)(descriptor))?.ok === true; }
      catch { report.credentialsReleased = false; }
      uncertain ||= !report.credentialsReleased;
    }
    if (instance) {
      // After the answered wake, ThreadEnd, debugger stop and app-user release: read-only, never re-wakes.
      const thread = report.backgroundTrace;
      if (report.triggerAnswered === true && !uncertain && thread) {
        const deadlineAt = Date.now() + INSTANCE_SECONDS * 1000;
        report.instanceWindow = { since: new Date(reservedAt - 5000).toISOString(), until: new Date(deadlineAt).toISOString() };
        report.instanceIdentity = instance.identity ?? null;
        let found;
        try { found = await instance.observe({ baseline: report.instanceBaseline?.available === true ? report.instanceBaseline : null, threadOutcome: thread,
          requestIdShape: report.instanceRequestIdShape ?? null, window: report.instanceWindow, deadlineAt }); }
        catch { found = { state: 'unavailable', reason: 'portal_read_failed', instanceCorrelationProved: false, executionCompleted: false }; }
        report.instanceCorrelation = bindOdcTimerInstance(found, thread);
      } else report.instanceCorrelation = { state: 'not-observed', reason: report.triggerAnswered === true ? 'wake_uncertain_or_untraced' : 'wake_not_answered',
        instanceCorrelationProved: false, executionCompleted: false, wakeOwnershipProved: false };
      const found = report.instanceCorrelation;
      Object.assign(report, { instanceCorrelationProved: found.instanceCorrelationProved === true, executionCompleted: found.executionCompleted === true,
        wakeOwnershipProved: found.wakeOwnershipProved === true, outcome: found.outcome ?? 'unproved' });
      try { report.portalCredentialsReleased = (await instance.release?.())?.released !== false; } catch { report.portalCredentialsReleased = false; }
      uncertain ||= !report.portalCredentialsReleased;
      if (uncertain) report.executionCompleted = false;
    }
    report.finishedAt = new Date().toISOString(); report.uncertain = uncertain;
    report.ok = report.state === answeredState && report.triggerAnswered === true && !uncertain &&
      (trace.mode === 'none' || report.backgroundTrace?.requestBound === true);
    // Only a ThreadEnd bound to the target stops' native request fingerprint attests the background trace.
    if (!report.ok && !report.error && !uncertain && report.triggerAnswered === true && trace.mode !== 'none')
      report.error = 'debug_odc_workflow_request_bound_thread_end_missing';
    if (uncertain) report.state = 'uncertain';
    if (ownsLock) {
      report.lockRetained = uncertain;
      if (!uncertain) { try { fs.unlinkSync(lock); } catch { report.lockRetained = true; report.ok = false; } }
      save();
    }
  }
}

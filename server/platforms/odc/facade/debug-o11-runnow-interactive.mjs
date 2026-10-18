// Interactive inspection of an O11 Timer that has no REST/SOAP caller, triggered once
// by the Service Center Run Now adapter (run.trigger 'service-center-run-now', no
// launch). Scope binding precedes the submission, the debugger keeps a fixed native
// deadline without autoContinue, and an accepted-unverified submission stays
// uncertain with the runner lock retained. Run Now is never resent or replayed.
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { blockedBinding } from './debug-o11-native-run.mjs';
import { observeNativeBackground } from './debug-native-background.mjs';
import { backgroundThreadOutcome, backgroundValuesCoverage } from './debug-background-correlation.mjs';

export const RUN_NOW_TRIGGER = 'service-center-run-now';
const fail = code => { throw new Error('debug_native_background_' + code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const TIMER_LOG_SECONDS = 90, MAX_LEASE_MS = 600000;
// Never Run Now targets, matched by module key on any host and refused even without a registry file:
// SSAMDebugBoundaryCore20261009 (historical accepted-unverified Timer) and SSAMDebuggerProbe.
const NEVER = Object.freeze(['pVAfAKUEu0qw8Yxu+bBfBw', 'bf7WCuRy7keTqvquautTGg']);
// Also exported for the runner, to refuse before adapter.prepare reads the Service Center form.
export const runNowBindingRefused = (root, host, moduleKey) => NEVER.includes(moduleKey) || !!blockedBinding(root, host, moduleKey);
const noIdentity = { applicationUserContext: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false, requestOwnershipProved: false };
const emptyInputs = input => Object.keys(input.inputs ?? {}).length === 0 && input.scenarios === undefined && input.context === undefined;

// Server-session start admission for the Run Now variant (debug-server-session.mjs wiring).
export function runNowStartAdmission(run) {
  const refuse = message => ({ ok: false, code: 'debug_server_session_run_not_admitted', message });
  if (!run || run.op !== 'run' || run.lane !== 'o11' || run.execution && run.execution !== 'native-entry' || run.trace !== 'full')
    return refuse('O11 Run Now inspection requires op run, lane o11, native-entry and trace full');
  if (run.trigger !== RUN_NOW_TRIGGER || run.contextMode !== 'native-background')
    return refuse('Run Now requires trigger service-center-run-now with contextMode native-background');
  if (run.launch !== undefined || !emptyInputs(run)) return refuse('Run Now takes no launch, inputs, scenarios or context');
  if (!wordsGiven(run.words)) return refuse('Run Now requires authorization words'); // CX15 r7: one predicate
  return { ok: true, adapters: ['native-background-run-now'] };
}

export async function runO11TimerRunNowInteractive(args) {
  const { input, mode, target, owner, plan, traceAction, scopes = {}, omittedScopeRoots = 0, root, directory, operationId,
    report, save, adapter, debug, endpointPublicationCheck, prepareServerInspection, beforeServerInvocation,
    traceRead, observeBackground, compactServerMap, timerInstance, scopeEvidence } = args;
  if (input?.trigger !== RUN_NOW_TRIGGER || input.contextMode !== 'native-background' || input.launch !== undefined || !emptyInputs(input))
    fail('run_now_contract_invalid');
  const host = target.host, moduleKey = owner.target.moduleKey;
  // Refused before scope preparation, debugger start or any Service Center contact.
  if (runNowBindingRefused(root, host, moduleKey)) fail('binding_blocked');
  if (typeof prepareServerInspection !== 'function' || mode !== 'full') fail('run_now_interactive_inspection_required');
  if (!plan?.executable || plan.trigger !== 'o11-service-center-timer-run' || plan.nativeAuthenticationQualified !== true ||
      plan.binding?.moduleKey !== moduleKey || plan.binding.sourceSha256 !== owner.snapshot.sha256) fail('entry_unprepared');
  if (!/^[A-Za-z0-9_+]{22}$/.test(traceAction?.startNodeKey ?? '')) fail('target_start_node_unread');
  await prepareServerInspection({ lane: 'o11', moduleKey, source: owner.snapshot, functionKey: traceAction.key });
  report.background = { ...plan, trigger: RUN_NOW_TRIGGER, nativeTrigger: plan.trigger, valuesComplete: false, executionCompleted: false, ...noIdentity };
  report.tracePlan = { mode, contextMode: 'native-background', trigger: RUN_NOW_TRIGGER, functionKey: traceAction.key, startNodeKey: traceAction.startNodeKey,
    scopes, omittedScopeRoots, inspectionMode: 'interactive', autoContinue: false, valuesComplete: false, executionCompleted: false, ...noIdentity };
  report.needs = { loginWindow: false, contextMode: 'native-background', trigger: RUN_NOW_TRIGGER, words: true };
  if (input.op === 'prepare') { report.state = 'prepared'; return { uncertain: false }; }
  if (input.op !== 'run' || !wordsGiven(input.words)) fail('explicit_background_authorization_required');
  // Persist the approval before the debugger start and the single Run Now.
  fs.writeFileSync(path.join(directory, 'run-now-authorization.json'), JSON.stringify({ operationId, contextMode: 'native-background',
    trigger: RUN_NOW_TRIGGER, wordsSha256: sha(input.words), plan: report.tracePlan }, null, 2), { flag: 'wx' }); // CX15 r5 (N-3): never the words
  report.background.authorizationWordsSha256 = sha(input.words);
  let session, uncertain = false, baseline = null, stopping = null;
  const outcome = { uncertain: false };
  // Stopped once: before the read-only Service Center correlation (whose poll may outlive the native lease), or in finally.
  const stopDebugger = () => stopping ??= (async () => {
    let stopped; try { stopped = await debug({ op: 'stop', sessionId: session }); } catch { stopped = null; }
    report.serverTrace.stopped = stopped?.ok === true && stopped.state === 'stopped'; uncertain ||= !report.serverTrace.stopped;
  })();
  try {
    await endpointPublicationCheck(owner, path.join(directory, 'publication-before-run-now'));
    report.state = 'starting-background-watch'; save();
    let started;
    try { started = await debug({ op: 'watch', lane: 'o11', tenant: host, module: owner.target.module, moduleKey, runtimeUrl: owner.target.runtimeUrl,
      o11Auth: { applicationKey: owner.target.applicationKey, publishedVersionId: owner.versionId, publishedProof: owner.inventoryProof },
      nodeKeys: [traceAction.startNodeKey], seconds: MAX_LEASE_MS / 1000, pauseSeconds: 5, autoContinue: false, paths: [] },
    { backgroundWatch: true, contextMode: 'native-background' }); }
    catch { uncertain = true; fail('watch_start_uncertain'); }
    session = started?.sessionId;
    report.serverTrace = { sessionId: session ?? null, state: started?.state ?? null, contextMode: 'native-background', requestOwnershipProved: false };
    if (!started?.ok || started.state !== 'connected') { uncertain = !!session; fail('watch_not_connected'); }
    const deadline = Date.parse(started.expiresAt);
    if (started.inspectionMode !== 'interactive' || started.autoContinue !== false || !Number.isFinite(deadline) ||
        deadline <= Date.now() || deadline > Date.now() + MAX_LEASE_MS) fail('interactive_deadline_invalid');
    Object.assign(report.serverTrace, { inspectionMode: 'interactive', requestDeadline: started.expiresAt });
    if (timerInstance) {
      try { baseline = await timerInstance.baseline(); } catch { baseline = null; }
      if (baseline?.available !== true) fail('timer_instance_baseline_unavailable');
    }
    await endpointPublicationCheck(owner, path.join(directory, 'publication-before-run-now-send'));
    // No hold arguments: the Run Now POST returns at once and the Timer runs on the scheduler thread, so
    // the O11 gateway-bound request hold (50 s on cloud hosts) does not apply. debugger_required still does.
    await beforeServerInvocation?.();
    report.state = 'scheduling'; save();
    let submitted;
    // The adapter journals authorization + sending before its POST and owns replay prevention.
    try { submitted = await adapter.run(plan, { root, operationId, context: 'native-background', authorizationWords: input.words, inputs: {} }); }
    catch { uncertain = true; fail('trigger_outcome_uncertain'); }
    uncertain = submitted?.outcome === 'uncertain' || submitted?.scheduled !== true && submitted?.accepted !== false;
    const result = { name: 'service-center-run-now', ok: submitted?.scheduled === true && !uncertain, uncertain,
      requests: { submitted: 1, answered: submitted?.scheduled === true ? 1 : 0 }, executionCompleted: false, instanceCorrelationProved: false, ...noIdentity };
    report.results.push(result);
    report.background.result = submitted;
    report.state = uncertain ? 'uncertain' : submitted.scheduled ? 'observing-background' : 'failed'; save();
    if (submitted.scheduled || uncertain) {
      await observeBackground(session, traceAction.key, Math.max(0, (deadline - Date.now()) / 1000));
      const lines = traceRead(session), threadOutcome = backgroundThreadOutcome(lines, traceAction.key);
      const visits = compactServerMap(lines.filter(row => row.functionKey === traceAction.key && row.kind !== 'thread-end'));
      report.backgroundTrace = { functionKey: traceAction.key, ...threadOutcome, visits, ...noIdentity };
      Object.assign(result, { traceVerified: threadOutcome.traceVerified, requestBound: threadOutcome.requestBound, serverMap: visits });
      if (!threadOutcome.traceVerified) { result.ok = false; result.error = 'debug_native_background_timer_interactive_trace_incomplete'; }
      result.valuesCoverage = await coverage(scopeEvidence, scopes[traceAction.key] ?? [], omittedScopeRoots);
      result.valuesComplete = report.background.valuesComplete = result.valuesCoverage.valuesComplete === true;
      await stopDebugger(); save();
      report.instanceCorrelation = await correlate(timerInstance, baseline, threadOutcome);
      const observed = observeNativeBackground(plan, submitted.receipt, { entryKey: plan.entryKey, moduleKey, sourceSha256: owner.snapshot.sha256,
        threadOutcome, instance: report.instanceCorrelation });
      report.background.result = { ...submitted, ...observed };
      Object.assign(result, { instanceCorrelationProved: observed.instanceCorrelationProved, executionCompleted: observed.executionCompleted, outcome: observed.outcome });
    }
    report.executionCompleted = !uncertain && result.executionCompleted === true;
    report.state = uncertain ? 'uncertain' : submitted.scheduled ? 'answered' : 'failed';
    return outcome;
  } finally {
    if (session) await stopDebugger();
    report.uncertain = outcome.uncertain = uncertain;
    if (uncertain) { report.state = 'uncertain'; report.executionCompleted = false; }
    // The outer runner owns the binding lock; report.uncertain keeps it.
    save();
  }
}

async function coverage(scopeEvidence, roots, omittedRoots) {
  if (!scopeEvidence) return { valuesComplete: false, reason: 'native_scope_reads_unavailable' };
  try { return backgroundValuesCoverage({ modelRoots: roots, omittedRoots, stops: await scopeEvidence() }); }
  catch { return { valuesComplete: false, reason: 'native_scope_reads_unavailable' }; }
}
async function correlate(timerInstance, baseline, threadOutcome) {
  if (!timerInstance || !baseline) return { state: 'unavailable', reason: 'service_center_observer_unwired', instanceCorrelationProved: false, executionCompleted: false };
  try { return await timerInstance.observe({ baseline, threadOutcome, deadlineAt: Date.now() + TIMER_LOG_SECONDS * 1000 }); }
  catch { return { state: 'unproved', reason: 'service_center_read_failed', instanceCorrelationProved: false, executionCompleted: false }; }
}

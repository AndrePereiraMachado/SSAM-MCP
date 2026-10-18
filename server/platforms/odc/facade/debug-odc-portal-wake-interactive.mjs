// Interactive inspection of an ODC Timer woken through the original Portal action (no app caller).
// Order: bind the runner-derived scope (prepareServerInspection) before any request, then the
// debugger with a fixed deadline, then the single reserved Portal POST (timer-background keeps its
// one-send marker and lock). A refusal before the POST sends nothing; an uncertain POST is never re-sent.
import { wordsGiven } from './destructive-operations.mjs';
const fail = code => { throw new Error('debug_odc_timer_' + code); };
export const PORTAL_WAKE_TRIGGER = 'portal-wake';
const MAX_MS = 600000;

// ssam_debug_server start admission for run.trigger:'portal-wake' (wired by the server session).
export function portalWakeStartAdmission(run) {
  const refuse = message => ({ ok: false, message });
  if (run?.trigger !== PORTAL_WAKE_TRIGGER) return refuse('portal-wake requires run.trigger:"portal-wake"');
  if ((run.lane ?? 'odc') !== 'odc' || run.op !== 'run' || run.execution && run.execution !== 'native-entry') return refuse('portal-wake requires an explicit ODC native-entry run');
  if (run.contextMode !== 'native-background') return refuse('portal-wake requires contextMode native-background');
  if (!wordsGiven(run.words)) return refuse('portal-wake requires words with the user authorization'); // CX15 r7: one predicate
  if (['launch', 'inputs', 'scenarios', 'context', 'workflow'].some(k => run[k] !== undefined))
    return refuse('portal-wake has no app caller: omit launch, inputs, scenarios, context and workflow');
  if (run.trace !== undefined && run.trace !== 'full') return refuse('portal-wake interactive inspection requires trace full');
  return { ok: true };
}

// Runner-side checks, before any lock, Portal read or debugger start.
export function assertPortalWakeInput(input, interactive) {
  if (input.trigger !== undefined && input.trigger !== PORTAL_WAKE_TRIGGER) fail('trigger_unsupported');
  if (input.launch !== undefined || input.workflow !== undefined || interactive && input.inputs !== undefined) fail('portal_wake_has_no_launch');
  if (interactive && (input.trace ?? 'nodes') !== 'full') fail('interactive_timer_required');
}

export function bindPortalWakeScope(services, { binding, readers, trace }) {
  return services.prepareServerInspection({ lane: 'odc', moduleKey: binding.moduleKey, source: readers.sourceContract, functionKey: trace.functionKey });
}

// The configureServerInspection equivalent: the Portal POST has no native broker to configure, so the
// runner fixes the debugger's deadline here and enforces it immediately before the reserved POST.
export function portalWakeDeadline(started, now = Date.now()) {
  const deadline = Date.parse(started?.expiresAt);
  if (started?.inspectionMode !== 'interactive' || started.autoContinue !== false || !Number.isFinite(deadline) || deadline <= now || deadline > now + MAX_MS)
    fail('interactive_deadline_invalid');
  return { deadline, requestDeadline: new Date(deadline).toISOString() };
}
export function assertPortalWakeBeforePost(deadline, now = Date.now()) { if (!(now < deadline)) fail('interactive_deadline_expired'); }

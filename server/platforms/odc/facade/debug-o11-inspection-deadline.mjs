// A fixed native debugger lease. Reading/stepping cannot renew it.
import { o11HoldBudget } from './debug-o11-request-hold.mjs';
const fail = code => { throw new Error('debug_o11_native_' + code); };
export function o11InspectionDeadline(state, options) {
  const now = state.now(), deadline = Date.parse(options?.expiresAt), credential = Date.parse(state.descriptor?.expiresAt);
  if (state.serverInspectionDeadline !== undefined || state.inspection || state.armed || state.scenario ||
      state.report.authenticated !== true || state.report.requestSubmittedCount !== 0 || (state.report.scenarios?.length ?? 0) !== 0 ||
      !Number.isFinite(deadline) || !Number.isFinite(credential) || deadline <= now || deadline > credential || deadline > now + 600000)
    fail('inspection_deadline_invalid');
  state.serverInspectionDeadline = deadline;
  state.report.serverInspection = { expiresAt: new Date(deadline).toISOString(), fixed: true };
  return { configured: true, expiresAt: state.report.serverInspection.expiresAt };
}
// The fixed native lease end: inspection deadline bounded by the credential.
export function o11NativeDeadlineAt(state) {
  if (state.serverInspectionDeadline === undefined) return undefined;
  return Math.min(state.serverInspectionDeadline, Date.parse(state.descriptor?.expiresAt));
}
export function o11InvocationBudget(state) {
  if (state.serverInspectionDeadline === undefined) return state.input.timeoutSeconds * 1000;
  const remaining = o11NativeDeadlineAt(state) - state.now();
  if (!Number.isFinite(remaining) || remaining <= 0) fail('expired');
  return remaining;
}
// The public request hold is a part of this lease, never an extension of it.
export function o11RequestHoldBudget(state, { host, submittedAt = state.now(), overrideMs } = {}) {
  const nativeDeadlineAt = o11NativeDeadlineAt(state);
  if (nativeDeadlineAt === undefined) return null;
  if (!Number.isFinite(nativeDeadlineAt) || nativeDeadlineAt <= submittedAt) fail('expired');
  return o11HoldBudget({ host, nativeDeadlineAt, submittedAt, overrideMs });
}

// Data Actions do not use CallContext.timeout in the original O11 controller.
// Use the runtime's own application timeout API for the bounded inspection,
// then restore the host's previous value. No controller body is replaced.
export function o11NativeInspectionTimeout(state) {
  if (state.serverInspectionDeadline === undefined) return () => {};
  const info = state.os?.Internal?.ApplicationInfo;
  if (typeof info?.getApplicationDefaultTimeout !== 'function' || typeof info?.setApplicationDefaultTimeout !== 'function')
    fail('inspection_native_timeout_unavailable');
  const seconds = Math.floor(o11InvocationBudget(state) / 1000);
  if (seconds < 1) fail('expired');
  const previous = info.getApplicationDefaultTimeout();
  info.setApplicationDefaultTimeout(seconds);
  if (info.getApplicationDefaultTimeout() !== seconds) {
    info.setApplicationDefaultTimeout(previous);
    fail('inspection_native_timeout_unavailable');
  }
  state.report.serverInspection.nativeTimeoutConfigured = true;
  state.report.serverInspection.nativeTimeoutSeconds = seconds;
  return () => info.setApplicationDefaultTimeout(previous);
}

// Public hold budget for a paused O11 server request. Both lost O11 answers
// were cut near 60 s while the native timeout was 193/580 s: HTTP 504 at
// 60.279 s (item13 audit, pinned below) and no status at 60.107 s (item5 deep
// failure). The budget only tells the driver how long the paused request can
// still be held; it never extends a native limit, continues or resends.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const fail = code => { throw new Error('debug_o11_request_hold_' + code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const o11GatewayEvidence = Object.freeze({ path: '.local/debugger/item13-o11-site-live/live/audit.json',
  sha256: '0b3c2878f44940bb0fec6de3f3a3f46603f820805cd17e2ec3d54a512cc7c8ef',
  httpStatus: 504, responseDurationMs: 60279, nativeTimeoutSeconds: 193 });
// 10 s below the earliest observed cut (60.107 s); configurable only downward.
export const o11GatewayBudgetMs = 50000;
export const o11RequestHoldLowMs = 8000;
const cloudHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+outsystemscloud\.com$/i;

// Verifies the pinned audit bytes; a changed audit refuses the pin.
export function verifyO11GatewayEvidence(root) {
  const bytes = fs.readFileSync(path.join(root, ...o11GatewayEvidence.path.split('/')));
  if (sha256(bytes) !== o11GatewayEvidence.sha256) fail('gateway_evidence_changed');
  const audit = JSON.parse(bytes.toString('utf8'));
  if (audit.httpStatus !== o11GatewayEvidence.httpStatus || audit.responseDurationMs !== o11GatewayEvidence.responseDurationMs ||
      audit.nativeTimeoutSeconds !== o11GatewayEvidence.nativeTimeoutSeconds || audit.requestSubmitted !== 1 || audit.requestAnswered !== 0 ||
      !(o11GatewayBudgetMs < audit.responseDurationMs && audit.responseDurationMs < audit.nativeTimeoutSeconds * 1000)) fail('gateway_evidence_invalid');
  return { ...o11GatewayEvidence };
}
export function o11GatewayBudget(host) {
  if (typeof host !== 'string' || !host) fail('host_invalid');
  return cloudHost.test(host) ? o11GatewayBudgetMs : null;
}
// min(native deadline, host gateway budget, downward-only override), measured
// from the scenario submission. Ties report the native deadline first.
export function o11HoldBudget({ host, nativeDeadlineAt, submittedAt, overrideMs } = {}) {
  if (!Number.isFinite(nativeDeadlineAt)) fail('native_deadline_required');
  if (!Number.isFinite(submittedAt)) fail('submission_invalid');
  const native = Math.floor(nativeDeadlineAt - submittedAt), gateway = o11GatewayBudget(host);
  if (native <= 0) fail('expired');
  if (overrideMs !== undefined && (!Number.isSafeInteger(overrideMs) || overrideMs < 1 || overrideMs > (gateway ?? native))) fail('override_invalid');
  const [source, budgetMs] = [['native-deadline', native], ['host-gateway', gateway], ['override', overrideMs]]
    .filter(([, ms]) => ms != null).reduce((a, b) => b[1] < a[1] ? b : a);
  return { budgetMs, source, submittedAt, deadlineAt: submittedAt + budgetMs };
}
export function requestHold(budget, now) {
  const elapsedMs = Math.floor(now - budget.submittedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) fail('clock_invalid');
  return { elapsedMs, budgetMs: budget.budgetMs, remainingMs: Math.max(0, budget.budgetMs - elapsedMs), source: budget.source };
}
// Control and lifecycle commands are always accepted: they end or move the
// hold. Every other command evaluates natively and is refused near the cut.
const control = new Set(['start', 'status', 'stop', 'pause', 'reconcile', 'continue', 'step-into', 'step-over', 'step-out']);
export function classifyInspectionOp(op, remainingMs) {
  if (typeof op !== 'string' || !op) fail('op_invalid');
  if (control.has(op) || remainingMs == null) return { allowed: true };
  if (!Number.isFinite(remainingMs) || remainingMs < 0) fail('remaining_invalid');
  return remainingMs < o11RequestHoldLowMs ? { allowed: false, error: 'debug_server_session_request_hold_budget_low', remainingMs } : { allowed: true };
}
// A non-JSON 504 is the gateway's limit: transport evidence, never an action
// answer. Any other status is left to the native envelope check (answer null).
export function classifyGatewayResponse(status, body) {
  if (!Number.isInteger(status) || status < 100 || status > 599) fail('status_invalid');
  const text = body == null ? '' : typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : fail('body_invalid');
  let json = false;
  try { const value = JSON.parse(text); json = value !== null && typeof value === 'object'; } catch {}
  return status === 504 && !json ? { kind: 'gateway-limit', status, transportEvidence: true, answer: false }
    : { kind: 'http-response', status, transportEvidence: false, answer: null };
}
// Public receipts keep only transport metadata. A 504 whose native envelope
// was not accepted is gateway-limit evidence; bodyJson is null when unrecorded.
export function classifyEntryResponse(response) {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 ||
      typeof response.nativeEnvelopeAccepted !== 'boolean') return null;
  return response.status === 504 && !response.nativeEnvelopeAccepted && response.bodyJson !== true
    ? { kind: 'gateway-limit', status: 504, transportEvidence: true, answer: false, bodyJson: response.bodyJson === false ? false : null }
    : { kind: 'http-response', status: response.status, transportEvidence: false, answer: null };
}
// One open request at a time, from its earliest known submission (before
// invocation or the worker receipt) until it is closed by the runner.
export function createO11RequestHold({ host, overrideMs, now = Date.now } = {}) {
  let open = null;
  const snapshot = () => open ? requestHold(open.budget, now()) : null;
  return {
    submitted({ requestId, at = now(), nativeDeadlineAt }) {
      if (typeof requestId !== 'string' || !requestId) fail('request_invalid');
      if (open && open.requestId !== requestId) fail('previous_request_open');
      if (!open || at < open.budget.submittedAt)
        open = { requestId, budget: o11HoldBudget({ host, nativeDeadlineAt: open?.nativeDeadlineAt ?? nativeDeadlineAt, submittedAt: at, overrideMs }),
          nativeDeadlineAt: open?.nativeDeadlineAt ?? nativeDeadlineAt };
      return snapshot();
    },
    closed(requestId) { if (!open || open.requestId !== requestId) fail('request_not_open'); open = null; },
    snapshot,
    classify: op => classifyInspectionOp(op, snapshot()?.remainingMs ?? null),
  };
}

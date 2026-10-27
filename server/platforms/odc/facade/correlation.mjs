// F7 (traceability per session; owner audit of a Traditional migration, 22/10, items 22-25): ONE correlation id per session
// (the MCP session, or the CLI process) and ONE operation id per tool call, carried on every record SSAM writes for that call:
// the friction operation (the launcher, facade/friction-boundary.mjs), the facade task (ssam-task.mjs), the kernel delivery
// task and its receipt (kernel DeliveryTask, from the --correlation-id/--call-id the kernel runner adds), the journals, the
// access-restore journal (o11-access.mjs) and the friction report. The same operation id names a delivery in ssam_task,
// ssam_friction and ssam_evidence; the kernel task id is an alias of it in each.
//
// Where the ids come from (the one rule, here):
// - correlationId: a hosted transport's session (ctx.sessionId, the mcp-session-id) as the friction store keys it
//   (sessionKey: a UUID as it is, any other id a UUID-shaped digest); else SSAM_CORRELATION_ID, which the launcher sets for
//   its child (facade/launch.mjs: the id its friction observer records); else one random id per process.
// - operationId: derived from the session and the JSON-RPC id of the request (operationIdOf), so the launcher's observer
//   (facade/friction-boundary.mjs) and the server child name the call with the same id without changing one byte of the
//   request (an id is unique per session, MCP); a CLI child gets its observer's id (SSAM_OPERATION_ID); a call with no
//   request id gets a new id. A call nested in another (ssam_code writing through o11_deliver) keeps the outer call's ids.
// - callerKey (hosted, SSAM_EXPOSURE=licensee): a digest of the caller (the exposure meter's caller: SSAM_EXPOSURE_CALLER, or
//   the hosted session's token), never the caller id itself. A hosted reader never sees a record of another caller, with any
//   session option.
// The trace of the current call lives on its call-deadline entry (callScope below, the scope every served tool runs in), so a
// writer stamps it without any plumbing: traceFields().
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';

// The scope of the live calls of this process (call-deadline.mjs: one entry per served call, innermost first via parent).
export const callScope = new AsyncLocalStorage();

export const CORRELATION_ENV = 'SSAM_CORRELATION_ID';
export const OPERATION_ENV = 'SSAM_OPERATION_ID';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTraceId = value => typeof value === 'string' && UUID.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const uuidOf = d => `${d.slice(0, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}-${d.slice(16, 20)}-${d.slice(20, 32)}`;
// The friction store's sessionKey (facade/friction-store.mjs C33), the same bytes: a hosted session is the same id in both.
export function correlationKey(value) {
  if (isTraceId(value)) return value.toLowerCase();
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return null;
  return uuidOf(digest('session:' + value));
}
const PROCESS_CORRELATION = randomUUID();
export const processCorrelationId = (env = process.env) => isTraceId(env[CORRELATION_ENV]) ? env[CORRELATION_ENV].toLowerCase() : PROCESS_CORRELATION;
export const callerKey = caller => typeof caller === 'string' && caller.trim() ? 'c-' + digest('ssam-caller\0' + caller.trim()).slice(0, 24) : null;

// The operation id of one request of one session: the same on both sides of the transport (the observer that records the
// call and the server that runs it), from what both already have. null without a session or a request id.
export function operationIdOf(correlationId, requestId) {
  if (!isTraceId(correlationId) || requestId === undefined || requestId === null || !['string', 'number'].includes(typeof requestId)) return null;
  return uuidOf(digest('ssam-operation\0' + correlationId.toLowerCase() + '\0' + JSON.stringify(requestId)));
}
// The trace of one served call (ctx: the SDK's request context: sessionId of a hosted transport, mcpReq.id of the request).
export function traceOfRequest(ctx, { env = process.env, parent = null, caller = null } = {}) {
  if (parent?.correlationId) return parent;
  const correlationId = correlationKey(ctx?.sessionId) ?? processCorrelationId(env);
  const key = caller ? callerKey(typeof caller === 'function' ? caller() : caller) : null;
  return { correlationId, operationId: operationIdOf(correlationId, ctx?.mcpReq?.id) ?? randomUUID(), ...(key ? { callerKey: key } : {}) };
}
// The trace of the code running now: the innermost live call's, else the process's (a CLI child: its launcher's ids).
export function currentTrace(env = process.env) {
  for (let scope = callScope.getStore(), depth = 0; scope && depth < 64; scope = scope.parent, depth++) if (scope.trace?.correlationId) return scope.trace;
  return { correlationId: processCorrelationId(env), operationId: isTraceId(env[OPERATION_ENV]) ? env[OPERATION_ENV].toLowerCase() : null };
}
// The fields every record of the current call carries.
export function traceFields(trace = currentTrace()) {
  return { correlationId: trace.correlationId, ...(trace.operationId ? { operationId: trace.operationId } : {}), ...(trace.callerKey ? { callerKey: trace.callerKey } : {}) };
}
// A record of the current call: its fields, then the trace fields it does not name itself. A record with an operationId of its
// own (a destructive operation, a Service Center receipt) keeps it and names the call as callId.
export function stamped(value, trace = currentTrace()) {
  const out = { ...value };
  for (const [key, item] of Object.entries(traceFields(trace))) {
    if (!(key in out)) out[key] = item;
    else if (key === 'operationId' && out.operationId !== item && !('callId' in out)) out.callId = item;
  }
  return out;
}
// THE writer of a JSONL record line of the facade (journals, ledgers, receipts' lines): every line carries the trace. The
// generated sweep (tests/f7-traceability.test.mjs) refuses an append of a JSON line anywhere else in the facade.
export function appendJsonLine(file, value, trace = currentTrace()) {
  fs.appendFileSync(file, JSON.stringify(stamped(value, trace)) + '\n');
}

// The kernel arguments of the trace (Anvil.Cli DeliverCmd records them in task.json): added once, to `deliver` only.
export function withTraceArgs(args, trace = currentTrace()) {
  if (String(args?.[0]) !== 'deliver' || args.includes('--correlation-id') || !trace?.correlationId) return args;
  return [...args, '--correlation-id', trace.correlationId, ...(trace.operationId ? ['--call-id', trace.operationId] : [])];
}

// The `session` option of ssam_task, ssam_friction and ssam_evidence: absent = the caller's session; "all" = every session
// (of the caller, when hosted); a correlation id = that session. Anything else is refused by the tool, with the accepted forms.
export const SESSION_FORMS = 'omit for this session; "all" for every session; or a session correlationId';
export function sessionScope(option, trace = currentTrace()) {
  if (option === undefined || option === null || option === '') return { ok: true, mode: 'this', id: trace.correlationId, callerKey: trace.callerKey ?? null };
  if (option === 'all') return { ok: true, mode: 'all', id: null, callerKey: trace.callerKey ?? null };
  if (isTraceId(option)) return { ok: true, mode: 'id', id: option.toLowerCase(), callerKey: trace.callerKey ?? null };
  return { ok: false, code: 'SESSION_INVALID', error: 'session takes ' + SESSION_FORMS + ' (got ' + JSON.stringify(String(option).slice(0, 60)) + ')' };
}
// Whether a record belongs to the scope. Hosted: only the caller's own records, whatever the option (a record without a
// caller key was not written for this caller). Then the session: "all" keeps every one; otherwise only that correlation id
// (a record without one belongs to no session of today and is not returned by default).
export function inScope(record, scope) {
  if (scope.callerKey && record?.callerKey !== scope.callerKey) return false;
  if (scope.mode === 'all') return true;
  return typeof record?.correlationId === 'string' && record.correlationId.toLowerCase() === scope.id;
}
// What an answer says about its scope: the session read and how many records of other sessions it left out.
export const scopeNote = (scope, excluded) => ({ session: scope.mode === 'all' ? 'all' : scope.id, ...(excluded ? { otherSessions: excluded } : {}) });

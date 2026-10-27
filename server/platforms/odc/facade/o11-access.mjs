// o11_access over MCP: O11 end-user roles by versioned manifest (kernel Anvil.Core/Access). Since 2026-10-02 (user
// decision) apply EXECUTES: `access apply --execute` with the user's words runs one ordinary `deliver` per owner module,
// each bound to the manifest environment (--expected-environment in every prepared argv), on the Studio port of the
// connection record and in the lane delivery store (<lane.local>/work, the store o11_deliver uses, so its resume finds
// the task). It never publishes; account creation stays a CLI opt-in of plan (D-PLANO-9). plan is offline (no words);
// verify is phase 2. Policy stays in the kernel: AccessArguments parses strictly (the words are only ever the value of
// --words, always the last token, so words such as "--prepare-only" never change the mode), AccessCommand.Apply keeps
// the receipt <lane.local>/access/applies/<operationId>.json and the ledger, and never replays an uncertain delivery; a
// second call with the same operationId returns that receipt (it executes only a receipt still "prepared", when nothing
// was sent). This file builds the argv, keeps the words as a sha256 in <lane.local>/journal/o11_access.jsonl and reads
// the outcome: every delivery delivered -> "entregue"; verifier errors -> the errors; an unconfirmed write -> uncertain,
// never repeated, with the MCP call that reconciles it. No Python, no shell, no sleep: each call waits for its process.
import { appendJsonLine, stamped, traceFields } from './correlation.mjs';
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { createWorkerFirstRunner } from './anvil-worker.mjs';
import { assertSelectedO11 } from './studio-connect.mjs';
import { readConnection } from './studio-session.mjs';
import { trackTask, tasksDir } from './ssam-task.mjs';
import { clean, closeState, contractRefusal, deliveryOutcome, findKernelTask, validationMessages, WORDS_MARKER } from './o11-cycle.mjs';
import { RESULT, resultIs } from './result-values.mjs';
import { exposureOf } from './exposure.mjs';

const ACTIONS = ['plan', 'apply', 'verify', 'users'];
const ARGUMENTS = ['action', 'manifestPath', 'words', 'operationId'];
// users (A13): the read-only lookup of users and roles through the Studio session (CLI `users`, UserDirectory). No words.
const USERS_ARGUMENTS = ['action', 'host', 'email', 'username', 'role', 'max'];
const USER_FIELDS = ['id', 'username', 'name', 'email', 'isActive', 'roles'];
export const USERS_MAX = 100;
const OPERATION_ID = /^[0-9a-fA-F]{32}$/; // kernel Guid "N", the name of the receipt
const APPLY_SCHEMA = 'ssam-access-apply/1';
const DELIVERED = Object.freeze({ ok: true, result: RESULT.delivered });
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const reply = (value, text = JSON.stringify(value)) => ({ content: [{ type: 'text', text }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, ...(continuation ? { continuation } : {}) });
// Blank words, or a placeholder such as the continuation marker, are not the user's words.
// CX15 r7 (L-7): the one predicate of destructive-operations.mjs (imported above).

// ---- continuations: always an MCP call, never a command line. The marker stands for the user's words.
const planAgain = input => ({ tool: 'o11_access', arguments: { action: 'plan', manifestPath: input.manifestPath },
  why: 'Fix what the errors say, plan again (offline), then apply with the user\'s words.' });
const wordsAgain = input => ({ tool: 'o11_access', arguments: { action: 'apply', manifestPath: input.manifestPath, words: WORDS_MARKER },
  why: 'Ask the user to authorize applying this manifest and pass their exact words in words.' });
const newOperation = input => ({ tool: 'o11_access', arguments: { action: 'apply', manifestPath: input.manifestPath, words: WORDS_MARKER },
  why: 'A new operation (no operationId); words: the user\'s words in place of the marker.' });
const sameOperation = (input, operationId) => ({ tool: 'o11_access', arguments: { action: 'apply', manifestPath: input.manifestPath, operationId, words: WORDS_MARKER },
  why: 'Returns the receipt of this same operation: the kernel reconciles by operationId and never repeats a delivery. words: the same words of the user, in place of the marker.' });
const resumeWith = taskId => ({ tool: 'o11_deliver', arguments: { resume: taskId, authorize: WORDS_MARKER },
  why: 'Resumes the same kernel delivery task: it reconciles through merge_status and never repeats the merge. authorize: the user\'s words in place of the marker.' });
const closeHolder = taskId => ({ tool: 'o11_deliver', arguments: { close: { taskId, reason: 'superseded by a new o11_access apply' }, authorize: WORDS_MARKER },
  why: 'A refused delivery still holds the module: close it ("closed"), then plan and apply again with the user\'s words.' });
const connect = why => ({ tool: 'ssam_connect', arguments: { lane: 'o11' }, why });
const doctor = why => ({ tool: 'ssam_doctor', arguments: { lane: 'o11' }, why });

// Kernel texts written for a terminal ("Run --execute with --port ...", "pass --plan <plan.json>") lose those sentences;
// the continuation says what to call instead.
const CLI_HINT = /\b(?:run|pass|use)\b[^.;]*\s--[a-z]|--execute\b|--deliver-work\b|\bdotnet\b/i;
export function cleanKernel(text, limit = 400) {
  const kept = String(text ?? '').split(/(?<=[.;])\s+/).filter(s => !CLI_HINT.test(s)).join(' ')
    .replace(/\brun access plan first\b/gi, 'plan first (o11_access action plan)');
  return clean(kept, limit);
}

// ---- arguments
// The input the user and the model control, checked before anything runs (null when it is acceptable).
function inputRefusal(input) {
  const { action, manifestPath, words, operationId } = input;
  if (action === 'users') return usersRefusal(input);
  const unknown = Object.keys(input).filter(k => !ARGUMENTS.includes(k));
  if (unknown.length) return refusal('UNKNOWN_ARGUMENT', 'unknown argument(s) ' + unknown.join(', ') + '; o11_access ' + (ACTIONS.includes(action) ? action : 'plan/apply/verify') + ' takes only action, manifestPath, words and operationId (the mode is never an argument)',
    { tool: 'o11_access', arguments: { action: ACTIONS.includes(action) ? action : 'plan', ...(typeof manifestPath === 'string' ? { manifestPath } : {}) }, why: 'Call again without the unknown arguments.' });
  if (!ACTIONS.includes(action)) return refusal('BAD_ACTION', 'action must be plan, apply or verify (or users, the read-only lookup of users and roles)',
    { tool: 'o11_access', arguments: { action: 'plan', ...(typeof manifestPath === 'string' ? { manifestPath } : {}) }, why: 'plan first (offline), then apply with the user\'s words.' });
  if (action !== 'apply' && words !== undefined) return refusal('WORDS_NOT_TAKEN', action === 'plan' ? 'plan is offline and takes no authorization words' : 'verify takes no authorization words',
    { tool: 'o11_access', arguments: { action, manifestPath }, why: 'Only apply takes the user\'s words.' });
  if (action !== 'apply' && operationId !== undefined) return refusal('OPERATION_NOT_TAKEN', 'operationId goes only with apply',
    { tool: 'o11_access', arguments: { action, manifestPath }, why: 'Call again without operationId.' });
  if (action === 'verify') return null;
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) return refusal('MANIFEST_NOT_ABSOLUTE', 'manifestPath must be an absolute path',
    { tool: 'o11_access', arguments: { action }, why: 'Pass the absolute path of the access manifest JSON.' });
  if (action === 'plan') return null;
  if (!wordsGiven(words)) return refusal('WORDS_REQUIRED', "apply requires the user's own authorization words, verbatim", wordsAgain(input));
  if (operationId !== undefined && (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)))
    return refusal('OPERATION_ID_INVALID', 'operationId must be 32 hex characters, the operationId of an earlier apply', newOperation(input));
  return null;
}

// users: only its own fields; plain values (never a flag-like "--..."), max an integer (kept within 1..100 and reported).
function usersRefusal(input) {
  const unknown = Object.keys(input).filter(k => input[k] !== undefined && !USERS_ARGUMENTS.includes(k));
  const kept = Object.fromEntries(Object.entries(input).filter(([k]) => USERS_ARGUMENTS.includes(k)));
  if (unknown.length) return refusal('UNKNOWN_ARGUMENT', 'users takes only host, email, username, role and max (a read: no words, no manifest)' + (unknown.length ? '; not: ' + unknown.join(', ') : ''),
    { tool: 'o11_access', arguments: kept, why: 'Call again without the other arguments.' });
  for (const key of ['host', 'email', 'username', 'role'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().startsWith('--')))
      return refusal('BAD_VALUE', `${key}: a plain, nonempty text`, { tool: 'o11_access', arguments: Object.fromEntries(Object.entries(kept).filter(([k]) => k !== key)), why: 'Give the plain value.' });
  if (input.max !== undefined && !Number.isInteger(input.max))
    return refusal('BAD_VALUE', 'max: an integer from 1 to ' + USERS_MAX, { tool: 'o11_access', arguments: { ...kept, max: 20 }, why: 'Call again with an integer max.' });
  return null;
}

// The argv of `anvil users` (always a read-only lease): users --read-only [--host h] [--email e] [--username u] [--role r] --max n --work dir.
export function usersArguments(input = {}, { work } = {}) {
  const argv = ['users', '--read-only'];
  for (const key of ['host', 'email', 'username', 'role']) if (input[key] !== undefined) argv.push('--' + key, input[key].trim());
  argv.push('--max', String(Math.min(USERS_MAX, Math.max(1, input.max ?? 20))));
  if (work) argv.push('--work', work);
  return argv;
}

// The answer of users: the closed fields of each user only, whatever the CLI carried.
export function usersOutcome(run, input) {
  const envelope = run?.envelope;
  const data = envelope?.data;
  if (envelope?.ok === true && data && typeof data === 'object' && data.ok === true) {
    const users = (Array.isArray(data.users) ? data.users : []).map(u => Object.fromEntries(USER_FIELDS.filter(k => Object.hasOwn(u ?? {}, k))
      .map(k => [k, k === 'roles' ? (Array.isArray(u.roles) ? u.roles.filter(r => typeof r === 'string') : []) : u[k]])));
    const max = input.max ?? 20;
    return { ok: true, ...(data.host ? { host: data.host } : {}), users, total: Number.isInteger(data.total) ? data.total : users.length,
      ...(data.unknownRole ? { unknownRole: data.unknownRole, roles: data.roles ?? [] } : {}), ...(data.more ? { more: true } : {}),
      ...(data.linksTruncated ? { linksTruncated: true } : {}),
      ...(max !== Math.min(USERS_MAX, Math.max(1, max)) ? { inputAdjusted: [{ path: 'max', from: max, to: Math.min(USERS_MAX, Math.max(1, max)), rule: 'clamp' }] } : {}) };
  }
  const code = envelope?.code;
  const error = cleanKernel(envelope?.error ?? (run?.stderr ?? []).slice(-3).join(' '), 400) || 'users ended without an answer; nothing was read';
  if (code === 'STUDIO_BRIDGE_OUTDATED') return refusal(code, error, connect('Reconnects the Studio after it loads the current bridge (opened through the "Service Studio (SSAM)" shortcut).'));
  if (code === 'USERS_MODULE_NOT_FOUND' || code === 'USERS_SCHEMA_UNRESOLVED')
    return refusal(code, error, { tool: 'o11_environment', arguments: { action: 'inventory', filter: 'Users' }, why: 'Shows whether the Users module is published in this environment.' });
  return refusal(code ?? 'USERS_LOOKUP_FAILED', error, doctor('Reports the O11 lane, its Studio and its bridge.'));
}

async function users(input, ctx) {
  try { await ctx.assertSelected(); }
  catch (error) { return refusal('STUDIO_NOT_SELECTED', clean(error.message) || 'The selected Studio is not confirmed.', connect('Selects the Service Studio open on the O11 lane again.')); }
  const run = await ctx.runAnvil(usersArguments(input, { work: path.join(ctx.lane().local, 'users') }), { timeoutMs: ctx.planTimeoutMs, read: true });
  return usersOutcome(run, input);
}

// The argv of the O11 CLI (runAnvil args, the verb first). plan: `access plan --manifest <abs>`; verify: `access verify`;
// apply: `access apply --execute --manifest <abs> --operation-id <id> --port <p> --deliver-work <dir> --words <words>`,
// never --prepare-only, the words always last and only as the value of --words. ctx: {operationId, port, deliverWork}.
export function accessArguments(input = {}, ctx = {}) {
  const given = input ?? {};
  const refused = inputRefusal(given);
  if (refused) return refused;
  if (given.action === 'verify') return { ok: true, argv: ['access', 'verify'] };
  if (given.action === 'plan') return { ok: true, argv: ['access', 'plan', '--manifest', given.manifestPath] };
  const operationId = String(given.operationId ?? ctx.operationId ?? '');
  if (!OPERATION_ID.test(operationId)) return refusal('OPERATION_ID_INVALID', 'no operationId for this apply', newOperation(given));
  if (!Number.isInteger(ctx.port) || ctx.port < 1 || ctx.port > 65535) return refusal('PORT_UNKNOWN', 'no Studio bridge port for the O11 lane',
    connect('Selects the Service Studio open on the O11 lane; its bridge port is recorded.'));
  if (typeof ctx.deliverWork !== 'string' || !path.isAbsolute(ctx.deliverWork)) return refusal('DELIVER_WORK_UNKNOWN', 'no delivery store for the O11 lane',
    doctor('Reports the O11 lane folders.'));
  const id = operationId.toLowerCase();
  return { ok: true, operationId: id, argv: ['access', 'apply', '--execute', '--manifest', given.manifestPath, '--operation-id', id,
    '--port', String(ctx.port), '--deliver-work', ctx.deliverWork, '--words', given.words] };
}

// ---- the receipt
// The kernel's checkpoint (DurableJson envelope {format, sha256, payload}); null when absent, {unreadable} when corrupt.
export function readReceipt(store, operationId) {
  const file = path.join(store, 'applies', operationId + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (typeof document.payload !== 'string' || document.sha256 !== sha256(document.payload)) return { unreadable: true };
    const receipt = JSON.parse(document.payload);
    return receipt?.schema === APPLY_SCHEMA ? receipt : { unreadable: true };
  } catch { return { unreadable: true }; }
}

// One prepared delivery of the receipt: delivered | pending (never started, nothing sent) | uncertain | refused. A failed,
// uncertain or interrupted one is decided by its kernel task (task.json is registered before any bridge call), found by
// taskId or, when the delivery threw before answering, by its job since it started.
function verdict(d, work) {
  const base = { module: d?.module ?? null, taskId: d?.taskId ?? null };
  if (d?.status === 'delivered') return { ...base, state: 'delivered' };
  if (d?.status === 'prepared' || d?.status === 'not-started') return { ...base, state: 'pending' };
  if (d?.status === 'delivered-unattested') return { ...base, state: 'refused', code: 'ENVIRONMENT_NOT_ATTESTED',
    error: d.error ?? 'The delivery result does not attest the manifest environment.' };
  const since = Date.parse(d?.startedAtUtc ?? '') || 0;
  const task = d?.taskId ? findKernelTask(work, { taskId: d.taskId }) : d?.job ? findKernelTask(work, { job: d.job, since }) : null;
  // The receipt stands in for an unreadable task of a failed delivery; a delivery that never registered a task sent nothing.
  const state = task ?? (d?.status === 'failed' ? { taskId: d.taskId, delivered: d.delivered === true, writeState: d.writeState, error: d.error } : null);
  if (!state) return { ...base, state: 'refused', code: 'DELIVERY_FAILED', error: d?.error ?? 'The delivery stopped before it registered a task; nothing reached the Studio.' };
  const taskId = state.taskId ?? base.taskId;
  const outcome = deliveryOutcome(state);
  if (outcome === 'delivered') return { ...base, taskId, state: 'delivered' };
  if (outcome === 'uncertain') return { ...base, taskId, state: 'uncertain', writeState: state.writeState, error: state.error ?? d.error };
  // No recorded failure: the process ended mid-delivery; only resuming the same task settles it.
  if (state.error == null && d?.status !== 'failed') return { ...base, taskId, state: 'uncertain', writeState: state.writeState ?? null, error: 'The delivery stopped before it ended.' };
  return { ...base, taskId, state: 'refused', task: state, error: state.error ?? d?.error };
}

function uncertainAnswer(v, { input, operationId }) {
  return { ok: false, outcome: 'uncertain', code: 'ACCESS_UNCERTAIN', module: v.module ?? null, taskId: v.taskId ?? null,
    ...(v.writeState ? { writeState: v.writeState } : {}), operationId,
    error: (cleanKernel(v.error, 300) || 'The delivery outcome is not confirmed.') + ' Nothing was repeated.',
    continuation: v.taskId ? resumeWith(v.taskId) : sameOperation(input, operationId) };
}

// The verifier's errors of the delivery that stopped the operation, short; never the receipt.
function refusedAnswer(v, verdicts, { input, operationId, deliverWork }) {
  const task = v.task ?? {};
  const { messages, omitted } = v.task ? validationMessages(task) : { messages: [], omitted: 0 };
  const failures = (task.failures ?? []).map(f => ({ stage: f?.stage ?? null, error: cleanKernel(f?.error, 300) }));
  const invalid = (task.apply && (task.apply.isValid !== true || task.apply.accepted !== true)) || (task.validation?.newErrors ?? 0) > 0 || task.contract?.accepted === false;
  const merged = task.writeState === 'applied';
  let error = cleanKernel(merged ? task.failures?.[0]?.error ?? v.error : v.error ?? 'Not delivered', 300) || 'Not delivered';
  // A merge order delivery is two native merges: two undo steps (the bridge's receipt counts them).
  const undo = task.merge?.undoSteps === 2 ? 'Ctrl+Z twice undoes it' : 'Ctrl+Z undoes it';
  if (merged && !/merge kept for review/i.test(error)) error = cleanKernel('Merge kept for review in the Studio (' + undo + '); nothing was published. ' + error, 300);
  const deliveredModules = verdicts.filter(x => x.state === 'delivered').map(x => x.module).filter(Boolean);
  // The kernel names a task that still holds the module ("resume task <id> before starting another").
  const holder = /resume task ([0-9a-f]{32})/i.exec(String(v.error ?? ''))?.[1];
  const continuation = holder ? (closeState(findKernelTask(deliverWork, { taskId: holder })) === 'refused' ? closeHolder(holder) : resumeWith(holder)) : planAgain(input);
  // A refusal of the validation contract names the part that refused and carries every problem (o11-cycle contractRefusal, as
  // o11_deliver answers it): never only messages.
  const refused = !merged && !v.code && invalid && task.apply ? contractRefusal(task.apply, Array.isArray(task.problems) && task.problems.length ? task.problems : null) : null;
  if (refused?.summary && /^job rejected by validation contract; /.test(error)) error = cleanKernel('job rejected by validation contract (' + refused.summary + '); merge was not attempted', 400);
  return { ok: false, outcome: 'refused', code: v.code ?? (invalid ? 'VALIDATION_REFUSED' : 'DELIVERY_FAILED'), module: v.module, stage: task.stage ?? null,
    taskId: v.taskId ?? null, operationId, error, ...(refused ? refused.fields : {}), ...(messages.length ? { messages } : {}), ...(omitted ? { messagesOmitted: omitted } : {}),
    ...(failures.length ? { failures } : {}), ...(merged ? { merged: true } : {}), ...(deliveredModules.length ? { deliveredModules } : {}), continuation };
}

// The answer for one receipt (the kernel's, or the one on disk when the answer was lost). inFlight: the process may still
// be running (timed out, or the worker took the request and never answered).
export function receiptOutcome(receipt, info) {
  const { input, operationId, inFlight = false } = info;
  if (receipt?.unreadable) return uncertainAnswer({ error: 'The receipt of operation ' + operationId + ' is unreadable.' }, info);
  if (receipt.status === 'delivered' || receipt.status === 'unchanged') return DELIVERED;
  const verdicts = (Array.isArray(receipt.deliveries) ? receipt.deliveries : []).map(d => verdict(d, info.deliverWork));
  const unsure = verdicts.find(v => v.state === 'uncertain');
  if (unsure) return uncertainAnswer(unsure, info);
  const refused = verdicts.find(v => v.state === 'refused');
  if (refused) return refusedAnswer(refused, verdicts, info);
  if (verdicts.length && verdicts.every(v => v.state === 'delivered')) return DELIVERED;
  // Only deliveries that never started remain.
  if (inFlight) return uncertainAnswer({ error: 'The answer was lost while operation ' + operationId + ' was running.' }, info);
  const deliveredModules = verdicts.filter(v => v.state === 'delivered').map(v => v.module).filter(Boolean);
  if (receipt.status === 'prepared') return refusal('ACCESS_NOT_EXECUTED', 'Operation ' + operationId + ' was prepared and nothing was sent.',
    sameOperation(input, operationId), { operationId });
  return refusal('ACCESS_INCOMPLETE', 'Operation ' + operationId + ' stopped between deliveries; the pending ones were never sent.', planAgain(input),
    { operationId, ...(deliveredModules.length ? { deliveredModules } : {}) });
}

// A refusal of AccessCommand (Refused: {ok:false, stage, errors}): nothing was delivered.
const NEXT = { manifest: planAgain, plan: planAgain, words: wordsAgain, operation: newOperation, execute: newOperation };
function kernelRefusal(data, { input }) {
  const errors = (Array.isArray(data.errors) ? data.errors : []).map(e => cleanKernel(e, 300)).filter(Boolean);
  return { ok: false, code: 'ACCESS_REFUSED', stage: data.stage, error: errors[0] ?? 'access apply was refused',
    ...(errors.length > 1 ? { errors: errors.slice(0, 20) } : {}), continuation: (NEXT[data.stage] ?? planAgain)(input) };
}

// info: {input, operationId, store (<lane.local>/access), deliverWork}.
export function applyOutcome(run, info) {
  const data = run?.envelope?.data;
  if (data && typeof data === 'object' && data.schema === APPLY_SCHEMA) return receiptOutcome(data, info);
  if (data && typeof data === 'object' && data.ok === false && typeof data.stage === 'string') return kernelRefusal(data, info);
  // No receipt in the answer (an exception, a lost answer, a stopped process): the receipt on disk is the evidence.
  const inFlight = run?.timedOut === true || run?.unknown === true;
  const recorded = readReceipt(info.store, info.operationId);
  if (recorded) return receiptOutcome(recorded, { ...info, inFlight });
  const detail = run?.envelope?.error ?? [...(run?.stderr ?? []), ...(run?.stdout ?? [])].slice(-3).join(' ');
  // Another call holds this operation (DurableJson.Lease): it is running now; read it again, never start another.
  if (inFlight || /Operation is already running/i.test(detail)) return uncertainAnswer({ error: inFlight
    ? 'access apply did not answer in time; the outcome is unknown' : 'Operation ' + info.operationId + ' is already running' }, info);
  // The receipt is written before the first delivery: without one nothing was sent.
  return refusal('ACCESS_REFUSED', cleanKernel(detail) || 'access apply ended without an answer; nothing was delivered', planAgain(info.input), { stage: 'start' });
}

// ---- actions
async function plan(argv, input, ctx) {
  const run = await ctx.runAnvil(argv, { timeoutMs: ctx.planTimeoutMs, read: true });
  const data = run?.envelope?.data;
  if (data && typeof data === 'object' && !Array.isArray(data))
    return data.ok === false ? { ...data, code: 'ACCESS_PLAN_REFUSED', continuation: { tool: 'o11_access', arguments: { action: 'plan', manifestPath: input.manifestPath },
      why: 'Fix the manifest or its bases as the errors say, then plan again.' } } : data;
  const detail = run?.envelope?.error ?? [...(run?.stderr ?? []), ...(run?.stdout ?? [])].slice(-3).join(' ');
  return refusal('ACCESS_PLAN_FAILED', cleanKernel(detail) || 'access plan ended without an answer', doctor('Reports the O11 lane CLI.'));
}

async function verify(argv, ctx) {
  const run = await ctx.runAnvil(argv, { timeoutMs: ctx.planTimeoutMs, read: true });
  const data = run?.envelope?.data;
  if (data && typeof data === 'object' && data.implemented === false) return { ...data, ok: false, code: 'NOT_IMPLEMENTED' };
  if (data && typeof data === 'object') return data;
  return refusal('ACCESS_VERIFY_FAILED', cleanKernel(run?.envelope?.error ?? (run?.stderr ?? []).slice(-3).join(' ')) || 'access verify ended without an answer',
    doctor('Reports the O11 lane CLI.'));
}

async function apply(input, ctx) {
  try { await ctx.assertSelected(); }
  catch (error) {
    // Hosted without the customer's O11 connection (executor.mjs): its own code and continuation.
    if (error?.code === 'O11_NOT_CONNECTED') return refusal(error.code, clean(error.message), error.continuation);
    return refusal('STUDIO_NOT_SELECTED', clean(error.message) || 'The selected Studio is not confirmed.', connect('Selects the Service Studio open on the O11 lane again.'));
  }
  const lane = ctx.lane();
  const built = accessArguments(input, { operationId: input.operationId ?? ctx.newOperationId(), port: ctx.port(), deliverWork: lane.work });
  if (!built.ok) return built;
  const operationId = built.operationId;
  const summary = { action: 'apply', manifest: input.manifestPath, manifestFileSha256: sha256(fs.readFileSync(input.manifestPath)), operationId,
    port: Number(built.argv[built.argv.indexOf('--port') + 1]), ...(input.operationId ? { reconcile: true } : {}) };
  const journal = entry => ctx.journal(lane.local, { tool: 'o11_access', ...entry });
  return trackTask({ tool: 'o11_access', summary, dir: ctx.tasks, now: ctx.now }, async task => {
    // Only the sha256 of the words, as the kernel hashes them (trimmed): it matches wordsSha256 of the receipt.
    journal({ event: 'start', task: task.id, ...summary, wordsSha256: sha256(input.words.trim()) });
    const run = await ctx.runAnvil(built.argv, { timeoutMs: ctx.applyTimeoutMs });
    const value = applyOutcome(run, { input, operationId, store: path.join(lane.local, 'access'), deliverWork: lane.work });
    // A failed end line never changes what happened; the task file still records the outcome.
    try {
      journal({ event: 'end', task: task.id, operationId, outcome: value.ok ? 'delivered' : value.outcome ?? 'refused',
        ...(value.code ? { code: value.code } : {}), ...(value.stage ? { stage: value.stage } : {}), ...(value.taskId ? { kernelTaskId: value.taskId } : {}) });
    } catch { /* see above */ }
    return value;
  });
}

export async function access(input, ctx) {
  const refused = inputRefusal(input);
  if (refused) return refused;
  if (input.action === 'users') return users(input, ctx);
  if (input.action === 'verify') return verify(['access', 'verify'], ctx);
  if (!isFile(input.manifestPath)) return refusal('MANIFEST_NOT_FOUND', 'No manifest at ' + input.manifestPath,
    { tool: 'o11_access', arguments: { action: input.action }, why: 'Pass the absolute path of an existing access manifest JSON.' });
  if (input.action === 'plan') return plan(accessArguments(input).argv, input, ctx);
  return apply(input, ctx);
}

// ---- T12: the restore journal of a temporary access change (Traditional migration, calls 588-601: the Roles of 21 source
// screens were widened for a comparison and the restore was tracked by hand). A job of o11_deliver that says
// "temporary":{"restore":true} may hold only set Roles / set AnonymousAccess ops (the writes whose before-state the kernel
// captures, Verbs.Access.cs). Once it lands (delivered, or delivered and the publication failed), the kernel's
// accessChanges/accessRestore become one entry <lane.local>/access/restores[/<user>/<tenant>]/<kernel task>.json, "pending"
// until every one of its changes is back (change by change, by the final value each later delivery reports) or the user
// closes it with their words (o11_access close). Its restore call is a job of set ops with ifCurrent: each applies only
// while the screen still has the value this change wrote, so stacked changes are restored newest first and a restore never
// overwrites a later edit. ssam_doctor and every later o11_deliver answer list the pending ones, newest first.
// Hosted (SSAM_EXPOSURE=licensee): the journal is keyed by the caller (SSAM_EXPOSURE_CALLER, as the exposure meter reads
// it) and the tenant (the delivery's environment); without both, a temporary change is refused rather than shared.
const RESTORE_SCHEMA = 'ssam-access-restore/2';
const ACCESS_PROPS = new Set(['Roles', 'AnonymousAccess']);
const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v);
const sameValue = (a, b) => JSON.stringify(Array.isArray(a) ? [...a].map(String).sort() : a ?? null) === JSON.stringify(Array.isArray(b) ? [...b].map(String).sort() : b ?? null);
const sameHost = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const scopeKey = text => createHash('sha256').update('ssam-access-restore\0' + text).digest('hex').slice(0, 24);

// The scope of the journal: local (one folder per installation) or hosted (caller and tenant).
export function restoreScope(env = process.env) {
  let hosted = false;
  try { hosted = exposureOf(env) === 'licensee'; } catch { hosted = true; }
  const named = typeof env.SSAM_EXPOSURE_CALLER === 'string' ? env.SSAM_EXPOSURE_CALLER.trim() : '';
  return { hosted, caller: named && named !== 'local' ? named : null };
}
export const restoresDir = (local, scope = { hosted: false }, tenant = null) => scope.hosted
  ? path.join(local, 'access', 'restores', 'u-' + scopeKey(scope.caller ?? ''), ...(tenant ? ['t-' + scopeKey(String(tenant).trim().toLowerCase())] : []))
  : path.join(local, 'access', 'restores');

// The temporary field of a job: null when the job has none or it is well formed; else the refusal, before anything is sent.
export function temporaryRefusal(job, { scope = { hosted: false }, environment = null } = {}) {
  if (!isObject(job) || job.temporary === undefined) return null;
  const again = why => ({ tool: 'o11_deliver', arguments: {}, why });
  const t = job.temporary;
  // {close:"<id>"}: the user keeps the screens of a pending restore as they are; no ops, the user's words in authorize.
  if (isObject(t) && Object.keys(t).length === 1 && t.close !== undefined) {
    if (typeof t.close !== 'string' || !OPERATION_ID.test(t.close))
      return refusal('TEMPORARY_INVALID', 'temporary.close takes the id of a pending access restore (32 hex characters)', { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Lists the pending access restores with their ids.' });
    if (Array.isArray(job.ops) && job.ops.length)
      return refusal('TEMPORARY_INVALID', 'a close of an access restore sends no ops: it drops the restore and keeps the screens as they are', again('Send "temporary":{"close":"<id>"} with "ops":[] and the user\'s words in authorize.'));
    return null;
  }
  if (!isObject(t) || t.restore !== true || Object.keys(t).some(k => k !== 'restore'))
    return refusal('TEMPORARY_INVALID', 'temporary takes exactly {"restore":true} (a temporary access change, recorded to be restored) or {"close":"<id>"} (drop a pending restore)',
      again('Write "temporary":{"restore":true} in the job, or remove temporary for a lasting change.'));
  if (scope.hosted && (!scope.caller || !environment))
    return refusal('TEMPORARY_SCOPE_UNAVAILABLE', 'a temporary access change needs its restore journal kept for this user and tenant, and this hosted session names '
      + (!scope.caller ? 'no user' : 'no tenant (expectedEnvironment)') + '; nothing was sent',
      again('Pass expectedEnvironment (the tenant host) in the same o11_deliver call; without a user scope the change cannot be temporary here: make it a lasting change the user approves.'));
  const ops = Array.isArray(job.ops) ? job.ops : [];
  const other = ops.map((op, i) => ({ op, i })).filter(({ op }) => !(isObject(op) && op.op === 'set' && ACCESS_PROPS.has(op.prop) && typeof op.target === 'string'));
  if (!ops.length || other.length)
    return refusal('TEMPORARY_NOT_REVERSIBLE', (ops.length ? 'a temporary job holds only the access writes whose before-state SSAM records (set Roles, set AnonymousAccess on a screen); not: '
      + other.slice(0, 10).map(({ op, i }) => '/ops/' + i + ' (' + (isObject(op) ? (op.op ?? '?') + (op.prop ? ' ' + op.prop : '') : typeof op) + ')').join(', ')
      : 'a temporary job needs at least one access write (set Roles or set AnonymousAccess on a screen)'),
      again('Keep only the set Roles / set AnonymousAccess ops in the temporary job and send every other op in a job of its own.'),
      { ops: other.slice(0, 10).map(({ i }) => i) });
  return null;
}

function readRestore(file) {
  try { const entry = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); return entry?.schema === RESTORE_SCHEMA && Array.isArray(entry.changes) ? entry : null; } catch { return null; }
}
function writeRestore(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, entry.id + '.json');
  // One temporary name per writer: two processes never share a .tmp.
  const temp = file + '.' + process.pid + '.' + randomUUID().replace(/-/g, '') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(entry, null, 1)); fs.renameSync(temp, file);
  return file;
}
const closeCall = ({ module, id, environment }) => ({ tool: 'o11_deliver', arguments: { module, job: { temporary: { close: id }, ops: [] }, authorize: WORDS_MARKER, ...(environment ? { expectedEnvironment: environment } : {}) },
  why: 'Keeps the screens as they are now and drops this restore; nothing reaches the Studio. Only with the user\'s own words.' });
const restoreCall = ({ module, ops, environment }) => ({ tool: 'o11_deliver', arguments: { module, job: { ops }, authorize: WORDS_MARKER, ...(environment ? { expectedEnvironment: environment } : {}) },
  why: 'Puts the screens of this temporary access change back as they were before it (the exact Roles and AnonymousAccess SSAM recorded); each write applies only while the screen still has the value this change wrote. The user\'s words in authorize; confirm with the user first.' });

// The entries of one scope (hosted: every tenant of the caller), newest first.
function listRestores(local, scope) {
  const dirs = [];
  const root = restoresDir(local, scope);
  if (scope.hosted) { try { for (const d of fs.readdirSync(root)) if (d.startsWith('t-')) dirs.push(path.join(root, d)); } catch { /* none yet */ } }
  else dirs.push(root);
  return dirs.flatMap(dir => { try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => ({ dir, entry: readRestore(path.join(dir, n)) })); } catch { return []; } })
    .filter(x => x.entry).sort((a, b) => String(b.entry.createdAt).localeCompare(String(a.entry.createdAt)) || String(b.entry.id).localeCompare(String(a.entry.id)));
}

// After a temporary job lands: the journal entry from the kernel's apply receipt, keyed by the kernel task of the delivery.
// The answer carries accessRestore {id, state, screens, restore}; a delivery whose receipt holds no before-state says so
// (ACCESS_RESTORE_NOT_CAPTURED).
export function recordAccessRestore(local, { module, environment = null, taskId = null, apply, scope = { hosted: false }, now = () => new Date() }) {
  const changes = Array.isArray(apply?.accessChanges) ? apply.accessChanges.filter(isObject) : [];
  const ops = Array.isArray(apply?.accessRestore?.ops) ? apply.accessRestore.ops.filter(isObject) : [];
  const id = String(taskId ?? '').trim().toLowerCase();
  if (!changes.length || !ops.length || !OPERATION_ID.test(id))
    return { code: 'ACCESS_RESTORE_NOT_CAPTURED', state: 'not-captured',
      error: 'The temporary access change landed, but its receipt holds no before-state to restore from' + (changes.length ? '' : ' (no screen changed who may open it)') + '.',
      continuation: { tool: 'ssam_map', arguments: { lane: 'o11', target: module, view: 'digest' }, why: 'Every screen of the digest prints its access and roles: compare them with the state before the change.' } };
  // F7: keyed by the kernel task, the entry carries the session and the call of the temporary change (correlationId,
  // operationId: the same ids as its facade task, kernel task and friction operation).
  const entry = stamped({ schema: RESTORE_SCHEMA, id, module, environment, createdAt: now().toISOString(), state: 'pending',
    changes: changes.map(c => ({ ...c, restored: false })), restore: restoreCall({ module, ops, environment }) });
  writeRestore(restoresDir(local, scope, environment), entry);
  return { id, state: 'pending', screens: [...new Set(changes.map(c => c.screen))].length, restore: entry.restore };
}

// After any delivery that landed in a module: every change of a pending entry of that module and environment whose screen
// this delivery left at the recorded before-state is restored (change by change, so a restore split over several
// deliveries settles too); an entry with every change restored is "restored". Returns the ids restored now.
export function settleAccessRestores(local, { module, environment = null, apply, taskId = null, scope = { hosted: false }, now = () => new Date() }) {
  const done = Array.isArray(apply?.accessChanges) ? apply.accessChanges.filter(isObject) : [];
  if (!done.length || !module) return [];
  const settled = [];
  for (const { dir, entry } of listRestores(local, scope)) {
    if (entry.state !== 'pending' || String(entry.module ?? '').toLowerCase() !== String(module).toLowerCase()) continue;
    if (entry.environment && !sameHost(entry.environment, environment)) continue;
    let changed = false;
    const changes = entry.changes.map(c => {
      const last = done.filter(d => d.key === c.key && d.property === c.property).at(-1);
      if (!last) return c;
      const restored = sameValue(last.to, c.from);
      if (restored !== c.restored) changed = true;
      return { ...c, restored };
    });
    if (!changed) continue;
    const all = changes.every(c => c.restored);
    writeRestore(dir, { ...entry, changes, ...(all ? { state: 'restored', restoredAt: now().toISOString(), ...(taskId ? { restoredBy: taskId } : {}), restoredTrace: traceFields() } : {}) });
    if (all) settled.push(entry.id);
  }
  return settled;
}

// The pending restores of the scope, newest first (the order their restores apply in).
export function pendingAccessRestores(local, scope = { hosted: false }) {
  return listRestores(local, scope).map(x => x.entry).filter(e => e.state === 'pending').map(e => ({ id: e.id, module: e.module, ...(e.environment ? { environment: e.environment } : {}),
    createdAt: e.createdAt, screens: e.changes.filter(c => !c.restored).map(c => c.screen).filter((s, i, all) => all.indexOf(s) === i), restore: e.restore,
    close: closeCall({ module: e.module, id: e.id, environment: e.environment }) }));
}

// o11_deliver with "temporary":{"close":"<id>"}: closes that restore with the user's words (null for any other job).
export function temporaryClose(job, { local, words, scope = { hosted: false }, now = () => new Date() }) {
  if (!isObject(job?.temporary) || job.temporary.close === undefined || !local) return null;
  if (!wordsGiven(words)) return refusal('WORDS_REQUIRED', "closing an access restore keeps the screens as they are: it requires the user's own words, verbatim, in authorize",
    { tool: 'o11_deliver', arguments: { job, authorize: WORDS_MARKER }, why: 'Ask the user whether to keep the screens as they are, and pass their exact words.' });
  return closeAccessRestore(local, { id: job.temporary.close, wordsSha256: sha256(String(words).trim()), scope, now });
}

// The close of a pending restore (temporaryClose): the user keeps the screens as they are; the entry is closed, never restored.
export function closeAccessRestore(local, { id, wordsSha256, scope = { hosted: false }, now = () => new Date() }) {
  const found = listRestores(local, scope).find(x => x.entry.id === String(id).toLowerCase());
  if (!found) return refusal('RESTORE_NOT_FOUND', 'No access restore ' + id + ' is recorded for this lane' + (scope.hosted ? ', user and tenant' : ''),
    { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Lists the pending access restores with their ids.' });
  if (found.entry.state !== 'pending') return { ok: true, id: found.entry.id, state: found.entry.state };
  writeRestore(found.dir, { ...found.entry, state: 'closed', closedAt: now().toISOString(), closedWordsSha256: wordsSha256, closedTrace: traceFields() });
  return { ok: true, id: found.entry.id, state: 'closed', screens: found.entry.changes.filter(c => !c.restored).map(c => c.screen) };
}

// The o11_deliver hook (o11-cycle.mjs, after a merged delivery): records a temporary change that landed (delivered, or
// delivered and the publication failed), settles what this delivery put back, and names every restore still pending.
export function accessRestoreAfter(value, { local, module, job, kernelState, environment = null, scope = { hosted: false }, now }) {
  if (!value || typeof value !== 'object' || !local) return value;
  const apply = kernelState?.apply;
  const landed = resultIs(value.result, 'delivered', 'deliveredAndPublished');
  const where = kernelState?.environment ?? environment ?? null;
  let out = value;
  try {
    if (landed) settleAccessRestores(local, { module, environment: where, apply, taskId: kernelState?.taskId ?? null, scope, now });
    if (landed && isObject(job?.temporary))
      out = { ...out, accessRestore: recordAccessRestore(local, { module, environment: where, taskId: kernelState?.taskId ?? null, apply, scope, now }) };
    const pending = pendingAccessRestores(local, scope);
    if (pending.length) out = { ...out, pendingRestores: pending.map(p => ({ id: p.id, module: p.module, screens: p.screens.length, restore: p.restore, close: p.close })) };
  } catch {
    out = { ...out, accessRestore: { code: 'ACCESS_RESTORE_JOURNAL_FAILED', error: 'The restore journal could not be updated; the delivery itself stands.',
      continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Lists the access restores the journal holds.' } } };
  }
  return out;
}

function appendJournal(now) {
  return (local, entry) => {
    const dir = path.join(local, 'journal');
    fs.mkdirSync(dir, { recursive: true });
    appendJsonLine(path.join(dir, 'o11_access.jsonl'), { at: now().toISOString(), ...entry });
  };
}

const accessSchema = z.object({
  action: z.enum(ACTIONS).describe('plan (offline, no words) | apply (executes, with the user\'s words) | verify (phase 2, not implemented) | users (read-only lookup of users and roles)'),
  manifestPath: z.string().min(1).optional().describe('plan/apply: absolute path of the access manifest JSON (schema ssam-access/1).'),
  host: z.string().optional().describe('users only: the environment host among those the Studio is logged in to.'),
  email: z.string().optional().describe('users only: the user\'s e-mail (exact, case-insensitive).'),
  username: z.string().optional().describe('users only: the username (exact, case-insensitive).'),
  role: z.string().optional().describe('users only: a role name; answers the users that have it.'),
  max: z.number().int().optional().describe('users only: most users answered (default 20, up to 100).'),
  words: z.string().optional().describe('apply only: the user\'s own authorization words, verbatim; only their SHA-256 is recorded.'),
  operationId: z.string().regex(OPERATION_ID).optional()
    .describe('apply only, to reconcile: the operationId of an earlier apply (same manifest and words); its receipt comes back and no delivery is repeated'),
}).strict();

// deps: root, env, lane, now, runAnvil, assertSelected, newOperationId, tasksDir, journal, planTimeoutMs, applyTimeoutMs.
export function registerO11Access(server, deps = {}) {
  const root = deps.root ?? anvilRoot;
  const env = deps.env ?? process.env;
  const laneName = deps.lane ?? o11Lane.lane;
  const now = deps.now ?? (() => new Date());
  const lane = () => o11LaneOf(laneName, { root, env });
  const connection = () => { try { return readConnection(root, laneName); } catch { return null; } };
  const ctx = {
    now, lane,
    // The lane's resident worker when it can serve, else a cold process; ANVIL_WORKER=0 keeps it cold.
    runAnvil: deps.runAnvil ?? createWorkerFirstRunner({ root, env, o11: laneName }),
    assertSelected: deps.assertSelected ?? assertSelectedO11,
    // The bridge port of the selected Studio (connection record), else the lane table's.
    port: () => { const record = connection(); return Number.isInteger(record?.port) ? record.port : lane().bridge; },
    newOperationId: deps.newOperationId ?? (() => randomUUID().replace(/-/g, '')),
    tasks: deps.tasksDir ?? tasksDir(root),
    journal: deps.journal ?? appendJournal(now),
    planTimeoutMs: deps.planTimeoutMs ?? 900000, applyTimeoutMs: deps.applyTimeoutMs ?? 3600000,
  };
  server.registerTool('o11_access', {
    title: 'O11 end-user roles by versioned manifest',
    description: '[o11] plan (offline, no words): reads the roles of the current OMLs named in the manifest, validates it (own persistent '
      + 'roles only, never UserManager or Users roles, monotonic manifestVersion, demo derived from the owner module\'s '
      + 'DemoLoginUsernames/OpsDemoLoginUsernames) and proves one private job per owner module with check-job and apply. '
      + 'apply (the user\'s own words, verbatim; only their SHA-256 is kept) EXECUTES the successful plan: one delivery per owner module '
      + 'on the Service Studio selected on the O11 lane, each bound to the manifest environment (it stops before any merge on another '
      + 'environment); a receipt with hashes only. All delivered: the answer is only "delivered". Verifier errors come back and nothing more '
      + 'is delivered. outcome "uncertain" is never repeated: follow continuation. operationId (apply only) reconciles an earlier apply. '
      + 'Never publishes (the user publishes in Service Studio) and never creates accounts. verify: phase 2, not implemented. '
      + 'users {host?, email?, username?, role?, max?} (no words, read-only): users and their role names through the Studio\'s own login '
      + '(id, username, name, email, isActive, roles; never a password or hash): use it instead of asking the user for a user id.',
    inputSchema: accessSchema, annotations: mutating,
  }, async input => {
    try { const value = await access(input ?? {}, ctx); return value === DELIVERED ? reply(value, value.result) : reply(value); }
    catch (error) { return reply({ ok: false, error: clean(error.message) }); }
  });
}

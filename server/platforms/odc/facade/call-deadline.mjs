// One deadline for every externally served tool. Internal calls keep the same async scope.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalArguments } from './read-budget.mjs';
import { keepAnswer } from './answer-size.mjs';
import { mergeTask, readTask, findCallTask, ensureTaskIndexes, releaseKernelFacadeTasks, sanitizeAnswer, tasksDir, stateOf, kernelTaskAnswer, awaitsReplay, replayWindowOpen, kernelWorkFolders } from './ssam-task.mjs';
import { isMutation, declareToolClassification, classifyTool, phaseOfCall } from './tool-classification.mjs';
import { taskStepOfCall, tokensOfCall } from './destructive-operations.mjs';
import { WORDS_MARKER } from './next-steps.mjs';
import { RESULT, resultIs } from './result-values.mjs';

export const CALL_DEADLINE_MS = 25000;
export const callScope = new AsyncLocalStorage();
const liveTasks = new Map();
const liveKey = (dir, id) => dir.toLowerCase() + ':' + id.toLowerCase();
export const isLiveTask = (id, dir) => !!liveTasks.get(liveKey(dir, id));
// CT-2 (servidor/fase4-26): the identical-call index (by tool and argument hash) and the calls by id are the process's,
// per task folder, like liveTasks: every deadline on one folder (the MCP sessions of one customer hosted; the bootstrap
// deadline and the server's own locally) joins the same live call and replays the same undelivered final under the same
// 10-minute rule. A deadline on another folder (another customer) never sees them. The folder is compared exactly, only
// case-folded on Windows.
export const folderKey = dir => { const resolved = path.resolve(String(dir)); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const callsByKey = new Map(), callsById = new Map();
const scopedMap = (map, scope) => ({ get: key => map.get(scope + '|' + key), set: (key, value) => map.set(scope + '|' + key, value),
  delete: key => map.delete(scope + '|' + key), has: key => map.has(scope + '|' + key),
  values: () => [...map].filter(([key]) => key.startsWith(scope + '|')).map(([, value]) => value) });
// The live calls the current async scope runs inside, innermost first (callScope holds the entry of each call).
const runsInside = entry => { for (let scope = callScope.getStore(), depth = 0; scope && depth < 64; scope = scope.parent, depth++) if (scope === entry) return true; return false; };
// CT-1: a task whose handler a deadline of this process runs now, on that folder.
export const runsHere = (id, dir) => isLiveTask(String(id), dir);
// Owner decision (2026-10-18): deliveries and creations have no time limit. A handler that runs one marks every live call it
// runs inside (ssam.mjs, by tool-classification.mjs runsToEnd: the served call itself, and the call a nested delivery runs
// inside, as ssam_code write through the lane's delivery tool). At the deadline a marked call is KEPT instead of answered
// running (wait below): it detaches as before (its task on disk for ssam_task {id}, a cancellation of the client no longer
// stops the work, continueTask and stop work on it) while the original call, and an identical call that joined it, wait for
// the final answer. A call never marked keeps the deadline and its continueTask.
export function markRunsToEnd() {
  for (let scope = callScope.getStore(), depth = 0; scope && depth < 64; scope = scope.parent, depth++) scope.runsToEnd = true;
}
// The replay of an unconfirmed final answer is decided by the served handler on the call's resolved inputs (replay-store.mjs,
// ssam.mjs). Here, a run-to-end call carries its inputs (inputsOf: its print, or null when a file it reads cannot be read for
// sure): a live call is joined by the same inputs, also under other arguments (a default written or not); the same arguments
// while the first still runs with other content is one refusal (DELIVERY_STILL_RUNNING) that names the running task, how to
// wait for it and how to stop it; an undelivered final (CX12) is replayed only for the same inputs, never without them.
export function stopTask(id, { dir = tasksDir() } = {}) {
  const entry = liveTasks.get(liveKey(dir, id));
  if (!entry) return refusal(readTask(id, { dir }) ? 'TASK_NOT_RUNNING' : 'TASK_NOT_FOUND', 'No live task ' + id);
  if (!entry.isWrite) return refusal('TASK_STOP_NOT_WRITE', 'Stop applies to live writes.');
  entry.controller.abort(new Error('Explicit task stop'));
  try { mergeTask(dir, { id, stopRequestedAt: new Date().toISOString() }); } catch {}
  return reply({ ok: true, state: 'stop-requested', task: { id, tool: entry.tool } });
}
// Junction CX12 x CX15 (M6 adjustments 4 and 5): the live CX12 entry that runs a destructive execution, found by the previewId
// of its token(s) or by the operationId/previewId of the CX15 record; ssam_task {id:<operationId|previewId>, stop:true} aborts
// its handler (the signal the CX15 engines read before each send).
export function liveTaskOfOperation(ids, { dir = tasksDir() } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(id => String(id).toLowerCase()));
  for (const entry of liveTasks.values()) if (entry.dir.toLowerCase() === dir.toLowerCase() && (entry.previewIds ?? []).some(id => wanted.has(id))) return entry;
  return null;
}
export function stopOperation(ids, { dir = tasksDir() } = {}) {
  const entry = liveTaskOfOperation(ids, { dir });
  return entry ? stopTask(entry.id, { dir }) : null;
}
export function callDeadlineMs(env = process.env) {
  const raw = env.SSAM_CALL_DEADLINE_MS;
  if (raw == null || !/^\d+$/.test(String(raw))) return CALL_DEADLINE_MS;
  return Math.min(CALL_DEADLINE_MS, Math.max(1000, Number(raw)));
}
export const CONTINUE_TASK_SCHEMA = { type: 'string' };
export function continuationSchema(config) {
  const schema = config?.inputSchema;
  const standard = schema?.['~standard'];
  if (!standard?.jsonSchema?.input) return config;
  const input = options => { const json = standard.jsonSchema.input(options); return { ...json, properties: { ...json.properties, continueTask: CONTINUE_TASK_SCHEMA } }; };
  return { ...config, inputSchema: { '~standard': { ...standard, jsonSchema: { ...standard.jsonSchema, input }, validate: args => args && Object.hasOwn(args, 'continueTask') ? { value: args } : standard.validate(args) } } };
}
const valueOf = answer => { if (answer?.structuredContent !== undefined) return answer.structuredContent; try { return JSON.parse(answer?.content?.find(c => c.type === 'text')?.text); } catch { return answer; } };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const why = 'Cancelling the wait does not stop the work; use ssam_task {id,stop:true} or ssam_doctor {task:{id,stop:true}}. It goes on in the server; this call waits up to 25 s and returns the result as soon as it ends; never repeat the original call nor sleep';
const next = task => ({ tool: task.tool, arguments: { continueTask: task.id, ...(task.continuationLane ? { lane: task.continuationLane } : {}) }, why });
const refusal = (code, error, extra = {}) => reply({ ok: false, code, error, ...extra });
// fix/no-internals round 6 (D15): a refusal of a continuation that never reached the call or its task (an extra field,
// another tool, an unknown id) carries this mark, so the exposure gate (ssam.mjs exposeHandler) never takes it for the end of
// the call. The mark is a non-enumerable symbol: it never reaches the JSON of an answer.
export const CONTINUATION_REFUSED = Symbol.for('ssam.continuationRefused');
const notReached = answer => Object.defineProperty(answer, CONTINUATION_REFUSED, { value: true });
const completionState = result => { const value = valueOf(result); return value?.ok != null || value?.outcome === 'uncertain' ? stateOf(value) : result?.isError === true ? 'failed' : 'ok'; };
// The saved answer of a facade task (its hash checked), else its brief summary.
function savedOriginal(task) {
  const source = task.callResult ?? task.result;
  let original = source?.content ? valueOf(source) : source;
  if (task.answer?.file) { try { const body = fs.readFileSync(task.answer.file, 'utf8'); if (createHash('sha256').update(body).digest('hex') === task.answer.sha256) original = valueOf(JSON.parse(body)); } catch {} }
  return original;
}
// R4-3: the confirmation answers the ORIGINAL call and never promises more than the resume proved. A publish:true call
// whose publication did not run (or is not confirmed) gets result "delivered", failed "publish" and only the o11_publish
// continuation (the contract of o11-cycle.mjs C08); the publication of before is labelled previousPublication.
// The module of a kernel delivery task (work/deliver/<id>/task.json), read only when a confirmation needs it.
async function kernelModuleOf(kernelId, root) {
  try {
    const { findKernelTask } = await import('./o11-cycle.mjs');
    for (const work of kernelWorkFolders(root)) { const state = findKernelTask(work, { taskId: kernelId }); if (state?.module) return state.module; }
  } catch {}
  return null;
}
export function deliveredConfirmation(original, reconciled, { module: kernelModule = null } = {}) {
  const { lastPublication, ...proven } = reconciled ?? {};
  const published = reconciled?.ok === true && reconciled?.publish?.outcome === 'published';
  if (original?.publish?.requested === true && !published) {
    const module = original?.module ?? reconciled?.module ?? kernelModule;
    const ran = reconciled?.publish?.requested === true;
    return { ...proven, ...(lastPublication ? { previousPublication: lastPublication } : {}), ok: false, result: RESULT.delivered, code: ran && reconciled?.code ? reconciled.code : 'PUBLISH_SKIPPED', failed: 'publish',
      publish: ran ? reconciled.publish : { requested: true, outcome: 'skipped' },
      continuation: { tool: 'o11_publish', arguments: { module, authorize: WORDS_MARKER }, why: 'The delivery is already in the Studio; publish only the module (never repeat the delivery). authorize: the user\'s words in place of the marker.' },
      message: 'The delivery was reconciled as delivered; the publication the original call asked for did not run.' };
  }
  if (reconciled?.ok !== true) return { ...reconciled, result: RESULT.delivered };
  return { ...reconciled, ok: true, code: 'TASK_DELIVERED', result: resultIs(reconciled.result, 'deliveredAndPublished') ? RESULT.deliveredAndPublished : RESULT.delivered, message: 'The operation was delivered and reconciled.' };
}
function annotate(answer, fields) {
  const value = valueOf(answer);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value === answer || Object.keys(fields).some(k => Object.hasOwn(value,k) && value[k] !== fields[k]))
    return { ...answer, _meta: { ...answer._meta, ...fields }, content: [...(answer.content ?? []), { type:'text', text:JSON.stringify(fields) }] };
  const updated = { ...value, ...fields };
  let changed = false;
  const content = (answer.content ?? []).map(block => { if (block.type !== 'text' || changed) return block; changed = true; return { ...block, text: JSON.stringify(updated) }; });
  if (!changed) content.unshift({ type: 'text', text: JSON.stringify(updated) });
  return { ...answer, structuredContent: updated, content };
}
// The fields of a replayed or joined answer next to its own (ssam.mjs: resumedFrom of a replay).
export const annotateAnswer = (answer, fields) => annotate(answer, fields);
// answerOrigin(tool, args) -> {tool, kind?} | null (fix/no-internals round 4, a licensee's server): whose answer the final
// answer of a call is, kept with it (answer-size.mjs keepAnswer), so ssam_evidence reads it back as that tool's answer.
// inputsOf(tool, args) -> undefined (a call outside the run-to-end family: CX12 as before) | {key, print, replay} (print: the
// sha256 of its normalized arguments and of the files it reads, null when one cannot be read for sure; replay false: its
// final answer is never given to a later identical call); replay-store.mjs createReplay.
export function createCallDeadline({ root, dir = tasksDir(root), timeoutMs = callDeadlineMs(), env = process.env, notify, hasTool = () => true, defaultLane = 'o11', persistTask = mergeTask, saveAnswer = keepAnswer, answerOrigin = null, inputsOf = null } = {}) {
  const originOf = (tool, args) => { try { return answerOrigin?.(tool, args) ?? null; } catch { return null; } };
  const scope = folderKey(dir);
  const entries = scopedMap(callsByKey, scope), byId = scopedMap(callsById, scope);
  try { ensureTaskIndexes(dir); } catch {}
  // The detached count (and its notification) stays this deadline's: an entry counts for the deadline that started it,
  // whichever deadline of the folder detaches it; runningTasks lists only those.
  let detached = 0;
  const changed = () => { if (env.SSAM_RELAY_CHILD === '1') Promise.resolve(notify?.({ method: 'notifications/ssam/detached_tasks', params: { running: detached } })).catch(() => {}); };
  const owner = { up: () => { detached++; changed(); }, down: () => { detached--; changed(); } };
  const persist = (entry, fields) => (entry.persistTask ?? persistTask)(dir, { id: entry.id, tool: entry.tool, pid: process.pid, startedAt: new Date(entry.started).toISOString(), state: 'running', call: entry.call, continuationLane: entry.continuationLane, isWrite: entry.isWrite, cancelled: entry.cancelled === true, ...fields });
  // M6 adjustment 6: a destructive execution still running also names the record of its operation (taskStepOfCall).
  const recordOf = entry => entry.step ? { destructiveRecord: entry.step, ...(entry.previewIds.length > 1 ? { previewIds: entry.previewIds } : {}) } : {};
  const running = (entry, joined = false) => reply({ state: 'running', task: { id: entry.id, tool: entry.tool, elapsedMs: Date.now() - entry.started }, continuation: next(entry), ...recordOf(entry), ...(joined ? { joined: true } : {}) });
  const safePersist = (entry, fields) => {
    try { persist(entry, fields); return true; }
    catch { entry.storageFailed = true; return false; }
  };
  const detach = entry => {
    if (entry.detached) return;
    entry.detached = true; entry.removeAbort?.(); (entry.owner ?? owner).up();
    safePersist(entry);
  };
  const evidenceNext = (task, close = false) => hasTool('ssam_task')
    ? { tool: 'ssam_task', arguments: { id: task.id, ...(close ? { close: { reason: '<reason after reconciliation>' } } : {}) }, why: close ? 'Explicitly close this facade task after reconciling the original outcome; only then may a new operation run.' : 'Read the original operation evidence.' }
    : { tool: 'ssam_doctor', arguments: { lane: task.call?.lane ?? defaultLane, task: { id: task.id, ...(close ? { close: { reason: '<reason after reconciliation>' } } : {}) } }, why: close ? 'Explicitly close this facade task after reconciliation; only then may a new operation run.' : 'Read the original operation evidence on this served lane.' };
  const uncertainAnswer = task => {
    let original = savedOriginal(task);
    if (original?.taskId && task.call?.lane === 'o11') original = { ...original, continuation: { tool: 'o11_deliver', arguments: { resume: original.taskId }, why: 'Resume this kernel delivery to reconcile its outcome; proof close via ssam_task also releases this facade record.' } };
    return refusal(task.cancelled ? 'TASK_CANCELLED_UNCERTAIN' : 'TASK_UNCERTAIN_PENDING', 'The previous operation has no definitive outcome; reconcile and explicitly close its task before a new operation.', {
      ...original, ok: false, code: task.cancelled ? 'TASK_CANCELLED_UNCERTAIN' : 'TASK_UNCERTAIN_PENDING', outcome: 'uncertain',
      task: { id: task.id, tool: task.tool, ...(task.orphaned ? { orphaned: true } : {}) }, continuation: original?.continuation ?? evidenceNext(task), close: evidenceNext(task, true)
    });
  };
  const cancelOriginal = entry => {
    entry.cancelled = true;
    // Abort affects only the original handler signal and this caller's wait. Other callers retain its promise.
    detach(entry);
    safePersist(entry, { cancelled: true });
  };
  const deliver = entry => {
    const deliveries = (entry.deliveries ?? 0) + 1;
    if (entry.detached) safePersist(entry, { state: completionState(entry.result), answer: entry.answer, deliveries, endedAt: new Date(entry.finished).toISOString() });
    entry.deliveries = deliveries;
    // Cancelled writes remain joined in this process; never treat an uncertain write as a fresh retry.
    if (!entry.isWrite || completionState(entry.result) !== 'uncertain') {
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      if (!entry.detached || entry.answer && !entry.storageFailed) byId.delete(entry.id);
    }
    return entry.result;
  };
  // A call marked to run to its end (markRunsToEnd) is kept at the deadline: it detaches without an answer, and the
  // original request (holding: its progress still reaches it) and an identical call that joined it wait for the final
  // answer. A continuation (continueTask) of any task still answers running at the deadline.
  const keep = (entry, original) => { entry.kept = true; if (original && !entry.cancelled) entry.holding = true; detach(entry); };
  // A repeat that joins a run-to-end call names its task (Integradora, A5): ssam_task {id, stop:true} stops it.
  const joinedFields = entry => ({ joined: true, ...(entry.runsToEnd ? { joinedTask: entry.id } : {}) });
  // B4: the same arguments while the first still runs, but the files it reads changed: one refusal, nothing started. Round 3b
  // (Integradora, 2026-10-18: no blind join): the same when this server cannot read what the call names (a relative path,
  // agent:, ws:, a path of another machine: its print is null), so it cannot compare it with what the running one read.
  // Round 3c (re-review M2): when the content cannot be read there is no replay after the end, so the refusal never sends the
  // model back with the same job: after the end it reads the task's answer, which is this call's when the job is the same.
  const readTaskText = () => (hasTool('ssam_task') ? 'ssam_task {id}' : 'ssam_doctor {task:{id}}');
  // The cause named is the call's own (inputs.unreadable): a path it cannot read, or a job too large to look at whole.
  // 'outside' (a8 phase 7, hosted): a file this call names outside the caller's own workspace, which the server never reads.
  const unreadableCause = reason => (reason === 'size' ? 'cannot compare the content this call names (a job or a file too large to look at whole)'
    : reason === 'outside' ? 'does not read a file this call names outside your own workspace (its content cannot be compared)'
      : 'cannot read the content this call names (a relative path, agent:, ws: or a path of another machine)');
  const stillRunning = (entry, { unreadable = false } = {}) => refusal('DELIVERY_STILL_RUNNING', unreadable
    ? 'A delivery of this job is still running. This server ' + unreadableCause(unreadable) + ', so it neither joins the running one nor starts this one; nothing was started. Its continuation waits for its final answer; after its end read it with ' + readTaskText() + ': when the job is the same, that is this call\'s answer. Never send the same job again; a changed job goes after it ends or after stopping it.'
    : 'This call is still running with the content it read when it started; a file it reads changed since, so the new content was not started. Wait for the running one or stop it, then send the call again.', {
    outcome: 'not-sent', task: { id: entry.id, tool: entry.tool }, continuation: next(entry),
    wait: { ...evidenceNext(entry), why: 'the state of the running call; continuation waits for its final answer' },
    stop: hasTool('ssam_task') ? { tool: 'ssam_task', arguments: { id: entry.id, stop: true }, why: 'stops the running call before its next step; then send the call again' }
      : { tool: 'ssam_doctor', arguments: { lane: entry.call?.lane ?? defaultLane, task: { id: entry.id, stop: true } }, why: 'stops the running call before its next step; then send the call again' } });
  const sameInputs = (entry, inputs) => inputs === undefined || inputs?.print != null && entry?.inputs?.print === inputs.print;
  async function wait(entry, signal, joined = false, original = false) {
    let timer, abort;
    try {
      const elapsed = new Promise(resolve => {
        if (entry.exempt && original) return;
        timer = setTimeout(() => { if ((original || joined) && entry.runsToEnd) keep(entry, original); else resolve(false); }, timeoutMs);
      });
      const cancelled = new Promise((_, reject) => { abort = () => { if (original) cancelOriginal(entry); reject(Object.assign(new Error('Continuation cancelled'), { code: 'CANCELLED' })); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
      const finished = await Promise.race([entry.promise.then(() => true), elapsed, cancelled]);
      if (finished) return joined ? annotate(deliver(entry), joinedFields(entry)) : deliver(entry);
      detach(entry); return running(entry, joined);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (original) entry.holding = false; }
  }
  async function fromDisk(tool, args, signal) {
    let task = readTask(args.continueTask, { dir });
    if (!task) return notReached(refusal('TASK_NOT_FOUND', 'No task ' + args.continueTask));
    if (task.tool !== tool) return notReached(refusal('TASK_TOOL_MISMATCH', 'This task belongs to ' + task.tool, { continuation: next(task) }));
    const started = Date.now();
    while (true) {
      if (task.answer) {
        try {
          const body = fs.readFileSync(task.answer.file, 'utf8');
          if (createHash('sha256').update(body).digest('hex') !== task.answer.sha256) throw new Error('Task answer hash differs');
          // The persisted copy is already sanitized; a copy saved by an older release is sanitized here (R4-2).
          const result = sanitizeAnswer(JSON.parse(body));
          mergeTask(dir, { id: task.id, deliveries: (task.deliveries ?? 0) + 1 });
          return result;
        } catch (error) { return refusal('TASK_ANSWER_UNAVAILABLE', error.message); }
      }
      if (task.state === 'uncertain') return uncertainAnswer(task);
      if (task.state !== 'running') return refusal('TASK_ANSWER_UNAVAILABLE', 'This task ended without a saved final answer. Read its evidence before any new operation.');
      // M3 and CT-1 (from servidor/fase4-26): readTask applies the one rule of ssam-task.mjs (orphanedTask): a task this
      // process still runs for another deadline on the same folder is waited for, never orphaned; a record of this pid that
      // no handler here runs (a restart that got the same pid) is orphaned.
      if (task.orphaned) {
        let continuation = { tool: task.call?.lane === 'odc' ? 'studio_status' : 'ssam_doctor', arguments: task.call?.lane ? { lane: task.call.lane } : {}, why: 'reconcile the original state; never repeat an uncertain write' };
        if (continuation.tool === 'studio_status') continuation.arguments = {};
        if (task.result?.taskId && task.call?.lane === 'o11') continuation = (await kernelTaskAnswer(task.result.taskId, { root }))?.continuation ?? continuation;
        return refusal('TASK_ORPHANED', 'The server that ran this task stopped before its final answer.', { ...(task.isWrite !== false ? { outcome: 'uncertain', close: evidenceNext(task, true) } : {}), continuation: hasTool(continuation.tool) ? continuation : evidenceNext(task) });
      }
      if (signal?.aborted) throw Object.assign(new Error('Continuation cancelled'), { code: 'CANCELLED' });
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) return running({ ...task, started: Date.parse(task.startedAt) });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(done, Math.min(250, left));
        const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(Object.assign(new Error('Continuation cancelled'), { code: 'CANCELLED' })); };
        function done() { signal?.removeEventListener('abort', aborted); resolve(); }
        signal?.addEventListener('abort', aborted, { once: true });
      });
      task = readTask(task.id, { dir }) ?? task;
    }
  }
  return { wrap(tool, handler, { exempt = false, ...config } = {}) {
    if (config.annotations != null || !classifyTool(tool).declared) declareToolClassification(tool, config);
    return async (args = {}, ctx) => {
      const signal = ctx?.mcpReq?.signal;
      if (Object.hasOwn(args, 'continueTask')) {
        const extras = Object.keys(args).filter(k => k !== 'continueTask' && k !== 'lane');
        if (extras.length) return notReached(refusal('INPUT_INVALID', 'A continuation accepts only continueTask and lane.', { violations: extras.map(k => ({ path: '/' + k, message: 'Unexpected continuation field', accepted: ['continueTask', 'lane'] })), continuation: { tool, arguments: { continueTask: args.continueTask, ...(args.lane ? { lane: args.lane } : {}) }, why: 'remove all extra fields' } }));
        const entry = byId.get(args.continueTask);
        if (entry && entry.tool !== tool) return notReached(refusal('TASK_TOOL_MISMATCH', 'This task belongs to ' + entry.tool, { continuation: next(entry) }));
        return entry ? wait(entry, signal) : fromDisk(tool, args, signal);
      }
      // Elicitation may require the still-open request: propose must never detach.
      const hash = createHash('sha256').update(canonicalArguments(args)).digest('hex');
      const key = tool + ':' + hash;
      // M6 adjustment 8: for a destructive execution (it carries its confirmationToken) without a definitive outcome, the CX15
      // record and lease decide a repeat (CONFIRMATION_ALREADY_USED, OperationRunning, the record by ssam_task), never
      // TASK_UNCERTAIN_PENDING: an uncertain finished one is forgotten here and the gate answers the repeat by its record; a
      // running one is joined (the same call, never a second send); a definitive one (ok/failed) is delivered as CX12 does.
      const phase = phaseOfCall(tool, args);
      // inputsOf may answer a promise (a hosted gate that pulls the file it names to read it); the lookup below stays atomic.
      let inputs;
      try { inputs = inputsOf?.(tool, args); if (typeof inputs?.then === 'function') inputs = await inputs; } catch { inputs = { print: null }; }
      let entry = entries.get(key);
      // CT-2: a call never joins a live call it runs inside (a nested identical call through another deadline of the folder
      // would wait for itself); it goes on as a call of its own and leaves the index to the outer call, as before.
      const nested = !!entry && !entry.finished && runsInside(entry);
      if (nested) entry = null;
      // B1: the same inputs under other arguments (a default written or not) are the same live call.
      if (!entry && inputs?.print) entry = entries.values().find(e => !e.finished && e.tool === tool && e.inputs?.print === inputs.print && !runsInside(e)) ?? null;
      // A1: an undelivered final (CX12) is the answer of a run-to-end call only for the same inputs; none when they cannot be read.
      // Round 3b: none for a publication, refresh, deployment or package (inputs.replay false), which runs again after its end.
      if (entry?.finished && completionState(entry.result) !== 'uncertain' && (!sameInputs(entry, inputs) || inputs?.replay === false)) { if (entries.get(key) === entry) entries.delete(key); entry = null; }
      if (entry?.finished && entry.phase === 'execute' && completionState(entry.result) === 'uncertain') { entries.delete(key); if (entry.deliveries) byId.delete(entry.id); entry = null; }
      if (entry?.finished && (!entry.isWrite || completionState(entry.result) !== 'uncertain') && (entry.deliveries || entry.cancelled && (!entry.isWrite || valueOf(entry.result)?.outcome === 'not-sent') || Date.now() - entry.finished > 600000 && !(entry.cancelled && entry.isWrite))) { entries.delete(key); entry = null; }
      if (entry) {
        if (entry.finished) {
          const stored = readTask(entry.id, { dir });
          if (stored?.reconciledOutcome === 'delivered' && !stored.deliveries) { entries.delete(key); byId.delete(entry.id); return fromDisk(tool, { continueTask: entry.id }, signal); }
          if (entry.isWrite && completionState(entry.result) === 'uncertain' && stored?.closedAt) { entries.delete(key); byId.delete(entry.id); entry = null; }
          else if (entry.isWrite && entry.deliveries && completionState(entry.result) === 'uncertain') return uncertainAnswer(entry);
          else return entry.detached && !entry.cancelled ? annotate(deliver(entry), { resumedFrom: entry.id }) : deliver(entry);
        }
        // B4: the same arguments while the first still runs, but what it reads changed: one refusal, nothing started; round 3b:
        // also when what it reads cannot be read here (never a blind join).
        if (entry && (inputs?.print === null || entry.inputs?.print === null)) return stillRunning(entry, { unreadable: inputs?.unreadable ?? entry.inputs?.unreadable ?? 'path' });
        if (entry && inputs?.print && entry.inputs?.print && entry.inputs.print !== inputs.print) return stillRunning(entry);
        if (entry) return wait(entry, signal, true);
      }
      const mutation = isMutation(tool, args);
      if (mutation) {
        const previous = findCallTask(dir, tool, hash);
        // A1: an undelivered final on disk is the answer of a run-to-end call only for the same inputs (its record keeps them).
        const same = previous && (inputs === undefined || inputs.replay !== false && inputs.print != null && previous.call?.inputsSha256 === inputs.print);
        if (previous && awaitsReplay(previous) && same) return fromDisk(tool, { continueTask: previous.id }, signal);
        // A4: a record that only keeps its replay window reserves the call for the served handler, which decides on the inputs.
        if (previous && !previous.closedAt && phase !== 'execute' && !replayWindowOpen(previous) && !(awaitsReplay(previous) && !same)) return uncertainAnswer(previous);
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      const previewIds = phase === 'execute' ? tokensOfCall(args) : [];
      entry = { id: randomUUID(), dir, tool, key, exempt, started: Date.now(), continuationLane: args.lane, call: { argsSha256: hash, lane: args.lane ?? (/^o11_/.test(tool) ? 'o11' : /^(studio_|odc_|hybrid_)/.test(tool) ? 'odc' : defaultLane), ...(previewIds.length ? { previewIds } : {}), ...(inputs?.print ? { inputsSha256: inputs.print } : {}) }, isWrite: mutation, deliveries: 0, controller, inputs,
        phase, previewIds, step: phase === 'execute' ? taskStepOfCall(args) : null, owner, persistTask, parent: callScope.getStore() ?? null,
        removeAbort: () => signal?.removeEventListener('abort', abort) };
      const notifyOriginal = ctx?.mcpReq?.notify;
      const context = ctx?.mcpReq ? { ...ctx, mcpReq: { ...ctx.mcpReq, signal: controller.signal, notify: (...params) => entry.detached && !entry.holding ? Promise.resolve() : notifyOriginal?.(...params) } } : ctx;
      if (!nested) entries.set(key, entry);
      byId.set(entry.id, entry); liveTasks.set(liveKey(dir, entry.id), entry);
      entry.promise = Promise.resolve().then(() => callScope.run(entry, () => handler(args, context))).catch(error => reply({ ok: false, error: error.message, ...(entry.isWrite ? { outcome: 'uncertain', code: entry.cancelled ? 'TASK_CANCELLED_UNCERTAIN' : 'TASK_FAILED_UNCERTAIN', continuation: entry.step ?? evidenceNext(entry), ...(entry.step ? recordOf(entry) : {}) } : {}) })).then(async result => {
        if (result == null && entry.isWrite) result = uncertainAnswer(entry);
        // R4-2: the live answer is the handler's; only the persisted copy (saveAnswer below) and its replay are sanitized.
        const reconciled = valueOf(result);
        try {
        if ((args.resume || args.close) && /^[0-9a-f]{32}$/i.test(String(reconciled?.taskId ?? args.resume ?? args.close?.taskId))) {
          const kernelId = reconciled?.taskId ?? args.resume ?? args.close.taskId;
          if (reconciled?.writeState === 'not-applied' || reconciled?.code === 'MERGE_ROLLED_BACK' && reconciled?.closed === true || reconciled?.closed === true && reconciled?.ok === true) releaseKernelFacadeTasks(kernelId, { dir, outcome: 'not-applied' });
          else if (resultIs(reconciled?.result, 'delivered') || reconciled?.delivered === true || reconciled?.writeState === 'applied' && reconciled?.ok === true) {
            // Read before any release, so a record is never closed while its confirmation waits.
            const module = await kernelModuleOf(kernelId, root);
            for (const task of releaseKernelFacadeTasks(kernelId, { dir, outcome: 'delivered' })) {
              // R4-3: built for the original call of this record; R4-7: its own marker, never cancelled:true.
              const confirmation = reply(deliveredConfirmation(savedOriginal(task), reconciled, { module }));
              mergeTask(dir, { id: task.id, state: stateOf(valueOf(confirmation)), closedAt: null, confirmation: 'delivered', deliveries: 0, answer: saveAnswer(sanitizeAnswer(confirmation), root, originOf(task.tool, {})), callResult: valueOf(confirmation) });
            }
          }
        }
        } catch { entry.storageFailed = true; result = annotate(result, { reconciliationGuardPending: true }); }
        entry.result = result; entry.finished = Date.now(); entry.removeAbort(); liveTasks.delete(liveKey(dir, entry.id));
        if (!entry.detached && entry.isWrite && completionState(result) === 'uncertain') detach(entry);
        if (entry.detached) {
          try {
            try { entry.answer = saveAnswer(sanitizeAnswer(result), root, originOf(entry.tool, args)); } catch { entry.storageFailed = true; }
            safePersist(entry, { state: completionState(result), answer: entry.answer, deliveries: entry.deliveries, endedAt: new Date(entry.finished).toISOString(), callResult: valueOf(result), ...(!entry.tracked ? { result: valueOf(result) } : {}), cancelled: entry.cancelled === true });
          } finally { entry.owner.down(); }
        }
        if (entry.tracked && !entry.detached) safePersist(entry, { state: completionState(result), callResult: valueOf(result), deliveries: entry.deliveries, endedAt: new Date(entry.finished).toISOString() });
        return result;
      });
      return wait(entry, signal, false, true);
    };
  }, stop: id => stopTask(id, { dir }), runningCount: () => detached, runningTasks: () => [...byId.values()].filter(entry => entry.owner === owner && entry.detached && !entry.finished).map(entry => ({ id: entry.id, tool: entry.tool, isWrite: entry.isWrite, continuation: next(entry) })) };
}

// Long tasks of the facade (o11_deliver today): one JSON file per task under <anvilRoot>/.local/tasks, so another server
// process, or the same one after a lost reply, answers `ssam_task` from the files alone. A task keeps who ran it, a short
// summary, its state (running | ok | failed | uncertain), its times and a short result; never the user's words and never
// a full receipt (the kernel keeps those in its own task folder).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot } from './workspace.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { listOperations, readOperation, readPreviewState, summarizeOperation } from './destructive-operations.mjs';
import { callScope, stopTask, isLiveTask, stopOperation, runsHere, folderKey } from './call-deadline.mjs';
import { WORDS_MARKER } from './next-steps.mjs';
import { WORDS as ENGLISH_WORDS_MARKER } from './continuations.mjs';

export const TASK_STATES = ['running', 'ok', 'failed', 'uncertain'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KERNEL_ID = /^[0-9a-f]{32}$/i; // a kernel delivery task id (work/deliver/<id>), answered through the task that ran it
// Hosted (executor.mjs), the default root means the customer's <ws>/o11/tasks.
export const tasksDir = (root = anvilRoot) => (usesWorkspace(root, anvilRoot) ? workspacePath('o11', 'tasks') : path.join(root, '.local', 'tasks'));

// Words never reach a task file, whatever the caller put in the summary.
const WORDS = /^(authorize|authorization|words|password|passwd|secret|token|accessToken|refreshToken|apiKey|credentials|cookie|bridgeKey)$/i;
export const scrub = value => Array.isArray(value) ? value.map(scrub)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => !WORDS.test(k)).map(([k, v]) => [k, scrub(v)]))
  : value;

// CT-1: the start of this server process, random at module load. Every record this process writes names it next to its
// pid (processStartId), and so does the call index entry of the record.
export const PROCESS_START_ID = randomUUID();

const indexFile = (dir, kind, key) => path.join(dir, '.index', kind, key + '.json');
const callKey = (tool, hash) => createHash('sha256').update(tool + '\0' + hash).digest('hex');
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file);
}
const readIndex = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// The keys that carry the user's words. In a persisted answer copy (and its replay) they keep only a public marker: the
// exact markers, a <...> template of a continuation, or a boolean (needs.words: true); any other value is dropped. Every
// other key of WORDS (token, password, credentials, ...) is always dropped. The live answer never passes through here.
const WORDS_KEYS = /^(authorize|authorization|words)$/i;
const TEMPLATE = /^<[^<>]{1,200}>$/;
const publicMarker = item => typeof item === 'boolean' || item === WORDS_MARKER || item === ENGLISH_WORDS_MARKER || typeof item === 'string' && TEMPLATE.test(item);
export function sanitizeAnswer(answer) {
  const cleanValue = value => Array.isArray(value) ? value.map(cleanValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !WORDS.test(key) || WORDS_KEYS.test(key) && publicMarker(item))
      .map(([key, item]) => [key, cleanValue(item)])) : value;
  const clean = cleanValue(answer);
  if (!Array.isArray(clean?.content)) return clean;
  return { ...clean, content: clean.content.map(block => {
    if (block.type !== 'text') return block;
    try { return { ...block, text: JSON.stringify(cleanValue(JSON.parse(block.text))) }; } catch { return block; }
  }) };
}
// A final the identical call has not received yet: a cancelled write whose handler ran (never one cancelled before it was
// sent: outcome "not-sent" means nothing ran, so the identical call is a new operation, R4-1), or the delivered
// confirmation saved for the original call of a reconciled kernel delivery (confirmation, R4-7).
export const awaitsReplay = task => !task?.closedAt && !task.deliveries && ['ok', 'failed'].includes(task.state)
  && (task.confirmation === 'delivered' || task.cancelled === true && (task.callResult ?? task.result)?.outcome !== 'not-sent');
// The replay window of an unconfirmed final answer (replay-store.mjs; Integradora, 2026-10-18, A4): the record keeps it, so
// after a restart the call stays reserved for it; the served handler decides the replay on the call's inputs.
export const replayWindowOpen = task => !!task && !task.closedAt && ['ok', 'failed'].includes(task.state)
  && typeof task.replayUntil === 'string' && Date.parse(task.replayUntil) > Date.now();
// One predicate decides whether a record holds its call key: the index and the guard read the same rule (R4-5).
export const reservesCall = task => !!task && !task.closedAt && task.isWrite !== false
  && (task.state === 'running' || task.state === 'uncertain' || awaitsReplay(task) || replayWindowOpen(task));
function updateIndexes(dir, task) {
  if (task.tool && task.call?.argsSha256) {
    const file = indexFile(dir, 'calls', callKey(task.tool, task.call.argsSha256));
    if (reservesCall(task)) atomicJson(file, { id: task.id, ...(task.processStartId ? { processStartId: task.processStartId } : {}) });
    else if (readIndex(file)?.id === task.id) { try { fs.unlinkSync(file); } catch {} }
  }
  if (KERNEL_ID.test(String(task.result?.taskId))) {
    const file = indexFile(dir, 'kernel', task.result.taskId.toLowerCase());
    const ids = readIndex(file)?.ids ?? [];
    if (!ids.includes(task.id)) atomicJson(file, { ids: [...ids, task.id] });
  }
}
// Only startup migration enumerates legacy evidence. Every subsequent mutation looks up one key directly.
export function ensureTaskIndexes(dir) {
  const marker = path.join(dir, '.index', 'version.json');
  if (readIndex(marker)?.format === 1) return;
  let names = []; try { names = fs.readdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  const records = names.filter(name => /\.json$/i.test(name) && UUID.test(name.slice(0, -5)))
    .map(name => readTask(name.slice(0, -5), { dir })).filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  for (const task of records) updateIndexes(dir, task);
  atomicJson(marker, { format: 1 });
}
export function findCallTask(dir, tool, hash) {
  const file = indexFile(dir, 'calls', callKey(tool, hash));
  const indexed = readIndex(file);
  const task = indexed?.id ? readTask(indexed.id, { dir }) : null;
  if (task?.tool !== tool || task.call?.argsSha256 !== hash) return null;
  if (reservesCall(task)) return task;
  // A stale entry (an unlink that failed, or a stop between the record and its index) never refuses the call forever:
  // the record it names was read and no longer holds the key, so the entry goes (R4-5). An unreadable record keeps it.
  if (readIndex(file)?.id === task.id) { try { fs.unlinkSync(file); } catch {} }
  return null;
}
export function findKernelFacadeTasks(kernelId, { dir = tasksDir() } = {}) {
  if (!KERNEL_ID.test(String(kernelId))) return [];
  return (readIndex(indexFile(dir, 'kernel', kernelId.toLowerCase()))?.ids ?? []).map(id => readTask(id, { dir })).filter(Boolean);
}
export function releaseKernelFacadeTasks(kernelId, { dir = tasksDir(), reason = 'Kernel reconciliation confirmed', outcome } = {}) {
  return findKernelFacadeTasks(kernelId, { dir }).filter(task => !task.closedAt).map(task => mergeTask(dir, { id: task.id,
    closedAt: new Date().toISOString(), closeReason: reason, ...(outcome ? { reconciledOutcome: outcome } : {}) }));
}

function write(dir, task) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, task.id + '.json');
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(task, null, 2));
  fs.renameSync(temporary, file);
}

// A shared task record is updated atomically; nested trackers never discard the call's final answer.
export function mergeTask(dir, fields) {
  const existing = readTask(fields.id, { dir }) ?? {};
  // A merge that writes this process's pid also writes its start (CT-1); one that writes no pid keeps the record's own.
  const task = scrub({ ...existing, ...fields, ...(fields.pid === process.pid ? { processStartId: PROCESS_START_ID } : {}) });
  for (const key of ['result', 'callResult']) if (task[key] != null) task[key] = briefResult(task[key]);
  delete task.orphaned;
  write(dir, task);
  updateIndexes(dir, task);
  return task;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// The trackTask bodies this process runs now, by folder and id (a trackTask may run outside any call deadline).
const trackedHere = new Set();
const trackedKey = (dir, id) => folderKey(dir) + '|' + String(id).toLowerCase();
// CT-1 (servidor/fase4-26): ONE rule says whether a running record still runs, for every reader (readTask and the listing,
// closeFacadeTask, the ssam_task close, the identical-call guard, continueTask). A record of another pid runs while that
// process lives. A record of this pid runs only while this process runs its handler (a live call of a deadline, a
// trackTask body). So one with another start id (a restart that got the same pid: pid 7 in every
// start of the image), one of an older release without the id, or one whose handler ended here without its final write,
// is orphaned: it never finished, ssam_task says so and its explicit close works (continueTask already answered
// TASK_ORPHANED for it; now every reader agrees).
export function orphanedTask(task, dir) {
  if (task?.state !== 'running' || !Number.isInteger(task.pid)) return false;
  if (task.pid !== process.pid) return !alive(task.pid);
  if (task.processStartId != null && task.processStartId !== PROCESS_START_ID) return true;
  return !runsHere(task.id, dir) && !trackedHere.has(trackedKey(dir, task.id));
}
const live = (task, dir) => orphanedTask(task, dir) ? { ...task, orphaned: true } : task;

export function readTask(id, { dir = tasksDir() } = {}) {
  if (!UUID.test(String(id))) return null;
  try { return live(JSON.parse(fs.readFileSync(path.join(dir, String(id).toLowerCase() + '.json'), 'utf8')), dir); }
  catch { return null; }
}

// Explicit reconciliation closes only an uncertain facade record. Kernel delivery tasks keep their proof-based close.
export function closeFacadeTask(id, reason, { dir = tasksDir() } = {}) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500)
    return { ok: false, code: 'BAD_ARGS', error: 'close needs a reason of 1 to 500 characters' };
  const task = readTask(id, { dir });
  if (!task) return { ok: false, code: 'CLOSE_TASK_NOT_FOUND', error: 'No facade task ' + id + ' to close' };
  if (isLiveTask(id, dir)) return { ok: false, code: 'CLOSE_TASK_RUNNING', error: 'The real handler is still running; wait for its final answer' };
  if (typeof task.result?.taskId === 'string' && KERNEL_ID.test(task.result.taskId))
    return { ok: false, code: 'CLOSE_KERNEL_REQUIRED', error: 'This delivery task requires the existing kernel close with proof',
      continuation: closeContinuation(task.result.taskId) };
  if (task.state === 'running' && !task.orphaned)
    return { ok: false, code: 'CLOSE_TASK_RUNNING', error: 'The handler is still running; wait for its final answer' };
  if (task.closedAt) return { ok: true, task };
  if (task.state !== 'uncertain' && !task.orphaned)
    return { ok: false, code: 'CLOSE_TASK_NOT_UNCERTAIN', error: 'Only an uncertain or orphaned facade task needs reconciliation close' };
  return { ok: true, task: mergeTask(dir, { id: task.id, closedAt: new Date().toISOString(), closeReason: reason.trim() }) };
}

// Newest first by start time.
export function listTasks({ dir = tasksDir(), limit = 20, tool } = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => /\.json$/i.test(n) && UUID.test(n.slice(0, -5))); } catch { return []; }
  const found = names.map(n => readTask(n.slice(0, -5), { dir })).filter(t => t && (!tool || t.tool === tool))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit)
    .map(({ callResult, ...task }) => ({ ...scrub(task), ...(task.result ? { result: briefResult(task.result) } : {}) }));
  if (limit !== 20) return found;
  // A listing is evidence, not a receipt. Legacy large records must not make the default response exceed its page.
  const listed = []; let bytes = Buffer.byteLength('{"ok":true,"tasks":[]}');
  for (const task of found) {
    const size = Buffer.byteLength(JSON.stringify(task)) + 1;
    if (bytes + size >= 40000) break;
    listed.push(task); bytes += size;
  }
  return listed;
}

export const stateOf = value => value?.ok === true ? 'ok' : value?.outcome === 'uncertain' ? 'uncertain' : 'failed';
const KEPT = ['result', 'valid', 'outcome', 'code', 'stage', 'taskId', 'writeState'];
const contractSummary = value => typeof value?.contract === 'string' ? value.contract : value?.contract?.summary;
// A refusal's record says what refused (VisitaCerta 2026-10-12: two VALIDATION_REFUSED records kept only "job rejected by
// validation contract"): the contract's summary and the problems, short (code and pointer or element, at most 10).
export const briefResult = value => scrub({ ok: value?.ok === true, ...Object.fromEntries(KEPT.filter(k => value?.[k] != null && ['string', 'number', 'boolean'].includes(typeof value[k])).map(k => [k, typeof value[k] === 'string' ? value[k].slice(0, 300) : value[k]])),
  ...(value?.error ? { error: String(value.error).slice(0, 300) } : {}),
  ...(contractSummary(value) ? { contract: String(contractSummary(value)).slice(0, 300) } : {}),
  ...(Array.isArray(value?.problems) && value.problems.length ? { problemsTotal: value.problemsTotal ?? value.problems.length,
    problems: value.problems.slice(0, 10).map(p => typeof p === 'string' ? p.slice(0, 200) : [p?.code, p?.pointer ?? p?.element].filter(Boolean).join(' ').slice(0, 200)) } : {}) });

// Runs fn(task) and records it: `running` before, the state of its value after (ok:true -> ok, outcome 'uncertain' ->
// uncertain, anything else -> failed). An exception becomes {ok:false, error}, as every tool answer does.
export async function trackTask({ tool, summary = {}, dir = tasksDir(), now = () => new Date(), id }, fn) {
  const context = callScope.getStore();
  const normalizeDir = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const inherited = context && !context.tracked && normalizeDir(dir) === normalizeDir(context.dir);
  if (inherited) context.tracked = true;
  id ??= inherited ? context.id : randomUUID();
  const task = { id, tool: inherited ? context.tool : tool, summary: scrub(summary), ...(context ? { call: context.call } : {}), pid: process.pid, startedAt: now().toISOString(), state: 'running',
    ...(context && !inherited ? { callTask: context.id } : {}) };
  // CT-1: while its body runs here, its running record is never read orphaned.
  const key = trackedKey(dir, id);
  trackedHere.add(key);
  try {
    mergeTask(dir, task);
    let value;
    try { value = await fn(task); } catch (error) { value = { ok: false, error: error.message }; }
    try { mergeTask(dir, { ...task, ...(inherited ? { state: 'running' } : { state: stateOf(value), endedAt: now().toISOString() }), result: briefResult(value) }); }
    catch { /* the answer matters more than its record; the running record stays as evidence */ }
    return value;
  } finally { trackedHere.delete(key); }
}

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

// C37 (atritos 3): a kernel delivery task id (32 hex) that no facade record names yet (a delivery still running records its
// kernel taskId only at its end; one run by the CLI has no record at all) is read from the kernel's own task folder,
// <work>/deliver/<id>/task.json, in the delivery work folders of this root (ss4 .local/work, ss5 .local/lane-ss5/work):
// {ok:true, kernelTask:{id, writeState, stage, updatedAt, closeState}} with the next call its close state allows. The
// reservation a running delivery holds names this id (ssam_doctor), so ssam_task never answers TASK_NOT_FOUND for it.
export function kernelWorkFolders(root = anvilRoot) {
  const folders = [];
  for (const name of ['ss4', 'ss5']) { try { folders.push(o11LaneOf(name, { root }).work); } catch { /* lane table unreadable */ } }
  return [...new Set(folders)];
}
const KERNEL_NEXT = {
  refused: id => ({ tool: 'ssam_task', arguments: { id, close: { reason: '<reason>' } }, why: 'the delivery ended refused: this closes the task in the kernel and frees the module' }),
  uncertain: id => ({ tool: 'o11_deliver', arguments: { resume: id }, why: 'the write of this task was not confirmed: resume reconciles the same task and never repeats the merge' }),
  unsettled: id => ({ tool: 'o11_deliver', arguments: { resume: id }, why: 'while the delivery runs, it answers by itself (resume waits for its turn in the Studio queue); if it stopped without an answer, resume reconciles the same task' }),
};
export async function kernelTaskAnswer(id, { root = anvilRoot, works, findTask, closeStateOf } = {}) {
  const cycle = findTask && closeStateOf ? null : await import('./o11-cycle.mjs');
  const find = findTask ?? cycle.findKernelTask;
  const closing = closeStateOf ?? cycle.closeState;
  for (const work of works ?? kernelWorkFolders(root)) {
    let state = null;
    try { state = find(work, { taskId: id }); } catch { state = null; }
    if (!state) continue;
    const closeState = closing(state);
    const next = KERNEL_NEXT[closeState]?.(id);
    return { ok: true, kernelTask: { id, writeState: state.writeState ?? null, stage: state.stage ?? null, updatedAt: state.updatedAt ?? null, closeState },
      ...(next ? { continuation: next } : { note: 'the task already ended (' + closeState + '); a reservation it left is released by ssam_doctor {lane:"o11", release}' }) };
  }
  return null;
}

// The close of an uncertain delivery (C15): the kernel closes it only with the proof that nothing was applied (the live
// module captured now has exactly the bytes of the task's base snapshot) and never when the live module differs.
export const CLOSE_WITH_PROOF_WHY = 'Closes the uncertain delivery only with the proof that nothing was applied (the live module equal to the captured base); '
  + 'with a different module it stays uncertain and nothing is repeated. reason: the reason, in one line.';
const closeContinuation = id => ({ tool: 'ssam_task', arguments: { id, close: { reason: '<reason>' } }, why: CLOSE_WITH_PROOF_WHY });
const facadeCloseContinuation = id => ({ tool: 'ssam_task', arguments: { id, close: { reason: '<reason>' } },
  why: 'After reconciling the uncertain result, close this facade task explicitly with the reason; only then a new write can run.' });

// The CX15 record of a destructive operation by its operationId or previewId (with its items), or the state of a preview.
function destructiveRecordOf(id, root) {
  const operation = readOperation(id, { root });
  if (operation) return { ...summarizeOperation(operation, { root }), items: operation.items };
  return readPreviewState(id, { root }) ?? null;
}

// deps: tasksDir | root; close(kernelTaskId, reason, {signal}) -> answer (o11-cycle.mjs: `deliver --close` of the kernel,
// DeliveryTask.CloseKnownFailure, the same close o11_deliver {close} runs). Without close, ssam_task only reads.
export function registerSsamTask(server, deps = {}) {
  const dir = deps.tasksDir ?? tasksDir(deps.root ?? anvilRoot);
  server.registerTool('ssam_task', {
    title: 'State of long facade tasks',
    description: 'Task evidence: id, tool, summary (never the user\'s words), state running | ok | failed | uncertain, '
      + 'startedAt/endedAt and a short result. id: the task id, or the kernel taskId of a delivery. Without id: the 20 most recent. '
      + 'orphaned:true means the server that ran it stopped before it ended. Reading never repeats anything. '
      + 'close {reason} with id closes that delivery task in the kernel and frees its module: a refused one, or an uncertain one only with '
      + 'the proof that nothing was applied (the live module equals the base the task captured); never when the live module differs. Destructive operations (deletes, previewed then confirmed): without id, `destructive` lists the 10 most recent with their counts and names; id = the operationId or the previewId of a preview gives item by item what was deleted, uncertain or not started: read it before telling the owner anything after an interruption, CANCELLED or "rejected" (also after SC_LOCAL_FAILURE or any other local failure). '
      + 'Cancelling the wait does not stop the work. stop:true with a live facade id, or with the operationId/previewId of a destructive execution running in this server, aborts its handler before the next send. A facade UUID without a kernel taskId closes its finished uncertain or orphaned record after explicit reconciliation; a live running handler cannot close. A destructive record is never closed here: close with its operationId refuses and answers the record.',
    inputSchema: z.object({
      id: z.string().regex(/^[0-9a-fA-F-]{32,36}$/).optional().describe('UUID or delivery taskId (32 hex)'),
      stop: z.literal(true).optional(),
      close: z.object({ reason: z.string().trim().min(1).max(500) }).strict().optional().describe('id: close delivery task'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ id, close, stop } = {}, extra) => {
    try {
      if (stop) {
        if (!id || close) return reply({ ok: false, code: 'BAD_ARGS', error: 'stop needs a live facade id and cannot combine close.' });
        // Junction (M6 adjustment 4): the operationId or previewId of a destructive execution stops the live CX12 entry
        // that runs its token; without one, the CX15 record answers (what was sent), never TASK_NOT_FOUND.
        if (!isLiveTask(id, dir) && !KERNEL_ID.test(id)) {
          const record = destructiveRecordOf(id, deps.destructiveRoot);
          const stopped = stopOperation([id, record?.previewId, record?.operationId], { dir });
          if (stopped) return stopped;
          if (record) return reply({ ok: false, code: 'TASK_NOT_RUNNING', error: 'No execution of the destructive operation ' + id + ' is running in this server; its record says item by item what was sent.', destructiveOperation: record,
              continuation: { tool: 'ssam_task', arguments: { id }, why: 'Read the record of the operation before telling the owner anything; never repeat it.' } });
        }
        return stopTask(id, { dir });
      }
      if (close) {
        if (id && isLiveTask(id, dir)) return reply({ ok: false, code: 'CLOSE_TASK_RUNNING', error: 'The real handler is still running; wait for its final answer' });
        if (!id) return reply({ ok: false, code: 'BAD_ARGS', error: 'close needs the id of the delivery task', continuation: { tool: 'ssam_task', arguments: {}, why: 'Lists the recent tasks and their ids.' } });
        const facadeTask=KERNEL_ID.test(id)?null:readTask(id,{dir});
        if(facadeTask?.state==='running'&&!facadeTask.orphaned)return reply({ok:false,code:'TASK_STILL_RUNNING',task:{id:facadeTask.id,state:facadeTask.state,startedAt:facadeTask.startedAt},
          continuation:{tool:'ssam_task',arguments:{id},why:'Read the running task; it has not finished and cannot be closed yet.'}});
        const kernelId = KERNEL_ID.test(id) ? id.toLowerCase() : facadeTask?.result?.taskId ?? null;
        if (kernelId && findKernelFacadeTasks(kernelId, { dir }).some(task => isLiveTask(task.id, dir))) return reply({ ok: false, code: 'CLOSE_TASK_RUNNING', error: 'The real handler is still running; wait for its final answer' });
        if (!kernelId || !KERNEL_ID.test(kernelId)) {
          // Junction (M6 adjustments 4 and 8): a CX15 record is never closed by ssam_task (its lease and items stay as they
          // are); the refusal answers the record.
          const record = facadeTask ? null : destructiveRecordOf(id, deps.destructiveRoot);
          if (record) return reply({ ok: false, code: 'DESTRUCTIVE_RECORD_NOT_CLOSABLE', error: 'A destructive operation record is never closed by ssam_task; it says item by item what was deleted, uncertain or not started.',
            destructiveOperation: record, continuation: { tool: 'ssam_task', arguments: { id }, why: 'Read the record of the operation before telling the owner anything; never repeat it.' } });
          return reply(closeFacadeTask(id, close.reason, { dir }));
        }
        if (typeof deps.close !== 'function') return reply({ ok: false, code: 'CLOSE_UNAVAILABLE', error: 'This server does not serve the O11 delivery close.',
          continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Shows the O11 lane of this server.' } });
        const answer = await deps.close(kernelId, close.reason, { signal: extra?.signal });
        if (answer?.ok === true) releaseKernelFacadeTasks(kernelId, { dir, reason: close.reason, outcome: 'not-applied' });
        return reply(answer);
      }
      if (!id) return reply({ ok: true, tasks: listTasks({ dir }), destructive: listOperations({ limit: 10, root: deps.destructiveRoot }) });
      const task = KERNEL_ID.test(id) ? findKernelFacadeTasks(id, { dir }).at(-1) ?? listTasks({ dir, limit: 500 }).find(t => t.result?.taskId?.toLowerCase() === id.toLowerCase()) : readTask(id, { dir });
      if (!task && KERNEL_ID.test(id)) {
        const kernel = await kernelTaskAnswer(id.toLowerCase(), { root: deps.root ?? anvilRoot, works: deps.works, findTask: deps.findTask, closeStateOf: deps.closeState });
        if (kernel) return reply(kernel);
      }
      // CX15: the record of a destructive operation, by its operationId or by the previewId of its preview.
      const operation = task ? null : readOperation(id, { root: deps.destructiveRoot });
      if (operation) return reply({ ok: true, destructiveOperation: { ...summarizeOperation(operation, { root: deps.destructiveRoot }), items: operation.items } });
      // CX15 r2 (T5): a preview with no execution yet answers its state, never TASK_NOT_FOUND.
      const previewed = task ? null : readPreviewState(id, { root: deps.destructiveRoot });
      if (previewed) return reply({ ok: true, destructiveOperation: previewed });
      if (!task) return reply({ ok: false, code: 'TASK_NOT_FOUND', error: 'No task ' + id,
        continuation: { tool: 'ssam_task', arguments: {}, why: 'Lists the recent tasks and their ids.' } });
      const kernelId = task.result?.taskId;
      const kernel = typeof kernelId === 'string' && KERNEL_ID.test(kernelId);
      const continuation = !task.closedAt && (task.state === 'uncertain' || task.orphaned)
        ? kernel ? (typeof deps.close === 'function' ? closeContinuation(kernelId) : null) : facadeCloseContinuation(task.id)
        : null;
      // M6 adjustment 6: the task of a destructive execution also answers the CX15 record of its operation(s).
      const records = (task.call?.previewIds ?? []).map(previewId => destructiveRecordOf(previewId, deps.destructiveRoot)).filter(Boolean);
      return reply({ ok: true, task, ...(records.length ? { destructiveOperation: records[0], ...(records.length > 1 ? { destructiveOperations: records } : {}) } : {}), ...(continuation ? { continuation } : {}) });
    } catch (error) { return reply({ ok: false, error: error.message }); }
  });
}

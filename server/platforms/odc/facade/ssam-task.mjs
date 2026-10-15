// Long tasks of the facade (o11_deliver today): one JSON file per task under <anvilRoot>/.local/tasks, so another server
// process, or the same one after a lost reply, answers `ssam_task` from the files alone. A task keeps who ran it, a short
// summary, its state (running | ok | failed | uncertain), its times and a short result; never the user's words and never
// a full receipt (the kernel keeps those in its own task folder).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot } from './workspace.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';
import { o11LaneOf } from './o11-lane.mjs';

export const TASK_STATES = ['running', 'ok', 'failed', 'uncertain'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KERNEL_ID = /^[0-9a-f]{32}$/i; // a kernel delivery task id (work/deliver/<id>), answered through the task that ran it
// Hosted (executor.mjs), the default root means the customer's <ws>/o11/tasks.
export const tasksDir = (root = anvilRoot) => (usesWorkspace(root, anvilRoot) ? workspacePath('o11', 'tasks') : path.join(root, '.local', 'tasks'));

// Words never reach a task file, whatever the caller put in the summary.
const WORDS = new Set(['authorize', 'authorization', 'words']);
const scrub = value => Array.isArray(value) ? value.map(scrub)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => !WORDS.has(k)).map(([k, v]) => [k, scrub(v)]))
  : value;

function write(dir, task) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, task.id + '.json');
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(task, null, 2));
  fs.renameSync(temporary, file);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// A running task whose server process is gone never finished here: it says so instead of staying "running" forever.
const live = task => task.state === 'running' && Number.isInteger(task.pid) && task.pid !== process.pid && !alive(task.pid) ? { ...task, orphaned: true } : task;

export function readTask(id, { dir = tasksDir() } = {}) {
  if (!UUID.test(String(id))) return null;
  try { return live(JSON.parse(fs.readFileSync(path.join(dir, String(id).toLowerCase() + '.json'), 'utf8'))); }
  catch { return null; }
}

// Newest first by start time.
export function listTasks({ dir = tasksDir(), limit = 20, tool } = {}) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => /\.json$/i.test(n) && UUID.test(n.slice(0, -5))); } catch { return []; }
  return names.map(n => readTask(n.slice(0, -5), { dir })).filter(t => t && (!tool || t.tool === tool))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
}

export const stateOf = value => value?.ok === true ? 'ok' : value?.outcome === 'uncertain' ? 'uncertain' : 'failed';
const KEPT = ['result', 'valid', 'outcome', 'code', 'stage', 'taskId', 'writeState'];
// A refusal's record says what refused (VisitaCerta 2026-10-12: two VALIDATION_REFUSED records kept only "job rejected by
// validation contract"): the contract's summary and the problems, short (code and pointer or element, at most 10).
const brief = value => scrub({ ok: value?.ok === true, ...Object.fromEntries(KEPT.filter(k => value?.[k] != null).map(k => [k, value[k]])),
  ...(value?.error ? { error: String(value.error).slice(0, 300) } : {}),
  ...(value?.contract?.summary ? { contract: String(value.contract.summary).slice(0, 300) } : {}),
  ...(Array.isArray(value?.problems) && value.problems.length ? { problemsTotal: value.problems.length,
    problems: value.problems.slice(0, 10).map(p => [p?.code, p?.pointer ?? p?.element].filter(Boolean).join(' ').slice(0, 200)) } : {}) });

// Runs fn(task) and records it: `running` before, the state of its value after (ok:true -> ok, outcome 'uncertain' ->
// uncertain, anything else -> failed). An exception becomes {ok:false, error}, as every tool answer does.
export async function trackTask({ tool, summary = {}, dir = tasksDir(), now = () => new Date(), id = randomUUID() }, fn) {
  const task = { id, tool, summary: scrub(summary), pid: process.pid, startedAt: now().toISOString(), state: 'running' };
  write(dir, task);
  let value;
  try { value = await fn(task); } catch (error) { value = { ok: false, error: error.message }; }
  try { write(dir, { ...task, state: stateOf(value), endedAt: now().toISOString(), result: brief(value) }); }
  catch { /* the answer matters more than its record; the running record stays as evidence */ }
  return value;
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
  refused: id => ({ tool: 'ssam_task', arguments: { id, close: { reason: '<motivo>' } }, why: 'a entrega terminou recusada: fecha a tarefa no kernel e libera o módulo' }),
  uncertain: id => ({ tool: 'o11_deliver', arguments: { resume: id }, why: 'a escrita desta tarefa não foi confirmada: o resume reconcilia a mesma tarefa e nunca repete o merge' }),
  unsettled: id => ({ tool: 'o11_deliver', arguments: { resume: id }, why: 'enquanto a entrega roda, ela responde sozinha (o resume espera a vez dela na fila do Studio); se ela parou sem resposta, o resume reconcilia a mesma tarefa' }),
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
      ...(next ? { continuation: next } : { note: 'a tarefa já terminou (' + closeState + '); uma reserva que ela deixou é liberada por ssam_doctor {lane:"o11", release}' }) };
  }
  return null;
}

// The close of an uncertain delivery (C15): the kernel closes it only with the proof that nothing was applied (the live
// module captured now has exactly the bytes of the task's base snapshot) and never when the live module differs.
export const CLOSE_WITH_PROOF_WHY = 'Fecha a entrega incerta só com a prova de que nada foi aplicado (o módulo vivo igual à base capturada); '
  + 'com o módulo diferente ela continua incerta e nada é repetido. reason: o motivo, em uma linha.';
const closeContinuation = id => ({ tool: 'ssam_task', arguments: { id, close: { reason: '<motivo>' } }, why: CLOSE_WITH_PROOF_WHY });

// deps: tasksDir | root; close(kernelTaskId, reason, {signal}) -> answer (o11-cycle.mjs: `deliver --close` of the kernel,
// DeliveryTask.CloseKnownFailure, the same close o11_deliver {close} runs). Without close, ssam_task only reads.
export function registerSsamTask(server, deps = {}) {
  const dir = deps.tasksDir ?? tasksDir(deps.root ?? anvilRoot);
  server.registerTool('ssam_task', {
    title: 'State of long facade tasks',
    description: 'Long tasks of the facade (o11_deliver, o11_publish): id, tool, summary (never the user\'s words), state running | ok | failed | uncertain, '
      + 'startedAt/endedAt and a short result. id: the task id, or the kernel taskId of a delivery. Without id: the 20 most recent. '
      + 'orphaned:true means the server that ran it stopped before it ended. Reading never repeats anything. '
      + 'close {reason} with id closes that delivery task in the kernel and frees its module: a refused one, or an uncertain one only with '
      + 'the proof that nothing was applied (the live module equals the base the task captured); never when the live module differs.',
    inputSchema: z.object({
      id: z.string().regex(/^[0-9a-fA-F-]{32,36}$/).optional().describe('Task id (uuid) or a kernel delivery taskId (32 hex)'),
      close: z.object({ reason: z.string().trim().min(1).max(500) }).strict().optional().describe('With id: close that delivery task (see the description)'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ id, close } = {}, extra) => {
    try {
      if (close) {
        if (!id) return reply({ ok: false, code: 'BAD_ARGS', error: 'close needs the id of the delivery task', continuation: { tool: 'ssam_task', arguments: {}, why: 'Lists the recent tasks and their ids.' } });
        const kernelId = KERNEL_ID.test(id) ? id.toLowerCase() : readTask(id, { dir })?.result?.taskId ?? null;
        if (!kernelId || !KERNEL_ID.test(kernelId)) return reply({ ok: false, code: 'CLOSE_TASK_NOT_FOUND', error: 'No delivery task ' + id + ' to close',
          continuation: { tool: 'ssam_task', arguments: {}, why: 'Lists the recent tasks and their kernel taskId.' } });
        if (typeof deps.close !== 'function') return reply({ ok: false, code: 'CLOSE_UNAVAILABLE', error: 'This server does not serve the O11 delivery close.',
          continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Shows the O11 lane of this server.' } });
        return reply(await deps.close(kernelId, close.reason, { signal: extra?.signal }));
      }
      if (!id) return reply({ ok: true, tasks: listTasks({ dir }) });
      const task = KERNEL_ID.test(id) ? listTasks({ dir, limit: 500 }).find(t => t.result?.taskId?.toLowerCase() === id.toLowerCase()) : readTask(id, { dir });
      if (!task && KERNEL_ID.test(id)) {
        const kernel = await kernelTaskAnswer(id.toLowerCase(), { root: deps.root ?? anvilRoot, works: deps.works, findTask: deps.findTask, closeStateOf: deps.closeState });
        if (kernel) return reply(kernel);
      }
      if (!task) return reply({ ok: false, code: 'TASK_NOT_FOUND', error: 'No task ' + id,
        continuation: { tool: 'ssam_task', arguments: {}, why: 'Lists the recent tasks and their ids.' } });
      const kernelId = task.result?.taskId;
      return reply({ ok: true, task, ...(task.state === 'uncertain' && typeof kernelId === 'string' && KERNEL_ID.test(kernelId) && typeof deps.close === 'function'
        ? { continuation: closeContinuation(kernelId) } : {}) });
    } catch (error) { return reply({ ok: false, error: error.message }); }
  });
}

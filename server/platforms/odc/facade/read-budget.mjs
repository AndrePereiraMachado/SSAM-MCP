// One wall-clock budget for discovery/auth/queue/transport. A timeout is not proof of remote cancellation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
const scope = new AsyncLocalStorage();
const pending = new Map();
export function readCheckpoint(stage = 'transport') {
  const state = scope.getStore();
  if (!state) return;
  state.stage = stage;
  if (state.controller.signal.aborted) throw Object.assign(new Error('Read budget expired; no further request was sent.'), { code: 'READ_DEADLINE_EXCEEDED', stage });
}
export function readOptions(stage = 'transport') {
  readCheckpoint(stage);
  const state = scope.getStore();
  return state ? { signal: state.controller.signal, timeoutMs: Math.max(1, state.deadline - Date.now()) } : {};
}
export async function boundedRead(key, work, { timeoutMs = 29000 } = {}) {
  if (scope.getStore()) { readCheckpoint(); return work(); }
  const serialized = typeof key === 'string' ? key : JSON.stringify(key, (_name, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
  const fingerprint = createHash('sha256').update(serialized).digest('hex');
  // Retain timed-out work to prevent another authentication/send while its outcome is still unobserved.
  for (const [k, entry] of pending) if (entry.settled && Date.now() - entry.finishedAt > 300000) pending.delete(k);
  let state = pending.get(fingerprint);
  if (state) {
    if (state.settled) { pending.delete(fingerprint); return state.result; }
    return state.timedOut ? timeoutAnswer(state) : state.answer;
  }
  if (pending.size >= 128) return { ok: false, code: 'READ_PENDING_LIMIT', stage: 'queue', error: 'Too many unobserved reads; reconcile the pending calls before starting more.' };
  state = { id: randomUUID(), startedAt: Date.now(), deadline: Date.now() + Math.min(120000, Math.max(1, timeoutMs)), stage: 'preflight', controller: new AbortController(), timedOut: false };
  pending.set(fingerprint, state);
  let timer;
  // Defer work until the shared answer is installed: simultaneous callers join
  // the same authentication/request even before its first deadline expires.
  const task = Promise.resolve().then(() => scope.run(state, async () => {
    try { return await work(); }
    catch (error) { return { ok: false, code: error.code ?? 'READ_LOCAL_FAILURE', stage: state.stage,
      error: error.code === 'READ_DEADLINE_EXCEEDED' ? error.message : 'Read failed locally; no raw exception was exposed.' }; }
  })).then(result => { state.settled = true; state.result = result; state.finishedAt = Date.now();
    if (!state.timedOut && pending.get(fingerprint) === state) pending.delete(fingerprint);
    return result; });
  const elapsed = new Promise(resolve => { timer = setTimeout(() => {
    state.timedOut = true; state.controller.abort(); resolve(timeoutAnswer(state));
  }, Math.max(1, state.deadline - Date.now())); });
  state.answer = Promise.race([task, elapsed]).finally(() => clearTimeout(timer));
  return state.answer;
}
function timeoutAnswer(state) {
  return { ok: false, code: 'READ_DEADLINE_EXCEEDED', stage: state.stage, error: 'The read budget expired. Remote cancellation is not confirmed; the same call checks the pending result without resending it.',
    operationId: state.id, resumable: true, remoteCancellationConfirmed: false, elapsedMs: Date.now() - state.startedAt };
}

// One wall-clock budget for discovery/auth/queue/transport. A timeout is not proof of remote cancellation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { hostedContext } from './executor.mjs';
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
export const canonicalArguments = key => typeof key === 'string' ? key : JSON.stringify(key, (_name, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
export async function boundedRead(key, work, { timeoutMs = 29000 } = {}) {
  if (scope.getStore()) { readCheckpoint(); return work(); }
  // X1: a hosted process serves many customers and `pending` is the process's. A read joins (in flight) or is found again
  // (its timed-out outcome, the continuation of the same call) only by the caller that started it: its token and that
  // token's hosted context (one per token: one agent link, credential and tenant; a new context after the link closes).
  // Outside a hosted context the caller is null and the key is the arguments alone, as before.
  const caller = hostedContext();
  const serialized = canonicalArguments(caller ? { caller: { token: caller.tokenId, context: caller.id ?? null }, key } : key);
  const fingerprint = createHash('sha256').update(serialized).digest('hex');
  // Retain timed-out work to prevent another authentication/send while its outcome is still unobserved.
  for (const [k, entry] of pending) if (entry.settled && Date.now() - entry.finishedAt > 300000) pending.delete(k);
  let state = pending.get(fingerprint);
  if (state) {
    if (state.settled) { pending.delete(fingerprint); return state.result; }
    return state.timedOut ? timeoutAnswer(state) : state.answer;
  }
  // X1d: the limit of unobserved reads is each caller's (128, as before), so one customer's retained reads never refuse
  // another's; the process keeps a higher ceiling of its own. Outside a hosted context the caller is one (null): unchanged.
  const owner = caller ? caller.tokenId + '\u0000' + (caller.id ?? '') : null;
  let owned = 0;
  for (const entry of pending.values()) if (entry.owner === owner) owned++;
  if (owned >= 128 || pending.size >= 1024) return { ok: false, code: 'READ_PENDING_LIMIT', stage: 'queue', error: 'Too many unobserved reads; reconcile the pending calls before starting more.' };
  state = { id: randomUUID(), owner, startedAt: Date.now(), deadline: Date.now() + Math.min(120000, Math.max(1, timeoutMs)), stage: 'preflight', controller: new AbortController(), timedOut: false };
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

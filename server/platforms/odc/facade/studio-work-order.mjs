// Pending merges are intent records, not locks. Publications wait for them; builds never wait for publications.
// The records also cover another facade process attached to the same Studio authority.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const own = new Set();
export const INTENT_GRACE_MS = 30000;
const matches = (a, b) => a.dir === b.dir && a.lane === b.lane && (!a.id || !b.id || a.id === b.id)
  && (!a.module || !b.module || (a.module.key && b.module.key ? a.module.key === b.module.key : a.module.name === b.module.name));
const live = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function pendingMerge(target) {
  const record = { ...target, pid: process.pid, token: randomUUID(), at: Date.now() };
  own.add(record);
  const file = path.join(target.dir, `merge-${record.token}.intent`);
  try { fs.mkdirSync(target.dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx' }); } catch { /* local ordering still works */ }
  return () => { own.delete(record); try { fs.unlinkSync(file); } catch { /* already removed */ } };
}

export function hasPendingMerge(target) {
  if ([...own].some(row => matches(row, target))) return true;
  let names; try { names = fs.readdirSync(target.dir); } catch { return false; }
  for (const name of names.filter(n => /^merge-[\w-]+\.intent$/.test(n))) {
    const file = path.join(target.dir, name);
    try {
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (row.pid === process.pid ? ![...own].some(r => r.token === row.token) : !live(row.pid)) { fs.unlinkSync(file); continue; }
      if (matches(row, target)) return true;
    } catch {
      // A young unreadable record may still be being written. Match the lock creation grace period.
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > INTENT_GRACE_MS) { fs.unlinkSync(file); continue; }
      } catch (error) { if (error.code === 'ENOENT') continue; }
      return true;
    }
  }
  return false;
}

// A batch accepts callers only before its lock is acquired. No completed or uncertain result is cached/replayed.
const publications = new Map();
export function coalescePublication(key, execute, { signal } = {}) {
  if (!key) return execute(() => {}, signal);
  let batch = publications.get(key);
  if (!batch) {
    batch = { callers: [], controller: new AbortController(), started: false };
    publications.set(key, batch);
    // Let all synchronous callers join before dispatch; the real wait is the ordinary Studio queue.
    queueMicrotask(async () => {
      const started = () => { batch.started = true; if (publications.get(key) === batch) publications.delete(key); };
      try {
        const result = await execute(started, batch.controller.signal);
        const count = batch.callers.length;
        const value = count > 1 && result && typeof result === 'object'
          ? { ...result, coalesced: count, note: `coalesced with ${count} requests` } : result;
        for (const caller of batch.callers) caller.resolve(value);
      } catch (error) { for (const caller of batch.callers) caller.reject(error); }
      finally { started(); for (const caller of batch.callers) caller.cleanup(); }
    });
  }
  return new Promise((resolve, reject) => {
    const caller = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
    const cancel = () => {
      // Once sent, a sole caller keeps its cancellation contract. Never abort another caller's active publish.
      if (batch.started) {
        if (batch.callers.length === 1) batch.controller.abort();
        return;
      }
      batch.callers = batch.callers.filter(c => c !== caller);
      caller.cleanup(); resolve({ ok: false, code: 'CANCELLED', outcome: 'not-sent', error: 'The publication was cancelled before it started.' });
      if (!batch.callers.length) { batch.controller.abort(); if (publications.get(key) === batch) publications.delete(key); }
    };
    batch.callers.push(caller);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

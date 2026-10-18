// The build pool of the deliveries (lane wp of the atritos 3 package; the owner's OML writer pool, 2026-10-07). The BUILD
// phase of a delivery (studio-write-lock.mjs "Build and apply phases": the kernel apply and the ODC builder, headless)
// runs in one of SSAM_BUILD_WORKERS slots (default min(4, cores - 1), at least 1), never under the Studio lock.
//
// - Slots. One file per slot, <dir>/slot-<i>.lock, created exclusively with {schema, pid, startedAt, customer, token}
//   (a customer is kept as the sha256 of its key, never the key), so the SSAM processes of one machine share the
//   slots. A slot is stale when its process is dead, when it is older than staleMs (3 h), or when it carries this
//   process's pid without being held here; a stale slot is taken over. Each slot has its private folder
//   <dir>/slot-<i>/tmp, given to the build as TEMP and TMP (slot.env): two builds never share a temporary folder.
// - Queue. A build that finds every slot busy WAITS its turn, at most SSAM_BUILD_QUEUE_MS (else SSAM_WRITE_QUEUE_MS, else
//   240000), and then runs; the call is told queue {position, waitedMs} (onQueued), as the write queue does. Only a
//   wait that runs out refuses: BUILD_QUEUE_TIMEOUT (a BuildQueueRefused error carrying the refusal), nothing of the
//   build ran. A cancelled call (signal) leaves the queue: CANCELLED, not-sent.
// - Fairness. In this process (the hosted server serves its customers from one process), the next free slot goes to
//   the customer with the fewest builds running, then to the one served least recently, then first come first served
//   within a customer: a customer with ten builds queued never holds back another customer's single build for ten
//   turns. Between processes, a free slot goes to whichever process looks first (25 to 400 ms naps, an in-process wake on
//   every release).
// - A build inside the apply phase (the call already holds its Studio: a rebase) never queues: it runs at once in a
//   private folder of its own, so a Studio is never held waiting behind other customers' builds.
// - A slot folder that cannot be written keeps the pool in this process only (the Map below), never a refusal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { phaseOfCall, notePhase, processAlive, CANCELLED_CODE } from './studio-write-lock.mjs';

export const BUILD_QUEUE_TIMEOUT_CODE = 'BUILD_QUEUE_TIMEOUT';
export const SLOT_SCHEMA = 'ssam-build-slot/1';
export const DEFAULT_BUILD_QUEUE_MS = 240000;
const STALE_MS = 3 * 60 * 60 * 1000;
const GRACE_MS = 30000;
const NAP_FIRST = 25, NAP_MAX = 400;

const cores = () => { try { return os.availableParallelism?.() ?? os.cpus().length; } catch { return 2; } };
// SSAM_BUILD_WORKERS (an integer from 1 to 64), else min(4, cores - 1), at least 1.
export function buildWorkers(env = process.env, count = cores()) {
  const n = Number(String(env?.SSAM_BUILD_WORKERS ?? '').trim());
  if (String(env?.SSAM_BUILD_WORKERS ?? '').trim() !== '' && Number.isInteger(n) && n >= 1) return Math.min(n, 64);
  return Math.max(1, Math.min(4, (Number.isFinite(count) ? count : 2) - 1));
}
// SSAM_BUILD_QUEUE_MS (ms, 0 = no wait), else SSAM_WRITE_QUEUE_MS, else 240000.
export function buildQueueMs(env = process.env) {
  for (const raw of [env?.SSAM_BUILD_QUEUE_MS, env?.SSAM_WRITE_QUEUE_MS]) {
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_BUILD_QUEUE_MS;
}

export const BUILD_WHY = 'the build pool of this machine stayed busy past the limit; none of this delivery ran: the doctor shows the lane, and the same delivery may be repeated';
export class BuildQueueRefused extends Error {
  constructor(refusal) { super(refusal.error); this.name = 'BuildQueueRefused'; this.code = refusal.code; this.refusal = refusal; }
}
export function buildQueueRefusal({ position = 1, waitedMs = 0, queueMs = DEFAULT_BUILD_QUEUE_MS, size = 1, lane = 'o11' } = {}) {
  return { ok: false, code: BUILD_QUEUE_TIMEOUT_CODE, outcome: 'not-sent', waitedFor: 'pool',
    error: 'This delivery waited ' + Math.round(waitedMs / 1000) + ' s for one of the ' + size + ' build workers and its turn did not come; nothing of it ran.',
    position, waitedMs, queueMs, workers: size, continuation: { tool: 'ssam_doctor', arguments: { lane: lane === 'odc' ? 'odc' : 'o11' }, why: BUILD_WHY } };
}

const tagOf = value => createHash('sha256').update(String(value ?? '').toLowerCase()).digest('hex').slice(0, 16);
function readSlot(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { mtimeMs } = fs.statSync(file);
    let record = null; try { record = JSON.parse(raw); } catch { record = null; }
    return { raw, record: record && typeof record === 'object' ? record : null, mtimeMs };
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

// createBuildPool({dir, size, queueMs, now, alive, staleMs}) -> {size, dir, run(meta, fn), stats()}.
// run({customer, signal, onQueued, label}, fn(slot)) resolves to fn's value; slot = {index, tmp, env:{TEMP, TMP}}.
// Throws BuildQueueRefused when the wait runs out or the signal aborts it.
export function createBuildPool({ dir, size = buildWorkers(), queueMs = buildQueueMs(), now = Date.now, alive = processAlive, staleMs = STALE_MS } = {}) {
  if (!dir) throw new Error('createBuildPool needs dir');
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const held = new Map();     // slot index -> {token, customer}
  const waiting = [];         // {customer, arrived, wake}
  const served = new Map();   // customer -> last start (ms)
  let arrivals = 0;
  const running = customer => [...held.values()].filter(h => h.customer === customer).length;
  const slotFile = i => path.join(dir, 'slot-' + i + '.lock');
  const slotOf = i => {
    const tmp = path.join(dir, 'slot-' + i, 'tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* the build gets the folder name; it creates it or fails visibly */ }
    return { index: i, tmp, env: { TEMP: tmp, TMP: tmp } };
  };
  const stale = (lock, i) => {
    const r = lock.record;
    if (!r || !Number.isSafeInteger(r.pid)) return Date.now() - lock.mtimeMs > GRACE_MS;
    if (r.pid === process.pid) return held.get(i)?.token !== r.token;
    if (!alive(r.pid)) return true;
    const started = Date.parse(r.startedAt);
    return Number.isFinite(started) ? now() - started > staleMs : Date.now() - lock.mtimeMs > staleMs;
  };
  // Takes a free slot for customer: its index, or -1.
  const takeSlot = customer => {
    for (let i = 0; i < size; i++) {
      if (held.has(i)) continue;
      const token = randomUUID();
      const record = { schema: SLOT_SCHEMA, pid: process.pid, startedAt: new Date(now()).toISOString(), customer: tagOf(customer), token };
      held.set(i, { token, customer });
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = slotFile(i);
        let fd = null;
        try { fd = fs.openSync(file, 'wx'); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        if (fd == null) {
          const lock = readSlot(file);
          if (lock && !stale(lock, i)) { held.delete(i); continue; }
          try { if (lock && readSlot(file)?.raw === lock.raw) fs.unlinkSync(file); } catch { /* raced */ }
          try { fd = fs.openSync(file, 'wx'); } catch { held.delete(i); continue; }
        }
        try { fs.writeSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
      } catch { /* the folder cannot be written: this process's Map still bounds its own builds */ }
      return i;
    }
    return -1;
  };
  const freeSlot = i => {
    const mine = held.get(i);
    held.delete(i);
    try { const lock = readSlot(slotFile(i)); if (lock?.record?.token === mine?.token) fs.unlinkSync(slotFile(i)); } catch { /* best effort */ }
    bus.emit('change');
  };
  // The waiter whose turn it is: fewest running, then least recently served, then arrival.
  const nextWaiter = () => waiting.slice().sort((a, b) => running(a.customer) - running(b.customer)
    || (served.get(a.customer) ?? -Infinity) - (served.get(b.customer) ?? -Infinity) || a.arrived - b.arrived)[0] ?? null;
  async function run({ customer = 'local', signal, onQueued } = {}, fn) {
    const key = String(customer);
    const me = { customer: key, arrived: ++arrivals };
    const started = Date.now();
    let index = waiting.length ? -1 : takeSlot(key);
    let queue = null;
    if (index < 0) {
      waiting.push(me);
      const position = waiting.length; // this build's place in the line (1 = next), as the write queue counts it
      let step = NAP_FIRST;
      try {
        for (;;) {
          if (signal?.aborted) throw new BuildQueueRefused({ ok: false, code: CANCELLED_CODE, outcome: 'not-sent', error: 'The call was cancelled while it waited for a build worker; nothing ran.',
            position, waitedMs: Date.now() - started });
          if (nextWaiter() === me) { index = takeSlot(key); if (index >= 0) break; }
          const left = started + queueMs - Date.now();
          if (left <= 0) throw new BuildQueueRefused(buildQueueRefusal({ position, waitedMs: Date.now() - started, queueMs, size }));
          await new Promise(resolve => {
            let timer = null;
            const done = () => { clearTimeout(timer); bus.off('change', done); signal?.removeEventListener?.('abort', done); resolve(); };
            timer = setTimeout(done, Math.min(step, left)); bus.on('change', done); signal?.addEventListener?.('abort', done, { once: true });
          });
          step = Math.min(step * 2, NAP_MAX);
        }
      } finally { const at = waiting.indexOf(me); if (at >= 0) waiting.splice(at, 1); bus.emit('change'); }
      queue = { position, waitedMs: Date.now() - started };
      try { onQueued?.(queue); } catch { /* a notification never changes the build */ }
    }
    served.set(key, now());
    try { return await fn(slotOf(index), queue); } finally { freeSlot(index); }
  }
  return { size, dir, queueMs, run, stats: () => ({ size, running: [...held.entries()].map(([slot, h]) => ({ slot, customer: tagOf(h.customer) })), waiting: waiting.length }) };
}

// The resident worker of a slot (the convention of kernel/scripts/worker_pool.py): slot 0 is the lane's own worker, slot i
// listens on base + i * poolStep (workers.poolStep of .ssam-workspace.json, else 10). Each worker keeps its Studio
// assemblies loaded and its own base cache (BaseModelCache), so a slot builds warm.
export function slotWorkerPort(base, index, { workspace } = {}) {
  let step = 10;
  try { const n = JSON.parse(fs.readFileSync(path.join(workspace ?? process.cwd(), '.ssam-workspace.json'), 'utf8').replace(/^﻿/, '')).workers?.poolStep; if (Number.isInteger(n) && n > 0) step = n; }
  catch { /* the default step */ }
  return Number.isInteger(index) && index > 0 ? base + index * step : base;
}

// One pool per folder and size in this process (every MCP server of the process shares it).
const pools = new Map();
export function sharedBuildPool({ root, env = process.env, dir } = {}) {
  const folder = path.resolve(dir ?? env.SSAM_BUILD_POOL_DIR ?? path.join(root ?? os.tmpdir(), '.local', 'build-pool'));
  const size = buildWorkers(env);
  const key = folder.toLowerCase() + '|' + size;
  if (!pools.has(key)) pools.set(key, createBuildPool({ dir: folder, size, queueMs: buildQueueMs(env) }));
  return pools.get(key);
}

// A build of the current call: in the pool during the build phase (the wait goes to the call's phases), at once in a
// private folder when the call already holds its Studio (a rebase inside the apply). fn(slot) -> value.
export async function pooledBuild({ pool, customer, signal, privateDir } = {}, fn) {
  const phase = phaseOfCall();
  if (!pool || phase?.promoted) {
    const tmp = path.join(privateDir ?? pool?.dir ?? os.tmpdir(), 'apply-' + process.pid + '-' + randomUUID().slice(0, 8));
    try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* see slotOf */ }
    try { return await fn({ index: null, tmp, env: { TEMP: tmp, TMP: tmp } }); }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  const started = Date.now();
  return pool.run({ customer, signal, onQueued: queue => notePhase({ buildQueue: queue }) }, async slot => {
    notePhase({ poolWaitMs: Date.now() - started });
    return fn(slot);
  });
}

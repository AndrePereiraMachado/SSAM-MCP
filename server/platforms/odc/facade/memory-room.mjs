// Memory admission of the kernel processes of one server (capacity review R2 M2, 2026-11-09: C:/t/r5/capacity/REVISAO-R2.md).
// A hosted backend runs in a container whose cgroup has a memory limit (the Coolify compose: 10g hot, 4g other). The host's
// MemAvailable (/proc/meminfo, the host's even in a container) shows ~25 GB free while the container is near its own limit,
// so a guard that reads it never sees an OOM coming; an OOM kill of a worker in a call leaves the delivery's outcome unknown.
// The room of this server is therefore the smaller of:
//   - the host's MemAvailable, and
//   - the container's limit minus what it uses: /sys/fs/cgroup/memory.max minus (memory.current minus inactive_file of
//     memory.stat, the page cache the kernel reclaims before it kills); "max" (no limit) or unreadable is no bound.
// Unreadable both ways (Windows, a developer machine): null, and nothing is decided by memory.
//
// The gate (createMemoryGate, one per process: memoryGate()) admits a kernel process only when the room, minus what the
// processes it admitted have not shown yet, keeps the reserve the new one needs (SSAM_MEMORY_RESERVE_MB, default 1400: the
// measured peak of a 100-action O11 build, 1.33 GB; SSAM_MEMORY_RESERVE_ODC_MB, default 600, ODC peaks at ~0.45 GB; 0 is off).
// What an admitted process has not shown yet: its reserve minus its resident set (VmRSS of the pid it attached, read at each
// decision), or its whole reserve for its first SSAM_MEMORY_GROW_MS (default 15 s) when no pid is attached (a call on a
// resident worker). Every other process, the resident workers included, is in memory.current already.
//   - The only admitted process of the server is always admitted (nothing it waits for would free memory: progress).
//   - A waiting call naps (50 ms doubling to 500 ms, woken by every release) at most SSAM_MEMORY_WAIT_MS (default 120 s);
//     when the wait runs out it is REFUSED, nothing sent (memoryWaitRefusal: BUILD_QUEUE_TIMEOUT, outcome not-sent,
//     waitedFor memory, the build pool's own refusal). Running it anyway would hand the OOM the cgroup measured for two
//     minutes to the largest process, most often another customer's worker in a call: one customer's delay would become
//     another's uncertain outcome (review R3 M2). No deadlock: the only admitted process always starts.
//   The gate is code of the server image: it holds only in images built from e04cfb7 or later (review R3 A2).
//   - run(hold, fn): fn and everything it awaits run as admitted (AsyncLocalStorage): a cold process started inside a
//     build-pool slot attaches its pid to the slot's hold instead of waiting a second time.
//   - Standing holds (S1 R3, C:\t\r5\janela-4x4\S1-KIT-PLANO.md 0): a resident process that outlives the call that started it
//     (the ODC lane worker, anvil-worker.mjs) keeps its hold while it lives: admit(mb, {standing: true}) and attach(pid). What
//     it has not shown yet is its reserve (the measured peak, SSAM_MEMORY_RESERVE_ODC_WORKER_MB, default 2150: VmHWM 2116 MiB
//     on v5 2026-11-09) minus its resident set, i.e. its growth still to come (~620 MiB from a 1498 MiB RSS), counted in every
//     later decision; it counts as an admitted process (a lone build no longer passes without the room the worker may still
//     take). The hold goes when its process does: release() on exit, or the first decision that finds no resident set for it
//     (its process is gone). SSAM_MEMORY_WORKER_WAIT_MS (default 15 s): how long a resident worker's start waits for room
//     before its caller runs the command cold instead (a cold process, admitted with its own smaller reserve).
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

const MB = 1024 * 1024;
export const DEFAULT_MEMORY_RESERVE_MB = 1400;
export const DEFAULT_MEMORY_RESERVE_ODC_MB = 600;
export const DEFAULT_MEMORY_WAIT_MS = 120000;
export const DEFAULT_MEMORY_GROW_MS = 15000;
export const DEFAULT_MEMORY_RESERVE_ODC_WORKER_MB = 2150;
export const DEFAULT_MEMORY_WORKER_WAIT_MS = 15000;
export const MEMORY_WAIT_CODE = 'BUILD_QUEUE_TIMEOUT';
export const MEMORY_WAIT_WHY = 'this server stayed short of the memory a kernel process needs past the limit; none of this call ran: the doctor shows the lane, and the same call may be repeated';

// The refusal of a call whose wait for memory ran out (the build pool's BUILD_QUEUE_TIMEOUT, waitedFor memory): nothing ran.
export function memoryWaitRefusal({ waitedMs = 0, lane = 'o11', position = 1, queueMs = DEFAULT_MEMORY_WAIT_MS, workers = undefined, what = 'delivery' } = {}) {
  return { ok: false, code: MEMORY_WAIT_CODE, outcome: 'not-sent', waitedFor: 'memory',
    error: 'This ' + what + ' waited ' + Math.round(waitedMs / 1000) + ' s for the memory its ' + (what === 'delivery' ? 'build' : 'kernel process') + ' needs on this server (the processes already running hold it) and its turn did not come; nothing of it ran.',
    position, waitedMs, queueMs, ...(workers !== undefined ? { workers } : {}),
    continuation: { tool: 'ssam_doctor', arguments: { lane: lane === 'odc' ? 'odc' : 'o11' }, why: MEMORY_WAIT_WHY } };
}

// The host's MemAvailable in MB, or null (not Linux, unreadable).
export function hostAvailableMb({ platform = process.platform, readFile = fs.readFileSync } = {}) {
  if (platform !== 'linux') return null;
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFile('/proc/meminfo', 'utf8'));
    return match ? Math.round(Number(match[1]) / 1024) : null;
  } catch { return null; }
}
// The container's free memory under its cgroup v2 limit in MB, or null (no limit, not Linux, unreadable).
export function containerRoomMb({ platform = process.platform, readFile = fs.readFileSync, root = '/sys/fs/cgroup' } = {}) {
  if (platform !== 'linux') return null;
  try {
    const max = String(readFile(root + '/memory.max', 'utf8')).trim();
    if (!/^\d+$/.test(max)) return null;
    const current = Number(String(readFile(root + '/memory.current', 'utf8')).trim());
    if (!Number.isFinite(current)) return null;
    let inactive = 0;
    try { const m = /^inactive_file (\d+)$/m.exec(readFile(root + '/memory.stat', 'utf8')); if (m) inactive = Number(m[1]); } catch { /* no reclaim credit */ }
    return Math.floor((Number(max) - Math.max(0, current - inactive)) / MB);
  } catch { return null; }
}
// The room of this server: the smaller of the two that can be read, or null.
export function roomMb(deps = {}) {
  const values = [hostAvailableMb(deps), containerRoomMb(deps)].filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}
// VmRSS of a pid in MB, or null.
export function processRssMb(pid, { platform = process.platform, readFile = fs.readFileSync } = {}) {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try { const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFile(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(Number(m[1]) / 1024) : null; }
  catch { return null; }
}
const setting = (value, fallback, min = 0) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
};
export function memorySettings(env = process.env) {
  return {
    reserveMb: setting(env.SSAM_MEMORY_RESERVE_MB, DEFAULT_MEMORY_RESERVE_MB),
    odcReserveMb: setting(env.SSAM_MEMORY_RESERVE_ODC_MB, DEFAULT_MEMORY_RESERVE_ODC_MB),
    waitMs: setting(env.SSAM_MEMORY_WAIT_MS, DEFAULT_MEMORY_WAIT_MS),
    growMs: setting(env.SSAM_MEMORY_GROW_MS, DEFAULT_MEMORY_GROW_MS),
    odcWorkerReserveMb: setting(env.SSAM_MEMORY_RESERVE_ODC_WORKER_MB, DEFAULT_MEMORY_RESERVE_ODC_WORKER_MB),
    workerWaitMs: setting(env.SSAM_MEMORY_WORKER_WAIT_MS, DEFAULT_MEMORY_WORKER_WAIT_MS),
  };
}

export function createMemoryGate({ room = () => roomMb(), rssOf = pid => processRssMb(pid), now = Date.now, settings = memorySettings({}) } = {}) {
  const holds = new Set();
  const extra = new Set(); // other pending providers (the hosted workers' growth still to come)
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const store = new AsyncLocalStorage();
  const shownLater = h => {
    if (h.pid) {
      let rss = null; try { rss = rssOf(h.pid); } catch { rss = null; }
      // A standing hold whose process shows no resident set any more: the process is gone, and so is its hold.
      if (h.standing && !Number.isFinite(rss)) { h.release(); return 0; }
      return Math.max(0, h.mb - (Number.isFinite(rss) ? rss : 0));
    }
    return now() - h.at < settings.growMs ? h.mb : 0;
  };
  // What the admitted processes (and the registered providers) have not shown in memory yet, in MB.
  const pendingMb = ({ others = true } = {}) => {
    let total = 0;
    for (const h of [...holds]) total += shownLater(h);
    if (others) for (const f of extra) { try { const v = f(); if (Number.isFinite(v) && v > 0) total += v; } catch { /* a provider decides nothing */ } }
    return total;
  };
  // null when mb may start now, else the room it would find.
  const shortOf = mb => {
    if (!(mb > 0) || holds.size === 0) return null;
    let r = null; try { r = room(); } catch { r = null; }
    if (!Number.isFinite(r)) return null;
    const left = r - pendingMb();
    return left >= mb ? null : left;
  };
  function hold(mb, { standing = false } = {}) {
    const h = { mb: Math.max(0, mb | 0), at: now(), pid: null, standing: standing === true,
      attach(pid) { if (Number.isInteger(pid) && pid > 0) h.pid = pid; },
      // The process attached ended: its memory is gone, nothing is pending for it until the next one attaches.
      detach() { h.pid = null; h.at = -Infinity; },
      release() { h.released = true; if (holds.delete(h)) bus.emit('change'); } };
    holds.add(h);
    return h;
  }
  // Waits for the room mb needs (at most waitMs), then holds it: {hold, waitedMs, timedOut: false}; a wait that runs out
  // holds nothing: {hold: null, waitedMs, timedOut: true, shortMb} and the caller refuses (memoryWaitRefusal).
  async function admit(mb, { waitMs = settings.waitMs, standing = false } = {}) {
    const started = now();
    let step = 50, short = shortOf(mb), timedOut = false;
    while (short !== null) {
      const left = started + waitMs - now();
      if (left <= 0) { timedOut = true; break; }
      await new Promise(resolve => {
        let timer = null;
        const done = () => { clearTimeout(timer); bus.off('change', done); resolve(); };
        timer = setTimeout(done, Math.min(step, left)); bus.on('change', done);
      });
      step = Math.min(step * 2, 500);
      short = shortOf(mb);
    }
    if (timedOut) return { hold: null, waitedMs: now() - started, timedOut, shortMb: short };
    return { hold: hold(mb, { standing }), waitedMs: now() - started, timedOut };
  }
  return {
    settings, pendingMb, fits: mb => shortOf(mb) === null, hold, admit,
    run: (h, fn) => store.run(h, fn), current: () => store.getStore() ?? null,
    addPending(fn) { extra.add(fn); return () => extra.delete(fn); },
    onChange(fn) { bus.on('change', fn); return () => bus.off('change', fn); },
    stats: () => { const pending = pendingMb(), standing = [...holds].filter(h => h.standing).length; return { admitted: holds.size, ...(standing ? { standing } : {}), pendingMb: pending }; },
  };
}

let processGate = null;
// The gate of this process, with the settings of its environment.
export function memoryGate() {
  if (!processGate) processGate = createMemoryGate({ settings: memorySettings(process.env) });
  return processGate;
}

// servidor/fase4-26 a8 (review of feat/ssam-code-hosted, M2): the checks of ssam_code on a hosted server. A check is a cold
// apply of the kernel (one dotnet process, seconds to minutes of CPU); a plan hands each of up to 8 subagents a check, and
// every customer shares the few CPUs of the server's container. So:
//   ceilings   at most perCustomer checks of one customer run at once and at most global checks of the whole server
//              (checkCeilings: SSAM_CODE_CHECKS and SSAM_CODE_CHECKS_PER_CUSTOMER, else the container's CPUs less one, from
//              1 to 4, and 2 per customer, never above the server's); the others wait in ONE queue in the order they came,
//              and a customer at its own ceiling never holds the queue for another (checkSlots)
//   candidates a check writes <lane folder>/jobs/check/<id>/{job.json, candidate.oml, candidate.oml.result.json, work/}; its
//              answer keeps the job (the base of a correction, nextBasedOn) and never the candidate, so candidate.oml (the
//              module rebuilt, megabytes), its result file and work/ are removed when the check ends; those an interrupted
//              check left are removed once older than CANDIDATE_MAX_AGE_MS (past the longest apply), at the next check or
//              plan of the customer (sweepCandidates). The candidates of a plan never pile up in the workspace quota.
// The folders are hosted/code.mjs's roots: <ws>/o11 (O11) and <ws>/odc/lab (ODC).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CANDIDATE_MAX_AGE_MS = 60 * 60000;
const SWEEP_EVERY_MS = 10 * 60000;
const CHECK_FOLDERS = Object.freeze([['o11', 'jobs', 'check'], ['odc', 'lab', 'jobs', 'check']]);
const CANDIDATE = 'candidate.oml';
const RESULT = 'candidate.oml.result.json'; // the kernel's whole result, read only by the check itself (its guidance)
const WORK = 'work';

/** The CPUs this process may use: the machine's, bounded by the container's cgroup quota (v2 cpu.max, v1 cfs). */
export function cpuCount({ read = file => fs.readFileSync(file, 'utf8') } = {}) {
  let cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const bound = (quota, period) => { if (quota > 0 && period > 0) cpus = Math.min(cpus, Math.ceil(quota / period)); };
  try { const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/); if (quota !== 'max') bound(Number(quota), Number(period)); } catch { /* not a cgroup v2 container */ }
  try { bound(Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')), Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'))); } catch { /* not a cgroup v1 container */ }
  return Math.max(1, cpus);
}

const positive = value => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; };
/** {global, perCustomer}: the owner's settings when they are positive integers, else from the CPUs (one left to the server). */
export function checkCeilings(env = process.env, cpus = cpuCount()) {
  const global = positive(env?.SSAM_CODE_CHECKS) ?? Math.max(1, Math.min(4, cpus - 1));
  return { global, perCustomer: Math.min(global, positive(env?.SSAM_CODE_CHECKS_PER_CUSTOMER) ?? 2) };
}

/** The slots of the checks: run(key, fn) runs fn once a slot of the server and one of the customer `key` are free. */
export function checkSlots({ global = 1, perCustomer = 1 } = {}) {
  const ceiling = Math.max(1, global), own = Math.max(1, Math.min(perCustomer, ceiling));
  const running = new Map();
  const waiting = [];
  let total = 0;
  const free = key => total < ceiling && (running.get(key) ?? 0) < own;
  const take = key => { total++; running.set(key, (running.get(key) ?? 0) + 1); };
  const pump = () => {
    for (let i = 0; i < waiting.length && total < ceiling;) {
      if (free(waiting[i].key)) { const [next] = waiting.splice(i, 1); take(next.key); next.resolve(); } else i++;
    }
  };
  const give = key => {
    total--;
    const left = (running.get(key) ?? 1) - 1;
    if (left > 0) running.set(key, left); else running.delete(key);
    pump();
  };
  return {
    async run(key, fn) {
      // first come, first served: a customer with a check already waiting goes behind it
      if (free(key) && !waiting.some(w => w.key === key)) take(key);
      else await new Promise(resolve => waiting.push({ key, resolve }));
      try { return await fn(); } finally { give(key); }
    },
    state: () => ({ running: total, waiting: waiting.length, byCustomer: Object.fromEntries(running) }),
    ceilings: () => ({ global: ceiling, perCustomer: own }),
  };
}
let shared = null;
/** The slots of this server process, from checkCeilings() at the first check. */
export const sharedCheckSlots = () => (shared ??= checkSlots(checkCeilings()));

const checkFolders = workspace => CHECK_FOLDERS.map(parts => path.join(path.resolve(workspace), ...parts));
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const remove = target => { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* the next sweep tries again */ } };
/** Removes the candidate and the work folder of the check whose job file is `job`, when it is a check of this workspace. */
export function discardCandidate(workspace, job) {
  if (typeof job !== 'string' || !path.isAbsolute(job)) return false;
  const dir = path.dirname(path.resolve(job));
  if (!checkFolders(workspace).some(folder => same(path.dirname(dir), folder))) return false;
  for (const name of [CANDIDATE, RESULT, WORK]) remove(path.join(dir, name));
  return true;
}
const swept = new Map();
/** Removes the candidates and work folders older than maxAgeMs of this workspace's checks (at most every 10 minutes). */
export function sweepCandidates(workspace, { now = Date.now(), maxAgeMs = CANDIDATE_MAX_AGE_MS, force = false } = {}) {
  const key = path.resolve(workspace);
  if (!force && now - (swept.get(key) ?? -Infinity) < SWEEP_EVERY_MS) return 0;
  swept.set(key, now);
  let removed = 0;
  for (const folder of checkFolders(workspace)) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of [CANDIDATE, RESULT, WORK]) {
        const target = path.join(folder, entry.name, name);
        let stat;
        try { stat = fs.lstatSync(target); } catch { continue; }
        if (now - stat.mtimeMs > maxAgeMs) { remove(target); removed++; }
      }
    }
  }
  return removed;
}

/** The ssam_code check of a hosted customer: the old candidates swept, a slot taken, the check run, its candidate removed. */
export function hostedCheck(context, check, { slots = null, now = () => Date.now(), maxAgeMs = CANDIDATE_MAX_AGE_MS } = {}) {
  const workspace = path.resolve(context.workspace);
  return async input => {
    sweepCandidates(workspace, { now: now(), maxAgeMs });
    return (slots ?? sharedCheckSlots()).run(workspace, async () => {
      const answer = await check(input);
      discardCandidate(workspace, answer?.job);
      return answer;
    });
  };
}

// Retention of a customer's workspace on the hosted server (r41). ONE module, used by the quota check (mirror.mjs
// createQuota: over the quota, one cleanup and a new walk before WORKSPACE_FULL) and by the periodic sweep of every backend
// (http-server.mjs, sweepCustomers). Four backends share /data/server, so a workspace is cleaned by one process at a time:
// <ws>/state/retention/sweep.lock (exclusive create; a lock older than lockStaleMs belongs to a process that died and is
// broken once; the holder re-reads it before each phase and stops when it is no longer its own).
//
// What it removes (every removal is one line of <ws>/state/retention/journal.jsonl: relative names and bytes, never a
// file's content):
//   - core dumps anywhere: a file named core, core.<digits> or coredump.<digits>, or *.dmp/*.mdmp, whose first bytes are an
//     ELF core (e_type 4) or a minidump (MDMP); a user file with such a name and other content stays;
//   - scratch older than scratchDays (default 3): the entries of <lane>/journal/staging (content-named copies, written again
//     when needed), of <lane>/tmp/versions/<backend> (the TEMP of the kernel processes; <lane>/tmp/o11-worker, the worker's
//     own folder, is never touched), and of state[/versions/<backend>]/{checks, builds,
//     verified/candidate, verified/patch, transfers} (private build artifacts that expire after 1 h by their own rule, and
//     agent uploads that never finished);
//   - the bulk of a FINISHED O11 delivery task older than scratchDays (o11/work/deliver/<id>/attempt-*, its .oml files,
//     runtime-producers/): finished = closed, or delivered and not the newest delivered of its module (review R41 F2: a
//     task with a known failure may still be repaired or resumed, and a resume re-hashes its artifacts, so it stays whole).
//     task.json, result.json and producers/ (the signatures a resume re-hashes) stay; the deletion runs under its run lease;
//   - the bulk of an ENDED ODC lab delivery older than scratchDays (odc/lab/NN-*/work, work-merge-order and its .oml files):
//     the manifest and evidence stay;
//   - captures (o11/snapshots, odc/snapshots) beyond the newest keepCaptures (default 3) per module, once older than
//     captureMinAgeHours (24), with their .oml.json sibling.
// What it always keeps:
//   - a delivery task that is not finished (running, uncertain, failed and repairable, a pending Studio call or recovery,
//     an applied merge still being verified), whose run lease is held or cannot be tried, that a module reservation or an
//     app session of any backend names, or that is the newest delivered task of its module (the last successful delivery
//     base);
//   - a lab delivery in progress (no deliver-result.json), uncertain (outcome uncertain, or merge-started without
//     native-return), or the newest of its module and tenant (studio_publish reads it);
//   - everything a pending or uncertain record names (facade tasks running/uncertain, data/portal/Service Center receipts
//     not settled, data loads not closed, merge cuts) or a job file written in the last scratchDays (its base and producer
//     pins): every absolute, ws: or agent: path and every task id in them;
//   - files whose name it does not recognize, and the server's state (state/versions/<backend>/relay-authority, locks,
//     grants, service-center, studio-defaults; state/users, state/exposure), inbox/, jobs/, answers/, receipts and journals.
// When in doubt it keeps: an unreadable task, manifest or record protects what it could name.
// Never outside the workspace: every target is checked lexically and by the real path of its parent; a symbolic link is
// never followed, and a tree that contains one is kept whole.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runLeaseFree } from '../delivery-lineage.mjs';
import { runtimeDirectories } from './storage.mjs';

export const RETENTION = Object.freeze({ scratchDays: 3, keepCaptures: 3, captureMinAgeHours: 24, sweepEveryMs: 30 * 60000,
  lockStaleMs: 20 * 60000, journalMaxBytes: 2 * 1024 * 1024, journalItems: 500 });
export const RETENTION_ENV = Object.freeze({ scratchDays: 'SSAM_WORKSPACE_SCRATCH_DAYS', keepCaptures: 'SSAM_WORKSPACE_KEEP_CAPTURES' });
const DAY = 86400000, HOUR = 3600000;
const LIMITS = { scratchDays: [1, 90], keepCaptures: [1, 50] };

// The settings of this server: each from its variable when it is a whole number in range, else the default.
export function retentionSettings(env = process.env) {
  const out = {};
  for (const [key, name] of Object.entries(RETENTION_ENV)) {
    const raw = String(env?.[name] ?? '').trim();
    const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    out[key] = n >= LIMITS[key][0] && n <= LIMITS[key][1] ? n : RETENTION[key];
  }
  return out;
}

const lst = p => { try { return fs.lstatSync(p); } catch { return null; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const sha = text => createHash('sha256').update(text).digest('hex');
// A DurableJson checkpoint ({format:1, sha256, payload}) or a plain JSON file; null when unreadable or its checksum fails.
function checkpoint(file) {
  const doc = readJson(file);
  if (!doc || typeof doc.payload !== 'string') return doc;
  if (doc.format !== 1 || doc.sha256 !== sha(doc.payload)) return null;
  try { return JSON.parse(doc.payload); } catch { return null; }
}
const list = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const norm = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const relOf = (ws, abs) => path.relative(ws, abs).split(path.sep).join('/');

// Bytes, newest modification time and whether a symbolic link is inside (lstat only: nothing is followed).
function treeInfo(target) {
  let bytes = 0, newest = 0, symlink = false;
  const stack = [target];
  while (stack.length) {
    const p = stack.pop();
    const st = lst(p);
    if (!st) continue;
    if (st.isSymbolicLink()) { symlink = true; continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (st.isDirectory()) for (const e of list(p)) stack.push(path.join(p, e.name));
    else bytes += st.size;
  }
  return { bytes, newest, symlink };
}

// The first bytes of a core dump: ELF with e_type ET_CORE (4, either byte order), or a Windows/.NET minidump.
const CORE_NAME = /^(?:core|core\.\d+|coredump\.\d+)$|\.(?:dmp|mdmp)$/i;
function isDump(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(18);
    const n = fs.readSync(fd, head, 0, 18, 0);
    if (n >= 4 && head.toString('latin1', 0, 4) === 'MDMP') return true;
    if (n < 18 || head[0] !== 0x7f || head.toString('latin1', 1, 4) !== 'ELF') return false;
    const type = head[5] === 2 ? head.readUInt16BE(16) : head.readUInt16LE(16);
    return type === 4;
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// ---- the lock shared by the backends
export const lockFileOf = workspace => path.join(workspace, 'state', 'retention', 'sweep.lock');
function acquireLock(workspace, { now, staleMs, backend }) {
  const file = lockFileOf(workspace);
  const id = randomBytes(8).toString('hex');
  const body = JSON.stringify({ id, pid: process.pid, backend: backend ?? null, at: new Date(now()).toISOString() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, body, { flag: 'wx' }); return { file, id }; } catch (error) {
      if (error.code !== 'EEXIST' && !(process.platform === 'win32' && error.code === 'EPERM')) throw error;
      const st = lst(file);
      if (!st || attempt > 0) return null;
      // A planted link or folder is never a lock: removed (the link itself, never its target) and tried once more.
      if (!st.isFile()) { try { if (st.isDirectory() && !st.isSymbolicLink()) fs.rmdirSync(file); else fs.unlinkSync(file); } catch { return null; } continue; }
      if (now() - st.mtimeMs <= staleMs) return null;
      // Review R41 F10: a stale lock is moved to a unique name first, so two processes breaking it never remove each other's
      // fresh lock; the one whose rename fails lost the race.
      const away = file + '.stale.' + id;
      try { fs.renameSync(file, away); } catch { return null; }
      const moved = lst(away);
      // a fresh lock was taken meanwhile and moved by mistake: put back (never over a newer one) and back off
      if (moved && now() - moved.mtimeMs <= staleMs) { try { fs.linkSync(away, file); } catch { /* a newer lock is there */ } try { fs.unlinkSync(away); } catch { /* idem */ } return null; }
      try { fs.unlinkSync(away); } catch { /* removed at the next break */ }
      continue;
    }
  }
  return null;
}
const lockHeld = lock => { try { return JSON.parse(fs.readFileSync(lock.file, 'utf8')).id === lock.id; } catch { return false; } };
const touchLock = lock => { try { const t = new Date(); fs.utimesSync(lock.file, t, t); } catch { /* the next check sees it */ } };
function releaseLock(lock) { if (lockHeld(lock)) try { fs.unlinkSync(lock.file); } catch { /* broken as stale later */ } }

// ---- what must stay: the references of every record still open
function collectRefs(value, workspace, refs, depth = 0) {
  if (depth > 40 || value == null) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^[0-9a-f]{32}$/i.test(s)) refs.ids.add(s.toLowerCase());
    let p = null;
    if (/^(ws|agent):/i.test(s)) p = path.join(workspace, ...s.replace(/^(ws|agent):/i, '').split(/[\\/]/).filter(Boolean));
    else if (path.isAbsolute(s) && s.length < 4096) p = s;
    if (p) { refs.paths.add(norm(p)); for (const m of s.matchAll(/[0-9a-f]{32}/gi)) refs.ids.add(m[0].toLowerCase()); }
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectRefs(v, workspace, refs, depth + 1); return; }
  if (typeof value === 'object') for (const v of Object.values(value)) collectRefs(v, workspace, refs, depth + 1);
}
const SETTLED = new Set(['ok', 'failed', 'accepted', 'confirmed', 'rejected', 'refused', 'not-sent', 'not-started', 'applied', 'done', 'closed', 'settled',
  'succeeded', 'completed', 'cancelled', 'canceled', 'superseded', 'deleted', 'absent']);
const openRecord = doc => !doc || typeof doc !== 'object' || !SETTLED.has(String(doc.state ?? doc.status ?? '').toLowerCase());

// The O11 delivery tasks with their verdict: {id, dir, task, keep, why}.
function deliveryTasks(workspace, deps) {
  const work = path.join(workspace, 'o11', 'work', 'deliver');
  const out = [];
  for (const e of list(work)) {
    if (!e.isDirectory() || !/^[0-9a-f]{32}$/i.test(e.name)) continue;
    const dir = path.join(work, e.name);
    const task = checkpoint(path.join(dir, 'task.json'));
    out.push({ id: e.name.toLowerCase(), dir, task });
  }
  return out;
}

// The ODC lab deliveries: {dir, manifest, result, group, at, open}.
function labDeliveries(workspace) {
  const lab = path.join(workspace, 'odc', 'lab');
  const out = [];
  for (const e of list(lab)) {
    if (!e.isDirectory() || !/^\d{2,}-/.test(e.name)) continue;
    const dir = path.join(lab, e.name);
    const result = readJson(path.join(dir, 'deliver-result.json'));
    const progress = readJson(path.join(dir, 'deliver-progress.json'));
    const manifest = readJson(path.join(dir, 'delivery', 'manifest.json')) ?? readJson(path.join(dir, 'manifest.json'));
    const evidence = path.join(dir, 'delivery', 'evidence');
    const started = fs.existsSync(path.join(evidence, 'merge-started.json'));
    const returned = fs.existsSync(path.join(evidence, 'native-return.json'));
    const uncertain = !result || result.outcome === 'uncertain' || (started && !returned);
    const module = manifest ? String(manifest.moduleKey ?? manifest.module ?? '').toLowerCase() : '';
    const tenant = manifest ? String(manifest.tenant ?? '').toLowerCase() : '';
    const at = Date.parse(result?.completedAt ?? result?.startedAt ?? '') || (lst(dir)?.mtimeMs ?? 0);
    out.push({ dir, name: e.name, manifest, result, progress, group: module ? module + '\n' + tenant : null, started, at, open: uncertain });
  }
  return out;
}

// Removes paths of one delivery task while holding its run lease (review R41 F3): on Linux under flock(1) without waiting
// (the kernel's FileShare.None is an advisory flock there), on Windows with the lease file open share-exclusive. false when the
// lease is taken (the task runs again): nothing is removed then.
const SHARE_EXCLUSIVE = 0x10000000;
function underLease(dir, paths, deps) {
  const lock = path.join(dir, 'run.lock');
  if (!fs.existsSync(lock)) return false;
  if ((deps.platform ?? process.platform) !== 'win32') {
    const run = deps.underLease ?? ((file, list) => spawnSync('flock', ['-n', file, 'rm', '-rf', '--', ...list], { stdio: 'ignore', timeout: 120000, windowsHide: true }));
    let r;
    try { r = run(lock, paths); } catch { return false; }
    return Boolean(r) && !r.error && r.status === 0;
  }
  let fd;
  try { fd = fs.openSync(lock, fs.constants.O_RDWR | SHARE_EXCLUSIVE); } catch { return false; }
  try { for (const p of paths) fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } finally { fs.closeSync(fd); }
}

// ---- the cleanup of one workspace
// options: now, backend, settings (retentionSettings()), reason, dryRun, log, deps ({flock, platform} for the run lease),
// afterLock (tests). -> {ok, skipped?, freedBytes, removed, byKind, items, journal}
export function cleanWorkspace(workspace, { now = Date.now, backend = process.env.SSAM_BACKEND_NAME ?? null, settings = retentionSettings(),
  reason = 'sweep', dryRun = false, log = () => {}, deps = {}, afterLock = null, lockStaleMs = RETENTION.lockStaleMs } = {}) {
  const ws = path.resolve(workspace);
  const wsStat = lst(ws);
  if (!wsStat || !wsStat.isDirectory() || wsStat.isSymbolicLink()) return { ok: true, skipped: 'no-workspace', freedBytes: 0, removed: 0, byKind: {}, items: [] };
  let wsReal;
  try { wsReal = fs.realpathSync.native(ws); } catch { return { ok: false, skipped: 'unreadable', freedBytes: 0, removed: 0, byKind: {}, items: [] }; }
  const stateDir = path.join(ws, 'state', 'retention');
  const stateParent = lst(path.join(ws, 'state'));
  if (stateParent && (stateParent.isSymbolicLink() || !stateParent.isDirectory())) return { ok: false, skipped: 'state-not-a-folder', freedBytes: 0, removed: 0, byKind: {}, items: [] };
  fs.mkdirSync(stateDir, { recursive: true });
  const sd = lst(stateDir);
  if (!sd || sd.isSymbolicLink() || !sd.isDirectory()) return { ok: false, skipped: 'state-not-a-folder', freedBytes: 0, removed: 0, byKind: {}, items: [] };
  const lock = acquireLock(ws, { now, staleMs: lockStaleMs, backend });
  if (!lock) return { ok: true, skipped: 'locked', freedBytes: 0, removed: 0, byKind: {}, items: [] };
  try {
    afterLock?.();
    return runCleanup({ ws, wsReal, now, backend, settings, reason, dryRun, log, deps, lock });
  } finally { releaseLock(lock); }
}

function runCleanup({ ws, wsReal, now, backend, settings, reason, dryRun, log, deps, lock }) {
  const t = now();
  const scratchMs = settings.scratchDays * DAY;
  const captureMinMs = RETENTION.captureMinAgeHours * HOUR;
  const items = [];
  const byKind = {};
  let freed = 0, removed = 0, lost = false;
  const within = target => {
    const rel = path.relative(ws, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    try { const parent = fs.realpathSync.native(path.dirname(target)); const r = path.relative(wsReal, parent); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); } catch { return false; }
  };
  // Removes one file or folder (whole), or keeps it: outside, a link, a link inside, or the lock lost.
  const gone = [];
  const remove = (target, kind, info = treeInfo(target)) => {
    if (lost || gone.some(g => target === g || target.startsWith(g + path.sep))) return false;
    const st = lst(target);
    if (!st || st.isSymbolicLink() || info.symlink || !within(target)) return false;
    if (!dryRun) {
      try { if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true }); else fs.unlinkSync(target); }
      catch { return false; }
    }
    gone.push(target); freed += info.bytes; removed++;
    if (removed % 200 === 0) touchLock(lock);
    byKind[kind] = (byKind[kind] ?? 0) + info.bytes;
    if (items.length < RETENTION.journalItems) items.push({ path: relOf(ws, target), bytes: info.bytes, kind });
    return true;
  };
  const phase = () => { if (!lockHeld(lock)) { lost = true; return false; } touchLock(lock); return true; };

  // 1. what stays: the references of the open records
  const refs = { paths: new Set(), ids: new Set() };
  const protectRecord = doc => collectRefs(doc, ws, refs);
  for (const dir of [['o11', 'tasks'], ['odc', 'tasks']]) for (const e of list(path.join(ws, ...dir))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const doc = readJson(path.join(ws, ...dir, e.name));
    if (openRecord(doc)) protectRecord(doc ?? {});
  }
  for (const dir of [['o11', 'data', 'receipts'], ['odc', 'journal', 'portal', 'receipts'], ['o11', 'service-center', 'receipts'], ['odc', 'journal', 'data', 'requests']])
    for (const e of list(path.join(ws, ...dir))) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const doc = checkpoint(path.join(ws, ...dir, e.name));
      if (openRecord(doc)) protectRecord(doc ?? {});
    }
  for (const e of list(path.join(ws, 'odc', 'journal', 'merge-cuts'))) if (e.isFile()) protectRecord(readJson(path.join(ws, 'odc', 'journal', 'merge-cuts', e.name)) ?? {});
  // Review R41 F4: a job written in the last scratchDays may still be run or patched: its base and producer pins stay.
  for (const root of [path.join(ws, 'o11', 'jobs'), path.join(ws, 'odc', 'jobs'), path.join(ws, 'odc', '.local', 'jobs')]) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of list(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
        const st = lst(p);
        if (st && t - st.mtimeMs <= scratchMs && st.size <= 8 * 1024 * 1024) protectRecord(readJson(p) ?? {});
      }
    }
  }
  for (const loads of [path.join(ws, 'o11', 'data', 'loads'), path.join(ws, 'odc', 'journal', 'data', 'loads')]) for (const e of list(loads)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const plan = readJson(path.join(loads, e.name, 'plan.json'));
    if (!plan || String(plan.state ?? '').toLowerCase() !== 'closed') { refs.paths.add(norm(path.join(loads, e.name))); protectRecord(plan ?? {}); }
  }
  // reservations of every backend: the owner task stays whole
  const stateDirs = runtimeDirectories(path.join(ws, 'state'));
  for (const stateDir of stateDirs) {
    // app sessions (AppSessions.cs): their task ids own reservations in place of the delivery's own
    const sessions = readJson(path.join(stateDir, 'relay-authority', 'app-sessions.json'));
    if (sessions) protectRecord(sessions);
    const dir = path.join(stateDir, 'relay-authority', 'reservations');
    for (const e of list(dir)) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const held = checkpoint(path.join(dir, e.name));
      if (held === null) { refs.paths.add(norm(path.join(ws, 'o11', 'work', 'deliver'))); continue; } // unreadable: keep every task
      if (held.owner) { refs.ids.add(String(held.owner).toLowerCase()); protectRecord(held); }
      else if (fs.existsSync(path.join(dir, e.name + '.lock'))) protectRecord(held);
    }
  }
  const tasks = deliveryTasks(ws, deps);
  const newestDelivered = new Map();
  for (const x of tasks) {
    const task = x.task;
    const module = String(task?.moduleKey ?? task?.module ?? task?.request?.Module ?? '').toLowerCase();
    const ended = !!task && !task.pendingBridgeOperation && !task.pendingOperationRecovery && (task.closed === true || task.delivered === true);
    x.ended = ended;
    if (!task || !ended) { refs.ids.add(x.id); if (task) protectRecord(task); continue; }
    // a task an app session or a reservation names through its request
    if (task.request?.ReservationOwner) x.owner = String(task.request.ReservationOwner).toLowerCase();
    if (task.delivered === true && module) {
      const at = Date.parse(task.updatedAt ?? '') || 0;
      const cur = newestDelivered.get(module);
      if (!cur || at > cur.at) newestDelivered.set(module, { at, x });
    }
  }
  for (const { x } of newestDelivered.values()) { refs.ids.add(x.id); protectRecord(x.task); }
  const labs = labDeliveries(ws);
  const newestLab = new Map(), newestMerge = new Map();
  for (const l of labs) {
    if (l.open || !l.group) { refs.paths.add(norm(l.dir)); for (const doc of [l.manifest, l.result, l.progress]) if (doc) protectRecord(doc); continue; }
    if (!newestLab.has(l.group) || l.at > newestLab.get(l.group).at) newestLab.set(l.group, l);
    if (l.started && (!newestMerge.has(l.group) || l.at > newestMerge.get(l.group).at)) newestMerge.set(l.group, l);
  }
  for (const l of [...newestLab.values(), ...newestMerge.values()]) { refs.paths.add(norm(l.dir)); for (const doc of [l.manifest, l.result, l.progress]) if (doc) protectRecord(doc); }
  // A path is protected when a reference names it or something inside it, or names a folder that holds it at least three
  // levels below the workspace (a reference to the workspace, a lane or a snapshots folder itself protects nothing more).
  const wsNorm = norm(ws);
  const depthOf = r => (r === wsNorm ? 0 : path.relative(wsNorm, r).split(path.sep).length);
  const protectedPath = p => {
    const n = norm(p);
    for (const r of refs.paths) {
      if (n === r || r.startsWith(n + path.sep)) return true;
      if (n.startsWith(r + path.sep) && r.startsWith(wsNorm + path.sep) && depthOf(r) >= 3) return true;
    }
    return false;
  };

  // 2. core dumps, anywhere
  if (phase()) {
    const stack = [ws];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of list(dir)) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (p !== path.join(ws, 'state', 'retention')) stack.push(p); continue; }
        if (e.isFile() && CORE_NAME.test(e.name) && isDump(p)) remove(p, 'core-dump');
      }
    }
  }

  // 3. scratch older than scratchDays: the entries of these folders
  if (phase()) {
    const roots = [path.join(ws, 'o11', 'journal', 'staging'), path.join(ws, 'odc', 'journal', 'staging')];
    const entries = [];
    for (const lane of ['o11', 'odc']) {
      const tmp = path.join(ws, lane, 'tmp');
      // only the per-backend TEMP folders: tmp/o11-worker (the worker's pid records and lock) and the rest stay
      for (const b of list(path.join(tmp, 'versions'))) if (b.isDirectory()) roots.push(path.join(tmp, 'versions', b.name));
    }
    for (const stateDir of stateDirs) {
      for (const rel of ['checks', 'builds', 'verified/candidate', 'verified/patch', 'transfers']) roots.push(path.join(stateDir, ...rel.split('/')));
    }
    for (const root of roots) for (const e of list(root)) entries.push(path.join(root, e.name));
    for (const p of entries) { if (lst(p)?.isSymbolicLink()) continue; const info = treeInfo(p); if (t - info.newest > scratchMs && !protectedPath(p)) remove(p, 'scratch', info); }
  }

  // 4. the bulk of ended O11 delivery tasks and ODC lab deliveries
  if (phase()) {
    for (const x of tasks) {
      if (!x.task || !x.ended || refs.ids.has(x.id) || (x.owner && refs.ids.has(x.owner)) || protectedPath(x.dir)) continue;
      const bulk = list(x.dir).filter(e => (e.isDirectory() && (/^attempt-\d+$/.test(e.name) || e.name === 'runtime-producers')) || (e.isFile() && /\.(oml|xif)$/i.test(e.name)))
        .map(e => path.join(x.dir, e.name)).filter(p => within(p) && !lst(p)?.isSymbolicLink());
      if (!bulk.length) continue; // trimmed before: no lease probe
      const info = treeInfo(x.dir);
      if (t - info.newest <= scratchMs || info.symlink) continue;
      if (!runLeaseFree({ ...x.task, work: x.dir }, deps)) continue;
      const infos = bulk.map(p => [p, treeInfo(p)]);
      if (infos.some(([, i]) => i.symlink) || lost) continue;
      if (!dryRun && !underLease(x.dir, bulk, deps)) continue;
      for (const [p, i] of infos) {
        if (!dryRun && lst(p)) continue; // still there: not removed
        gone.push(p); freed += i.bytes; removed++; byKind['delivery-task'] = (byKind['delivery-task'] ?? 0) + i.bytes;
        if (items.length < RETENTION.journalItems) items.push({ path: relOf(ws, p), bytes: i.bytes, kind: 'delivery-task' });
      }
    }
    for (const l of labs) {
      if (protectedPath(l.dir)) continue;
      const info = treeInfo(l.dir);
      if (t - info.newest <= scratchMs || info.symlink) continue;
      for (const e of list(l.dir)) if (e.isDirectory() && ['work', 'work-merge-order'].includes(e.name)) remove(path.join(l.dir, e.name), 'lab-delivery');
      const stack = [l.dir];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of list(dir)) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(p); else if (e.isFile() && /\.oml$/i.test(e.name)) remove(p, 'lab-delivery');
        }
      }
    }
  }

  // 5. captures beyond the newest keepCaptures per module
  if (phase()) {
    const groups = new Map();
    const add = (key, file, order) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ file, order }); };
    const o11 = path.join(ws, 'o11', 'snapshots');
    for (const e of list(o11)) {
      if (!e.isFile()) continue;
      const m = /^((?:build-|producer-)?)(.+)-(\d{14})(?:-[0-9a-f]{8})?\.oml$/i.exec(e.name);
      if (!m) continue;
      const st = lst(path.join(o11, e.name));
      add('o11\n' + m[1].toLowerCase() + m[2].toLowerCase(), path.join(o11, e.name), [m[3], st?.mtimeMs ?? 0]);
    }
    const odc = path.join(ws, 'odc', 'snapshots');
    for (const e of list(odc)) {
      if (!e.isFile()) continue;
      const file = path.join(odc, e.name);
      const st = lst(file);
      let m = /^(.+)-([0-9a-f]{64})\.oml$/i.exec(e.name);
      if (m) {
        const meta = readJson(file + '.json');
        const captured = Date.parse(meta?.capturedAt ?? '') || 0;
        const key = 'odc\n' + String(meta?.moduleKey ?? m[1]).toLowerCase() + '\n' + String(meta?.host ?? '').toLowerCase();
        // a capture of the same bytes reuses its file and rewrites capturedAt: that time orders them, the file's only without it
        add(key, file, [String(captured || Math.floor(st?.mtimeMs ?? 0)).padStart(16, '0'), st?.mtimeMs ?? 0]);
        continue;
      }
      m = /^(.+)-revision-(\d+)(?:-[0-9a-f]{12})?\.oml$/i.exec(e.name);
      if (m) add('odc-revision\n' + m[1].toLowerCase(), file, [m[2].padStart(12, '0'), st?.mtimeMs ?? 0]);
    }
    for (const list_ of groups.values()) {
      list_.sort((a, b) => (a.order[0] < b.order[0] ? 1 : a.order[0] > b.order[0] ? -1 : b.order[1] - a.order[1]));
      for (const { file } of list_.slice(settings.keepCaptures)) {
        const st = lst(file);
        const sibling = lst(file + '.json');
        if (!st || t - Math.max(st.mtimeMs, sibling?.mtimeMs ?? 0) <= captureMinMs || protectedPath(file) || protectedPath(file + '.json')) continue;
        if (remove(file, 'capture') && lst(file + '.json')?.isFile()) remove(file + '.json', 'capture');
      }
    }
  }

  const summary = { ok: !lost, ...(lost ? { skipped: 'lock-lost' } : {}), freedBytes: freed, removed, byKind, items };
  if (removed > 0 && !dryRun) journal(ws, { at: new Date(t).toISOString(), backend, reason, freedBytes: freed, removed, byKind, items, ...(removed > items.length ? { truncated: true } : {}) });
  if (removed > 0) log({ event: 'workspace-cleaned', reason, freedBytes: freed, removed, byKind, ...(dryRun ? { dryRun: true } : {}) });
  return summary;
}

export const journalFileOf = workspace => path.join(workspace, 'state', 'retention', 'journal.jsonl');
function journal(ws, entry) {
  const file = journalFileOf(ws);
  try {
    const st = lst(file);
    if (st && !st.isFile()) return; // a link or folder there: no journal written through it (review R41 F8)
    if (st && st.size > RETENTION.journalMaxBytes) { const old = file.replace(/\.jsonl$/, '.1.jsonl'); if (lst(old)?.isSymbolicLink()) fs.unlinkSync(old); fs.renameSync(file, old); }
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, JSON.stringify(entry) + '\n'); } finally { fs.closeSync(fd); }
  } catch { /* the journal never stops a cleanup */ }
}

// Every customer workspace under <serverDir>/customers, one at a time with a pause between them (the event loop serves
// requests meanwhile). -> {workspaces, freedBytes, removed, skipped}
export const CUSTOMER_DIR = /^tok_[0-9a-f]{12}$/;
export async function sweepCustomers(customersDir, options = {}) {
  const out = { workspaces: 0, freedBytes: 0, removed: 0, skipped: 0 };
  for (const e of list(customersDir)) {
    if (!e.isDirectory() || e.isSymbolicLink() || !CUSTOMER_DIR.test(e.name)) continue;
    await new Promise(resolve => setImmediate(resolve));
    let r;
    const ws = path.join(customersDir, e.name);
    const mark = path.join(ws, 'state', 'retention', 'last-sweep.json');
    const last = Date.parse(readJson(mark)?.at ?? '');
    const now = (options.now ?? Date.now)();
    // review R41 F11: the four backends share the last sweep time of a workspace
    if (!options.force && Number.isFinite(last) && now - last < 0.9 * (options.everyMs ?? RETENTION.sweepEveryMs)) { out.skipped++; continue; }
    try {
      r = cleanWorkspace(ws, { ...options, reason: options.reason ?? 'sweep' });
      if (r.ok && !r.skipped && !lst(mark)?.isSymbolicLink()) { try { fs.writeFileSync(mark, JSON.stringify({ at: new Date(now).toISOString(), backend: options.backend ?? null }) + '\n'); } catch { /* next sweep */ } }
    }
    catch (error) { options.log?.({ event: 'workspace-clean-failed', token: e.name, code: error?.code ?? 'UNKNOWN' }); continue; }
    out.workspaces++; out.freedBytes += r.freedBytes; out.removed += r.removed; if (r.skipped) out.skipped++;
  }
  return out;
}

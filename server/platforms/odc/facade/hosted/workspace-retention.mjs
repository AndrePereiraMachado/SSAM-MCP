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
//     when needed), of <lane>/tmp (the TEMP of the kernel processes), and of state/versions/<backend>/{checks, builds,
//     verified/candidate, verified/patch, transfers} (private build artifacts that expire after 1 h by their own rule, and
//     agent uploads that never finished);
//   - the bulk of an ENDED O11 delivery task older than scratchDays (o11/work/deliver/<id>/attempt-*, its .oml files,
//     producers/ and runtime-producers/): task.json and result.json stay, so ssam_task and basedOn {taskId} still read it;
//   - the bulk of an ENDED ODC lab delivery older than scratchDays (odc/lab/NN-*/work, work-merge-order and its .oml files):
//     the manifest and evidence stay;
//   - captures (o11/snapshots, odc/snapshots) beyond the newest keepCaptures (default 3) per module, once older than
//     captureMinAgeHours (24), with their .oml.json sibling.
// What it always keeps:
//   - a delivery task that is not ended (Delivery.EndedHolder: running, uncertain, a pending Studio call or recovery, an
//     applied merge still being verified), whose run lease is held or cannot be tried, that owns a module reservation of
//     any backend, or that is the newest delivered task of its module (the last successful delivery base);
//   - a lab delivery in progress (no deliver-result.json), uncertain (outcome uncertain, or merge-started without
//     native-return), or the newest of its module and tenant (studio_publish reads it);
//   - everything a pending or uncertain record names (facade tasks running/uncertain, data/portal/Service Center receipts
//     not settled, data loads not closed, merge cuts): every absolute, ws: or agent: path and every task id in them;
//   - files whose name it does not recognize, and the server's state (state/versions/<backend>/relay-authority, locks,
//     grants, service-center, studio-defaults; state/users, state/exposure), inbox/, jobs/, answers/, receipts and journals.
// When in doubt it keeps: an unreadable task, manifest or record protects what it could name.
// Never outside the workspace: every target is checked lexically and by the real path of its parent; a symbolic link is
// never followed, and a tree that contains one is kept whole.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { holderEnded, runLeaseFree } from '../delivery-lineage.mjs';

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
      if (st && st.isFile() && now() - st.mtimeMs > staleMs && attempt === 0) { try { fs.unlinkSync(file); } catch { /* another process broke it */ } continue; }
      return null;
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
const SETTLED = new Set(['ok', 'failed', 'accepted', 'confirmed', 'rejected', 'not-sent', 'applied', 'done', 'closed', 'settled', 'succeeded', 'completed', 'cancelled', 'canceled']);
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
  for (const loads of [path.join(ws, 'o11', 'data', 'loads'), path.join(ws, 'odc', 'journal', 'data', 'loads')]) for (const e of list(loads)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const plan = readJson(path.join(loads, e.name, 'plan.json'));
    if (!plan || String(plan.state ?? '').toLowerCase() !== 'closed') { refs.paths.add(norm(path.join(loads, e.name))); protectRecord(plan ?? {}); }
  }
  // reservations of every backend: the owner task stays whole
  for (const b of list(path.join(ws, 'state', 'versions'))) {
    if (!b.isDirectory()) continue;
    const dir = path.join(ws, 'state', 'versions', b.name, 'relay-authority', 'reservations');
    for (const e of list(dir)) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const held = checkpoint(path.join(dir, e.name));
      if (held === null) { refs.paths.add(norm(path.join(ws, 'o11', 'work', 'deliver'))); continue; } // unreadable: keep every task
      if (held.owner) { refs.ids.add(String(held.owner).toLowerCase()); protectRecord(held); }
    }
  }
  const tasks = deliveryTasks(ws, deps);
  const newestDelivered = new Map();
  for (const x of tasks) {
    const task = x.task;
    const module = String(task?.moduleKey ?? task?.module ?? task?.request?.Module ?? '').toLowerCase();
    const ended = task ? holderEnded(task, deps) : false;
    x.ended = ended;
    if (!task || !ended) { refs.ids.add(x.id); if (task) protectRecord(task); continue; }
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
      for (const e of list(tmp)) {
        if (e.name === 'versions' && e.isDirectory()) { for (const b of list(path.join(tmp, 'versions'))) if (b.isDirectory()) roots.push(path.join(tmp, 'versions', b.name)); }
        else entries.push(path.join(tmp, e.name));
      }
    }
    for (const b of list(path.join(ws, 'state', 'versions'))) {
      if (!b.isDirectory()) continue;
      for (const rel of ['checks', 'builds', 'verified/candidate', 'verified/patch', 'transfers']) roots.push(path.join(ws, 'state', 'versions', b.name, ...rel.split('/')));
    }
    for (const root of roots) for (const e of list(root)) entries.push(path.join(root, e.name));
    for (const p of entries) { const info = treeInfo(p); if (t - info.newest > scratchMs && !protectedPath(p)) remove(p, 'scratch', info); }
  }

  // 4. the bulk of ended O11 delivery tasks and ODC lab deliveries
  if (phase()) {
    for (const x of tasks) {
      if (!x.task || !x.ended || refs.ids.has(x.id) || protectedPath(x.dir)) continue;
      const info = treeInfo(x.dir);
      if (t - info.newest <= scratchMs || info.symlink) continue;
      if (!runLeaseFree(x.task.work ? { ...x.task, work: x.dir } : { work: x.dir }, deps)) continue;
      for (const e of list(x.dir)) {
        const p = path.join(x.dir, e.name);
        if ((e.isDirectory() && (/^attempt-\d+$/.test(e.name) || ['producers', 'runtime-producers'].includes(e.name))) || (e.isFile() && /\.(oml|xif)$/i.test(e.name))) remove(p, 'delivery-task');
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
    if (st && st.isFile() && st.size > RETENTION.journalMaxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
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
    try { r = cleanWorkspace(path.join(customersDir, e.name), { ...options, reason: options.reason ?? 'sweep' }); }
    catch (error) { options.log?.({ event: 'workspace-clean-failed', token: e.name, code: error?.code ?? 'UNKNOWN' }); continue; }
    out.workspaces++; out.freedBytes += r.freedBytes; out.removed += r.removed; if (r.skipped) out.skipped++;
  }
  return out;
}

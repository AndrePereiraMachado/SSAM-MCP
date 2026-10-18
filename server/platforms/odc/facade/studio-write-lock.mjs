// The Studio write lock and its queue (A08, 2026-10-06). Two calls that change the same Studio never run at the same
// time, so the model may group calls in parallel safely. Reads never wait and never touch the lock or the queue. A write
// that finds its Studio busy WAITS ITS TURN in a first-in first-out queue shared by every SSAM process of this machine,
// for at most SSAM_WRITE_QUEUE_MS (default 240000, below the MCP client's own timeout); then it runs and answers its own
// result, with queue {position, waitedMs, holder: {tool, pid, startedAt}} when it waited. Only a wait that runs out
// refuses: STUDIO_WRITE_QUEUE_TIMEOUT with the holder, the position and an MCP continuation (the status read of that
// Studio); nothing of that write ran. The tool waits inside the call: the model never polls, sleeps or repeats it.
//
// CX14 recovery and pending operations. Normal writes keep FIFO. A stalled holder refuses a new write immediately
// with STUDIO_WRITE_HOLDER_STALLED, the holder evidence and one continuation. Once its dialog disappears, the holder
// is pending-in-studio and new writes wait until its bridge operation settles; abandoning a caller never permits replay.
// CX14 R5: the watches of a pending operation (studio-pending-operation.mjs, the stalled flight of o11-bridge.mjs, which
// samples while its flight lives) read `windows` again and again: a window that counts again (the same blocker after a
// dismiss, or another one) marks blockedBy again, so writes are answered at once with the recovery instead of waiting
// for the whole limit; a read that began before a dismiss cleared the blocker never marks it again. A dismiss of the
// exact blocker that already waits in the queue passes the queue (as a bypass) as soon as the holder is marked with it.
// holder adds heldMs/state and optional task ids, operation and blockedBy {title <= 80, kind}. A token-matched .holder
// sidecar carries phase updates across processes; neither locks, queues nor sidecars contain arguments or user words.
// Recovery close entries (~p) precede ordinary entries but remain exclusive. Closing the running task owner answers
// TASK_STILL_RUNNING immediately; a pending bridge flight answers CLOSE_WAITS_FOR_PENDING_OPERATION. Dismissing an
// error report or the exact stalled blocker bypasses the owner under a separate recovery lock (~r, at most 5 seconds),
// serializing recoveries and excluding normal writes. Other dismissals keep normal FIFO. Old SSAM processes ignore
// ~r/~p/.holder and must be upgraded together for these cross-process recovery guarantees.
//
// What a write is. A call that changes the model (merge, create, refresh references, records), the environment through
// the Studio (publish, environment and access apply, Service Center execute) or the Studio state another write relies
// on (the active module tab, a dialog, the sign-in window). WRITE_TOOLS holds one predicate per tool over its
// arguments; this is Studio serialization scope, not the mutation classification of cancellation and outcomes. Selecting a module tab is such a state: every kernel step after a
// merge (get_errors, find_element, snapshot_module in Delivery.cs) is pinned to the module key it merged
// (RequireTarget), so a tab switched mid-delivery fails a delivery whose merge is already applied. So every call that
// opens a module of the O11 Studio is a write: o11_deliver (until=apply opens it to capture it) and o11_studio snapshot
// {module}. Opening a system module (Users, OutSystemsUI, System) is refused before the Studio is asked (A29), so that
// call is not a write and never waits.
//
// Reads that capture a live O11 module by name (ssam_map / ssam_discover on the O11 lane with a module name instead of a
// .oml, o11_inspect {module}) are not writes here: their capture (module-map.mjs captureO11Module) reads a module open in
// a tab by its key, without selecting it (snapshot_module module_key, bridge C41), or the published OML of a module that
// is closed or of the system (A29), so parallel reads and a running write never meet. Only a module that is open but must
// be selected first (still opening, an older bridge) makes the capture take this lock itself, as an exclusive write
// (write:true) that waits its turn in the same queue.
//
// Key. Lane plus Studio identity. O11: the lane (ss4|ss5) plus pid/port of the connection record
// <anvilRoot>/.local/connections/<lane>.json. ODC: the pid argument when given. Without an identity the key is the
// whole lane. Two levels: a lane-wide holder excludes every identity of its lane and an identity holder excludes the
// lane-wide one (a call without pid and one with the pid of the only ODC Studio reach the same Studio).
//
// Locks. In this process, a Map. Between processes (each MCP client starts its own server), one file per key under
// <lane root>/.local/locks/, created exclusively (wx) with {pid, tool, startedAt, ...}; never the arguments, so the
// user's words never reach it. An acquirer creates its own file first and only then looks at the other level: two
// racing acquirers can both back off, never both hold. A lock is stale when its owner process is dead
// (process.kill(pid, 0)), when it is older than staleMs (3 h; the longest write, a deliver closing its previous task,
// is 75 min), or when it carries this process's pid without being held here. A stale file is removed under an
// exclusive breaker file after re-reading it unchanged. Released in finally and, for a process that exits mid-write,
// by an 'exit' handler; a process killed hard leaves a file whose dead pid makes it stale for the next caller. If the
// lock folder cannot be written, the Map still keeps this process's writes apart and the queue is kept in memory.
//
// Queue. In the same folder, one file per waiting write, <lane>~q<seq>.queue, created exclusively with {schema, pid,
// tool, enqueuedAt, seq, lane, studio, token}; never the arguments. seq is one more than the highest of the lane, taken
// by exclusive creation (two racing writers get two numbers), so the order is the order of arrival on the machine. A
// write runs when no conflicting entry (the same Studio, or either side lane-wide) has a lower seq and the lock is
// free. An entry is dropped by the stale rule of the locks (dead pid, older than staleMs, this pid without waiting here,
// damaged and old); its own write removes it when it runs, runs out of time, is cancelled (signal, contract I7) or its
// process exits. The wait is a timer doubling from 25 to 400 ms plus an in-process wake on every release, inside the
// deadline of the call. A write made inside a write that already holds the same Studio (the same call, in its async
// context) runs at once: it is part of the holder, never queued behind it.
//
// Per module, not the whole Studio (C07 of the atritos 3 package; the queue above stays):
// - o11_data (insert, update, delete) writes records through the Edit Data of the bridge's environment session, without a
//   tab and without the model (Anvil.Bridge/EnvironmentSessionHandler.cs): it never takes the Studio key. Its key is its
//   own lane o11-data-<lane> plus the module of the request, so two writes of the same module stay in series and every
//   other one runs beside a delivery.
// - narrowStudioWrite (contract I2): inside a write that holds the Studio (its async context), the call swaps the Studio
//   lock for a module lock <lane>~<id>~m-<key or name>.lock (record with {module: {name, key}}), releases the Studio lock
//   and wakes the queue. From then on a write of the same Studio runs, except one that names the same module (or no
//   module: a write whose module is unknown conflicts with every module lock of its Studio), which waits. The end of the
//   call releases the module locks. The publish of ODC (kernel-delivery.mjs) and of O11 (o11-publish.mjs) call it before
//   the publish itself, after the merge and the save.
// - The queue keeps its order, with one exception that never lets two conflicting writes meet: a waiting write passes an
//   earlier one that is blocked by a module lock it does not conflict with itself (the earlier one could not run anyway).
//
// Build and apply phases (lane wp of the atritos 3 package; the section of that name at the end of this file): a delivery
// called with phased:true builds without the Studio lock and takes it at its first Studio write.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { anvilRoot, odcRoot, o11Lane, O11_LANES } from './workspace.mjs';
import { readConnection } from './studio-session.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';
import { systemModuleName } from './studio-module.mjs';
import { stallRecovery } from './studio-recovery.mjs';
import { isErrorReportTitle } from './bridge-stall.mjs';
import { isStudioWrite } from './tool-classification.mjs';
const APP_TOOLS = new Set(['context', 'propose', 'continue', 'status']);
const O11_STUDIO_BARRIER_WAITS = new Set(['idle', 'no-dialogs']);

export const LOCK_SCHEMA = 'ssam-studio-write-lock/1';
export const QUEUE_SCHEMA = 'ssam-studio-write-queue/1';
// Kept for the callers that still name it; the queue never answers it (a busy Studio is waited for).
export const BUSY_CODE = 'STUDIO_WRITE_BUSY';
export const QUEUE_TIMEOUT_CODE = 'STUDIO_WRITE_QUEUE_TIMEOUT';
export const STALE_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_QUEUE_MS = 240000;
const GRACE_MS = 30000; // an unreadable lock, queue or breaker file younger than this is a creation in flight
const NAP_FIRST = 25, NAP_MAX = 400;

// The bounded wait of a queued write: SSAM_WRITE_QUEUE_MS (ms, 0 = no wait), else 240000.
export function queueWaitMs(env = process.env) {
  const raw = env?.SSAM_WRITE_QUEUE_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_QUEUE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_QUEUE_MS;
}

// Studio serialization is a narrower scope of the shared classification module.
export { STUDIO_WRITE_TOOLS as WRITE_TOOLS, isMutation } from './tool-classification.mjs';

// A write whose own wait is longer than the queue default waits its turn for up to that long (milliseconds): o11_studio
// wait idle|no-dialogs {timeoutSeconds} is a wait for the Studio, so its turn in the queue is part of that wait.
export const QUEUE_LIMITS = Object.freeze({
  o11_studio: a => (a.command === 'wait' && O11_STUDIO_BARRIER_WAITS.has(a.args?.condition)
    ? Math.min(1800, Math.max(1, Number(a.args?.timeoutSeconds) || 600)) * 1000 : null),
});
export function queueLimitOf(name, args = {}) {
  if (!Object.hasOwn(QUEUE_LIMITS, name)) return null;
  const value = QUEUE_LIMITS[name](args && typeof args === 'object' ? args : {});
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export const isWrite = isStudioWrite;

// 'o11' | 'odc' | null: the `lane` argument (o11, odc, or an O11 lane ss4|ss5), else the tool's name.
export function laneOfTool(name, args = {}) {
  const lane = String(args?.lane ?? '').trim().toLowerCase();
  if (lane === 'o11' || O11_LANES.includes(lane)) return 'o11';
  if (lane === 'odc') return 'odc';
  if (/^o11_/.test(name) || APP_TOOLS.has(name)) return 'o11';
  if (/^(studio_|odc_|hybrid_)/.test(name)) return 'odc';
  return null;
}

// ---- The key: {lane, id, dir}. id null = the whole lane.
const safe = text => String(text).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
const platformOf = lane => { const l = String(lane ?? '').trim().toLowerCase(); return l === 'odc' ? 'odc' : l === 'o11' || O11_LANES.includes(l) ? 'o11' : null; };
function anvilLaneOf(lane, args, deps) {
  for (const value of [lane, args?.lane]) { const l = String(value ?? '').trim().toLowerCase(); if (O11_LANES.includes(l)) return l; }
  return deps.o11Lane ?? o11Lane.lane;
}

// The lane of the O11 record writes (C07): its own key, never the Studio's.
export const DATA_LANE_PREFIX = 'o11-data-';
// Hosted (executor.mjs), the default roots mean the customer's <ws>/state/locks: one customer's writes never wait on
// another's, and nothing is written in this machine's lane folders.
export function studioWriteTarget({ tool, args = {}, lane, studioKey, deps = {} } = {}) {
  if (tool === 'o11_data') {
    const module = typeof args?.module === 'string' && args.module.trim() ? 'm-' + moduleTag(args.module.trim()) : null;
    const root = deps.o11Root ?? anvilRoot;
    return { lane: DATA_LANE_PREFIX + anvilLaneOf(lane, args, deps), id: module,
      dir: usesWorkspace(root, anvilRoot) ? workspacePath('state', 'locks') : path.join(root, '.local', 'locks') };
  }
  const platform = platformOf(lane) ?? laneOfTool(tool, args) ?? 'o11';
  if (platform === 'odc') {
    const id = studioKey != null ? safe(studioKey) : Number.isSafeInteger(args?.pid) ? 'pid' + args.pid : null;
    const root = deps.odcRoot ?? odcRoot;
    return { lane: 'odc', id, dir: usesWorkspace(root, odcRoot) ? workspacePath('state', 'locks') : path.join(root, '.local', 'locks') };
  }
  const anvilLane = anvilLaneOf(lane, args, deps);
  const root = deps.o11Root ?? anvilRoot;
  let id = studioKey != null ? safe(studioKey) : null;
  let record = null;
  try { record = deps.connection ? deps.connection(anvilLane) : readConnection(root, anvilLane); } catch { record = null; }
  if (id == null && Number.isSafeInteger(record?.pid)) id = 'pid' + record.pid + (Number.isInteger(record.port) ? '-port' + record.port : '');
  return { lane: 'o11-' + anvilLane, id, dir: o11StudioLockDir(root, record) };
}
// The lock folder of an O11 Studio. Hosted (executor.mjs) with the default root: the customer's <ws>/state/locks, so one
// customer's writes and bridge flights never meet another's (the customer's Studio is reached only through its own
// workspace). Local: the Studio's authority folder (o11LockDir).
export function o11StudioLockDir(root, record) {
  return usesWorkspace(root, anvilRoot) ? workspacePath('state', 'locks') : o11LockDir(root, record);
}
// UI freeze of 2026-10-08 (pattern 4): the queue of one Service Studio is shared by every SSAM root and process attached
// to it, not per root: the folder is the Studio's own authority (the connection record's authorityDir, the folder of the
// bridge key every attached root uses), <authorityDir>/studio-locks. A record without one (an older connect) keeps the
// root's <root>/.local/locks. The lane and the identity (pid and port of the Studio) stay in the file names.
export function o11LockDir(root, record) {
  const authority = typeof record?.authorityDir === 'string' && path.isAbsolute(record.authorityDir) ? record.authorityDir : null;
  return authority ? path.join(authority, 'studio-locks') : path.join(root, '.local', 'locks');
}
// Two keys reach the same Studio: the same folder and lane, and the same identity or either side lane-wide.
const conflicting = (a, b) => a.dir === b.dir && a.lane === b.lane && (a.id === b.id || !a.id || !b.id);

// ---- modules (C07). The module a write names: {name, key}, or null when it names none.
const word = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
export function moduleOfWrite(tool, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const inner = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {};
  return { name: word(a.module) ?? word(a.name) ?? word(inner.module) ?? word(inner.name),
    key: word(a.moduleKey) ?? word(a.module_key) ?? word(inner.moduleKey) ?? word(inner.module_key) };
}
// A lock or queue file never holds the arguments: a module is kept as the sha256 (16 hex) of its lowercase name and key.
const moduleTag = value => createHash('sha256').update(String(value).toLowerCase()).digest('hex').slice(0, 16);
const moduleOrNull = m => (m && (m.name || m.key) ? { name: m.name ? moduleTag(m.name) : null, key: m.key ? moduleTag(m.key) : null } : null);
const moduleOfRecord = m => (m && typeof m === 'object' && (typeof m.name === 'string' || typeof m.key === 'string')
  ? { name: typeof m.name === 'string' ? m.name : null, key: typeof m.key === 'string' ? m.key : null } : null);
// Two module references are the same module unless both are known and differ (by key when both have one, else by name).
function sameModule(a, b) {
  if (!a || !b) return true;
  if (a.key && b.key) return a.key.toLowerCase() === b.key.toLowerCase();
  if (a.name && b.name) return a.name.toLowerCase() === b.name.toLowerCase();
  return true;
}
// A lock (Studio or module) excludes a slot (a write: Studio key plus the module it names) of the same Studio; a module
// lock only when the slot names the same module or none.
const excludes = (lock, slot) => conflicting(lock, slot) && (!slot.recovery || lock.kind === 'recovery') && (lock.kind !== 'module' || sameModule(lock.module, slot.module));
// The lock files of a lane: {file, id, kind: 'studio' | 'module'}.
function lockFilesOf(dir, lane) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(dir, name);
    if (name === lane + '.lock') { files.push({ file, id: null, kind: 'studio' }); continue; }
    if (!name.startsWith(lane + '~')) continue;
    const rest = name.slice(lane.length + 1, -'.lock'.length);
    // A bridge call still in flight in this Studio (registerBridgeFlight): it excludes every write of the Studio.
    const flight = rest.indexOf('~f-');
    if (flight >= 0) { files.push({ file, id: rest.slice(0, flight) || null, kind: 'studio' }); continue; }
    if(rest.endsWith('~r')) { files.push({file,id:rest.slice(0,-2)||null,kind:'recovery'});continue; }
    const at = rest.indexOf('~m-');
    if (at < 0) { if (!rest.includes('~')) files.push({ file, id: rest, kind: 'studio' }); }
    else files.push({ file, id: rest.slice(0, at) || null, kind: 'module' });
  }
  return files;
}
const moduleFileOf = (dir, lane, id, module) => path.join(dir, lane + '~' + (id ?? '') + '~m-' + safe(module.key ?? module.name) + '.lock');

// ---- Answers: the holder's tool, pid and start only; never its arguments. The continuation is the status read of the
// busy Studio (O11 o11_studio status; ODC studio_status, with the pid of the call): the writes of every tool, tracked or
// not, leave it there. The server that registers this wrapper swaps it for ssam_doctor when it does not serve that tool.
export const BUSY_WHY = 'a write is already running in this Studio: wait for its answer and repeat this call; this read shows the Studio state';
export const QUEUE_WHY = 'the write queue of this Studio did not move within the limit; this read shows the Studio and the write that holds it';
export const busyContinuation = ({ lane = 'o11', pid } = {}, why = BUSY_WHY) => (lane === 'odc'
  ? { tool: 'studio_status', arguments: Number.isSafeInteger(pid) ? { pid } : {}, why }
  : { tool: 'o11_studio', arguments: { command: 'status' }, why });
export const busyRefusal = (holder, studio) => ({ ok: false, code: BUSY_CODE, holder: { tool: holder?.tool ?? null, startedAt: holder?.startedAt ?? null },
  continuation: busyContinuation(studio) });
export const busyToolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true });
export function queueTimeoutRefusal({ holder = null, position = 1, waitedMs = 0, queueMs = DEFAULT_QUEUE_MS, studio, ahead = [] } = {}) {
  holder=holder?{...holder,heldMs:holder.heldMs??0,state:holder.state??'running'}:null;
  return { ok: false, code: QUEUE_TIMEOUT_CODE, outcome: 'not-sent',
    error: 'This write waited ' + Math.round(waitedMs / 1000) + ' s in the write queue of this Studio and its turn did not come; nothing of it ran.',
    holder, position, waitedMs, queueMs, ahead: ahead.slice(0, 5).map(e => ({tool:e.tool,waitingMs:e.waitingMs??0})),
    continuation: holder?.taskId ? {tool:'ssam_task',arguments:{id:holder.taskId},why:QUEUE_WHY} : busyContinuation(studio, QUEUE_WHY) };
}

// ---- Lock and queue files.
const held = new Map();    // lock file -> {dir, lane, id, record}
const waiting = new Map(); // queue file -> token of a write of this process waiting there
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const [file, entry] of held) unlinkIfMine(file, entry.record.token);
    for (const [file, token] of waiting) unlinkIfMine(file, token);
    held.clear(); waiting.clear();
  });
}
const bus = new EventEmitter(); // in-process wake of the waiting writes: a lock released, an entry gone
bus.setMaxListeners(0);
const changed = () => bus.emit('change');

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

const fileOf = (dir, lane, id) => path.join(dir, id ? lane + '~' + id + '.lock' : lane + '.lock');
const cleanBlockedBy = value => value && typeof value.title === 'string' ? { title: value.title.slice(0,80), kind: String(value.kind??'Modal').slice(0,80) } : null;
function holderMetadata(file, token) {
  try { const value=JSON.parse(fs.readFileSync(file+'.holder','utf8')); return value.schema==='ssam-studio-write-holder/1' && value.token===token ? value : {}; } catch { return {}; }
}
function noteHolderFile(file, token, fields) {
  if (readLock(file)?.record?.token!==token) return;
  const previous=holderMetadata(file,token);
  const metadata={schema:'ssam-studio-write-holder/1',token,...previous,updatedAt:new Date().toISOString()};
  for(const name of ['taskId','kernelTaskId']) if(typeof fields[name]==='string') metadata[name]=fields[name];
  if(fields.operation) metadata.operation={method:String(fields.operation.method??'').slice(0,80),...(typeof fields.operation.operationId==='string'?{operationId:fields.operation.operationId}: {})};
  // CX14 R5: a read that began before a dismiss cleared the blocker never marks it again; the next read decides.
  const stale=fields.blockedBy&&Number.isFinite(fields.observedAt)&&Date.parse(previous.blockedByClearedAt??'')>fields.observedAt;
  if(Object.hasOwn(fields,'blockedBy')&&!stale) {
    metadata.blockedBy=cleanBlockedBy(fields.blockedBy);
    if(!metadata.blockedBy)metadata.blockedByClearedAt=new Date().toISOString();
    else delete metadata.blockedByClearedAt;
  }
  const temporary=file+'.holder.'+randomUUID()+'.tmp';
  try { fs.writeFileSync(temporary,JSON.stringify(metadata)); if(readLock(file)?.record?.token===token)fs.renameSync(temporary,file+'.holder'); }
  finally {try{fs.unlinkSync(temporary)}catch{}}
  changed();
}
function holderOf(lock) {
  const record=lock?.record??{};
  const file=lock?.file??[...held].find(([,e])=>e.record?.token===record.token)?.[0];
  const metadata=file?holderMetadata(file,record.token):{};
  const blockedBy=metadata.blockedByClearedAt?null:cleanBlockedBy(metadata.blockedBy);
  const startedAt=record.startedAt??null;
  return {tool:record.tool??null,pid:Number.isSafeInteger(record.pid)?record.pid:null,startedAt,
    heldMs:Math.max(0,Date.now()-(Date.parse(startedAt)||Date.now())),state:blockedBy?'stalled':record.kind==='flight'?'pending-in-studio':'running',
    ...Object.fromEntries(['taskId','kernelTaskId','operation'].filter(k=>metadata[k]!=null).map(k=>[k,metadata[k]])),...(blockedBy?{blockedBy}:{})};
}
export function noteStudioHolder(fields={}) {
  const entries=owned.getStore()??[];
  const entry=[...entries].reverse().find(e=>!e.slot.lane.startsWith(DATA_LANE_PREFIX));
  if(!entry)return false;
  entry.holderFields={...entry.holderFields,...fields};entry.lock?.note?.(entry.holderFields);return true;
}
export function clearStudioBlockedBy({target,title}={}) {
  const same=value=>String(value??'').trim().toLowerCase()===String(title??'').trim().toLowerCase();
  for(const f of lockFilesOf(target.dir,target.lane)) {
    if(!conflicting({...target,id:f.id},target))continue;
    const lock=readLock(f.file);if(!lock)continue;
    if(same(holderOf(lock).blockedBy?.title))noteHolderFile(f.file,lock.record.token,{blockedBy:null});
  }
}
export function pendingOperationOf({taskId,kernelTaskId,deps={},lane,root,record}={}) {
  const target=studioWriteTarget({tool:'ssam_task',lane,deps:{...deps,...(root?{o11Root:root}:{}),...(record?{connection:()=>record}:{})}});
  const ctx={now:Date.now,alive:deps.alive??processAlive,staleMs:deps.staleMs??STALE_MS};
  for(const f of lockFilesOf(target.dir,target.lane)) {
    if(!conflicting({...target,id:f.id},target))continue;
    const lock=readLock(f.file);if(!lock||lock.record?.kind!=='flight'||stale(lock,f.file,ctx))continue;
    const holder=holderOf(lock);
    if((taskId && holder.taskId===taskId)||(kernelTaskId && holder.kernelTaskId===kernelTaskId))return holder;
  }
  return null;
}
function stalledRefusal(holder,{position=1,waitedMs=0,studio}={}) {
  const next=holder.taskId?{tool:'ssam_task',arguments:{id:holder.taskId},why:'Read the holder before another write.'}:busyContinuation(studio);
  const recovery=stallRecovery({verdict:'dialog',blockedBy:holder.blockedBy},next);
  return {ok:false,code:'STUDIO_WRITE_HOLDER_STALLED',outcome:'not-sent',holder,position,waitedMs,recovery,continuation:recovery[0],error:'The current Studio write is blocked by a persistent dialog; nothing of this call ran.'};
}
function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { mtimeMs } = fs.statSync(file);
    let record = null;
    try { record = JSON.parse(raw); } catch { /* a creation in flight, or a damaged file */ }
    return { file, raw, record: record && typeof record === 'object' ? record : null, mtimeMs };
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function unlinkIfMine(file, token) {
  try { if (readLock(file)?.record?.token === token) { try {fs.unlinkSync(file+'.holder')}catch{} fs.unlinkSync(file); } } catch { /* best effort */ }
}
function create(file, record) {
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
  try { fs.writeSync(fd, JSON.stringify(record)); }
  catch (error) { fs.closeSync(fd); fd = null; try { fs.unlinkSync(file); } catch { /* best effort */ } throw error; }
  finally { if (fd != null) fs.closeSync(fd); }
  return true;
}
// mine(file, record): the file is this process's own live lock or queue entry.
function staleRecord(lock, ctx, at, mine) {
  const { record } = lock;
  if (!record || !Number.isSafeInteger(record.pid)) return Date.now() - lock.mtimeMs > GRACE_MS;
  if (record.pid === process.pid) return !mine(record);
  if (!ctx.alive(record.pid)) return true;
  const started = Date.parse(record[at]);
  return Number.isFinite(started) ? ctx.now() - started > ctx.staleMs : Date.now() - lock.mtimeMs > ctx.staleMs;
}
const stale = (lock, file, ctx) => staleRecord(lock, ctx, 'startedAt', record => held.get(file)?.record.token === record.token);
const staleEntry = (lock, file, ctx) => staleRecord(lock, ctx, 'enqueuedAt', record => waiting.get(file) === record.token);
// Removes a stale file only while holding <file>.break and only if it still reads the same; false = leave it.
function breakStale(file, raw) {
  const breaker = file + '.break';
  try { fs.writeFileSync(breaker, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try { if (Date.now() - fs.statSync(breaker).mtimeMs > GRACE_MS) fs.unlinkSync(breaker); } catch { /* gone meanwhile */ }
    return false;
  }
  try {
    let current;
    try { current = fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
    if (current !== raw) return false;
    try {fs.unlinkSync(file+'.holder')}catch{}
    fs.unlinkSync(file);
    return true;
  } finally { try { fs.unlinkSync(breaker); } catch { /* best effort */ } }
}
// The holder of a file, or null when it is free (missing, or stale and removed now).
function liveHolder(file, ctx) {
  const lock = readLock(file);
  if (!lock) return null;
  if (!stale(lock, file, ctx)) return holderOf(lock);
  return breakStale(file, lock.raw) ? null : holderOf(readLock(file) ?? lock);
}
// The lock files that exclude a slot: the other Studio locks of its Studio (both levels) and the module locks of its Studio
// that name its module (or any, when it names none). A module lock that cannot be read yet excludes (a creation in flight).
function excludingFiles(slot, own = null) {
  return lockFilesOf(slot.dir, slot.lane).filter(f => (!slot.recovery || f.kind==='recovery') && f.file !== own && conflicting({ dir: slot.dir, lane: slot.lane, id: f.id }, slot)
    && (f.kind !== 'module' || (() => { let lock = null; try { lock = readLock(f.file); } catch { lock = null; } return sameModule(moduleOfRecord(lock?.record?.module), slot.module); })()));
}
function acquireFile(slot, file, record, ctx) {
  fs.mkdirSync(slot.dir, { recursive: true });
  if (!create(file, record)) {
    const holder = liveHolder(file, ctx);
    if (holder) return holder;
    if (!create(file, record)) return holderOf(readLock(file));
  }
  for (const other of excludingFiles(slot, file)) {
    const holder = liveHolder(other.file, ctx);
    if (holder) { unlinkIfMine(file, record.token); return holder; }
  }
  return null;
}

function acquire(slot, tool, ctx) {
  for (const entry of held.values())
    if (excludes(entry, slot)) return { ok: false, holder: holderOf(entry) };
  const startedAt = new Date(ctx.now()).toISOString();
  const record = { schema: LOCK_SCHEMA, pid: process.pid, tool: String(tool), startedAt,
    lane: slot.lane, studio: slot.id ?? null, ...(slot.module ? { module: slot.module } : {}), token: randomUUID() };
  const file = slot.recovery ? path.join(slot.dir,slot.lane+'~'+(slot.id??'')+'~r.lock') : fileOf(slot.dir, slot.lane, slot.id);
  if(slot.recovery)record.kind='recovery';
  held.set(file, { dir: slot.dir, lane: slot.lane, id: slot.id, kind: slot.recovery?'recovery':'studio', module: slot.module, record });
  hookExit();
  try {
    const holder = acquireFile(slot, file, record, ctx);
    if (holder) { held.delete(file); return { ok: false, holder }; }
  } catch { /* the lock folder cannot be written: the Map above still excludes this process's own writes */ }
  let released = false, studioHeld = true;
  let holderFields={};
  const modules = new Map(); // module lock file -> its token
  // C07, contract I2: the Studio lock becomes a module lock (see the header). Idempotent per module; another module of the
  // same call adds its own lock; a module another write holds is not taken ({narrowed:false}) and the Studio lock stays.
  const narrow = wanted => {
    // The module named by the call, completed by the one the write named when they are the same module; else the latter.
    const given = moduleOrNull(wanted);
    const module = !given ? slot.module : slot.module && sameModule(given, slot.module)
      ? { name: given.name ?? slot.module.name, key: given.key ?? slot.module.key } : given;
    if (released || !module) return { narrowed: false, key: null };
    const moduleFile = moduleFileOf(slot.dir, slot.lane, slot.id, module);
    const key = path.basename(moduleFile, '.lock');
    if (modules.has(moduleFile)) return { narrowed: true, key };
    const mine = new Set([record.token, ...modules.values()]);
    for (const entry of held.values())
      if (entry.kind === 'module' && !mine.has(entry.record.token) && conflicting(entry, slot) && sameModule(entry.module, module)) return { narrowed: false, key: null };
    const moduleRecord = { schema: LOCK_SCHEMA, pid: process.pid, tool: String(tool), startedAt, lane: slot.lane, studio: slot.id ?? null,
      module, kind: 'module', token: randomUUID() };
    held.set(moduleFile, { dir: slot.dir, lane: slot.lane, id: slot.id, kind: 'module', module, record: moduleRecord });
    try {
      fs.mkdirSync(slot.dir, { recursive: true });
      if (!create(moduleFile, moduleRecord) && (liveHolder(moduleFile, ctx) || !create(moduleFile, moduleRecord))) { held.delete(moduleFile); return { narrowed: false, key: null }; }
    } catch { /* the lock folder cannot be written: the Map keeps this process's writes apart */ }
    modules.set(moduleFile, moduleRecord.token);
    if(Object.keys(holderFields).length)noteHolderFile(moduleFile,moduleRecord.token,holderFields);
    if (studioHeld) { studioHeld = false; held.delete(file); unlinkIfMine(file, record.token); }
    changed();
    return { narrowed: true, key };
  };
  // The tokens of the files this write holds now (studioWriteHolder never counts the asking call itself).
  const tokens = () => [...(studioHeld && !released ? [record.token] : []), ...(released ? [] : modules.values())];
  return { ok: true, narrow, tokens, note: fields => {
    holderFields={...holderFields,...fields};
    if(studioHeld&&!released)noteHolderFile(file,record.token,holderFields);
    for(const [f,t] of modules)if(!released)noteHolderFile(f,t,holderFields);
  }, release: () => {
    if (released) return; released = true;
    if (studioHeld) { held.delete(file); unlinkIfMine(file, record.token); }
    for (const [moduleFile, token] of modules) { held.delete(moduleFile); unlinkIfMine(moduleFile, token); }
    changed();
  } };
}
// The live holder that excludes a slot (in this process first, then the lock files), or null.
function holderFor(slot, ctx, accept=()=>true) {
  for (const entry of held.values()) if (excludes(entry, slot)) {const holder=holderOf(entry);if(accept(holder))return holder;}
  for (const other of excludingFiles(slot)) {
    let holder = null;
    try { holder = liveHolder(other.file, ctx); } catch { holder = null; }
    if (holder && accept(holder)) return holder;
  }
  return null;
}
// The live module locks of a Studio, in this process and in files: [{id, module}].
function moduleLocks(slot, ctx) {
  const found = [];
  for (const entry of held.values()) if (entry.kind === 'module' && conflicting(entry, slot)) found.push({ id: entry.id, module: entry.module });
  for (const f of lockFilesOf(slot.dir, slot.lane)) {
    if (f.kind !== 'module' || !conflicting({ dir: slot.dir, lane: slot.lane, id: f.id }, slot) || held.has(f.file)) continue;
    let lock = null;
    try { lock = readLock(f.file); } catch { lock = null; }
    if (moduleOfRecord(lock?.record?.module) && !stale(lock, f.file, ctx)) found.push({ id: f.id, module: moduleOfRecord(lock.record.module) });
  }
  return found;
}
// An earlier write that is blocked by a module lock the later one does not conflict with: the later one may pass it.
const passable = (earlier, later, locks) => {
  if (!earlier.module || !later.module) return false;
  const blocking = locks.filter(l => conflicting({ dir: earlier.dir, lane: earlier.lane, id: l.id }, earlier) && sameModule(l.module, earlier.module));
  return blocking.length > 0 && blocking.every(l => !sameModule(l.module, later.module));
};

// The queue entries of a lane, oldest first, after dropping the stale ones: [{file, seq, record}].
const QUEUE_EXT = '.queue';
const queueFile = (dir, lane, seq, priority=false) => path.join(dir, lane + (priority?'~p':'~q') + String(seq).padStart(12, '0') + QUEUE_EXT);
function queueEntries(target, ctx) {
  let names = [];
  try { names = fs.readdirSync(target.dir); } catch { return []; }
  const prefix = target.lane + '~';
  const entries = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(QUEUE_EXT) || !/^[pq][0-9]+$/.test(name.slice(prefix.length,-QUEUE_EXT.length))) continue;
    const priority=name[prefix.length]==='p';
    const seq = Number(name.slice(prefix.length+1, -QUEUE_EXT.length));
    if (!Number.isSafeInteger(seq)) continue;
    const file = path.join(target.dir, name);
    let entry = null;
    try { entry = readLock(file); } catch { entry = null; }
    if (!entry) continue;
    if (staleEntry(entry, file, ctx)) { try { if (breakStale(file, entry.raw)) continue; } catch { /* left for the next reader */ } }
    entries.push({ file, seq, priority, record: entry.record });
  }
  return entries.sort((a, b) => Number(b.priority)-Number(a.priority) || a.seq - b.seq);
}
// A write of this process waiting its turn: its queue file (null when the folder cannot be written; then the order is
// the in-process one) and its in-process arrival order.
const local = new Set();
let arrivals = 0;
function enter(target, tool, ctx, priority=false) {
  const waiter = { target, priority, tool: String(tool), token: randomUUID(), order: ++arrivals, file: null, seq: null };
  local.add(waiter);
  hookExit();
  try {
    fs.mkdirSync(target.dir, { recursive: true });
    let seq = queueEntries(target, ctx).reduce((max, e) => Math.max(max, e.seq), 0) + 1;
    for (let tries = 0; tries < 1000 && !waiter.file; tries++, seq++) {
      const file = queueFile(target.dir, target.lane, seq, priority);
      const record = { schema: QUEUE_SCHEMA, pid: process.pid, tool: waiter.tool, enqueuedAt: new Date(ctx.now()).toISOString(), seq,
        lane: target.lane, studio: target.id ?? null, ...(target.module ? { module: target.module } : {}), token: waiter.token };
      waiting.set(file, waiter.token); // before the file exists: this process never reads its own entry as stale
      if (create(file, record)) { waiter.file = file; waiter.seq = seq; } else waiting.delete(file);
    }
  } catch { if (waiter.file) waiting.delete(waiter.file); waiter.file = null; waiter.seq = null; }
  return waiter;
}
function leave(waiter) {
  if (!waiter || !local.delete(waiter)) return;
  if (waiter.file) { waiting.delete(waiter.file); unlinkIfMine(waiter.file, waiter.token); }
  changed();
}
// The writes ahead of a waiter (or, for null, every write waiting for the target): [{tool, pid, startedAt:null}]. A
// waiter without a queue file is ordered among the waiters of this process only.
function aheadOf(target, waiter, ctx) {
  const inProcess = o => ({ tool: o.tool, pid: process.pid, startedAt: null });
  // C07: an earlier write blocked by a module lock this one does not conflict with is passed (see the header).
  let locks = null;
  const ahead = other => conflicting(other, target) && !(other.module && target.module && passable(other, target, locks ??= moduleLocks(target, ctx)));
  const earlier = o => o !== waiter && ahead(o.target) && (!waiter || (o.priority!==waiter.priority ? o.priority : o.order < waiter.order));
  if (waiter && !waiter.file) return [...local].filter(earlier).map(inProcess);
  return [...queueEntries(target, ctx)
    .filter(e => (!waiter || (e.record?.token !== waiter.token && (e.priority!==waiter.priority ? e.priority : e.seq < waiter.seq)))
      && ahead({ dir: target.dir, lane: target.lane, id: typeof e.record?.studio === 'string' ? e.record.studio : null,
        module: moduleOfRecord(e.record?.module) }))
    .map(e => ({ tool: e.record?.tool ?? null, pid: Number.isSafeInteger(e.record?.pid) ? e.record.pid : null, startedAt: null, waitingMs: Math.max(0,ctx.now()-(Date.parse(e.record?.enqueuedAt)||ctx.now())) })),
  ...(waiter ? [] : [...local].filter(o => !o.file && earlier(o)).map(inProcess))];
}
// Resolves after ms, on an in-process change, or when the signal aborts (the caller then reads signal.aborted).
function nap(ms, signal) {
  return new Promise(resolve => {
    let timer = null;
    const done = () => { clearTimeout(timer); bus.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, Math.max(0, ms));
    bus.on('change', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const clock = now => () => { const value = (now ?? Date.now)(); return value instanceof Date ? value.getTime() : Number(value); };

// The live holder of the write lock of a Studio, without acquiring it (null when free): the `idle` wait of o11_studio
// (C31) is not idle while a write runs there. Stale files are reported free and left in place (the next acquirer
// removes them).
// The call that asks (a wait idle that holds the Studio as a write, its async context) is never its own holder; a bridge
// call still in flight (registerBridgeFlight) is one.
export function studioWriteHolder({ tool = 'o11_studio', args = {}, lane, studioKey, deps = {} } = {}) {
  const ctx = { now: clock(deps.now), alive: deps.alive ?? processAlive, staleMs: deps.staleMs ?? STALE_MS };
  const target = studioWriteTarget({ tool, args, lane, studioKey, deps });
  const mine = new Set((owned.getStore() ?? []).flatMap(e => (typeof e?.lock?.tokens === 'function' ? e.lock.tokens() : [])));
  for (const entry of held.values())
    if (conflicting(entry,target) && !mine.has(entry.record?.token)) return holderOf(entry);
  let files = [];
  try { files = fs.readdirSync(target.dir).filter(n => (n === target.lane + '.lock' || n.startsWith(target.lane + '~')) && n.endsWith('.lock')); }
  catch { return null; }
  for (const name of files) {
    const file = path.join(target.dir, name);
    let lock = null;
    try { lock = readLock(file); } catch { lock = null; }
    if (lock && conflicting({dir:target.dir,lane:target.lane,id:lock.record?.studio??null},target) && !mine.has(lock.record?.token) && !stale(lock, file, ctx)) return holderOf(lock);
  }
  return null;
}

// ---- Bridge calls still in flight (UI freeze of 2026-10-08, pattern 4). A bridge call that outlives its client timeout
// keeps running in the Studio (an open_module, a close_module stuck on the UI thread). Before, the write that sent it
// ended at the timeout and released the Studio lock, and the next write (another agent's refresh-refs + publish of the
// same module, 13:59Z) went into a Studio still busy with it. Now o11-bridge.mjs keeps listening for the late answer and
// registers the call here: a lock file <lane>~<id>~f-<token>.lock (tool "bridge:<method>", never the arguments) that
// excludes every write of that Studio, in this process and the others, until the bridge answers, the connection ends
// (the Studio closed) or FLIGHT_CAP_MS passes. The stale rules of the locks apply (dead pid, older than staleMs).
export const FLIGHT_CAP_MS = 30 * 60 * 1000;
export function registerBridgeFlight({ lane, root, record, method, module, now, taskId, kernelTaskId, operationId, blockedBy, stall } = {}) {
  const anvilLane = O11_LANES.includes(String(lane ?? '').toLowerCase()) ? String(lane).toLowerCase() : o11Lane.lane;
  if (!Number.isSafeInteger(record?.pid)) return () => {};
  const id = 'pid' + record.pid + (Number.isInteger(record.port) ? '-port' + record.port : '');
  const dir = o11StudioLockDir(root ?? anvilRoot, record);
  const laneKey = 'o11-' + anvilLane;
  const token = randomUUID();
  const flightRecord = { schema: LOCK_SCHEMA, pid: process.pid, tool: 'bridge:' + String(method ?? '?'), startedAt: new Date((now ?? Date.now)()).toISOString(),
    lane: laneKey, studio: id, kind: 'flight', ...(moduleOrNull(module) ? { module: moduleOrNull(module) } : {}), token };
  const file = path.join(dir, laneKey + '~' + id + '~f-' + token.replace(/-/g, '').slice(0, 16) + '.lock');
  held.set(file, { dir, lane: laneKey, id, kind: 'studio', record: flightRecord });
  hookExit();
  try { fs.mkdirSync(dir, { recursive: true }); create(file, flightRecord); } catch { /* the Map still excludes this process's writes */ }
  let done = false;
  const update=fields=>{if(!done)noteHolderFile(file,token,fields)};
  update({taskId,kernelTaskId,operation:{method,operationId},...(blockedBy??stall?.blockedBy?{blockedBy:blockedBy??stall.blockedBy}:{})});
  const release=() => { if (done) return; done = true; held.delete(file); unlinkIfMine(file, token); changed(); };
  release.update=update;return release;
}

export const CANCELLED_CODE = 'CANCELLED';

// The answer of a write that waited: its own result with queue {position, waitedMs, holder}. A plain object gets the field;
// an MCP result gets it in structuredContent and in its JSON text, or a second text block beside a plain text ("entregue").
export function withQueue(result, queue) {
  if (!queue || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Array.isArray(result.content)) return { ...result, queue };
  const structured = result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
    ? { ...result.structuredContent, queue } : result.structuredContent;
  let placed = false;
  const content = result.content.map((c, i) => {
    if (i !== 0 || c?.type !== 'text' || !/^\s*\{/.test(c.text ?? '')) return c;
    try { const value = JSON.parse(c.text); if (value && typeof value === 'object' && !Array.isArray(value)) { placed = true; return { ...c, text: JSON.stringify({ ...value, queue }) }; } } catch { /* plain text */ }
    return c;
  });
  if (!placed) content.push({ type: 'text', text: JSON.stringify({ queue }) });
  return { ...result, content, ...(structured !== undefined ? { structuredContent: structured } : {}) };
}

// The Studios the current async call already holds (re-entrant writes of the same call run at once): [{slot, lock}].
const owned = new AsyncLocalStorage();

// C07, contract I2: inside a write that holds a Studio (the async context of the call), swaps the Studio lock for the lock
// of the module {module, moduleKey} (or of the module the write named) until the call ends; see the header. Outside a write,
// or without a module: {narrowed:false, key:null}. Idempotent.
export function narrowStudioWrite({ module, moduleKey } = {}) {
  const store = owned.getStore() ?? [];
  const entry = [...store].reverse().find(e => typeof e?.lock?.narrow === 'function' && !e.slot.lane.startsWith(DATA_LANE_PREFIX));
  if (!entry) return { narrowed: false, key: null };
  return entry.lock.narrow({ name: word(module), key: word(moduleKey) });
}

// The turn of a write in the queue of its Studio (see the header): {ok:true, lock, queue} once the lock is taken (queue
// null when nothing was waited for), or {ok:false, value} when the call was cancelled or the bounded wait ran out (value is
// the refusal, not yet shaped by onBusy). Nothing of the write has run either way.
async function takeTurn({ target, tool, args = {}, ctx, limit, signal, studio, priority=false }) {
  const cancelled = extra => ({ ok: false, value: { ok: false, code: CANCELLED_CODE, outcome: 'not-sent', ...extra, continuation: busyContinuation(studio) } });
  if (signal?.aborted) return cancelled({ error: 'The call was cancelled before it started; nothing ran.' });
  // Nobody waits ahead and the Studio is free: run at once, without a queue entry.
  if (!aheadOf(target, null, ctx).length) {
    const lock = acquire(target, tool, ctx);
    if (lock.ok) return { ok: true, lock, queue: null };
  }
  const started = Date.now();
  const waiter = enter(target, tool, ctx, priority);
  let position = null, holder = null, step = NAP_FIRST;
  try {
    for (;;) {
      if (signal?.aborted)
        return cancelled({ error: 'The call was cancelled while it waited in the write queue of this Studio; nothing ran.', position: position ?? 1, waitedMs: Date.now() - started });
      const ahead = aheadOf(target, waiter, ctx);
      let current = null;
      if (!ahead.length) {
        const lock = acquire(target, tool, ctx);
        if (lock.ok) {
          leave(waiter);
          return { ok: true, lock, queue: { position: position ?? 1, waitedMs: Date.now() - started, holder } };
        }
        current = lock.holder;
      } else current = holderFor(target, ctx);
      const now = ahead.length + (current ? 1 : 0) || 1;
      if (position == null) position = now;
      holder ??= current ?? ahead[0] ?? null;
      // CX14 R5: the dismiss of the exact blocker that waited here (it came back before a watch marked it again) passes
      // as soon as the holder is marked stalled by it, as if it had arrived then; any other write gets the recovery.
      if(current?.state==='stalled'&&recoveryOf(tool,args,current)==='bypass')return {ok:false,bypass:true};
      if(current?.state==='stalled')return {ok:false,value:stalledRefusal(current,{position:now,waitedMs:Date.now()-started,studio})};
      const left = started + limit - Date.now();
      if (left <= 0) return { ok: false, value: queueTimeoutRefusal({ holder: current ?? ahead[0] ?? holder, position: now, waitedMs: Date.now() - started, queueMs: limit, studio, ahead }) };
      await nap(Math.min(step, left), signal);
      step = Math.min(step * 2, NAP_MAX);
    }
  } finally { leave(waiter); }
}

// Runs fn under the write lock of the Studio the call touches; a read runs fn directly. Busy: the write waits its turn in
// the queue (see the header) and then runs; a wait that runs out answers STUDIO_WRITE_QUEUE_TIMEOUT (or
// onBusy(refusal), e.g. busyToolResult for an MCP handler) without calling fn. deps: o11Root, odcRoot, o11Lane,
// connection(lane) -> record, now, staleMs, alive(pid), queueMs (else env.SSAM_WRITE_QUEUE_MS, else 240000), env.
// studioKey overrides the Studio identity.
// signal (contract I7): an AbortSignal of the call. Aborted before the lock is taken (before the call or while it waits
// in the queue): {ok:false, code:CANCELLED, outcome:"not-sent"} (through onBusy when given), its queue entry is removed
// and fn never runs. Once fn runs, the lock stays until fn ends: the long writes (o11_publish, o11_studio wait) honor
// the same signal and end at once, so the lock is never released while their operation is still being written by this
// process.
// write: true takes the lock whatever the tool (a read whose own step writes: the select of captureO11Module).
// phased: true splits a delivery (PHASED_TOOLS) into its build and apply phases (see "Build and apply phases" below): fn
// starts without the Studio lock and takes it at its first Studio write. The ssam server passes isPhased(tool, args).
// queue: accepted for the callers of the previous in-process queue; every write now waits in the shared queue.
export const RECOVERY_TOOLS=Object.freeze({o11_studio:'bypass',ssam_task:'first'});
export function recoveryOf(tool,args={},holder=null) {
  if(tool==='ssam_task'&&args.close)return 'first';
  if(tool!=='o11_studio'||args.command!=='dismiss-dialog')return null;
  const title=typeof args.args==='object'&&!Array.isArray(args.args)?args.args?.title:null;
  const same=(a,b)=>String(a??'').trim().toLowerCase()===String(b??'').trim().toLowerCase();
  return isErrorReportTitle(title)||(title&&holder?.state==='stalled'&&same(title,holder.blockedBy?.title))?'bypass':null;
}
function resultValue(result) {
 if(result?.structuredContent)return result.structuredContent;
 try{return JSON.parse(result?.content?.find(c=>c.type==='text')?.text)}catch{return result}
}
async function bypassRecovery({target,tool,ctx,signal,studio},fn) {
 const begin=Date.now(),slot={...target,recovery:true,module:null};let turn;
 for(;;){
  if(signal?.aborted)return {refusal:{ok:false,code:CANCELLED_CODE,outcome:'not-sent',continuation:busyContinuation(studio)}};
  turn=acquire(slot,tool,ctx);if(turn.ok)break;
  if(Date.now()-begin>=5000)return {refusal:queueTimeoutRefusal({holder:turn.holder,waitedMs:Date.now()-begin,queueMs:5000,studio})};
  await nap(25,signal);
 }
 try{return {result:await owned.run([...(owned.getStore()??[]),{slot,lock:turn}],fn)}}finally{turn.release()}
}
export async function withStudioWriteLock({ tool, args = {}, lane, studioKey, deps = {}, onBusy, signal, write, phased, queue: _queue } = {}, fn) {
  if (!(write === true || isWrite(tool, args))) return fn();
  const ctx = { now: clock(deps.now), alive: deps.alive ?? processAlive, staleMs: deps.staleMs ?? STALE_MS };
  const key = studioWriteTarget({ tool, args, lane, studioKey, deps });
  // The slot of this write: its Studio key plus the module it names (C07); a record write (o11_data) has its own lane.
  const target = { ...key, module: key.lane.startsWith(DATA_LANE_PREFIX) ? null : moduleOrNull(moduleOfWrite(tool, args)) };
  const studio = { lane: target.lane === 'odc' ? 'odc' : 'o11', pid: args?.pid };
  const refuse = value => (onBusy ? onBusy(value) : value);
  const current=holderFor(target,ctx);
  const title=typeof args.args==='object'&&!Array.isArray(args.args)?args.args?.title:null;
  const matching=title?holderFor(target,ctx,h=>h.state==='stalled'&&String(h.blockedBy?.title??'').trim().toLowerCase()===String(title).trim().toLowerCase()):null;
  const mode=recoveryOf(tool,args,matching??current);
  const bypass=async()=>{
    const execution=await bypassRecovery({target,tool,ctx,signal,studio},fn);
    if(execution.refusal)return refuse(execution.refusal);
    const result=execution.result;
    const value=resultValue(result);
    if((value?.ok===true&&Array.isArray(value.closed)&&value.closed.length)||value?.code==='DIALOG_NOT_FOUND')clearStudioBlockedBy({target,title:args.args.title});
    return result;
  };
  if(mode==='bypass') return bypass();
  if(mode==='first') {
    const pending=pendingOperationOf({taskId:args.id,kernelTaskId:args.id,deps,lane});
    const running=typeof args.id==='string'?holderFor(target,ctx,h=>!String(h.tool).startsWith('bridge:')&&[h.taskId,h.kernelTaskId].includes(args.id)):null;
    const holder=running??pending;
    if(running||pending) {
      const next={tool:'ssam_task',arguments:{id:args.id},why:'Read the running task; it cannot be closed while its operation is pending.'};
      const recovery=holder.state==='stalled'?stallRecovery({verdict:'dialog',blockedBy:holder.blockedBy},next):[next];
      return refuse({ok:false,code:running?'TASK_STILL_RUNNING':'CLOSE_WAITS_FOR_PENDING_OPERATION',outcome:'not-sent',holder,recovery,continuation:recovery[0]});
    }
  }
  const own = queueLimitOf(tool, args);
  const limit = Number.isFinite(deps.queueMs) && deps.queueMs >= 0 ? deps.queueMs : Math.max(queueWaitMs(deps.env ?? process.env), own ?? 0);
  // A write inside a call that already holds this Studio runs at once (part of the holder). Inside a call still in its
  // build phase, it is that call's first Studio write: the call takes the Studio now and keeps it until it ends.
  const inside = (owned.getStore() ?? []).filter(e => conflicting(e.slot, target));
  if (inside.length) {
    const pending = inside.find(e => e.deferred && !e.lock);
    if (pending && !inside.some(e => !e.deferred || e.lock)) {
      const promoted = await pending.promote();
      if (promoted.ok === false) return refuse(promoted);
    }
    return fn();
  }
  if (phased === true && isPhased(tool, args) && !target.lane.startsWith(DATA_LANE_PREFIX))
    return runPhased({ target, tool, ctx, limit, signal, studio, refuse }, fn);
  const turn = await takeTurn({ target, tool, args, ctx, limit, signal, studio, priority:mode==='first' });
  if (!turn.ok && turn.bypass) return bypass();
  if (!turn.ok) return refuse(turn.value);
  let value;
  try { value = await owned.run([...(owned.getStore() ?? []), { slot: target, lock: turn.lock }], fn); } finally { turn.lock.release(); }
  return turn.queue ? withQueue(value, turn.queue) : value;
}

// ---- Build and apply phases (lane wp of the atritos 3 package; the owner's OML writer pool, 2026-10-07).
// Several agents of one person deliver to different modules of the SAME Studio at once, and several customers of the
// hosted server build at once. A delivery is two phases:
// - BUILD: everything that never touches the Studio model: the capture of the module by its key without selecting it,
//   the kernel apply and the ODC builder, headless, in the build pool (build-pool.mjs: SSAM_BUILD_WORKERS workers, FIFO
//   with fairness between customers, a private TEMP per worker). No Studio lock is held.
// - APPLY: merge, verify, publish. It takes the Studio lock and keeps it to the end of the call, in the same FIFO queue
//   as every other write of that Studio, so applies of one Studio never overlap and each one merges in seconds.
// The rule that makes it safe: a phased call (PHASED_TOOLS, passed phased:true by the ssam server) starts WITHOUT the
// Studio lock, and its first Studio write takes it: enterApplyPhase(), a guarded call (phaseGuard), or any nested
// withStudioWriteLock of the same Studio. From then on the call holds the Studio as any write does. A short Studio read
// that must not run beside a write of the same Studio (the ODC bridge serves one command at a time) runs in
// studioMoment(fn): it takes the Studio lock for fn only and gives it back.
// Two deliveries of the same module never build at the same time: a phased call first takes the build guard of its
// module (<lane>~b-<module tag>.guard beside the locks, FIFO in this process, the stale rules of the locks between
// processes) and keeps it to its end. The second one builds on top of the first one applied. The apply still checks the
// base its build saw: a module changed meanwhile (the person in the Studio) is rebuilt on the fresh capture in the same
// call (O11: Anvil.Core.Delivery.PrebuiltCandidate; ODC: odc-build-phase.mjs on BASE_DRIFT), never merged blind.
// The answer of a phased call that built carries phases {buildMs, queuedMs, applyMs, buildQueue?, moduleQueue?,
// rebased?} and so do the receipts the build named (notePhase {receipt}). A turn that does not come refuses with
// nothing run: STUDIO_WRITE_QUEUE_TIMEOUT (the Studio), BUILD_QUEUE_TIMEOUT (the module guard or the build pool).
export const BUILD_QUEUE_TIMEOUT_CODE = 'BUILD_QUEUE_TIMEOUT';
export const GUARD_SCHEMA = 'ssam-module-build-guard/1';
export const BUILD_WHY = 'another delivery of the same module (or the build pool) did not end within the limit; none of this one ran: read the Studio state and repeat the same delivery';
export const PHASED_TOOLS = Object.freeze({
  // A new delivery (and resume, closePrevious): its first Studio write takes the Studio. close alone and until=apply are
  // writes from their first call, so they keep the lock of the whole call.
  o11_deliver: a => a.close == null && (a.until ?? 'merge') === 'merge',
  studio_deliver: a => (a.until ?? 'merge') === 'merge',
});
// A handler that splits its delivery declares it in its registration: config._meta[PHASES_META] === true (the ssam server
// reads it in process, and through the ODC proxy from the listed tool). A handler that does not declare it holds the
// Studio for its whole call, as before: a write never runs unlocked because its handler does not know the phases.
export const PHASES_META = 'ssam/phases';
export const declaresPhases = config => config?._meta?.[PHASES_META] === true;
export function isPhased(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  return Object.hasOwn(PHASED_TOOLS, name) && isWrite(name, a) && PHASED_TOOLS[name](a) === true;
}

// The module build guard of a phased call: {ok:true, release, waitedMs, queue} or {ok:false, value}.
const guardsHeld = new Map(); // guard file -> token
const guardOwners = new Map(); // guard file -> {tool, pid, startedAt} of the delivery of this process that holds it
const guardLines = new Map(); // guard file -> waiters of this process, in arrival order
let guardExitHooked = false;
async function takeGuard({ target, tool, ctx, limit, signal, studio }) {
  const module = target.module;
  if (!module) return { ok: true, release: () => {}, waitedMs: 0, queue: null };
  const file = path.join(target.dir, target.lane + '~b-' + safe(module.key ?? module.name) + '.guard');
  const me = { token: randomUUID() };
  const line = guardLines.get(file) ?? [];
  guardLines.set(file, line);
  line.push(me);
  if (!guardExitHooked) { guardExitHooked = true; process.on('exit', () => { for (const [f, token] of guardsHeld) unlinkIfMine(f, token); guardsHeld.clear(); }); }
  let holder = null;
  const take = () => {
    if (line[0] !== me || guardsHeld.has(file)) return false;
    const record = { schema: GUARD_SCHEMA, pid: process.pid, tool: String(tool), startedAt: new Date(ctx.now()).toISOString(), lane: target.lane, token: me.token };
    guardsHeld.set(file, me.token);
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      if (create(file, record)) { guardOwners.set(file, holderOf({ record })); return true; }
      // Another process holds the guard; a stale one (dead pid, too old, this pid without holding it) is broken.
      const other = readLock(file);
      if (other && (!staleRecord(other, ctx, 'startedAt', r => r.token === me.token) || !breakStale(file, other.raw))) { holder = holderOf(other); guardsHeld.delete(file); return false; }
      if (create(file, record)) { guardOwners.set(file, holderOf({ record })); return true; }
      holder = holderOf(readLock(file)); guardsHeld.delete(file); return false;
    } catch { guardOwners.set(file, holderOf({ record })); return true; } // the folder cannot be written: the in-process line still orders this process's deliveries
  };
  const started = Date.now();
  let position = null, step = NAP_FIRST, taken = false, firstHolder = null;
  const release = () => {
    if (guardsHeld.get(file) === me.token) { guardsHeld.delete(file); guardOwners.delete(file); unlinkIfMine(file, me.token); }
    const at = line.indexOf(me); if (at >= 0) line.splice(at, 1);
    if (!line.length) guardLines.delete(file);
    changed();
  };
  try {
    for (;;) {
      if (take()) { taken = true; break; }
      // The deliveries of this process ahead (the holder among them) and a holder in another process.
      const ahead = Math.max(0, line.indexOf(me)) + (holder && !guardsHeld.has(file) ? 1 : 0);
      position ??= Math.max(1, ahead);
      if (guardsHeld.has(file) && guardOwners.has(file)) holder = guardOwners.get(file);
      firstHolder ??= holder;
      if (signal?.aborted) return { ok: false, value: { ok: false, code: CANCELLED_CODE, outcome: 'not-sent', error: 'The call was cancelled while it waited for another delivery of the same module; nothing ran.',
        position, waitedMs: Date.now() - started, continuation: busyContinuation(studio) } };
      const left = started + limit - Date.now();
      if (left <= 0) return { ok: false, value: { ok: false, code: BUILD_QUEUE_TIMEOUT_CODE, outcome: 'not-sent', waitedFor: 'module',
        error: 'This delivery waited ' + Math.round((Date.now() - started) / 1000) + ' s for another delivery of the same module to end and its turn did not come; nothing of it ran.',
        holder: holder ? { tool: holder.tool ?? null, pid: holder.pid ?? null, startedAt: holder.startedAt ?? null } : null, position, waitedMs: Date.now() - started, queueMs: limit,
        continuation: busyContinuation(studio, BUILD_WHY) } };
      await nap(Math.min(step, left), signal);
      step = Math.min(step * 2, NAP_MAX);
    }
  } finally { if (!taken) release(); }
  const waitedMs = Date.now() - started;
  // A delivery that waited for another one of its module is told so as a write that waited its turn: queue {position,
  // waitedMs, holder}.
  return { ok: true, release, waitedMs, queue: position != null ? { position, waitedMs, holder: firstHolder } : null };
}

// The answer of a phased call (see withQueue): its own result with the given fields added in one place.
export function withFields(result, fields) {
  const entries = Object.entries(fields ?? {}).filter(([, v]) => v != null);
  if (!entries.length || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  const extra = Object.fromEntries(entries);
  if (!Array.isArray(result.content)) return { ...result, ...extra };
  const structured = result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
    ? { ...result.structuredContent, ...extra } : result.structuredContent;
  let placed = false;
  const content = result.content.map((c, i) => {
    if (i !== 0 || c?.type !== 'text' || !/^\s*\{/.test(c.text ?? '')) return c;
    try { const value = JSON.parse(c.text); if (value && typeof value === 'object' && !Array.isArray(value)) { placed = true; return { ...c, text: JSON.stringify({ ...value, ...extra }) }; } } catch { /* plain text */ }
    return c;
  });
  if (!placed) content.push({ type: 'text', text: JSON.stringify(extra) });
  return { ...result, content, ...(structured !== undefined ? { structuredContent: structured } : {}) };
}

function phasesOf(p, end) {
  const momentWaitMs = p.momentWaitMs ?? 0;
  const studioWaitMs = p.promoteAt != null ? (p.acquiredAt ?? end) - p.promoteAt : 0;
  const buildMs = Math.max(0, (p.promoteAt ?? end) - p.startedAt - p.guardWaitMs - p.poolWaitMs - momentWaitMs);
  return { buildMs, queuedMs: p.guardWaitMs + p.poolWaitMs + momentWaitMs + studioWaitMs, applyMs: p.acquiredAt != null ? end - p.acquiredAt : 0,
    ...(p.buildQueue ? { buildQueue: p.buildQueue } : {}), ...(p.moduleQueue ? { moduleQueue: p.moduleQueue } : {}), ...(p.rebased ? { rebased: p.rebased } : {}) };
}
// The receipts a build named get the phases too: a JSON object file gets the field, any other path becomes {phases}.
function stampReceipts(files, phases) {
  for (const file of new Set(files)) {
    try {
      let value = null;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { value = null; }
      const next = value && typeof value === 'object' && !Array.isArray(value) ? { ...value, phases } : { schema: 'ssam-delivery-phases/1', phases };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2));
    } catch { /* a receipt that cannot be written never changes the answer */ }
  }
}

async function runPhased({ target, tool, ctx, limit, signal, studio, refuse }, fn) {
  if (signal?.aborted) return refuse({ ok: false, code: CANCELLED_CODE, outcome: 'not-sent', error: 'The call was cancelled before it started; nothing ran.', continuation: busyContinuation(studio) });
  const startedAt = Date.now();
  const guard = await takeGuard({ target, tool, ctx, limit, signal, studio });
  if (!guard.ok) return refuse(guard.value);
  const phase = { startedAt, guardWaitMs: guard.waitedMs, poolWaitMs: 0, promoteAt: null, acquiredAt: null, queue: null, refusal: null,
    built: false, rebased: null, buildQueue: null, moduleQueue: guard.queue ? { position: guard.queue.position, waitedMs: guard.queue.waitedMs } : null, receipts: [] };
  const entry = { slot: target, lock: null, deferred: true, tool: String(tool), phase };
  let promoting = null;
  entry.promote = () => promoting ??= (async () => {
    phase.promoteAt = Date.now();
    const turn = await takeTurn({ target, tool, ctx, limit, signal, studio });
    if (!turn.ok) { phase.refusal = turn.value; return turn.value; }
    entry.lock = turn.lock; if(entry.holderFields)entry.lock.note(entry.holderFields); phase.acquiredAt = Date.now(); phase.queue = turn.queue;
    return { ok: true, phased: true, promoted: true };
  })();
  // A short Studio read of the build phase: the Studio lock for read() only (writes nested in it are part of it).
  entry.moment = async read => {
    if (entry.lock || promoting) { const promoted = await entry.promote(); return promoted.ok === false ? promoted : read(); }
    const begin = Date.now();
    const turn = await takeTurn({ target, tool, ctx, limit, signal, studio });
    phase.momentWaitMs = (phase.momentWaitMs ?? 0) + (Date.now() - begin);
    if (!turn.ok) return turn.value;
    try { return await owned.run([...(owned.getStore() ?? []), { slot: target, lock: turn.lock }], read); } finally { turn.lock.release(); }
  };
  let value;
  try { value = await owned.run([...(owned.getStore() ?? []), entry], fn); }
  finally { entry.lock?.release(); guard.release(); }
  const phases = phasesOf(phase, Date.now());
  if (phase.built || phase.rebased) stampReceipts(phase.receipts, phases);
  // The Studio turn did not come: nothing after the build reached the Studio, whatever fn made of the refusal.
  if (phase.refusal) return refuse({ ...phase.refusal, ...(phase.built ? { phases } : {}) });
  return withFields(value, { queue: phase.queue ?? guard.queue, phases: phase.built || phase.rebased ? phases : null });
}

const currentPhased = () => [...(owned.getStore() ?? [])].reverse().find(e => e?.deferred) ?? null;
// The phase of the current call: null outside a phased call; else {promoted, tool}.
export function phaseOfCall() {
  const entry = currentPhased();
  return entry ? { promoted: Boolean(entry.lock), tool: entry.tool } : null;
}
// The first Studio write of a phased call: the call takes the Studio now (FIFO queue) and keeps it to its end.
// {ok:true, phased:false} outside a phased call; {ok:true, phased:true, promoted:true}; or the refusal (nothing ran).
export async function enterApplyPhase() {
  const entry = currentPhased();
  if (!entry) return { ok: true, phased: false };
  if (entry.lock) return { ok: true, phased: true, promoted: true };
  return entry.promote();
}
// A short Studio read of the build phase (see the header); outside a phased call, or once it applies, read() as is.
export async function studioMoment(read) {
  const entry = currentPhased();
  return entry && !entry.lock ? entry.moment(read) : read();
}
// What the build tells the answer: built (a build phase ran), poolWaitMs (added), buildQueue {position, waitedMs},
// rebased {reason} (the base moved and the apply rebuilt), receipt (a file that gets the phases). False outside.
export function notePhase(fields = {}) {
  const entry = currentPhased();
  if (!entry) return false;
  const p = entry.phase;
  if (fields.built === true) p.built = true;
  if (Number.isFinite(fields.poolWaitMs)) p.poolWaitMs += Math.max(0, fields.poolWaitMs);
  if (fields.buildQueue) p.buildQueue = fields.buildQueue;
  if (fields.rebased) p.rebased = fields.rebased;
  if (typeof fields.receipt === 'string' && fields.receipt) p.receipts.push(fields.receipt);
  return true;
}
// A Studio turn that did not come, thrown by a guarded call; the phased wrapper answers the refusal itself.
export class StudioTurnRefused extends Error {
  constructor(value) { super(value?.error ?? 'The turn of this write in the Studio queue did not come; nothing ran.'); this.name = 'StudioTurnRefused'; this.code = value?.code; this.refusal = value; }
}
// fn reaches the Studio. In a phased call, a call isBuild(...args) does not accept runs only once the call holds the
// Studio (enterApplyPhase); outside one, fn as is.
export function phaseGuard(fn, isBuild = () => false) {
  return async (...args) => {
    if (!isBuild(...args)) { const entered = await enterApplyPhase(); if (entered.ok === false) throw new StudioTurnRefused(entered); }
    return fn(...args);
  };
}

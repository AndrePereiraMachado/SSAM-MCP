// Window 4x4 (review S1 M2 and B10, C:\t\r5\janela-4x4\S1-REVISAO.md): the resident O11 readers of a multi-O11 backend.
// reader-client.mjs keeps one detached `read-serve` per reader generation (<cacheRoot>/<platform>/<generation>), and the
// generation hashes the CLI folder and the Studio folder: on a multi-O11 image every Service Studio version a customer
// brings gets its own resident reader (up to four per backend), each holding its version's model assemblies and the
// capture it read, alive 15 min after its last read (SnapshotReadServer.cs). Those starts were outside the memory gate
// (memory-room.mjs) and outside the r45 capacity model. On a multi-O11 image (only there; a pair image keeps its one
// reader as before) a new reader generation now:
//   1. evicts first: the live readers of the same platform beyond SSAM_O11_READERS_MAX - 1 are asked to shut down, least
//      recently used first, only idle ones (ping: not busy, nothing queued); the shutdown is the reader's own queued
//      command (WorkerServer.cs), so a read in flight always finishes. A reader that serves now is never stopped: the
//      start then relies on the gate alone;
//   2. drops the copies of retired versions (B10): a generation folder whose recorded Studio folder is no longer in the
//      image (reader.json runtimeDir) and whose reader is not live loses its bin copy and folder;
//   3. is admitted by the memory gate of the process with SSAM_MEMORY_RESERVE_READER_MB (default 800, not measured yet:
//      the first-deploy kit measures it, S1-KIT-PLANO.md), its pid attached until its first read answered; a wait that
//      runs out refuses the read, nothing started (memoryWaitRefusal, waitedFor memory).
// SSAM_O11_READERS_MAX (>= 1): the compose sets it per tier (gen-compose sizing o11Readers: other 1, hot 2). Unset, it
// follows the container's limit: 1 under 8 GiB, 2 from 8 GiB on, every kernel of the image without a readable limit.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_READER_RESERVE_MB = 800;
export const READER_META = 'reader.json';
export const LAST_READ = 'last-read';
const GIB = 1024 * 1024 * 1024;

const integer = (value, min) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : null;
};
// The container's memory limit in bytes (cgroup v2 memory.max), or null (no limit, not Linux, unreadable).
export function containerLimitBytes({ platform = process.platform, readFile = fs.readFileSync, root = '/sys/fs/cgroup' } = {}) {
  if (platform !== 'linux') return null;
  try { const max = String(readFile(root + '/memory.max', 'utf8')).trim(); return /^\d+$/.test(max) ? Number(max) : null; } catch { return null; }
}
// {max, reserveMb}: how many O11 readers may stay resident on this backend and what a new one reserves in the gate.
export function readerResidency({ env = process.env, versions = 1, limitBytes = containerLimitBytes() } = {}) {
  const explicit = integer(env.SSAM_O11_READERS_MAX, 1);
  const max = explicit ?? (Number.isFinite(limitBytes) ? (limitBytes >= 8 * GIB ? 2 : 1) : Math.max(1, versions));
  return { max, reserveMb: integer(env.SSAM_MEMORY_RESERVE_READER_MB, 0) ?? DEFAULT_READER_RESERVE_MB, source: explicit ? 'env' : Number.isFinite(limitBytes) ? 'limit' : 'image' };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const mtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
// What a generation folder records of its reader: the Studio folder and CLI it was started over.
export function writeReaderMeta(directory, { dll, runtimeDir }) {
  try { fs.writeFileSync(path.join(directory, READER_META), JSON.stringify({ dll, runtimeDir, at: new Date().toISOString() })); } catch { /* best effort */ }
}
export function touchLastRead(directory) {
  try { fs.writeFileSync(path.join(directory, LAST_READ), String(Date.now())); } catch { /* best effort */ }
}

// The readers of one platform folder other than `keep`: [{directory, state, live, busy, lastRead, rssMb, runtimeDir}].
// rpc(state, args, authorization, timeoutMs): reader-client.mjs readerRpc.
export async function residentReaders(platformDir, { keep = null, rpc }) {
  let names = [];
  try { names = fs.readdirSync(platformDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  const out = [];
  for (const name of names) {
    const directory = path.join(platformDir, name);
    if (keep && path.resolve(directory) === path.resolve(keep)) continue;
    let state = null, meta = null;
    try { state = readJson(path.join(directory, 'worker.json')); } catch { state = null; }
    try { meta = readJson(path.join(directory, READER_META)); } catch { meta = null; }
    let ping = null;
    if (state?.port) { try { ping = await rpc(state, ['ping'], null, 1000); } catch { ping = null; } }
    const live = ping?.ok === true && ping.data?.instanceId === state.instanceId && !ping.data?.recycling;
    out.push({ directory, state, live, busy: live && (ping.data.busy === true || (ping.data.queued ?? 0) > 0),
      lastRead: Math.max(mtime(path.join(directory, LAST_READ)), mtime(path.join(directory, 'worker.json'))),
      rssMb: live && Number.isFinite(ping.data.workingSetMB) ? ping.data.workingSetMB : null, runtimeDir: meta?.runtimeDir ?? null });
  }
  return out;
}

// Before a new reader generation starts in `keep`: evicts idle live readers (least recently used first) until at most max-1
// stay, and removes the folders of retired versions (a recorded Studio folder not among `servedDirs`, no live reader, no
// starter). Returns {evicted: [{generation, rssMb}], kept: n, pruned: [generation]}. Never throws.
export async function makeRoom(platformDir, { keep, max, rpc, authorization, servedDirs = null, remove = dir => fs.rmSync(dir, { recursive: true, force: true }) }) {
  const evicted = [], pruned = [];
  let readers = [];
  try { readers = await residentReaders(platformDir, { keep, rpc }); } catch { return { evicted, kept: 0, pruned }; }
  const served = servedDirs ? new Set(servedDirs.map(d => path.resolve(d))) : null;
  for (const r of readers) {
    if (r.live || !served || !r.runtimeDir || served.has(path.resolve(r.runtimeDir))) continue;
    if (fs.existsSync(path.join(r.directory, 'start.lock'))) continue;
    try { remove(r.directory); pruned.push(path.basename(r.directory)); } catch { /* left for the next start */ }
  }
  const live = readers.filter(r => r.live).sort((a, b) => a.lastRead - b.lastRead);
  let count = live.length;
  for (const r of live) {
    if (count <= max - 1) break;
    if (r.busy) continue;
    try { await rpc(r.state, ['shutdown'], authorization, 5000); evicted.push({ generation: path.basename(r.directory), rssMb: r.rssMb }); count--; }
    catch { /* it may have gone already: the gate still decides */ }
  }
  return { evicted, kept: count, pruned };
}

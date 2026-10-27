// The resident Anvil worker of each job lane (`dotnet <cli> serve --port p --log-dir <local>`), driven from the
// facade's own process: ported from kernel/scripts/anvil_cli.py (O11), odc_worker.py (ODC) and worker_process.py
// (startup lock), so no Python runs. Protocol (kernel src/Anvil.Core/Hosting/WorkerServer.cs): one JSON line
// {args, authorization} in, one envelope line out, on 127.0.0.1. `ping` needs no key and answers the status
// (protocol, instanceId, pid, busy, queued, recycling, studio); any other command needs the trusted-controller key
// (bridge.key, readAuthorityKey), else the worker answers {ok:false, executed:false} and nothing ran.
//
// | Lane | CLI                                    | Port                                              | Folder            |
// |------|----------------------------------------|---------------------------------------------------|-------------------|
// | o11  | <lane local>/cli/anvil.dll (o11-lane)  | ANVIL_WORKER_PORT, else workers.o11<lane>         | <lane local>      |
// | odc  | .local/lane-odc/cli/anvil-odc.dll      | ANVIL_ODC_PORT, else workers.odc (4547 without it) | .local/lane-odc   |
//
// Rules kept from the Python clients:
//   - retry only when nothing executed: the connection was refused before a byte was written, or the worker answered
//     {retryable:true, executed:false} (it was recycling); never once the request line was written (unknown outcome);
//   - a worker is reused only when its ping `studio` is the selected installation (ANVIL_STUDIO_DIR of the lane
//     environment for O11, ANVIL_ODC_STUDIO_DIR for ODC). The O11 selection is the one lanes.py makes: the connection
//     record (<root>/.local/connections/<lane>.json, written by ssam_connect) first, then ANVIL_STUDIO_DIR, then the
//     lane's own copy when it exists (laneEnvironment). A worker of another installation on the lane's port is recycled
//     when idle (stopWorker) and started again for the selected one; a busy one serves nobody here: the call runs cold;
//   - stopping a worker (stale kernel, other installation) asks it to shut down; a process that accepted and is still
//     alive 10 s later, with the creation time it had when its ping named it on this port, is terminated and waited
//     for (kernel/scripts/anvil_worker.py stop does the same); a pid whose creation time changed is never touched;
//   - starting one takes the startup lock file of worker_process.py (<local>/worker-<port>.lock, which names the process
//     instance: a lock of an earlier process with the same pid, of another boot or of a reused pid is left over), launches it detached
//     and waits for its ping. There is no event that says "listening" outside the worker's own log, so the ping is
//     consulted with backoff (250 ms doubling to 1 s) until a deadline (25 s O11, 90 s ODC) or until the child exits;
//   - a worker that loaded a kernel older than the CLI on disk is shut down and restarted when idle, served (with a
//     warning) when busy; its age comes from the record of a successful ping (worker_process.remember, or ours);
//   - reads/recovery can avoid a busy or queued worker using its existing ensure status (no extra ping); a race
//     after that status is accepted, with the returned queuedMs exposed as workerQueuedMs by the runner;
//   - ANVIL_WORKER=0 (both lanes) and ANVIL_ODC_NO_WORKER (ODC) always run cold.
// Hosted (executor.mjs), the O11 lane's worker above is off; each customer may get a resident O11 worker of its own,
// started in the background with that customer's hosted spawn environment plus the pool's memory profile
// (HostedO11Workers, at the end of this file).
// Out of scope, on purpose: the worker pool (worker_pool.py: several workers, reservation, base affinity) stays
// Python-only and is never used from here; a port that accepts connections but does not answer the ping is left
// alone (no pid to verify) and the job runs cold; the stale-deploy warning of anvil_cli.py (sources newer than .local/cli).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { anvilRoot, workspaceRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf, readAuthorityKey } from './o11-lane.mjs';
import { laneEnvironment, createAnvilRunner } from './anvil-cli.mjs';
import { hostedContext, hostedSpawnEnv, onHostedContextClose, usesWorkspace } from './executor.mjs';
import { kernelStart } from './quality-meter.mjs';
import { withTraceArgs } from './correlation.mjs';

export const WORKER_PROTOCOL = 'anvil-worker-1';
const MAX_REPLY_BYTES = 256 * 1024 * 1024;
const EPOCH_FILETIME = 11644473600; // seconds between 1601-01-01 (FILETIME) and 1970-01-01 (Unix)
const STALE_LOCK_SECONDS = 300;     // no startup waits this long: an older lock is left over
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const portOf = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback; };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const sameDir = (a, b) => { const n = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)); return n(a) === n(b); };

// Hosted (executor.mjs), the O11 lane's worker is off: its process would keep this server's environment and Studio (a
// customer's calls go to that customer's own worker instead, hostedWorkerClient). The ODC worker is a shared process of
// the server that never talks to a Studio, so it stays.
export const workerDisabled = (lane, env = process.env) => env.ANVIL_WORKER === '0' || (lane === 'odc' && Boolean(env.ANVIL_ODC_NO_WORKER))
  || (lane === 'o11' && hostedContext() !== null);
const odcPort = workspace => portOf(readJson(path.join(workspace, '.ssam-workspace.json'))?.workers?.odc, 4547);

// Where one lane's worker lives and what it must serve. env is the caller's environment, never mutated. laneEnv: the O11
// child environment (default laneEnvironment, which reads the connection record; a check passes the lane's own).
export function workerTarget(lane, { root = anvilRoot, workspace = workspaceRoot, env = process.env, o11 = o11Lane.lane, pingMs = 3000, laneEnv = laneEnvironment } = {}) {
  if (lane === 'o11') {
    const row = o11LaneOf(o11, { root, workspace, env });
    const childEnv = laneEnv({ lane: row.name, root, env });
    const studio = childEnv.ANVIL_STUDIO_DIR || row.studioDir;
    return { lane, port: portOf(env.ANVIL_WORKER_PORT, row.worker), local: row.local, root, cli: row.cli, env: childEnv,
      selectedStudio: childEnv.ANVIL_STUDIO_DIR || null, timeoutMs: 900000, waitMs: 25000, pingMs, disabled: workerDisabled(lane, env),
      // anvil_cli.ensure_worker: without the installation's framework the worker cannot start; cold gives the exact error.
      studioReady: () => fs.existsSync(path.join(studio, 'ServiceStudio.Framework.dll')),
      key: () => readAuthorityKey({ env: childEnv }) };
  }
  if (lane === 'odc') {
    const local = path.join(root, '.local', 'lane-odc');
    return { lane, port: portOf(env.ANVIL_ODC_PORT, odcPort(workspace)), local, root, cli: path.join(local, 'cli', 'anvil-odc.dll'), env: { ...env },
      selectedStudio: env.ANVIL_ODC_STUDIO_DIR || null, timeoutMs: 600000, waitMs: 90000, pingMs, disabled: workerDisabled(lane, env),
      studioReady: () => true, key: () => readAuthorityKey({ env }) };
  }
  throw new Error(`Unknown job lane '${lane}'; lanes: o11, odc`);
}

// One request on its own connection; never rejects. sent:false means no byte was written (refused:true when the port
// refused it); sent:true with reply, or with error when the outcome is unknown.
export function workerRequest({ port, host = '127.0.0.1', authorization, timeoutMs = 3000, maxBytes = MAX_REPLY_BYTES }, args) {
  const command = String(args[0] ?? '?');
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const chunks = []; let size = 0; let settled = false; let sent = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ sent, code: 'WORKER_TIMEOUT', error: `worker ${command} timed out after ${timeoutMs} ms` }), timeoutMs);
    socket.on('error', error => finish({ sent, refused: !sent && error.code === 'ECONNREFUSED', code: error.code === 'ECONNREFUSED' ? 'WORKER_NOT_LISTENING' : 'WORKER_TRANSPORT', error: error.message }));
    socket.on('connect', () => {
      const line = { args: args.map(String), ...(authorization !== undefined ? { authorization } : {}) };
      socket.write(JSON.stringify(line) + '\n'); sent = true;
    });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return finish({ sent: true, code: 'WORKER_REPLY_TOO_LARGE', error: `worker ${command} reply exceeded ${maxBytes} bytes` });
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { chunks.push(chunk); return; }
      chunks.push(chunk.subarray(0, newline));
      try { finish({ sent: true, reply: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch { finish({ sent: true, code: 'WORKER_PROTOCOL', error: 'unexpected service on the worker port' }); }
    });
    socket.on('close', () => finish({ sent, code: 'WORKER_NO_REPLY', error: `worker closed ${command} without a reply` }));
  });
}

// The status of the worker on the target port, or null. Ping carries no key: the worker never asks one for it.
export async function ping(target, timeoutMs = target.pingMs ?? 3000) {
  const r = await workerRequest({ port: target.port, timeoutMs }, ['ping']);
  return r.reply?.ok === true && r.reply.data && typeof r.reply.data === 'object' ? r.reply.data : null;
}
export const studioMatches = (status, selected) => !selected || (typeof status?.studio === 'string' && status.studio !== '' && sameDir(status.studio, selected));

// When the worker process started, in Unix seconds, from a record of a successful ping with the same instance:
// worker_process.remember (pid creation FILETIME, Windows) or ours (launch time, never later than the real start).
function startedAt(target, status) {
  const python = readJson(path.join(target.local, `worker-${target.port}.json`));
  if (process.platform === 'win32' && python?.instanceId === status.instanceId && python?.pid === status.pid && /^\d+$/.test(String(python?.birth ?? '')))
    return Number(python.birth) / 1e7 - EPOCH_FILETIME;
  const own = readJson(path.join(target.local, `worker-${target.port}.node.json`));
  return own?.instanceId === status.instanceId && own?.pid === status.pid && Number.isFinite(own?.startedUnix) ? own.startedUnix : null;
}
// The worker loads the kernel once; a CLI rebuilt after it started is not what it serves (anvil_cli._kernel_mais_novo_que).
export function staleKernel(target, status) {
  try { const born = startedAt(target, status); return born !== null && fs.statSync(target.cli).mtimeMs / 1000 > born + 1; }
  catch { return false; }
}
function remember(target, status, launchedMs) {
  if (status?.protocol !== WORKER_PROTOCOL || !Number.isInteger(status.pid)) return;
  try { fs.writeFileSync(path.join(target.local, `worker-${target.port}.node.json`), JSON.stringify({ pid: status.pid, instanceId: status.instanceId, startedUnix: launchedMs / 1000 })); }
  catch { /* a record is a convenience: the ping stays the truth */ }
}

// Poll check() with backoff 250 ms -> 1 s until it is true, the deadline passes or `wake` settles (a child exit).
async function until(check, waitMs, { now = Date.now, wake = null } = {}) {
  const deadline = now() + waitMs; let delay = 250;
  for (;;) {
    if (await check()) return true;
    if (now() >= deadline) return false;
    await Promise.race([sleep(Math.min(delay, Math.max(0, deadline - now()))), ...(wake ? [wake] : [])]);
    delay = Math.min(delay * 2, 1000);
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const listening = port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const done = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
  const timer = setTimeout(() => done(false), 500);
  socket.on('connect', () => done(true)); socket.on('error', () => done(false));
});

// The identity of a live process: its creation time (Windows: the FILETIME GetProcessTimes reports, the value
// worker_process.birth reads; elsewhere the start field of /proc/<pid>/stat) and its image name, or null when it cannot
// be read (gone, access denied). Two reads of the same process agree; a pid reused by another process does not.
export function processIdentity(pid, { execFileFn = execFile, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (platform !== 'win32') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const birth = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      return Promise.resolve(birth ? { birth, name } : null);
    } catch { return Promise.resolve(null); }
  }
  const script = `try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); '' + $p.StartTime.ToFileTimeUtc() + ' ' + $p.ProcessName } catch { '' }`;
  return new Promise(resolve => execFileFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => {
      const match = /^(\d+) (\S+)$/.exec(String(stdout ?? '').trim());
      resolve(!error && match ? { birth: match[1], name: match[2] } : null);
    }));
}
// The worker runs as `dotnet <cli> serve` (launch here and in worker_process.py): only such a process is ever terminated.
const WORKER_IMAGES = /^(dotnet|anvil|anvil-odc)(\.exe)?$/i;

// stop(): the worker the ping named on this port (status.pid) is asked to shut down. When it accepted and its process
// is still alive after waitMs (10 s), with the identity it had before the request (same creation time, a dotnet image),
// that pid is terminated and its exit waited for (anvil_worker.py stop). A pid whose identity changed or cannot be read
// is never terminated. -> {stopped:true[, terminated:pid]} | {stopped:false, note}. deps: identity, alive, kill (tests).
export async function stopWorker(target, status, deps = {}) {
  const { now = Date.now, identity = processIdentity, alive: isAlive = alive, kill = pid => process.kill(pid), waitMs = 10000, exitMs = 10000 } = deps;
  const port = target.port; const pid = Number(status?.pid);
  const known = Number.isSafeInteger(pid) && pid > 0;
  const before = known ? await identity(pid) : null;
  const r = await workerRequest({ port, authorization: target.key() ?? null, timeoutMs: 60000 }, ['shutdown']);
  if (r.reply?.ok !== true) return { stopped: false, note: `the worker on port ${port} did not accept the shutdown (${String(r.reply?.error ?? r.error ?? 'no reply').slice(0, 160)}); nothing was stopped` };
  // The port closes first and the process may outlive it (a thread that never ends): the process itself is waited for.
  const gone = async () => (!known || !isAlive(pid)) && (await ping(target, 500)) === null;
  if (await until(gone, waitMs, { now })) return { stopped: true };
  const after = before ? await identity(pid) : null;
  if (before && after && after.birth === before.birth && after.name === before.name && WORKER_IMAGES.test(before.name)) {
    try { kill(pid); } catch (error) { return { stopped: false, note: `worker pid ${pid} accepted the shutdown, is still alive and could not be terminated (${error.message})` }; }
    if (await until(gone, exitMs, { now })) return { stopped: true, terminated: pid };
    return { stopped: false, note: `worker pid ${pid} was terminated after accepting the shutdown but has not exited yet` };
  }
  // Its process is gone (or the pid now names another process): stopped once nothing answers on the port.
  const replaced = before && (!after || after.birth !== before.birth);
  if (replaced && (await ping(target, 500)) === null) return { stopped: true };
  const why = !before ? 'its process could not be verified' : replaced ? 'another process answers on the port' : 'its process is not a worker image';
  return { stopped: false, note: `the worker on port ${port} accepted the shutdown but is still there after ${Math.round(waitMs / 1000)} s; ${why}, so nothing was terminated` };
}

// The identity of this process instance, named in every startup lock it writes (item 2 of the 24th rehearsal,
// C:\t\r24f\ENSAIO-24.md): under docker-init the server is always pid 7, so a lock {pid:7, owner:'node', birth:null} left by
// a server stopped during its warm-up looked alive to the next server (pid 7 again): the warm-up ended after 90 s with
// "worker startup lock did not clear" and the first ODC call waited until the lock was STALE_LOCK_SECONDS old. Now the
// lock carries a random instance id, the start time of the process as the kernel counts it (Linux: the start field of
// /proc/self/stat, the value worker_process.birth writes, so worker_process.py tells a reused pid apart too) and the boot
// id of the host (/proc/sys/kernel/random/boot_id, the same in every container of one boot).
const INSTANCE = randomUUID();
// The start time of a process (field 22 of /proc/<pid>/stat, clock ticks after boot), or null (Windows, gone, no /proc).
export function procBirth(pid, { read = fs.readFileSync } = {}) {
  try { const stat = String(read(`/proc/${pid}/stat`, 'utf8')); return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null; }
  catch { return null; }
}
// The boot id of the running kernel, or null (Windows, no /proc).
export function bootId({ read = fs.readFileSync } = {}) {
  try { return String(read('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null; } catch { return null; }
}
let own = null;
export const selfInstance = () => (own ??= { pid: process.pid, instance: INSTANCE,
  birth: process.platform === 'win32' ? null : procBirth('self'), boot: process.platform === 'win32' ? null : bootId() });
// Whether the startup lock of another starter is left over: older than any startup; written in another boot of the host;
// written by an earlier process that had this very pid (pid 7 under docker-init: that process is gone, this one has its
// pid); its owner is gone; or its pid now names another process (Linux: another start time). A lock of this same instance
// (a second start inside this process) and a live owner are not. null (its owner is still writing it) is not.
// deps: self, now, alive, birthOf, platform (tests).
export function lockLeftOver(owner, { self = selfInstance(), now = Date.now, alive: isAlive = alive, birthOf = procBirth, platform = process.platform } = {}) {
  if (!owner || typeof owner !== 'object') return false;
  if (now() / 1000 - Number(owner.created) > STALE_LOCK_SECONDS) return true;
  if (owner.boot && self.boot && owner.boot !== self.boot) return true;
  const pid = Number(owner.pid);
  if (pid === self.pid) return owner.instance !== self.instance;
  if (!isAlive(pid)) return true;
  if (platform !== 'win32' && typeof owner.birth === 'string' && owner.birth) {
    const birth = birthOf(pid);
    if (birth !== null && birth !== owner.birth) return true;
  }
  return false;
}

// worker_process.startup_lock: one starter per port, across Python and Node. A lock that is left over (lockLeftOver: its
// owner gone, another instance with this pid, another boot, a reused pid, or older than any startup) is removed; a live
// owner is waited for with the same backoff until the deadline. identity: lockLeftOver's deps (tests).
export async function withStartupLock(local, port, waitMs, fn, { now = Date.now, ...identity } = {}) {
  fs.mkdirSync(local, { recursive: true });
  const file = path.join(local, `worker-${port}.lock`);
  const self = identity.self ?? selfInstance();
  const token = { pid: self.pid, birth: self.birth, created: now() / 1000, owner: 'node', instance: self.instance, boot: self.boot };
  let free = false;
  const take = () => {
    try { fs.writeFileSync(file, JSON.stringify(token), { flag: 'wx', mode: 0o600 }); return (free = true); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = readJson(file); // null while its owner is still writing it
    if (lockLeftOver(owner, { now, ...identity, self })) { try { fs.unlinkSync(file); } catch { /* raced */ } return take(); }
    return false;
  };
  if (!(await until(take, waitMs, { now })) || !free) return { locked: false, note: `worker startup lock did not clear: ${file}` };
  try { return { locked: true, value: await fn() }; }
  finally { try { if (JSON.stringify(readJson(file)) === JSON.stringify(token)) fs.unlinkSync(file); } catch { /* already gone */ } }
}

function launch(target, spawnFn) {
  fs.mkdirSync(target.local, { recursive: true });
  // The worker writes its own log (worker-<port>-<pid>.log); this file only catches startup failures.
  const log = fs.openSync(path.join(target.local, `worker-${target.port}-startup.log`), 'a');
  try {
    const child = spawnFn('dotnet', [target.cli, 'serve', '--port', String(target.port), '--log-dir', target.local],
      { cwd: target.root, env: target.env, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref?.();
    return child;
  } finally { fs.closeSync(log); }
}

// The worker on the target port is up and serves the selected Studio: {status}; else {status:null, note} and the
// caller runs cold. warning: it serves an older kernel because it is busy. A worker of another installation (C35) or of
// an older kernel is stopped when idle (stopWorker) and a new one started for the selected installation; when busy, the
// other installation's worker serves nobody here (cold) and the older kernel serves with the warning.
// deps: spawnFn, now, and stopWorker's identity/alive/kill/waitMs/exitMs (tests: never a real process).
export async function ensureWorker(target, deps = {}) {
  const { spawnFn = spawn, now = Date.now } = deps;
  const port = target.port;
  const otherStudio = (s, why = 'ran cold') => ({ status: null, note: `the worker on port ${port} serves ${s.studio ?? 'an unknown installation'}, not ${target.selectedStudio}; ${why}` });
  let status = await ping(target);
  if (status && !studioMatches(status, target.selectedStudio)) {
    if (status.busy || status.queued || status.recycling) return otherStudio(status, 'it is busy, so it was left running; ran cold');
    const stopped = await stopWorker(target, status, { now, ...deps });
    if (!stopped.stopped) return otherStudio(status, stopped.note + '; ran cold');
    status = null;
  }
  if (status && !status.recycling) {
    if (!staleKernel(target, status)) return { status };
    if (status.busy || status.queued) return { status, warning: `the worker on port ${port} loaded a kernel older than ${path.basename(target.cli)} and is busy; it served this request` };
    const stopped = await stopWorker(target, status, { now, ...deps });
    if (!stopped.stopped) return { status: null, note: `the worker on port ${port} loaded a kernel older than ${path.basename(target.cli)}: ${stopped.note}; ran cold` };
  }
  if (!fs.existsSync(target.cli)) return { status: null, note: `the ${target.lane} worker CLI is not built: ${target.cli}` };
  if (!target.studioReady()) return { status: null, note: 'the selected Studio installation has no ServiceStudio.Framework.dll; ran cold' };
  const locked = await withStartupLock(target.local, port, target.waitMs, async () => {
    let s = await ping(target);
    if (s && !studioMatches(s, target.selectedStudio)) return otherStudio(s);
    if (s && !s.recycling) return { status: s };
    if (s?.recycling) {
      const old = s.instanceId;
      await until(async () => { s = await ping(target, 500); return !s || (!s.recycling && s.instanceId !== old); }, target.waitMs, { now });
      if (s && !s.recycling) return studioMatches(s, target.selectedStudio) ? { status: s } : otherStudio(s);
      if (s) return { status: null, note: `the worker on port ${port} did not finish recycling` };
    } else if (await listening(port)) return { status: null, note: `port ${port} accepts connections but does not answer the worker ping; nothing was stopped; ran cold` };
    const launchedMs = now();
    const child = launch(target, spawnFn);
    let exited = null;
    const wake = new Promise(resolve => { child.once?.('exit', code => { exited = code ?? 'signal'; resolve(); }); child.once?.('error', error => { exited = error.message; resolve(); }); });
    await until(async () => { s = await ping(target, 500); return Boolean(s) || exited !== null; }, target.waitMs, { now, wake });
    if (!s && exited !== null) s = await ping(target); // another starter may have won the port
    if (s) { remember(target, s, launchedMs); return studioMatches(s, target.selectedStudio) ? { status: s, started: true } : otherStudio(s); }
    return { status: null, note: exited !== null
      ? `worker startup failed (exit ${exited}); see ${path.join(target.local, `worker-${port}-startup.log`)}`
      : `worker did not start within ${Math.round(target.waitMs / 1000)} s` };
  }, { now });
  return locked.locked ? locked.value : { status: null, note: locked.note };
}

// Run one CLI command on the worker. {used:false, note}: nothing executed there, run it cold. {used:true, envelope}:
// the worker's envelope (a refusal of the key included, as anvil_cli.run returns it). {used:true, unknown:true}: the
// request was written and no reply came; it is never replayed, here or cold.
export async function runOnWorker(argv, target, deps = {}) {
  if (target.disabled) return { used: false, note: 'worker disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
  const ensure = deps.ensure ?? (() => ensureWorker(target, deps));
  let state = await ensure();
  if (!state.status) return { used: false, note: state.note };
  for (let attempt = 1; ; attempt++) {
    if (deps.avoidBusy === true && (state.status.busy || Number(state.status.queued) > 0))
      return { used: false, note: `the resident worker was busy with ${state.status.currentCommand ?? 'an unknown command'} for ${state.status.runningMs ?? 0} ms; this read ran cold` };
    const r = await workerRequest({ port: target.port, authorization: target.key() ?? null, timeoutMs: target.timeoutMs }, argv);
    if (!r.sent) {
      if (!r.refused) return { used: false, note: `worker unreachable before the request was written (${r.error})` };
      if (attempt >= 3) return { used: false, note: 'the worker kept refusing the connection; nothing was sent' };
    } else if (!r.reply) {
      return { used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', detail: r.error,
        error: 'worker connection failed after submission; execution outcome is unknown, command was not replayed' };
    } else if (r.reply.retryable === true && r.reply.executed === false) {
      if (attempt >= 3) return { used: false, note: 'the worker kept recycling before executing the request' };
    } else {
      return { used: true, envelope: r.reply, ...(state.warning ? { warning: state.warning } : {}) };
    }
    state = await ensure();
    if (!state.status) return { used: false, note: state.note };
  }
}

// The client the job runner takes (deps.worker in tests): one lane's target and its three calls.
export function createWorkerClient(lane, options = {}, deps = {}) {
  const target = workerTarget(lane, options);
  return { target, ping: () => ping(target), ensure: () => ensureWorker(target, deps),
    run: (argv, { timeoutMs, avoidBusy } = {}) => runOnWorker(argv, timeoutMs ? { ...target, timeoutMs } : target, { ...deps, avoidBusy }) };
}

// S9 (ssam_code check through the hot module): the worker already up on the lane's port, or nothing. It never starts,
// stops, recycles or waits for one: a check must not change the machine (ensureWorker stops a worker of another
// installation or of an older kernel). It serves only when its ping names the selected installation, it is not recycling,
// it loaded the CLI on disk (staleKernel), and it is idle (avoidBusy: a check never queues behind a delivery's apply, it
// runs cold beside it, as two checks in parallel do). {used:false, note} from run means nothing ran there.
export function residentWorkerClient(lane, options = {}, deps = {}) {
  const target = workerTarget(lane, options);
  const ensure = async () => {
    const status = await ping(target, deps.pingMs ?? 1000);
    if (!status) return { status: null, note: `no ${lane} worker is up on port ${target.port}` };
    if (status.protocol !== WORKER_PROTOCOL) return { status: null, note: `the service on port ${target.port} is not an ${WORKER_PROTOCOL} worker` };
    if (!studioMatches(status, target.selectedStudio)) return { status: null, note: `the worker on port ${target.port} serves ${status.studio ?? 'an unknown installation'}, not ${target.selectedStudio}` };
    if (status.recycling) return { status: null, note: `the worker on port ${target.port} is recycling` };
    if (staleKernel(target, status)) return { status: null, note: `the worker on port ${target.port} loaded a kernel older than ${path.basename(target.cli)}` };
    return { status };
  };
  return { target, resident: true, ping: () => ping(target), ensure,
    run: (argv, { timeoutMs } = {}) => runOnWorker(argv.map(String), timeoutMs ? { ...target, timeoutMs } : target, { ...deps, ensure, avoidBusy: true }) };
}

// S14 (leitura quente): one request of the snapshot reader (reader-client.mjs readSnapshot: flow, flowElements, digest)
// answered by the lane's write worker over the spare of the same model (WorkerServer hot-read, kernel HotModuleRead): the
// same reader code, the same files in the same store (indexRoot), without loading the capture again. Only a worker already
// up, of the selected installation and kernel, that says it reads hot (hotRead), keeps or is preparing a spare and runs no
// command: it never starts, stops or queues behind one (the worker itself refuses at once, not executed, when it became busy
// or prepares another model; it waits up to 8 s only for the prefetch of this capture's own model).
// -> {used:false, note}: nothing ran there, the caller reads cold (also for any answer that is not ok: a read is safe to
// repeat cold); {used:true, response}: the reader's answer, its cache naming the worker (via:'worker').
export const HOT_READ = 'hot-read';
export async function hotModuleRead(lane, { request, indexRoot } = {}, options = {}, deps = {}) {
  if (workerDisabled(lane, options.env ?? process.env)) return { used: false, note: 'worker disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
  let client;
  try { client = (deps.client ?? residentWorkerClient)(lane, options, { pingMs: 500, ...deps }); }
  catch (error) { return { used: false, note: 'no worker target: ' + error.message }; }
  const state = await client.ensure();
  if (!state.status) return { used: false, note: state.note };
  const status = state.status;
  if (status.hotRead !== true) return { used: false, note: `the worker on port ${client.target.port} does not read hot (an older kernel)` };
  if (status.busy || Number(status.queued) > 0) return { used: false, note: `the worker on port ${client.target.port} is not free` };
  // L3b follow-up: a worker preparing a spare (idleWork, or a capture wanted and not ready yet) is asked too. It waits for that
  // prefetch when it is of this capture's model (at most its JoinWait, 8 s), and refuses at once, without stopping it, when it
  // is another model's; the read is then cold.
  const preparing = status.idleWork === true || (Array.isArray(status.baseCache?.warming) && status.baseCache.warming.length > 0);
  if (!preparing && !(Number(status.cachedModules ?? status.baseCache?.entries) > 0)) return { used: false, note: `the worker on port ${client.target.port} keeps no spare` };
  const body = JSON.stringify({ ...request, ...(indexRoot ? { indexRoot: path.resolve(indexRoot) } : {}) });
  const started = performance.now();
  const r = await (deps.request ?? workerRequest)({ port: client.target.port, authorization: client.target.key() ?? null, timeoutMs: deps.timeoutMs ?? 120000 }, [HOT_READ, body]);
  const reply = r.reply;
  if (!reply || reply.ok !== true) return { used: false, note: reply?.error ?? r.error ?? 'no answer', ...(reply?.code ? { code: reply.code } : {}) };
  const { queuedMs, hot, ...response } = reply;
  return { used: true, response: { ...response, cache: { ...response.cache, generation: 'worker:' + status.instanceId, instanceId: status.instanceId, pid: status.pid, via: 'worker' },
    timings: { ...response.timings, transportMs: performance.now() - started }, hot } };
}

// L3b (pré-aquecimento, spare pós-merge): asks the lane's worker to prepare the spare of each capture next (WorkerServer
// `warm`, kernel BaseModelCache.Warm), in this order, at most the worker's cache entries. It only names them: the worker loads
// them while idle and gives a load up for any request that needs another base, as for every spare. Only a worker already up,
// of the selected installation and kernel, that says it warms (ping warm:true) and is idle; it never starts, stops or waits
// for one. captures: [{path (absolute), contentSha256?, supersedes?}]; developerId: the author the ODC worker loads them for.
// -> {used:false, note} | {used:true, wanted:[{wanted, file, key, modelSha256, ready, ...}], held, port}.
export const WARM = 'warm';
export async function warmSpares(lane, { captures = [], developerId = null } = {}, options = {}, deps = {}) {
  if (workerDisabled(lane, options.env ?? process.env)) return { used: false, note: 'worker disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
  const list = (Array.isArray(captures) ? captures : []).filter(c => typeof c?.path === 'string' && path.isAbsolute(c.path))
    .map(c => ({ path: path.resolve(c.path), ...(typeof c.contentSha256 === 'string' ? { contentSha256: c.contentSha256 } : {}), ...(typeof c.supersedes === 'string' ? { supersedes: path.resolve(c.supersedes) } : {}) }));
  if (!list.length) return { used: false, note: 'no capture to warm' };
  let client;
  try { client = (deps.client ?? residentWorkerClient)(lane, options, { pingMs: 500, ...deps }); }
  catch (error) { return { used: false, note: 'no worker target: ' + error.message }; }
  const state = await client.ensure();
  if (!state.status) return { used: false, note: state.note };
  const status = state.status;
  if (status.warm !== true) return { used: false, note: `the worker on port ${client.target.port} does not warm (an older kernel)` };
  if (status.busy || Number(status.queued) > 0) return { used: false, note: `the worker on port ${client.target.port} is busy with ${status.currentCommand ?? 'a command'}` };
  const body = JSON.stringify({ captures: list, ...(developerId ? { developerId } : {}) });
  const r = await (deps.request ?? workerRequest)({ port: client.target.port, authorization: client.target.key() ?? null, timeoutMs: deps.timeoutMs ?? 60000 }, [WARM, body]);
  if (r.reply?.ok !== true) return { used: false, note: String(r.reply?.error ?? r.error ?? 'no answer').slice(0, 200) };
  const data = r.reply.data ?? {};
  return { used: true, wanted: Array.isArray(data.wanted) ? data.wanted : [], held: data.held ?? null, port: client.target.port };
}

// B2 (C02, C25): one ODC CLI command (apply, check-job, create-app) on the lane's resident worker, which keeps the ODC Studio
// assemblies bound, the JIT warm and the base cache (BaseModelCache). `needs`: capabilities the worker's ping must
// advertise (apply:developer-id: the request runs under its own author, `--developer-id`; a worker of an older CLI would
// stamp its own identity). -> {used:false, note}: nothing ran there, the caller runs the command cold; {used:true,
// envelope}; {used:true, unknown:true, code, error}: the request was written and no answer came, never replayed.
// A refusal the worker answers with executed:false (another controller's key, an identity it cannot take) ran nothing:
// {used:false}. worker: a createWorkerClient('odc') (tests: a fake with ensure/run), null when disabled.
export async function runOdcOnWorker(argv, { worker = defaultOdcWorker(), needs = [] } = {}) {
  if (!worker) return { used: false, note: 'worker disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
  let state;
  try { state = await worker.ensure(); } catch (error) { return { used: false, note: 'worker unavailable: ' + error.message }; }
  if (!state?.status) return { used: false, note: state?.note ?? 'no ODC worker' };
  const capabilities = Array.isArray(state.status.capabilities) ? state.status.capabilities : [];
  const missing = needs.filter(c => !capabilities.includes(c));
  if (missing.length) return { used: false, note: `the ODC worker does not advertise ${missing.join(', ')} (an older CLI); ran cold` };
  // Quality (docs/QUALIDADE.md): the worker request is a kernel leaf; nothing run there (its cold fallback is the span).
  const end = kernelStart({ lane: 'odc', via: 'worker' });
  let w;
  try { w = await worker.run(argv.map(String)); }
  finally { end({ ran: w?.used === true && !(!w.unknown && w.envelope?.ok === false && w.envelope?.executed === false), ok: w?.envelope?.ok === true }); }
  if (!w.used) return { used: false, note: w.note };
  if (w.unknown) return { used: true, unknown: true, code: w.code ?? 'WORKER_OUTCOME_UNKNOWN', error: w.error };
  if (w.envelope?.ok === false && w.envelope?.executed === false)
    return { used: false, note: 'the ODC worker did not run the request (' + String(w.envelope.error ?? 'refused').slice(0, 160) + '); ran cold' };
  return { used: true, envelope: w.envelope, ...(w.warning ? { warning: w.warning } : {}) };
}
function defaultOdcWorker() { return workerDisabled('odc') ? null : createWorkerClient('odc'); }

// A runner with the call shape of createAnvilRunner (anvil-cli.mjs) that sends an O11 CLI command to the lane's
// resident worker when it can: the worker serves every CLI verb but app-session from the same Dispatch, without
// loading the Studio assemblies again (the ~17 s of a cold `dotnet anvil.dll` per call). Nothing executed there
// (disabled, other Studio, not startable, unreachable before the write) runs cold; a request written with no reply
// is an unknown outcome, reported as timedOut so callers treat it as uncertain and never replay it.
// Hosted, the command goes to the calling customer's own worker (hostedWorkerClient; deps.hostedWorkers in tests).
export function createWorkerFirstRunner({ root = anvilRoot, env = process.env, o11 = o11Lane.lane, cold, worker } = {}, deps = {}) {
  const fallback = cold ?? createAnvilRunner({ lane: o11, root, env });
  let client = worker ?? null;
  // Hosted, checked per call: a runner never hands a hosted command to the worker it may have used before, only to the
  // worker of the customer of this call.
  const resolve = () => (hostedContext() ? hostedWorkerClient({ root, env, o11, pool: deps.hostedWorkers }) ?? false
    : client ?? (client = workerDisabled('o11', env) ? false : createWorkerClient('o11', { root, env, o11 }, deps)));
  return async function runAnvil(args, options = {}) {
    // F7: the same trace arguments for the worker and the cold process (added once).
    args = withTraceArgs(args);
    const verb = String(args[0] ?? '');
    const usable = resolve();
    // stdin input (app-session) and another assembly (cli) are cold-only, as the worker refuses app-session.
    if (!usable || verb === 'app-session' || options.input !== undefined || options.cli) return fallback(args, options);
    const started = Date.now();
    const line = 'worker ' + verb;
    // Quality (docs/QUALIDADE.md): the worker request is a kernel leaf; a miss ran nothing and its cold run is the span.
    const end = kernelStart({ lane: 'o11', via: 'worker' });
    let w;
    try { w = await usable.run(args.map(String), { timeoutMs: options.timeoutMs, ...((options.read === true || options.recovery === true) ? { avoidBusy: true } : {}) }); }
    finally { end({ ran: w?.used === true && !(!w.unknown && w.envelope?.ok === false && w.envelope?.executed === false), ok: w?.envelope?.ok === true }); }
    // A refusal the worker answers with executed:false (another controller's key) ran nothing: the same command runs cold.
    const refusedUnrun = w.used && !w.unknown && w.envelope?.ok === false && w.envelope?.executed === false;
    if (!w.used || refusedUnrun) {
      const r = await fallback(args, options);
      const note = refusedUnrun ? 'the resident worker did not run the request (' + String(w.envelope.error ?? 'refused').slice(0, 160) + '); ran cold' : w.note;
      return note ? { ...r, workerNote: note } : r;
    }
    if (w.unknown) return { ok: false, exitCode: 1, envelope: null, timedOut: true, unknown: true, code: w.code,
      stderr: [w.error].filter(Boolean), wallMs: Date.now() - started, line, via: 'worker' };
    const envelope = w.envelope;
    return { ok: envelope?.ok === true, exitCode: envelope?.ok === true ? 0 : 1, envelope, stderr: w.warning ? [w.warning] : [],
      wallMs: Date.now() - started, line, via: 'worker', ...(Number.isFinite(envelope?.queuedMs) ? { workerQueuedMs: envelope.queuedMs } : {}) };
  };
}

// ---- Hosted: one resident O11 worker per customer -------------------------------------------------------------------
// Hosted, the O11 lane's worker stays off (workerDisabled): its process would keep this server's environment. A customer
// gets a worker of its own instead: `dotnet <cli> serve` started with the environment and folder that customer's cold
// process gets (hostedSpawnEnv('o11'): its relay port and relay authority, TEMP and cwd in its workspace), plus the memory
// profile the pool sets (hostedWorkerProfile, never the customer) and ANVIL_WORKER_IDLE_MINUTES, on a loopback port of
// its own. Its trusted-controller key is that customer's relay key (<ws>/state/relay-authority/bridge.key, read by the
// worker when it starts, as every kernel process with that environment reads it): a request with any other key runs
// nothing there (executed:false).
//   - Keyed by the tokenId of the hosted call and reused only by that token; every request carries that token's key.
//   - A miss never waits: the first call of a customer (and the first after its worker stopped) runs cold right away, and
//     the customer's worker starts in the background for the next call, when there is a place: a free one, or the place of
//     the least recently used idle worker that has been idle at least SSAM_O11_WORKER_MIN_IDLE_MS (default 2 min). With no
//     such place nothing starts and the call just runs cold. After a failed start the next one waits the same time.
//   - The fingerprint (environment, folder, CLI path and time, key) is checked at every call. Another one (a new hosted
//     context brings a new relay port and a new relay key; a rebuilt CLI) retires the idle worker and the call is a miss;
//     a busy one is left to finish and the call runs cold.
//   - One call at a time: a worker busy with another call, or starting, sends this call cold.
//   - SSAM_O11_WORKERS_MAX (default 2, the KVM 2; 0 is off) processes at most, stopping ones included: a new worker is
//     spawned only once the workers it replaces have exited. SSAM_O11_WORKER_IDLE_MS (default 10 min) without a call
//     retires a worker; ANVIL_WORKER_IDLE_MINUTES makes it exit by itself 5 min after that, should this process lose it.
//     A closed hosted context retires its worker. After each call, a worker whose resident set (Linux /proc/<pid>/status
//     VmRSS) is above SSAM_O11_WORKER_RSS_MB (default 1200) is retired; never during a call.
//   - Retiring: no call reaches the worker from then on. When its ping still names the process started here (pid,
//     instance), it is asked to shut down with the customer's key and terminated when it does not exit. A worker that
//     may still run a command (an unknown outcome, a recycle) is watched until its ping says idle, bounded by the call's
//     own timeout, and only then shut down; terminated only past that bound. A listener that is not this worker (another
//     pid or instance, no ping, a startup failure, unreachable) gets nothing: the worker's own ChildProcess is terminated,
//     so the customer's key never reaches another process. A spawn without a pid is never adopted.
//   - Cold, the call as today: a miss, the worker busy or starting, it refuses the connection before the write, recycles,
//     or answers its ping other than idle. A request written with no reply is an unknown outcome, never replayed (here or
//     cold), and its worker is retired as above.
//   - ANVIL_WORKER=0 keeps every hosted call cold, as locally. The startup lock and the records of the lane worker are not
//     used: this process alone starts these workers and holds their ChildProcess (no pid is ever guessed).
export const HOSTED_O11_WORKERS_MAX = 2;
export const HOSTED_O11_WORKER_IDLE_MS = 10 * 60 * 1000;
export const HOSTED_O11_WORKER_MIN_IDLE_MS = 2 * 60 * 1000;
export const HOSTED_O11_WORKER_HEAP_MB = 1536;
export const HOSTED_O11_WORKER_MAX_COMMANDS = 1000;
export const HOSTED_O11_WORKER_RSS_MB = 1200;
// The variables the pool sets in a customer's worker (hostedWorkerProfile and the idle exit), the only ones besides the
// customer's cold environment. The kernel reads them: ANVIL_BASE_CACHE (=off) and ANVIL_BASE_CACHE_ENTRIES/_MB
// (BaseModelCache.cs BaseCacheOptions.FromEnvironment), ANVIL_WORKER_MAX_COMMANDS (Anvil.Cli Program.cs, serve),
// ANVIL_WORKER_IDLE_MINUTES (WorkerServer.cs); DOTNET_GCHeapHardLimit is the .NET runtime's (hexadecimal bytes).
export const HOSTED_O11_WORKER_VARIABLES = Object.freeze(['ANVIL_BASE_CACHE', 'ANVIL_BASE_CACHE_ENTRIES', 'ANVIL_BASE_CACHE_MB',
  'DOTNET_GCHeapHardLimit', 'ANVIL_WORKER_MAX_COMMANDS', 'ANVIL_WORKER_IDLE_MINUTES']);
const SELF_EXIT_MARGIN_MS = 5 * 60 * 1000;
const THE_WORKER = "the customer's O11 worker";
const UNKNOWN = 'worker connection failed after submission; execution outcome is unknown, command was not replayed';

const settingOf = (value, fallback, min) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
};
// 0 switches a memory bound off; any other value below 256 MB keeps the default (a worker cannot run below it).
const megabytesOf = (value, fallback) => { const n = settingOf(value, fallback, 0); return n === 0 || n >= 256 ? n : fallback; };
// The customers' workers: cap, idle time, minimum residency, memory profile and working-set guard, and whether they are
// off. Read from the server's environment only; invalid values keep the defaults.
//   SSAM_O11_WORKER_BASE_CACHE: off (default), or a budget in MB (>= 64) for one spare base per worker.
//   SSAM_O11_WORKER_HEAP_MB: the GC heap hard limit of a worker (default 1536; 0 leaves the runtime's own).
//   SSAM_O11_WORKER_MAX_COMMANDS: commands before a worker recycles itself (default 1000).
//   SSAM_O11_WORKER_RSS_MB: resident set above which a worker is retired after its call (default 1200; 0 is off).
export function hostedWorkerSettings(env = process.env) {
  const max = settingOf(env.SSAM_O11_WORKERS_MAX, HOSTED_O11_WORKERS_MAX, 0);
  const cache = String(env.SSAM_O11_WORKER_BASE_CACHE ?? '').trim();
  const baseCacheMb = /^\d+$/.test(cache) && Number(cache) >= 64 ? Number(cache) : 0;
  return {
    max,
    idleMs: settingOf(env.SSAM_O11_WORKER_IDLE_MS, HOSTED_O11_WORKER_IDLE_MS, 1000),
    minIdleMs: settingOf(env.SSAM_O11_WORKER_MIN_IDLE_MS, HOSTED_O11_WORKER_MIN_IDLE_MS, 0),
    heapMb: megabytesOf(env.SSAM_O11_WORKER_HEAP_MB, HOSTED_O11_WORKER_HEAP_MB),
    maxCommands: settingOf(env.SSAM_O11_WORKER_MAX_COMMANDS, HOSTED_O11_WORKER_MAX_COMMANDS, 1),
    rssMb: megabytesOf(env.SSAM_O11_WORKER_RSS_MB, HOSTED_O11_WORKER_RSS_MB),
    baseCacheMb,
    disabled: env.ANVIL_WORKER === '0' || max === 0,
  };
}

// The memory profile of a customer's worker, set by the pool: the base cache off (or one spare within its budget), the GC
// heap hard limit and the command limit. The idle exit is added at launch.
export function hostedWorkerProfile(settings = hostedWorkerSettings({})) {
  const profile = settings.baseCacheMb > 0
    ? { ANVIL_BASE_CACHE: 'on', ANVIL_BASE_CACHE_ENTRIES: '1', ANVIL_BASE_CACHE_MB: String(settings.baseCacheMb) }
    : { ANVIL_BASE_CACHE: 'off' };
  if (settings.heapMb > 0) profile.DOTNET_GCHeapHardLimit = '0x' + (settings.heapMb * 1024 * 1024).toString(16).toUpperCase();
  profile.ANVIL_WORKER_MAX_COMMANDS = String(settings.maxCommands);
  return profile;
}

// The environment a customer's worker is started with: the customer's cold environment without any variable the pool
// owns (nor another GC setting of the runtime), then the pool's profile and the idle exit.
const POOL_OWNED = new Set(HOSTED_O11_WORKER_VARIABLES.map(name => name.toUpperCase()));
export function hostedWorkerEnv(coldEnv, profile, selfExitMinutes) {
  const env = {};
  for (const [name, value] of Object.entries(coldEnv)) if (!POOL_OWNED.has(name.toUpperCase()) && !/^(DOTNET|COMPLUS)_GC/i.test(name)) env[name] = value;
  return { ...env, ...profile, ANVIL_WORKER_IDLE_MINUTES: String(selfExitMinutes) };
}

// The resident set of a process in MB (Linux /proc/<pid>/status VmRSS), or null where it cannot be read (other systems,
// a process gone).
export function residentMb(pid, { platform = process.platform, readFile = fs.readFileSync } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFile(`/proc/${pid}/status`, 'utf8'));
    return match ? Math.round(Number(match[1]) / 1024) : null;
  } catch { return null; }
}

const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
// What a customer's worker is started with: the same value means the same environment, folder, kernel build and key.
export function hostedFingerprint({ env, cwd, cli, key }) {
  let built = null;
  try { built = fs.statSync(cli).mtimeMs; } catch { built = null; }
  return sha256(JSON.stringify({ cli, built, cwd, env: Object.keys(env).sort().map(name => [name, env[name]]), key: sha256(key) }));
}

// The worker the hosted call in progress may use: the customer's spawn environment and folder (hostedSpawnEnv, which
// throws what it throws for the cold process too), the server's CLI, the customer's relay key and the folder of the
// worker's logs (<ws>/o11/tmp/o11-worker).
export function hostedWorkerSpec({ root = anvilRoot, env = process.env, o11 = o11Lane.lane } = {}) {
  const context = hostedContext();
  if (!context) throw new Error('a hosted O11 worker exists only inside a hosted call');
  const { env: childEnv, cwd } = hostedSpawnEnv('o11');
  if (!childEnv.ANVIL_AUTHORITY_DIR) throw new Error('the hosted environment names no relay authority');
  const key = fs.readFileSync(path.join(childEnv.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'ascii').trim();
  if (!key) throw new Error("this customer's relay key is empty");
  const cli = o11LaneOf(o11, { root, env }).cli;
  return { tokenId: context.tokenId, contextId: context.id ?? null, env: childEnv, cwd, cli, key, studioDir: childEnv.ANVIL_STUDIO_DIR ?? null,
    local: path.join(cwd, 'tmp', 'o11-worker'), fingerprint: hostedFingerprint({ env: childEnv, cwd, cli, key }) };
}

// A loopback port nothing listens on now (asked from the system and released), none of the ports in use here.
export async function loopbackPort(taken = new Set()) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    if (!taken.has(port)) return port;
  }
  throw new Error('the system kept handing out ports of other workers');
}

// The newest logs of a customer's workers stay (a running worker's file among them); the older ones go.
function pruneLogs(folder, keep = 4) {
  let files = [];
  try {
    files = fs.readdirSync(folder).filter(name => /^worker-\d+-(?:\d+|startup)\.log$/.test(name))
      .map(name => { const file = path.join(folder, name); return { file, at: fs.statSync(file).mtimeMs }; });
  } catch { return; }
  for (const { file } of files.sort((a, b) => b.at - a.at).slice(keep)) { try { fs.unlinkSync(file); } catch { /* still open */ } }
}

// Not detached: the worker belongs to this process, which terminates it on exit (hookExit).
function launchHosted(entry, spawnFn, selfExitMinutes, profile) {
  fs.mkdirSync(entry.local, { recursive: true });
  pruneLogs(entry.local);
  const log = fs.openSync(path.join(entry.local, `worker-${entry.port}-startup.log`), 'a');
  try {
    const child = spawnFn('dotnet', [entry.cli, 'serve', '--port', String(entry.port), '--log-dir', entry.local],
      { cwd: entry.cwd, env: hostedWorkerEnv(entry.env, profile, selfExitMinutes), stdio: ['ignore', log, log], windowsHide: true });
    child.unref?.();
    return child;
  } finally { fs.closeSync(log); }
}

// True when the promise settles within ms; the timer never outlives it.
const settlesWithin = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms);
  promise.then(() => { clearTimeout(timer); resolve(true); });
});

// On this process's exit every customer worker still running is terminated (the exit event allows only synchronous work).
const pools = new Set();
let exitHooked = false;
function hookExit(pool) {
  pools.add(pool);
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { for (const each of pools) each.terminateAll(); });
}

// The customers' workers of this process. run(spec, argv) has the answer shape of runOnWorker: {used:false, note} (nothing
// ran there: the caller runs cold), {used:true, envelope}, or {used:true, unknown:true, code, error} (never replayed).
// deps (tests): spawnFn, now, freePort, rssOf (MB of a pid, or null), waitMs (startup deadline), pingMs, stopMs (shutdown,
// then terminate), profile (the worker's memory profile).
export class HostedO11Workers {
  constructor({ max = HOSTED_O11_WORKERS_MAX, idleMs = HOSTED_O11_WORKER_IDLE_MS, minIdleMs = HOSTED_O11_WORKER_MIN_IDLE_MS,
    rssMb = HOSTED_O11_WORKER_RSS_MB, profile = hostedWorkerProfile(), waitMs = 25000, pingMs = 3000, stopMs = 10000,
    spawnFn = spawn, now = Date.now, freePort = loopbackPort, rssOf = pid => residentMb(pid) } = {}) {
    Object.assign(this, { max, idleMs, minIdleMs, rssMb, profile: Object.freeze({ ...profile }), waitMs, pingMs, stopMs, spawnFn, now, freePort, rssOf });
    this.entries = new Map(); // tokenId -> that customer's worker, starting or ready
    this.stopping = new Set(); // retired, process not gone yet
    this.failed = new Map(); // tokenId -> {fingerprint, at, note} of its last failed start
    this.starts = new Map(); // tokenId -> its last start in the background (resolves to {ok, note})
    this.closed = false;
  }

  // What the cap counts: workers starting or ready, and those whose process has not exited yet.
  get size() { return this.entries.size + this.stopping.size; }
  workerOf(tokenId) { return this.entries.get(tokenId) ?? null; }
  // The last start in the background of a customer's worker ({ok:true} or {ok:false, note}), or null.
  starting(tokenId) { return this.starts.get(tokenId) ?? null; }
  processes(except = null) {
    return [...this.entries.values()].filter(e => e !== except && e.child && e.exitCode === undefined).length + this.stopping.size;
  }
  ports() { return new Set([...this.entries.values(), ...this.stopping].map(e => e.port).filter(Number.isInteger)); }

  async run(spec, argv, { timeoutMs = 900000 } = {}) {
    const claim = this.claim(spec);
    if (!claim.entry) return { used: false, note: claim.note };
    const entry = claim.entry;
    let written = false; // from the request on, a failure is an unknown outcome
    const unknown = detail => {
      this.retire(entry, 'outcome unknown', { mode: 'drain', drainMs: timeoutMs });
      return { used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', detail, error: UNKNOWN };
    };
    try {
      const ready = await this.check(entry, timeoutMs);
      if (!ready.ok) return { used: false, note: ready.note };
      written = true;
      let r;
      try { r = await workerRequest({ port: entry.port, authorization: entry.key, timeoutMs }, argv.map(String)); }
      catch (error) { r = { sent: false, error: error.message }; } // the socket never opened: nothing was written
      if (!r.sent) {
        written = false;
        this.retire(entry, 'unreachable', { mode: 'kill' });
        return { used: false, note: `${THE_WORKER} was unreachable before the request was written (${r.error}); ran cold` };
      }
      if (!r.reply) return unknown(r.error);
      // A worker that drains after this request (its command limit, its heap) or before it (recycling) serves no other call
      // and exits by itself; one that refused the key ran nothing and gets nothing more.
      const recycling = r.reply.retryable === true && r.reply.executed === false;
      if (r.reply.recycling === true || recycling) this.retire(entry, 'recycling', { mode: 'drain', drainMs: this.stopMs });
      else if (r.reply.executed === false) this.retire(entry, 'refused the request', { mode: 'kill' });
      if (recycling) return { used: false, note: `${THE_WORKER} was recycling before executing the request; ran cold` };
      return { used: true, envelope: r.reply };
    } catch (error) {
      return written ? unknown(error.message) : { used: false, note: `${THE_WORKER} failed before the request was written (${error.message}); ran cold` };
    } finally { this.release(entry); }
  }

  // Synchronous, so two calls never take one worker: the entry this call uses (busy from now on), or why it runs cold (a
  // miss starts the customer's worker in the background when there is a place).
  claim(spec) {
    if (this.closed) return { note: 'the hosted O11 workers are closed; ran cold' };
    const freeing = [];
    let entry = this.entries.get(spec.tokenId) ?? null;
    if (entry && entry.fingerprint !== spec.fingerprint) {
      if (entry.busy) return { note: `${THE_WORKER} still serves its earlier environment (relay, key or kernel changed) and is busy; ran cold` };
      this.retire(entry, 'environment changed');
      freeing.push(entry);
      entry = null;
    }
    if (entry) {
      if (entry.state === 'starting') return { note: `${THE_WORKER} is starting in the background; ran cold` };
      if (entry.busy) return { note: `${THE_WORKER} is busy with another call; ran cold` };
      entry.busy = true; clearTimeout(entry.idleTimer); entry.idleTimer = null;
      return { entry };
    }
    return { note: this.warm(spec, freeing) };
  }

  // A miss: this call runs cold; the customer's worker starts in the background, in a free place or in the place of the
  // least recently used worker idle for at least minIdleMs. freeing: the customer's own earlier worker, just retired.
  // Returns the note of the cold call. Never waits.
  warm(spec, freeing = []) {
    const failed = this.failed.get(spec.tokenId);
    if (failed && failed.fingerprint === spec.fingerprint && this.now() - failed.at < this.minIdleMs)
      return `${THE_WORKER} did not start a moment ago (${failed.note}); ran cold`;
    // The places taken once the workers retired for this customer have exited (the cap counts stopping processes).
    const taken = this.size - freeing.filter(e => this.stopping.has(e)).length;
    const waits = freeing.map(e => e.stopped);
    if (taken >= this.max) {
      const now = this.now();
      const idle = [...this.entries.values()].filter(e => e.state === 'ready' && !e.busy && now - e.lastUsed >= this.minIdleMs)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      // Only a victim whose exit leaves a place for this customer.
      if (!idle || taken - 1 >= this.max)
        return `no place for ${THE_WORKER} now (the ${this.max} place(s) of this server are busy, starting, stopping or used in the last ${Math.round(this.minIdleMs / 1000)} s); ran cold`;
      waits.push(this.retire(idle, 'least recently used'));
    }
    const entry = { tokenId: spec.tokenId, contextId: spec.contextId ?? null, fingerprint: spec.fingerprint, env: spec.env, cwd: spec.cwd, cli: spec.cli,
      key: spec.key, studioDir: spec.studioDir ?? null, local: spec.local, state: 'starting', busy: true, lastUsed: this.now(), port: null,
      child: null, pid: null, instanceId: null, exitCode: undefined, exited: null, idleTimer: null, stopped: null, closeAfter: false, warming: null };
    this.entries.set(spec.tokenId, entry);
    this.failed.delete(spec.tokenId);
    entry.warming = this.start(entry, waits)
      .catch(error => { this.retire(entry, 'startup failed', { mode: 'kill' }); return { ok: false, failed: true, note: `could not be started (${error.message})` }; })
      .then(result => {
        if (result.ok) this.release(entry);
        else if (!this.closed && result.failed) this.failed.set(entry.tokenId, { fingerprint: entry.fingerprint, at: this.now(), note: result.note });
        return result;
      });
    this.starts.set(spec.tokenId, entry.warming);
    return `${THE_WORKER} is not running: this call ran cold and the worker starts in the background for the next call`;
  }

  // The worker of a new entry, once the workers it replaces are gone: {ok:true} when its ping answers as the process
  // started here, idle. {ok:false, note, failed} when it did not start (failed: a start to remember, not a stop).
  async start(entry, waits = []) {
    await Promise.all(waits);
    const fail = note => { this.forget(entry); return { ok: false, failed: true, note }; };
    const gone = when => ({ ok: false, note: `${THE_WORKER} was retired ${when}` });
    if (this.entries.get(entry.tokenId) !== entry) return gone('before it started');
    // A worker that did not exit yet keeps its place: never a process beyond the cap (a matter of places, not remembered
    // as a failed start of this customer's worker).
    if (this.processes(entry) >= this.max) { this.forget(entry); return { ok: false, note: `the ${this.max} hosted O11 worker(s) of this server were still running` }; }
    if (!fs.existsSync(entry.cli)) return fail(`the o11 worker CLI is not built: ${entry.cli}`);
    if (!entry.studioDir || !fs.existsSync(path.join(entry.studioDir, 'ServiceStudio.Framework.dll')))
      return fail('the kernel Studio installation has no ServiceStudio.Framework.dll');
    try { entry.port = await this.freePort(this.ports()); }
    catch (error) { return fail(`no loopback port (${error.message})`); }
    if (this.entries.get(entry.tokenId) !== entry) return gone('before it started');
    let child;
    try { child = launchHosted(entry, this.spawnFn, Math.ceil((this.idleMs + SELF_EXIT_MARGIN_MS) / 60000), this.profile); }
    catch (error) { return fail(`could not be started (${error.message})`); }
    entry.child = child;
    entry.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    entry.exited = new Promise(resolve => {
      child.once?.('exit', (code, signal) => { if (entry.exitCode === undefined) entry.exitCode = code ?? signal ?? 'signal'; resolve(); });
      child.once?.('error', error => { if (entry.exitCode === undefined) entry.exitCode = error.message; resolve(); });
    });
    entry.exited.then(() => this.gone(entry));
    hookExit(this);
    const failedStart = why => { this.retire(entry, 'startup failed', { mode: 'kill' }); return { ok: false, failed: true, note: why }; };
    // Whatever answers on its port is adopted only as the process started here: without its pid, never.
    if (entry.pid === null) return failedStart('was started without a process id, so nothing on its port is adopted');
    let status = null;
    await until(async () => { status = await ping(entry, 500); return Boolean(status) || entry.exitCode !== undefined; }, this.waitMs, { now: this.now, wake: entry.exited });
    const why = !status ? (entry.exitCode !== undefined
      ? `exited during startup (exit ${entry.exitCode}); see ${path.join(entry.local, `worker-${entry.port}-startup.log`)}`
      : `did not start within ${Math.round(this.waitMs / 1000)} s`) : this.foreign(entry, status) ?? this.unready(status);
    if (why) return failedStart(why);
    if (this.entries.get(entry.tokenId) !== entry) return gone('while it started');
    entry.instanceId = status.instanceId ?? null; entry.state = 'ready';
    return { ok: true, started: true };
  }

  // An entry ready from an earlier call: its process is alive and its ping still names it, idle.
  async check(entry, timeoutMs = 900000) {
    if (entry.exitCode !== undefined) { this.forget(entry); return { ok: false, note: `${THE_WORKER} has exited; ran cold` }; }
    const status = await ping(entry, this.pingMs);
    const foreign = status ? this.foreign(entry, status) : 'does not answer its ping';
    if (foreign) { this.retire(entry, foreign, { mode: 'kill' }); return { ok: false, note: `${THE_WORKER} ${foreign}; ran cold` }; }
    // Its own process, not idle (recycling, or a request this server did not send): watched until idle, never cut.
    const unready = this.unready(status);
    if (unready) { this.retire(entry, unready, { mode: 'drain', drainMs: timeoutMs }); return { ok: false, note: `${THE_WORKER} ${unready}; ran cold` }; }
    return { ok: true };
  }

  // Why the process that answered on the entry's port is not the one started here (null when it is): another protocol, no
  // pid of ours, another pid or instance, another Studio installation.
  foreign(entry, status) {
    if (status?.protocol !== WORKER_PROTOCOL) return 'answers its ping with another protocol';
    if (entry.pid === null) return 'has no process id of its own';
    if (status.pid !== entry.pid) return `is answered on its port by pid ${status.pid}, not ${entry.pid}`;
    if (entry.instanceId !== null && status.instanceId !== entry.instanceId) return 'is answered on its port by another instance';
    if (!studioMatches(status, entry.studioDir)) return `serves ${status.studio ?? 'an unknown installation'}, not ${entry.studioDir}`;
    return null;
  }

  // Why the entry's own worker cannot take a request now (null when idle).
  unready(status) {
    if (status.recycling) return 'is recycling';
    if (status.busy || status.queued) return 'is busy with a request this server did not send';
    return null;
  }

  // The call is over: the worker is idle again, retired after idleMs without another call, now when its context closed or
  // when its resident set passed rssMb (read after the call, never during one).
  release(entry) {
    entry.busy = false; entry.lastUsed = this.now();
    if (this.entries.get(entry.tokenId) !== entry || entry.state !== 'ready') return;
    if (entry.closeAfter) { this.retire(entry, 'its hosted context closed'); return; }
    if (this.rssMb > 0) {
      let rss = null;
      try { rss = this.rssOf(entry.pid); } catch { rss = null; }
      if (Number.isFinite(rss) && rss > this.rssMb) { this.retire(entry, `its resident set (${rss} MB) passed ${this.rssMb} MB`); return; }
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { if (!entry.busy && this.entries.get(entry.tokenId) === entry) this.retire(entry, 'idle'); }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  // An entry that never got a process.
  forget(entry) {
    clearTimeout(entry.idleTimer); entry.idleTimer = null;
    if (this.entries.get(entry.tokenId) === entry) this.entries.delete(entry.tokenId);
    if (entry.state !== 'stopping') entry.state = 'gone';
  }

  // Its process exited: whatever it was, it serves no one now.
  gone(entry) {
    clearTimeout(entry.idleTimer); entry.idleTimer = null;
    this.stopping.delete(entry);
    if (this.entries.get(entry.tokenId) === entry) this.entries.delete(entry.tokenId);
    if (entry.state !== 'stopping') entry.state = 'gone';
  }

  // No call reaches the worker from now on. Resolves when its process is gone (or the last attempt is over); never rejects.
  //   graceful: when its ping names the process started here, asked to shut down with the customer's key, then terminated
  //     when it does not exit; when it does not, terminated without a request.
  //   drain: its command may still run (an unknown outcome, a recycle): the ping is watched until it says idle or the
  //     process exits, at most drainMs (the call's own timeout); then graceful; terminated only past that bound.
  //   kill: what answers on its port may not be this worker (another pid, no ping, a startup failure, unreachable): its own
  //     ChildProcess is terminated and nothing is sent to the port.
  retire(entry, why, { mode = 'graceful', drainMs = this.stopMs } = {}) {
    clearTimeout(entry.idleTimer); entry.idleTimer = null;
    if (this.entries.get(entry.tokenId) === entry) this.entries.delete(entry.tokenId);
    entry.state = 'stopping'; entry.why ??= why;
    if (entry.stopped) return entry.stopped;
    if (!entry.child || entry.exitCode !== undefined) return (entry.stopped = Promise.resolve());
    this.stopping.add(entry);
    entry.stopped = (async () => {
      if (mode === 'drain') {
        let idle = false;
        await until(async () => {
          if (entry.exitCode !== undefined) return true;
          const status = await ping(entry, Math.min(this.pingMs, 1000));
          idle = Boolean(status) && this.foreign(entry, status) === null && this.unready(status) === null;
          return idle;
        }, drainMs, { now: this.now, wake: entry.exited });
        if (entry.exitCode !== undefined) return;
        if (!idle) { await this.terminate(entry); return; }
      }
      if (mode !== 'kill') {
        const status = await ping(entry, this.pingMs);
        if (status && this.foreign(entry, status) === null) {
          await workerRequest({ port: entry.port, authorization: entry.key, timeoutMs: this.stopMs }, ['shutdown']).catch(() => null);
          if (await settlesWithin(entry.exited, this.stopMs)) return;
        }
      }
      await this.terminate(entry);
    })().catch(() => {});
    return entry.stopped;
  }

  // The worker's own ChildProcess: SIGTERM, then SIGKILL when it does not exit.
  async terminate(entry) {
    if (entry.exitCode !== undefined) return;
    try { entry.child.kill(); } catch { /* exited meanwhile */ }
    if (await settlesWithin(entry.exited, this.stopMs)) return;
    try { entry.child.kill('SIGKILL'); } catch { /* idem */ }
    await settlesWithin(entry.exited, this.stopMs);
  }

  // A closed hosted context: its relay is gone, so its worker serves nothing more (retired now, or after the call it runs
  // or the start in progress).
  contextClosed(tokenId, contextId) {
    const entry = this.entries.get(tokenId);
    if (!entry || entry.contextId !== contextId) return;
    if (entry.busy) entry.closeAfter = true; else this.retire(entry, 'its hosted context closed');
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.entries.values(), ...this.stopping].map(entry => this.retire(entry, 'closed')));
    pools.delete(this);
  }

  terminateAll() {
    for (const entry of [...this.entries.values(), ...this.stopping])
      if (entry.child && entry.exitCode === undefined) { try { entry.child.kill(); } catch { /* exited */ } }
  }
}

let processWorkers = null;
// The customers' workers of this process, with the settings of its environment, retired when their context closes.
export function hostedO11Workers() {
  if (!processWorkers) {
    const settings = hostedWorkerSettings(process.env);
    processWorkers = new HostedO11Workers({ max: settings.max, idleMs: settings.idleMs, minIdleMs: settings.minIdleMs, rssMb: settings.rssMb,
      profile: hostedWorkerProfile(settings) });
    onHostedContextClose(context => processWorkers.contextClosed(context.tokenId, context.id));
  }
  return processWorkers;
}

// The O11 worker client of the hosted call in progress, with the run shape of runOnWorker: that customer's worker, its
// environment computed again at each call. null outside a hosted call, with a data root passed on purpose (tests, the
// bench: their cold process does not get the hosted environment either) and when off (ANVIL_WORKER=0,
// SSAM_O11_WORKERS_MAX=0). pool: tests.
export function hostedWorkerClient({ root = anvilRoot, env = process.env, o11 = o11Lane.lane, pool = null } = {}) {
  const context = hostedContext();
  if (!context || hostedWorkerSettings(env).disabled || !usesWorkspace(root, anvilRoot)) return null;
  const workers = pool ?? hostedO11Workers();
  return {
    hosted: true, tokenId: context.tokenId,
    run: async (argv, { timeoutMs } = {}) => {
      if (hostedContext() !== context) return { used: false, note: 'the hosted O11 worker client left the call it was made for; ran cold' };
      let spec;
      try { spec = hostedWorkerSpec({ root, env, o11 }); }
      catch (error) { return { used: false, note: `no hosted O11 worker (${error.message}); ran cold` }; }
      return workers.run(spec, argv, timeoutMs ? { timeoutMs } : {});
    },
  };
}

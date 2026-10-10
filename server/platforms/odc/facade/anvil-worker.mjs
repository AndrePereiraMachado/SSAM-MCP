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
//   - starting one takes the startup lock file of worker_process.py (<local>/worker-<port>.lock), launches it detached
//     and waits for its ping. There is no event that says "listening" outside the worker's own log, so the ping is
//     consulted with backoff (250 ms doubling to 1 s) until a deadline (25 s O11, 90 s ODC) or until the child exits;
//   - a worker that loaded a kernel older than the CLI on disk is shut down and restarted when idle, served (with a
//     warning) when busy; its age comes from the record of a successful ping (worker_process.remember, or ours);
//   - ANVIL_WORKER=0 (both lanes) and ANVIL_ODC_NO_WORKER (ODC) always run cold.
// Out of scope, on purpose: the worker pool (worker_pool.py: several workers, reservation, base affinity) stays
// Python-only and is never used from here; a port that accepts connections but does not answer the ping is left
// alone (no pid to verify) and the job runs cold; the stale-deploy warning of anvil_cli.py (sources newer than .local/cli).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { anvilRoot, workspaceRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf, readAuthorityKey } from './o11-lane.mjs';
import { laneEnvironment, createAnvilRunner } from './anvil-cli.mjs';
import { hostedContext } from './executor.mjs';

export const WORKER_PROTOCOL = 'anvil-worker-1';
const MAX_REPLY_BYTES = 256 * 1024 * 1024;
const EPOCH_FILETIME = 11644473600; // seconds between 1601-01-01 (FILETIME) and 1970-01-01 (Unix)
const STALE_LOCK_SECONDS = 300;     // no startup waits this long: an older lock is left over
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const portOf = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback; };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const sameDir = (a, b) => { const n = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)); return n(a) === n(b); };

// Hosted (executor.mjs), the O11 worker is off: its process would keep this server's environment and Studio. The ODC
// worker is a shared process of the server that never talks to a Studio, so it stays.
export const workerDisabled = (lane, env = process.env) => env.ANVIL_WORKER === '0' || (lane === 'odc' && Boolean(env.ANVIL_ODC_NO_WORKER))
  || (lane === 'o11' && hostedContext() !== null);
const odcPort = workspace => portOf(readJson(path.join(workspace, '.ssam-workspace.json'))?.workers?.odc, 4547);

// Where one lane's worker lives and what it must serve. env is the caller's environment, never mutated.
export function workerTarget(lane, { root = anvilRoot, workspace = workspaceRoot, env = process.env, o11 = o11Lane.lane, pingMs = 3000 } = {}) {
  if (lane === 'o11') {
    const row = o11LaneOf(o11, { root, workspace, env });
    const childEnv = laneEnvironment({ lane: row.name, root, env });
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

// worker_process.startup_lock: one starter per port, across Python and Node. A lock whose owner is gone (or older
// than any startup) is removed; a live owner is waited for with the same backoff until the deadline.
export async function withStartupLock(local, port, waitMs, fn, { now = Date.now } = {}) {
  fs.mkdirSync(local, { recursive: true });
  const file = path.join(local, `worker-${port}.lock`);
  const token = { pid: process.pid, birth: null, created: now() / 1000, owner: 'node' };
  let free = false;
  const take = () => {
    try { fs.writeFileSync(file, JSON.stringify(token), { flag: 'wx', mode: 0o600 }); return (free = true); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = readJson(file); // null while its owner is still writing it
    if (owner && (!alive(Number(owner.pid)) || now() / 1000 - Number(owner.created) > STALE_LOCK_SECONDS)) { try { fs.unlinkSync(file); } catch { /* raced */ } return take(); }
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
    run: (argv, { timeoutMs } = {}) => runOnWorker(argv, timeoutMs ? { ...target, timeoutMs } : target, deps) };
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
  const w = await worker.run(argv.map(String));
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
export function createWorkerFirstRunner({ root = anvilRoot, env = process.env, o11 = o11Lane.lane, cold, worker } = {}, deps = {}) {
  const fallback = cold ?? createAnvilRunner({ lane: o11, root, env });
  let client = worker ?? null;
  // Hosted, checked per call: a runner never hands a hosted command to the worker it may have used before.
  const resolve = () => (hostedContext() ? false : client ?? (client = workerDisabled('o11', env) ? false : createWorkerClient('o11', { root, env, o11 }, deps)));
  return async function runAnvil(args, options = {}) {
    const verb = String(args[0] ?? '');
    const usable = resolve();
    // stdin input (app-session) and another assembly (cli) are cold-only, as the worker refuses app-session.
    if (!usable || verb === 'app-session' || options.input !== undefined || options.cli) return fallback(args, options);
    const started = Date.now();
    const line = 'worker ' + verb;
    const w = await usable.run(args.map(String), { timeoutMs: options.timeoutMs });
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
      wallMs: Date.now() - started, line, via: 'worker' };
  };
}

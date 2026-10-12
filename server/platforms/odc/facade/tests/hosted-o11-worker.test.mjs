// The resident O11 worker of each hosted customer (anvil-worker.mjs HostedO11Workers, hostedWorkerClient): one worker per
// tokenId, started in the background with that customer's hosted spawn environment plus the pool's memory profile, on its
// own loopback port, with that customer's relay key as its trusted-controller key; capped, retired when idle or too big,
// restarted when the environment changes, and cold whenever anything is uncertain. No process is ever started: the spawn
// is a fake that brings up a fake TCP worker on the port it is given (reading the key of the environment's authority
// folder, as the real worker does when it starts), and every workspace, CLI, Studio folder and user folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HostedO11Workers, hostedWorkerClient, hostedWorkerSettings, hostedWorkerSpec, hostedFingerprint, hostedO11Workers,
  hostedWorkerProfile, hostedWorkerEnv, residentMb, createWorkerFirstRunner, workerDisabled, workerRequest,
  HOSTED_O11_WORKERS_MAX, HOSTED_O11_WORKER_IDLE_MS, HOSTED_O11_WORKER_MIN_IDLE_MS, HOSTED_O11_WORKER_HEAP_MB,
  HOSTED_O11_WORKER_MAX_COMMANDS, HOSTED_O11_WORKER_RSS_MB, HOSTED_O11_WORKER_VARIABLES } from '../anvil-worker.mjs';
import { runWithExecutor, prepareWorkspace, hostedSpawnEnv, createHostedContext, onHostedContextClose } from '../executor.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { runJob } from '../job-runner.mjs';
import { fakeWorker } from './fixtures/jobs-fake-worker.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const QUICK = { waitMs: 3000, pingMs: 1000, stopMs: 150, idleMs: 60000, minIdleMs: 0 };
const PROFILE = { ANVIL_BASE_CACHE: 'off', DOTNET_GCHeapHardLimit: '0x60000000', ANVIL_WORKER_MAX_COMMANDS: '1000' };
const selfExit = idleMs => String(Math.ceil((idleMs + 5 * 60 * 1000) / 60000));
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('condition not met within ' + ms + ' ms'); await sleep(20); }
}
const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
// A clock that never repeats a value, so the least recently used worker is always one.
const monotonic = () => { let n = 0; return () => Date.now() + n++; };
const WARMING = /is not running: this call ran cold and the worker starts in the background for the next call/;
const notPing = worker => worker.seen.filter(r => r.args[0] !== 'ping');

// The server's side: a built CLI and the kernel's Studio installation.
function server(t) {
  const dir = temp(t, 'ssam-hw-server-');
  const cli = path.join(dir, 'cli', 'anvil.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const studio = path.join(dir, 'Service Studio'); fs.mkdirSync(studio); fs.writeFileSync(path.join(studio, 'ServiceStudio.Framework.dll'), '');
  return { dir, cli, studio };
}
// One customer's spec, as hostedWorkerSpec computes it: the hosted spawn environment of its workspace and its relay key.
function customer(t, s, name, { relay = 47000, cli = s.cli, studio = s.studio, extra = {} } = {}) {
  const workspace = temp(t, 'ssam-hw-' + name + '-');
  const authority = path.join(workspace, 'state', 'relay-authority'); fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'bridge.key'), 'KEY-' + name);
  const cwd = path.join(workspace, 'o11'); const tmp = path.join(cwd, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ANVIL_AUTHORITY_DIR: authority, ANVIL_BRIDGE_PORT: String(relay),
    ANVIL_STUDIO_DIR: studio, ANVIL_LANE: 'ss4', ANVIL_BRIDGE_FLAVOR: 'thin', ANVIL_BRIDGE_TIMEOUT_SECONDS: '600', ...extra };
  return respec({ tokenId: 'tok_' + name, contextId: 'ctx-' + name, env, cwd, cli, key: 'KEY-' + name, studioDir: studio, local: path.join(tmp, 'o11-worker') });
}
// The same customer with another environment or key (a new hosted context), its fingerprint computed again.
function respec(spec, envChanges = {}, key = spec.key) {
  const env = { ...spec.env, ...envChanges };
  return { ...spec, env, key, fingerprint: hostedFingerprint({ env, cwd: spec.cwd, cli: spec.cli, key }) };
}

// A spawn that starts no process: the child is an emitter whose pid the fake worker reports (unless pid is given; noPid: the
// child has none), and the fake worker comes up on the --port it was given after startMs, with the key of the environment's
// authority folder. exit: the child exits during startup with that code; never: nothing comes up and nothing exits;
// ignoreShutdown(env): that worker never answers its shutdown (only kill ends it); handler(request, record): the envelope
// of a command.
function fakeDotnet({ startMs = 30, exit = null, never = false, pid = null, noPid = false, studio = null, ignoreShutdown = () => false, handler = null } = {}) {
  const launched = []; let live = 0; let peak = 0;
  const fn = (file, args, options) => {
    const port = Number(args[args.indexOf('--port') + 1]);
    const child = new EventEmitter();
    child.pid = noPid ? undefined : 61000 + launched.length;
    const record = { file, args, options, child, port, key: null, worker: null, killed: [], exited: false };
    launched.push(record); live++; peak = Math.max(peak, live);
    const exitWith = async (code, signal = null) => {
      if (record.exited) return;
      record.exited = true; live--;
      await record.worker?.close();
      child.emit('exit', code, signal);
    };
    child.kill = (signal = 'SIGTERM') => { record.killed.push(signal); setImmediate(() => exitWith(null, signal)); return true; };
    child.unref = () => { record.unrefd = true; };
    setTimeout(async () => {
      if (never || record.exited) return;
      if (exit !== null) { await exitWith(exit); return; }
      record.key = fs.readFileSync(path.join(options.env.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'ascii').trim();
      record.worker = await fakeWorker({ port, key: record.key,
        status: { pid: pid ?? child.pid ?? 4343, instanceId: 'instance-' + launched.indexOf(record), studio: studio ?? options.env.ANVIL_STUDIO_DIR },
        handler: async request => {
          if (request.args[0] === 'shutdown') {
            if (ignoreShutdown(options.env)) return undefined;
            setImmediate(() => exitWith(0));
            return { ok: true, command: 'shutdown', data: {} };
          }
          return handler ? handler(request, record) : { ok: true, command: request.args[0], elapsedMs: 1, data: { bridgePort: options.env.ANVIL_BRIDGE_PORT } };
        } });
    }, startMs);
    return child;
  };
  return Object.assign(fn, { launched, peak: () => peak });
}
const pool = (t, options = {}) => { const p = new HostedO11Workers({ ...QUICK, ...options }); t.after(() => p.close()); return p; };
// The first call of a customer: cold at once, and the worker it starts in the background ready for the next call.
async function warmUp(workers, spec) {
  const first = await workers.run(spec, ['apply', '--first']);
  assert.equal(first.used, false, JSON.stringify(first)); assert.match(first.note, WARMING);
  const warming = workers.starting(spec.tokenId);
  assert.ok(warming, 'a start in the background');
  const started = await warming;
  const entry = workers.workerOf(spec.tokenId);
  assert.equal(started.ok, true, JSON.stringify(started));
  return entry;
}

test('settings: cap, idle, minimum residency and the memory profile from the server environment; invalid values keep the defaults', () => {
  assert.deepEqual([HOSTED_O11_WORKERS_MAX, HOSTED_O11_WORKER_IDLE_MS, HOSTED_O11_WORKER_MIN_IDLE_MS, HOSTED_O11_WORKER_HEAP_MB,
    HOSTED_O11_WORKER_MAX_COMMANDS, HOSTED_O11_WORKER_RSS_MB], [2, 600000, 120000, 1536, 1000, 1200]);
  const defaults = { max: 2, idleMs: 600000, minIdleMs: 120000, heapMb: 1536, maxCommands: 1000, rssMb: 1200, baseCacheMb: 0, disabled: false };
  assert.deepEqual(hostedWorkerSettings({}), defaults);
  assert.deepEqual(hostedWorkerSettings({ SSAM_O11_WORKERS_MAX: '3', SSAM_O11_WORKER_IDLE_MS: '120000', SSAM_O11_WORKER_MIN_IDLE_MS: '0',
    SSAM_O11_WORKER_HEAP_MB: '2048', SSAM_O11_WORKER_MAX_COMMANDS: '50', SSAM_O11_WORKER_RSS_MB: '0', SSAM_O11_WORKER_BASE_CACHE: '512' }),
  { max: 3, idleMs: 120000, minIdleMs: 0, heapMb: 2048, maxCommands: 50, rssMb: 0, baseCacheMb: 512, disabled: false });
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKERS_MAX: '0' }).disabled, true);
  assert.equal(hostedWorkerSettings({ ANVIL_WORKER: '0' }).disabled, true);
  assert.deepEqual(hostedWorkerSettings({ SSAM_O11_WORKERS_MAX: '-1', SSAM_O11_WORKER_IDLE_MS: 'soon', SSAM_O11_WORKER_MIN_IDLE_MS: '-5',
    SSAM_O11_WORKER_HEAP_MB: '100', SSAM_O11_WORKER_MAX_COMMANDS: '0', SSAM_O11_WORKER_RSS_MB: 'big', SSAM_O11_WORKER_BASE_CACHE: 'on' }), defaults);
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKER_BASE_CACHE: 'off' }).baseCacheMb, 0);
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKER_BASE_CACHE: '32' }).baseCacheMb, 0, 'below 64 MB a spare cannot fit: off');
  // The profile the pool sets: the base cache off, the GC heap hard limit in hexadecimal bytes, the command limit.
  assert.deepEqual(hostedWorkerProfile(), PROFILE);
  assert.deepEqual(hostedWorkerProfile(hostedWorkerSettings({ SSAM_O11_WORKER_BASE_CACHE: '512', SSAM_O11_WORKER_HEAP_MB: '2048', SSAM_O11_WORKER_MAX_COMMANDS: '50' })),
    { ANVIL_BASE_CACHE: 'on', ANVIL_BASE_CACHE_ENTRIES: '1', ANVIL_BASE_CACHE_MB: '512', DOTNET_GCHeapHardLimit: '0x80000000', ANVIL_WORKER_MAX_COMMANDS: '50' });
  assert.deepEqual(hostedWorkerProfile(hostedWorkerSettings({ SSAM_O11_WORKER_HEAP_MB: '0' })), { ANVIL_BASE_CACHE: 'off', ANVIL_WORKER_MAX_COMMANDS: '1000' });
  assert.deepEqual(HOSTED_O11_WORKER_VARIABLES, ['ANVIL_BASE_CACHE', 'ANVIL_BASE_CACHE_ENTRIES', 'ANVIL_BASE_CACHE_MB', 'DOTNET_GCHeapHardLimit',
    'ANVIL_WORKER_MAX_COMMANDS', 'ANVIL_WORKER_IDLE_MINUTES']);
  // The process's own pool: one, with the settings and the profile of this process's environment.
  const own = hostedWorkerSettings(process.env);
  assert.equal(hostedO11Workers(), hostedO11Workers());
  assert.deepEqual([hostedO11Workers().max, hostedO11Workers().minIdleMs, hostedO11Workers().rssMb], [own.max, own.minIdleMs, own.rssMb]);
  assert.deepEqual({ ...hostedO11Workers().profile }, hostedWorkerProfile(own));
});

test('the worker environment is the cold one plus only the pool\'s variables; the customer\'s environment cannot override them', () => {
  const cold = { PATH: '/usr/bin', TEMP: '/ws/o11/tmp', ANVIL_BRIDGE_PORT: '47000', ANVIL_BRIDGE_FLAVOR: 'thin', DOTNET_ROOT: '/usr/share/dotnet' };
  const env = hostedWorkerEnv(cold, PROFILE, 15);
  assert.deepEqual(env, { ...cold, ...PROFILE, ANVIL_WORKER_IDLE_MINUTES: '15' });
  assert.deepEqual(Object.keys(env).filter(name => !(name in cold)).sort(), ['ANVIL_BASE_CACHE', 'ANVIL_WORKER_IDLE_MINUTES', 'ANVIL_WORKER_MAX_COMMANDS', 'DOTNET_GCHeapHardLimit']);
  assert.ok(Object.keys(env).filter(name => !(name in cold)).every(name => HOSTED_O11_WORKER_VARIABLES.includes(name)));
  const pushed = { ...cold, ANVIL_BASE_CACHE: 'on', ANVIL_BASE_CACHE_ENTRIES: '8', ANVIL_BASE_CACHE_MB: '4096', DOTNET_GCHeapHardLimit: '0xFFFFFFFFF',
    DOTNET_gcServer: '1', COMPlus_GCHeapHardLimit: '0xFFFFFFFFF', anvil_worker_max_commands: '999999', ANVIL_WORKER_IDLE_MINUTES: '0' };
  assert.deepEqual(hostedWorkerEnv(pushed, PROFILE, 15), env, 'none of those survives');
});

test('the resident set of a pid comes from /proc/<pid>/status on Linux; elsewhere, or unreadable, it is unknown', () => {
  const status = 'Name:\tdotnet\nVmPeak:\t 2000000 kB\nVmRSS:\t  1258291 kB\nThreads:\t30\n';
  const reads = [];
  assert.equal(residentMb(4242, { platform: 'linux', readFile: file => { reads.push(file); return status; } }), 1229);
  assert.deepEqual(reads, ['/proc/4242/status']);
  assert.equal(residentMb(4242, { platform: 'win32', readFile: () => status }), null);
  assert.equal(residentMb(4242, { platform: 'linux', readFile: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(residentMb(4242, { platform: 'linux', readFile: () => 'Name:\tdotnet\n' }), null);
  assert.equal(residentMb(undefined, { platform: 'linux', readFile: () => status }), null);
});

test('the fingerprint follows the relay port, the relay key and the kernel build; not the order of the variables', t => {
  const s = server(t);
  const a = customer(t, s, 'a', { relay: 47001 });
  const reordered = Object.fromEntries(Object.entries(a.env).reverse());
  assert.equal(hostedFingerprint({ env: reordered, cwd: a.cwd, cli: a.cli, key: a.key }), a.fingerprint);
  assert.notEqual(respec(a, { ANVIL_BRIDGE_PORT: '47002' }).fingerprint, a.fingerprint);
  assert.notEqual(respec(a, {}, 'KEY-a-2').fingerprint, a.fingerprint);
  const later = new Date(Date.now() + 60000); fs.utimesSync(s.cli, later, later);
  assert.notEqual(respec(a).fingerprint, a.fingerprint, 'a rebuilt CLI is another kernel');
});

test('two customers get two workers, each with its own environment, profile, folder, port and key; B never reaches A\'s worker', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  const workers = pool(t, { spawnFn });
  // B's cold environment carries memory variables of its own (it never does in production): the pool's profile wins.
  const a = customer(t, s, 'a', { relay: 47101 });
  const b = customer(t, s, 'b', { relay: 47102, extra: { ANVIL_BASE_CACHE: 'on', ANVIL_BASE_CACHE_MB: '4096', DOTNET_GCHeapHardLimit: '0xFFFFFFFFF', ANVIL_WORKER_MAX_COMMANDS: '999999' } });
  await warmUp(workers, a); await warmUp(workers, b);
  const ra = await workers.run(a, ['apply', '--job', 'a1.json']);
  const rb = await workers.run(b, ['apply', '--job', 'b1.json']);
  assert.deepEqual([ra.used, ra.envelope.data.bridgePort, rb.used, rb.envelope.data.bridgePort], [true, '47101', true, '47102']);
  assert.equal(spawnFn.launched.length, 2);
  const [wa, wb] = spawnFn.launched;
  // Exactly the customer's spawn environment and folder, plus the pool's profile and the worker's own idle exit.
  assert.deepEqual(wa.options.env, { ...a.env, ...PROFILE, ANVIL_WORKER_IDLE_MINUTES: selfExit(QUICK.idleMs) });
  const { ANVIL_BASE_CACHE_MB: _mb, ...bCold } = b.env;
  assert.deepEqual(wb.options.env, { ...bCold, ...PROFILE, ANVIL_WORKER_IDLE_MINUTES: selfExit(QUICK.idleMs) }, 'the customer\'s values never override the profile');
  assert.equal(wa.options.cwd, a.cwd); assert.equal(wb.options.cwd, b.cwd);
  assert.equal(wa.file, 'dotnet'); assert.deepEqual(wa.args, [s.cli, 'serve', '--port', String(wa.port), '--log-dir', a.local]);
  assert.equal(wa.options.detached, undefined, 'the worker belongs to this process'); assert.equal(wa.options.windowsHide, true); assert.equal(wa.unrefd, true);
  assert.ok(fs.existsSync(path.join(a.local, `worker-${wa.port}-startup.log`)), 'its logs stay in the customer\'s workspace');
  assert.notEqual(wa.port, wb.port);
  assert.deepEqual([wa.key, wb.key], ['KEY-a', 'KEY-b'], 'each worker took its own customer\'s relay key as its controller key');
  // Each worker is reused by its own customer only, and every request carries that customer's key.
  await workers.run(a, ['apply', '--job', 'a2.json']); await workers.run(b, ['apply', '--job', 'b2.json']);
  assert.equal(spawnFn.launched.length, 2);
  assert.deepEqual(wa.worker.requests('apply').map(r => r.args[2]), ['a1.json', 'a2.json'], 'the first call of each customer ran cold');
  assert.deepEqual(wb.worker.requests('apply').map(r => r.args[2]), ['b1.json', 'b2.json']);
  assert.ok(wa.worker.requests('apply').every(r => r.authorization === 'KEY-a'));
  assert.ok(wb.worker.requests('apply').every(r => r.authorization === 'KEY-b'));
  // Even sent straight to A's port, a request with B's key runs nothing there.
  const crossed = await workerRequest({ port: wa.port, authorization: b.key, timeoutMs: 2000 }, ['apply', '--job', 'b3.json']);
  assert.deepEqual([crossed.reply.ok, crossed.reply.executed], [false, false]);
  assert.equal(wa.worker.requests('apply').filter(r => r.authorization === 'KEY-a').length, 2);
  assert.deepEqual([workers.workerOf('tok_a').port, workers.workerOf('tok_b').port], [wa.port, wb.port]);
});

test('a miss runs cold at once, never waiting for the worker it replaces; the new worker starts once that one exited and serves the next call', async t => {
  const s = server(t);
  let hold = deferred();
  // B ignores its shutdown: it keeps its place until it is terminated.
  const spawnFn = fakeDotnet({ ignoreShutdown: env => env.ANVIL_BRIDGE_PORT === '47202',
    handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { max: 2, spawnFn, now: monotonic(), stopMs: 400 });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name, i) => customer(t, s, name, { relay: 47201 + i }));
  await warmUp(workers, a); await warmUp(workers, b);
  assert.equal((await workers.run(a, ['apply'])).used, true); // B is now the least recently used
  const [wa, wb] = spawnFn.launched;
  const began = Date.now();
  const rc = await workers.run(c, ['apply']);
  const elapsed = Date.now() - began;
  assert.equal(rc.used, false); assert.match(rc.note, WARMING);
  assert.ok(elapsed < 400, `the miss returned after ${elapsed} ms, before B could even be asked to stop and terminated`);
  assert.deepEqual([wb.exited, spawnFn.launched.length], [false, 2], 'C\'s worker waits for B; the call did not');
  const started = await workers.starting('tok_c');
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(spawnFn.launched.length, 3);
  assert.equal(wb.worker.requests('shutdown').length, 1); assert.equal(wb.worker.requests('shutdown')[0].authorization, 'KEY-b');
  assert.deepEqual(wb.killed, ['SIGTERM'], 'B did not exit after its shutdown: terminated');
  assert.deepEqual([wb.exited, wa.exited], [true, false], 'B, the least recently used, made room; A stays');
  assert.deepEqual([...workers.entries.keys()].sort(), ['tok_a', 'tok_c']);
  assert.equal(spawnFn.peak(), 2, 'never more processes than the cap, a stopping one included');
  const wc = spawnFn.launched[2];
  assert.equal((await workers.run(c, ['apply', 'next'])).used, true, 'the start in the background serves C\'s next call');
  assert.deepEqual(notPing(wc.worker).map(r => r.args), [['apply', 'next']]);
  // Every place busy: a fourth customer runs cold; nothing is stopped or started.
  hold = deferred();
  const busy = [workers.run(a, ['apply', 'hold']), workers.run(c, ['apply', 'hold'])];
  await waitFor(() => wa.worker.requests('apply').some(r => r.args[1] === 'hold') && wc.worker.requests('apply').some(r => r.args[1] === 'hold'));
  const rd = await workers.run(d, ['apply']);
  assert.equal(rd.used, false); assert.match(rd.note, /no place for the customer's O11 worker now \(the 2 place\(s\) of this server are busy/);
  assert.equal(spawnFn.launched.length, 3); assert.deepEqual([wa.exited, wc.exited], [false, false]);
  hold.resolve();
  assert.deepEqual((await Promise.all(busy)).map(r => r.used), [true, true]);
});

test('round robin of 3 customers with 2 places: 2 workers in all (minimum residency), the third runs cold, and evicts only after the minimum', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  let clock = 1_000_000_000_000;
  const workers = pool(t, { max: 2, minIdleMs: 120000, spawnFn, now: () => clock });
  const specs = { a: customer(t, s, 'a', { relay: 47231 }), b: customer(t, s, 'b', { relay: 47232 }), c: customer(t, s, 'c', { relay: 47233 }) };
  const seen = { a: [], b: [], c: [] }; let lastNote = null;
  for (let round = 0; round < 4; round++) {
    for (const name of ['a', 'b', 'c']) {
      const r = await workers.run(specs[name], ['apply', String(round)]);
      seen[name].push(r.used ? 'worker' : 'cold');
      if (name === 'c') lastNote = r.note;
      await workers.starting(specs[name].tokenId); // a start in the background is over before the next call
      clock += 10;
    }
  }
  assert.equal(spawnFn.launched.length, 2, 'not a worker per call');
  assert.deepEqual(seen, { a: ['cold', 'worker', 'worker', 'worker'], b: ['cold', 'worker', 'worker', 'worker'], c: ['cold', 'cold', 'cold', 'cold'] });
  assert.match(lastNote, /no place for the customer's O11 worker now .* used in the last 120 s\); ran cold/);
  assert.deepEqual(spawnFn.launched.map(w => w.exited), [false, false]);
  // Two minutes later A (the least recently used) may give its place to C.
  clock += 120000;
  const rc = await workers.run(specs.c, ['apply', 'later']);
  assert.equal(rc.used, false); assert.match(rc.note, WARMING);
  assert.equal((await workers.starting('tok_c')).ok, true);
  assert.deepEqual(spawnFn.launched.map(w => w.exited), [true, false, false]);
  assert.equal((await workers.run(specs.c, ['apply', 'then'])).used, true);
  assert.equal(spawnFn.launched.length, 3);
});

test('idle: a worker without a call for the idle time is retired; the next call is a miss again', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  const workers = pool(t, { spawnFn, idleMs: 150 });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  const [first] = spawnFn.launched;
  assert.equal(first.options.env.ANVIL_WORKER_IDLE_MINUTES, selfExit(150), 'it would exit by itself 5 min after the idle time');
  await waitFor(() => first.exited);
  assert.equal(first.worker.requests('shutdown').length, 1); assert.deepEqual(first.killed, []);
  assert.equal(workers.workerOf('tok_a'), null); assert.equal(workers.size, 0);
  const again = await workers.run(a, ['apply']);
  assert.equal(again.used, false); assert.match(again.note, WARMING);
  await workers.starting('tok_a');
  assert.equal(spawnFn.launched.length, 2);
});

test('the working-set guard: a worker whose resident set passed SSAM_O11_WORKER_RSS_MB is retired after its call, never during it', async t => {
  const s = server(t);
  const rss = new Map();
  const spawnFn = fakeDotnet();
  const workers = pool(t, { spawnFn, rssMb: 1200, rssOf: pid => rss.get(pid) ?? null });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  const [w] = spawnFn.launched;
  // Unknown (another system) or below the limit: it stays.
  assert.equal((await workers.run(a, ['apply', 'unknown'])).used, true);
  rss.set(w.child.pid, 900);
  assert.equal((await workers.run(a, ['apply', 'small'])).used, true);
  assert.ok(workers.workerOf('tok_a'));
  // Above it: the call that made it big ends with its answer, then the worker goes.
  rss.set(w.child.pid, 1300);
  const big = await workers.run(a, ['apply', 'big']);
  assert.deepEqual([big.used, big.envelope.ok], [true, true]);
  assert.equal(workers.workerOf('tok_a'), null, 'retired once the call was over');
  await waitFor(() => w.exited);
  assert.deepEqual(notPing(w.worker).map(r => r.args[0] === 'shutdown' ? 'shutdown' : r.args[1]), ['unknown', 'small', 'big', 'shutdown']);
  assert.deepEqual(w.killed, []);
  // SSAM_O11_WORKER_RSS_MB=0: no guard.
  const unguarded = pool(t, { spawnFn: fakeDotnet(), rssMb: 0, rssOf: () => 99999 });
  const b = customer(t, s, 'b');
  await warmUp(unguarded, b);
  assert.equal((await unguarded.run(b, ['apply'])).used, true);
  assert.ok(unguarded.workerOf('tok_b'));
});

test('a new environment of the same customer (relay port, relay key) retires its idle worker; a busy one stays and the call runs cold', async t => {
  const s = server(t);
  let hold = null;
  const spawnFn = fakeDotnet({ handler: async (request, record) => {
    if (request.args[1] === 'hold') await hold.promise;
    return { ok: true, command: request.args[0], data: { bridgePort: record.options.env.ANVIL_BRIDGE_PORT, key: record.key } };
  } });
  const workers = pool(t, { spawnFn });
  const a1 = customer(t, s, 'a', { relay: 47301 });
  await warmUp(workers, a1);
  assert.equal((await workers.run(a1, ['apply'])).envelope.data.bridgePort, '47301');
  // A new hosted context: another relay port. The call is a miss; the new worker starts once the old one exited.
  const a2 = respec(a1, { ANVIL_BRIDGE_PORT: '47302' });
  await warmUp(workers, a2);
  const r2 = await workers.run(a2, ['apply']);
  assert.equal(r2.envelope.data.bridgePort, '47302');
  const [first, second] = spawnFn.launched;
  assert.equal(first.exited, true); assert.equal(first.worker.requests('shutdown').length, 1);
  assert.equal(second.options.env.ANVIL_BRIDGE_PORT, '47302');
  // ... and a new relay key in the same folder.
  fs.writeFileSync(path.join(a1.env.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'KEY-a-2');
  const a3 = respec(a2, {}, 'KEY-a-2');
  await warmUp(workers, a3);
  const r3 = await workers.run(a3, ['apply']);
  assert.equal(r3.envelope.data.key, 'KEY-a-2'); assert.equal(spawnFn.launched.length, 3); assert.equal(second.exited, true);
  // Busy with the environment it was started with: it finishes, and the call of the new environment runs cold.
  hold = deferred();
  const running = workers.run(a3, ['apply', 'hold']);
  const third = spawnFn.launched[2];
  await waitFor(() => third.worker.requests('apply').some(r => r.args[1] === 'hold'));
  const r4 = await workers.run(respec(a3, { ANVIL_BRIDGE_PORT: '47303' }), ['apply']);
  assert.equal(r4.used, false); assert.match(r4.note, /still serves its earlier environment .* and is busy; ran cold/);
  assert.equal(third.exited, false); assert.equal(spawnFn.launched.length, 3);
  hold.resolve();
  assert.equal((await running).used, true);
});

test('cold, with the reason: busy, starting, an exit during startup (remembered), a deadline, another Studio, CLI or Studio missing, a spawn error', async t => {
  const s = server(t);
  // Still starting in the background for this customer, then busy with another call of the same customer.
  let hold = deferred();
  const holding = fakeDotnet({ startMs: 300, handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { spawnFn: holding });
  const a = customer(t, s, 'a');
  const first = await workers.run(a, ['apply']);
  assert.match(first.note, WARMING);
  const early = await workers.run(a, ['apply']);
  assert.equal(early.used, false); assert.match(early.note, /is starting in the background; ran cold/);
  await workers.starting('tok_a');
  const running = workers.run(a, ['apply', 'hold']);
  await waitFor(() => holding.launched[0].worker.requests('apply').some(r => r.args[1] === 'hold'));
  const busy = await workers.run(a, ['apply']);
  assert.equal(busy.used, false); assert.match(busy.note, /is busy with another call; ran cold/);
  hold.resolve(); await running;
  assert.equal(holding.launched.length, 1);

  const cases = [
    [{ exit: 1 }, {}, /exited during startup \(exit 1\); see .*worker-\d+-startup\.log/],
    [{ never: true }, { waitMs: 400 }, /did not start within 0 s/],
    [{ studio: path.join(s.dir, 'Other Studio') }, {}, /serves .*Other Studio, not /],
  ];
  for (const [fake, options, note] of cases) {
    const spawnFn = fakeDotnet(fake);
    const each = pool(t, { spawnFn, minIdleMs: 60000, ...options });
    const x = customer(t, s, 'x');
    const r = await each.run(x, ['apply']);
    assert.equal(r.used, false, JSON.stringify(fake)); assert.match(r.note, WARMING);
    const started = await each.starting('tok_x');
    assert.equal(started.ok, false); assert.match(started.note, note);
    assert.equal(each.workerOf('tok_x'), null);
    // A worker that did not start as this customer's is terminated; nothing is sent to its port.
    await waitFor(() => spawnFn.launched[0].exited);
    assert.equal(each.size, 0);
    if (spawnFn.launched[0].worker) assert.deepEqual(notPing(spawnFn.launched[0].worker), []);
    // The failure is remembered for the minimum residency: the next call runs cold with it and starts nothing.
    const next = await each.run(x, ['apply']);
    assert.equal(next.used, false); assert.match(next.note, /did not start a moment ago \(/); assert.match(next.note, note);
    assert.equal(spawnFn.launched.length, 1);
  }
  const none = fakeDotnet();
  const missing = pool(t, { spawnFn: none });
  const y = customer(t, s, 'y', { cli: path.join(s.dir, 'none', 'anvil.dll') });
  await missing.run(y, ['apply']);
  assert.match((await missing.starting('tok_y')).note, /CLI is not built/);
  const z = customer(t, s, 'z', { studio: path.join(s.dir, 'empty') });
  await missing.run(z, ['apply']);
  assert.match((await missing.starting('tok_z')).note, /ServiceStudio\.Framework\.dll/);
  assert.equal(none.launched.length, 0); assert.equal(missing.size, 0);
  const refused = pool(t, { spawnFn: () => { throw new Error('spawn EPERM'); } });
  await refused.run(customer(t, s, 'w'), ['apply']);
  assert.match((await refused.starting('tok_w')).note, /could not be started \(spawn EPERM\)/);
  assert.equal(refused.size, 0);
});

test('nothing with the customer\'s key reaches a listener that is not its worker: another pid at startup, a spawn without pid, another pid later, no ping', async t => {
  const s = server(t);
  // Another pid answers the ping at startup: the process started here is terminated; only pings reached the port.
  const otherPid = fakeDotnet({ pid: 999 });
  const p1 = pool(t, { spawnFn: otherPid });
  const x = customer(t, s, 'x');
  await p1.run(x, ['apply']);
  assert.match((await p1.starting('tok_x')).note, /is answered on its port by pid 999, not 61000/);
  await waitFor(() => otherPid.launched[0].exited);
  assert.deepEqual(otherPid.launched[0].killed, ['SIGTERM']);
  assert.deepEqual(notPing(otherPid.launched[0].worker), [], 'no shutdown, no key');
  assert.ok(otherPid.launched[0].worker.seen.every(r => r.authorization === undefined));

  // A spawn whose pid is unknown: what listens on its port is never adopted, not even pinged.
  const squatter = await fakeWorker({ status: { pid: 61000, instanceId: 'squatter', studio: s.studio } });
  t.after(() => squatter.close());
  const noPid = fakeDotnet({ noPid: true, never: true });
  const p2 = pool(t, { spawnFn: noPid, freePort: async () => squatter.port });
  const y = customer(t, s, 'y');
  await p2.run(y, ['apply']);
  assert.match((await p2.starting('tok_y')).note, /was started without a process id, so nothing on its port is adopted/);
  await waitFor(() => noPid.launched[0].exited);
  assert.deepEqual(noPid.launched[0].killed, ['SIGTERM']);
  assert.deepEqual(squatter.seen, [], 'nothing was sent to the listener');
  assert.equal(p2.size, 0);

  // A ready worker whose port is answered by another process later: terminated, nothing sent with the key.
  const spawnFn = fakeDotnet();
  const p3 = pool(t, { spawnFn, pingMs: 300 });
  const a = customer(t, s, 'a');
  await warmUp(p3, a);
  const [wa] = spawnFn.launched;
  await wa.worker.close();
  const intruder = await fakeWorker({ port: wa.port, status: { pid: 777, instanceId: 'intruder', studio: s.studio } });
  t.after(() => intruder.close());
  const r = await p3.run(a, ['deliver']);
  assert.equal(r.used, false); assert.match(r.note, /is answered on its port by pid 777, not 61000; ran cold/);
  await waitFor(() => wa.exited);
  assert.deepEqual(wa.killed, ['SIGTERM']);
  assert.deepEqual(notPing(intruder), [], 'no deliver, no shutdown');
  assert.ok(intruder.seen.every(req => req.authorization === undefined));
  await intruder.close();

  // No ping at all (its port closed): terminated, nothing written anywhere.
  const b = customer(t, s, 'b');
  await warmUp(p3, b);
  const wb = spawnFn.launched[1];
  await wb.worker.close();
  const silent = await p3.run(b, ['deliver']);
  assert.equal(silent.used, false); assert.match(silent.note, /does not answer its ping; ran cold/);
  await waitFor(() => wb.exited);
  assert.deepEqual(wb.killed, ['SIGTERM']);
  assert.deepEqual(notPing(wb.worker), []);
});

test('a worker that recycles serves no more: cold before anything is written, and the next call is a miss', async t => {
  const s = server(t);
  let recycle = false;
  const spawnFn = fakeDotnet({ handler: request => (recycle
    ? { ok: false, command: request.args[0], error: 'worker recycling; request was not executed', retryable: true, executed: false }
    : { ok: true, command: request.args[0], data: {} }) });
  const workers = pool(t, { spawnFn, pingMs: 300 });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  assert.equal((await workers.run(a, ['apply'])).used, true);
  recycle = true;
  const recycled = await workers.run(a, ['apply']);
  assert.equal(recycled.used, false); assert.match(recycled.note, /was recycling before executing the request; ran cold/);
  assert.equal(workers.workerOf('tok_a'), null);
  // It drains: its ping says idle, so it is asked to shut down (never cut).
  await waitFor(() => spawnFn.launched[0].exited);
  assert.deepEqual(spawnFn.launched[0].killed, []);
  recycle = false;
  const next = await workers.run(a, ['apply']);
  assert.equal(next.used, false); assert.match(next.note, WARMING);
});

test('a request written with no reply is an unknown outcome: sent once, never replayed, and its worker retired', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet({ handler: request => (request.args[1] === 'drop' ? 'drop' : request.args[1] === 'silent' ? undefined
    : { ok: true, command: request.args[0], data: {} }) });
  const workers = pool(t, { spawnFn });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  const [first] = spawnFn.launched;
  const lost = await workers.run(a, ['deliver', 'drop']);
  assert.deepEqual([lost.used, lost.unknown, lost.code], [true, true, 'WORKER_OUTCOME_UNKNOWN']);
  assert.match(lost.error, /outcome is unknown, command was not replayed/);
  assert.equal(first.worker.requests('deliver').length, 1, 'sent once');
  assert.equal(workers.workerOf('tok_a'), null, 'retired');
  await waitFor(() => first.exited);
  // A timeout after the write is unknown too.
  await warmUp(workers, a);
  const late = await workers.run(a, ['deliver', 'silent'], { timeoutMs: 300 });
  assert.deepEqual([late.used, late.unknown, late.code], [true, true, 'WORKER_OUTCOME_UNKNOWN']);
  const second = spawnFn.launched[1];
  assert.equal(second.worker.requests('deliver').length, 1);
  await waitFor(() => second.exited);
  // The next calls: a miss, then a new worker; nothing of the earlier requests is sent again.
  await warmUp(workers, a);
  assert.equal((await workers.run(a, ['apply', 'next'])).used, true);
  assert.equal(spawnFn.launched.length, 3);
  assert.deepEqual(notPing(spawnFn.launched[2].worker).map(r => r.args), [['apply', 'next']]);
});

test('after an unknown outcome the command still running is waited for: shutdown once its ping says idle, terminated only past the call\'s timeout', async t => {
  const s = server(t);
  // 'outlive': the connection drops while the command goes on (the worker's ping says busy until the test ends it).
  const spawnFn = fakeDotnet({ handler: (request, record) => {
    if (request.args[1] === 'outlive') { record.worker.state.busy = true; record.worker.state.currentCommand = request.args[0]; return 'drop'; }
    return { ok: true, command: request.args[0], data: {} };
  } });
  const workers = pool(t, { spawnFn, pingMs: 300, stopMs: 300 });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  const [w] = spawnFn.launched;
  const lost = await workers.run(a, ['deliver', 'outlive'], { timeoutMs: 20000 });
  assert.deepEqual([lost.used, lost.unknown], [true, true]);
  await sleep(1500);
  assert.deepEqual([w.exited, w.killed, w.worker.requests('shutdown').length], [false, [], 0], 'not cut while its command runs');
  assert.equal(workers.workerOf('tok_a'), null, 'no new call reaches it');
  assert.equal(workers.size, 1, 'still counted by the cap');
  w.worker.state.busy = false; w.worker.state.currentCommand = null;
  await waitFor(() => w.exited, 5000);
  assert.equal(w.worker.requests('shutdown').length, 1); assert.deepEqual(w.killed, []);
  assert.equal(w.worker.requests('deliver').length, 1, 'never replayed');
  // Still busy past the call's own timeout: terminated, and nothing is sent.
  await warmUp(workers, a);
  const w2 = spawnFn.launched[1];
  const late = await workers.run(a, ['deliver', 'outlive'], { timeoutMs: 700 });
  assert.equal(late.unknown, true);
  await waitFor(() => w2.exited, 5000);
  assert.deepEqual(w2.killed, ['SIGTERM']); assert.equal(w2.worker.requests('shutdown').length, 0);
  assert.equal(w2.worker.requests('deliver').length, 1);
});

test('a closed hosted context retires its customer\'s worker: now, after the call it runs, or once its start in the background is over', async t => {
  // The executor tells its listeners when a context has closed.
  const seen = [];
  const off = onHostedContextClose(context => seen.push(context.tokenId));
  t.after(off);
  class AgentExecutor { async start() {} o11Connection() { return null; } async call() { return {}; } async close() {} }
  const workspace = path.join(temp(t, 'ssam-hw-close-'), 'customers', 'tok_close');
  const context = await createHostedContext({ tokenId: 'tok_close', agent: { tokenId: 'tok_close' }, workspace }, { loadExecutor: async () => ({ AgentExecutor }) });
  await context.close(); await context.close();
  assert.deepEqual(seen, ['tok_close']);

  const s = server(t);
  let hold = deferred();
  const spawnFn = fakeDotnet({ handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { spawnFn });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  workers.contextClosed('tok_a', 'another-context');
  assert.ok(workers.workerOf('tok_a'), 'another context of the token is not this worker\'s');
  workers.contextClosed('tok_a', a.contextId);
  await waitFor(() => spawnFn.launched[0].exited);
  assert.equal(workers.workerOf('tok_a'), null);
  // Busy: retired once its call is over.
  await warmUp(workers, a);
  const running = workers.run(a, ['apply', 'hold']);
  await waitFor(() => spawnFn.launched[1].worker?.requests('apply').some(r => r.args[1] === 'hold'));
  workers.contextClosed('tok_a', a.contextId);
  assert.equal(spawnFn.launched[1].exited, false);
  hold.resolve();
  assert.equal((await running).used, true);
  await waitFor(() => spawnFn.launched[1].exited);
  // Starting in the background: retired as soon as the start is over.
  await workers.run(a, ['apply']);
  const warming = workers.starting('tok_a');
  workers.contextClosed('tok_a', a.contextId);
  assert.equal((await warming).ok, true);
  assert.equal(workers.workerOf('tok_a'), null);
  await waitFor(() => spawnFn.launched[2].exited);
});

// ---- the facade's callers in a hosted call -----------------------------------------------------------------------------
function hostedContextOf(t, name, { relay = 47500, studio = path.join(os.tmpdir(), 'ssam-hw-kernel', 'Service Studio') } = {}) {
  const workspace = path.join(temp(t, 'ssam-hw-ctx-'), 'customers', 'tok_' + name);
  prepareWorkspace(workspace);
  const executor = { id: 'fake-' + name, hosted: true, relayPort: () => relay, o11Connection: () => null, async close() {},
    async call(kind) { throw Object.assign(new Error('no machine call here: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
  return { id: randomUUID(), hosted: true, tokenId: 'tok_' + name, customer: name, lanes: ['o11'], workspace, agent: null, executor,
    o11: { studioDir: studio, lane: 'ss4' }, close: async () => {} };
}
// The customers' workers as the callers see them: each call recorded, the answer programmed.
function recordingPool(answer = () => ({ used: true, envelope: { ok: true, command: 'apply', data: { accepted: true, isValid: true } } })) {
  const calls = [];
  return { calls, run: async (spec, argv, options) => { calls.push({ spec, argv, options }); return answer(spec, argv); } };
}

test('hosted, createWorkerFirstRunner sends each customer\'s command to that customer\'s worker, with its own spawn environment and key', async t => {
  const a = hostedContextOf(t, 'a', { relay: 47501 }); const b = hostedContextOf(t, 'b', { relay: 47502 });
  const workers = recordingPool(spec => ({ used: true, envelope: { ok: true, command: 'deliver', data: { token: spec.tokenId } } }));
  const cold = fakeAnvil({ deliver: () => ({ ok: true, data: { cold: true } }) });
  const run = createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: workers });
  const ra = await runWithExecutor(a, () => run(['deliver', '--module', 'M'], { timeoutMs: 3600000 }));
  const rb = await runWithExecutor(b, () => run(['deliver', '--module', 'N']));
  assert.deepEqual([ra.ok, ra.via, ra.envelope.data.token, rb.via, rb.envelope.data.token], [true, 'worker', 'tok_a', 'worker', 'tok_b']);
  assert.equal(cold.calls.length, 0);
  const [ca, cb] = workers.calls;
  const spawnA = runWithExecutor(a, () => hostedSpawnEnv('o11'));
  assert.deepEqual(ca.spec.env, spawnA.env, 'the environment of the customer\'s cold process'); assert.equal(ca.spec.cwd, spawnA.cwd);
  assert.equal(ca.spec.env.ANVIL_BRIDGE_PORT, '47501'); assert.equal(cb.spec.env.ANVIL_BRIDGE_PORT, '47502');
  assert.equal(ca.spec.key, fs.readFileSync(path.join(a.workspace, 'state', 'relay-authority', 'bridge.key'), 'ascii').trim());
  assert.equal(cb.spec.key, fs.readFileSync(path.join(b.workspace, 'state', 'relay-authority', 'bridge.key'), 'ascii').trim());
  assert.notEqual(ca.spec.key, cb.spec.key);
  assert.deepEqual([ca.spec.tokenId, ca.spec.contextId, cb.spec.tokenId, cb.spec.contextId], ['tok_a', a.id, 'tok_b', b.id]);
  assert.equal(ca.spec.local, path.join(a.workspace, 'o11', 'tmp', 'o11-worker'));
  assert.equal(ca.spec.cli, runWithExecutor(a, () => o11LaneOf('ss4').cli), 'the server\'s CLI');
  assert.equal(ca.spec.studioDir, a.o11.studioDir);
  assert.deepEqual(ca.argv, ['deliver', '--module', 'M']); assert.deepEqual(ca.options, { timeoutMs: 3600000 }); assert.deepEqual(cb.options, {});
  assert.deepEqual(runWithExecutor(a, () => hostedWorkerSpec({ env: {} })), ca.spec);
  // The customer's spec carries no memory variable: the pool adds its profile when it launches (hostedWorkerEnv).
  assert.ok(HOSTED_O11_WORKER_VARIABLES.every(name => !(name in ca.spec.env)));
  // Unknown outcome: reported as timedOut, never run cold.
  const lost = createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: recordingPool(() => ({ used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', error: 'worker connection failed after submission' })) });
  const unknown = await runWithExecutor(a, () => lost(['deliver', '--module', 'M']));
  assert.deepEqual([unknown.ok, unknown.timedOut, unknown.unknown, unknown.via], [false, true, true, 'worker']);
  assert.equal(cold.calls.length, 0);
  // Nothing ran there (a miss, busy, no place): the same command runs cold, with the reason.
  const full = createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: recordingPool(() => ({ used: false, note: "the customer's O11 worker is not running: this call ran cold and the worker starts in the background for the next call" })) });
  const missed = await runWithExecutor(a, () => full(['deliver', '--module', 'M']));
  assert.equal(missed.ok, true); assert.deepEqual(missed.envelope.data, { cold: true }); assert.match(missed.workerNote, WARMING);
  assert.equal(cold.calls.length, 1);
  // app-session, stdin input and another assembly stay cold, as locally.
  await runWithExecutor(a, () => run(['app-session'], { input: {} }));
  assert.equal(workers.calls.length, 2);
});

test('hosted, an O11 job runs on the customer\'s worker; an unknown outcome is never run cold; a worker that ran nothing sends it cold', async t => {
  const a = hostedContextOf(t, 'a');
  const accepted = { ok: true, command: 'apply', data: { accepted: true, isValid: true, ops: 1 } };
  const cold = fakeAnvil({ apply: () => accepted });
  const deps = workers => ({ env: {}, runAnvil: cold, hostedWorkers: workers, prepareIntegrationJob: async () => ({}) });
  const job = { ops: [{ op: 'get', target: 'ServerAction:SaveOrder' }] };
  const worked = recordingPool();
  const ok = await runWithExecutor(a, () => runJob({ lane: 'o11', job }, deps(worked)));
  assert.deepEqual([ok.ok, ok.via, cold.calls.length, worked.calls.length], [true, 'worker', 0, 1], JSON.stringify(ok));
  assert.equal(worked.calls[0].argv[0], 'apply'); assert.equal(worked.calls[0].spec.tokenId, 'tok_a');
  assert.ok(inside(ok.out, path.join(a.workspace, 'o11', 'jobs')));
  const lost = recordingPool(() => ({ used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', error: 'worker connection failed after submission; execution outcome is unknown, command was not replayed' }));
  const unknown = await runWithExecutor(a, () => runJob({ lane: 'o11', job }, deps(lost)));
  assert.deepEqual([unknown.ok, unknown.code, lost.calls.length, cold.calls.length], [false, 'worker-outcome-unknown', 1, 0]);
  const refused = recordingPool(() => ({ used: true, envelope: { ok: false, command: 'apply', error: 'Worker operation requires the trusted Hybrid controller', executed: false } }));
  const ranCold = await runWithExecutor(a, () => runJob({ lane: 'o11', job }, deps(refused)));
  assert.deepEqual([ranCold.ok, ranCold.via, cold.calls.length], [true, 'process', 1]);
  assert.match(ranCold.worker, /did not run the request \(Worker operation requires the trusted Hybrid controller\); ran cold/);
  const busy = recordingPool(() => ({ used: false, note: "the customer's O11 worker is busy with another call; ran cold" }));
  const besides = await runWithExecutor(a, () => runJob({ lane: 'o11', job }, deps(busy)));
  assert.deepEqual([besides.ok, besides.via, besides.worker, cold.calls.length], [true, 'process', "the customer's O11 worker is busy with another call; ran cold", 2]);
});

test('no customer worker is asked when off, with a root passed on purpose, or outside a hosted call; local mode keeps the lane worker', async t => {
  const a = hostedContextOf(t, 'a');
  const never = { run: async () => { throw new Error('the customers\' workers are never asked here'); } };
  const cold = fakeAnvil({ inventory: () => ({ ok: true, data: {} }) });
  for (const env of [{ ANVIL_WORKER: '0' }, { SSAM_O11_WORKERS_MAX: '0' }]) {
    const r = await runWithExecutor(a, () => createWorkerFirstRunner({ cold, env }, { hostedWorkers: never })(['inventory']));
    assert.equal(r.ok, true); assert.equal(r.via, undefined);
  }
  assert.equal(cold.calls.length, 2);
  runWithExecutor(a, () => {
    assert.equal(hostedWorkerClient({ root: os.tmpdir(), env: {}, pool: never }), null, 'a root passed on purpose runs as its cold process does');
    assert.equal(hostedWorkerClient({ env: { ANVIL_WORKER: '0' }, pool: never }), null);
    assert.ok(hostedWorkerClient({ env: {}, pool: never }));
    assert.equal(workerDisabled('o11', {}), true, 'the lane\'s own O11 worker stays off for a customer');
  });
  // Outside a hosted call the customers' workers do not exist, and the lane's worker serves as before.
  assert.equal(hostedWorkerClient({ env: {}, pool: never }), null);
  const lane = { calls: [], run: async argv => { lane.calls.push(argv); return { used: true, envelope: { ok: true, command: argv[0], data: {} } }; } };
  const local = await createWorkerFirstRunner({ cold, worker: lane, env: {} }, { hostedWorkers: never })(['inventory']);
  assert.deepEqual([local.via, lane.calls.length], ['worker', 1]);
  // A hosted call never reaches the lane's worker a runner was given.
  const hosted = await runWithExecutor(a, () => createWorkerFirstRunner({ cold, worker: lane, env: { ANVIL_WORKER: '0' } })(['inventory']));
  assert.equal(hosted.ok, true); assert.equal(lane.calls.length, 1);
});

// R2-F rule 3 (warm worker, base cache, measured memory): on the hosted server every ssam_code check ran cold (BankDash:
// 11 of 11, 267 s) because the O11 lane worker is off there and the check never asked the customer's own worker; a
// customer had one worker serving one call at a time; nothing bounded the workers by the host's memory; a Studio replaced
// in the same folder kept the old worker. These tests prove the general case with fakes only: no kernel, no Studio, no
// process (the spawn brings up a fake TCP worker on the port it is given), temporary folders.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as worker from '../anvil-worker.mjs';
import { codeCheck } from '../code-check.mjs';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { fakeWorker } from './fixtures/jobs-fake-worker.mjs';

const { HostedO11Workers, hostedFingerprint, hostedWorkerSettings } = worker;
const QUICK = { waitMs: 3000, pingMs: 1000, stopMs: 150, idleMs: 60000, minIdleMs: 0 };
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('condition not met within ' + ms + ' ms'); await sleep(20); }
}
const option = (args, name) => args[args.indexOf(name) + 1];

function server(t) {
  const dir = temp(t, 'ssam-warm-server-');
  const cli = path.join(dir, 'cli', 'anvil.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const studio = path.join(dir, 'Service Studio'); fs.mkdirSync(studio); fs.writeFileSync(path.join(studio, 'ServiceStudio.Framework.dll'), 'studio 11.55.93');
  return { dir, cli, studio };
}
function customer(t, s, name, { relay = 47000 } = {}) {
  const workspace = temp(t, 'ssam-warm-' + name + '-');
  const authority = path.join(workspace, 'state', 'relay-authority'); fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'bridge.key'), 'KEY-' + name);
  const cwd = path.join(workspace, 'o11'); const tmp = path.join(cwd, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ANVIL_AUTHORITY_DIR: authority, ANVIL_BRIDGE_PORT: String(relay),
    ANVIL_STUDIO_DIR: s.studio, ANVIL_LANE: 'ss4' };
  const spec = { tokenId: 'tok_' + name, contextId: 'ctx-' + name, env, cwd, cli: s.cli, key: 'KEY-' + name, studioDir: s.studio, local: path.join(tmp, 'o11-worker') };
  return { ...spec, fingerprint: hostedFingerprint(spec) };
}
// A spawn that starts no process: a fake worker comes up on the --port it was given. handler(request, record): an envelope.
function fakeDotnet({ startMs = 20, handler = null } = {}) {
  const launched = [];
  const fn = (file, args, options) => {
    const port = Number(args[args.indexOf('--port') + 1]);
    const child = new EventEmitter();
    child.pid = 62000 + launched.length;
    const record = { file, args, options, child, port, worker: null, exited: false };
    launched.push(record);
    const exitWith = async (code, signal = null) => { if (record.exited) return; record.exited = true; await record.worker?.close(); child.emit('exit', code, signal); };
    child.kill = (signal = 'SIGTERM') => { setImmediate(() => exitWith(null, signal)); return true; };
    child.unref = () => {};
    setTimeout(async () => {
      if (record.exited) return;
      const key = fs.readFileSync(path.join(options.env.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'ascii').trim();
      record.worker = await fakeWorker({ port, key, status: { pid: child.pid, instanceId: 'instance-' + launched.indexOf(record), studio: options.env.ANVIL_STUDIO_DIR },
        handler: async request => {
          if (request.args[0] === 'shutdown') { setImmediate(() => exitWith(0)); return { ok: true, command: 'shutdown', data: {} }; }
          return handler ? handler(request, record) : { ok: true, command: request.args[0], elapsedMs: 1, data: {} };
        } });
    }, startMs);
    return child;
  };
  return Object.assign(fn, { launched });
}
const pool = (t, options = {}) => { const p = new HostedO11Workers({ ...QUICK, ...options }); t.after(() => p.close()); return p; };
async function warmUp(workers, spec) {
  const first = await workers.run(spec, ['apply', '--first']);
  assert.equal(first.used, false, JSON.stringify(first));
  const started = await workers.starting(spec.tokenId);
  assert.equal(started?.ok, true, JSON.stringify(started));
  return workers.workerOf(spec.tokenId);
}

// ---- the check reaches the customer's worker ---------------------------------------------------------------------------
function kernelApply(args) {
  const out = option(args, '--out');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'candidate of ' + option(args, '--job'));
  const data = { accepted: true, isValid: true, verifyRan: true, timings: { totalMs: 30, loadMs: 1 }, hot: { reused: true, reason: 'spare', savedMs: 900 } };
  fs.writeFileSync(out.replace(/\.oml$/i, '.result.json'), JSON.stringify({ ...data, sources: [{ path: option(args, '--job'), sha256: 'x' }], provenance: { kernelSha256: 'k' } }));
  return { ok: true, command: 'apply', elapsedMs: 40, data };
}
function hostedCustomer(t, name) {
  const workspace = path.join(temp(t, 'ssam-warm-ctx-'), 'customers', 'tok_' + name);
  prepareWorkspace(workspace);
  const studio = path.join(os.tmpdir(), 'ssam-warm-kernel', 'Service Studio');
  const executor = { id: 'fake-' + name, hosted: true, relayPort: () => 47600, o11Connection: () => null, quota: { full: () => false }, async close() {},
    async call(kind) { throw Object.assign(new Error('no machine call here: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
  const context = { id: randomUUID(), hosted: true, tokenId: 'tok_' + name, customer: name, lanes: ['o11'], workspace, agent: null, executor,
    o11: { studioDir: studio, lane: 'ss4' }, close: async () => {} };
  const snapshots = path.join(workspace, 'o11', 'snapshots'); fs.mkdirSync(snapshots, { recursive: true });
  const base = path.join(snapshots, 'Neutral.oml'); fs.writeFileSync(base, 'OML base');
  const roots = { o11: path.join(workspace, 'o11'), odc: path.join(workspace, 'odc'), odcWork: path.join(workspace, 'odc', 'lab') };
  return { context, base, roots };
}

test('warm: a hosted ssam_code check runs its apply on the calling customer\'s own worker, not in a cold process', async t => {
  const c = hostedCustomer(t, 'a');
  const cold = [];
  const runAnvil = async (args) => { cold.push(args[0]); const envelope = kernelApply(args); return { ok: true, exitCode: 0, envelope, stderr: [], wallMs: 1 }; };
  const calls = [];
  const hostedWorkers = { run: async (spec, argv) => { calls.push({ spec, argv }); return { used: true, envelope: kernelApply(argv) }; } };
  const answer = await runWithExecutor(c.context, () => codeCheck({ lane: 'o11', action: 'check', module: 'Neutral', part: 'logic', text: 'server action NeutralCheck\n  end\n', base: c.base },
    { roots: c.roots, env: {}, runAnvil, hostedWorkers, guidance: async (_lane, _job, run) => run }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.timings?.via, 'worker', JSON.stringify(answer.timings));
  assert.equal(answer.timings.hot.reused, true);
  assert.deepEqual(calls.map(c => c.argv[0]), ['apply']);
  assert.equal(calls[0].spec.tokenId, 'tok_a', 'the worker of the customer of this call');
  assert.ok(!cold.includes('apply'), 'no cold apply: ' + cold.join(','));
  // A worker that ran nothing (busy, starting, no place) leaves the check cold, with the same answer.
  const busy = { run: async () => ({ used: false, note: "the customer's O11 worker is busy with another call; ran cold" }) };
  const besides = await runWithExecutor(c.context, () => codeCheck({ lane: 'o11', action: 'check', module: 'Neutral', part: 'logic', text: 'server action NeutralCheck\n  end\n', base: c.base },
    { roots: c.roots, env: {}, runAnvil, hostedWorkers: busy, guidance: async (_lane, _job, run) => run }));
  assert.equal(besides.ok, true); assert.equal(besides.timings.via, 'process'); assert.ok(cold.includes('apply'));
  // Off (ANVIL_WORKER=0 or SSAM_O11_WORKERS_MAX=0): cold, the pool never asked.
  const never = { run: async () => { throw new Error('never asked when off'); } };
  for (const env of [{ ANVIL_WORKER: '0' }, { SSAM_O11_WORKERS_MAX: '0' }]) {
    const off = await runWithExecutor(c.context, () => codeCheck({ lane: 'o11', action: 'check', module: 'Neutral', part: 'logic', text: 'server action NeutralCheck\n  end\n', base: c.base },
      { roots: c.roots, env, runAnvil, hostedWorkers: never, guidance: async (_lane, _job, run) => run }));
    assert.equal(off.timings.via, 'process');
  }
});

// ---- a small pool per token -----------------------------------------------------------------------------------------------
test('warm: overlapping calls of one customer get a second worker in a free place, bounded by SSAM_O11_WORKERS_PER_TOKEN', async t => {
  const s = server(t);
  let hold = deferred();
  const spawnFn = fakeDotnet({ handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { max: 3, perToken: 2, spawnFn });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  const first = workers.run(a, ['apply', 'hold']);
  await waitFor(() => spawnFn.launched[0].worker?.requests('apply').some(r => r.args[1] === 'hold'));
  const second = await workers.run(a, ['apply', 'second']);
  assert.equal(second.used, false);
  assert.match(second.note, /is busy with another call: this call ran cold and another worker of this customer \(2 of 2\) starts in the background/);
  assert.equal((await workers.starting('tok_a#1')).ok, true);
  assert.equal(workers.workersOf('tok_a').length, 2);
  const third = await workers.run(a, ['apply', 'third']);
  assert.equal(third.used, true, 'the second worker serves while the first is busy');
  assert.deepEqual(spawnFn.launched[1].worker.requests('apply').map(r => r.args[1]), ['third']);
  // Both busy: never a third worker for this customer, even with a place free.
  const hold2 = deferred(); const prev = hold; hold = hold2;
  const busy2 = workers.run(a, ['apply', 'hold']);
  await waitFor(() => spawnFn.launched[1].worker.requests('apply').some(r => r.args[1] === 'hold'));
  const fourth = await workers.run(a, ['apply', 'fourth']);
  assert.equal(fourth.used, false); assert.match(fourth.note, /is busy with another call; ran cold/);
  assert.equal(spawnFn.launched.length, 2);
  prev.resolve(); hold2.resolve();
  assert.deepEqual((await Promise.all([first, busy2])).map(r => r.used), [true, true]);
});

test('warm: an extra worker never takes another customer\'s place and is the first to give its own', async t => {
  const s = server(t);
  let hold = deferred();
  const spawnFn = fakeDotnet({ handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  // The minimum residency is long: only an extra worker may be retired for another customer now.
  const workers = pool(t, { max: 2, perToken: 2, minIdleMs: 3600000, spawnFn });
  const a = customer(t, s, 'a', { relay: 47701 }), b = customer(t, s, 'b', { relay: 47702 });
  await warmUp(workers, a);
  const held = workers.run(a, ['apply', 'hold']);
  await waitFor(() => spawnFn.launched[0].worker?.requests('apply').some(r => r.args[1] === 'hold'));
  assert.match((await workers.run(a, ['apply', 'x'])).note, /another worker of this customer/);
  assert.equal((await workers.starting('tok_a#1')).ok, true);
  hold.resolve(); await held;
  // B's first call: no free place; one of A's two workers (an extra: A keeps another) gives its place at once, inside
  // the residency; A keeps the other one.
  const rb = await workers.run(b, ['apply']);
  assert.equal(rb.used, false); assert.match(rb.note, /is not running: this call ran cold/);
  assert.equal((await workers.starting('tok_b')).ok, true);
  assert.deepEqual([spawnFn.launched[0].exited, spawnFn.launched[1].exited].sort(), [false, true]);
  assert.equal(spawnFn.launched[2].exited, false);
  assert.equal(workers.workersOf('tok_a').length, 1); assert.ok(workers.workerOf('tok_b'));
  const kept = spawnFn.launched.find(w => w.port === workers.workersOf('tok_a')[0].port);
  // A busy again, every place taken: A's overlap runs cold and never retires B, and A's only worker is no extra now.
  hold = deferred();
  const before = kept.worker.requests('apply').filter(r => r.args[1] === 'hold').length;
  const again = workers.run(a, ['apply', 'hold']);
  await waitFor(() => kept.worker.requests('apply').filter(r => r.args[1] === 'hold').length === before + 1);
  const overlap = await workers.run(a, ['apply', 'y']);
  assert.equal(overlap.used, false); assert.match(overlap.note, /is busy with another call; ran cold/);
  assert.equal(spawnFn.launched.length, 3); assert.equal(spawnFn.launched[2].exited, false);
  hold.resolve(); await again;
});

test('warm: an apply goes to the idle worker that last served its base (the kernel still keys every base itself)', async t => {
  const s = server(t);
  const dir = temp(t, 'ssam-warm-bases-');
  const baseA = path.join(dir, 'a.oml'), baseB = path.join(dir, 'b.oml');
  fs.writeFileSync(baseA, 'module A'); fs.writeFileSync(baseB, 'module B');
  let hold = deferred();
  const spawnFn = fakeDotnet({ handler: async request => { if (request.args.includes('hold')) await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { max: 2, perToken: 2, spawnFn });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  // Worker 0 serves base A and is held; worker 1 starts and then serves base B.
  const heldA = workers.run(a, ['apply', '--base', baseA, 'hold']);
  await waitFor(() => spawnFn.launched[0].worker?.requests('apply').some(r => r.args.includes('hold')));
  await workers.run(a, ['apply', '--base', baseB]);
  assert.equal((await workers.starting('tok_a#1')).ok, true);
  assert.equal((await workers.run(a, ['apply', '--base', baseB, 'b1'])).used, true);
  hold.resolve(); await heldA;
  // Both idle now; worker 1 was used last. Base A goes back to worker 0, base B to worker 1, in any order.
  for (const [base, index, tag] of [[baseA, 0, 'a2'], [baseB, 1, 'b2'], [baseA, 0, 'a3']]) {
    assert.equal((await workers.run(a, ['apply', '--base', base, tag])).used, true);
    assert.ok(spawnFn.launched[index].worker.requests('apply').some(r => r.args.includes(tag)), `${tag} on worker ${index}`);
  }
  // A changed module is another base: whichever idle worker takes it, the bytes decide, never the path.
  fs.writeFileSync(baseA, 'module A, changed');
  assert.equal(worker.baseAffinity(['apply', '--base', baseA]) === worker.baseAffinity(['apply', '--base', baseB]), false);
  assert.equal(worker.baseAffinity(['apply', '--base', baseA, '--base-content-sha256', 'A'.repeat(64)]), 'content:' + 'a'.repeat(64));
  assert.equal(worker.baseAffinity(['check-job', '--base', baseA]), null);
});

// ---- the Studio build is part of the worker's identity ---------------------------------------------------------------------
test('warm: a Studio replaced in the same folder (another version) retires the idle worker; the next call is a miss', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  const workers = pool(t, { spawnFn });
  const a = customer(t, s, 'a');
  await warmUp(workers, a);
  assert.equal((await workers.run(a, ['apply', 'one'])).used, true);
  // The vigia updates the Studio in place: same folder, another ServiceStudio.Framework.dll.
  fs.writeFileSync(path.join(s.studio, 'ServiceStudio.Framework.dll'), 'studio 11.55.94, another build');
  const later = new Date(Date.now() + 60000); fs.utimesSync(path.join(s.studio, 'ServiceStudio.Framework.dll'), later, later);
  const updated = { ...a, fingerprint: hostedFingerprint(a) };
  assert.notEqual(updated.fingerprint, a.fingerprint, 'the Studio build is in the fingerprint');
  const r = await workers.run(updated, ['apply', 'two']);
  assert.equal(r.used, false, 'never the worker that loaded the earlier Studio');
  await waitFor(() => spawnFn.launched[0].exited);
  assert.equal((await workers.starting('tok_a')).ok, true);
  assert.equal((await workers.run(updated, ['apply', 'three'])).used, true);
  assert.equal(spawnFn.launched.length, 2);
  assert.ok(spawnFn.launched[1].worker.requests('apply').some(r => r.args[1] === 'three'));
});

// ---- memory ------------------------------------------------------------------------------------------------------------
test('warm: memory settings come from the server environment with safe defaults; the host floor and the pool total are read on Linux only', () => {
  const d = hostedWorkerSettings({});
  assert.deepEqual([d.perToken, d.minAvailableMb, d.startMb, d.totalRssMb, d.baseCacheMb], [1, 3072, worker.HOSTED_O11_WORKER_START_MB, 2 * 1200, 0]);
  const set = hostedWorkerSettings({ SSAM_O11_WORKERS_PER_TOKEN: '2', SSAM_O11_WORKER_MIN_AVAILABLE_MB: '0', SSAM_O11_WORKER_START_MB: '900', SSAM_O11_WORKERS_RSS_TOTAL_MB: '3000' });
  assert.deepEqual([set.perToken, set.minAvailableMb, set.startMb, set.totalRssMb], [2, 0, 900, 3000]);
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKERS_PER_TOKEN: '5', SSAM_O11_WORKERS_MAX: '2' }).perToken, 2, 'never above the server cap');
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKERS_PER_TOKEN: '0' }).perToken, 1);
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKER_RSS_MB: '0' }).totalRssMb, 0, 'no per-worker bound: no derived total');
  const meminfo = 'MemTotal:       8000000 kB\nMemFree:         100000 kB\nMemAvailable:    3500000 kB\n';
  assert.equal(worker.availableMb({ platform: 'linux', readFile: () => meminfo }), 3418);
  assert.equal(worker.availableMb({ platform: 'win32', readFile: () => meminfo }), null);
  assert.equal(worker.availableMb({ platform: 'linux', readFile: () => { throw new Error('ENOENT'); } }), null);
});

test('warm: no worker starts when it would take the host below its MemAvailable floor; a worker is retired after its call below it', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  let free = 3500;
  const workers = pool(t, { spawnFn, minAvailableMb: 3072, startMb: 700, availableOf: () => free, rssOf: () => null });
  const a = customer(t, s, 'a');
  const refused = await workers.run(a, ['apply']);
  assert.equal(refused.used, false);
  assert.match(refused.note, /did not start: the host has 3500 MB available; one more worker \(700 MB\) would leave less than the 3072 MB floor; ran cold/);
  assert.equal(spawnFn.launched.length, 0); assert.equal(workers.starting('tok_a'), null);
  free = 4000;
  await warmUp(workers, a);
  assert.equal((await workers.run(a, ['apply', 'ok'])).used, true);
  free = 3000; // other backends grew meanwhile
  assert.equal((await workers.run(a, ['apply', 'last'])).used, true, 'never cut during a call');
  await waitFor(() => spawnFn.launched[0].exited);
  assert.equal(workers.workerOf('tok_a'), null);
  // Unreadable (Windows, no /proc): decides nothing.
  const blind = pool(t, { spawnFn: fakeDotnet(), minAvailableMb: 3072, availableOf: () => null, rssOf: () => null });
  await warmUp(blind, a);
});

test('warm: the resident sets of this server\'s workers stay within their total; one more never starts beyond it, and a worker that passed it goes after its call', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  const rss = new Map();
  const workers = pool(t, { max: 3, spawnFn, totalRssMb: 2000, startMb: 700, rssOf: pid => rss.get(pid) ?? null });
  const a = customer(t, s, 'a', { relay: 47801 }), b = customer(t, s, 'b', { relay: 47802 }), c = customer(t, s, 'c', { relay: 47803 });
  await warmUp(workers, a); rss.set(spawnFn.launched[0].child.pid, 650);
  await warmUp(workers, b); rss.set(spawnFn.launched[1].child.pid, 700);
  const rc = await workers.run(c, ['apply']);
  assert.equal(rc.used, false);
  assert.match(rc.note, /did not start: this server's workers use or have reserved 1400 MB; one more \(700 MB\) would pass their 2000 MB total; ran cold/);
  assert.equal(spawnFn.launched.length, 2);
  // B grows past the total during a call: retired once it is over.
  rss.set(spawnFn.launched[1].child.pid, 1400);
  assert.equal((await workers.run(b, ['apply', 'big'])).used, true);
  await waitFor(() => spawnFn.launched[1].exited);
  assert.ok(workers.workerOf('tok_a')); assert.equal(workers.workerOf('tok_b'), null);
});

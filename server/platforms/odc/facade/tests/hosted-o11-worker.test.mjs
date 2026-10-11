// The resident O11 worker of each hosted customer (anvil-worker.mjs HostedO11Workers, hostedWorkerClient): one worker per
// tokenId, started with exactly that customer's hosted spawn environment, on its own loopback port, with that customer's
// relay key as its trusted-controller key; capped, recycled when idle, restarted when the environment changes, and cold
// whenever anything is uncertain. No process is ever started: the spawn is a fake that brings up a fake TCP worker on the
// port it is given (reading the key of the environment's authority folder, as the real worker does when it starts), and
// every workspace, CLI, Studio folder and user folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HostedO11Workers, hostedWorkerClient, hostedWorkerSettings, hostedWorkerSpec, hostedFingerprint, hostedO11Workers,
  createWorkerFirstRunner, workerDisabled, workerRequest, HOSTED_O11_WORKERS_MAX, HOSTED_O11_WORKER_IDLE_MS } from '../anvil-worker.mjs';
import { runWithExecutor, prepareWorkspace, hostedSpawnEnv, createHostedContext, onHostedContextClose } from '../executor.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { runJob } from '../job-runner.mjs';
import { fakeWorker } from './fixtures/jobs-fake-worker.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const QUICK = { waitMs: 3000, pingMs: 1000, stopMs: 150, idleMs: 60000 };
const selfExit = idleMs => String(Math.ceil((idleMs + 5 * 60 * 1000) / 60000));
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitFor(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('condition not met within ' + ms + ' ms'); await new Promise(r => setTimeout(r, 20)); }
}
const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
// A clock that never repeats a value, so the least recently used worker is always one.
const monotonic = () => { let n = 0; return () => Date.now() + n++; };

// The server's side: a built CLI and the kernel's Studio installation.
function server(t) {
  const dir = temp(t, 'ssam-hw-server-');
  const cli = path.join(dir, 'cli', 'anvil.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const studio = path.join(dir, 'Service Studio'); fs.mkdirSync(studio); fs.writeFileSync(path.join(studio, 'ServiceStudio.Framework.dll'), '');
  return { dir, cli, studio };
}
// One customer's spec, as hostedWorkerSpec computes it: the hosted spawn environment of its workspace and its relay key.
function customer(t, s, name, { relay = 47000, cli = s.cli, studio = s.studio } = {}) {
  const workspace = temp(t, 'ssam-hw-' + name + '-');
  const authority = path.join(workspace, 'state', 'relay-authority'); fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'bridge.key'), 'KEY-' + name);
  const cwd = path.join(workspace, 'o11'); const tmp = path.join(cwd, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ANVIL_AUTHORITY_DIR: authority, ANVIL_BRIDGE_PORT: String(relay),
    ANVIL_STUDIO_DIR: studio, ANVIL_LANE: 'ss4', ANVIL_BRIDGE_FLAVOR: 'thin', ANVIL_BRIDGE_TIMEOUT_SECONDS: '600' };
  return respec({ tokenId: 'tok_' + name, contextId: 'ctx-' + name, env, cwd, cli, key: 'KEY-' + name, studioDir: studio, local: path.join(tmp, 'o11-worker') });
}
// The same customer with another environment or key (a new hosted context), its fingerprint computed again.
function respec(spec, envChanges = {}, key = spec.key) {
  const env = { ...spec.env, ...envChanges };
  return { ...spec, env, key, fingerprint: hostedFingerprint({ env, cwd: spec.cwd, cli: spec.cli, key }) };
}

// A spawn that starts no process: the child is an emitter whose pid the fake worker reports (unless pid is given), and the
// fake worker comes up on the --port it was given after startMs, with the key of the environment's authority folder.
// exit: the child exits during startup with that code; never: nothing comes up and nothing exits; ignoreShutdown(env):
// that worker never answers its shutdown (only kill ends it); handler(request, record): the envelope of a command.
function fakeDotnet({ startMs = 30, exit = null, never = false, pid = null, studio = null, ignoreShutdown = () => false, handler = null } = {}) {
  const launched = []; let live = 0; let peak = 0;
  const fn = (file, args, options) => {
    const port = Number(args[args.indexOf('--port') + 1]);
    const child = new EventEmitter();
    child.pid = 61000 + launched.length;
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
      if (never) return;
      if (exit !== null) { await exitWith(exit); return; }
      record.key = fs.readFileSync(path.join(options.env.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'ascii').trim();
      record.worker = await fakeWorker({ port, key: record.key,
        status: { pid: pid ?? child.pid, instanceId: 'instance-' + launched.indexOf(record), studio: studio ?? options.env.ANVIL_STUDIO_DIR },
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

test('settings: SSAM_O11_WORKERS_MAX (default 2, 0 is off), SSAM_O11_WORKER_IDLE_MS (default 10 min), ANVIL_WORKER=0 is off', () => {
  assert.equal(HOSTED_O11_WORKERS_MAX, 2); assert.equal(HOSTED_O11_WORKER_IDLE_MS, 600000);
  assert.deepEqual(hostedWorkerSettings({}), { max: 2, idleMs: 600000, disabled: false });
  assert.deepEqual(hostedWorkerSettings({ SSAM_O11_WORKERS_MAX: '3', SSAM_O11_WORKER_IDLE_MS: '120000' }), { max: 3, idleMs: 120000, disabled: false });
  assert.equal(hostedWorkerSettings({ SSAM_O11_WORKERS_MAX: '0' }).disabled, true);
  assert.equal(hostedWorkerSettings({ ANVIL_WORKER: '0' }).disabled, true);
  assert.deepEqual(hostedWorkerSettings({ SSAM_O11_WORKERS_MAX: '-1', SSAM_O11_WORKER_IDLE_MS: 'soon' }), { max: 2, idleMs: 600000, disabled: false });
  // The process's own pool: one, with the settings of this process.
  assert.equal(hostedO11Workers(), hostedO11Workers()); assert.equal(hostedO11Workers().max, 2);
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

test('two customers get two workers, each with its own environment, folder, port and key; B never reaches A\'s worker', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  const workers = pool(t, { spawnFn });
  const a = customer(t, s, 'a', { relay: 47101 }); const b = customer(t, s, 'b', { relay: 47102 });
  const ra = await workers.run(a, ['apply', '--job', 'a1.json']);
  const rb = await workers.run(b, ['apply', '--job', 'b1.json']);
  assert.deepEqual([ra.used, ra.envelope.data.bridgePort, rb.used, rb.envelope.data.bridgePort], [true, '47101', true, '47102']);
  assert.equal(spawnFn.launched.length, 2);
  const [wa, wb] = spawnFn.launched;
  // Exactly the customer's spawn environment and folder; the only addition is the worker's own idle exit.
  assert.deepEqual(wa.options.env, { ...a.env, ANVIL_WORKER_IDLE_MINUTES: selfExit(QUICK.idleMs) });
  assert.deepEqual(wb.options.env, { ...b.env, ANVIL_WORKER_IDLE_MINUTES: selfExit(QUICK.idleMs) });
  assert.equal(wa.options.cwd, a.cwd); assert.equal(wb.options.cwd, b.cwd);
  assert.equal(wa.file, 'dotnet'); assert.deepEqual(wa.args, [s.cli, 'serve', '--port', String(wa.port), '--log-dir', a.local]);
  assert.equal(wa.options.detached, undefined, 'the worker belongs to this process'); assert.equal(wa.options.windowsHide, true); assert.equal(wa.unrefd, true);
  assert.ok(fs.existsSync(path.join(a.local, `worker-${wa.port}-startup.log`)), 'its logs stay in the customer\'s workspace');
  assert.notEqual(wa.port, wb.port);
  assert.deepEqual([wa.key, wb.key], ['KEY-a', 'KEY-b'], 'each worker took its own customer\'s relay key as its controller key');
  // Each worker is reused by its own customer only, and every request carries that customer's key.
  await workers.run(a, ['apply', '--job', 'a2.json']); await workers.run(b, ['apply', '--job', 'b2.json']);
  assert.equal(spawnFn.launched.length, 2);
  assert.deepEqual(wa.worker.requests('apply').map(r => r.args[2]), ['a1.json', 'a2.json']);
  assert.deepEqual(wb.worker.requests('apply').map(r => r.args[2]), ['b1.json', 'b2.json']);
  assert.ok(wa.worker.requests('apply').every(r => r.authorization === 'KEY-a'));
  assert.ok(wb.worker.requests('apply').every(r => r.authorization === 'KEY-b'));
  // Even sent straight to A's port, a request with B's key runs nothing there.
  const crossed = await workerRequest({ port: wa.port, authorization: b.key, timeoutMs: 2000 }, ['apply', '--job', 'b3.json']);
  assert.deepEqual([crossed.reply.ok, crossed.reply.executed], [false, false]);
  assert.equal(wa.worker.requests('apply').filter(r => r.authorization === 'KEY-a').length, 2);
  assert.deepEqual([workers.workerOf('tok_a').port, workers.workerOf('tok_b').port], [wa.port, wb.port]);
});

test('the cap: a new customer takes the place of the least recently used idle worker, gone before it starts; all busy runs cold', async t => {
  const s = server(t);
  let hold = deferred();
  // B ignores its shutdown: it keeps its place until it is terminated.
  const spawnFn = fakeDotnet({ ignoreShutdown: env => env.ANVIL_BRIDGE_PORT === '47202',
    handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { max: 2, spawnFn, now: monotonic() });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name, i) => customer(t, s, name, { relay: 47201 + i }));
  await workers.run(a, ['apply']); await workers.run(b, ['apply']); await workers.run(a, ['apply']);
  const [wa, wb] = spawnFn.launched;
  const rc = await workers.run(c, ['apply']);
  assert.equal(rc.used, true, JSON.stringify(rc));
  assert.equal(spawnFn.launched.length, 3);
  assert.equal(wb.worker.requests('shutdown').length, 1); assert.equal(wb.worker.requests('shutdown')[0].authorization, 'KEY-b');
  assert.deepEqual(wb.killed, ['SIGTERM'], 'B did not exit after its shutdown: terminated');
  assert.deepEqual([wb.exited, wa.exited], [true, false], 'B, the least recently used, made room; A stays');
  assert.deepEqual([...workers.entries.keys()].sort(), ['tok_a', 'tok_c']);
  assert.equal(spawnFn.peak(), 2, 'never more processes than the cap, a stopping one included');
  // Every worker busy: a fourth customer runs cold; nothing is stopped or started.
  hold = deferred();
  const wc = spawnFn.launched[2];
  const busy = [workers.run(a, ['apply', 'hold']), workers.run(c, ['apply', 'hold'])];
  await waitFor(() => wa.worker.requests('apply').some(r => r.args[1] === 'hold') && wc.worker.requests('apply').some(r => r.args[1] === 'hold'));
  const rd = await workers.run(d, ['apply']);
  assert.equal(rd.used, false); assert.match(rd.note, /the 2 hosted O11 worker\(s\) of this server are busy; ran cold/);
  assert.equal(spawnFn.launched.length, 3); assert.deepEqual([wa.exited, wc.exited], [false, false]);
  hold.resolve();
  assert.deepEqual((await Promise.all(busy)).map(r => r.used), [true, true]);
});

test('idle: a worker without a call for the idle time is stopped; the next call starts a new one', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  const workers = pool(t, { spawnFn, idleMs: 150 });
  const a = customer(t, s, 'a');
  assert.equal((await workers.run(a, ['apply'])).used, true);
  const [first] = spawnFn.launched;
  assert.equal(first.options.env.ANVIL_WORKER_IDLE_MINUTES, selfExit(150), 'it would exit by itself 5 min after the idle time');
  await waitFor(() => first.exited);
  assert.equal(first.worker.requests('shutdown').length, 1); assert.deepEqual(first.killed, []);
  assert.equal(workers.workerOf('tok_a'), null); assert.equal(workers.size, 0);
  assert.equal((await workers.run(a, ['apply'])).used, true);
  assert.equal(spawnFn.launched.length, 2);
});

test('a new environment of the same customer (relay port, relay key) restarts its idle worker; a busy one stays and the call runs cold', async t => {
  const s = server(t);
  let hold = null;
  const spawnFn = fakeDotnet({ handler: async (request, record) => {
    if (request.args[1] === 'hold') await hold.promise;
    return { ok: true, command: request.args[0], data: { bridgePort: record.options.env.ANVIL_BRIDGE_PORT, key: record.key } };
  } });
  const workers = pool(t, { spawnFn });
  const a1 = customer(t, s, 'a', { relay: 47301 });
  assert.equal((await workers.run(a1, ['apply'])).envelope.data.bridgePort, '47301');
  // A new hosted context: another relay port.
  const a2 = respec(a1, { ANVIL_BRIDGE_PORT: '47302' });
  const r2 = await workers.run(a2, ['apply']);
  assert.equal(r2.envelope.data.bridgePort, '47302');
  const [first, second] = spawnFn.launched;
  assert.equal(first.exited, true); assert.equal(first.worker.requests('shutdown').length, 1);
  assert.equal(second.options.env.ANVIL_BRIDGE_PORT, '47302');
  // ... and a new relay key in the same folder.
  fs.writeFileSync(path.join(a1.env.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'KEY-a-2');
  const a3 = respec(a2, {}, 'KEY-a-2');
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

test('cold, with the reason: busy, still starting, an exit during startup, a deadline, another pid or Studio, CLI or Studio missing, a spawn error', async t => {
  const s = server(t);
  // Busy with another call of the same customer, then still starting for another call.
  let hold = deferred();
  const holding = fakeDotnet({ startMs: 300, handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const workers = pool(t, { spawnFn: holding });
  const a = customer(t, s, 'a');
  const starting = workers.run(a, ['apply']);
  const early = await workers.run(a, ['apply']);
  assert.equal(early.used, false); assert.match(early.note, /is starting for another call; ran cold/);
  assert.equal((await starting).used, true);
  const running = workers.run(a, ['apply', 'hold']);
  await waitFor(() => holding.launched[0].worker.requests('apply').some(r => r.args[1] === 'hold'));
  const busy = await workers.run(a, ['apply']);
  assert.equal(busy.used, false); assert.match(busy.note, /is busy with another call; ran cold/);
  hold.resolve(); await running;
  assert.equal(holding.launched.length, 1);

  const cases = [
    [{ exit: 1 }, {}, /exited during startup \(exit 1\); see .*worker-\d+-startup\.log; ran cold/],
    [{ never: true }, { waitMs: 400 }, /did not start within 0 s; ran cold/],
    [{ pid: 999 }, {}, /is answered on its port by pid 999, not 6100\d; ran cold/],
    [{ studio: path.join(s.dir, 'Other Studio') }, {}, /serves .*Other Studio, not .*; ran cold/],
  ];
  for (const [fake, options, note] of cases) {
    const spawnFn = fakeDotnet(fake);
    const each = pool(t, { spawnFn, ...options });
    const r = await each.run(customer(t, s, 'x'), ['apply']);
    assert.equal(r.used, false, JSON.stringify(fake)); assert.match(r.note, note);
    assert.equal(each.workerOf('tok_x'), null);
    // A worker that did not start as this customer's is stopped (terminated when it does not answer its shutdown).
    await waitFor(() => spawnFn.launched[0].exited);
    assert.equal(each.size, 0);
  }
  const none = fakeDotnet();
  const missing = pool(t, { spawnFn: none });
  assert.match((await missing.run(customer(t, s, 'y', { cli: path.join(s.dir, 'none', 'anvil.dll') }), ['apply'])).note, /CLI is not built/);
  assert.match((await missing.run(customer(t, s, 'z', { studio: path.join(s.dir, 'empty') }), ['apply'])).note, /ServiceStudio\.Framework\.dll; ran cold/);
  assert.equal(none.launched.length, 0); assert.equal(missing.size, 0);
  const refused = pool(t, { spawnFn: () => { throw new Error('spawn EPERM'); } });
  assert.match((await refused.run(customer(t, s, 'w'), ['apply'])).note, /could not be started \(spawn EPERM\); ran cold/);
  assert.equal(refused.size, 0);
});

test('a worker that died, or recycles, serves no more: cold before anything is written, and the next call starts a new one', async t => {
  const s = server(t);
  let recycle = false;
  const spawnFn = fakeDotnet({ handler: request => (recycle
    ? { ok: false, command: request.args[0], error: 'worker recycling; request was not executed', retryable: true, executed: false }
    : { ok: true, command: request.args[0], data: {} }) });
  const workers = pool(t, { spawnFn, pingMs: 300 });
  const a = customer(t, s, 'a');
  await workers.run(a, ['apply']);
  // Its port closed without an exit event (a crash the ping sees first): nothing is written, the call runs cold.
  await spawnFn.launched[0].worker.close();
  const dead = await workers.run(a, ['deliver']);
  assert.equal(dead.used, false); assert.match(dead.note, /does not answer its ping; ran cold/);
  assert.equal(spawnFn.launched[0].worker.requests('deliver').length, 0);
  await waitFor(() => spawnFn.launched[0].exited);
  assert.equal((await workers.run(a, ['apply'])).used, true);
  recycle = true;
  const recycled = await workers.run(a, ['apply']);
  assert.equal(recycled.used, false); assert.match(recycled.note, /was recycling before executing the request; ran cold/);
  assert.equal(workers.workerOf('tok_a'), null);
});

test('a request written with no reply is an unknown outcome: sent once, never replayed, and its worker retired', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet({ handler: request => (request.args[1] === 'drop' ? 'drop' : request.args[1] === 'silent' ? undefined
    : { ok: true, command: request.args[0], data: {} }) });
  const workers = pool(t, { spawnFn });
  const a = customer(t, s, 'a');
  await workers.run(a, ['apply']);
  const [first] = spawnFn.launched;
  const lost = await workers.run(a, ['deliver', 'drop']);
  assert.deepEqual([lost.used, lost.unknown, lost.code], [true, true, 'WORKER_OUTCOME_UNKNOWN']);
  assert.match(lost.error, /outcome is unknown, command was not replayed/);
  assert.equal(first.worker.requests('deliver').length, 1, 'sent once');
  assert.equal(workers.workerOf('tok_a'), null, 'retired');
  await waitFor(() => first.exited);
  // A timeout after the write is unknown too.
  const late = await workers.run(a, ['deliver', 'silent'], { timeoutMs: 300 });
  assert.deepEqual([late.used, late.unknown, late.code], [true, true, 'WORKER_OUTCOME_UNKNOWN']);
  const second = spawnFn.launched[1];
  assert.equal(second.worker.requests('deliver').length, 1);
  await waitFor(() => second.exited);
  // The next call runs on a new worker and nothing of the earlier requests is sent again.
  assert.equal((await workers.run(a, ['apply', 'next'])).used, true);
  assert.equal(spawnFn.launched.length, 3);
  assert.deepEqual(spawnFn.launched[2].worker.seen.filter(r => r.args[0] !== 'ping').map(r => r.args), [['apply', 'next']]);
});

test('a closed hosted context stops its customer\'s worker, now or after the call it runs', async t => {
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
  await workers.run(a, ['apply']);
  workers.contextClosed('tok_a', 'another-context');
  assert.ok(workers.workerOf('tok_a'), 'another context of the token is not this worker\'s');
  workers.contextClosed('tok_a', a.contextId);
  await waitFor(() => spawnFn.launched[0].exited);
  assert.equal(workers.workerOf('tok_a'), null);
  // Busy: stopped once its call is over.
  await workers.run(a, ['apply']);
  const running = workers.run(a, ['apply', 'hold']);
  await waitFor(() => spawnFn.launched[1].worker?.requests('apply').some(r => r.args[1] === 'hold'));
  workers.contextClosed('tok_a', a.contextId);
  assert.equal(spawnFn.launched[1].exited, false);
  hold.resolve();
  assert.equal((await running).used, true);
  await waitFor(() => spawnFn.launched[1].exited);
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
  // Unknown outcome: reported as timedOut, never run cold.
  const lost = createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: recordingPool(() => ({ used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', error: 'worker connection failed after submission' })) });
  const unknown = await runWithExecutor(a, () => lost(['deliver', '--module', 'M']));
  assert.deepEqual([unknown.ok, unknown.timedOut, unknown.unknown, unknown.via], [false, true, true, 'worker']);
  assert.equal(cold.calls.length, 0);
  // Nothing ran there (cap, busy, start failure): the same command runs cold, with the reason.
  const full = createWorkerFirstRunner({ cold, env: {} }, { hostedWorkers: recordingPool(() => ({ used: false, note: 'the 2 hosted O11 worker(s) of this server are busy; ran cold' })) });
  const capped = await runWithExecutor(a, () => full(['deliver', '--module', 'M']));
  assert.equal(capped.ok, true); assert.deepEqual(capped.envelope.data, { cold: true }); assert.match(capped.workerNote, /are busy; ran cold/);
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

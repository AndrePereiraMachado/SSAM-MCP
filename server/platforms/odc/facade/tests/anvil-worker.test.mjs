// The resident worker client without Python (anvil-worker.mjs, the port of anvil_cli.py, odc_worker.py and
// worker_process.py), against fake TCP workers on ephemeral loopback ports. No process is ever started: the spawn is
// injected, every root, authority folder and user folder is temporary, and every target names its fake's port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { workerTarget, workerDisabled, workerRequest, ping, ensureWorker, runOnWorker, withStartupLock, staleKernel, studioMatches } from '../anvil-worker.mjs';
import { fakeWorker, freePort } from './fixtures/jobs-fake-worker.mjs';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'KEY\n');
  const studio = path.join(root, 'Service Studio'); fs.mkdirSync(studio);
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: auth };
  // An O11 target on the fake's port, with a selected installation; waitMs is short so a failure cannot hang a test.
  const o11 = (port, extra = {}) => ({ ...workerTarget('o11', { root, env: { ...env, ANVIL_WORKER_PORT: String(port), ANVIL_STUDIO_DIR: studio }, o11: 'ss4', pingMs: 1000 }), waitMs: 4000, ...extra });
  const odc = (port, extra = {}) => ({ ...workerTarget('odc', { root, env: { ...env, ANVIL_ODC_PORT: String(port) }, pingMs: 1000 }), waitMs: 4000, ...extra });
  const cli = target => { fs.mkdirSync(path.dirname(target.cli), { recursive: true }); fs.writeFileSync(target.cli, ''); return target.cli; };
  return { root, auth, studio, env, o11, odc, cli };
}
// A spawn that starts nothing: it records the call and returns a child-like emitter; `then` runs after a delay.
function fakeSpawn({ then = null, delayMs = 200, exitCode = null } = {}) {
  const calls = [];
  const fn = (file, args, options) => {
    const child = new EventEmitter(); child.unref = () => { child.unrefd = true; };
    calls.push({ file, args, options, child });
    setTimeout(async () => { if (then) await then(); if (exitCode !== null) child.emit('exit', exitCode); }, delayMs);
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('the lane table: ports from the environment or the workspace, the CLI and folder of each lane, the off switches', t => {
  const s = sandbox(t);
  const o11 = workerTarget('o11', { root: s.root, env: s.env, o11: 'ss5' });
  assert.equal(o11.local, path.join(s.root, '.local', 'lane-ss5')); assert.match(o11.cli, /anvil\.dll$/);
  assert.ok(Number.isInteger(o11.port)); assert.equal(o11.timeoutMs, 900000); assert.equal(o11.waitMs, 25000);
  assert.equal(workerTarget('o11', { root: s.root, env: { ...s.env, ANVIL_WORKER_PORT: '45999' }, o11: 'ss4' }).port, 45999);
  const odc = workerTarget('odc', { root: s.root, env: { ...s.env, ANVIL_ODC_PORT: '45998' } });
  assert.deepEqual([odc.port, odc.local, odc.cli, odc.waitMs], [45998, path.join(s.root, '.local', 'lane-odc'), path.join(s.root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'), 90000]);
  assert.equal(odc.key(), 'KEY');
  assert.equal(workerDisabled('o11', { ANVIL_WORKER: '0' }), true); assert.equal(workerDisabled('odc', { ANVIL_WORKER: '0' }), true);
  assert.equal(workerDisabled('odc', { ANVIL_ODC_NO_WORKER: '1' }), true); assert.equal(workerDisabled('o11', { ANVIL_ODC_NO_WORKER: '1' }), false);
  assert.equal(workerDisabled('o11', {}), false);
  assert.throws(() => workerTarget('ss4'), /Unknown job lane/);
});

test('ping carries no key; a request carries the controller key and returns the envelope; a refused key is not retried', async t => {
  const s = sandbox(t);
  const fake = await fakeWorker({ key: 'KEY', status: { studio: s.studio } });
  t.after(() => fake.close());
  const target = s.o11(fake.port);
  assert.equal((await ping(target)).instanceId, 'fake-instance');
  const done = await runOnWorker(['apply', '--job', 'j.json'], target);
  assert.deepEqual([done.used, done.envelope.ok, done.envelope.command], [true, true, 'apply']);
  assert.equal(Object.hasOwn(fake.requests('ping')[0], 'authorization'), false);
  assert.deepEqual(fake.requests('apply')[0], { args: ['apply', '--job', 'j.json'], authorization: 'KEY' });
  // Another controller's key: the worker says executed:false and nothing ran; it comes back as the answer, sent once.
  fake.state.studio = s.studio;
  fs.writeFileSync(path.join(s.auth, 'bridge.key'), 'OTHER');
  const refused = await runOnWorker(['apply'], target);
  assert.deepEqual([refused.used, refused.envelope.ok, refused.envelope.executed], [true, false, false]);
  assert.match(refused.envelope.error, /trusted Hybrid controller/);
  assert.equal(fake.requests('apply').length, 2);
});

test('retryable (recycling, not executed): ensure again and retry; a connection lost after sending is never replayed', async t => {
  const s = sandbox(t);
  let applies = 0; let mode = 'recycle-once';
  const fake = await fakeWorker({ key: 'KEY', status: { studio: s.studio }, handler: request => {
    applies++;
    if (mode === 'drop') return 'drop';
    if (mode === 'recycle-once' && applies === 1) return { ok: false, command: request.args[0], error: 'worker recycling; request was not executed', retryable: true, executed: false };
    if (mode === 'recycle-always') return { ok: false, command: request.args[0], error: 'worker recycling; request was not executed', retryable: true, executed: false };
    return { ok: true, command: request.args[0], elapsedMs: 1, data: { n: applies } };
  } });
  t.after(() => fake.close());
  const target = s.o11(fake.port);
  const retried = await runOnWorker(['apply'], target);
  assert.deepEqual([retried.used, retried.envelope.data.n, fake.requests('apply').length, fake.requests('ping').length], [true, 2, 2, 2]);
  mode = 'recycle-always';
  const recycling = await runOnWorker(['apply'], target);
  assert.deepEqual([recycling.used, recycling.note], [false, 'the worker kept recycling before executing the request']);
  mode = 'drop'; const before = fake.requests('apply').length;
  const lost = await runOnWorker(['deliver'], target);
  assert.deepEqual([lost.used, lost.unknown, lost.code], [true, true, 'WORKER_OUTCOME_UNKNOWN']);
  assert.match(lost.error, /outcome is unknown, command was not replayed/);
  assert.equal(fake.requests('apply').length + fake.requests('deliver').length - before, 1, 'one request, never repeated');
});

test('a busy worker of another Studio installation is neither used nor stopped: the caller runs cold', async t => {
  const s = sandbox(t);
  // Busy: it serves another session's request; it is left running (C35 recycles only an idle one, pacote-laneC-worker).
  const fake = await fakeWorker({ key: 'KEY', status: { studio: path.join(s.root, 'clone', 'Service Studio'), busy: true } });
  t.after(() => fake.close());
  const spawnFn = fakeSpawn();
  const never = () => { throw new Error('no process is inspected or terminated for a busy worker'); };
  const r = await runOnWorker(['apply'], s.o11(fake.port), { spawnFn, identity: never, kill: never });
  assert.equal(r.used, false); assert.match(r.note, /serves .*clone.*busy.*; ran cold/);
  assert.deepEqual(fake.seen.map(x => x.args[0]), ['ping']); assert.equal(spawnFn.calls.length, 0);
  assert.equal(studioMatches({ studio: s.studio.toUpperCase() }, s.studio), process.platform === 'win32');
  assert.equal(studioMatches({}, null), true); assert.equal(studioMatches({}, s.studio), false);
  // Off switches: nothing is asked at all.
  const off = await runOnWorker(['apply'], { ...s.o11(fake.port), disabled: true });
  assert.equal(off.used, false); assert.equal(fake.seen.length, 1);
});

test('start: the startup lock, a detached `dotnet <cli> serve --port --log-dir`, then the ping answers (no fixed sleep)', async t => {
  const s = sandbox(t);
  const port = await freePort();
  const target = s.odc(port);
  let fake = null;
  t.after(() => fake?.close());
  const spawnFn = fakeSpawn({ delayMs: 300, then: async () => { fake = await fakeWorker({ port, key: 'KEY', status: { instanceId: 'started', pid: 777 } }); } });
  // No CLI built: nothing is launched.
  assert.match((await ensureWorker(target, { spawnFn })).note, /CLI is not built/);
  assert.equal(spawnFn.calls.length, 0);
  s.cli(target);
  const started = Date.now();
  const r = await ensureWorker(target, { spawnFn });
  assert.equal(r.status.instanceId, 'started'); assert.equal(r.started, true);
  assert.ok(Date.now() - started < 3500, 'answered as soon as the ping did');
  const call = spawnFn.calls[0];
  assert.equal(call.file, 'dotnet');
  assert.deepEqual(call.args, [target.cli, 'serve', '--port', String(port), '--log-dir', target.local]);
  assert.equal(call.options.detached, true); assert.equal(call.options.windowsHide, true); assert.equal(call.options.cwd, s.root);
  assert.equal(call.child.unrefd, true);
  assert.equal(fs.existsSync(path.join(target.local, `worker-${port}.lock`)), false, 'the lock is released');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target.local, `worker-${port}.node.json`), 'utf8')).instanceId, 'started');
  assert.ok(fs.existsSync(path.join(target.local, `worker-${port}-startup.log`)));
  // Up already: reused, nothing launched again.
  assert.equal((await ensureWorker(target, { spawnFn })).status.instanceId, 'started');
  assert.equal(spawnFn.calls.length, 1);
});

test('a child that exits during startup ends the wait at once; an O11 Studio without its framework never launches', async t => {
  const s = sandbox(t);
  const port = await freePort();
  const target = { ...s.odc(port), waitMs: 20000 };
  s.cli(target);
  const spawnFn = fakeSpawn({ delayMs: 100, exitCode: 1 });
  const started = Date.now();
  const r = await ensureWorker(target, { spawnFn });
  assert.equal(r.status, null); assert.match(r.note, /worker startup failed \(exit 1\); see .*worker-\d+-startup\.log/);
  assert.ok(Date.now() - started < 5000, 'the exit event ends the wait, not the 20 s deadline');
  const o11 = s.o11(port); s.cli(o11);
  const none = fakeSpawn();
  assert.match((await ensureWorker(o11, { spawnFn: none })).note, /ServiceStudio\.Framework\.dll/);
  fs.writeFileSync(path.join(s.studio, 'ServiceStudio.Framework.dll'), '');
  const timeout = await ensureWorker({ ...o11, waitMs: 800 }, { spawnFn: none });
  assert.match(timeout.note, /did not start within/); assert.equal(none.calls.length, 1);
});

test('the startup lock: a dead owner is removed; a live owner is waited for until the deadline; never a foreign lock removed', async t => {
  const s = sandbox(t);
  const local = path.join(s.root, '.local', 'lane-odc');
  fs.mkdirSync(local, { recursive: true });
  const lock = path.join(local, 'worker-1234.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 987654321, birth: 'dead', created: Date.now() / 1000 }));
  const taken = await withStartupLock(local, 1234, 1000, async () => fs.existsSync(lock));
  assert.deepEqual(taken, { locked: true, value: true }); assert.equal(fs.existsSync(lock), false);
  const live = { pid: process.pid, birth: '1', created: Date.now() / 1000 };
  fs.writeFileSync(lock, JSON.stringify(live));
  const started = Date.now();
  const busy = await withStartupLock(local, 1234, 700, async () => 'never');
  assert.equal(busy.locked, false); assert.match(busy.note, /startup lock did not clear/);
  assert.ok(Date.now() - started >= 650);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), live, 'the live owner keeps its lock');
});

test('a worker that loaded an older kernel: busy serves with a warning, idle is shut down and restarted', async t => {
  const s = sandbox(t);
  const port = await freePort();
  const target = s.odc(port); s.cli(target);
  fs.mkdirSync(target.local, { recursive: true });
  fs.writeFileSync(path.join(target.local, `worker-${port}.node.json`), JSON.stringify({ pid: 4242, instanceId: 'old', startedUnix: 1000 }));
  let fresh = null;
  const old = await fakeWorker({ port, key: 'KEY', status: { instanceId: 'old', busy: true }, handler: request => {
    if (request.args[0] === 'shutdown') { setImmediate(() => old.close()); return { ok: true, command: 'shutdown', data: { stopped: true } }; }
    return { ok: true, command: request.args[0], data: {} };
  } });
  t.after(async () => { await old.close(); await fresh?.close(); });
  assert.equal(staleKernel(target, { pid: 4242, instanceId: 'old' }), true);
  assert.equal(staleKernel(target, { pid: 4242, instanceId: 'other' }), false, 'a record of another instance proves nothing');
  const busy = await ensureWorker(target);
  assert.equal(busy.status.instanceId, 'old'); assert.match(busy.warning, /older than anvil-odc\.dll and is busy/);
  old.state.busy = false;
  const spawnFn = fakeSpawn({ delayMs: 200, then: async () => { fresh = await fakeWorker({ port, key: 'KEY', status: { instanceId: 'new' } }); } });
  // The fake's pid names no process: identity and liveness are fakes too (stopWorker never looks at a real process here).
  const restarted = await ensureWorker(target, { spawnFn, identity: async () => ({ birth: '1', name: 'dotnet' }), alive: () => false, kill: () => { throw new Error('never terminated'); } });
  assert.equal(restarted.status.instanceId, 'new'); assert.equal(old.requests('shutdown').length, 1);
  assert.equal(old.requests('shutdown')[0].authorization, 'KEY');
});

test('a port that accepts connections but never answers the ping is left alone: nothing launched, cold', async t => {
  const s = sandbox(t);
  const sockets = new Set();
  const mute = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(resolve => mute.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const x of sockets) x.destroy(); mute.close(resolve); }));
  const target = { ...s.odc(mute.address().port), pingMs: 300 }; s.cli(target);
  const spawnFn = fakeSpawn();
  const r = await ensureWorker(target, { spawnFn });
  assert.equal(r.status, null); assert.match(r.note, /accepts connections but does not answer the worker ping; nothing was stopped/);
  assert.equal(spawnFn.calls.length, 0);
});

test('transport: refused before sending is marked so; a foreign reply and a timeout after sending are unknown outcomes', async t => {
  const port = await freePort();
  const refused = await workerRequest({ port, timeoutMs: 5000 }, ['apply']);
  assert.equal(refused.sent, false);
  assert.ok(refused.refused === true || refused.code === 'WORKER_TIMEOUT', JSON.stringify(refused));
  const foreign = await fakeWorker({ handler: () => undefined });
  t.after(() => foreign.close());
  const silent = await workerRequest({ port: foreign.port, timeoutMs: 200 }, ['apply']);
  assert.deepEqual([silent.sent, silent.code, silent.reply], [true, 'WORKER_TIMEOUT', undefined]);
});

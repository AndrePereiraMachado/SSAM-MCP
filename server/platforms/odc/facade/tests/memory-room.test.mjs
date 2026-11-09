// Memory admission by the container's cgroup limit (capacity review R2 M2, 2026-11-09): the room of a server is the smaller
// of the host's MemAvailable and the container's memory.max - (memory.current - inactive_file); the gate admits a kernel
// process only with the reserve it needs, the build pool keeps a build queued for memory, a cold process attaches to the
// slot's hold, and the customers' workers do not start into a container that cannot hold one more kernel process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { containerRoomMb, hostAvailableMb, roomMb, createMemoryGate, memorySettings, processRssMb } from '../memory-room.mjs';
import { createBuildPool, BuildQueueRefused } from '../build-pool.mjs';
import { createAnvilRunner } from '../anvil-cli.mjs';
import { HostedO11Workers } from '../anvil-worker.mjs';
import { slotExec } from '../odc-build-phase.mjs';

const MB = 1024 * 1024;
const files = map => (file => { if (!(file in map)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return map[file]; });
const cg = (max, current, inactive = 0) => ({ '/sys/fs/cgroup/memory.max': max, '/sys/fs/cgroup/memory.current': String(current), '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${inactive}\nactive_file 5\n`,
  '/proc/meminfo': 'MemTotal: 32859000 kB\nMemAvailable:   26000000 kB\n' });
const settle = () => new Promise(r => setTimeout(r, 30));

test('the room is the container\'s free memory under its limit (page cache credited), else the host\'s; unreadable decides nothing', () => {
  // 4g other tier: 3.0 GiB used of which 0.5 GiB inactive page cache -> 1.5 GiB free.
  const four = files(cg(String(4096 * MB), 3072 * MB, 512 * MB));
  assert.equal(containerRoomMb({ platform: 'linux', readFile: four }), 1536);
  assert.equal(hostAvailableMb({ platform: 'linux', readFile: four }), 25391);
  assert.equal(roomMb({ platform: 'linux', readFile: four }), 1536, 'the container, not the host\'s 25 GB');
  assert.equal(containerRoomMb({ platform: 'linux', readFile: files(cg('max', 3072 * MB)) }), null, 'no limit');
  assert.equal(roomMb({ platform: 'linux', readFile: files(cg('max', 3072 * MB)) }), 25391, 'no limit: the host');
  assert.equal(roomMb({ platform: 'win32', readFile: four }), null);
  assert.equal(roomMb({ platform: 'linux', readFile: files({}) }), null);
  assert.equal(processRssMb(42, { platform: 'linux', readFile: files({ '/proc/42/status': 'Name: dotnet\nVmRSS:   1048576 kB\n' }) }), 1024);
  assert.deepEqual(memorySettings({}), { reserveMb: 1400, odcReserveMb: 600, waitMs: 120000, growMs: 15000 });
  assert.deepEqual(memorySettings({ SSAM_MEMORY_RESERVE_MB: '0', SSAM_MEMORY_WAIT_MS: 'x' }).reserveMb, 0);
});

test('the gate: the only process always starts; the next waits for its reserve; an attached pid counts only what it has not shown', async () => {
  let room = 2000; const rss = new Map(); let clock = 1000;
  const gate = createMemoryGate({ room: () => room, rssOf: pid => rss.get(pid) ?? null, now: () => clock, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 400, growMs: 15000 } });
  const first = await gate.admit(1400);
  assert.equal(first.timedOut, false); assert.equal(first.waitedMs, 0, 'nothing else admitted: no wait even below the reserve');
  first.hold.attach(4242); rss.set(4242, 200);
  assert.equal(gate.pendingMb(), 1200); assert.equal(gate.fits(1400), false, '2000 MB free, 1200 still to come: 800 < 1400');
  assert.equal(gate.fits(600), true, 'an ODC process fits');
  rss.set(4242, 1300); assert.equal(gate.pendingMb(), 100); room = 1600; assert.equal(gate.fits(1400), true, 'the build showed its memory');
  // No pid (a call on a resident worker): the whole reserve for growMs, then nothing.
  first.hold.release(); const w = gate.hold(1400); room = 2000; assert.equal(gate.fits(1400), false);
  clock += 15000; assert.equal(gate.fits(1400), true); w.release();
  // A waiter is woken by a release and admitted.
  const a = gate.hold(1400); room = 1000;
  const waiting = gate.admit(1400); await settle();
  room = 3000; a.release();
  const b = await waiting; assert.equal(b.timedOut, false); b.hold.release();
  // A wait that runs out holds nothing (R3 M2: the caller refuses, nothing is sent).
  const c = gate.hold(1400); room = 500;
  const late = await createMemoryGate({ room: () => 500, settings: { reserveMb: 1400, waitMs: 120, growMs: 15000 } });
  const h = late.hold(1400); const out = await late.admit(1400);
  assert.equal(out.timedOut, true); assert.equal(out.hold, null); assert.ok(out.shortMb < 1400);
  assert.deepEqual(late.stats(), { admitted: 1, pendingMb: 1400 }, 'only the first hold: the refused one took nothing');
  h.release(); c.release();
  assert.deepEqual(gate.stats(), { admitted: 0, pendingMb: 0 });
});

test('the build pool keeps a build queued for memory although a slot is free, runs it when room comes, and times out as BUILD_QUEUE_TIMEOUT (memory)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-mem-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let room = 1000;
  const gate = createMemoryGate({ room: () => room, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 1000, growMs: 15000 } });
  const pool = createBuildPool({ dir, size: 2, queueMs: 3000, memory: { gate, reserveMb: 1400, odcReserveMb: 600 } });
  let release; const firstDone = new Promise(r => { release = r; });
  const order = [];
  const first = pool.run({ customer: 'a' }, async () => { order.push('a'); assert.ok(gate.current(), 'the build runs inside its hold'); await firstDone; return 'a'; });
  await settle();
  const second = pool.run({ customer: 'b' }, async () => { order.push('b'); return 'b'; });
  await settle(); await settle();
  assert.deepEqual(order, ['a'], 'slot 2 is free but 1000 MB cannot hold another 1400 MB build');
  assert.equal(pool.stats().waiting, 1);
  room = 4000; release();
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  // An ODC build needs its smaller reserve only: 2100 MB free, 1400 still to come for the running build (no pid: a
  // resident worker), 700 left: an ODC build (600) starts, an O11 one (1400) waits.
  room = 2100; let end; const hold = new Promise(r => { end = r; });
  const busy = pool.run({ customer: 'c' }, () => hold);
  await settle();
  assert.equal(await pool.run({ customer: 'd', lane: 'odc' }, async () => 'odc'), 'odc');
  // A wait for memory that runs out is the pool's refusal, waitedFor memory, nothing ran.
  const short = createBuildPool({ dir: path.join(dir, 'b'), size: 2, queueMs: 150, memory: { gate, reserveMb: 1400, odcReserveMb: 600 } });
  await assert.rejects(short.run({ customer: 'e' }, async () => assert.fail('must not run')),
    e => e instanceof BuildQueueRefused && e.refusal.code === 'BUILD_QUEUE_TIMEOUT' && e.refusal.waitedFor === 'memory' && /memory its build needs/.test(e.refusal.error));
  end(); await busy;
  // Without a gate the pool is as before.
  const plain = createBuildPool({ dir: path.join(dir, 'c'), size: 1, queueMs: 100 });
  assert.equal(await plain.run({}, async () => 'x'), 'x'); assert.equal(plain.stats().memory, undefined);
});

test('a cold process takes the gate\'s room: alone it starts, inside a slot it attaches its pid to the slot\'s hold and never waits twice', async () => {
  let room = 500; const admitted = [];
  const gate = createMemoryGate({ room: () => room, rssOf: () => 100, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 5000, growMs: 15000 } });
  const real = gate.admit.bind(gate); gate.admit = async mb => { admitted.push(mb); return real(mb); };
  const execFileFn = (cmd, argv, opts, cb) => { setTimeout(() => cb(null, JSON.stringify({ ok: true, command: argv[1] }), ''), 20); return { pid: 777, stdin: null }; };
  const run = createAnvilRunner({ root: os.tmpdir(), execFileFn, environment: () => ({}), memory: gate });
  const r = await run(['inspect'], { cli: 'anvil.dll' });
  assert.equal(r.ok, true); assert.deepEqual(admitted, [1400], 'an O11 cold process is admitted with the O11 reserve');
  assert.deepEqual(gate.stats(), { admitted: 0, pendingMb: 0 }, 'released when it ended');
  await run(['apply'], { cli: 'anvil-odc.dll' }); assert.deepEqual(admitted, [1400, 600], 'ODC: its own reserve');
  // Inside a slot: no admission of its own, its pid on the slot's hold while it runs, detached after.
  const slot = gate.hold(1400); let seen = null;
  const slotted = createAnvilRunner({ root: os.tmpdir(), environment: () => ({}), memory: gate,
    execFileFn: (cmd, argv, opts, cb) => { setTimeout(() => { seen = slot.pid; cb(null, '{"ok":true}', ''); }, 10); return { pid: 9001 }; } });
  await gate.run(slot, () => slotted(['apply'], { cli: 'anvil.dll' }));
  assert.equal(seen, 9001); assert.equal(slot.pid, null); assert.deepEqual(admitted, [1400, 600]);
  slot.release();
  // A second process while one runs waits for room; when the wait runs out it is REFUSED, nothing started (R3 M2): the
  // pool's own refusal (BUILD_QUEUE_TIMEOUT, not-sent, waitedFor memory), never timedOut (an uncertain outcome).
  const quick = createMemoryGate({ room: () => 500, rssOf: () => 0, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 1100, growMs: 15000 } });
  const held = quick.hold(1400); let started = 0;
  const counting = (cmd, argv, opts, cb) => { started++; return execFileFn(cmd, argv, opts, cb); };
  const waited = await createAnvilRunner({ root: os.tmpdir(), execFileFn: counting, environment: () => ({}), memory: quick })(['apply'], { cli: 'anvil.dll' });
  assert.equal(started, 0, 'no process was started');
  assert.equal(waited.ok, false); assert.equal(waited.refused, true); assert.equal(waited.notSent, true); assert.equal(waited.timedOut, undefined);
  assert.ok(waited.memoryWaitMs >= 1000);
  assert.equal(waited.envelope.code, 'BUILD_QUEUE_TIMEOUT'); assert.equal(waited.envelope.outcome, 'not-sent'); assert.equal(waited.envelope.waitedFor, 'memory');
  assert.match(waited.envelope.error, /memory its kernel process needs.*nothing of it ran/);
  assert.deepEqual(quick.stats(), { admitted: 1, pendingMb: 1400 }, 'the refused call holds nothing');
  held.release();
  // Room comes before the limit: it runs, with memoryWaitMs.
  let roomNow = 500; const late = createMemoryGate({ room: () => roomNow, rssOf: () => 0, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 5000, growMs: 15000 } });
  const busy = late.hold(1400); setTimeout(() => { roomNow = 5000; busy.release(); }, 1100);
  const ran = await createAnvilRunner({ root: os.tmpdir(), execFileFn, environment: () => ({}), memory: late })(['apply'], { cli: 'anvil.dll' });
  assert.equal(ran.ok, true); assert.ok(ran.memoryWaitMs >= 1000);
  room = 0;
});

test('a customer\'s worker does not start into a container that could not then hold one more kernel process', () => {
  let room = 3500, admitted = 0;
  const workers = new HostedO11Workers({ roomReserveMb: 1400, startMb: 400, roomOf: () => room, gatePending: () => admitted, availableOf: () => 25000, minAvailableMb: 3072, rssOf: () => null });
  assert.equal(workers.memoryRefusal(), null, '3500 - 400 >= 1400');
  admitted = 1800;
  assert.match(workers.memoryRefusal(), /1700 MB free|3500 MB free under its container memory limit \(1800 MB of it already reserved by processes still starting\); one more worker \(400 MB\) would leave less than the 1400 MB/);
  admitted = 0; room = 1700;
  assert.match(workers.memoryRefusal(), /1700 MB free under its container memory limit; one more worker/);
  room = null; assert.equal(workers.memoryRefusal(), null, 'no limit read: decides nothing');
  assert.equal(new HostedO11Workers({ roomOf: () => 10, availableOf: () => null }).memoryRefusal(), null, 'off by default (roomReserveMb 0)');
});

test('an ODC build in a pool slot puts its pid on the slot\'s hold while it runs and takes it off when it ends (R3 B1)', async () => {
  const gate = createMemoryGate({ room: () => 5000, rssOf: () => 100, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 1000, growMs: 15000 } });
  const slot = { index: 0, env: { TEMP: os.tmpdir(), TMP: os.tmpdir() } };
  let finish; const runner = () => { const p = new Promise(r => { finish = r; }); p.child = { pid: 4321 }; return p; };
  const hold = gate.hold(600);
  const exec = slotExec(slot, runner, gate);
  const running = gate.run(hold, () => exec('dotnet', ['anvil-odc.dll', 'apply'], { env: { TEMP: os.tmpdir() } }));
  assert.equal(hold.pid, 4321, 'attached while it runs');
  assert.equal(gate.pendingMb(), 500, 'the reserve minus what the process shows');
  finish({ stdout: '{}' }); await running; await settle();
  assert.equal(hold.pid, null, 'detached when it ended'); assert.equal(gate.pendingMb(), 0);
  // Outside a slot (no hold): nothing attached.
  const bare = slotExec(slot, runner, gate)('dotnet', [], {}); finish({}); await bare;
  hold.release();
});

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
  assert.deepEqual(memorySettings({}), { reserveMb: 1400, odcReserveMb: 600, waitMs: 120000, growMs: 15000, odcWorkerReserveMb: 2150, workerWaitMs: 15000, evictTurnMs: 2000 });
  assert.equal(memorySettings({ SSAM_MEMORY_RESERVE_ODC_WORKER_MB: '1800', SSAM_MEMORY_WORKER_WAIT_MS: '5000' }).odcWorkerReserveMb, 1800);
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

// S1 R3/R4: a resident process that outlives its call (the ODC lane worker) keeps a STANDING hold while it lives: its growth
// still to come (reserve minus RSS) counts in every later decision, and the hold goes with the process. A standing hold is no
// consumer: a lone transient process still enters once nothing more can be evicted (review R3 M6, the progress rule).
const R4 = { reserveMb: 1400, odcReserveMb: 600, waitMs: 400, growMs: 15000, odcWorkerReserveMb: 2150, workerWaitMs: 100, evictTurnMs: 20 };
test('standing hold: the growth still to come counts against a second consumer; a lone one enters; the hold goes with its process', async () => {
  const rss = new Map([[900, 1500]]);
  let room = 2200;
  const gate = createMemoryGate({ room: () => room, rssOf: pid => rss.get(pid) ?? null, settings: { ...R4, waitMs: 120 } });
  const worker = await gate.admit(2150, { standing: true });
  assert.equal(worker.timedOut, false, 'real room for its reserve (a standing start never takes the progress rule, M7)');
  worker.hold.attach(900); room = 2000;
  assert.equal(gate.pendingMb(), 650, 'reserve 2150 minus RSS 1500: its growth to come');
  assert.deepEqual(gate.stats(), { admitted: 1, standing: 1, pendingMb: 650 });
  const lone = await gate.admit(1400);
  assert.equal(lone.timedOut, false, 'no other consumer and nothing to evict: the lone build enters (progress)');
  const second = await gate.admit(1400);
  assert.equal(second.timedOut, true, 'room 2000 - 650 to come - 1400 of the first build: a second build waits and is refused');
  lone.hold.release();
  rss.delete(900); // the worker exited (idle exit): no resident set any more
  assert.equal(gate.pendingMb(), 0); assert.deepEqual(gate.stats(), { admitted: 0, pendingMb: 0 }, 'its hold went with it');
  assert.equal(worker.hold.released, true);
});

// Review R3 M6, the probe (scratchpad/probe/m6.mjs) as a regression: tier other, no call running: server 400, the ODC worker
// at RSS 1498 with its standing hold, one idle O11 reader of R MiB. An O11 delivery (1400) must be admitted at R = 300, 600
// and 800: the idle reader is asked to leave, and the build enters.
test('M6: an O11 delivery is admitted beside a standing ODC worker and an idle O11 reader (R = 0, 300, 600, 800): the reader leaves first', async () => {
  for (const R of [0, 300, 600, 800]) {
    let reader = R, asked = [];
    const gate = createMemoryGate({ room: () => 4240 - (400 + 1498 + reader), rssOf: pid => (pid === 900 ? 1498 : null), settings: R4 });
    const w = gate.hold(2150, { standing: true }); w.attach(900);
    gate.addEvictor({ rank: 0, name: 'o11-readers', evict: async ({ kind }) => { asked.push(kind); if (!reader) return null; reader = 0; return { what: 'o11-reader' }; } });
    const build = await gate.admit(1400, { kind: 'build' });
    assert.equal(build.timedOut, false, 'R=' + R + ': admitted');
    assert.equal(reader, 0, 'R=' + R + ': the idle reader left (or there was none)');
    if (R >= 300) assert.deepEqual(asked.slice(0, 1), ['build'], 'the evictor learns who waits');
    build.hold.release(); w.release();
  }
});

test('relief: idle readers first, then idle workers; one cache per turn; a busy one is never evicted; a second consumer still waits', async () => {
  const room = { value: 1000 }, order = [];
  const gate = createMemoryGate({ room: () => room.value, rssOf: () => null, settings: R4 });
  const readers = [{ mb: 300, busy: false }, { mb: 300, busy: true }];
  const workers = [{ mb: 1500, busy: false }];
  gate.addEvictor({ rank: 1, name: 'workers', evict: async () => { const w = workers.find(x => !x.busy && !x.gone); if (!w) return null; w.gone = true; order.push('worker'); room.value += w.mb; return { what: 'worker' }; } });
  gate.addEvictor({ rank: 0, name: 'readers', evict: async () => { const r = readers.find(x => !x.busy && !x.gone); if (!r) return null; r.gone = true; order.push('reader'); room.value += r.mb; return { what: 'reader' }; } });
  const other = gate.hold(0); // another consumer is admitted: no progress shortcut
  const a = await gate.admit(1400, { kind: 'build' });
  assert.equal(a.timedOut, false);
  assert.deepEqual(order, ['reader', 'worker'], 'the idle reader first (1300 still short), then the idle worker; the busy reader stays');
  assert.equal(readers[1].gone, undefined);
  assert.equal(gate.stats().evictions, 2);
  const b = await gate.admit(5000, { kind: 'build', waitMs: 100 });
  assert.equal(b.timedOut, true, 'nothing more to evict and other consumers admitted: it waits and is refused');
  a.hold.release(); other.release();
});

test('covered hold (B-R3-2): a slot hold covered by its worker\'s standing hold counts nothing until a process of its own attaches', () => {
  const gate = createMemoryGate({ room: () => 5000, rssOf: pid => (pid === 7 ? 100 : null), settings: R4 });
  const slot = gate.hold(600);
  assert.equal(gate.pendingMb(), 600);
  slot.covered = true;
  assert.equal(gate.pendingMb(), 0, 'its build runs on the slot worker, whose growth the standing hold reserves');
  slot.attach(7);
  assert.equal(gate.pendingMb(), 500, 'a cold process of the slot: its own reserve again');
  slot.release();
});

// R4 (M6): the build pool's own line asks for relief too: a build short of memory beside an idle cache gets its slot once the
// cache left, and a lone build beside a standing worker and a busy cache enters by the progress rule.
test('build pool (M6): a build short of memory makes an idle cache leave and runs; beside only busy caches a lone build still runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-pool-relief-'));
  try {
    let cache = 800;
    const gate = createMemoryGate({ room: () => 4240 - (400 + 1498 + cache), rssOf: pid => (pid === 900 ? 1498 : null), settings: R4 });
    const w = gate.hold(2150, { standing: true }); w.attach(900);
    let evictable = true;
    gate.addEvictor({ rank: 0, name: 'cache', evict: async ({ kind }) => { if (!evictable || !cache) return null; assert.equal(kind, 'build'); cache = 0; return { what: 'o11-reader' }; } });
    const pool = createBuildPool({ dir, size: 1, queueMs: 2000, memory: { gate, reserveMb: 1400, odcReserveMb: 600 } });
    assert.equal(await pool.run({ customer: 'a' }, async () => 'built'), 'built');
    assert.equal(cache, 0, 'the idle reader left for the build');
    cache = 800; evictable = false; // the reader serves a read now: never asked; the build is the only consumer
    assert.equal(await pool.run({ customer: 'a' }, async () => 'built again'), 'built again', 'progress: nothing evictable, no other consumer');
    w.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hosted O11 workers (M6): evictIdle retires the least recently used idle worker, never one in a call', () => {
  const workers = new HostedO11Workers({ rssOf: () => null, availableOf: () => null });
  const retired = [];
  workers.retire = (entry, why) => { retired.push([entry.slot, why]); workers.entries.delete(entry.slot); return Promise.resolve(); };
  workers.entries.set('a', { slot: 'a', state: 'ready', busy: true, lastUsed: 1 });
  workers.entries.set('b', { slot: 'b', state: 'ready', busy: false, lastUsed: 5 });
  workers.entries.set('c', { slot: 'c', state: 'ready', busy: false, lastUsed: 3 });
  workers.entries.set('d', { slot: 'd', state: 'starting', busy: true, lastUsed: 0 });
  assert.deepEqual(workers.evictIdle(), { what: 'o11-worker' });
  assert.deepEqual(retired.map(r => r[0]), ['c'], 'the least recently used idle one');
  workers.evictIdle();
  assert.deepEqual(retired.map(r => r[0]), ['c', 'b']);
  assert.equal(workers.evictIdle(), null, 'only a worker in a call and one starting are left');
});

// Review R4 M7 (probe r4.mjs case 2): room 1200, nothing evictable, nothing admitted. The ODC worker's start (standing 2150)
// never takes the progress rule: it is refused and its command runs cold (600, a consumer, which really fits); a build next
// to that cold run is admitted only when it really fits. fits() for a standing request says the same (the 60 s cache).
test('M7: a standing start never takes the progress rule; the cold run fits; a second consumer only when it really fits', async () => {
  let room = 1200;
  const gate = createMemoryGate({ room: () => room, rssOf: () => null, settings: R4 });
  gate.addEvictor({ rank: 1, name: 'none', evict: async () => null });
  assert.equal(gate.fits(2150, { standing: true }), false);
  const w = await gate.admit(2150, { standing: true, waitMs: 100 });
  assert.equal(w.timedOut, true, 'refused: the worker runs cold instead');
  assert.deepEqual(gate.stats(), { admitted: 0, pendingMb: 0 }, 'nothing held for it');
  const cold = await gate.admit(600);
  assert.equal(cold.timedOut, false, 'the cold run (600) fits in 1200');
  const build = await gate.admit(1400, { waitMs: 100 });
  assert.equal(build.timedOut, true, '1200 - 600 to come < 1400: the build waits for real room');
  room = 2100;
  const later = await gate.admit(1400, { waitMs: 100 });
  assert.equal(later.timedOut, false, '2100 - 600 >= 1400: it really fits');
  later.hold.release(); cold.hold.release();
  // With real room the standing start is admitted as before.
  room = 3000;
  const ok = await gate.admit(2150, { standing: true, waitMs: 100 });
  assert.equal(ok.timedOut, false); ok.hold.release();
});

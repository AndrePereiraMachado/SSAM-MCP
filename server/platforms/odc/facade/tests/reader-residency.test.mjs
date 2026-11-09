// Window 4x4 (review S1 M2, B10): the resident O11 readers of a multi-O11 backend (reader-residency.mjs) and their
// admission by the memory gate (reader-client.mjs admitReader). The readers are fakes behind a fake rpc (ping answers as
// WorkerServer.cs Status does; shutdown is recorded); the gate is memory-room.mjs createMemoryGate with a fixed room.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readerResidency, makeRoom, residentReaders, writeReaderMeta, touchLastRead, DEFAULT_READER_RESERVE_MB, DEFAULT_READER_MIN_IDLE_MS, READER_META } from '../reader-residency.mjs';
import { admitReader, ensureReader, registerReaderEvictor } from '../reader-client.mjs';
import { createMemoryGate, MEMORY_WAIT_CODE } from '../memory-room.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-reader-residency-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = path.join(tmp, 'p' + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };

// A platform folder with reader generations: {name: {port, busy, queued, lastRead, runtimeDir, live}}.
function readers(spec) {
  const dir = fresh(), byPort = new Map();
  for (const [name, r] of Object.entries(spec)) {
    const g = path.join(dir, name); fs.mkdirSync(path.join(g, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(g, 'worker.json'), JSON.stringify({ port: r.port, pid: r.port, instanceId: 'i' + r.port, generation: name }));
    if (r.runtimeDir) writeReaderMeta(g, { dll: '/cli/anvil.dll', runtimeDir: r.runtimeDir });
    touchLastRead(g); const at = new Date(r.lastRead); fs.utimesSync(path.join(g, 'last-read'), at, at); fs.utimesSync(path.join(g, 'worker.json'), at, at);
    byPort.set(r.port, r);
  }
  const calls = [];
  const rpc = async (state, args, authorization) => {
    calls.push({ port: state.port, command: args[0], authorization });
    const r = byPort.get(state.port);
    if (!r || r.live === false) throw new Error('ECONNREFUSED');
    if (args[0] === 'ping') return { ok: true, data: { instanceId: 'i' + state.port, busy: !!r.busy, queued: r.queued ?? 0, recycling: false, workingSetMB: r.rss ?? 500 } };
    if (args[0] === 'shutdown') { r.live = false; return { ok: true }; }
    throw new Error('unexpected ' + args[0]);
  };
  return { dir, rpc, calls };
}

test('readerResidency: the ceiling is the compose value, else every kernel (the gate decides what fits); 60 s of hysteresis', () => {
  assert.deepEqual(readerResidency({ env: { SSAM_O11_READERS_MAX: '3' }, versions: 4 }), { max: 3, reserveMb: DEFAULT_READER_RESERVE_MB, minIdleMs: DEFAULT_READER_MIN_IDLE_MS, source: 'env' });
  assert.equal(DEFAULT_READER_MIN_IDLE_MS, 60000);
  assert.equal(readerResidency({ env: {}, versions: 4 }).max, 4, 'no ceiling named: every kernel of the image');
  assert.equal(readerResidency({ env: { SSAM_O11_READERS_MAX: '0' }, versions: 4 }).max, 4, 'an invalid value is ignored');
  assert.equal(readerResidency({ env: { SSAM_MEMORY_RESERVE_READER_MB: '650' } }).reserveMb, 650);
  assert.equal(readerResidency({ env: { SSAM_O11_READER_MIN_IDLE_MS: '5000' } }).minIdleMs, 5000);
});

test('makeRoom (B-R2-2): a reader read within minIdleMs is never asked to leave; limit bounds the evictions of one turn', async () => {
  const t0 = Date.parse('2026-11-09T12:00:00Z');
  const { dir, rpc } = readers({
    old: { port: 31, lastRead: '2026-11-09T11:50:00Z' },
    older: { port: 32, lastRead: '2026-11-09T11:40:00Z' },
    fresh: { port: 33, lastRead: '2026-11-09T11:59:30Z' },
  });
  const room = await makeRoom(dir, { keep: path.join(dir, 'new'), max: 1, rpc, minIdleMs: 60000, limit: 1, now: () => t0 });
  assert.deepEqual(room.evicted.map(e => e.generation), ['older'], 'one per turn, least recently used first');
  const next = await makeRoom(dir, { keep: path.join(dir, 'new'), max: 1, rpc, minIdleMs: 60000, now: () => t0 });
  assert.deepEqual(next.evicted.map(e => e.generation), ['old'], 'the reader read 30 s ago stays');
  assert.equal(next.kept, 1);
});

test('makeRoom: idle readers go least recently used first, a busy one is never stopped, the new one makes max', async () => {
  const { dir, rpc, calls } = readers({
    a: { port: 1, lastRead: '2026-11-09T10:00:00Z' },
    b: { port: 2, lastRead: '2026-11-09T09:00:00Z', busy: true },
    c: { port: 3, lastRead: '2026-11-09T11:00:00Z' },
    d: { port: 4, lastRead: '2026-11-09T08:00:00Z', queued: 1 },
  });
  const keep = path.join(dir, 'new');
  const room = await makeRoom(dir, { keep, max: 2, rpc, authorization: 'k' });
  assert.deepEqual(room.evicted.map(e => e.generation), ['a', 'c'], 'oldest idle first; b (busy) and d (queued) stay');
  assert.equal(room.kept, 2, 'two busy readers stay: the start relies on the gate alone');
  assert.ok(calls.filter(c => c.command === 'shutdown').every(c => c.authorization === 'k'), 'the shutdown carries the authority');
  assert.ok(fs.existsSync(path.join(dir, 'a', 'bin')), 'an evicted reader of a served version keeps its copy');
  const one = readers({ x: { port: 7, lastRead: '2026-11-09T10:00:00Z' } });
  assert.deepEqual((await makeRoom(one.dir, { keep: path.join(one.dir, 'y'), max: 2, rpc: one.rpc })).evicted, [], 'under max: nothing stops');
  assert.deepEqual((await makeRoom(one.dir, { keep: path.join(one.dir, 'y'), max: 1, rpc: one.rpc })).evicted.map(e => e.generation), ['x'], 'max 1: the other version goes');
});

test('makeRoom (B10): the folder of a retired version goes when its reader is not live; a served or live one stays', async () => {
  const served = path.resolve('/studio/o11/11.55.94'), retired = path.resolve('/studio/o11/11.55.91');
  const { dir, rpc } = readers({
    old: { port: 11, lastRead: '2026-11-01T10:00:00Z', runtimeDir: retired, live: false },
    oldLive: { port: 12, lastRead: '2026-11-09T10:00:00Z', runtimeDir: retired },
    cur: { port: 13, lastRead: '2026-11-01T10:00:00Z', runtimeDir: served, live: false },
    legacy: { port: 14, lastRead: '2026-11-01T10:00:00Z', live: false },
  });
  const room = await makeRoom(dir, { keep: path.join(dir, 'new'), max: 4, rpc, servedDirs: [served] });
  assert.deepEqual(room.pruned, ['old']);
  assert.equal(fs.existsSync(path.join(dir, 'old')), false);
  for (const kept of ['oldLive', 'cur', 'legacy']) assert.ok(fs.existsSync(path.join(dir, kept)), kept);
  const listed = await residentReaders(dir, { rpc });
  assert.deepEqual(listed.filter(r => r.live).map(r => path.basename(r.directory)), ['oldLive']);
});

test('admitReader: makes room, records the Studio, and holds the reader reserve in the gate; a wait that runs out refuses', async () => {
  const studios = fresh(), clis = fresh();
  const env = { SSAM_IMAGE_O11: '11.55.92,11.55.95', SSAM_O11_STUDIO_ROOT: studios, SSAM_O11_CLI_ROOT: clis, SSAM_O11_READERS_MAX: '1', SSAM_MEMORY_RESERVE_READER_MB: '700' };
  const { dir, rpc } = readers({ other: { port: 21, lastRead: '2026-11-09T10:00:00Z', runtimeDir: path.join(studios, '11.55.95') } });
  const directory = path.join(dir, 'gen92'); fs.mkdirSync(directory);
  let room = 5000;
  const gate = createMemoryGate({ room: () => room, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 60, growMs: 15000 } });
  const busy = gate.hold(1400); // a build admitted before: the reader is not the only admitted process
  const admission = {};
  await admitReader({ dll: path.join(clis, '11.55.92', 'cli', 'anvil.dll'), runtimeDir: path.join(studios, '11.55.92'), directory, authorization: 'k' }, admission, { env, gate, rpc });
  assert.deepEqual(admission.residency.evicted.map(e => e.generation), ['other'], 'max 1: the idle reader of the other version stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, READER_META), 'utf8')).runtimeDir, path.join(studios, '11.55.92'));
  assert.ok(admission.hold, 'admitted'); assert.equal(gate.stats().admitted, 2);
  assert.equal(gate.pendingMb(), 1400 + 700, 'the reader reserve counts until its pid shows memory');
  admission.hold.release();
  room = 1500; // the build holds 1400 pending: 100 left, short of 700
  await assert.rejects(admitReader({ dll: 'x', runtimeDir: path.join(studios, '11.55.92'), directory, authorization: 'k' }, {}, { env, gate, rpc }),
    error => error.code === MEMORY_WAIT_CODE && error.refusal.outcome === 'not-sent' && error.refusal.waitedFor === 'memory' && /This read waited/.test(error.message));
  busy.release();
  const alone = {};
  await admitReader({ dll: 'x', runtimeDir: path.join(studios, '11.55.92'), directory, authorization: 'k' }, alone, { env, gate, rpc });
  assert.ok(alone.hold, 'the only admitted process is always admitted'); alone.hold.release();
  // B-R2-3: a reader outlives the slot it may start in: it reserves on its own there too.
  room = 5000;
  const slot = gate.hold(100), inside = {};
  await gate.run(slot, () => admitReader({ dll: 'x', runtimeDir: path.join(studios, '11.55.92'), directory, authorization: 'k' }, inside, { env, gate, rpc }));
  assert.ok(inside.hold && inside.hold !== slot, 'its own hold, not the slot\'s'); assert.equal(inside.hold.mb, 700);
  inside.hold.release(); slot.release();
});

test('admitReader (B-R2-1, R4): a reader waiting for memory asks one more idle reader to leave at each relief turn, and is admitted once it left', async () => {
  const studios = fresh(), clis = fresh();
  const env = { SSAM_IMAGE_O11: '11.55.92,11.55.93,11.55.95', SSAM_O11_STUDIO_ROOT: studios, SSAM_O11_CLI_ROOT: clis, SSAM_MEMORY_RESERVE_READER_MB: '700', SSAM_O11_READER_MIN_IDLE_MS: '60000' };
  // Two idle readers of other versions, under the ceiling (3): makeRoom stops nobody; the memory is what is short.
  const { dir, rpc, calls } = readers({
    r93: { port: 41, lastRead: '2026-11-09T10:00:00Z', runtimeDir: path.join(studios, '11.55.93'), rss: 900 },
    r95: { port: 42, lastRead: '2026-11-09T09:00:00Z', runtimeDir: path.join(studios, '11.55.95'), rss: 900 },
  });
  const directory = path.join(dir, 'gen92'); fs.mkdirSync(directory);
  // The room grows by a reader's 900 MB each time one is shut down.
  const room = () => 300 + 900 * calls.filter(c => c.command === 'shutdown').length;
  const gate = createMemoryGate({ room, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 2000, growMs: 15000, evictTurnMs: 50 } });
  const build = gate.hold(0); // another admitted process: the reader is not alone
  const admission = {};
  await admitReader({ dll: 'x', runtimeDir: path.join(studios, '11.55.92'), directory, authorization: 'k' }, admission, { env, gate, rpc });
  assert.ok(admission.hold, 'admitted once the idle reader left, well before the wait ran out');
  assert.deepEqual(calls.filter(c => c.command === 'shutdown').map(c => c.port), [42], 'one idle reader, the least recently used, and no more than needed');
  admission.hold.release(); build.release();
});

// R4 (review R3 M6): the readers are a cache every waiter may ask to leave; a non-reader waiter evicts a reader idle for 5 s,
// a waiting reader spares the ones read within 60 s; a busy one is never asked.
test('reader evictor (M6): a build evicts a reader idle 5 s; a waiting reader spares one read within 60 s; a busy one stays', async () => {
  const now = Date.now();
  const { dir, rpc, calls } = readers({
    recent: { port: 51, lastRead: new Date(now - 20000).toISOString() },
    busy: { port: 52, lastRead: new Date(now - 600000).toISOString(), busy: true },
  });
  const gate = createMemoryGate({ room: () => 5000, settings: { reserveMb: 1400, odcReserveMb: 600, waitMs: 100, growMs: 15000, evictTurnMs: 0 } });
  registerReaderEvictor(gate, dir, { rpc, authorization: 'k', minIdleMs: 60000 });
  registerReaderEvictor(gate, dir, { rpc, authorization: 'k' });
  assert.equal(await gate.relieve({ kind: 'reader', force: true }), null, 'a waiting reader spares the reader read 20 s ago, and the busy one');
  const r = await gate.relieve({ kind: 'build', force: true });
  assert.equal(r.what, 'o11-reader'); assert.equal(r.generation, 'recent', 'a build evicts the reader idle for 20 s (>= 5 s)');
  assert.deepEqual(calls.filter(c => c.command === 'shutdown').map(c => c.port), [51], 'registered once; the busy one never asked');
});

test('ensureReader (M4): the startup deadline runs from the spawn, after a late admission; a reader that does not answer in time is killed and its hold released', async () => {
  const directory = fresh();
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  let released = false, attached = null, spawnedAt = null;
  const hold = { mb: 700, attach(pid) { attached = pid; }, release() { released = true; } };
  const admittedAt = [];
  const admit = async (_args, admission) => { await new Promise(r => setTimeout(r, 300)); admittedAt.push(Date.now()); admission.hold = hold; };
  const child = { pid: 424242, exitCode: null, on() {}, unref() {} };
  const killed = [];
  const spawnFn = () => { spawnedAt = Date.now(); return child; };
  const started = Date.now();
  await assert.rejects(ensureReader({ dll: path.join(directory, 'anvil.dll'), runtimeDir: directory, platform: 'ss4', directory, generation: 'g', authority: directory, authorization: 'k' }, {},
    { resident: true, admit, spawnFn, startMs: 250, kill: pid => killed.push(pid), live: async () => null }), /startup timed out/);
  assert.ok(spawnedAt >= admittedAt[0], 'spawned after the admission');
  assert.ok(Date.now() - spawnedAt >= 240, 'the whole startup time counts from the spawn, not from before the wait');
  assert.ok(Date.now() - started >= 540);
  assert.equal(attached, 424242); assert.deepEqual(killed, [424242], 'the late reader is killed'); assert.equal(released, true, 'and its reservation released');
  assert.equal(fs.existsSync(path.join(directory, 'start.lock')), false);
});

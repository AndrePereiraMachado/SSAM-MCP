// Window 4x4 (review S1 M2, B10): the resident O11 readers of a multi-O11 backend (reader-residency.mjs) and their
// admission by the memory gate (reader-client.mjs admitReader). The readers are fakes behind a fake rpc (ping answers as
// WorkerServer.cs Status does; shutdown is recorded); the gate is memory-room.mjs createMemoryGate with a fixed room.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readerResidency, makeRoom, residentReaders, writeReaderMeta, touchLastRead, DEFAULT_READER_RESERVE_MB, READER_META } from '../reader-residency.mjs';
import { admitReader } from '../reader-client.mjs';
import { createMemoryGate, MEMORY_WAIT_CODE } from '../memory-room.mjs';

const GIB = 1024 * 1024 * 1024;
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

test('readerResidency: the compose value, else the container limit (1 under 8 GiB, 2 from 8 GiB), else every kernel', () => {
  assert.deepEqual(readerResidency({ env: { SSAM_O11_READERS_MAX: '3' }, versions: 4, limitBytes: 4240 * 1024 * 1024 }), { max: 3, reserveMb: DEFAULT_READER_RESERVE_MB, source: 'env' });
  assert.equal(readerResidency({ env: {}, versions: 4, limitBytes: 4240 * 1024 * 1024 }).max, 1, 'the other tier (4240m)');
  assert.equal(readerResidency({ env: {}, versions: 4, limitBytes: 10 * GIB }).max, 2, 'the hot tier (10g)');
  assert.equal(readerResidency({ env: {}, versions: 4, limitBytes: null }).max, 4, 'no readable limit (a developer machine)');
  assert.equal(readerResidency({ env: { SSAM_O11_READERS_MAX: '0' }, versions: 4, limitBytes: null }).max, 4, 'an invalid value is ignored');
  assert.equal(readerResidency({ env: { SSAM_MEMORY_RESERVE_READER_MB: '650' }, limitBytes: null }).reserveMb, 650);
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
  const inside = {};
  await gate.run(gate.hold(100), () => admitReader({ dll: 'x', runtimeDir: path.join(studios, '11.55.92'), directory, authorization: 'k' }, inside, { env, gate, rpc }));
  assert.equal(inside.hold, undefined, 'inside an admitted slot the slot hold covers it');
});

// L3b (pré-aquecimento): at startup the server asks each lane's worker to prepare the spares of the known captures of the
// modules open in the Studio (else the newest known ones, at most 3), in the background; ssam_doctor answers at once with
// how many are ready. warmSpares sends `warm` only to a worker already up, of the selected installation, that warms.
// A fake worker on a loopback port, fake bridges, temporary folders.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { warmModules, o11WarmCaptures, odcWarmCaptures, spareStatus, warmState, resetWarmState } from '../warm-modules.mjs';
import { warmSpares } from '../anvil-worker.mjs';
import { rememberCapture, modelSha256 } from '../o11-capture-store.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { doctor, warmBackground } from '../ssam.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-modules-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const oml = (file, model) => { const head = Buffer.from('{w:1}'); const n = Buffer.alloc(4); n.writeUInt32LE(head.length); fs.writeFileSync(file, Buffer.concat([Buffer.from('OML'), n, head, Buffer.from(model)])); return file; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loopbackWorker(t, { studio, key, warm = true, busy = false }) {
  const seen = [];
  const server = net.createServer(socket => {
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      const newline = text.indexOf('\n'); if (newline < 0) return;
      const request = JSON.parse(text.slice(0, newline)); text = text.slice(newline + 1);
      seen.push(request);
      const command = request.args[0];
      const body = command === 'warm' ? JSON.parse(request.args[1]) : null;
      const reply = command === 'ping' ? { ok: true, command, data: { protocol: 'anvil-worker-1', instanceId: 'i', pid: process.pid, busy, queued: 0, recycling: false, studio, hotRead: true, ...(warm ? { warm: true } : {}) } }
        : request.authorization !== key ? { ok: false, command, error: 'Worker operation requires the trusted Hybrid controller', executed: false }
        : { ok: true, command, data: { wanted: body.captures.map(c => ({ wanted: true, file: c.path, modelSha256: modelSha256(c.path), ready: false })), held: 0, limitEntries: 3 } };
      socket.write(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, seen };
}
function laneOptions(dir, port, extra = {}) {
  const studio = path.join(dir, 'studio'), auth = path.join(dir, 'auth');
  fs.mkdirSync(studio, { recursive: true }); fs.mkdirSync(auth, { recursive: true }); fs.writeFileSync(path.join(auth, 'bridge.key'), 'secret-key');
  const laneEnv = ({ lane, root, env }) => o11LaneOf(lane, { root, env }).env(env);
  return { studio, options: { root: dir, laneEnv, env: { USERPROFILE: dir, LOCALAPPDATA: dir, ANVIL_WORKER_PORT: String(port), ANVIL_STUDIO_DIR: studio, ANVIL_AUTHORITY_DIR: auth, ...extra } } };
}

test('L3b warmSpares sends warm only to an idle worker of the selected installation that warms; it never starts one', async t => {
  const dir = tmp(t);
  const capture = oml(path.join(dir, 'm.oml'), 'MODEL');
  const never = { spawnFn: () => { throw new Error('never starts a worker'); } };
  const { studio, options } = laneOptions(dir, 0);
  const at = port => ({ ...options, env: { ...options.env, ANVIL_WORKER_PORT: String(port) } });

  const w = await loopbackWorker(t, { studio, key: 'secret-key' });
  const used = await warmSpares('o11', { captures: [{ path: capture, supersedes: path.join(dir, 'before.oml') }, { path: 'relative.oml' }] }, at(w.port), never);
  assert.equal(used.used, true); assert.equal(used.port, w.port);
  assert.deepEqual(w.seen.map(r => r.args[0]), ['ping', 'warm']);
  assert.equal(w.seen[1].authorization, 'secret-key');
  assert.deepEqual(JSON.parse(w.seen[1].args[1]), { captures: [{ path: path.resolve(capture), supersedes: path.resolve(dir, 'before.oml') }] }, 'absolute paths only');
  assert.equal(used.wanted[0].modelSha256, modelSha256(capture));

  const older = await loopbackWorker(t, { studio, key: 'secret-key', warm: false });
  const notWarm = await warmSpares('o11', { captures: [{ path: capture }] }, at(older.port), never);
  assert.equal(notWarm.used, false); assert.match(notWarm.note, /does not warm/);
  assert.deepEqual(older.seen.map(r => r.args[0]), ['ping']);

  const busy = await loopbackWorker(t, { studio, key: 'secret-key', busy: true });
  assert.equal((await warmSpares('o11', { captures: [{ path: capture }] }, at(busy.port), never)).used, false);
  assert.deepEqual(busy.seen.map(r => r.args[0]), ['ping'], 'never queues behind a command');

  const other = await loopbackWorker(t, { studio: path.join(dir, 'another'), key: 'secret-key' });
  assert.equal((await warmSpares('o11', { captures: [{ path: capture }] }, at(other.port), never)).used, false);

  assert.equal((await warmSpares('o11', { captures: [{ path: capture }] }, { ...at(w.port), env: { ...at(w.port).env, ANVIL_WORKER: '0' } }, never)).used, false);
  assert.equal((await warmSpares('o11', { captures: [] }, at(w.port), never)).note, 'no capture to warm');
});

test('L3b o11WarmCaptures: the open tabs first (the capture of the tab model, else its newest), else the newest known ones', async t => {
  const dir = tmp(t), local = path.join(dir, 'local');
  const at = minute => new Date(Date.UTC(2026, 9, 24, 9, minute));
  const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(k => [k, oml(path.join(dir, k + '.oml'), 'model ' + k)]));
  ['A', 'B', 'C', 'D', 'E'].forEach((key, i) => rememberCapture(local, { moduleKey: key, module: key, file: files[key.toLowerCase()], now: at(i) }));
  const tabs = [{ name: 'B', key: 'B' }, { name: 'D', key: 'D' }, { name: 'X', key: 'X' }, { name: 'A', key: 'A' }, { name: 'C', key: 'C' }];
  const fingerprints = { B: modelSha256(files.b), D: 'f'.repeat(64) };   // D's tab holds a model no capture has
  const bridge = () => ({ async ok(method, params) {
    assert.equal(method, 'list_open_modules');
    if (!params?.model_sha256_of) return { modules: tabs };
    const name = params.model_sha256_of;
    return { modules: tabs.map(m => (m.name === name && fingerprints[name] ? { ...m, modelSha256: fingerprints[name] } : m)) };
  } });
  const open = await o11WarmCaptures({ local, bridge });
  assert.equal(open.source, 'studio');
  assert.deepEqual(open.captures.map(c => c.moduleKey), ['B', 'A', 'C'], 'B by its model, D skipped (an older module), X unknown, A and C by their newest');
  assert.equal(open.captures[0].model, modelSha256(files.b));
  const none = await o11WarmCaptures({ local, bridge: () => ({ async ok() { throw new Error('no Studio'); } }) });
  assert.equal(none.source, 'known');
  assert.deepEqual(none.captures.map(c => c.moduleKey), ['E', 'D', 'C'], 'the three newest known captures');
});

test('L3b odcWarmCaptures: the newest snapshot of each module with its author and content identity', t => {
  const dir = tmp(t), snapshots = path.join(dir, 'snapshots'); fs.mkdirSync(snapshots);
  const snap = (module, hex, at, meta = {}) => { const file = oml(path.join(snapshots, `${module}-${hex.repeat(64)}.oml`), module + hex); fs.writeFileSync(file + '.json', JSON.stringify({ module, capturedAt: at, ...meta })); return file; };
  snap('App', 'a', '2026-10-24T09:00:00Z', { developerId: 'dev-1' });
  const newest = snap('App', 'b', '2026-10-24T10:00:00Z', { developerId: 'dev-1', contentSha256: 'c'.repeat(64) });
  snap('Lib', 'c', '2026-10-24T08:00:00Z', { developerId: 'dev-2' });
  fs.writeFileSync(path.join(snapshots, 'App-revision-3.oml'), 'not a snapshot');
  const found = odcWarmCaptures({ odcRoot: dir });
  assert.deepEqual(found.captures.map(c => [c.module, c.path, c.developerId, c.contentSha256]), [['App', newest, 'dev-1', 'c'.repeat(64)], ['Lib', found.captures[1].path, 'dev-2', null]]);
  assert.deepEqual(odcWarmCaptures({ odcRoot: path.join(dir, 'none') }).captures, []);
});

test('L3b warmModules asks once per author, records what it asked; SSAM_NO_WARM and disabled workers ask nothing', async t => {
  resetWarmState(); t.after(resetWarmState);
  const dir = tmp(t);
  const files = ['x', 'y', 'z'].map(k => oml(path.join(dir, k + '.oml'), k));
  const sent = [];
  const warm = async (lane, request) => { sent.push([lane, request]); return { used: true, port: 1, wanted: request.captures.map(c => ({ wanted: true, file: c.path, modelSha256: modelSha256(c.path) })) }; };
  const odc = await warmModules('odc', { env: {} }, { warm, captures: async () => ({ source: 'known', captures: [
    { path: files[0], developerId: 'dev-1', contentSha256: 'c'.repeat(64) }, { path: files[1], developerId: 'dev-2' }, { path: files[2], developerId: 'dev-1' }] }) });
  assert.deepEqual(sent.map(([lane, r]) => [lane, r.developerId, r.captures.map(c => path.basename(c.path))]), [['odc', 'dev-1', ['x.oml', 'z.oml']], ['odc', 'dev-2', ['y.oml']]]);
  assert.equal(sent[0][1].captures[0].contentSha256, 'c'.repeat(64));
  assert.equal(odc.used, true); assert.equal(odc.wanted, 3);
  assert.deepEqual(warmState().odc.asked.map(a => a.model), files.map(f => modelSha256(f)));
  sent.length = 0;
  assert.equal((await warmModules('o11', { env: { SSAM_NO_WARM: '1' } }, { warm })).used, false);
  assert.equal((await warmModules('o11', { env: { ANVIL_WORKER: '0' } }, { warm })).used, false);
  assert.equal((await warmModules('odc', { env: { ANVIL_ODC_NO_WORKER: '1' } }, { warm })).used, false);
  const nothing = await warmModules('o11', { env: {} }, { warm, captures: async () => ({ source: 'known', captures: [] }) });
  assert.equal(nothing.note, 'no known capture to warm');
  assert.equal(sent.length, 0);
});

test('L3b spareStatus: asked and ready per lane from one short ping; null when nothing was warmed here', async t => {
  resetWarmState(); t.after(resetWarmState);
  assert.equal(await spareStatus({ pingWorker: async () => { throw new Error('never pinged'); } }), null);
  const dir = tmp(t);
  const a = oml(path.join(dir, 'a.oml'), 'a'), b = oml(path.join(dir, 'b.oml'), 'b');
  await warmModules('o11', { env: {} }, { captures: async () => ({ source: 'studio', captures: [{ path: a }, { path: b }] }),
    warm: async (lane, r) => ({ used: true, port: 1, wanted: r.captures.map(c => ({ wanted: true, file: c.path, modelSha256: modelSha256(c.path) })) }) });
  const pinged = [];
  const status = await spareStatus({ pingWorker: async lane => { pinged.push(lane); return { baseCache: { entries: 2, keys: [modelSha256(a).slice(0, 16), 'ffffffffffffffff'], warming: [modelSha256(b).slice(0, 16)] } }; } });
  assert.deepEqual(pinged, ['o11']);
  assert.deepEqual(status, { o11: { asked: 2, ready: 1, held: 2, warming: 1, source: 'studio', since: warmState().o11.at } });
  const down = await spareStatus({ pingWorker: async () => null });
  assert.equal(down.o11.worker, 'not answering'); assert.equal(down.o11.ready, 0);
  assert.equal(await spareStatus({ lanes: ['odc'], pingWorker: async () => null }), null);
});

test('L3b ssam_doctor answers at once with the spares; the startup warm-up warms each lane after its worker is up', async t => {
  const began = performance.now();
  const lanes = { o11: async () => ({ ok: true, studio: { open: true } }), odc: async () => ({ ok: true, studio: { open: false } }) };
  const report = await doctor(undefined, { lanes, spares: async ({ lanes: asked }) => ({ o11: { asked: 2, ready: 1, lanes: asked } }) });
  assert.deepEqual(report.spares, { o11: { asked: 2, ready: 1, lanes: ['o11', 'odc'] } });
  assert.ok(performance.now() - began < 1000);
  assert.equal((await doctor('o11', { lanes, spares: async () => null })).spares, undefined);
  assert.equal((await doctor('o11', { lanes, spares: async () => { throw new Error('ping failed'); } })).spares, undefined, 'a status that fails never fails the doctor');

  const order = [];
  await warmBackground({ env: { ANVIL_ODC_NO_WORKER: '1' }, lanes: ['odc', 'o11'], indexes: async () => {}, facts: { warm: async () => {} },
    worker: name => ({ ensure: async () => { await sleep(20); order.push('ensure-' + name); return { status: {} }; } }), spares: async name => { order.push('spares-' + name); } });
  assert.deepEqual(order, ['ensure-o11', 'spares-o11'], 'only lanes with a worker, the spares after it is up');
  order.length = 0;
  await warmBackground({ env: { SSAM_NO_WARM: '1' }, indexes: async () => {}, facts: { warm: async () => {} }, worker: () => ({ ensure: async () => order.push('x') }), spares: async () => order.push('y') });
  assert.deepEqual(order, []);
});

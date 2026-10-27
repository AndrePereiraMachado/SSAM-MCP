// S14 (leitura quente): ssam_map view "flow" (one or several actions, or the whole list) and "digest" go first to the
// lane's write worker when it is up, free and keeps the spare of the capture's model (anvil-worker.mjs hotModuleRead, the
// worker's hot-read: the kernel reader over the spare, kernel HotModuleReadTests); anything else reads cold through the
// resident reader, exactly as before. The answer is the cold one (its timings and cache aside), the cache says
// via:"worker". The worker is never started, stopped, waited for or queued behind. Fake readers and a fake worker on a
// loopback port; temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { moduleMap, flowFile } from '../module-map.mjs';
import { hotModuleRead, HOT_READ } from '../anvil-worker.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { FLOW_EXTRACTOR, FLOW_SELECTION_SCHEMA } from '../module-flow.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

function setup(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-map-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  return { dir, store, env, ...writeCapture(dir, text) };
}

const actionText = (name, key) => ['server action ' + name + ' @' + key, '  in Id: Long Integer @p1', '  assign Total = Total + 1 @n1', '  end @n2'].join('\n') + '\n';
function flowOf({ lane, sourceSha256 }) {
  const action = (name, key, kind = 'ServerAction') => ({ key, kind, name, fixedPoint: true, nodes: 4, digestBytes: 80,
    text: actionText(name.replace(/^.*\//, ''), key), ids: { start: 'S' + key, n1: 'N1' + key }, problems: [] });
  return { schema: 'ssam-flow/1', extractor: FLOW_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-24T00:00:00Z',
    module: { name: 'Quotes', key: 'R0' }, notWritten: {}, actions: [action('GetQuote', 'A1'), action('SaveQuote', 'A2'), action('ListQuotes', 'A3')] };
}
function selectionOf(flow, elements) {
  const built = flow.actions.filter(a => elements.some(e => a.key === e.replace(/^@/, '') || a.name.toLowerCase() === e.toLowerCase())).map(a => ({ ...a, digestBytes: 0 }));
  return { ...flow, schema: FLOW_SELECTION_SCHEMA, partial: true, actions: built, notWritten: {},
    scope: { completeModule: false, availableActions: flow.actions.length, builtActions: built.length, notBuilt: { actions: flow.actions.length - built.length }, requested: elements },
    catalog: flow.actions.map(a => ({ key: a.key, kind: a.kind, name: a.name })) };
}
// The kernel reader (read-serve and the worker's hot-read run the same SnapshotReadCache): a selection for
// {"flowElements"}, the whole flow written to the store for {"flow":"ensure"}.
function kernelReader(c, lane, requests) {
  const flow = flowOf({ lane, sourceSha256: c.sha256 });
  return async request => {
    requests.push(request);
    if (request.flowElements) return { ok: true, sourceSha256: c.sha256, flowSelection: selectionOf(flow, request.flowElements), cache: { loads: 1, queryHit: false }, timings: { loadMs: 1 } };
    const file = flowFile(lane, c.sha256, c.env);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(flow));
    return { ok: true, sourceSha256: c.sha256, flow: { path: file, built: true }, cache: { loads: 1 }, timings: { loadMs: 1 } };
  };
}
const coldOf = (kernel, seen) => async config => { seen.push(config.request); return kernel(config.request); };
const hotOf = (kernel, seen, used = true) => async (lane, { request, indexRoot }) => {
  seen.push({ lane, request, indexRoot });
  if (used !== true) return { used: false, note: used };
  const response = await kernel(request);
  return { used: true, response: { ...response, cache: { ...response.cache, generation: 'worker:i', via: 'worker' } } };
};
const strip = answer => { const { timings, cache, size, ...rest } = answer; return rest; };
const never = async () => { throw new Error('the cold reader is not used when the worker answers'); };

test('S14 a flow read by element, by a list and the whole list go to the worker first and answer what the cold read answers', async t => {
  for (const lane of ['o11', 'odc']) {
    for (const element of ['GetQuote', ['GetQuote', 'SaveQuote'], undefined]) {
      const input = { lane, view: 'flow', ...(element ? { element } : {}) };
      const text = 'capture ' + lane + ' ' + JSON.stringify(element);
      const cold = setup(t, text), coldSeen = [];
      const coldAnswer = await moduleMap({ ...input, target: cold.file }, { env: cold.env, read: coldOf(kernelReader(cold, lane, []), coldSeen), hot: null });
      assert.equal(coldAnswer.ok, true, coldAnswer.error);
      const hot = setup(t, text), hotSeen = [];
      const hotAnswer = await moduleMap({ ...input, target: hot.file }, { env: hot.env, read: never, hot: hotOf(kernelReader(hot, lane, []), hotSeen) });
      assert.equal(hotAnswer.ok, true, hotAnswer.error);
      assert.equal(hotAnswer.cache.via, 'worker'); assert.equal(coldAnswer.cache.via, undefined);
      assert.equal(hotAnswer.cache.flow, coldAnswer.cache.flow);
      // the same answer, the capture's own paths named alike
      assert.deepEqual(JSON.parse(JSON.stringify(strip(hotAnswer)).replaceAll(JSON.stringify(hot.dir).slice(1, -1), '<dir>')),
        JSON.parse(JSON.stringify(strip(coldAnswer)).replaceAll(JSON.stringify(cold.dir).slice(1, -1), '<dir>')));
      // the worker got the reader's own request and the store the facade reads
      assert.deepEqual(hotSeen.map(s => s.request), coldSeen.map(r => ({ ...r, file: r.file.replace(cold.dir, hot.dir) })));
      assert.ok(hotSeen.every(s => s.lane === lane && path.resolve(s.indexRoot) === path.resolve(hot.store)));
    }
  }
});

test('S14 a worker that ran nothing (down, busy, no spare, a failure) leaves the read cold; an injected reader alone never goes hot', async t => {
  for (const outcome of ['no o11 worker is up on port 1', 'busy', 'throws']) {
    const c = setup(t), coldSeen = [], hotSeen = [];
    const hot = outcome === 'throws' ? async () => { hotSeen.push(1); throw new Error('transport'); } : hotOf(kernelReader(c, 'o11', []), hotSeen, outcome);
    const answer = await moduleMap({ lane: 'o11', view: 'flow', element: 'SaveQuote', target: c.file }, { env: c.env, read: coldOf(kernelReader(c, 'o11', []), coldSeen), hot });
    assert.equal(answer.ok, true, answer.error); assert.equal(answer.cache.via, undefined);
    assert.equal(hotSeen.length, 1); assert.equal(coldSeen.length, 1, 'read cold once');
  }
  const c = setup(t), coldSeen = [];
  const answer = await moduleMap({ lane: 'o11', view: 'flow', element: 'SaveQuote', target: c.file }, { env: c.env, read: coldOf(kernelReader(c, 'o11', []), coldSeen) });
  assert.equal(answer.ok, true); assert.equal(coldSeen.length, 1);
});

// A worker on a loopback port: its ping and its hot-read, as WorkerServer.cs answers them.
async function loopbackWorker(t, { studio, key, status = {}, reply = null }) {
  const seen = [];
  const server = net.createServer(socket => {
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      const newline = text.indexOf('\n'); if (newline < 0) return;
      const request = JSON.parse(text.slice(0, newline)); text = text.slice(newline + 1);
      seen.push(request);
      const command = request.args[0];
      const answer = command === 'ping'
        ? { ok: true, command, data: { protocol: 'anvil-worker-1', instanceId: 'w1', pid: process.pid, busy: false, queued: 0, recycling: false, idleWork: false, studio,
          hotRead: true, cachedModules: 1, ...status } }
        : request.authorization !== key ? { ok: false, command, error: 'Worker operation requires the trusted Hybrid controller', executed: false }
        : reply ?? { ok: true, sourceSha256: 'a'.repeat(64), digest: { path: 'x', built: true }, cache: { loads: 0 }, timings: { serverMs: 3 }, hot: { reused: true }, queuedMs: 0 };
      socket.write(JSON.stringify(answer) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, seen };
}

test('S14 hotModuleRead reads only on an idle worker of the selected installation that keeps a spare; it never starts, waits for or queues behind one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-hot-read-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const studio = path.join(dir, 'studio'), auth = path.join(dir, 'auth');
  fs.mkdirSync(studio, { recursive: true }); fs.mkdirSync(auth, { recursive: true }); fs.writeFileSync(path.join(auth, 'bridge.key'), 'secret-key');
  const laneEnv = ({ lane, root, env }) => o11LaneOf(lane, { root, env }).env(env);
  const options = (port, extra = {}) => ({ root: dir, laneEnv, env: { USERPROFILE: dir, LOCALAPPDATA: dir, ANVIL_WORKER_PORT: String(port), ANVIL_STUDIO_DIR: studio, ANVIL_AUTHORITY_DIR: auth, ...extra } });
  const deps = { spawnFn: () => { throw new Error('a read never starts a worker'); } };
  const request = { file: path.join(dir, 'c.oml'), digest: 'ensure', expectedSourceSha256: 'a'.repeat(64) };

  const idle = await loopbackWorker(t, { studio, key: 'secret-key' });
  const used = await hotModuleRead('o11', { request, indexRoot: path.join(dir, 'store') }, options(idle.port), deps);
  assert.equal(used.used, true, used.note);
  assert.deepEqual(idle.seen.map(r => r.args[0]), ['ping', HOT_READ]);
  assert.equal(idle.seen[1].authorization, 'secret-key');
  assert.deepEqual(JSON.parse(idle.seen[1].args[1]), { ...request, indexRoot: path.resolve(dir, 'store') });
  assert.equal(used.response.cache.via, 'worker'); assert.equal(used.response.cache.generation, 'worker:w1');
  assert.equal(used.response.queuedMs, undefined); assert.deepEqual(used.response.digest, { path: 'x', built: true });

  for (const [status, note] of [[{ busy: true }, /not free/], [{ queued: 1 }, /not free/], [{ hotRead: undefined }, /does not read hot/],
    [{ cachedModules: 0 }, /keeps no spare/], [{ recycling: true }, /recycling/]]) {
    const worker = await loopbackWorker(t, { studio, key: 'secret-key', status });
    const answer = await hotModuleRead('o11', { request }, options(worker.port), deps);
    assert.equal(answer.used, false); assert.match(answer.note, note);
    assert.deepEqual(worker.seen.map(r => r.args[0]), ['ping'], 'nothing is sent to a worker that is not free: ' + JSON.stringify(status));
  }
  // L3b follow-up: a worker preparing a spare is asked (it waits only for the prefetch of this model, and decides that itself)
  for (const status of [{ idleWork: true, cachedModules: 0 }, { cachedModules: 0, baseCache: { entries: 0, warming: ['dcc59e65b706fa14'] } }, { idleWork: true }]) {
    const preparing = await loopbackWorker(t, { studio, key: 'secret-key', status });
    const answer = await hotModuleRead('o11', { request }, options(preparing.port), deps);
    assert.equal(answer.used, true, JSON.stringify(status) + ': ' + answer.note);
    assert.deepEqual(preparing.seen.map(r => r.args[0]), ['ping', HOT_READ]);
  }
  const other = await loopbackWorker(t, { studio: path.join(dir, 'another-studio'), key: 'secret-key' });
  assert.equal((await hotModuleRead('o11', { request }, options(other.port), deps)).used, false);
  assert.deepEqual(other.seen.map(r => r.args[0]), ['ping']);
  // the worker itself refused (it became busy, or holds another model): not executed, read cold
  for (const code of ['WORKER_BUSY', 'HOT_READ_MISS']) {
    const refusing = await loopbackWorker(t, { studio, key: 'secret-key', reply: { ok: false, command: HOT_READ, executed: false, code, error: 'nothing ran' } });
    const answer = await hotModuleRead('o11', { request }, options(refusing.port), deps);
    assert.equal(answer.used, false); assert.equal(answer.code, code);
  }
  const free = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const down = await hotModuleRead('o11', { request }, options(free), deps);
  assert.equal(down.used, false); assert.match(down.note, /no o11 worker is up/);
  const disabled = await loopbackWorker(t, { studio, key: 'secret-key' });
  assert.equal((await hotModuleRead('o11', { request }, options(disabled.port, { ANVIL_WORKER: '0' }), deps)).used, false);
  assert.deepEqual(disabled.seen, [], 'ANVIL_WORKER=0 does not even ping');
});

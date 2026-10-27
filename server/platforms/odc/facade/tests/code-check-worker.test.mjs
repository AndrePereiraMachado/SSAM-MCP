// S9 (check through the hot module): ssam_code check sends its apply to the lane's resident worker when one is already up,
// idle and of the check's installation, and answers exactly as the cold check does (same fields, same problems[]), with
// timings {via, hot}. A worker that ran nothing leaves the check cold; an unknown outcome is never replayed; the check
// never starts, stops or queues behind a worker. Fake runners and a fake worker on a loopback port; temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { codeCheck, CHECK_CANDIDATE } from '../code-check.mjs';
import { residentWorkerClient } from '../anvil-worker.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { slotModelPort } from '../build-pool.mjs';

const flow = 'server action NeutralCheck\n  end\n';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-worker-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const option = (args, name) => args[args.indexOf(name) + 1];
const PROBLEM = { phase: 'verify', op: 0, pointer: '/ops/0/data/flow/0', code: 'ExpressionUnknownObject', severity: 'error', message: 'Unknown object Missing' };
const HOT = { reused: true, reason: 'a spare of the same model, loaded and walked while the worker was idle', savedMs: 812, modelSha256: 'a'.repeat(64) };

// The kernel's apply as both the worker and the cold process run it: the candidate and the kernel's own result beside it.
function kernelApply(args, { ok = true, hot = null } = {}) {
  const out = option(args, '--out');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'candidate of ' + option(args, '--job'));
  const data = ok ? { accepted: true, isValid: true, verifyRan: true, timings: { totalMs: 30, loadMs: 1, scopeMs: 2 }, ...(hot ? { hot } : {}) }
    : { accepted: false, isValid: false, verifyRan: true, problems: [PROBLEM], timings: { totalMs: 30 } };
  fs.writeFileSync(out.replace(/\.oml$/i, '.result.json'), JSON.stringify({ ...data, sources: [{ path: option(args, '--job'), sha256: 'x' }], provenance: { kernelSha256: 'k' } }));
  return ok ? { ok: true, command: 'apply', elapsedMs: 40, data } : { ok: false, command: 'apply', elapsedMs: 40, code: 'VALIDATION_REFUSED', error: 'the Verify refused the candidate', problems: [PROBLEM], data };
}
function setup(t) {
  const dir = tmp(t), base = path.join(dir, 'base.oml');
  fs.writeFileSync(base, 'OML base');
  const cold = [];
  const runAnvil = async (args, options = {}) => { cold.push(args[0]); const envelope = kernelApply(args, options.kernel ?? {}); return { ok: envelope.ok, exitCode: envelope.ok ? 0 : 1, envelope, stderr: [], wallMs: 1 }; };
  return { dir, base, cold, deps: { root: dir, local: path.join(dir, 'local'), runAnvil, guidance: async (_lane, _job, run) => run } };
}
function fakeWorker(reply) {
  const calls = [];
  return { calls, target: { port: 27999 }, run: async argv => { calls.push(argv); return reply(argv); } };
}
const input = base => ({ lane: 'o11', action: 'check', module: 'Neutral', part: 'logic', text: flow, base });
// What differs between two checks of the same input by construction: the private folder, the clock and where it ran.
const comparable = answer => {
  const { wallMs, timings, job, jobSha256, nextBasedOn, capture, ...rest } = answer;
  const { via, hot, kernelMs, ...own } = timings ?? {};
  delete rest[CHECK_CANDIDATE]; // its paths are the private folder's
  return { ...rest, timings: own };
};

test('S9 a check on the resident worker answers what the cold check answers, accepted and refused, with timings {via, hot}', async t => {
  for (const ok of [true, false]) {
    const coldRun = setup(t), hotRun = setup(t);
    const kernel = { ok, hot: ok ? HOT : null };
    const coldAnswer = await codeCheck(input(coldRun.base), { ...coldRun.deps, runAnvil: (args, o) => coldRun.deps.runAnvil(args, { ...o, kernel: { ok } }) });
    const worker = fakeWorker(argv => ({ used: true, envelope: kernelApply(argv, kernel) }));
    const hotAnswer = await codeCheck(input(coldRun.base), { ...hotRun.deps, worker }); // the same capture file
    assert.equal(worker.calls.length, 1); assert.equal(worker.calls[0][0], 'apply');
    assert.equal(hotRun.cold.length, 0, 'nothing ran cold');
    assert.equal(coldRun.cold.length, 1);
    assert.equal(hotAnswer.ok, ok); assert.equal(coldAnswer.ok, ok);
    assert.deepEqual(Object.keys(hotAnswer).sort(), Object.keys(coldAnswer).sort(), 'the same fields');
    assert.deepEqual({ ...hotAnswer.capture, ageSeconds: 0 }, { ...coldAnswer.capture, ageSeconds: 0 });
    assert.deepEqual(comparable(hotAnswer), comparable(coldAnswer));
    if (!ok) assert.deepEqual(hotAnswer.problems, coldAnswer.problems, 'the same problems[]');
    assert.equal(hotAnswer.timings.via, 'worker'); assert.equal(coldAnswer.timings.via, 'process');
    assert.equal(hotAnswer.timings.kernelMs, 40); assert.equal(hotAnswer.timings.totalMs, 30);
    if (ok) {
      assert.deepEqual(hotAnswer.timings.hot, { reused: true, reason: HOT.reason, savedMs: 812 });
      assert.equal(coldAnswer.timings.hot.reused, false);
    }
  }
});

test('S9 a worker that ran nothing (down, busy, another key) leaves the check cold; an unknown outcome is never replayed', async t => {
  for (const reply of [() => ({ used: false, note: 'no o11 worker is up on port 27999' }),
    () => ({ used: true, envelope: { ok: false, executed: false, error: 'Worker operation requires the trusted Hybrid controller' } })]) {
    const s = setup(t);
    const answer = await codeCheck(input(s.base), { ...s.deps, worker: fakeWorker(reply) });
    assert.equal(answer.ok, true, JSON.stringify(answer)); assert.deepEqual(s.cold, ['apply']); assert.equal(answer.timings.via, 'process');
  }
  const s = setup(t);
  const answer = await codeCheck(input(s.base), { ...s.deps, worker: fakeWorker(() => ({ used: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', error: 'worker connection failed after submission' })) });
  assert.equal(answer.ok, false); assert.equal(answer.code, 'CHECK_REFUSED');
  assert.deepEqual(s.cold, [], 'the request the worker may still run is not run again');
});

test('S9 the accepted check keeps its candidate for the draft under a symbol key: no answer the model reads carries it', async t => {
  const s = setup(t);
  const answer = await codeCheck(input(s.base), { ...s.deps, worker: fakeWorker(argv => ({ used: true, envelope: kernelApply(argv, { hot: HOT }) })) });
  const candidate = answer[CHECK_CANDIDATE];
  assert.ok(candidate && fs.existsSync(candidate.path) && fs.existsSync(candidate.result));
  assert.equal(JSON.parse(fs.readFileSync(candidate.result, 'utf8')).provenance.kernelSha256, 'k', 'the kernel\'s own result, before the job runner wrote its answer over it');
  assert.equal(candidate.base, answer.capture.path); assert.equal(candidate.baseModelSha256, answer.capture.model);
  assert.equal(candidate.via, 'worker');
  assert.ok(!JSON.stringify(answer).includes('kernel-result'), 'the serialized answer has no trace of it');
  assert.equal(slotModelPort(answer.capture.model), 27999, 'the build pool now prefers the worker that holds the model');
});

// A worker on a loopback port: its ping and its apply, as WorkerServer.cs answers them.
async function loopbackWorker(t, { studio, key, busy = false }) {
  const seen = [];
  const server = net.createServer(socket => {
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      const newline = text.indexOf('\n'); if (newline < 0) return;
      const request = JSON.parse(text.slice(0, newline)); text = text.slice(newline + 1);
      seen.push(request);
      const command = request.args[0];
      const reply = command === 'ping' ? { ok: true, command, data: { protocol: 'anvil-worker-1', instanceId: 'i', pid: process.pid, busy, queued: 0, recycling: false, studio } }
        : request.authorization !== key ? { ok: false, command, error: 'Worker operation requires the trusted Hybrid controller', executed: false }
        : kernelApply(request.args, { hot: HOT });
      socket.write(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, seen };
}

test('S9 residentWorkerClient serves only an idle worker of the selected installation; it never starts one', async t => {
  const dir = tmp(t), studio = path.join(dir, 'studio'), auth = path.join(dir, 'auth');
  fs.mkdirSync(studio, { recursive: true }); fs.mkdirSync(auth, { recursive: true }); fs.writeFileSync(path.join(auth, 'bridge.key'), 'secret-key');
  const laneEnv = ({ lane, root, env }) => o11LaneOf(lane, { root, env }).env(env);
  const client = (port, extra = {}) => residentWorkerClient('o11', { root: dir, laneEnv, env: { USERPROFILE: dir, LOCALAPPDATA: dir, ANVIL_WORKER_PORT: String(port), ANVIL_STUDIO_DIR: studio, ANVIL_AUTHORITY_DIR: auth, ...extra } },
    { spawnFn: () => { throw new Error('a check never starts a worker'); } });
  const out = path.join(dir, 'out', 'candidate.oml');
  const argv = ['apply', '--job', path.join(dir, 'job.json'), '--out', out];

  const idle = await loopbackWorker(t, { studio, key: 'secret-key' });
  const used = await client(idle.port).run(argv);
  assert.equal(used.used, true); assert.equal(used.envelope.ok, true);
  assert.deepEqual(idle.seen.map(r => r.args[0]), ['ping', 'apply']);
  assert.equal(idle.seen[1].authorization, 'secret-key');

  const busy = await loopbackWorker(t, { studio, key: 'secret-key', busy: true });
  const queued = await client(busy.port).run(argv);
  assert.equal(queued.used, false); assert.match(queued.note, /busy/);
  assert.deepEqual(busy.seen.map(r => r.args[0]), ['ping'], 'a check never queues behind a delivery');

  const other = await loopbackWorker(t, { studio: path.join(dir, 'another-studio'), key: 'secret-key' });
  const elsewhere = await client(other.port).run(argv);
  assert.equal(elsewhere.used, false); assert.match(elsewhere.note, /serves/);
  assert.deepEqual(other.seen.map(r => r.args[0]), ['ping'], 'a worker of another installation is left running, never stopped');

  const free = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const down = await client(free).run(argv);
  assert.equal(down.used, false); assert.match(down.note, /no o11 worker is up/);

  const disabled = await client(idle.port, { ANVIL_WORKER: '0' }).run(argv);
  assert.equal(disabled.used, false);
});

test('S9 the default check finds the resident worker by itself; ANVIL_WORKER=0 or an injected runner keeps it cold and never pings', async t => {
  const dir = tmp(t), studio = path.join(dir, 'studio'), auth = path.join(dir, 'auth'), base = path.join(dir, 'base.oml');
  fs.mkdirSync(studio, { recursive: true }); fs.mkdirSync(auth, { recursive: true }); fs.writeFileSync(path.join(auth, 'bridge.key'), 'secret-key');
  fs.writeFileSync(base, 'OML base');
  const worker = await loopbackWorker(t, { studio, key: 'secret-key' });
  const env = { ...process.env, ANVIL_WORKER_PORT: String(worker.port), ANVIL_STUDIO_DIR: studio, ANVIL_AUTHORITY_DIR: auth };
  delete env.ANVIL_WORKER;
  const deps = { root: dir, local: path.join(dir, 'local'), env, guidance: async (_lane, _job, run) => run };
  const answer = await codeCheck(input(base), deps);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.timings.via, 'worker');
  assert.deepEqual(worker.seen.map(r => r.args[0]), ['ping', 'apply']);

  const before = worker.seen.length;
  let cold = 0;
  const runAnvil = async args => { cold++; const envelope = kernelApply(args); return { ok: true, exitCode: 0, envelope, stderr: [], wallMs: 1 }; };
  assert.equal((await codeCheck(input(base), { ...deps, runAnvil })).timings.via, 'process');
  assert.equal((await codeCheck(input(base), { ...deps, runAnvil, env: { ...env, ANVIL_WORKER: '0' } })).timings.via, 'process');
  assert.equal(cold, 2); assert.equal(worker.seen.length, before, 'no ping, no apply');
});

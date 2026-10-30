// Reviewer repro (R2-F rule 3): pending starts are not reserved by the memory guards; a customer's only worker in an
// extra slot loses its minimum residency.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as worker from '../anvil-worker.mjs';
import { fakeWorker } from './fixtures/jobs-fake-worker.mjs';

const { HostedO11Workers, hostedFingerprint } = worker;
const QUICK = { waitMs: 3000, pingMs: 1000, stopMs: 150, idleMs: 60000, minIdleMs: 0 };
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms = 4000) { const d = Date.now() + ms; while (!(await check())) { if (Date.now() > d) throw new Error('timeout'); await sleep(20); } }
function server(t) {
  const dir = temp(t, 'rv-warm-server-');
  const cli = path.join(dir, 'cli', 'anvil.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const studio = path.join(dir, 'Service Studio'); fs.mkdirSync(studio); fs.writeFileSync(path.join(studio, 'ServiceStudio.Framework.dll'), 'studio');
  return { cli, studio };
}
function customer(t, s, name, relay) {
  const workspace = temp(t, 'rv-warm-' + name + '-');
  const authority = path.join(workspace, 'state', 'relay-authority'); fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'bridge.key'), 'KEY-' + name);
  const cwd = path.join(workspace, 'o11'); const tmp = path.join(cwd, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', TEMP: tmp, TMP: tmp, ANVIL_AUTHORITY_DIR: authority, ANVIL_BRIDGE_PORT: String(relay), ANVIL_STUDIO_DIR: s.studio };
  const spec = { tokenId: 'tok_' + name, contextId: 'ctx-' + name, env, cwd, cli: s.cli, key: 'KEY-' + name, studioDir: s.studio, local: path.join(tmp, 'o11-worker') };
  return { ...spec, fingerprint: hostedFingerprint(spec) };
}
function fakeDotnet({ handler = null } = {}) {
  const launched = [];
  const fn = (file, args, options) => {
    const port = Number(args[args.indexOf('--port') + 1]);
    const child = new EventEmitter(); child.pid = 63000 + launched.length;
    const record = { child, port, worker: null, exited: false }; launched.push(record);
    const exitWith = async code => { if (record.exited) return; record.exited = true; await record.worker?.close(); child.emit('exit', code, null); };
    child.kill = () => { setImmediate(() => exitWith(null)); return true; }; child.unref = () => {};
    setTimeout(async () => {
      if (record.exited) return;
      const key = fs.readFileSync(path.join(options.env.ANVIL_AUTHORITY_DIR, 'bridge.key'), 'ascii').trim();
      record.worker = await fakeWorker({ port, key, status: { pid: child.pid, instanceId: 'i' + launched.indexOf(record), studio: options.env.ANVIL_STUDIO_DIR },
        handler: async request => {
          if (request.args[0] === 'shutdown') { setImmediate(() => exitWith(0)); return { ok: true, command: 'shutdown', data: {} }; }
          return handler ? handler(request) : { ok: true, command: request.args[0], data: {} };
        } });
    }, 20);
    return child;
  };
  return Object.assign(fn, { launched });
}
const pool = (t, o) => { const p = new HostedO11Workers({ ...QUICK, ...o }); t.after(() => p.close()); return p; };

test('warm (review): two starts in the same moment each reserve their start size against the MemAvailable floor', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  // 3500 MB available, floor 3072, a start counts 400: room for ONE start (3100), never two (2700).
  const workers = pool(t, { max: 3, spawnFn, minAvailableMb: 3072, startMb: 400, availableOf: () => 3500, rssOf: () => null });
  const a = customer(t, s, 'a', 47901), b = customer(t, s, 'b', 47902);
  const [ra, rb] = await Promise.all([workers.run(a, ['apply']), workers.run(b, ['apply'])]);
  assert.equal(ra.used, false); assert.equal(rb.used, false);
  assert.match(rb.note, /did not start/, 'the second start must see the first one reserved: ' + rb.note);
});

test('warm (review): a start that has no process yet is counted in the workers\' total', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  // Total 1000, start 400: two starts fit (800), the third (1200) never.
  const workers = pool(t, { max: 3, spawnFn, totalRssMb: 1000, startMb: 400, rssOf: () => null });
  const a = customer(t, s, 'a', 47911), b = customer(t, s, 'b', 47912), c = customer(t, s, 'c', 47913);
  const r = await Promise.all([workers.run(a, ['apply']), workers.run(b, ['apply']), workers.run(c, ['apply'])]);
  assert.match(r[2].note, /did not start/, 'three starts of 400 MB passed the 1000 MB total: ' + r[2].note);
});

test('warm (review): a customer\'s only worker keeps its minimum residency, whatever its slot', async t => {
  const s = server(t);
  let hold = deferred();
  const spawnFn = fakeDotnet({ handler: async request => { if (request.args[1] === 'hold') await hold.promise; return { ok: true, command: request.args[0], data: {} }; } });
  const rss = new Map();
  const workers = pool(t, { max: 2, perToken: 2, minIdleMs: 3600000, rssMb: 1000, spawnFn, rssOf: pid => rss.get(pid) ?? 100 });
  const a = customer(t, s, 'a', 47921), b = customer(t, s, 'b', 47922);
  const first = await workers.run(a, ['apply']); assert.equal(first.used, false);
  assert.equal((await workers.starting('tok_a')).ok, true);
  const held = workers.run(a, ['apply', 'hold']);
  await waitFor(() => spawnFn.launched[0].worker?.requests('apply').some(r => r.args[1] === 'hold'));
  await workers.run(a, ['apply', 'x']);
  assert.equal((await workers.starting('tok_a#1')).ok, true);
  // A's first worker passes its resident limit during the held call and is retired after it: A keeps only tok_a#1.
  rss.set(spawnFn.launched[0].child.pid, 1500);
  hold.resolve(); await held;
  await waitFor(() => spawnFn.launched[0].exited);
  assert.equal(workers.workersOf('tok_a').length, 1);
  assert.equal((await workers.run(a, ['apply', 'just-now'])).used, true, 'A just used its only worker');
  // C takes the place #0 left, so no place is free; then B arrives: A's only worker (used a moment ago, within the
  // residency, in slot #1) must stay. (The reviewer's repro let B into the free place; C makes the pool full first.)
  const c = customer(t, s, 'c', 47923);
  assert.match((await workers.run(c, ['apply'])).note, /is not running/);
  assert.equal((await workers.starting('tok_c')).ok, true);
  const rb = await workers.run(b, ['apply']);
  assert.match(rb.note, /no place/, 'B took the place of A\'s only worker: ' + rb.note);
  assert.equal(spawnFn.launched[1].exited, false); assert.ok(workers.workerOf('tok_a#1'));
});

test('warm (review): a worker\'s reservation is replaced by its measured resident set once it served a call', async t => {
  const s = server(t);
  const spawnFn = fakeDotnet();
  // Total 1000, start 400, measured 100: before its first call A counts 400; after it, 100, so B and C both fit.
  const workers = pool(t, { max: 3, spawnFn, totalRssMb: 1000, startMb: 400, rssOf: () => 100 });
  const a = customer(t, s, 'a', 47931), b = customer(t, s, 'b', 47932), c = customer(t, s, 'c', 47933);
  await workers.run(a, ['apply']); assert.equal((await workers.starting('tok_a')).ok, true);
  assert.deepEqual(workers.ledger(), { total: 400, pending: 300, measured: 100 });
  assert.equal((await workers.run(a, ['apply', 'served'])).used, true);
  assert.deepEqual(workers.ledger(), { total: 100, pending: 0, measured: 100 });
  const [rb, rc] = await Promise.all([workers.run(b, ['apply']), workers.run(c, ['apply'])]);
  assert.match(rb.note, /is not running/); assert.match(rc.note, /is not running/, 'measured 100 + 400 + 400 fits 1000: ' + rc.note);
});

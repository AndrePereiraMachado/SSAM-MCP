// L3b (spare pós-merge): after a delivery that merged, the delivered capture is the module the lane's worker prepares next.
// The kernel that delivered in the worker already wants it (nextSpare): the facade only points the next build at that worker.
// A delivery that left no such want (cold, an older kernel) asks the worker in the background (warm). Not delivered: nothing.
// The capture after the merge is what the next build copies (captureByKey), so the build takes that spare. Fakes only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterApply, captureByKey } from '../o11-build-phase.mjs';
import { modelSha256 } from '../o11-capture-store.mjs';
import { slotModelPort } from '../build-pool.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spare-merge-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const oml = (file, model) => { const head = Buffer.from('{w:1}'); const n = Buffer.alloc(4); n.writeUInt32LE(head.length); fs.writeFileSync(file, Buffer.concat([Buffer.from('OML'), n, head, Buffer.from(model)])); return file; };
function scene(t, tag) {
  const dir = tmp(t), local = path.join(dir, 'local');
  const base = oml(path.join(dir, 'base.oml'), 'before ' + tag), delivered = oml(path.join(dir, 'delivered.oml'), 'after ' + tag);
  const data = { delivered: true, moduleKey: 'K', module: 'App', snapshot: { path: base, key: 'K' }, deliveredSnapshot: { path: delivered, key: 'K' } };
  return { dir, local, base, delivered, data, lane: { work: path.join(dir, 'work'), local, name: 'ss4' } };
}
const fakeWorker = (port, warmAnswer) => {
  const calls = [];
  return { calls, workerTarget: () => ({ port }), warmSpares: async (lane, request, options) => { calls.push({ lane, request, options }); return warmAnswer ?? { used: true, port, wanted: [{ wanted: true }] }; } };
};

test('L3b a delivery the kernel ran in the worker: no warm request, the next build prefers that worker', async t => {
  const s = scene(t, 'kernel');
  const worker = fakeWorker(28101);
  const model = modelSha256(s.delivered);
  const run = { via: 'worker', envelope: { ok: true, data: { ...s.data, nextSpare: { wanted: true, modelSha256: model, ready: false } } } };
  const spare = await afterApply(run, null, s.lane, { worker });
  assert.deepEqual(spare, { by: 'kernel', port: 28101, modelSha256: model });
  assert.equal(worker.calls.length, 0, 'the kernel already wants it: nothing is sent');
  assert.equal(slotModelPort(model), 28101);
});

test('L3b a delivery that left no want (cold or an older kernel) asks the worker, superseding the capture before the merge', async t => {
  const s = scene(t, 'cold');
  const worker = fakeWorker(28102);
  const spare = await afterApply({ via: 'process', envelope: { ok: true, data: s.data } }, null, s.lane, { worker });
  assert.equal(spare.by, 'facade'); assert.equal(spare.used, true);
  assert.deepEqual(worker.calls.map(c => [c.lane, c.request.captures]), [['o11', [{ path: path.resolve(s.delivered), supersedes: path.resolve(s.base) }]]]);
  assert.deepEqual(worker.calls[0].options, { o11: 'ss4' });
  assert.equal(slotModelPort(modelSha256(s.delivered)), 28102);
  // a worker that did not take it changes nothing and never rejects
  const s2 = scene(t, 'refused');
  const down = await afterApply({ envelope: { ok: true, data: s2.data } }, null, s2.lane, { worker: fakeWorker(28103, { used: false, note: 'no o11 worker is up' }) });
  assert.deepEqual(down, { by: 'facade', used: false, note: 'no o11 worker is up' });
  assert.equal(slotModelPort(modelSha256(s2.delivered)), null);
  const s3 = scene(t, 'throws');
  const broken = await afterApply({ envelope: { ok: true, data: s3.data } }, null, s3.lane, { worker: { workerTarget: () => ({ port: 1 }), warmSpares: async () => { throw new Error('boom'); } } });
  assert.deepEqual(broken, { by: 'facade', used: false, note: 'boom' });
});

test('L3b nothing merged (refused, kept for review, no delivered snapshot): no spare is asked', async t => {
  const s = scene(t, 'none');
  const worker = fakeWorker(28104);
  assert.equal(await afterApply({ envelope: { ok: false, data: { ...s.data, delivered: false } } }, null, s.lane, { worker }), null);
  assert.equal(await afterApply({ envelope: { ok: true, data: { ...s.data, deliveredSnapshot: undefined } } }, null, s.lane, { worker }), null);
  assert.equal(await afterApply({ envelope: { ok: true, data: s.data } }, null, { ...s.lane, local: null }, { worker }), null);
  assert.equal(await afterApply(null, null, s.lane, { worker }), null);
  assert.equal(worker.calls.length, 0);
});

test('L3b the next build copies the delivered capture (the model the worker prepares), never captures again', async t => {
  const s = scene(t, 'next');
  await afterApply({ envelope: { ok: true, data: s.data } }, null, s.lane, { worker: fakeWorker(28105, { used: false, note: 'x' }) });
  const model = modelSha256(s.delivered);
  const calls = [];
  const bridge = () => ({ async ok(method) { calls.push(method); if (method === 'list_open_modules') return { modules: [{ name: 'App', key: 'K', hasESpace: true, modelSha256: model }] }; throw new Error('a capture: ' + method); } });
  const shot = await captureByKey('App', { bridge, local: s.local });
  assert.deepEqual(shot.reused, { from: path.resolve(s.delivered), modelSha256: model });
  assert.equal(shot.modelSha256, model);
  assert.deepEqual(calls, ['list_open_modules']);
});

// S9: the build phase of a draft's delivery takes the candidate of the draft's joint check (withCheckedCandidate) when the
// capture it takes has the model the check ran on, the job is the JSON the check applied and the producers are the same:
// no `anvil apply` runs (one apply fewer). Anything else builds as always and the offer says why. The build pool prefers the
// slot whose worker holds the model. Fake bridges and a fake kernel runner only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildBeforeApply, withCheckedCandidate, slotPort, PREBUILT_SCHEMA } from '../o11-build-phase.mjs';
import { modelSha256 } from '../o11-capture-store.mjs';
import { createBuildPool, rememberSlotModel, slotModelPort } from '../build-pool.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-build-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const oml = (header, model) => { const head = Buffer.from(header); const length = Buffer.alloc(4); length.writeUInt32LE(head.length); return Buffer.concat([Buffer.from('OML'), length, head, Buffer.from(model)]); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const JOB = { ops: [{ op: 'logic', data: { flow: ['server action A\n  end\n'] } }] };

// A module open in a tab (its capture has `model`), a draft's check of `checkJob` on a capture of `checkModel`, and a kernel
// runner that counts the applies it runs.
function scene(t, { model = 'MODEL-1', checkModel = model, job = JOB, checkJob = job, poolSize = 1, via } = {}) {
  const root = tmp(t);
  const lane = { local: path.join(root, 'local'), work: path.join(root, 'work'), name: 'ss4' };
  const deliveryJob = path.join(root, 'inline', 'delivery.json');
  fs.mkdirSync(path.dirname(deliveryJob), { recursive: true }); fs.writeFileSync(deliveryJob, JSON.stringify(job, null, 2) + '\n');
  const check = path.join(root, 'check');
  fs.mkdirSync(check, { recursive: true });
  const base = path.join(check, 'capture.oml'); fs.writeFileSync(base, oml('{check capture}', checkModel));
  const appliedJob = path.join(check, 'job.json'); fs.writeFileSync(appliedJob, JSON.stringify(checkJob, null, 2));
  const candidate = path.join(check, 'candidate.oml'); fs.writeFileSync(candidate, oml('{candidate}', checkModel + '+job'));
  const result = path.join(check, 'candidate.kernel-result.json');
  fs.writeFileSync(result, JSON.stringify({ isValid: true, accepted: true, sources: [{ path: appliedJob, sha256: sha(fs.readFileSync(appliedJob)) }], provenance: { kernelSha256: 'k' },
    hot: { reused: true, reason: 'spare', savedMs: 900, modelSha256: modelSha256(base) } }));
  const offer = { module: 'App', jobSha256: 'j', candidate: { path: candidate, sha256: sha(fs.readFileSync(candidate)), result, job: appliedJob, base, baseSha256: sha(fs.readFileSync(base)),
    baseModelSha256: modelSha256(base), producers: {}, via: 'worker' } };
  const studio = { calls: [], async ok(method, params = {}) {
    this.calls.push(method);
    if (method === 'list_open_modules') return { modules: [{ name: 'App', key: 'K', hasESpace: true }] };
    if (method === 'snapshot_module') { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, oml('{window}', model)); return { path: params.path, key: 'K' }; }
    throw new Error('a Studio write: ' + method);
  } };
  const applies = [];
  const buildRunner = slot => async argv => {
    applies.push({ argv, slot: slot.index });
    const out = argv[argv.indexOf('--out') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, oml('{built}', model + '+job')); fs.writeFileSync(out.replace(/\.oml$/i, '.result.json'), '{}');
    return { envelope: { ok: true, data: { isValid: true, accepted: true } }, wallMs: 5000, ...(via ? { via } : {}) };
  };
  const ctx = { root, env: {}, now: () => new Date(), bridge: () => studio, buildPool: createBuildPool({ dir: path.join(root, 'pool'), size: poolSize }), buildRunner };
  const deps = { o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4', connection: () => null };
  const build = (input = { module: 'App' }, withOffer = offer) => withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'App', job: deliveryJob }, lane: 'o11', deps, phased: true },
    () => (withOffer ? withCheckedCandidate(withOffer, () => buildBeforeApply({ input, job: deliveryJob, ctx, lane, task: { id: 'T1' } }))
      : buildBeforeApply({ input, job: deliveryJob, ctx, lane, task: { id: 'T1' } })));
  return { root, ctx, lane, offer, applies, build, deliveryJob, base, candidate, appliedJob, model: modelSha256(base) };
}

test('S9 the checked candidate of the same model becomes the prebuilt manifest: no apply runs (one apply fewer)', async t => {
  const without = scene(t);
  await without.build({ module: 'App' }, null);
  assert.equal(without.applies.length, 1, 'without the offer: the build applies');

  const s = scene(t);
  const built = await s.build();
  assert.equal(s.applies.length, 0, 'with the offer: no apply');
  assert.deepEqual(built.args, ['--prebuilt', built.manifest]);
  assert.deepEqual(s.offer.outcome, { reused: true, from: 'check', manifest: built.manifest, via: 'worker' });
  const manifest = read(built.manifest);
  // What PrebuiltCandidate reads: the delivery's job, the check's base (the same model), the candidate and its result.
  for (const field of ['schema', 'job', 'base', 'baseSha256', 'candidate', 'candidateSha256', 'result', 'producers']) assert.ok(field in manifest, field);
  assert.equal(manifest.schema, PREBUILT_SCHEMA);
  assert.equal(manifest.job, s.deliveryJob);
  assert.equal(manifest.base, s.base); assert.equal(manifest.baseModelSha256, s.model);
  assert.equal(manifest.candidateSha256, sha(fs.readFileSync(s.candidate)), 'the check\'s candidate, copied');
  assert.notEqual(path.resolve(manifest.candidate), path.resolve(s.candidate), 'into the build folder');
  const result = read(manifest.result);
  assert.deepEqual(result.sources, [{ path: path.resolve(s.deliveryJob), sha256: sha(fs.readFileSync(s.deliveryJob)) }], 'the sources name the job the delivery runs');
  assert.equal(result.provenance.kernelSha256, 'k', 'the kernel that built it, for its own check');
  assert.equal(manifest.checked.candidate, s.candidate); assert.equal(manifest.checked.via, 'worker');
  assert.equal(manifest.hot.identity.same, true);
});

test('S9 a capture of another model, another job, other producers or a patched delivery build as always, and the offer says why', async t => {
  const cases = [
    [{ checkModel: 'MODEL-0' }, {}, 'capture-changed'],
    [{ checkJob: { ops: [{ op: 'logic', data: { flow: ['server action B\n  end\n'] } }] } }, {}, 'job-differs'],
    [{}, { producers: { Lib: path.join(os.tmpdir(), 'lib.oml') } }, 'producers-differ'],
    [{}, { [Symbol('basedOnJob')]: 'C:/earlier.json' }, 'patched-delivery'],
    [{}, { module: 'Other' }, 'other-module'],
  ];
  for (const [options, extra, reason] of cases) {
    const s = scene(t, options);
    const built = await s.build({ module: 'App', ...extra });
    if (reason === 'other-module') { assert.equal(s.offer.outcome, undefined, 'no tab of that module: no build phase'); continue; }
    assert.equal(s.applies.length, 1, reason + ': the build applies');
    assert.equal(s.offer.outcome.reused, false); assert.equal(s.offer.outcome.reason, reason);
    assert.deepEqual(read(built.manifest).checkedCandidate, s.offer.outcome, 'the manifest keeps why');
  }
  const changed = scene(t, { checkModel: 'MODEL-0' });
  await changed.build();
  assert.equal(changed.offer.outcome.checkedModelSha256, sha(Buffer.from('MODEL-0')));
  assert.equal(changed.offer.outcome.captureModelSha256, sha(Buffer.from('MODEL-1')));
});

test('S9 a candidate changed or a check not accepted is never delivered', async t => {
  const s = scene(t);
  fs.appendFileSync(s.candidate, 'x');
  await s.build();
  assert.equal(s.offer.outcome.reason, 'candidate-changed'); assert.equal(s.applies.length, 1);
  const r = scene(t);
  fs.writeFileSync(r.offer.candidate.result, JSON.stringify({ isValid: false, accepted: false, sources: [] }));
  await r.build();
  assert.equal(r.offer.outcome.reason, 'check-not-accepted'); assert.equal(r.applies.length, 1);
});

test('S9 affinity: a build prefers the free slot whose worker holds its model, and records the slot it ran on', async t => {
  const s = scene(t, { poolSize: 3, model: 'MODEL-AFF', via: 'worker' });
  const port2 = await slotPort(2, { root: s.root, env: {}, lane: 'ss4' });
  rememberSlotModel(s.model, { port: port2 });
  await s.build({ module: 'App' }, null);
  assert.equal(s.applies[0].slot, 2, 'the slot of the worker that holds the model');
  const other = scene(t, { poolSize: 3, model: 'MODEL-NEW', via: 'worker' });
  await other.build({ module: 'App' }, null);
  assert.equal(other.applies[0].slot, 0, 'no affinity: the first free slot');
  assert.equal(slotModelPort(other.model), await slotPort(0, { root: other.root, env: {}, lane: 'ss4' }), 'the slot it ran on is remembered');
});

test('S9 the pool takes a preferred slot only when it is free: affinity never makes a build wait', async t => {
  const pool = createBuildPool({ dir: path.join(tmp(t), 'pool'), size: 3, queueMs: 5000 });
  let release;
  const holding = pool.run({ customer: 'a', prefer: [2] }, async slot => { await new Promise(resolve => { release = resolve; }); return slot.index; });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  const second = await pool.run({ customer: 'b', prefer: [2] }, async (slot, queue) => ({ index: slot.index, queue }));
  assert.notEqual(second.index, 2); assert.equal(second.queue, null, 'it did not queue');
  assert.ok(Date.now() - started < 1000);
  release();
  assert.equal(await holding, 2);
});

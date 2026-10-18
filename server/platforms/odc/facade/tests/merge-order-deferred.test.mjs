// The merge order of a delivery, planned headless by the kernel and delivered as two plain merges (2026-10-08 defect).
// An entity whose mandatory Identifier attribute has a default (Trail.DifficultyId = Entities.Difficulty.Easy) failed
// live with native_error: the bridge v45's NativeMergeOrder.Prepare built its first-pass copy in a transaction that threw
// NullReferenceException inside ODC Studio 1.7.27. The bridge is not changed: the facade never hands it a merge with a
// deferred default. Merge 1 is the candidate without those defaults (it creates the elements), merge 2 the full candidate
// over the module captured after merge 1 (the defaults land on existing elements); the bridge's own plan is empty both
// times, so Prepare returns before its transaction.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deliverKernel, planMergeOrderKernel, kernelCli } from '../kernel-delivery.mjs';
import { anvilRoot } from '../workspace.mjs';

const exec = promisify(execFile);
const DEFERRED = [{ key: 'k1', objectKey: 'k1', element: 'Trail.DifficultyId', property: 'DefaultValue', value: 'Entities.Difficulty.Easy', baseValue: null }];

// A fake bridge that records each merge with the manifest it receives; a planner that defers DEFERRED (or nothing).
function fixture(t, { deferred = DEFERRED, refuse = {}, planner } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-merge-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [], merges = [], manifests = [], published = [];
  let snapshots = 0, merged = 0;
  const input = { module: 'Fixture', feature: 'trail', job: 'job.json', owners: ['Data'], changes: ['Entity Trail'] };
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, guide: null,
    studio: async ([step, arg]) => {
      calls.push(step);
      if (step === 'snapshot') { snapshots++; return refuse.snapshot === snapshots ? { ok: false, error: 'snapshot refused' } : { ok: true, path: 'base-' + snapshots + '.oml', sha256: 'HASH' + snapshots, host: 'fixture.test' }; }
      if (step === 'merge') {
        merged++; merges.push(arg);
        if (refuse.merge === merged) return { ok: false, gate: 'test_gate', error: 'refused merge ' + merged };
        return { ok: true, merged: true, strictlyEqual: true };
      }
      return { ok: true };
    },
    apply: async () => { calls.push('apply'); return { ok: true, candidate: path.join(root, 'attempt', 'kernel-candidate.oml'), receipt: 'kernel-result.json' }; },
    prepareManifest: async ({ base, candidate, output }) => {
      calls.push('manifest'); const manifest = path.join(output, 'manifest.json'); manifests.push({ base, candidate, manifest });
      return refuse.manifest === manifests.length ? { ok: false, error: 'invalid candidate' } : { ok: true, manifest };
    },
    mergeOrder: planner ?? (async ({ base, candidate, output }) => {
      calls.push('merge-order');
      return { ok: true, deferred, firstPass: deferred.length ? path.join(output, 'merge-order-first-pass.oml') : null, plannedFrom: { base, candidate } };
    }),
    publishStep: async ({ manifest }) => { calls.push('publish'); published.push(manifest); return { publish: { requested: true, outcome: 'published' } }; },
    grants: null,
  };
  return { root, input, deps, calls, merges, manifests, published };
}

test('a candidate with a deferred default is delivered in two merges of one call, each with an empty bridge plan', async t => {
  const f = fixture(t);
  const result = await deliverKernel({ ...f.input, pid: 7 }, f.deps);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.merged, true); assert.equal(result.result, 'delivered');
  assert.deepEqual(f.calls, ['snapshot', 'apply', 'merge-order', 'manifest', 'merge', 'snapshot', 'manifest', 'merge', 'status']);
  // Merge 1: the first-pass candidate (no deferred default) over the first capture; merge 2: the full candidate over the
  // module captured after merge 1.
  const out = result.evidence;
  assert.deepEqual(f.manifests.map(m => [m.base, m.candidate]), [
    ['base-1.oml', path.join(out, 'merge-order-first-pass.oml')],
    ['base-2.oml', path.join(out, 'kernel-candidate.oml')]]);
  assert.deepEqual(f.merges, f.manifests.map(m => m.manifest));
  assert.equal(result.manifest, f.manifests[1].manifest);
  assert.deepEqual(result.mergeOrder.passes, 2);
  assert.deepEqual(result.mergeOrder.deferred, ['Trail.DifficultyId']);
  assert.equal(result.mergeOrder.firstPass.manifest, f.manifests[0].manifest);
  assert.deepEqual(result.steps.filter(s => s.pass).map(s => s.step + ':' + s.pass), ['merge:1', 'snapshot:2', 'build:2', 'merge:2']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'merge-order.json'), 'utf8')).deferred[0].element, 'Trail.DifficultyId');
});

test('a candidate without deferred defaults is still one merge, and the answer has no merge order', async t => {
  const f = fixture(t, { deferred: [] });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true);
  assert.equal(f.merges.length, 1);
  assert.equal(f.manifests[0].candidate, path.join(result.evidence, 'kernel-candidate.oml'));
  assert.equal(result.mergeOrder, undefined);
  assert.deepEqual(f.calls, ['snapshot', 'apply', 'merge-order', 'manifest', 'merge', 'status']);
});

test('the merge order is planned only for a merge: a review (until preview) keeps the full candidate', async t => {
  const f = fixture(t);
  const result = await deliverKernel({ ...f.input, until: 'preview' }, f.deps);
  assert.equal(result.ok, true);
  assert.ok(!f.calls.includes('merge-order'));
  assert.equal(f.manifests.length, 1);
});

test('a plan the kernel cannot compute keeps the single merge of before and says so', async t => {
  const f = fixture(t, { planner: async () => { throw new Error('comando desconhecido: merge-order'); } });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true);
  assert.equal(f.merges.length, 1);
  assert.equal(result.mergeOrder.passes, 1);
  assert.match(result.mergeOrder.skipped, /merge-order/);
});

test('publication follows pass 2 only, with the full candidate\'s manifest', async t => {
  const f = fixture(t);
  const result = await deliverKernel({ ...f.input, publish: true, authorize: 'pode publicar o Fixture' }, f.deps);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.calls.slice(-2), ['merge', 'publish']);
  assert.deepEqual(f.published, [f.manifests[1].manifest]);
  const refused = fixture(t, { refuse: { merge: 2 } });
  const failed = await deliverKernel({ ...refused.input, publish: true, authorize: 'pode publicar o Fixture' }, refused.deps);
  assert.equal(failed.ok, false); assert.ok(!refused.calls.includes('publish'));
  assert.deepEqual(failed.publish, { requested: true, outcome: 'skipped' });
});

test('a refused pass 1 names the pass and merges nothing more', async t => {
  const f = fixture(t, { refuse: { merge: 1 } });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false); assert.equal(result.failed, 'merge');
  assert.equal(result.mergeOrder.failedPass, 1);
  assert.match(result.error, /^Merge order pass 1 of 2/);
  assert.equal(f.merges.length, 1); assert.equal(result.merged, false);
});

for (const [where, refuse] of [['merge', { merge: 2 }], ['snapshot', { snapshot: 2 }], ['build', { manifest: 2 }]])
  test('a refused pass 2 (' + where + ') keeps merged:true, names the pass and continues with the repair job', async t => {
    const f = fixture(t, { refuse });
    const result = await deliverKernel({ ...f.input, pid: 7 }, f.deps);
    assert.equal(result.ok, false); assert.equal(result.failed, where);
    assert.equal(result.merged, true);
    assert.equal(result.mergeOrder.failedPass, 2);
    assert.match(result.error, /^Merge order pass 2 of 2/);
    assert.match(result.error, /Trail\.DifficultyId = Entities\.Difficulty\.Easy/);
    const repair = { ops: [{ op: 'set', target: '@k1', prop: 'DefaultValue', value: 'Entities.Difficulty.Easy' }] };
    assert.deepEqual(result.repair, repair);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.repairJob, 'utf8')), repair);
    assert.equal(result.continuation.tool, 'studio_deliver');
    assert.equal(result.continuation.arguments.job, result.repairJob);
    assert.equal(result.continuation.arguments.pid, 7);
  });

// The real kernel (anvil-odc merge-order) over a neutral equivalent of the live job: a static entity and an entity whose
// mandatory Identifier attribute has a default. The bridge's plan for each merge it receives (base of the manifest,
// candidate of the manifest) is read by the same kernel: empty both times.
const cli = kernelCli();
const fixtureBase = path.join(anvilRoot, 'tests', 'fixtures', 'odc', 'blank-mobile.oml');
const studioDir = process.env.ANVIL_ODC_STUDIO_DIR ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'OutSystems', 'ODC Studio', 'ODC Studio');
const realKernel = fs.existsSync(cli) && fs.existsSync(fixtureBase) && fs.existsSync(path.join(studioDir, 'OutSystems.Model.dll'));
const TRAIL_JOB = { ops: [{ op: 'spec', data: {
  static: [{ name: 'Difficulty', public: true, records: [{ name: 'Easy', id: 1 }, { name: 'Hard', id: 2 }] }],
  entities: [{ name: 'Trail', attributes: [{ name: 'Name', type: 'Text', mandatory: true, length: 100 },
    { name: 'DifficultyId', type: 'Difficulty Identifier', mandatory: true, default: 'Entities.Difficulty.Easy' },
    { name: 'IsActive', type: 'Boolean', default: 'True' }] }] } }] };

test('the real kernel defers the Identifier default, and the bridge plan of both merges is empty', { skip: !realKernel && 'ODC kernel CLI or ODC Studio not available', timeout: 300000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-merge-order-kernel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = path.join(root, 'trail.json'); fs.writeFileSync(job, JSON.stringify(TRAIL_JOB));
  const full = path.join(root, 'kernel-candidate.oml');
  const applied = JSON.parse((await exec('dotnet', [cli, 'apply', '--job', job, '--base', fixtureBase, '--out', full, '--work', path.join(root, 'work')],
    { cwd: path.dirname(cli), windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout);
  assert.equal(applied.ok, true, applied.error);
  const plan = (base, candidate, name) => { const output = path.join(root, name); fs.mkdirSync(output); return planMergeOrderKernel({ base, candidate, output }, { worker: null }); };
  const order = await plan(fixtureBase, full, 'plan');
  assert.equal(order.ok, true, order.error);
  assert.deepEqual(order.deferred.map(d => d.element + ' = ' + d.value), ['Trail.DifficultyId = Entities.Difficulty.Easy']);
  assert.ok(fs.existsSync(order.firstPass));
  // Merge 1 (first pass over the capture): no default left to defer, so the bridge's Prepare returns early.
  const first = await plan(fixtureBase, order.firstPass, 'merge-1');
  assert.equal(first.ok, true, first.error); assert.deepEqual(first.deferred, []); assert.equal(first.firstPass, null);
  // Merge 2 (full candidate over the module after merge 1, whose elements are the first pass's): empty again.
  const second = await plan(order.firstPass, full, 'merge-2');
  assert.equal(second.ok, true, second.error); assert.deepEqual(second.deferred, []); assert.equal(second.firstPass, null);
  // The delivery hands the bridge exactly those two manifests.
  const manifests = [];
  let snapshots = 0;
  const result = await deliverKernel({ module: 'Fixture', feature: 'trail', job, owners: ['Data'], changes: ['Entity Trail'], output: path.join(root, 'attempt') }, {
    root, journal: () => {}, guide: null, nextLabDir: () => path.join(root, 'unused'),
    studio: async ([step]) => step === 'snapshot' ? { ok: true, path: ++snapshots === 1 ? fixtureBase : order.firstPass, sha256: 'H' + snapshots, host: 'fixture.test' }
      : step === 'merge' ? { ok: true, merged: true, strictlyEqual: true } : { ok: true },
    apply: async ({ output }) => { fs.copyFileSync(full, path.join(output, 'kernel-candidate.oml')); return { ok: true, candidate: path.join(output, 'kernel-candidate.oml') }; },
    mergeOrder: args => planMergeOrderKernel(args, { worker: null }),
    prepareManifest: async ({ base, candidate, output }) => { manifests.push({ base, candidate }); return { ok: true, manifest: path.join(output, 'manifest.json') }; },
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.mergeOrder.deferred, ['Trail.DifficultyId']);
  assert.equal(manifests.length, 2);
  for (const [i, m] of manifests.entries()) {
    const bridgePlan = await plan(m.base, m.candidate, 'bridge-' + i);
    assert.equal(bridgePlan.ok, true, bridgePlan.error); assert.deepEqual(bridgePlan.deferred, [], 'merge ' + (i + 1) + ' would reach NativeMergeOrder.Prepare\'s transaction');
  }
});

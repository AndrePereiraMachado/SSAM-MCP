// L3b (spare pós-merge, ODC): the ODC delivery merges through the bridge, whose receipt carries the module after the merge
// (afterSnapshot, with its sha256 and author). A delivered merge records it as a known snapshot of the module (the bridge's
// name and sidecar, next to the delivery's capture) and asks the ODC worker for its spare under that author, with the
// capture's content identity; a delivery that did not merge asks nothing. A simulated bridge and a fake worker client.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel } from '../kernel-delivery.mjs';
import { afterOdcMerge } from '../odc-build-phase.mjs';
import { odcWarmCaptures } from '../warm-modules.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const content = file => 'c0' + sha(fs.readFileSync(file)).toLowerCase().slice(2);   // a stand-in content identity of the file

// The delivery of kernel-delivery.test.mjs, with a bridge that captures and merges like the real one: the capture is
// <snapshots>/<module>-<sha>.oml, the merge writes the module after it to its evidence and answers afterSnapshot.
function scene(t, { mergeAnswer = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-spare-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshots = path.join(root, 'snapshots'), evidence = path.join(root, 'bridge-evidence');
  fs.mkdirSync(snapshots); fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const before = Buffer.from('OML module before ' + root), afterBytes = Buffer.from('OML module after ' + root);
  const base = path.join(snapshots, 'Fixture-' + sha(before) + '.oml'); fs.writeFileSync(base, before);
  fs.writeFileSync(base + '.json', JSON.stringify({ ok: true, module: 'Fixture', sha256: sha(before), path: base, capturedAt: '2026-10-24T21:00:00.000Z', developerId: 'author@fixture.test' }));
  const after = path.join(evidence, 'after-merge.oml');
  const calls = [], warms = [], afterMerges = [];
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, signatureCache: null, check: null, mergeOrder: null, guide: null,
    studio: async ([step]) => {
      calls.push(step);
      if (step === 'snapshot') return { ok: true, path: base, sha256: sha(before), host: 'fixture.test', moduleKey: 'module-key', developerId: 'author@fixture.test', module: 'Fixture' };
      if (step === 'merge') {
        if (mergeAnswer.ok === false) return mergeAnswer;
        fs.writeFileSync(after, afterBytes);
        return { ok: true, merged: true, strictlyEqual: true, module: 'Fixture', sha256: sha(afterBytes), afterSnapshot: after, developerId: 'author@fixture.test', ...mergeAnswer };
      }
      return { ok: true };
    },
    apply: async () => { calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => { calls.push('manifest'); return { ok: true, manifest: 'manifest.json' }; },
    afterMerge: args => { const done = afterOdcMerge(args, { contentOf: async s => content(s.path), now: () => new Date('2026-10-24T22:00:00Z'),
      warmSpares: async (lane, request, options) => { warms.push({ lane, request, options }); return { used: true, port: 4547, wanted: [{ wanted: true }] }; } }); afterMerges.push(done); return done; },
  };
  const input = { module: 'Fixture', feature: 'odc-spare', job: 'job.json', owners: ['Screen'], changes: ['Change screen'] };
  return { root, snapshots, base, after, afterBytes, calls, warms, afterMerges, deps, input };
}

test('L3b a delivered ODC merge records the module after it and asks the worker for its spare with the delivered sha256 and author', async t => {
  const s = scene(t);
  const result = await deliverKernel(s.input, s.deps);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.merged, true);
  assert.equal(s.afterMerges.length, 1);
  const done = await s.afterMerges[0];
  const known = path.join(s.snapshots, 'Fixture-' + sha(s.afterBytes) + '.oml');
  assert.deepEqual(done, { known, sha256: sha(s.afterBytes), contentSha256: content(known), warm: { used: true, port: 4547, wanted: [{ wanted: true }] } });
  // the known capture is the bridge's bytes, under the bridge's name, with its sidecar
  assert.equal(sha(fs.readFileSync(known)), sha(s.afterBytes));
  const sidecar = JSON.parse(fs.readFileSync(known + '.json', 'utf8'));
  assert.deepEqual(sidecar, { ok: true, module: 'Fixture', moduleKey: 'module-key', sha256: sha(s.afterBytes), path: known, capturedAt: '2026-10-24T22:00:00.000Z',
    developerId: 'author@fixture.test', host: 'fixture.test', contentSha256: content(known), source: 'after-merge' });
  // the warm: the ODC worker, the delivered capture with its content identity, superseding the capture before the merge, the author
  assert.deepEqual(s.warms, [{ lane: 'odc', options: {}, request: { developerId: 'author@fixture.test',
    captures: [{ path: known, contentSha256: content(known), supersedes: path.resolve(s.base) }] } }]);
  // and the startup warm-up now finds it as the newest snapshot of the module, with its author
  const found = odcWarmCaptures({ odcRoot: s.root });
  assert.equal(found.captures[0].path, known); assert.equal(found.captures[0].developerId, 'author@fixture.test');
});

test('L3b a refused or uncertain ODC merge asks nothing and records nothing', async t => {
  for (const mergeAnswer of [{ ok: false, gate: 'test_gate', error: 'refused merge' }, { strictlyEqual: false }]) {
    const s = scene(t, { mergeAnswer });
    const result = await deliverKernel(s.input, s.deps);
    assert.equal(result.ok, false);
    assert.equal(s.afterMerges.length, 0);
    assert.deepEqual(s.warms, []);
    assert.deepEqual(fs.readdirSync(s.snapshots).sort(), [path.basename(s.base), path.basename(s.base) + '.json']);
  }
  // until preview never merges
  const s = scene(t);
  const preview = await deliverKernel({ ...s.input, until: 'preview' }, s.deps);
  assert.equal(preview.ok, true); assert.equal(s.afterMerges.length, 0); assert.deepEqual(s.warms, []);
});

test('L3b afterOdcMerge: nothing merged, no file or an unsafe name is null; a worker that does not take it changes nothing else', async t => {
  const s = scene(t);
  const snapshot = { path: s.base, host: 'fixture.test', moduleKey: 'module-key', developerId: 'author@fixture.test' };
  fs.writeFileSync(s.after, s.afterBytes);
  const never = { warmSpares: async () => { throw new Error('never asked'); }, contentOf: async () => null };
  assert.equal(await afterOdcMerge({ merge: { merged: false, afterSnapshot: s.after }, snapshot, module: 'Fixture' }, never), null);
  assert.equal(await afterOdcMerge({ merge: { merged: true }, snapshot, module: 'Fixture' }, never), null);
  assert.equal(await afterOdcMerge({ merge: { merged: true, afterSnapshot: path.join(s.root, 'gone.oml') }, snapshot, module: 'Fixture' }, never), null);
  assert.equal(await afterOdcMerge({ merge: { merged: true, afterSnapshot: s.after, module: '..\\Other' }, snapshot }, never), null);
  assert.equal(await afterOdcMerge({ merge: { merged: true, afterSnapshot: s.after }, snapshot: { ...snapshot, path: 'relative.oml' }, module: 'Fixture' }, never), null);
  // the worker is down: the capture is still known; a warm that throws is null, never a throw
  const down = await afterOdcMerge({ merge: { merged: true, afterSnapshot: s.after, sha256: sha(s.afterBytes) }, snapshot, module: 'Fixture' },
    { contentOf: async () => null, warmSpares: async () => ({ used: false, note: 'no odc worker is up' }) });
  assert.deepEqual(down.warm, { used: false, note: 'no odc worker is up' });
  assert.ok(fs.existsSync(down.known));
  assert.equal(await afterOdcMerge({ merge: { merged: true, afterSnapshot: s.after }, snapshot, module: 'Fixture' }, { contentOf: async () => null, warmSpares: async () => { throw new Error('boom'); } }), null);
});

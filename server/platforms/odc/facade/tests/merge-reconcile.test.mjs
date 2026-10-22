// Friction ef7de23f-58ea-4880-97c2-07ee184593d0 (2026-10-21, a customer delivery): a merge that ran and was
// integrated, but whose native equivalence stayed uncertain, left no receipt.json; studio_publish {module} refused with
// LAST_DELIVERY_NOT_CLEAN and no call of the MCP lifted it. The family rule (merge-reconcile.mjs): the SSAM's content proof
// of a capture of the open module against the delivery candidate reconciles it, automatically in studio_publish and in
// studio_deliver, and through ONE explicit call (studio_publish {module, reconcile:true}); never without the proof, never
// by a second merge. Offline: a temporary lab with the bridge's evidence shapes, a fake bridge and a fake prover.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishWithGrant, publishPrecheck } from '../studio-publish-log.mjs';
import { mergeState, reconcileMerge, RECONCILIATION_SCHEMA } from '../merge-reconcile.mjs';
import { deliverKernel } from '../kernel-delivery.mjs';

const TENANT = 'personal-test.outsystems.dev';
const WORDS = 'pode publicar o OrderPortal agora';
const PID = 5150;
const CANDIDATE_SHA = '05521C765DE26695B1DC3F68398A2319E027F448F73C76E506B46763341D2F33';
const CAPTURE_SHA = '6121031D807994566E263C8A1D7BD35DEA632A54233C6EB35E026B3E4ED95939';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lab: path.join(root, 'lab') };
}

// One delivery whose merge ran (merge-started.json, native-return.json) and ended as `receipt` says.
function delivery(lab, name, { receipt = 'none', pid = PID, divergences = [{ Element: 'MainFlow/Options', Kind: 'Screen', Property: 'Screen Content', Local: 'The Screen content has changed', Candidate: '' }] } = {}) {
  const dir = path.join(lab, name); const manifestDir = path.join(dir, 'delivery'); const evidence = path.join(manifestDir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const candidatePath = path.join(manifestDir, 'candidate.oml'); fs.writeFileSync(candidatePath, 'candidate bytes');
  const manifest = path.join(manifestDir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'FEATURE-1', module: 'OrderPortal', moduleKey: 'k-op', tenant: TENANT, owners: ['Options'],
    changes: ['Configure carrier limits'], candidatePath, candidateSha256: CANDIDATE_SHA, evidenceDir: evidence }, null, 2));
  fs.writeFileSync(path.join(dir, 'deliver-result.json'), JSON.stringify({ ok: false, code: 'MERGE_UNCERTAIN', outcome: 'uncertain', merged: true, module: 'OrderPortal', feature: 'FEATURE-1',
    job: path.join(lab, '..', 'jobs', name + '.json'), divergences }));
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-22T00:00:41Z', pid, module: 'OrderPortal', baseSha256: 'B', candidateSha256: CANDIDATE_SHA, passes: 1, publishInvoked: false }));
  fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'MergeAndPublish', secondPass: null, publishInvoked: false }));
  if (receipt === 'normalized') fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, module: 'OrderPortal', equivalence: 'normalized', strictlyEqual: false, sha256: CAPTURE_SHA }));
  if (receipt === 'references') fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, module: 'OrderPortal', equivalence: null, strictlyEqual: false, sha256: CAPTURE_SHA, refreshedReferences: ['ProducerServices'] }));
  if (receipt === 'incomplete') fs.writeFileSync(path.join(evidence, 'incomplete-receipt.json'), JSON.stringify({ ok: false, merged: true, outcome: 'incomplete', module: 'OrderPortal' }));
  return { dir, manifest, evidence, candidatePath };
}

// The fake bridge: status, snapshot (the capture of the open module), authorize and publish; it never merges.
function bridge(box, { pid = PID, captureSha = CAPTURE_SHA, snapshot } = {}) {
  const calls = [];
  const capturePath = path.join(box.root, 'OrderPortal-' + captureSha + '.oml');
  fs.writeFileSync(capturePath, 'capture bytes');
  const studio = async args => {
    calls.push([...args]);
    if (args[0] === 'status') return { ok: true, pid, modules: [{ name: 'OrderPortal', key: 'k-op', host: TENANT, loggedIn: true }] };
    if (args[0] === 'snapshot') return snapshot ?? { ok: true, module: 'OrderPortal', moduleKey: 'k-op', sha256: captureSha, path: capturePath, capturedAt: '2026-10-22T00:20:00Z' };
    if (args[0] === 'authorize') return { ok: true };
    if (args[0] === 'publish') return { ok: true, module: 'OrderPortal', published: { revision: 430 }, completedAt: '2026-10-22T00:30:00Z' };
    return { ok: false, error: 'unexpected ' + args[0] };
  };
  return { studio, calls, capturePath };
}

// The fake prover: the shape of anvil-odc content-proof (MergeContentProof), bound to the sha256 of both inputs.
function prover({ differences = [], expectedSha = CANDIDATE_SHA, actualSha = CAPTURE_SHA, fail = null } = {}) {
  const runs = [];
  const prove = async input => {
    runs.push(input);
    if (fail) return { ok: false, error: fail };
    return { ok: true, proof: { schema: 'ssam-merge-content-proof/1', accepted: differences.length === 0, checked: 134021, differences,
      inputs: { expected: { path: input.expected, sha256: expectedSha.toLowerCase() }, actual: { path: input.actual, sha256: actualSha.toLowerCase() } },
      coverage: { complete: false, boundary: 'Public Model API content' } } };
  };
  return { prove, runs };
}

const deps = (box, b, p, extra = {}) => ({ studio: b.studio, readManifest: file => JSON.parse(fs.readFileSync(path.resolve(box.root, file), 'utf8')), lab: box.lab, root: box.root,
  catalog: () => null, grants: { findGrant: async () => null },
  ...(p ? { reconcile: (input, more = {}) => reconcileMerge(input, { studio: b.studio, prove: p.prove, ...more }) } : {}), ...extra });

test('studio_publish {module}: an uncertain merge whose content the SSAM proves is reconciled and published, never merged again', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '71-FEATURE-1');
  const b = bridge(box); const p = prover();
  const answer = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, p));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(b.calls.map(c => c[0]), ['status', 'snapshot', 'authorize', 'publish']);
  assert.ok(!b.calls.some(c => c[0] === 'merge' || c[0] === 'reconcile-merge'), 'never another merge');
  assert.deepEqual(p.runs, [{ expected: last.candidatePath, actual: b.capturePath }]);
  // The receipt the bridge's dispatch reads: the capture's own hash, the proof beside it.
  const receipt = JSON.parse(fs.readFileSync(path.join(last.evidence, 'receipt.json'), 'utf8'));
  assert.equal(receipt.ok, true); assert.equal(receipt.merged, true); assert.equal(receipt.sha256, CAPTURE_SHA);
  assert.equal(receipt.equivalence, 'content-proof'); assert.equal(receipt.strictlyEqual, false);
  const record = JSON.parse(fs.readFileSync(path.join(last.evidence, 'reconciliation.json'), 'utf8'));
  assert.equal(record.schema, RECONCILIATION_SCHEMA); assert.equal(record.accepted, true);
  assert.equal(record.proof.checked, 134021); assert.equal(record.capture.sha256, CAPTURE_SHA); assert.equal(record.candidate.sha256, CANDIDATE_SHA);
  assert.equal(record.nativeDivergences[0].Property, 'Screen Content');
  assert.equal(answer.resolvedFrom.reconciliation.accepted, true);
  assert.equal(mergeState(last.evidence).outcome, 'reconciled');
});

test('the proof finds differences: refused before anything, no receipt written, the differences and the correction named', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '71-FEATURE-1');
  const b = bridge(box);
  const p = prover({ differences: [{ address: 'MainFlow/Options/Title', property: 'api:Text', expected: 'Limits', actual: 'Limit' }] });
  const answer = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, p));
  assert.equal(answer.ok, false); assert.equal(answer.code, 'LAST_DELIVERY_NOT_CLEAN');
  assert.equal(answer.reconciliation.code, 'MERGE_CONTENT_MISMATCH');
  assert.equal(answer.reconciliation.differences[0].property, 'api:Text');
  // The refusal names each differing element and property in its text, never only a count.
  assert.match(answer.error, /MainFlow\/Options\/Title api:Text/);
  assert.equal(fs.existsSync(path.join(last.evidence, 'receipt.json')), false, 'never clean without the proof');
  assert.equal(answer.continuation.tool, 'ssam_evidence'); assert.equal(answer.continuation.arguments.pointer, '/proof/differences');
  assert.equal(answer.then.tool, 'studio_deliver');
  assert.deepEqual(b.calls.map(c => c[0]), ['status', 'snapshot'], 'nothing authorized or published');
});

test('a proof of another capture or another candidate is never accepted', async t => {
  for (const p of [prover({ actualSha: 'AAAA' }), prover({ expectedSha: 'BBBB' })]) {
    const box = sandbox(t);
    const last = delivery(box.lab, '71-FEATURE-1');
    const b = bridge(box);
    const answer = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, p));
    assert.equal(answer.code, 'LAST_DELIVERY_NOT_CLEAN'); assert.equal(answer.reconciliation.code, 'RECONCILE_PROOF_REFUSED');
    assert.equal(fs.existsSync(path.join(last.evidence, 'receipt.json')), false);
  }
});

test('the explicit call studio_publish {module, reconcile:true} reconciles without publishing and names the publication', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '71-FEATURE-1');
  const b = bridge(box); const p = prover();
  const answer = await publishWithGrant({ module: 'OrderPortal', reconcile: true, pid: PID }, deps(box, b, p));
  assert.equal(answer.ok, true, JSON.stringify(answer)); assert.equal(answer.reconciled, true); assert.equal(answer.publishInvoked, false);
  assert.deepEqual(b.calls.map(c => c[0]), ['status', 'snapshot']);
  assert.deepEqual(answer.continuation, { tool: 'studio_publish', arguments: { module: 'OrderPortal', pid: PID }, why: answer.continuation.why });
  assert.equal(mergeState(last.evidence).clean, true);
  // Again: already clean, nothing captured or proven again.
  const again = await publishWithGrant({ module: 'OrderPortal', reconcile: true, pid: PID }, deps(box, b, p));
  assert.equal(again.ok, true); assert.equal(again.reconciled, false); assert.equal(again.outcome, 'reconciled');
  assert.equal(p.runs.length, 1);
});

test('a bridge receipt normalized by the Studio is clean for studio_publish {module} (was a dead end: not-strict)', async t => {
  const box = sandbox(t);
  delivery(box.lab, '72-FEATURE-1', { receipt: 'normalized' });
  const b = bridge(box);
  const answer = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, null));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(b.calls.map(c => c[0]), ['status', 'authorize', 'publish']);
});

test('a non-strict bridge receipt is reconciled by the proof without rewriting the bridge receipt', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '72-FEATURE-1', { receipt: 'references' });
  const before = fs.readFileSync(path.join(last.evidence, 'receipt.json'), 'utf8');
  const b = bridge(box); const p = prover();
  const answer = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, p));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(fs.readFileSync(path.join(last.evidence, 'receipt.json'), 'utf8'), before, 'the bridge receipt stays as the bridge wrote it');
  assert.equal(mergeState(last.evidence).outcome, 'reconciled');
  // A capture of another model than the bridge receipt is a change after the merge.
  const box2 = sandbox(t);
  delivery(box2.lab, '72-FEATURE-1', { receipt: 'references' });
  const changed = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box2, bridge(box2, { captureSha: 'CCCC' }), prover({ actualSha: 'CCCC' })));
  assert.equal(changed.code, 'LAST_DELIVERY_NOT_CLEAN'); assert.equal(changed.reconciliation.code, 'MODULE_CHANGED_SINCE_DELIVERY');
});

test('never a dead end: without the reconciliation (read-only precheck) the refusal names studio_publish {module, reconcile:true}', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '71-FEATURE-1');
  const b = bridge(box);
  const checked = await publishPrecheck({ module: 'OrderPortal', pid: PID, openSha256: CAPTURE_SHA }, { studio: b.studio, lab: box.lab, root: box.root });
  assert.equal(checked.ok, false); assert.equal(checked.code, 'LAST_DELIVERY_NOT_CLEAN');
  assert.deepEqual(checked.continuation.arguments, { module: 'OrderPortal', reconcile: true, pid: PID }); assert.equal(checked.continuation.tool, 'studio_publish');
  assert.deepEqual(b.calls.map(c => c[0]), ['status'], 'the precheck writes and captures nothing');
  assert.deepEqual(fs.readdirSync(last.evidence).sort(), ['merge-started.json', 'native-return.json']);
});

test('known losses are never reconciled; a capture refused (merge pending) and a missing proof engine name the next call', async t => {
  const box = sandbox(t);
  delivery(box.lab, '70-FEATURE-1', { receipt: 'incomplete' });
  const b = bridge(box); const p = prover();
  const incomplete = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, p));
  assert.equal(incomplete.code, 'LAST_DELIVERY_NOT_CLEAN'); assert.equal(incomplete.outcome, 'incomplete');
  assert.deepEqual(b.calls.map(c => c[0]), ['status']); assert.equal(p.runs.length, 0);
  const box2 = sandbox(t);
  delivery(box2.lab, '71-FEATURE-1');
  const pending = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID },
    deps(box2, bridge(box2, { snapshot: { ok: false, error: 'Pending merge exists in OrderPortal; snapshot refused.' } }), p));
  assert.equal(pending.reconciliation.code, 'RECONCILE_CAPTURE_FAILED'); assert.equal(pending.continuation.tool, 'studio_status');
  const box3 = sandbox(t);
  delivery(box3.lab, '71-FEATURE-1');
  const engine = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box3, bridge(box3), prover({ fail: 'unknown command: content-proof' })));
  assert.equal(engine.reconciliation.code, 'RECONCILE_PROOF_UNAVAILABLE'); assert.equal(engine.continuation.tool, 'ssam_doctor');
  for (const answer of [incomplete, pending, engine]) assert.ok(answer.continuation?.tool, 'every refusal names its next call');
});

test('a merge made in another Studio process is not reconciled here', async t => {
  const box = sandbox(t);
  delivery(box.lab, '71-FEATURE-1', { pid: 999 });
  const b = bridge(box); const p = prover();
  const answer = await publishWithGrant({ module: 'OrderPortal', authorize: WORDS, pid: PID }, deps(box, b, p));
  assert.equal(answer.code, 'DELIVERY_IN_OTHER_STUDIO'); assert.equal(p.runs.length, 0);
});

// studio_deliver: the same rule right after the merge, so the delivery itself ends clean (and publish:true publishes).
function kernelDelivery(t, { proofDifferences = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-reconcile-deliver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [];
  const manifestDir = path.join(root, 'attempt', 'delivery');
  const candidatePath = path.join(manifestDir, 'candidate.oml');
  const capturePath = path.join(root, 'after.oml');
  const studio = async ([step]) => {
    calls.push(step);
    if (step === 'snapshot') {
      if (calls.includes('merge')) { fs.writeFileSync(capturePath, 'after'); return { ok: true, module: 'Fixture', moduleKey: 'K', path: capturePath, sha256: CAPTURE_SHA }; }
      return { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test', moduleKey: 'K' };
    }
    if (step === 'merge') {
      fs.mkdirSync(path.join(manifestDir, 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(manifestDir, 'evidence', 'merge-started.json'), JSON.stringify({ at: 'now', pid: PID, candidateSha256: CANDIDATE_SHA }));
      fs.writeFileSync(path.join(manifestDir, 'evidence', 'native-return.json'), JSON.stringify({ outcome: 'Merged', publishInvoked: false }));
      return { ok: false, outcome: 'uncertain', gate: 'equivalence', merged: true, error: 'Native object differs from the candidate: (Object Screen) Options [ChangedInLocal]. The merge ran and is already integrated in the open module (merged:true).' };
    }
    return { ok: true };
  };
  const p = prover({ differences: proofDifferences });
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {}, studio,
    apply: async () => { calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => {
      calls.push('manifest');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(candidatePath, 'candidate');
      const manifest = path.join(manifestDir, 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', moduleKey: 'K', candidatePath, candidateSha256: CANDIDATE_SHA, evidenceDir: path.join(manifestDir, 'evidence') }));
      return { ok: true, manifest };
    },
    reconcile: (input, more = {}) => reconcileMerge(input, { studio, prove: p.prove, ...more }) };
  return { calls, deps, p, input: { module: 'Fixture', feature: 'merge-reconcile', job: 'job.json', owners: ['Options'], changes: ['Change'] } };
}

test('studio_deliver: an uncertain merge proven by the content proof ends delivered (equivalence content-proof), never merged twice', async t => {
  const f = kernelDelivery(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true, JSON.stringify({ code: result.code, error: result.error }));
  assert.equal(result.result, 'delivered'); assert.equal(result.merged, true); assert.equal(result.equivalence, 'content-proof');
  assert.equal(result.code, undefined); assert.equal(result.failed, undefined);
  assert.equal(result.reconciliation.accepted, true);
  assert.equal(f.calls.filter(c => c === 'merge').length, 1);
  assert.ok(result.steps.some(s => s.step === 'reconcile' && s.ok === true));
});

test('studio_deliver: when the proof finds differences the merge stays uncertain, already integrated, with the differences', async t => {
  const f = kernelDelivery(t, { proofDifferences: [{ address: 'MainFlow/Options/Title', property: 'api:Text' }] });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false); assert.equal(result.code, 'MERGE_UNCERTAIN'); assert.equal(result.merged, true);
  assert.match(result.error, /already integrated/);
  assert.equal(result.reconciliation.code, 'MERGE_CONTENT_MISMATCH');
  assert.equal(f.calls.filter(c => c === 'merge').length, 1);
});

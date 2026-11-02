// U1 round 2 (REVISAO-U1 correction 2): a merge whose bridge verification never ran (bridge v106/v107: the tab did not start
// the verification's job, MergeNotVerifiedException and verification-not-started.json; or the active module changed,
// verification-refused.json) has had none of G-1/G-2 (errors and security warnings after the merge, a11-b) nor the stylesheet
// caches. A content proof alone must never make it delivered: the facade first asks the bridge for reconcile-merge (VerifyMerged
// on the merge that returned). Its receipt makes it clean; a security warning is the a11-b refusal; a verification that stays
// uncertain (MergeUncertain) goes on to the content proof as before; anything else is MERGE_UNCERTAIN, merged, never ok.
// Offline: the reviewer's harness (merge-reconcile.test.mjs shapes), a fake bridge and a fake prover.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileMerge, mergeState, bridgeVerificationPending } from '../merge-reconcile.mjs';
import { deliverKernel } from '../kernel-delivery.mjs';
import { SECURITY_CODE } from '../security-after-merge.mjs';

const PID = 5150;
const CANDIDATE_SHA = '05521C765DE26695B1DC3F68398A2319E027F448F73C76E506B46763341D2F33';
const CAPTURE_SHA = '6121031D807994566E263C8A1D7BD35DEA632A54233C6EB35E026B3E4ED95939';
const NOT_VERIFIED = 'The native merge of Fixture returned (native-return.json), but the Studio did not run its verification within 120 s: its tab did not become idle. The module holds the merge, not verified, and nothing was published. Never deliver it again: once studio_status names no busy command, studio_publish {module, reconcile:true} verifies it.';
const openRedirect = { key: 'k1', id: 'OpenRedirect', type: 'Warning', message: 'Open Redirect', detail: 'The URL of the redirect uses an input', ownerKey: 'k1', ownerPath: 'MainFlow/Home' };

function prover() {
  const runs = [];
  return { runs, prove: async input => { runs.push(input); return { ok: true, proof: { schema: 'ssam-merge-content-proof/1', accepted: true, checked: 10, differences: [],
    inputs: { expected: { path: input.expected, sha256: CANDIDATE_SHA.toLowerCase() }, actual: { path: input.actual, sha256: CAPTURE_SHA.toLowerCase() } }, coverage: { complete: false } } }; } };
}

// verify: what the bridge's reconcile-merge does with the evidence: 'refused' (verification again not started), 'strict' (receipt),
// 'security' (new-messages.json with a security warning, its refusal), 'uncertain' (MergeUncertain with divergences), 'not-allowed'.
function kernelDelivery(t, { verify = 'refused', marker = 'verification-not-started.json' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-not-verified-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [];
  const manifestDir = path.join(root, 'attempt', 'delivery'); const evidence = path.join(manifestDir, 'evidence');
  const candidatePath = path.join(manifestDir, 'candidate.oml');
  const capturePath = path.join(root, 'after.oml');
  const studio = async ([step]) => {
    calls.push(step);
    if (step === 'snapshot') {
      if (calls.includes('merge')) { fs.writeFileSync(capturePath, 'after'); return { ok: true, module: 'Fixture', moduleKey: 'K', path: capturePath, sha256: CAPTURE_SHA }; }
      return { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test', moduleKey: 'K' };
    }
    if (step === 'merge') {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: 'now', pid: PID, candidateSha256: CANDIDATE_SHA }));
      fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'Merged', publishInvoked: false }));
      fs.writeFileSync(path.join(evidence, marker), JSON.stringify({ merged: true, verified: false }));
      return { ok: false, outcome: 'uncertain', gate: 'studio_busy', merged: true, equal: false, equivalence: 'uncertain', error: NOT_VERIFIED };
    }
    if (step === 'reconcile-merge') {
      if (verify === 'strict') { fs.writeFileSync(path.join(evidence, 'new-messages.json'), '[]'); fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, module: 'Fixture', outcome: 'reconciled', sha256: CAPTURE_SHA, strictlyEqual: true, equivalence: 'strict' })); return { ok: true, merged: true, strictlyEqual: true, sha256: CAPTURE_SHA }; }
      if (verify === 'security') { fs.writeFileSync(path.join(evidence, 'new-messages.json'), JSON.stringify([openRedirect])); return { ok: false, outcome: 'gate_refused', gate: 'candidate_validation', error: 'New live validation diagnostics after merge: 1 (ids: OpenRedirect); new-messages.json names each owner and its addressableKey for ssam_map and studio_inspect.' }; }
      if (verify === 'uncertain') return { ok: false, outcome: 'gate_refused', gate: 'equivalence', error: 'Native object differs from the candidate', divergences: [{ Element: 'MainFlow/Home', Property: 'Screen Content' }] };
      if (verify === 'busy') return { ok: false, code: 'BRIDGE_BUSY', outcome: 'gate_refused', gate: 'studio_busy', executed: false, error: "Command 'publish' is still running since now; nothing of this call ran." };
      if (verify === 'not-allowed') { const error = new Error('The ODC bridge command "reconcile-merge" is not allowed on this agent'); error.code = 'COMMAND_NOT_ALLOWED'; throw error; }
      return { ok: false, outcome: 'gate_refused', gate: 'studio_busy', error: NOT_VERIFIED };
    }
    return { ok: true };
  };
  const p = prover();
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {}, studio,
    apply: async () => { calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => {
      calls.push('manifest');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(candidatePath, 'candidate');
      const manifest = path.join(manifestDir, 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', moduleKey: 'K', candidatePath, candidateSha256: CANDIDATE_SHA, evidenceDir: evidence }));
      return { ok: true, manifest };
    },
    reconcile: (input, more = {}) => reconcileMerge(input, { studio, prove: p.prove, ...more }) };
  return { calls, deps, p, evidence, input: { module: 'Fixture', feature: 'merge-not-verified', job: 'job.json', owners: ['Options'], changes: ['Change'] } };
}

test('the reviewer probe: a verification that never started is never "delivered" by the content proof alone', async t => {
  const f = kernelDelivery(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false, JSON.stringify({ ok: result.ok, result: result.result, equivalence: result.equivalence }));
  assert.equal(result.code, 'MERGE_UNCERTAIN');
  assert.equal(result.merged, true);
  assert.notEqual(result.result, 'delivered');
  assert.ok(f.calls.includes('reconcile-merge'), 'the bridge is asked to verify the merge first');
  assert.equal(f.p.runs.length, 0, 'no content proof without the bridge verification');
  assert.equal(result.reconciliation.code, 'MERGE_UNCERTAIN');
  assert.equal(f.calls.filter(c => c === 'merge').length, 1, 'never merged twice');
  assert.equal(fs.existsSync(path.join(f.evidence, 'receipt.json')), false, 'never clean');
});

test('the bridge verifies it (reconcile-merge writes its receipt): delivered by the bridge, not by a content proof', async t => {
  const f = kernelDelivery(t, { verify: 'strict' });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true, JSON.stringify({ code: result.code, error: result.error }));
  assert.equal(result.result, 'delivered'); assert.equal(result.equivalence, 'strict'); assert.equal(result.reconciliation.verifiedBy, 'bridge');
  assert.equal(f.p.runs.length, 0);
});

test('a11-b: the bridge verification finds a new security warning: the security refusal, never delivered nor published', async t => {
  const f = kernelDelivery(t, { verify: 'security' });
  const result = await deliverKernel({ ...f.input }, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, SECURITY_CODE);
  assert.equal(result.refusal.blocking[0].id, 'OpenRedirect');
  assert.equal(f.p.runs.length, 0, 'never the content proof of a merge that holds a security warning');
  assert.equal(mergeState(f.evidence).outcome, 'security');
});

test('a verification that stays uncertain (MergeUncertain) goes on to the content proof, as any uncertain merge', async t => {
  const f = kernelDelivery(t, { verify: 'uncertain' });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true, JSON.stringify({ code: result.code, error: result.error }));
  assert.equal(result.equivalence, 'content-proof');
  assert.equal(f.p.runs.length, 1);
  assert.ok(f.calls.indexOf('reconcile-merge') < f.calls.lastIndexOf('snapshot'), 'the bridge first');
});

test('the active module changed (verification-refused.json) is the same family; an agent without reconcile-merge names the update', async t => {
  const f = kernelDelivery(t, { marker: 'verification-refused.json' });
  assert.equal((await deliverKernel(f.input, f.deps)).code, 'MERGE_UNCERTAIN');
  assert.equal(f.p.runs.length, 0);
  const g = kernelDelivery(t, { verify: 'not-allowed' });
  const result = await deliverKernel(g.input, g.deps);
  assert.equal(result.code, 'MERGE_UNCERTAIN'); assert.equal(g.p.runs.length, 0);
  assert.match(result.reconciliation.error, /not allowed/);
});

// R2-1 (re-review): no difference is known when the bridge did not verify, so the delivery answers the reconciliation's own text
// and next call, never "differences remain unexplained" with an empty /divergences.
test('R2-1: the answer is the reconciliation refusal, its text and its next call, never unexplained differences', async t => {
  const cases = [
    { verify: 'refused', tool: 'studio_publish', check: c => assert.equal(c.arguments.reconcile, true) },
    { verify: 'busy', tool: 'studio_status', check: c => assert.match(c.why, /busy/) },
    { verify: 'not-allowed', tool: 'studio_status', check: c => assert.match(c.why, /update the agent package/) },
  ];
  for (const { verify, tool, check } of cases) {
    const f = kernelDelivery(t, { verify });
    const result = await deliverKernel({ ...f.input, publish: true, authorize: 'yes, deliver and publish Fixture now' }, f.deps);
    assert.equal(result.ok, false, verify); assert.equal(result.code, 'MERGE_UNCERTAIN', verify); assert.equal(result.merged, true, verify);
    assert.doesNotMatch(result.error, /differences from the candidate remain unexplained/, verify);
    assert.match(result.error, /the bridge did not verify it/, verify);
    assert.equal(result.continuation?.tool, tool, verify + ': ' + JSON.stringify(result.continuation));
    assert.notEqual(result.continuation?.arguments?.pointer, '/divergences', verify);
    check(result.continuation);
    assert.equal(result.publish?.outcome, 'skipped', verify);
    assert.ok(!f.calls.includes('publish'), verify + ': never published');
  }
});

test('bridgeVerificationPending: only a marker with nothing of the verification on record', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(bridgeVerificationPending(dir), false);
  fs.writeFileSync(path.join(dir, 'verification-not-started.json'), '{}');
  assert.equal(bridgeVerificationPending(dir), true);
  fs.writeFileSync(path.join(dir, 'new-messages.json'), '[]');
  assert.equal(bridgeVerificationPending(dir), false);
});

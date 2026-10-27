// a11-b correction round (review of f14ab1a9, BLOCKING 1 and 2): a merge that brought a new security warning is never
// published nor reconciled, whatever the bridge wrote. The verdict lives in the merge's evidence (security-after-merge.mjs,
// merge-reconcile.mjs mergeState), so the delivery, studio_publish {module}, studio_publish {manifest}, the bridge
// `publish` of lib.mjs studio (studio_command publish) and a reconciliation all agree. Shapes:
//   - v97: receipt.json ok/strictlyEqual with the warning among its warnings, new-messages.json beside it;
//   - a newer bridge: its own refusal (gate candidate_validation, merged:true), new-messages.json, no receipt;
//   - the answer judged upstream (lib.mjs) with no new-messages.json: the verdict the delivery records;
//   - known losses (incomplete): its repair is no way out of the warning.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deliverKernel } from '../kernel-delivery.mjs';
import { reconcileMerge, mergeState, reconcilable } from '../merge-reconcile.mjs';
import { judgeMergeAnswer, VERDICT_FILE } from '../security-after-merge.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import { runWithExecutor } from '../executor.mjs';
import { studio as libStudio } from '../lib.mjs';

const SHA = 'A'.repeat(64);
const WORDS = 'yes, publish Fixture now';
const openRedirect = { key: 'k1', id: 'OpenRedirect', type: 'Warning', message: 'Open Redirect', detail: 'The URL of the redirect uses an input', ownerKey: 'k1', ownerPath: 'MainFlow/Home' };
const harmless = { key: 'k3', id: 'UnusedVariable', type: 'Warning', message: 'Unused Variable', detail: 'Local variable X is never used' };
const v97Receipt = { ok: true, merged: true, module: 'Fixture', outcome: 'Merged', equivalence: 'strict', strictlyEqual: true, sha256: SHA, publishInvoked: false, warnings: [harmless, openRedirect] };
const newerRefusal = { ok: false, outcome: 'uncertain', gate: 'candidate_validation', merged: true, equal: false, equivalence: 'uncertain', dialogsClosed: [],
  error: 'New live validation diagnostics after merge: 1 (ids: OpenRedirect); new-messages.json names each owner and its addressableKey for ssam_map and studio_inspect.' };
const v97Incomplete = { ok: false, merged: true, outcome: 'incomplete', gate: 'known_losses', module: 'Fixture', mergeOutcome: 'Merged', error: 'Native merge kept the candidate except: 1 default.',
  missing: [{ element: 'Orders.Status', value: '1' }], repair: { ops: [{ op: 'set', target: 'Attribute:Orders.Status', prop: 'DefaultValue', value: '1' }] }, sha256: SHA };

// One delivery over fakes: shape(evidence) writes what the bridge writes and returns its answer (raw: the fake stands for
// the bridge; judged: it stands for lib.mjs studio, which judges the answer).
function harness(t, shape) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sam-bypass-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [];
  const manifestDir = path.join(root, 'lab', 'attempt', 'delivery');
  const evidence = path.join(manifestDir, 'evidence');
  const manifest = path.join(manifestDir, 'manifest.json');
  const studio = async ([step]) => {
    calls.push(step);
    if (step === 'status') return { ok: true, pid: 5150, modules: [{ name: 'Fixture', key: 'K', host: 'fixture.test', loggedIn: true }] };
    if (step === 'snapshot' && calls.includes('merge')) { fs.writeFileSync(path.join(root, 'after.oml'), 'a'); return { ok: true, module: 'Fixture', moduleKey: 'K', path: path.join(root, 'after.oml'), sha256: SHA }; }
    if (step === 'snapshot') return { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test', moduleKey: 'K', module: 'Fixture' };
    if (step === 'merge') {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: 'now', pid: 5150, candidateSha256: SHA }));
      fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'Merged', publishInvoked: false }));
      return shape(evidence);
    }
    if (step === 'publish') return { ok: true, module: 'Fixture', published: { revision: 9 }, completedAt: 'now' };
    return { ok: true };
  };
  // A content proof that accepts: the module equals the candidate, warning included.
  const prove = async () => ({ ok: true, proof: { schema: 'ssam-merge-content-proof/1', accepted: true, checked: 1, differences: [], inputs: { expected: { sha256: SHA }, actual: { sha256: SHA } } } });
  const reconcile = (input, more = {}) => reconcileMerge(input, { studio, prove, ...more });
  const deps = { root, nextLabDir: () => path.join(root, 'lab', 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {}, studio,
    apply: async () => ({ ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }),
    prepareManifest: async () => { fs.mkdirSync(manifestDir, { recursive: true }); fs.writeFileSync(path.join(manifestDir, 'candidate.oml'), 'c');
      fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', moduleKey: 'K', tenant: 'fixture.test', candidatePath: path.join(manifestDir, 'candidate.oml'), candidateSha256: SHA, evidenceDir: evidence }));
      return { ok: true, manifest }; },
    reconcile, grants: { findGrant: async () => null } };
  const deliver = () => deliverKernel({ module: 'Fixture', feature: 'f', job: 'job.json', owners: ['O'], changes: ['C'], publish: true, authorize: WORDS }, deps);
  const publishDeps = { studio, readManifest: f => JSON.parse(fs.readFileSync(path.resolve(root, f), 'utf8')), lab: path.join(root, 'lab'), root, catalog: () => null, grants: { findGrant: async () => null }, reconcile };
  return { root, calls, evidence, manifest, deliver, publishDeps };
}

async function assertNeverPublished(h, { delivered }) {
  assert.equal(delivered.ok, false, JSON.stringify(delivered).slice(0, 400));
  assert.equal(delivered.code, 'MERGE_SECURITY_WARNING');
  assert.equal(delivered.merged, true);
  assert.notEqual(delivered.code, 'MERGE_UNCERTAIN');
  assert.doesNotMatch(String(delivered.error), /remain unexplained/);
  assert.match(String(delivered.error), /OpenRedirect/);
  assert.match(String(delivered.error), /ReplaceURLDomain/, 'the platform\'s fix is named');
  assert.doesNotMatch(String(delivered.error), /[A-Z]:\\|\/tmp\//, 'no path in the text');
  assert.ok(!delivered.steps.some(s => s.step === 'reconcile'), 'never reconciled');
  assert.equal(h.calls.includes('publish'), false, 'never published by the delivery');
  // The verdict is in the evidence: every later reader refuses it.
  const state = mergeState(h.evidence);
  assert.equal(state.outcome, 'security'); assert.equal(state.clean, false); assert.equal(reconcilable(state), false);
  assert.ok(fs.existsSync(path.join(h.evidence, VERDICT_FILE)), 'the server verdict is recorded beside the bridge evidence');
  // studio_publish {module}: refused, no reconciliation, nothing written as a receipt by SSAM.
  const receiptBefore = fs.existsSync(path.join(h.evidence, 'receipt.json')) ? fs.readFileSync(path.join(h.evidence, 'receipt.json'), 'utf8') : null;
  const byModule = await publishWithGrant({ module: 'Fixture', authorize: WORDS, pid: 5150 }, h.publishDeps);
  assert.equal(byModule.ok, false); assert.equal(byModule.code, 'MERGE_SECURITY_WARNING', JSON.stringify(byModule).slice(0, 300));
  // studio_publish {manifest}: refused before the words are recorded.
  const byManifest = await publishWithGrant({ manifest: h.manifest, authorize: WORDS, pid: 5150 }, h.publishDeps);
  assert.equal(byManifest.ok, false); assert.equal(byManifest.code, 'MERGE_SECURITY_WARNING');
  assert.equal(h.calls.includes('publish'), false, 'never published');
  assert.equal(h.calls.includes('authorize'), false, 'no words recorded for a publication SSAM refuses');
  assert.equal(fs.existsSync(path.join(h.evidence, 'receipt.json')) ? fs.readFileSync(path.join(h.evidence, 'receipt.json'), 'utf8') : null, receiptBefore, 'no receipt written');
  assert.equal(fs.existsSync(path.join(h.evidence, 'reconciliation.json')), false);
}

test('v97: strict receipt with the warning among its warnings; the delivery and both studio_publish forms refuse', async t => {
  const h = harness(t, evidence => {
    fs.writeFileSync(path.join(evidence, 'new-messages.json'), JSON.stringify([harmless, openRedirect]));
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(v97Receipt));   // what the v97 bridge writes
    return { ...v97Receipt };                                                             // the bridge's raw answer
  });
  await assertNeverPublished(h, { delivered: await h.deliver() });
});

test('v97, answer judged upstream (lib.mjs studio): the same, the receipt on disk still says strict', async t => {
  const h = harness(t, evidence => {
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(v97Receipt));
    return judgeMergeAnswer({ ...v97Receipt });
  });
  await assertNeverPublished(h, { delivered: await h.deliver() });
});

test('a newer bridge: its own validation refusal, new-messages.json, no receipt; a content proof that accepts is never asked', async t => {
  const h = harness(t, evidence => {
    fs.writeFileSync(path.join(evidence, 'new-messages.json'), JSON.stringify([openRedirect]));
    return { ...newerRefusal };
  });
  await assertNeverPublished(h, { delivered: await h.deliver() });
  assert.equal(h.calls.filter(c => c === 'snapshot').length, 1, 'no capture for a reconciliation');
});

test('a newer bridge refusal judged upstream without new-messages.json: the delivery records the verdict', async t => {
  const h = harness(t, () => judgeMergeAnswer({ ...v97Receipt }));
  await assertNeverPublished(h, { delivered: await h.deliver() });
});

test('a newer bridge validation refusal without a security warning (errors) is never reconciled either', async t => {
  const h = harness(t, evidence => {
    fs.writeFileSync(path.join(evidence, 'new-messages.json'), JSON.stringify([harmless]));
    return { ...newerRefusal, error: 'New live validation diagnostics after merge: 1 (ids: SomeError); new-messages.json names each owner.' };
  });
  const delivered = await h.deliver();
  assert.equal(delivered.ok, false);
  assert.ok(!delivered.steps.some(s => s.step === 'reconcile'), 'gate candidate_validation is never reconciled');
  assert.equal(h.calls.includes('publish'), false);
});

test('known losses with a security warning: MERGE_SECURITY_WARNING, no repair job as the way out, never published', async t => {
  const h = harness(t, evidence => {
    fs.writeFileSync(path.join(evidence, 'new-messages.json'), JSON.stringify([openRedirect]));
    fs.writeFileSync(path.join(evidence, 'incomplete-receipt.json'), JSON.stringify(v97Incomplete));
    return { ...v97Incomplete };
  });
  const delivered = await h.deliver();
  assert.equal(delivered.code, 'MERGE_SECURITY_WARNING', JSON.stringify(delivered).slice(0, 300));
  assert.notEqual(delivered.continuation?.tool, 'studio_deliver', 'the repair job is no way out of a security warning');
  assert.equal(delivered.repairJob, undefined);
  assert.equal(mergeState(h.evidence).outcome, 'security');
  const byModule = await publishWithGrant({ module: 'Fixture', authorize: WORDS, pid: 5150 }, h.publishDeps);
  assert.equal(byModule.code, 'MERGE_SECURITY_WARNING');
  assert.equal(h.calls.includes('publish'), false);
});

test('lib.mjs studio: merge, reconcile-merge and publish of a manifest whose evidence holds the warning (hosted, through the agent)', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sam-lib-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const lab = path.join(workspace, 'odc', 'lab', '01', 'delivery');
  const evidence = path.join(lab, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const manifest = path.join(lab, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', evidenceDir: evidence }));
  const sent = [];
  let answer = { ...v97Receipt, warnings: [harmless] };
  const executor = { id: 'fake', hosted: true, o11Connection() { return null; }, async close() {},
    async call(kind, params) { sent.push(params?.args?.[0]); return kind === 'odc.pipe' ? { line: JSON.stringify(answer) } : {}; } };
  const context = { id: randomUUID(), hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc'], workspace, agent: null, executor, close: async () => {} };
  const run = args => runWithExecutor(context, () => libStudio(args, 4120));
  // the warning only in the evidence (new-messages.json), not in the answer: still judged
  fs.writeFileSync(path.join(evidence, 'new-messages.json'), JSON.stringify([harmless, openRedirect]));
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(v97Receipt));
  const merged = await run(['merge', manifest]);
  assert.equal(merged.code, 'MERGE_SECURITY_WARNING'); assert.equal(merged.merged, true);
  answer = { ...v97Receipt, warnings: [openRedirect] };
  assert.equal((await run(['reconcile-merge', manifest])).code, 'MERGE_SECURITY_WARNING');
  // studio_command publish / the publish of a delivery: refused before the bridge
  sent.length = 0;
  const published = await run(['publish', manifest, '--wait', '10']);
  assert.equal(published.ok, false); assert.equal(published.code, 'MERGE_SECURITY_WARNING'); assert.equal(published.executed, false);
  assert.deepEqual(sent, [], 'the publish line never reached the agent');
  // a clean merge evidence publishes as before (the line goes to the bridge)
  fs.rmSync(evidence, { recursive: true, force: true }); fs.mkdirSync(evidence, { recursive: true });
  answer = { ok: true, module: 'Fixture', published: { revision: 9 } };
  const clean = await run(['publish', manifest, '--wait', '10']);
  assert.deepEqual(sent, ['publish']); assert.equal(clean.ok, true);
});

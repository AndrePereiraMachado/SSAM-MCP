import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, interpretKernelResult, requiredFlowLayoutEngine, withBridgeUpgrade, withManifestCode } from '../kernel-delivery.mjs';

test('named reference producers are acquired without changing the consumer before headless build', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'job.json'), JSON.stringify({ ops: [
    { op: 'reference', producer: 'OutSystemsUI', elements: ['IMobileBlock:DropdownSearch'] },
    { op: 'reference', producer: 'OutSystemsUI', elements: ['IStructure:DropdownOption'] },
  ] }));
  const original = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] !== 'reference-snapshot') return original(args);
    f.calls.push(args[0]);
    const request = JSON.parse(args[1]);
    assert.equal(request.module, 'Fixture');
    assert.equal(request.producer, 'OutSystemsUI');
    const bytes = JSON.stringify({ Environment: 'fixture.test' });
    fs.writeFileSync(request.output, bytes);
    return { ok: true, environment: 'fixture.test', consumerUnchanged: true,
      sha256: createHash('sha256').update(bytes).digest('hex'), producerKey: 'fixture-key', revision: '1' };
  };
  f.deps.apply = async input => {
    f.calls.push('apply');
    assert.equal(Object.keys(input.producers).length, 1);
    assert.equal(path.dirname(input.producers.OutSystemsUI), path.join(f.root, 'attempt'));
    return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' };
  };
  const result = await deliverKernel({ ...f.input, until: 'build' }, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.producers.length, 1);
  assert.deepEqual(f.calls, ['snapshot', 'reference-snapshot', 'apply', 'manifest']);
});

for (const bad of ['wrong-environment', 'consumer-changed', 'missing-producer', 'wrong-hash']) {
  test('dependency acquisition refuses ' + bad + ' before build or merge', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: 'OutSystemsUI', elements: ['IMobileBlock:DropdownSearch'] }] }));
    const original = f.deps.studio;
    f.deps.studio = async args => {
      if (args[0] !== 'reference-snapshot') return original(args);
      const request = JSON.parse(args[1]);
      fs.writeFileSync(request.output, '{}');
      return { ok: bad !== 'missing-producer', error: 'missing producer',
        environment: bad === 'wrong-environment' ? 'other.test' : 'fixture.test',
        consumerUnchanged: bad !== 'consumer-changed', sha256: 'wrong' };
    };
    const result = await deliverKernel(f.input, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'reference-snapshot');
    assert.ok(!f.calls.includes('apply'));
    assert.ok(!f.calls.includes('merge'));
  });
}

test('a stale kernel CLI refuses with its code and an MCP continuation, never a build command', async t => {
  const f = fixture(t);
  const continuation = { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'componente não compilado: o integrador/usuário compila' };
  f.deps.apply = async () => ({ ok: false, code: 'COMPONENT_STALE', error: 'ODC authoring CLI does not confirm layout x: it is older than the facade; the integrator or the user rebuilds it before delivery.', continuation });
  f.deps.guide = null;
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false); assert.equal(result.failed, 'build');
  assert.equal(result.code, 'COMPONENT_STALE'); assert.deepEqual(result.continuation, continuation);
  assert.doesNotMatch(JSON.stringify({ error: result.error, continuation: result.continuation }), /build_odc|scripts|dotnet|python/);
  assert.ok(!f.calls.includes('merge'));
});

function fixture(t, { refuse, transport, preview = {}, merge = {}, refusal = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [], entries = [];
  const input = { module: 'Fixture', feature: 'fixture-change', job: 'job.json', owners: ['Screen'], changes: ['Change screen'] };
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: e => entries.push(e),
    studio: async ([step]) => {
      calls.push(step);
      if (transport === step) throw new Error('pipe disconnected');
      if (refuse === step) return { ok: false, gate: 'test_gate', error: 'refused ' + step, ...refusal };
      if (step === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'HASH', host: 'fixture.test' };
      if (step === 'preview') return { ok: true, conflicts: false, noDifferences: false, ...preview };
      if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true, ...merge };
      return { ok: true };
    },
    apply: async () => { calls.push('apply'); return refuse === 'apply' ? { ok: false, error: 'kernel rejected' } : { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => { calls.push('manifest'); return refuse === 'manifest' ? { ok: false, error: 'invalid candidate' } : { ok: true, manifest: 'manifest.json' }; },
  };
  return { root, input, deps, calls, entries };
}

test('preview delivers no merge and records the completed steps', async t => {
  const f = fixture(t);
  const result = await deliverKernel({ ...f.input, until: 'preview' }, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.merged, false);
  assert.equal(result.publishInvoked, false);
  assert.deepEqual(f.calls, ['snapshot', 'apply', 'manifest', 'check-base', 'preview']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.evidence, 'deliver-result.json'))), result);
  assert.equal(f.entries.length, 1);
});

// check-base and preview run only for a review the person asks for (until=check-base|preview); a delivery goes straight to the merge.
for (const refuse of ['snapshot', 'apply', 'manifest', 'check-base', 'preview', 'merge']) {
  test('stops after refusal at ' + refuse, async t => {
    const f = fixture(t, { refuse });
    const result = await deliverKernel({ ...f.input, ...(['check-base', 'preview'].includes(refuse) ? { until: 'preview' } : {}) }, f.deps);
    assert.equal(result.ok, false);
    assert.equal(f.calls.at(-1), refuse);
    assert.equal(f.calls.filter(s => s === 'merge').length, refuse === 'merge' ? 1 : 0);
    assert.equal(f.entries[0].outcome, 'gate_refused');
  });
}

test('the journal keeps the gate and the failed stage of a refusal (request C-009)', async t => {
  const f = fixture(t, { refuse: 'check-base' });
  const result = await deliverKernel({ ...f.input, until: 'preview' }, f.deps);
  assert.equal(result.failed, 'check-base');
  assert.equal(f.entries[0].gate, 'test_gate'); assert.equal(f.entries[0].failed, 'check-base'); assert.equal(f.entries[0].outcome, 'gate_refused');
  assert.equal(f.entries[0].evidence, result.evidence);
});

test('an uncertain merge keeps receipts, never retries and refuses reuse of the attempt', async t => {
  const f = fixture(t, { transport: 'merge' });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(f.calls.filter(s => s === 'merge').length, 1);
  assert.equal(f.entries[0].outcome, 'uncertain');
  const callCount = f.calls.length;
  await assert.rejects(deliverKernel(f.input, f.deps), /new output directory/);
  assert.equal(f.calls.length, callCount);
});

test('an explicit uncertain bridge response stays uncertain in the receipt and journal', async t => {
  const f = fixture(t, { refuse: 'merge', refusal: { outcome: 'uncertain' } });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(f.entries[0].outcome, 'uncertain');
  assert.equal(f.calls.filter(s => s === 'merge').length, 1);
});

for (const preview of [{ conflicts: true }, { noDifferences: true }]) {
  test('preview prevents a conflicting or empty merge: ' + JSON.stringify(preview), async t => {
    const f = fixture(t, { preview });
    const result = await deliverKernel({ ...f.input, until: 'preview' }, f.deps);
    assert.equal(result.failed, 'preview');
    assert.equal(result.ok, false);
    assert.ok(!f.calls.includes('merge'));
  });
}

// The bridge's merge order (NativeMergeOrder) names a known loss instead of answering uncertain: merged, everything else
// proven equal, each lost default with its repair job. The delivery keeps it merged and carries the repair to the answer.
test('an incomplete merge is merged, not uncertain, and carries each lost default with its repair', async t => {
  const repair = { ops: [{ op: 'set', target: '@k1', prop: 'DefaultValue', value: 'Entities.PartidaStatus.Aguardando' }] };
  const f = fixture(t, { refuse: 'merge', refusal: { merged: true, outcome: 'incomplete', gate: 'known_losses',
    error: 'Native merge kept the candidate except: the native merge did not keep 1 default value(s): Partida.StatusId = Entities.PartidaStatus.Aguardando.',
    missing: [{ key: 'k1', objectKey: 'k1', element: 'Partida.StatusId', property: 'DefaultValue', value: 'Entities.PartidaStatus.Aguardando', baseValue: null }],
    repair, forcedDeleteRules: [], declare: { ops: [] }, afterSnapshot: 'after-merge.oml' } });
  const result = await deliverKernel({ ...f.input, pid: 42 }, f.deps);
  assert.equal(result.ok, false); assert.equal(result.outcome, 'incomplete'); assert.equal(result.merged, true); assert.equal(result.gate, 'known_losses');
  assert.deepEqual(result.repair, repair); assert.equal(result.missing[0].element, 'Partida.StatusId'); assert.equal(result.afterSnapshot, 'after-merge.oml');
  assert.equal(f.entries[0].outcome, 'incomplete');
  assert.equal(f.calls.filter(s => s === 'merge').length, 1);
  // The repair is the continuation: a job file next to the evidence, delivered by the same tool (a new capture and lab).
  assert.equal(result.repairJob, path.join(result.evidence, 'repair.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.repairJob, 'utf8')), repair);
  assert.deepEqual(result.continuation, { tool: 'studio_deliver', arguments: { feature: 'fixture-change', module: 'Fixture', job: result.repairJob, owners: ['Screen'],
    changes: ['Default Partida.StatusId = Entities.PartidaStatus.Aguardando'], pid: 42 }, why: result.continuation.why });
  assert.match(result.continuation.why, /Never repeat the original delivery/);
  // An uncertain merge carries no repair; the bridge's merged:true is kept (C16 G-3, package 3) and the continuation is a read.
  const plain = fixture(t, { refuse: 'merge', refusal: { outcome: 'uncertain', merged: true, repair } });
  const uncertain = await deliverKernel(plain.input, plain.deps);
  assert.equal(uncertain.merged, true); assert.equal(uncertain.repair, undefined);
  assert.equal(uncertain.continuation.tool, 'ssam_evidence');
});

test('merge succeeds only with explicit merged and strictlyEqual evidence', async t => {
  const f = fixture(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.strictlyEqual, true);
  const unproved = fixture(t, { merge: { strictlyEqual: false } });
  const refused = await deliverKernel(unproved.input, unproved.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.outcome, 'uncertain');
});

test('a kernel refusal at build returns the catalog guidance for the job; later refusals and merges never do', async t => {
  const f = fixture(t, { refuse: 'apply' });
  const asked = [];
  const guide = async args => { asked.push(args); return { schemaVersion: 'ssam-job-guidance/1', failure: { stage: 'kernel' } }; };
  const refused = await deliverKernel(f.input, { ...f.deps, guide });
  assert.equal(refused.failed, 'build'); assert.equal(refused.discovery.schemaVersion, 'ssam-job-guidance/1');
  assert.equal(asked[0].lane, 'odc'); assert.equal(asked[0].run.result.error, 'kernel rejected'); assert.equal(asked[0].job, path.join(f.root, 'job.json'));
  const failingGuide = await deliverKernel(fixture(t, { refuse: 'apply' }).input, { ...fixture(t, { refuse: 'apply' }).deps, guide: async () => { throw new Error('boom'); } });
  assert.equal(failingGuide.failed, 'build'); assert.equal(failingGuide.discovery, undefined, 'a guidance error never changes the delivery answer');
  for (const refuse of ['manifest', 'preview', 'merge']) {
    const g = fixture(t, { refuse }); const seen = [];
    const result = await deliverKernel(g.input, { ...g.deps, guide: async a => { seen.push(a); return {}; } });
    assert.equal(result.discovery, undefined); assert.equal(seen.length, 0, refuse);
  }
});

test('the base snapshot and the built candidate are warmed in the background; a failing warm-up changes nothing', async t => {
  const f = fixture(t);
  const warmed = [];
  const result = await deliverKernel({ ...f.input, until: 'build' }, { ...f.deps, prefetch: (file, lane) => { warmed.push([file, lane]); } });
  assert.equal(result.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warmed, [['base.oml', 'odc'], ['candidate.oml', 'odc']]);
  const g = fixture(t);
  const failing = await deliverKernel({ ...g.input, until: 'build' }, { ...g.deps, prefetch: () => { throw new Error('spawn EPERM'); } });
  const h = fixture(t);
  const rejecting = await deliverKernel({ ...h.input, until: 'build' }, { ...h.deps, prefetch: async () => { throw new Error('spawn EPERM'); } });
  for (const r of [failing, rejecting]) { assert.equal(r.ok, true); assert.equal(r.error, undefined); assert.equal(r.manifest, 'manifest.json'); }
  const refused = fixture(t, { refuse: 'apply' }); const none = [];
  await deliverKernel(refused.input, { ...refused.deps, prefetch: file => none.push(file) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(none, ['base.oml'], 'a refused build warms no candidate');
});

// The base is the module as it is now in the Studio. QuizLiveWeb, 2026-10-05: after an uncertain merge the correction
// was built on a fresh capture (FC9AEAF0..., the post-merge module); this keeps that true for every delivery.
test('every delivery builds on its own fresh capture of the open module, an uncertain one before it included', async t => {
  const f = fixture(t);
  let captures = 0; const applied = [], manifests = [];
  f.deps.studio = async ([step]) => {
    f.calls.push(step);
    if (step === 'snapshot') { captures++; return { ok: true, path: 'base-' + captures + '.oml', sha256: 'HASH' + captures, host: 'fixture.test', module: 'Fixture', capturedAt: '2026-10-05T00:2' + captures + ':00Z' }; }
    if (step === 'preview') return { ok: true, conflicts: false, noDifferences: false };
    if (step === 'merge') return captures === 1 ? { ok: true, merged: true, strictlyEqual: false } : { ok: true, merged: true, strictlyEqual: true };
    return { ok: true };
  };
  f.deps.apply = async ({ snapshot }) => { applied.push(snapshot.path); return { ok: true, candidate: 'candidate-' + captures + '.oml', receipt: 'kernel-result.json' }; };
  f.deps.prepareManifest = async ({ base, candidate }) => { manifests.push([base, candidate]); return { ok: true, manifest: 'manifest.json' }; };
  const first = await deliverKernel(f.input, { ...f.deps, nextLabDir: () => path.join(f.root, 'first') });
  assert.equal(first.outcome, 'uncertain');
  const second = await deliverKernel(f.input, { ...f.deps, nextLabDir: () => path.join(f.root, 'second') });
  assert.equal(second.ok, true);
  assert.deepEqual(applied, ['base-1.oml', 'base-2.oml']);
  assert.deepEqual(manifests, [['base-1.oml', 'candidate-1.oml'], ['base-2.oml', 'candidate-2.oml']]);
  assert.deepEqual(second.snapshot, { path: 'base-2.oml', sha256: 'HASH2', host: 'fixture.test', capturedAt: '2026-10-05T00:22:00Z' });
  assert.equal(f.calls.filter(s => s === 'snapshot').length, 2);
});

test('the app name the person sees reaches the open module the capture names, for every later step', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: 'OutSystemsUI', elements: ['IMobileBlock:DropdownSearch'] }] }));
  const seen = [];
  f.deps.studio = async args => {
    f.calls.push(args[0]); seen.push(args);
    if (args[0] === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'HASH', host: 'fixture.test', module: 'QuizLiveWeb', requestedModule: 'QuizLive Web' };
    const request = JSON.parse(args[1]);
    const bytes = JSON.stringify({ Environment: 'fixture.test' });
    fs.writeFileSync(request.output, bytes);
    return { ok: true, environment: 'fixture.test', consumerUnchanged: true, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const result = await deliverKernel({ ...f.input, module: 'QuizLive Web', until: 'build' }, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.module, 'QuizLiveWeb'); assert.equal(result.requestedModule, 'QuizLive Web');
  assert.deepEqual(seen[0], ['snapshot', 'QuizLive Web']);
  assert.equal(JSON.parse(seen[1][1]).module, 'QuizLiveWeb');
  assert.equal(f.entries[0].module, 'QuizLiveWeb');
});

test('a name that is no open module stops at the snapshot with the open modules and studio_open; nothing else runs', async t => {
  const continuation = { tool: 'studio_open', arguments: { module: 'Escala Viva' }, why: 'opens it' };
  const f = fixture(t, { refuse: 'snapshot', refusal: { code: 'MODULE_NOT_OPEN', openModules: ['QuizLiveWeb'], continuation } });
  const result = await deliverKernel({ ...f.input, module: 'Escala Viva' }, f.deps);
  assert.equal(result.ok, false); assert.equal(result.failed, 'snapshot'); assert.equal(result.code, 'MODULE_NOT_OPEN');
  assert.deepEqual(result.openModules, ['QuizLiveWeb']); assert.deepEqual(result.continuation, continuation);
  assert.deepEqual(f.calls, ['snapshot']);
});

test('a candidate identical to the live capture is refused at build as NO_CHANGE, before any Studio step', async t => {
  const f = fixture(t);
  f.deps.prepareManifest = async () => { f.calls.push('manifest'); return { ok: false, error: 'InvalidOperationException: Candidate equals the live module Fixture (snapshot HASH): no element added, removed or changed. The module already has what the job asks for; nothing to deliver.' }; };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false); assert.equal(result.failed, 'build'); assert.equal(result.code, 'NO_CHANGE');
  assert.deepEqual(f.calls, ['snapshot', 'apply', 'manifest']);
  assert.equal(withManifestCode({ ok: false, error: 'No change carries the snapshot author and nothing was deleted' }).code, 'CANDIDATE_AUTHOR');
  const ok = { ok: true, manifest: 'm.json' };
  assert.equal(withManifestCode(ok), ok);
});

// Lane extlib: a bridge from before the External Library reference refuses such a producer with its own sentence; the
// delivery answers BRIDGE_UPGRADE_REQUIRED with the step that fixes it, before any build.
test('an older bridge refusing an External Library producer is BRIDGE_UPGRADE_REQUIRED before the build', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: 'SSAMTextTools', elements: ['IServerAction:Reverse'] }] }));
  const original = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] !== 'reference-snapshot') return original(args);
    f.calls.push(args[0]);
    return { ok: false, outcome: 'gate_refused', error: 'This command currently exports module/library signatures, not extensions or external libraries' };
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false); assert.equal(result.failed, 'reference-snapshot'); assert.equal(result.code, 'BRIDGE_UPGRADE_REQUIRED');
  assert.equal(result.continuation.tool, 'studio_attach'); assert.match(result.continuation.why, /reopen the ODC Studio/);
  assert.match(result.error, /SSAMTextTools/);
  assert.deepEqual(f.calls, ['snapshot', 'reference-snapshot']);
  assert.equal(withBridgeUpgrade({ ok: false, error: 'Producer is not available to the consumer session: X' }).code, undefined, 'any other refusal stays as it is');
});

// CompileCheck (class D): a lab that builds a consumed SOAP service by verbs (allowSoapWithoutImport) is accepted by the kernel
// with a HIGH warning, and the delivery never delivers it.
test('a lab escape of the SOAP rule is never delivered', () => {
  const lab = { code: 'COMPILE_SOAP_DEFINITION_ALLOWED', severity: 'high', message: 'the consumed SOAP service X ... (never delivered)' };
  const refused = interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, highWarnings: [lab] } }, { output: 'o' });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'COMPILE_SOAP_DEFINITION'); assert.match(refused.error, /never delivered/);
  const other = interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, highWarnings: [{ code: 'AGGREGATES_MERGEABLE', severity: 'high' }] } }, { output: 'o' });
  assert.equal(other.ok, true);
});
// I7: what the integration ops of a job imported reaches the delivery answer (at most 10, with the total).
test('data.integration of the kernel result reaches the delivery report', async t => {
  const integration = Array.from({ length: 12 }, (_, i) => ({ op: 'rest', client: { name: 'Api' + i, key: 'k' + i, created: true }, imported: ['Get'], skipped: [], updated: [], removed: [], consumersBroken: [], warnings: [] }));
  assert.deepEqual(interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, integration } }, { output: 'o' }).integration, integration);
  assert.equal(interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine } }, { output: 'o' }).integration, undefined);
  const f = fixture(t);
  f.deps.apply = async () => { f.calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json', integration }; };
  const result = await deliverKernel({ ...f.input, until: 'build' }, f.deps);
  assert.equal(result.ok, true); assert.equal(result.integration.length, 10); assert.equal(result.integrationTotal, 12);
  assert.equal(result.integration[0].client.name, 'Api0');
});

// I6: the integration documents of a job are prepared (pinned, destructive words checked) before anything is captured.
test('prepareIntegrationJob runs before the snapshot; its refusal stops there and its pinned job is the one built', async t => {
  const refused = fixture(t); const asked = [];
  refused.deps.prepareIntegrationJob = async (job, options) => { asked.push([job, options]); return { ok: false, code: 'INTEGRATION_DELETE_WORDS', error: 'The words do not name IRestAction:GetCep.', problems: [{ code: 'INTEGRATION_DELETE_WORDS', message: 'x', fix: 'y' }] }; };
  const out = await deliverKernel({ ...refused.input, authorize: 'apague o metodo' }, refused.deps);
  assert.equal(out.ok, false); assert.equal(out.failed, 'documents'); assert.equal(out.code, 'INTEGRATION_DELETE_WORDS'); assert.equal(out.problems.length, 1);
  assert.deepEqual(refused.calls, [], 'nothing captured, built or merged');
  assert.equal(asked[0][0], path.join(refused.root, 'job.json'));
  assert.deepEqual(asked[0][1], { lane: 'odc', words: 'apague o metodo', localRoot: path.join(refused.root, '.local') });
  assert.equal(refused.entries[0].failed, 'documents');
  const pinned = fixture(t);
  const pinnedJob = path.join(pinned.root, 'job.pinned.json');
  fs.writeFileSync(pinnedJob, JSON.stringify({ ops: [] }));
  pinned.deps.prepareIntegrationJob = async () => ({ ok: true, job: pinnedJob, changed: true, documents: [{ source: 'https://example.test/api.wsdl', path: 'p', sha256: 'a'.repeat(64), bytes: 10 }] });
  const built = []; pinned.deps.apply = async ({ job }) => { built.push(job); pinned.calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; };
  const ok = await deliverKernel({ ...pinned.input, until: 'build' }, pinned.deps);
  assert.equal(ok.ok, true); assert.deepEqual(built, [pinnedJob]); assert.equal(ok.job, pinnedJob); assert.equal(ok.documents.length, 1);
  assert.deepEqual(pinned.calls, ['snapshot', 'apply', 'manifest']);
});

test('bad metadata is refused before contacting the Studio', async t => {
  const f = fixture(t);
  await assert.rejects(deliverKernel({ ...f.input, owners: [] }, f.deps), /owners/);
  await assert.rejects(deliverKernel({ ...f.input, until: 'publish' }, f.deps), /until/);
  assert.deepEqual(f.calls, []);
});

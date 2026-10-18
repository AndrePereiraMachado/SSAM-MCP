// fix/system-reference (owner, 2026-10-15): a delivery that adds a reference to a (System) element never fails. Replays the
// shape of the incident of 15/10 (an ODC app, ClientAction ListAppendAll from (System); friction records of the proof folder:
// KERNEL_REFUSED "producer '(System)' points to an OML outside tests/fixtures and outside the SSAM capture folders",
// REFERENCE_SNAPSHOT_FAILED "Producer is not available to the consumer session: System", and the offline check's
// PRODUCER_NOT_CAPTURED) with a fake bridge that offers the producer only as the Studio lists it, "(System)".
// Nothing here starts a process or a Studio; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel } from '../kernel-delivery.mjs';
import { codeCheck } from '../code-check.mjs';
import { autoCaptures, referencedProducers, producerArgs } from '../o11-cycle.mjs';
import { jobToolRequest, runJob } from '../job-runner.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'fixture.test';
const SYSTEM_KEY = 'uXCIR2Atc0+es3zYuZSnNw';
// The capture envelope the bridge writes (ReferenceCommands.cs ReferenceSnapshot), synthetic values.
const envelope = (name = '(System)', { key = SYSTEM_KEY, revision = '7', hash = 'aaaaaaaa-0000-1111-2222-333333333333', environment = HOST } = {}) => JSON.stringify({ FormatVersion: 2,
  Environment: environment, ModuleKey: key, ApplicationKey: '', ModuleKind: 'eSpace', ModuleType: 'ReactiveLibrary', Name: name, SignatureHash: hash, Revision: revision,
  Elements: [{ Kind: 'client-action', Name: 'ListAppendAll', Key: 'kListAppendAll' }] });
const incidentJob = producer => ({ ops: [
  { op: 'reference', producer, elements: ['ClientAction:ListAppendAll'] },
  { op: 'find', name: 'ListAppendAll', type: 'IClientAction' },
] });

// A consumer session that offers (System) and OutSystemsUI, by the names the Studio lists (reference-producers), and refuses
// any other name as the bridge does.
function studioFixture(t, { offered = ['(System)', 'OutSystemsUI'], revision = '7' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-system-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const studio = async ([step, argument]) => {
    if (step === 'reference-snapshot') {
      const request = JSON.parse(argument);
      calls.push({ step, producer: request.producer });
      const name = offered.find(n => n === request.producer || n.toLowerCase() === String(request.producer).toLowerCase());
      if (!name) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      const bytes = envelope(name, { revision });
      fs.writeFileSync(request.output, bytes, { flag: 'wx' });
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: name, producerKey: name === '(System)' ? SYSTEM_KEY : 'k-' + name, revision };
    }
    calls.push({ step });
    if (step === 'reference-producers') return { ok: true, producers: offered.map(name => ({ name, key: 'k-' + name })) };
    if (step === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'HASH', host: HOST };
    if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    return { ok: true };
  };
  const applied = [];
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, studio, signatureCache: path.join(root, '.local', 'producer-cache'),
    apply: async input => { applied.push(input.producers); calls.push({ step: 'apply' }); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => { calls.push({ step: 'manifest' }); return { ok: true, manifest: 'manifest.json' }; } };
  const input = job => { fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job)); return { module: 'FloodQuotes', feature: 'sort-visible-cards', job: 'job.json', owners: ['SortVisibleCards'], changes: ['Use ListAppendAll'] }; };
  return { root, calls, applied, deps, input, steps: () => calls.map(c => c.step) };
}

test('a job that names (System) as the Studio lists it captures it and binds it as System: one delivery, merged', async t => {
  const f = studioFixture(t);
  const result = await deliverKernel(f.input(incidentJob('(System)')), f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result, 'delivered'); // the English result since 16/10 (result-values.mjs)
  assert.deepEqual(f.calls.filter(c => c.step === 'reference-snapshot').map(c => c.producer), ['(System)']);
  assert.deepEqual(Object.keys(f.applied[0]), ['System']);
  assert.equal(path.basename(f.applied[0].System), 'System.avsig');
  assert.equal(result.producers[0].name, 'System');
  assert.equal(result.producers[0].studioName, '(System)');
});

for (const written of ['System', 'system', '(system)']) {
  test('"' + written + '" is the system producer: captured as (System) with a note in the receipt, never a dead end', async t => {
    const f = studioFixture(t);
    const result = await deliverKernel({ ...f.input(incidentJob(written)), until: 'build' }, f.deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls.filter(c => c.step === 'reference-snapshot').map(c => c.producer), ['(System)']);
    assert.deepEqual(Object.keys(f.applied[0]), ['System']);
    assert.match(result.producers[0].note, /\(System\)/);
    assert.deepEqual(result.producers[0].requested, [written]);
  });
}

test('(System) and System in one job are one producer: one capture, one binding', async t => {
  const f = studioFixture(t);
  const job = incidentJob('(System)'); job.ops.push({ op: 'reference', producer: 'System', elements: ['ClientAction:ListAppend'] });
  const result = await deliverKernel({ ...f.input(job), until: 'build' }, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.filter(c => c.step === 'reference-snapshot').length, 1);
  assert.deepEqual(Object.keys(f.applied[0]), ['System']);
});

test('a producer the consumer session does not offer: ONE refusal listing every producer it offers, with the corrected call', async t => {
  const f = studioFixture(t);
  const result = await deliverKernel(f.input(incidentJob('Sistema')), f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRODUCER_UNKNOWN');
  assert.equal(result.failed, 'reference-snapshot');
  assert.deepEqual(result.available, ['(System)', 'OutSystemsUI']);
  assert.match(result.error, /offers no producer named "Sistema"/);
  assert.match(result.error, /\(System\), OutSystemsUI/);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].pointer, '/ops/0/producer');
  assert.equal(result.continuation.tool, 'studio_deliver');
  assert.deepEqual(result.continuation.arguments.patch, [{ op: 'replace', path: '/ops/0/producer', value: '<a name of available>' }]);
  assert.equal(result.continuation.arguments.basedOn.sha256, sha(fs.readFileSync(path.join(f.root, 'job.json'))));
  assert.deepEqual(f.steps(), ['snapshot', 'reference-snapshot', 'reference-producers']);
  assert.ok(!f.steps().includes('apply') && !f.steps().includes('merge'));
});

test('a name the session lists only in the (Name) form is that producer: taken with a note, bound by its key', async t => {
  const f = studioFixture(t, { offered: ['(Tools)', 'OutSystemsUI'] });
  const result = await deliverKernel({ ...f.input(incidentJob('Tools')), until: 'build' }, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.filter(c => c.step === 'reference-snapshot').map(c => c.producer), ['Tools', '(Tools)']);
  assert.deepEqual(Object.keys(f.applied[0]), ['Tools']);
  assert.equal(result.producers[0].studioName, '(Tools)');
  assert.match(result.producers[0].note, /lists "\(Tools\)"/);
});

test('producers {(System): capture} binds the given capture: the build uses it, and the producer is acquired once to prove it current', async t => {
  const f = studioFixture(t);
  const given = path.join(f.root, 'snapshots', 'System-producer.avsig');
  fs.mkdirSync(path.dirname(given), { recursive: true }); fs.writeFileSync(given, envelope());
  // A delivery that merges: the build on the given capture first, then one acquisition right before the merge.
  const merged = await deliverKernel({ ...f.input(incidentJob('(System)')), producers: { '(System)': given } }, f.deps);
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.deepEqual(f.applied[0], { System: given });
  assert.equal(merged.producers[0].source, 'given');
  assert.equal(merged.producers[0].beforeMerge, 'acquired');
  assert.deepEqual(f.steps().slice(0, 4), ['snapshot', 'apply', 'manifest', 'reference-snapshot']);
  // One that stops at the build hands its manifest to a later merge that acquires nothing: the proof comes before the build.
  f.calls.length = 0;
  const built = await deliverKernel({ ...f.input(incidentJob('(System)')), producers: { '(System)': given }, until: 'build', output: path.join(f.root, 'build-only') }, f.deps);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.deepEqual(f.steps(), ['snapshot', 'reference-snapshot', 'apply', 'manifest']);
  assert.equal(built.producers[0].beforeBuild, 'acquired');
});

test('a given capture of another revision stops before the merge with PRODUCER_CHANGED and the same delivery without it', async t => {
  const f = studioFixture(t, { revision: '8' });
  const given = path.join(f.root, 'given.avsig'); fs.writeFileSync(given, envelope('(System)', { revision: '7' }));
  const result = await deliverKernel({ ...f.input(incidentJob('(System)')), producers: { '(System)': given } }, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRODUCER_CHANGED');
  assert.ok(!f.steps().includes('merge'));
  assert.equal(result.continuation.tool, 'studio_deliver');
  assert.equal(result.continuation.arguments.producers, undefined);
});

test('a recent studio_reference_snapshot capture in the capture folder is found by itself, then acquired again before the merge', async t => {
  const f = studioFixture(t);
  const capture = path.join(f.root, 'snapshots', 'System-producer.avsig');
  fs.mkdirSync(path.dirname(capture), { recursive: true }); fs.writeFileSync(capture, envelope());
  const result = await deliverKernel(f.input(incidentJob('(System)')), f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.producers[0].reused, true);
  assert.equal(result.producers[0].from, capture);
  // The build read the capture (no acquisition before it); the merge was preceded by one acquisition.
  assert.deepEqual(f.steps().slice(0, 3), ['snapshot', 'apply', 'manifest']);
  assert.deepEqual(f.calls.filter(c => c.step === 'reference-snapshot').map(c => c.producer), ['(System)']);
});

test('offline check (odc): the (System) capture of the capture folder binds System; absent, ONE problem continued by the capture', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-system-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.oml'); fs.writeFileSync(base, 'OML');
  const odcRoot = path.join(dir, 'odc');
  const calls = [];
  const run = () => codeCheck({ lane: 'odc', module: 'FloodQuotes', base, ops: incidentJob('(System)').ops },
    { root: dir, local: path.join(dir, 'local'), odcRoot, runJob: async request => { calls.push(request.producers); return { ok: true, job: request.job }; } });
  const missing = await run();
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PRODUCER_NOT_CAPTURED');
  assert.equal(missing.problems.length, 1);
  assert.equal(missing.continuation.tool, 'studio_reference_snapshot');
  assert.equal(missing.continuation.arguments.producer, '(System)');
  assert.equal(missing.continuation.arguments.module, 'FloodQuotes');
  assert.ok(missing.continuation.arguments.output.startsWith(path.join(odcRoot, 'snapshots')));
  const capture = path.join(odcRoot, 'snapshots', 'System-producer.avsig');
  fs.mkdirSync(path.dirname(capture), { recursive: true }); fs.writeFileSync(capture, envelope());
  const found = await run();
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(calls.at(-1), { System: capture });
  assert.equal(found.producers.System.path, capture);
});

test('offline check (o11): a cached (System) capture that covers the elements binds System', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-system-check-o11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.oml'); fs.writeFileSync(base, 'OML');
  const local = path.join(dir, 'local'), cache = path.join(local, 'producer-cache');
  fs.mkdirSync(cache, { recursive: true });
  const avsig = path.join(cache, 'system.avsig'); fs.writeFileSync(avsig, 'system');
  const payload = JSON.stringify({ producer: '(System)', environment: HOST, elements: ['IServerActionSignature:ListAppendAll'], storedAtUtc: '2026-10-15T00:00:00Z', sha256: sha('system') });
  fs.writeFileSync(path.join(cache, 'system.json'), JSON.stringify({ format: 1, payload, sha256: sha(payload) }));
  const calls = [];
  const result = await codeCheck({ lane: 'o11', module: 'Neutral', base, ops: [{ op: 'reference', producer: 'System', elements: ['IServerActionSignature:ListAppendAll'] }] },
    { root: dir, local, odcRoot: path.join(dir, 'odc'), now: () => Date.parse('2026-10-15T01:00:00Z'), runJob: async request => { calls.push(request.producers); return { ok: true, job: request.job }; } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls[0], { System: avsig });
});

test('o11_deliver: (System) and System are captured once, as System=(System); a bound (System) is never captured again', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-system-o11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = path.join(dir, 'job.json');
  fs.writeFileSync(job, JSON.stringify(incidentJob('(System)')));
  assert.deepEqual(referencedProducers(job), ['(System)']);
  assert.deepEqual(autoCaptures(job), ['System=(System)']);
  const both = incidentJob('(System)'); both.ops.push({ op: 'reference', producer: 'System', elements: ['IServerActionSignature:ListAppend'] });
  fs.writeFileSync(job, JSON.stringify(both));
  assert.deepEqual(autoCaptures(job), ['System=(System)']);
  assert.deepEqual(autoCaptures(job, { producers: { System: path.join(dir, 's.avsig') } }), []);
  assert.deepEqual(autoCaptures(job, { captureProducers: ['(System)'] }), []);
  const file = path.join(dir, 'System.avsig');
  assert.deepEqual(producerArgs({ '(System)': file }), ['--producer', 'System=' + file]);
  assert.deepEqual(producerArgs({ '(System)': 'published' }), ['--capture-producer', 'System=(System)']);
});

test('ssam_job (odc): producers {(System): capture} is accepted, and a capture of the capture folder is bound by itself', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-system-job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'System.avsig');
  const request = jobToolRequest({ lane: 'odc', job: path.join(root, 'job.json'), producers: { '(System)': file } });
  assert.equal(request.ok, true, JSON.stringify(request));
  const cli = path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, JSON.stringify(incidentJob('(System)')));
  const odcRoot = path.join(root, 'odc');
  const capture = path.join(odcRoot, 'snapshots', 'System-producer.avsig');
  fs.mkdirSync(path.dirname(capture), { recursive: true }); fs.writeFileSync(capture, envelope());
  const runAnvil = fakeAnvil({ apply: () => ({ ok: true, data: { accepted: true, isValid: true, messages: 0 } }) });
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: root, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const result = await runJob({ lane: 'odc', job }, { root, env, o11Lane: 'ss4', odcRoot, runAnvil, prepareIntegrationJob: async () => ({ ok: true }) });
  const argv = runAnvil.calls[0]?.args ?? [];
  assert.ok(argv.includes('System=' + capture), JSON.stringify(argv));
  assert.equal(result.boundProducers?.[0]?.path, capture);
});

test('the answer the model reads keeps the name note of a delivered producer and the producers offered on a refusal', async t => {
  const { compactDelivery } = await import('../responses.mjs');
  const f = studioFixture(t);
  const delivered = compactDelivery('studio_deliver', {}, await deliverKernel(f.input(incidentJob('System')), f.deps));
  assert.equal(delivered.result, 'delivered', JSON.stringify(delivered)); // English since 16/10
  assert.deepEqual(delivered.producerNotes.map(n => [n.name, n.studioName, n.requested]), [['System', '(System)', ['System']]]);
  const g = studioFixture(t);
  const refused = compactDelivery('studio_deliver', {}, await deliverKernel(g.input(incidentJob('Sistema')), g.deps));
  assert.equal(refused.code, 'PRODUCER_UNKNOWN');
  assert.deepEqual(refused.available, ['(System)', 'OutSystemsUI']);
  assert.equal(refused.continuation.tool, 'studio_deliver');
});

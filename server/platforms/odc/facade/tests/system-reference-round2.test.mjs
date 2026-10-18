// fix/system-reference round 2 (review C:\t\revisoes\system-ref: H1, M1, M2, M3, M4). The shape of the incident of 15/10 (an
// ODC app adds a (System) element by a reference op) with the names a tenant really has: 13 of 25 libraries of wrightflood
// have a space in their name ("OutSystems UI", "Flood Utilities"). A fake bridge offers the producers by the names the Studio
// lists and refuses any other name as the bridge does. Nothing here starts a process or a Studio; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, referenceSnapshot } from '../kernel-delivery.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { autoCaptures, producerArgs, deliverOutcome } from '../o11-cycle.mjs';
import { jobTool } from '../job-runner.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import * as producerNames from '../producer-names.mjs';
const { bindingKeyOf } = producerNames;

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'fixture.test';
const keyOf = name => 'k-' + name.replace(/[^A-Za-z0-9]/g, '');
const envelope = (name, { revision = '7', hash = 'aaaaaaaa-0000-1111-2222-333333333333' } = {}) => JSON.stringify({ FormatVersion: 2, Environment: HOST,
  ModuleKey: keyOf(name), ApplicationKey: '', ModuleKind: 'eSpace', ModuleType: 'ReactiveLibrary', Name: name, SignatureHash: hash, Revision: revision,
  Elements: [{ Kind: 'client-action', Name: 'ListAppendAll', Key: 'kListAppendAll' }] });
const job = (...producers) => ({ ops: producers.map(producer => ({ op: 'reference', producer, elements: ['ClientAction:ListAppendAll'] })) });
// The kernel's rule for a name the job writes (JobSources.BindingKey, kernel tests SystemReferenceRound2Tests): the facade's
// binding must be the key the kernel computes for the job's own spelling, else the build would refuse "not bound".
const kernelKey = name => bindingKeyOf(name);

function fixture(t, { offered = ['(System)', 'OutSystems UI', 'Flood Utilities', 'Flood-Utils'], state = { revision: '7' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sysref-r2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const studio = async ([step, argument]) => {
    if (step === 'reference-snapshot') {
      const request = JSON.parse(argument);
      calls.push({ step, producer: request.producer, output: request.output });
      // ReferenceCommands.cs: by name or key, case-insensitive, as the session lists it.
      const name = offered.find(n => n.toLowerCase() === String(request.producer).toLowerCase());
      if (!name) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      const bytes = envelope(name, { revision: state.revision });
      fs.mkdirSync(path.dirname(request.output), { recursive: true });
      fs.writeFileSync(request.output, bytes, { flag: 'wx' });
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: name, producerKey: keyOf(name), revision: state.revision };
    }
    calls.push({ step });
    if (step === 'reference-producers') return { ok: true, producers: offered.map(name => ({ name, key: keyOf(name) })) };
    if (step === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'HASH', host: HOST };
    if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    return { ok: true };
  };
  const applied = [];
  let lab = 0, applyAnswer = null;
  const deps = { root, nextLabDir: () => path.join(root, 'attempt-' + (++lab)), journal: () => {}, studio, signatureCache: path.join(root, '.local', 'producer-cache'),
    apply: async input => { applied.push(input.producers); calls.push({ step: 'apply' }); return applyAnswer ?? { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => { calls.push({ step: 'manifest' }); return { ok: true, manifest: 'manifest.json' }; } };
  const input = (document, name = 'job.json') => { fs.writeFileSync(path.join(root, name), JSON.stringify(document)); return { module: 'FloodQuotes', feature: 'f', job: name, owners: ['A'], changes: ['B'] }; };
  return { root, calls, applied, deps, input, studio, state, steps: () => calls.map(c => c.step), setApply: a => { applyAnswer = a; } };
}

// ---- H1

for (const [written, key] of [['OutSystems UI', 'OutSystemsUI'], ['Flood Utilities', 'FloodUtilities'], ['(Flood Utilities)', 'FloodUtilities'],
  ['Flood-Utils', 'FloodUtils'], ['System ', 'System'], ['(System) ', 'System']]) {
  test('H1: "' + written + '" is a producer name: captured from the consumer session and bound by the key the kernel computes', async t => {
    const f = fixture(t);
    const result = await deliverKernel({ ...f.input(job(written)), until: 'build' }, f.deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    // One capture: under the Studio's form of the name, else (a "(Name)" the session lists bare) once more under the listed name.
    const taken = f.calls.filter(c => c.step === 'reference-snapshot').map(c => c.producer);
    assert.ok(taken.length === 1 || (taken.length === 2 && f.steps().includes('reference-producers')), JSON.stringify(taken));
    assert.ok(['(System)', 'OutSystems UI', 'Flood Utilities', 'Flood-Utils'].includes(taken.at(-1)), taken.at(-1));
    assert.deepEqual(Object.keys(f.applied[0]), [key]);
    assert.equal(kernelKey(written).toLowerCase(), key.toLowerCase());
    // The capture file is named by the key (letters, digits, underscore), inside this delivery's evidence folder.
    assert.equal(path.dirname(f.applied[0][key]), result.evidence);
    assert.match(path.basename(f.applied[0][key]), /^[A-Za-z0-9_]+\.avsig$/);
  });
}

test('H1: a session that lists the compact name ("OutSystemsUI") resolves the spaced one by its letters, with a note', async t => {
  const f = fixture(t, { offered: ['(System)', 'OutSystemsUI', 'FloodUtilities'] });
  const result = await deliverKernel({ ...f.input(job('OutSystems UI', 'Flood Utilities')), until: 'build' }, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(f.applied[0]).sort(), ['FloodUtilities', 'OutSystemsUI']);
  assert.deepEqual(result.producerNotes.map(n => n.studioName).sort(), ['FloodUtilities', 'OutSystemsUI']);
  assert.ok(result.producerNotes.every(n => /lists "/.test(n.note)));
});

test('H1: every name the PRODUCER_UNKNOWN refusal offers binds when resubmitted (no loop)', async t => {
  const f = fixture(t);
  const refused = await deliverKernel(f.input(job('Sistema')), f.deps);
  assert.equal(refused.code, 'PRODUCER_UNKNOWN');
  assert.deepEqual(refused.available, ['(System)', 'Flood Utilities', 'Flood-Utils', 'OutSystems UI']);
  for (const name of refused.available) {
    const { patch, basedOn, ...rest } = refused.continuation.arguments;
    const patched = resolvePatchedJob({ patch: patch.map(p => ({ ...p, value: name })), basedOn }, { root: f.root, inlineDir: path.join(f.root, '.local', 'jobs', 'inline') });
    assert.equal(patched.ok, true, JSON.stringify(patched));
    f.applied.length = 0;
    const again = await deliverKernel({ ...rest, job: patched.path, until: 'build' }, f.deps);
    assert.equal(again.ok, true, name + ': ' + JSON.stringify(again));
    assert.equal(Object.keys(f.applied[0]).length, 1);
    assert.equal(Object.keys(f.applied[0])[0].toLowerCase(), kernelKey(name).toLowerCase(), name);
  }
});

test('H1: two producers the session lists for one name (the same letters and digits) are never guessed: ONE refusal lists both', async t => {
  const f = fixture(t, { offered: ['(System)', 'Flood Utils', 'FloodUtils.'] });
  const result = await deliverKernel(f.input(job('Flood-Utils')), f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRODUCER_AMBIGUOUS');
  assert.deepEqual(result.candidates, ['Flood Utils', 'FloodUtils.']);
  assert.equal(result.problems.length, 1);
  assert.equal(result.continuation.tool, 'studio_deliver');
  assert.ok(!f.steps().includes('apply') && !f.steps().includes('merge'));
  assert.deepEqual(producerNames.resolveListedName?.('Flood-Utils', ['Flood Utils', 'FloodUtils.'])?.ambiguous, ['Flood Utils', 'FloodUtils.']);
});

test('H1: a name with / or \\ is never resolved by its letters, never captured, never a path: ONE refusal with the producers offered', async t => {
  const f = fixture(t);
  for (const written of ['..\\System', 'a/OutSystems UI']) {
    f.calls.length = 0;
    const result = await deliverKernel(f.input(job(written)), f.deps);
    assert.equal(result.code, 'PRODUCER_UNKNOWN', JSON.stringify(result));
    assert.match(result.error, /matched only by its exact text/);
    assert.deepEqual(result.available, ['(System)', 'Flood Utilities', 'Flood-Utils', 'OutSystems UI']);
    assert.ok(!f.calls.some(c => c.step === 'reference-snapshot'), 'no capture under that name');
    assert.ok(!f.steps().includes('apply'));
  }
});

test('H1: a capture path stays a path (left to the kernel\'s guard), never captured as a name', async t => {
  const f = fixture(t);
  for (const written of ['..\\..\\fx\\System.avsig', '(System)\\..\\x.avsig', 'C:\\loose\\System.AVSIG']) {
    f.calls.length = 0; f.applied.length = 0;
    await deliverKernel({ ...f.input(job(written)), until: 'build' }, f.deps);
    assert.ok(!f.calls.some(c => c.step === 'reference-snapshot'), written);
    assert.deepEqual(f.applied[0], {}, written);
    assert.equal(bindingKeyOf(written), null);
  }
});

test('H1 (o11): the spaced names are captured as Key=Name and bound by their key', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sysref-r2-o11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job('OutSystems UI', '(System) ', 'Flood-Utils')));
  assert.deepEqual(autoCaptures(file), ['OutSystemsUI=OutSystems UI', 'System=(System)', 'FloodUtils=Flood-Utils']);
  const capture = path.join(dir, 'x.avsig');
  assert.deepEqual(producerArgs({ 'OutSystems UI': capture }), ['--producer', 'OutSystemsUI=' + capture]);
  assert.deepEqual(producerArgs({ 'OutSystems UI': 'published' }), ['--capture-producer', 'OutSystemsUI=OutSystems UI']);
});

// ---- M2

test('M2: the PRODUCER_UNKNOWN continuation keeps until and the producers the call bound; following it literally never merges', async t => {
  const f = fixture(t, { offered: ['(System)', 'OutSystemsUI'] });
  const given = path.join(f.root, 'given', 'System-given.avsig');
  fs.mkdirSync(path.dirname(given), { recursive: true }); fs.writeFileSync(given, envelope('(System)'));
  const first = await deliverKernel({ ...f.input(job('(System)', 'Sistema')), until: 'preview', producers: { '(System)': given } }, f.deps);
  assert.equal(first.code, 'PRODUCER_UNKNOWN');
  assert.equal(first.continuation.arguments.until, 'preview');
  assert.deepEqual(first.continuation.arguments.producers, { '(System)': given });
  // Followed literally, with a name of available for the placeholder and the tool's default until when absent.
  const { patch, basedOn, ...rest } = first.continuation.arguments;
  const patched = resolvePatchedJob({ patch: patch.map(p => ({ ...p, value: 'OutSystemsUI' })), basedOn }, { root: f.root, inlineDir: path.join(f.root, '.local', 'jobs', 'inline') });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  const before = f.calls.length; f.applied.length = 0;
  const second = await deliverKernel({ ...rest, job: patched.path, until: rest.until ?? 'merge' }, f.deps);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(!f.calls.slice(before).some(c => c.step === 'merge'), 'no merge');
  assert.equal(f.applied[0].System, given, 'the given capture is bound');
  // A refusal of a call that merges keeps no until (the tool's default).
  const g = fixture(t, { offered: ['(System)'] });
  const merging = await deliverKernel(g.input(job('Sistema')), g.deps);
  assert.equal('until' in merging.continuation.arguments, false);
  assert.equal('producers' in merging.continuation.arguments, false);
});

// ---- M1

test('M1: after studio_reference_snapshot and a republication outside the SSAM, ONE PRODUCER_CHANGED, then delivered', async t => {
  const f = fixture(t);
  const taken = await referenceSnapshot({ module: 'FloodQuotes', producer: '(System)', output: path.join(f.root, 'snapshots', 'System-producer.avsig') }, { studio: f.studio, cache: f.deps.signatureCache });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  f.state.revision = '8'; // published again, unseen by the SSAM
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const r = await deliverKernel(f.input(job('(System)')), f.deps);
    codes.push(r.ok ? r.result : r.code);
    if (r.ok) break;
    // The continuation of the refusal says what the next call does, and it is that call.
    if (r.code === 'PRODUCER_CHANGED') assert.match(r.continuation.why, /builds on the version of the producer this call acquired/);
  }
  assert.deepEqual(codes, ['PRODUCER_CHANGED', 'delivered']); // the English result since 16/10 (result-values.mjs)
});

test('M1: a capture-folder capture proven out of date is never reused; one of the same identity still is', async t => {
  const { rememberOdcReference, reuseOdcCapture } = await import('../producer-signatures.mjs');
  const f = fixture(t);
  const capture = path.join(f.root, 'snapshots', 'System-producer.avsig');
  fs.mkdirSync(path.dirname(capture), { recursive: true }); fs.writeFileSync(capture, envelope('(System)', { revision: '7' }));
  const take = () => reuseOdcCapture(f.root, f.deps.signatureCache, { environment: HOST, producer: 'System', target: path.join(f.root, 'out-' + Math.random().toString(16).slice(2) + '.avsig') });
  assert.equal(take()?.from, capture, 'nothing known against it: reused');
  // The delivery cache now holds a later observation of another revision (what a PRODUCER_CHANGED keeps).
  const later = path.join(f.root, 'later.avsig'); fs.writeFileSync(later, envelope('(System)', { revision: '8' }));
  assert.ok(rememberOdcReference(f.deps.signatureCache, { environment: HOST, producer: 'System', studioName: '(System)', file: later, sha256: sha(fs.readFileSync(later)), now: new Date(Date.now() + 1000) }));
  assert.equal(take(), null, 'proven out of date: never reused');
  // A later observation of the same revision proves nothing against it.
  const same = path.join(f.root, 'same.avsig'); fs.writeFileSync(same, envelope('(System)', { revision: '7' }));
  assert.ok(rememberOdcReference(f.deps.signatureCache, { environment: HOST, producer: 'System', studioName: '(System)', file: same, sha256: sha(fs.readFileSync(same)), now: new Date(Date.now() + 2000) }));
  assert.equal(take()?.from, capture);
});

// ---- M3 (the kernel's REFERENCE_OUTDATED: kernel tests SystemReferenceRound2OdcTests and the CLI replay of round 2)

test('M3: REFERENCE_OUTDATED continues with the Studio\'s refresh of that reference, then the same delivery; never "capture again"', async t => {
  const f = fixture(t);
  f.setApply({ ok: false, receipt: 'kernel-result.json', error: 'Kernel candidate must be accepted and valid before delivery.', problems: [{ op: 0, pointer: '/ops/0', code: 'REFERENCE_OUTDATED', severity: 'error', phase: 'apply',
    message: 'InvalidOperationException: Reference version differs from the captured signature; refresh the consumer\'s reference to it in the Studio, then deliver again: (System)',
    fix: 'the consumer module references (System) at another version than its published signature: refresh that reference in the Studio (studio_refresh_references {module: the consumer module, producer: "(System)"}; it writes to the module, so the person confirms it first), then deliver the same job again', patch: null }] });
  const result = await deliverKernel({ ...f.input(job('System')), pid: 4242 }, { ...f.deps, guide: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REFERENCE_OUTDATED');
  assert.equal(result.failed, 'build');
  assert.deepEqual(result.continuation.arguments, { module: 'FloodQuotes', producer: '(System)', pid: 4242 });
  assert.equal(result.continuation.tool, 'studio_refresh_references');
  assert.match(result.continuation.why, /ask the person first/);
  assert.doesNotMatch(JSON.stringify(result.continuation), /capture (it|the producer) again/i);
  assert.equal(result.continuation.then.tool, 'studio_deliver');
  assert.equal(result.continuation.then.arguments.job, 'job.json');
  assert.ok(!f.steps().includes('merge'));
});

// ---- M4 (the kernel's coded PRODUCER_UNKNOWN: kernel tests SystemReferenceRound2Tests)

const KERNEL_UNKNOWN = { code: 'PRODUCER_UNKNOWN', error: 'SignatureCaptureException: ProducerNotFound: Sistema is not referenceable in lab.example. The referenceable catalog lists: (System), (Tools), Users.',
  problems: [{ op: null, pointer: null, code: 'PRODUCER_UNKNOWN', severity: 'error', phase: 'reference', message: 'ProducerNotFound: Sistema is not referenceable in lab.example. The referenceable catalog lists: (System), (Tools), Users.',
    fix: 'name a producer the referenceable catalog lists (available), as the Studio lists it, e.g. "(System)" for the system producer', producer: 'Sistema', available: ['(System)', '(Tools)', 'Users'] }] };

test('M4: o11_deliver answers an unknown producer as ODC does: PRODUCER_UNKNOWN, available, and the same delivery with the capture bound to a listed name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sysref-r2-m4-'));
  try {
    const file = path.join(root, 'job.json'); fs.writeFileSync(file, JSON.stringify(job('Sistema')));
    const state = { taskId: '0123456789abcdef0123456789abcdef', stage: 'producer-signatures', writeState: 'not-sent', delivered: false, code: KERNEL_UNKNOWN.code,
      problems: KERNEL_UNKNOWN.problems, error: KERNEL_UNKNOWN.error, request: { JobPath: file } };
    const answer = deliverOutcome({ envelope: { ok: true, data: state } }, { trackId: 't1', work: root, job: file, taskId: state.taskId, input: { module: 'Consumer', job: file, producers: 'published' } });
    assert.equal(answer.code, 'PRODUCER_UNKNOWN', JSON.stringify(answer));
    assert.deepEqual(answer.available, ['(System)', '(Tools)', 'Users']);
    assert.equal(answer.continuation.tool, 'o11_deliver');
    assert.deepEqual(answer.continuation.arguments.captureProducers, ['Sistema=<a name of available>']);
    assert.equal(answer.continuation.arguments.module, 'Consumer');
    assert.equal(answer.continuation.arguments.job, file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('M4: o11_job answers the kernel\'s PRODUCER_UNKNOWN with available and the same call bound to a listed name', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sysref-r2-m4j-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tests', 'jobs', 'ref-sistema.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(job('Sistema')));
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: path.join(root, 'auth'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  fs.mkdirSync(env.ANVIL_AUTHORITY_DIR, { recursive: true });
  const runAnvil = fakeAnvil({ signature: () => ({ exitCode: 1, envelope: { ok: false, command: 'signature', ...KERNEL_UNKNOWN } }) });
  let clock = 1000;
  const r = await jobTool({ lane: 'o11', job: file, captureProducers: ['Sistema'] }, { root, env, o11Lane: 'ss4', now: () => (clock += 10), runAnvil });
  assert.equal(r.code, 'PRODUCER_UNKNOWN', JSON.stringify(r));
  assert.deepEqual(r.available, ['(System)', '(Tools)', 'Users']);
  assert.equal(r.continuation.tool, 'o11_job');
  assert.deepEqual(r.continuation.arguments.captureProducers, ['Sistema=<a name of available>']);
  assert.equal(r.continuation.arguments.job, file);
});

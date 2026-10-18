// fix/system-reference round 3 (review C:\t\revisoes\system-ref-2: H1-R, M5, M3-R with B4, B5). A fake consumer session lists
// each producer with its OWN module key; a fake kernel apply binds what the capture really is and refuses REFERENCE_OUTDATED
// as OdcReferenceImporter does (an existing reference at another signature than the capture). Synthetic values only;
// nothing here starts a process or a Studio; every folder is temporary.
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

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'fixture.test';
const OUTDATED = name => [{ op: 0, pointer: '/ops/0', code: 'REFERENCE_OUTDATED', severity: 'error', phase: 'apply',
  message: 'InvalidOperationException: Reference version differs from the captured signature; refresh the consumer\'s reference to it in the Studio, then deliver again: ' + name,
  fix: 'refresh that reference in the Studio (studio_refresh_references), then deliver the same job again', patch: null }];

// listed: [{name, key}]; state.published[key] the producer's latest revision; state.consumer[key] the revision the consumer
// module references it at (absent: no reference yet).
function world(t, listed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { published: Object.fromEntries(listed.map(p => [p.key, 7])), consumer: {} };
  const calls = [];
  const envelope = (p, rev = state.published[p.key]) => JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: p.key, ApplicationKey: '', ModuleKind: 'eSpace',
    ModuleType: 'ReactiveLibrary', Name: p.name, SignatureHash: 'hash-' + p.key + '-' + rev, Revision: String(rev), Elements: [{ Kind: 'client-action', Name: 'ListAppendAll', Key: 'kL' }] });
  const studio = async ([step, argument, ...rest]) => {
    if (step === 'reference-snapshot') {
      const request = JSON.parse(argument);
      calls.push('reference-snapshot ' + request.producer);
      // ReferenceCommands.cs: by name or by key, case-insensitive.
      const p = listed.find(x => x.name.toLowerCase() === String(request.producer).toLowerCase() || x.key === request.producer);
      if (!p) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      const bytes = envelope(p);
      fs.mkdirSync(path.dirname(request.output), { recursive: true });
      fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: p.name, producerKey: p.key, revision: String(state.published[p.key]) };
    }
    if (step === 'refresh-references') {
      calls.push('refresh-references ' + [argument, ...rest].join(' '));
      for (const key of Object.keys(state.consumer)) state.consumer[key] = state.published[key];
      return { ok: true };
    }
    calls.push(step);
    if (step === 'reference-producers') return { ok: true, producers: listed.map(p => ({ name: p.name, key: p.key })) };
    if (step === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'HASH', host: HOST };
    if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    return { ok: true };
  };
  const applied = [];
  let lab = 0, n = 0;
  const deps = { root, nextLabDir: () => path.join(root, 'attempt-' + (++lab)), journal: () => {}, studio, cache: null, guide: null,
    signatureCache: path.join(root, '.local', 'producer-cache'),
    apply: async input => {
      const bound = Object.fromEntries(Object.entries(input.producers).map(([k, f]) => [k, JSON.parse(fs.readFileSync(f, 'utf8'))]));
      applied.push(Object.fromEntries(Object.entries(bound).map(([k, e]) => [k, e.Name + ' #' + e.ModuleKey + '@' + e.Revision])));
      calls.push('apply');
      const references = [];
      for (const e of Object.values(bound)) {
        const at = state.consumer[e.ModuleKey];
        if (at != null && String(at) !== String(e.Revision)) return { ok: false, receipt: 'kernel-result.json', error: 'Kernel candidate must be accepted and valid before delivery.', problems: OUTDATED(e.Name) };
        references.push({ producer: e.Name, producerKey: e.ModuleKey, signatureHash: e.SignatureHash, referenceExisted: at != null, referenceHashBefore: at != null ? 'hash-' + e.ModuleKey + '-' + at : null });
      }
      return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json', references };
    },
    prepareManifest: async () => { calls.push('manifest'); return { ok: true, manifest: 'manifest.json' }; } };
  // The merge makes the consumer reference each bound producer at the revision bound (what the Studio then holds).
  const merged = () => { const last = applied.at(-1) ?? {}; for (const v of Object.values(last)) { const [, rest] = v.split(' #'); const [key, rev] = rest.split('@'); state.consumer[key] = Number(rev); } };
  const wrapped = async ([step, ...a], pid) => { const r = await studio([step, ...a], pid); if (step === 'merge' && r.ok) merged(); return r; };
  deps.studio = wrapped;
  const input = (written, extra = {}) => {
    const file = 'job-' + (++n) + '.json';
    fs.writeFileSync(path.join(root, file), JSON.stringify({ ops: written.map(producer => ({ op: 'reference', producer, elements: ['ClientAction:ListAppendAll'] })) }));
    return { module: 'FloodQuotes', feature: 'f', job: file, owners: ['A'], changes: ['B'], ...extra };
  };
  // A refusal's continuation followed literally (studio_refresh_references, then `then`; studio_deliver with patch + basedOn).
  const follow = async (refused, value) => {
    const c = refused.continuation;
    if (c.tool === 'studio_refresh_references') {
      await wrapped(['refresh-references', c.arguments.module, ...(c.arguments.producer ? ['--producer', c.arguments.producer] : [])]);
      return deliverKernel(c.then.arguments, deps);
    }
    const { patch, basedOn, ...rest } = c.arguments;
    if (!patch) return deliverKernel(rest, deps);
    const patched = resolvePatchedJob({ patch: patch.map(p => ({ ...p, value })), basedOn }, { root, inlineDir: path.join(root, '.local', 'jobs', 'inline') });
    assert.equal(patched.ok, true, JSON.stringify(patched));
    return deliverKernel({ ...rest, job: patched.path }, deps);
  };
  return { root, state, calls, applied, deps, input, studio: wrapped, follow, envelope, snaps: () => calls.filter(c => c.startsWith('reference-snapshot')).map(c => c.slice(19)) };
}
const outcome = r => (r.ok ? 'delivered' : r.code);

// ---- H1-R: a producer listed with / or \ binds by its EXACT text only, by the key of the listed name

const SLASHED = [{ name: 'Wright/Flood Lib', key: 'kW' }, { name: 'Flood\\Tools', key: 'kT' }, { name: '(System)', key: 'kS' }, { name: 'OutSystems UI', key: 'kA' }];

for (const [written, key, listed] of [['Wright/Flood Lib', 'WrightFloodLib', 'kW'], [' Wright/Flood Lib ', 'WrightFloodLib', 'kW'], ['wright/flood lib', 'WrightFloodLib', 'kW'], ['Flood\\Tools', 'FloodTools', 'kT']]) {
  test('H1-R: the listed "' + written.trim() + '" written as listed delivers in one call, bound by the listed name\'s key', async t => {
    const w = world(t, SLASHED);
    const r = await deliverKernel(w.input([written]), w.deps);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(Object.keys(w.applied[0]).length, 1);
    assert.equal(Object.keys(w.applied[0])[0].toLowerCase(), key.toLowerCase());
    assert.match(Object.values(w.applied[0])[0], new RegExp('#' + listed + '@'));
    // The capture file is named by the key, inside the delivery's evidence folder.
    assert.match(path.basename(r.producers[0].path), /^[A-Za-z0-9_]+\.avsig$/);
    assert.equal(path.dirname(r.producers[0].path), r.evidence);
  });
}

test('H1-R: every name of available, with / and \\ included, binds when resubmitted (no loop)', async t => {
  const w = world(t, SLASHED);
  const refused = await deliverKernel(w.input(['Sistema']), w.deps);
  assert.equal(refused.code, 'PRODUCER_UNKNOWN');
  for (const name of refused.available) {
    w.applied.length = 0;
    const again = await w.follow(refused, name);
    assert.equal(again.ok, true, name + ': ' + JSON.stringify(again));
    assert.match(Object.values(w.applied[0])[0], new RegExp('^' + name.replace(/[\\()]/g, '\\$&') + ' #'));
  }
});

test('H1-R: a name with / or \\ never binds by its letters: "..\\System" and "Wright Flood/Lib" are refused once, truthfully', async t => {
  const w = world(t, SLASHED);
  for (const written of ['..\\System', 'Wright Flood/Lib', 'WrightFlood/Lib']) {
    w.calls.length = 0; w.applied.length = 0;
    const r = await deliverKernel(w.input([written]), w.deps);
    assert.equal(r.code, 'PRODUCER_UNKNOWN', written + ': ' + JSON.stringify(r));
    assert.doesNotMatch(r.error, /never bound/);
    assert.match(r.error, /only by its exact text/);
    assert.ok(r.available.includes('Wright/Flood Lib'));
    assert.deepEqual(w.applied, [], 'nothing built');
    assert.ok(!w.snaps().length, 'no capture');
  }
});

test('H1-R (o11): a listed name with / is captured as Key=Name and bound by its key; "..\\System" never binds System', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr3-o11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'reference', producer: 'Wright/Flood Lib', elements: ['ServerAction:A'] }] }));
  assert.deepEqual(autoCaptures(file), ['WrightFloodLib=Wright/Flood Lib']);
  const capture = path.join(dir, 'x.avsig');
  // fix/a5-lows (B10, declared change): a binding name with / or \ is matched against the job's names (o11_deliver gives them).
  const names = ['Wright/Flood Lib'];
  assert.deepEqual(producerArgs({ 'Wright/Flood Lib': 'published' }, [], { names }), ['--capture-producer', 'WrightFloodLib=Wright/Flood Lib']);
  assert.deepEqual(producerArgs({ 'Wright/Flood Lib': capture }, [], { names }), ['--producer', 'WrightFloodLib=' + capture]);
  // "..\System" is captured by its exact text only (the catalog has no such producer: one PRODUCER_UNKNOWN), never as (System).
  fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'reference', producer: '..\\System', elements: ['ServerAction:A'] }] }));
  assert.deepEqual(autoCaptures(file), ['System=..\\System']);
});

// ---- M5: two listed producers with one compact key: the binding is a LISTED producer, never the other one

const TWINS = [{ name: 'Flood Utils', key: 'kSpace' }, { name: 'Flood-Utils', key: 'kHyphen' }, { name: '(System)', key: 'kS' }];

test('M5 (N3b): one job naming both twins exactly gets ONE PRODUCER_AMBIGUOUS, nothing built', async t => {
  const w = world(t, TWINS);
  const r = await deliverKernel(w.input(['Flood Utils', 'Flood-Utils']), w.deps);
  assert.equal(r.code, 'PRODUCER_AMBIGUOUS', JSON.stringify(r));
  assert.deepEqual(r.candidates, ['Flood Utils', 'Flood-Utils']);
  assert.match(r.error, /cannot bind/);
  assert.deepEqual(w.applied, []);
});

test('M5: one job naming ONE listed producer in two spellings is one producer, one capture', async t => {
  const w = world(t, [{ name: 'OutSystems UI', key: 'kA' }, { name: '(System)', key: 'kS' }]);
  const r = await deliverKernel(w.input(['OutSystems UI', 'OutSystemsUI']), w.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(w.applied[0], { OutSystemsUI: 'OutSystems UI #kA@7' });
});

for (const [first, second, expect] of [['Flood Utils', 'Flood-Utils', 'kHyphen'], ['Flood-Utils', 'Flood Utils', 'kSpace']]) {
  test('M5 (N3c): "' + first + '" delivered, then "' + second + '": the ledger of the first is never reused for the second', async t => {
    const w = world(t, TWINS);
    assert.equal((await deliverKernel(w.input([first]), w.deps)).ok, true);
    w.applied.length = 0; w.calls.length = 0;
    const r = await deliverKernel(w.input([second]), w.deps);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(Object.values(w.applied[0])[0], new RegExp('#' + expect + '@'));
    assert.deepEqual(w.snaps(), [second], 'acquired under the name the job writes, once');
    assert.equal(r.producers[0].studioName, second);
  });
}

test('M5 (N3d): a capture-folder capture of one twin is never reused for the other', async t => {
  const w = world(t, TWINS);
  const taken = await referenceSnapshot({ module: 'FloodQuotes', producer: 'Flood Utils', output: path.join(w.root, 'snapshots', 'FloodUtils-producer.avsig') }, { studio: w.studio, cache: null });
  assert.equal(taken.ok, true);
  w.calls.length = 0;
  const r = await deliverKernel(w.input(['Flood-Utils']), w.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(Object.values(w.applied[0])[0], /#kHyphen@/);
});

test('M5 (N3a): after PRODUCER_AMBIGUOUS, each candidate delivered in turn binds itself', async t => {
  const w = world(t, TWINS);
  const amb = await deliverKernel(w.input(['FloodUtils']), w.deps);
  assert.equal(amb.code, 'PRODUCER_AMBIGUOUS');
  for (const [candidate, key] of [[amb.candidates[0], 'kSpace'], [amb.candidates[1], 'kHyphen']]) {
    w.applied.length = 0;
    const r = await w.follow(amb, candidate);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(Object.values(w.applied[0])[0], new RegExp('#' + key + '@'));
  }
});

for (const [first, second, expect] of [['FloodUtils', 'Flood Utils', 'kSpace'], ['Flood Utils', 'FloodUtils', 'kBare']]) {
  test('M5: identifier twin: "' + first + '" then "' + second + '" binds the second exactly, no false PRODUCER_CHANGED', async t => {
    const w = world(t, [{ name: 'FloodUtils', key: 'kBare' }, { name: 'Flood Utils', key: 'kSpace' }, { name: '(System)', key: 'kS' }]);
    assert.equal((await deliverKernel(w.input([first]), w.deps)).ok, true);
    w.applied.length = 0;
    const r = await deliverKernel(w.input([second]), w.deps);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(Object.values(w.applied[0])[0], new RegExp('#' + expect + '@'));
  });
}

test('M5 (N8): a listed "System." is that producer, never (System) by a shortcut; the note never says otherwise', async t => {
  const w = world(t, [{ name: 'System.', key: 'kUser' }, { name: '(System)', key: 'kS' }]);
  const r = await deliverKernel({ ...w.input(['System.']), until: 'build' }, w.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(Object.values(w.applied[0])[0], /^System\. #kUser@/);
  assert.equal(r.producerNotes, undefined);
  // and "System" (no listed "System") is still the system producer
  w.applied.length = 0;
  const s = await deliverKernel({ ...w.input(['System']), until: 'build' }, w.deps);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.match(Object.values(w.applied[0])[0], /^\(System\) #kS@/);
});

test('M5 (o11): autoCaptures of a job naming one key in two spellings is ONE PRODUCER_AMBIGUOUS refusal, never one merged capture', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr3-o11t-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'reference', producer: 'Flood Utils', elements: ['ServerAction:A'] }, { op: 'reference', producer: 'Flood-Utils', elements: ['ServerAction:B'] }] }));
  assert.throws(() => autoCaptures(file), e => e.code === 'PRODUCER_AMBIGUOUS' && /Flood Utils/.test(e.message) && /Flood-Utils/.test(e.message));
  // (System) and System are one spelling of one producer
  fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'reference', producer: '(System)', elements: ['ServerAction:A'] }, { op: 'reference', producer: 'System', elements: ['ServerAction:B'] }] }));
  assert.deepEqual(autoCaptures(file), ['System=(System)']);
});

// ---- M3-R and B4: REFERENCE_OUTDATED with a reused or given capture older than the consumer: at most one refusal

const SYSTEM = [{ name: '(System)', key: 'kS' }];

test('M3-R (N5): a ledger capture older than the consumer is acquired again in the same call and the delivery goes through', async t => {
  const w = world(t, SYSTEM);
  assert.equal((await deliverKernel(w.input(['(System)']), w.deps)).ok, true); // ledger and consumer at 7
  w.state.published.kS = 8; w.state.consumer.kS = 8; // published again and refreshed outside the SSAM
  w.applied.length = 0;
  const r = await deliverKernel(w.input(['(System)']), w.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(w.applied.map(a => a.System), ['(System) #kS@7', '(System) #kS@8']);
  assert.match(r.producers[0].note ?? '', /acquired again/);
});

test('M3-R (N5b): a given capture older than the consumer: acquired again, built on the fresh one, the given one named in the receipt', async t => {
  const w = world(t, SYSTEM);
  const given = path.join(w.root, 'given', 'System-given.avsig');
  fs.mkdirSync(path.dirname(given), { recursive: true }); fs.writeFileSync(given, w.envelope(SYSTEM[0], 7));
  w.state.published.kS = 8; w.state.consumer.kS = 8;
  const r = await deliverKernel(w.input(['(System)'], { producers: { '(System)': given } }), w.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.applied.at(-1).System, '(System) #kS@8');
  assert.match(r.producers[0].note ?? '', /given capture/);
});

test('M3-R (N5c): a capture-folder capture older than the consumer: acquired again in the same call', async t => {
  const w = world(t, SYSTEM);
  const capture = path.join(w.root, 'snapshots', 'System-producer.avsig');
  fs.mkdirSync(path.dirname(capture), { recursive: true }); fs.writeFileSync(capture, w.envelope(SYSTEM[0], 7));
  w.state.published.kS = 8; w.state.consumer.kS = 8;
  const r = await deliverKernel(w.input(['(System)']), w.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.applied.at(-1).System, '(System) #kS@8');
});

test('M3-R (control): a consumer really behind the published producer: ONE REFERENCE_OUTDATED, the refresh, then delivered', async t => {
  const w = world(t, SYSTEM);
  w.state.consumer.kS = 6; w.state.published.kS = 8;
  const r = await deliverKernel(w.input(['(System)']), w.deps);
  assert.equal(r.code, 'REFERENCE_OUTDATED', JSON.stringify(r));
  assert.equal(r.continuation.tool, 'studio_refresh_references');
  assert.equal(outcome(await w.follow(r)), 'delivered');
});

test('B4 (N7): republished while the consumer references the old version: ONE PRODUCER_CHANGED that names the refresh, then delivered', async t => {
  const w = world(t, SYSTEM);
  assert.equal((await deliverKernel(w.input(['(System)']), w.deps)).ok, true); // ledger and consumer at 7
  w.state.published.kS = 8; // published again outside the SSAM; the consumer still references 7
  const r = await deliverKernel(w.input(['(System)']), w.deps);
  assert.equal(r.code, 'PRODUCER_CHANGED', JSON.stringify(r));
  assert.equal(r.continuation.tool, 'studio_refresh_references');
  assert.equal(r.continuation.then.tool, 'studio_deliver');
  assert.equal(outcome(await w.follow(r)), 'delivered');
});

test('B4: the kernel result of a build says whether each reference existed and at which signature (what the B4 refusal reads)', async () => {
  const { interpretKernelResult, requiredFlowLayoutEngine } = await import('../kernel-delivery.mjs');
  // The shape the real CLI writes (anvil-odc apply, Verbs.PrepareSignatureReference; round-2 replay m3-hashA), synthetic values.
  const result = { ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, results: [
    { op: 'reference', result: { producer: '(System)', producerKey: 'kS', signatureHash: 'H-A', referenceExisted: true, referenceHashBefore: 'H-A', requested: 1 } },
    { op: 'find', result: [{ name: 'ListAppendAll' }] }] } };
  const interpreted = interpretKernelResult(result, { output: os.tmpdir() });
  assert.deepEqual(interpreted.references, [{ producer: '(System)', producerKey: 'kS', signatureHash: 'H-A', referenceExisted: true, referenceHashBefore: 'H-A' }]);
});

// ---- B5: the O11 continuation marker in English

test('B5: the O11 PRODUCER_UNKNOWN continuation asks for the user\'s words with an English marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr3-b5-'));
  try {
    const file = path.join(root, 'job.json'); fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'reference', producer: 'Sistema', elements: ['ServerAction:A'] }] }));
    const problems = [{ code: 'PRODUCER_UNKNOWN', severity: 'error', phase: 'reference', message: 'x', fix: 'y', producer: 'Sistema', available: ['(System)'] }];
    const state = { taskId: '0123456789abcdef0123456789abcdef', stage: 'producer-signatures', writeState: 'not-sent', delivered: false, code: 'PRODUCER_UNKNOWN', problems, error: 'x', request: { JobPath: file } };
    const answer = deliverOutcome({ envelope: { ok: true, data: state } }, { trackId: 't', work: root, job: file, taskId: state.taskId, input: { module: 'C', job: file } });
    assert.equal(answer.continuation.arguments.authorize, '<the user\'s own words>');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

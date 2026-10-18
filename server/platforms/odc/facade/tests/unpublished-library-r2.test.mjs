// fix/unpublished-library round 2 (review C:\t\revisoes\unpublished-lib, findings A1-A5; probes R1-R6 and O1-O2 of
// review\probes): PRODUCER_NOT_PUBLISHED only when publishing the producer is what the job needs. Each case ends in ONE
// truthful refusal, and following its continuation never loops:
//  A1 an element of a kind the ODC published signature cannot hold (a service action) is never "not published";
//  A2 only a module open in an ODC Studio is the open model (this pid, or another Studio that lists it, and then the
//     publication goes there); a module capture of the capture folder is a data hint, never a studio_publish;
//  A3 a closed O11 producer (its published OML, read by the REAL moduleDigest) is never the open model, and the O11 reader
//     never downloads it only to discard it;
//  A4 the open model is matched as the kernel matches the signature (ordinal name, @key; O11 also Flow/Name): another
//     letter case or only the last segment of a path is a spelling problem whose fix names the right spelling;
//  A5 the job-alone check runs on that refusal, its problems are in it, and the job is never said to be right.
// The bridge and the kernel process are faked the way the real ones answer: the bridge exports only the kinds
// OdcPublicSignature.cs reads, without a flow path (Kind, Name, Key), and the kernel's NativeReferenceSnapshot.Select (ODC)
// refuses another kind ("Unsupported element kind ...") and compares names ordinally. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, applyKernel, requiredFlowLayoutEngine, referenceSnapshot } from '../kernel-delivery.mjs';
import { odcProducerModel } from '../producer-publication.mjs';
import { moduleDigest, digestFile, readCapture } from '../module-map.mjs';
import { DIGEST_SECTIONS } from '../module-digest.mjs';
import * as cycle from '../o11-cycle.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const HOST = 'fixture.test';
const CONSUMER = 'QuoteApp';
const MARKER = "<the user's own words>";
const ODC_KINDS = ['structure', 'block', 'client-action', 'action', 'entity'];
// The job's type -> the envelope kind (NativeReferenceKinds.ForType, then the ODC "block"), ordinal.
const KIND = { ServerAction: 'action', IServerAction: 'action', ServiceAction: 'service-action', ClientAction: 'client-action', Structure: 'structure', IMobileBlock: 'block', IBlock: 'block', Role: 'role' };
// The model's element -> its module digest entry (ModuleDigest.cs): actions in the action index, blocks in the ui section.
const DIGEST = { action: 'ServerAction', 'service-action': 'ServiceAction', 'client-action': 'ClientAction' };
const text = value => JSON.stringify(value);

// libraries: {Name: {open: [{kind, name, flow?}] (the live open model, all public), rev, published: [{kind, name}] (its last
// publication), notOpen?: true, openIn?: pid (open only in that ODC Studio), staleCapture?: [{kind, name}] (an older module
// capture in the capture folder)}}
function world(t, { libraries, references = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upr2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captures = path.join(root, 'snapshots'); fs.mkdirSync(captures);
  const state = { libraries: structuredClone(libraries), consumerRefs: Object.fromEntries(references.map(n => [n, libraries[n].rev])) };
  const surfaces = new Map();
  const calls = [];
  for (const [name, lib] of Object.entries(state.libraries)) if (lib.staleCapture) {
    const bytes = 'older capture of ' + name; const file = path.join(captures, name + '-' + sha(bytes).toUpperCase() + '.oml');
    fs.writeFileSync(file, bytes); fs.writeFileSync(file + '.json', JSON.stringify({ capturedAt: '2026-10-15T10:00:00.000Z' }));
    surfaces.set(path.basename(file), lib.staleCapture);
  }
  const studio = async ([step, ...rest], pid) => {
    if (step === 'snapshot') {
      const name = rest[0];
      calls.push('snapshot ' + name + (pid != null ? '@' + pid : ''));
      if (name === CONSUMER) {
        const base = path.join(captures, CONSUMER + '-base.oml');
        fs.writeFileSync(base, 'synthetic consumer ' + JSON.stringify(state.consumerRefs));
        return { ok: true, module: CONSUMER, path: base, sha256: sha(fs.readFileSync(base)).toUpperCase(), host: HOST, developerId: 'dev', moduleKey: 'kConsumer',
          dependencies: Object.entries(state.consumerRefs).map(([Name, rev]) => ({ Name, Revision: String(rev) })) };
      }
      const lib = state.libraries[name];
      if (!lib || lib.notOpen || (lib.openIn != null && lib.openIn !== pid)) return { ok: false, code: 'MODULE_NOT_OPEN', error: "Module '" + name + "' is not open in this ODC Studio." };
      const bytes = 'open model of ' + name + ' ' + JSON.stringify(lib.open);
      const file = path.join(captures, name + '-' + sha(bytes).toUpperCase() + '.oml');
      fs.writeFileSync(file, bytes); surfaces.set(path.basename(file), lib.open);
      return { ok: true, module: name, moduleKey: 'k' + name, path: file, sha256: sha(bytes).toUpperCase(), capturedAt: new Date().toISOString(), host: HOST };
    }
    if (step === 'reference-snapshot') {
      const request = JSON.parse(rest[0]);
      const lib = state.libraries[request.producer];
      calls.push('reference-snapshot ' + request.producer + ' rev ' + lib?.rev);
      if (!lib) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      const exported = (lib.published ?? []).filter(e => ODC_KINDS.includes(e.kind));
      if (!exported.length) return { ok: false, error: 'Producer has no supported public elements' };
      const bytes = JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: 'k' + request.producer, Name: request.producer, ModuleKind: 'eSpace', SignatureHash: 'sig-' + request.producer + '-' + lib.rev,
        Revision: String(lib.rev), Elements: exported.map(e => ({ Kind: e.kind, Name: e.name, Key: 'key' + e.name })) });
      fs.mkdirSync(path.dirname(request.output), { recursive: true }); fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: request.producer, producerKey: 'k' + request.producer, revision: String(lib.rev) };
    }
    calls.push(step);
    // Round 3 (N1, N2): the Studio's status lists the open modules with their tenant, as the bridge does.
    if (step === 'status') return { ok: true, modules: [{ name: CONSUMER, key: 'kConsumer', host: HOST }, ...Object.entries(state.libraries)
      .filter(([, lib]) => !lib.notOpen && (lib.openIn == null || lib.openIn === pid)).map(([name]) => ({ name, key: 'k' + name, host: HOST }))] };
    if (step === 'reference-producers') return { ok: true, producers: Object.keys(state.libraries).map(name => ({ name, key: 'k' + name })) };
    if (step === 'merge') { Object.assign(state.consumerRefs, state.bound ?? {}); return { ok: true, merged: true, strictlyEqual: true }; }
    return { ok: true };
  };
  const producerDigest = async file => {
    const surface = surfaces.get(path.basename(file)) ?? [];
    const name = path.basename(file).replace(/-[0-9A-F]{64}\.oml$/i, '');
    calls.push('digest ' + name);
    const blocks = surface.filter(e => e.kind === 'block');
    return { ok: true, sourceSha256: 'synthetic', digest: { schema: 'ssam-digest/1', module: { name, kind: 'ReactiveLibrary' },
      sections: [{ id: 'ui', blocks: blocks.map(e => ({ key: 'key' + e.name, kind: 'WebBlock', name: e.name, text: 'block ' + (e.flow ?? 'MainFlow') + '/' + e.name + ' @key' + e.name + ' public' })) }],
      actions: surface.filter(e => e.kind !== 'block').map(e => ({ key: 'key' + e.name, kind: DIGEST[e.kind] ?? 'ServerAction', name: e.name, section: 'actions', public: true })) } };
  };
  // Round 3 (N2): each open library was merged by an SSAM delivery and not touched since (its receipt has the open model's hash),
  // so studio_publish {module} can take it, as the chain proposes.
  for (const [name, lib] of Object.entries(libraries)) if (!lib.notOpen) {
    const evidence = path.join(root, 'lab', '01-' + name, 'delivery', 'evidence'); fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, '..', 'manifest.json'), JSON.stringify({ module: name, moduleKey: 'k' + name, tenant: HOST, evidenceDir: evidence }));
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-15T19:00:00Z' }));
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256: sha('open model of ' + name + ' ' + JSON.stringify(lib.open)).toUpperCase() }));
  }
  const cli = path.join(root, 'anvil-odc.dll'); fs.writeFileSync(cli, 'not a CLI');
  const exec = async (_dotnet, argv) => {
    const at = f => argv[argv.indexOf(f) + 1];
    const job = JSON.parse(fs.readFileSync(at('--job'), 'utf8'));
    const bound = Object.fromEntries(argv.filter((_, i) => argv[i - 1] === '--producer').map(p => { const [k, ...f] = p.split('='); return [k, JSON.parse(fs.readFileSync(f.join('='), 'utf8'))]; }));
    calls.push('apply');
    const fail = envelope => { const e = new Error('exit 1'); e.stdout = JSON.stringify({ ok: false, command: 'apply', elapsedMs: 9, verifyRan: false, phases: ['apply'], ...envelope }); e.stderr = ''; e.code = 1; throw e; };
    const results = [];
    for (const [i, op] of job.ops.entries()) {
      if (op.op !== 'reference') continue;
      const signature = bound[op.producer];
      for (const [k, element] of (op.elements ?? []).entries()) {
        const cut = element.indexOf(':'), type = element.slice(0, cut), name = element.slice(cut + 1);
        const kind = KIND[type];
        const message = !ODC_KINDS.includes(kind) ? 'Unsupported element kind for this frozen producer signature: ' + element
          : !signature.Elements.some(e => e.Kind === kind && (e.Name === name || '@' + e.Key === name)) ? 'Element not declared in the frozen producer signature: ' + element : null;
        if (message) fail({ error: 'ArgumentException: ' + message, problems: [{ op: i, pointer: '/ops/' + i + '/elements/' + k, code: 'REFERENCE_ELEMENT_MISSING', severity: 'error', phase: 'apply', message, fix: '(kernel fix text)', patch: null }] });
      }
      const had = state.consumerRefs[op.producer];
      if (had != null && String(had) !== signature.Revision) {
        const message = "Reference version differs from the captured signature; refresh the consumer's reference to it in the Studio, then deliver again: " + op.producer;
        fail({ error: 'InvalidOperationException: ' + message, problems: [{ op: i, pointer: '/ops/' + i, code: 'REFERENCE_OUTDATED', severity: 'error', phase: 'apply', message, fix: 'refresh', patch: null }] });
      }
      results.push({ op: 'reference', result: { producer: op.producer, producerKey: 'k' + op.producer, signatureHash: signature.SignatureHash, referenceExisted: had != null, referenceHashBefore: had != null ? 'sig-' + op.producer + '-' + had : null } });
      (state.bound ??= {})[op.producer] = Number(signature.Revision);
    }
    fs.writeFileSync(at('--out'), 'synthetic candidate');
    return { stdout: JSON.stringify({ ok: true, command: 'apply', data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, validation: {}, results } }), stderr: '' };
  };
  let lab = 0;
  const deps = { root, studio, guide: null, cache: null, journal: () => {}, prefetch: async () => {}, nextLabDir: () => path.join(root, 'lab-' + (++lab)),
    signatureCache: path.join(root, '.local', 'producer-cache'), producerDigest,
    apply: args => applyKernel(args, { cli, runOnWorker: async () => ({ used: false }), exec, contentSha: null }),
    prepareManifest: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); const m = path.join(output, 'manifest.json'); fs.writeFileSync(m, '{}'); return { ok: true, manifest: m }; } };
  const job = (refs, name = 'job.json', extra = []) => { fs.writeFileSync(path.join(root, name), JSON.stringify({ ops: [...refs.map(([producer, elements]) => ({ op: 'reference', producer, elements })), ...extra] })); return name; };
  const input = (file, more = {}) => ({ module: CONSUMER, feature: 'f', job: file, owners: ['Owner'], changes: ['Uses the library'], ...more });
  // The person publishes the producer: its published revision becomes its open model.
  const publishByHand = name => { const lib = state.libraries[name]; lib.published = structuredClone(lib.open); lib.rev += 1; };
  // Follows a refusal's continuation to the letter (publish, refresh, the same delivery), at most four deliveries.
  const follow = async (first, extraDeps = {}) => {
    const codes = [first.ok ? 'delivered' : first.code];
    let step = first.ok ? null : first.continuation, rounds = 0;
    const tools = [];
    while (step && rounds < 4) {
      tools.push(step.tool + (step.arguments?.pid != null ? '@' + step.arguments.pid : ''));
      if (step.tool === 'studio_publish') { assert.equal(step.arguments.authorize, MARKER); publishByHand(step.arguments.module); }
      else if (step.tool === 'studio_refresh_references') state.consumerRefs[step.arguments.producer] = state.libraries[step.arguments.producer].rev;
      else if (step.tool === 'studio_deliver') {
        rounds++;
        const last = await deliverKernel({ ...step.arguments }, { ...deps, ...extraDeps }); codes.push(last.ok ? 'delivered' : last.code);
        if (last.ok) break;
        step = last.continuation; continue;
      } else { codes.push('stop:' + step.tool); break; }
      step = step.then;
    }
    return { codes, tools };
  };
  return { root, captures, state, calls, deps, job, input, follow, publishByHand };
}
const publishes = r => { const tools = []; for (let s = r.continuation; s; s = s.then) tools.push(s.tool); return tools.includes('studio_publish'); };

// ---- A1: a kind the ODC published signature cannot hold ------------------------------------------------------------

test('A1 / R1: a public SERVICE ACTION (a kind the ODC signature never exports) is never PRODUCER_NOT_PUBLISHED: ONE kernel refusal, no publication', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetNcipDetails' }, { kind: 'service-action', name: 'GetRates' }],
    published: [{ kind: 'action', name: 'GetNcipDetails' }, { kind: 'service-action', name: 'GetRates' }], rev: 4 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetNcipDetails', 'ServiceAction:GetRates']]])), w.deps);
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.ok(r.problems.some(p => p.code === 'REFERENCE_ELEMENT_MISSING' && p.pointer === '/ops/0/elements/1' && /Unsupported element kind/.test(p.message)), text(r.problems));
  assert.ok(!publishes(r), 'no studio_publish: publishing never adds a service action to the signature');
  assert.ok(!/the job is right/.test(text(r)));
  assert.ok(!w.calls.includes('snapshot FloodServices'), 'the open model is not even read: ' + w.calls.join(' | '));
  const followed = await w.follow(r);
  assert.ok(followed.codes.length <= 2 && !followed.tools.includes('studio_publish'), 'no loop: ' + text(followed));
});

test('A1 / R2 (studio_deliver, form A): a library whose only public elements are service actions: ONE refusal that says the kind cannot be held, no publication', async t => {
  const w = world(t, { libraries: { RatingApp: { open: [{ kind: 'service-action', name: 'Rate' }], published: [{ kind: 'service-action', name: 'Rate' }], rev: 9 } } });
  const r = await deliverKernel(w.input(w.job([['RatingApp', ['ServiceAction:Rate']]])), w.deps);
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.equal(r.problems.length, 1, text(r.problems));
  assert.equal(r.problems[0].pointer, '/ops/0/elements/0');
  assert.match(r.problems[0].message, /cannot be referenced through the published signature of RatingApp/);
  assert.match(r.problems[0].fix, /publishing RatingApp does not change this/);
  assert.equal(r.continuation, undefined, 'no continuation: nothing to publish');
  assert.ok(!/the job is right/.test(text(r)));
  assert.ok(!w.calls.includes('apply'), 'nothing built');
});

test('A1 / R2 (studio_reference_snapshot): a published revision that exports nothing while the open model has only service actions keeps the bridge\'s refusal, no publication', async t => {
  const w = world(t, { libraries: { RatingApp: { open: [{ kind: 'service-action', name: 'Rate' }], published: [{ kind: 'service-action', name: 'Rate' }], rev: 9 } } });
  const output = path.join(w.root, 'x', 'RatingApp.avsig');
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'RatingApp', output }, { studio: w.deps.studio, captureDir: w.captures, producerDigest: w.deps.producerDigest });
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
  assert.match(r.error, /no supported public elements/);
  assert.match(r.error, /ServiceAction:Rate/);
  assert.match(r.error, /publishing does not change that/);
  assert.equal(r.continuation, undefined);
  assert.equal(r.openModel.exportablePublic, 0);
});

test('A1 (control): form A with an ACTION in the open model, open in the same Studio: still PRODUCER_NOT_PUBLISHED, publish then delivered', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetQuotes' }, { kind: 'service-action', name: 'Rate' }], published: [{ kind: 'service-action', name: 'Rate' }], rev: 1 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.deepEqual((await w.follow(r)).codes, ['PRODUCER_NOT_PUBLISHED', 'delivered']);
});

test('A1: one refusal names both an unpublished action and a service action of the same library, and proposes no publication (the job must change too)', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetNcipDetails' }, { kind: 'action', name: 'GetQuotes' }, { kind: 'service-action', name: 'GetRates' }],
    published: [{ kind: 'action', name: 'GetNcipDetails' }], rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes', 'ServiceAction:GetRates']]])), w.deps);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.map(p => [p.code, p.pointer]), [['PRODUCER_NOT_PUBLISHED', '/ops/0/elements/0'], ['REFERENCE_ELEMENT_MISSING', '/ops/0/elements/1']], text(r.problems));
  assert.ok(!publishes(r), 'publishing alone would not deliver this job: no chain proposed');
});

// ---- A2: only a module open in an ODC Studio is the open model ------------------------------------------------------

test('A2 / R3 (studio_deliver): the newest module capture predates a rename that WAS published: the kernel\'s ONE refusal, never "the job is right" nor a publication', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetQuotesV2' }], published: [{ kind: 'action', name: 'GetQuotesV2' }], rev: 3,
    notOpen: true, staleCapture: [{ kind: 'action', name: 'GetQuotes' }] } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.ok(r.problems.some(p => p.code === 'REFERENCE_ELEMENT_MISSING' && p.pointer === '/ops/0/elements/0'), text(r.problems));
  assert.ok(!publishes(r));
  assert.ok(!/the job is right/.test(text(r)));
  assert.ok(!w.calls.some(c => c.startsWith('digest')), 'the capture is never read as an open model: ' + w.calls.join(' | '));
  const followed = await w.follow(r);
  assert.ok(!followed.tools.includes('studio_publish'), text(followed));
});

test('A2 / R3 (studio_reference_snapshot): not open, an old module capture with public elements: the bridge\'s refusal with the capture as data, no publication', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [], published: [], rev: 3, notOpen: true, staleCapture: [{ kind: 'action', name: 'GetQuotes' }] } } });
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output: path.join(w.root, 'o.avsig'), pid: 7 }, { studio: w.deps.studio, captureDir: w.captures, producerDigest: w.deps.producerDigest });
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
  assert.match(r.error, /no supported public elements/);
  assert.equal(r.continuation, undefined);
  assert.equal(r.openModel.read, false);
  assert.equal(r.openModel.capture.capturedAt, '2026-10-15T10:00:00.000Z');
});

test('A2: form A in studio_deliver with only a module capture: the bridge\'s refusal with the capture as data, never PRODUCER_NOT_PUBLISHED', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [], published: [], rev: 1, notOpen: true, staleCapture: [{ kind: 'action', name: 'GetQuotes' }] } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.code, 'REFERENCE_SNAPSHOT_FAILED', text({ code: r.code, error: r.error }));
  assert.equal(r.continuation, undefined);
  assert.equal(r.unpublished[0].openModel.read, false);
  assert.equal(r.unpublished[0].openModel.capture.capturedAt, '2026-10-15T10:00:00.000Z');
  assert.ok(!/the job is right/.test(text(r)));
});

test('A2: module-capture evidence never exists: odcProducerModel answers a capture only as a data hint', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upr2-mc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'FloodServices-' + 'A'.repeat(64) + '.oml'); fs.writeFileSync(file, 'x'); fs.writeFileSync(file + '.json', JSON.stringify({ capturedAt: '2026-10-15T19:00:00Z' }));
  let digests = 0;
  const model = await odcProducerModel({ producer: 'FloodServices' }, { studio: async () => ({ ok: false, code: 'MODULE_NOT_OPEN' }), digestOf: async () => { digests++; return { ok: true, digest: {} }; }, captureDir: dir });
  assert.equal(model.ok, false);
  assert.equal(model.source, undefined);
  assert.deepEqual(model.capture, { file, capturedAt: '2026-10-15T19:00:00Z' });
  assert.equal(digests, 0);
});

test('A2: the library is open in ANOTHER ODC Studio (the call names pid 7, the library is open in pid 9): the publication goes to pid 9, the rest to pid 7', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetNcipDetails' }, { kind: 'action', name: 'GetQuotes' }], published: [{ kind: 'action', name: 'GetNcipDetails' }], rev: 2, openIn: 9 } },
    references: ['FloodServices'] });
  const deps = { ...w.deps, otherPids: async () => [7, 9] };
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]]), { pid: 7 }), deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.deepEqual(r.continuation.arguments, { module: 'FloodServices', authorize: MARKER, pid: 9 });
  assert.equal(r.continuation.then.tool, 'studio_refresh_references');
  assert.equal(r.continuation.then.arguments.pid, 7);
  assert.equal(r.continuation.then.then.arguments.pid, 7);
  assert.equal(r.unpublished[0].openModel.pid, 9);
  assert.deepEqual((await w.follow(r, { otherPids: async () => [7, 9] })).codes, ['PRODUCER_NOT_PUBLISHED', 'delivered']);
});

test('A2 (control): with an explicit pid and the library open in no Studio, no publication is proposed', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetQuotes' }], published: [{ kind: 'action', name: 'Other' }], rev: 2, notOpen: true } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]]), { pid: 7 }), { ...w.deps, otherPids: async () => [7, 9] });
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED');
  assert.ok(!publishes(r));
});

// ---- A4: the kernel's match ---------------------------------------------------------------------------------------

test('A4 (ODC, letter case): the job writes getQuotes, the open model has GetQuotes public and not published: ONE spelling refusal naming GetQuotes, no loop', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetNcipDetails' }, { kind: 'action', name: 'GetQuotes' }], published: [{ kind: 'action', name: 'GetNcipDetails' }], rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:getQuotes']]])), w.deps);
  assert.equal(r.code, 'REFERENCE_ELEMENT_MISSING', text({ code: r.code, error: r.error }));
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].fix, /^write ServerAction:GetQuotes in place of ServerAction:getQuotes/);
  assert.match(r.problems[0].fix, /publish FloodServices/, 'one refusal with everything: the publication it also needs');
  assert.ok(!publishes(r), 'the job must change first: no chain');
  assert.ok(!/the job is right/.test(text(r)));
  assert.equal((await w.follow(r)).codes.length, 1, 'nothing to follow');
});

test('A4 (ODC, letter case, already published): the fix is only the spelling', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetQuotes' }], published: [{ kind: 'action', name: 'GetQuotes' }], rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:getQuotes']]])), w.deps);
  assert.equal(r.code, 'REFERENCE_ELEMENT_MISSING', text({ code: r.code, error: r.error }));
  assert.match(r.problems[0].fix, /^write ServerAction:GetQuotes in place of ServerAction:getQuotes/);
  assert.ok(!/publish FloodServices/.test(r.problems[0].fix), r.problems[0].fix);
  assert.ok(!w.calls.includes('apply'));
});

test('A4 (ODC, wrong flow): the job writes IMobileBlock:Common/Header, the open model has MainFlow/Header: ONE spelling refusal naming IMobileBlock:Header, no loop', async t => {
  const w = world(t, { libraries: { FloodUI: { open: [{ kind: 'block', name: 'Footer' }, { kind: 'block', name: 'Header', flow: 'MainFlow' }], published: [{ kind: 'block', name: 'Footer' }], rev: 5 } } });
  const r = await deliverKernel(w.input(w.job([['FloodUI', ['IMobileBlock:Common/Header']]])), w.deps);
  assert.equal(r.code, 'REFERENCE_ELEMENT_MISSING', text({ code: r.code, error: r.error }));
  assert.match(r.problems[0].fix, /^write IMobileBlock:Header in place of IMobileBlock:Common\/Header/);
  assert.match(r.problems[0].fix, /an ODC signature names an element without its flow/);
  assert.ok(!publishes(r));
  assert.equal((await w.follow(r)).codes.length, 1);
});

test('A4 (control): the right spelling of an unpublished block: PRODUCER_NOT_PUBLISHED, then delivered', async t => {
  const w = world(t, { libraries: { FloodUI: { open: [{ kind: 'block', name: 'Footer' }, { kind: 'block', name: 'Header' }], published: [{ kind: 'block', name: 'Footer' }], rev: 5 } } });
  const r = await deliverKernel(w.input(w.job([['FloodUI', ['IMobileBlock:Header']]])), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.deepEqual((await w.follow(r)).codes, ['PRODUCER_NOT_PUBLISHED', 'delivered']);
});

// ---- A5: the job-alone check ---------------------------------------------------------------------------------------

test('A5 / R6: an unpublished element and a preflight-class problem of the job (a logic op whose data is an array): ONE refusal naming both; the check runs once; never "the job is right"', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetQuotes' }], published: [{ kind: 'action', name: 'Other' }], rev: 2 } } });
  const file = w.job([['FloodServices', ['ServerAction:GetQuotes']]], 'job-bad.json', [{ op: 'logic', target: 'QuoteFlow', data: [] }]);
  let checked = 0;
  const check = async ({ job }) => { checked++; assert.equal(path.basename(job), 'job-bad.json');
    return { ok: false, code: 'INPUT_INVALID', problems: [{ op: 1, pointer: '/ops/1/data', code: 'INPUT_INVALID', severity: 'error', message: 'logic data must be an object, not an array', fix: 'write data as an object', patch: null }] }; };
  const r = await deliverKernel(w.input(file), { ...w.deps, check });
  assert.equal(checked, 1);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED');
  assert.deepEqual(r.problems.map(p => [p.code, p.pointer]), [['PRODUCER_NOT_PUBLISHED', '/ops/0/elements/0'], ['INPUT_INVALID', '/ops/1/data']], text(r.problems));
  assert.match(r.error, /job-alone check also refused 1 problem/);
  assert.ok(!/the job is right/.test(text(r)));
  assert.deepEqual(r.jobCheck, { ran: true, ok: false, problems: 1 });
  let last = r.continuation; while (last.then) last = last.then;
  assert.equal(last.tool, 'studio_deliver');
  assert.match(last.why, /once the job is corrected/);
});

test('A5: the job-alone check passed: the refusal says so, and only so (never "the job is right")', async t => {
  const w = world(t, { libraries: { FloodServices: { open: [{ kind: 'action', name: 'GetQuotes' }], published: [{ kind: 'action', name: 'Other' }], rev: 2 } } });
  let checked = 0;
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), { ...w.deps, check: async () => { checked++; return { ok: true }; } });
  assert.equal(checked, 1);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED');
  assert.match(r.error, /The job-alone check passed \(it reads the job without the module; the build checks more\)/);
  assert.ok(!/the job is right/.test(text(r)));
  assert.deepEqual(r.jobCheck, { ran: true, ok: true });
});

// ---- O11: A3 and A4 ------------------------------------------------------------------------------------------------

const TASK = '7a8b9c0d1e2f30415263748596a7b8c9';
const o11Refusal = (element, cause, fix) => ({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-sent', stage: 'producer-signatures', code: 'PRODUCER_SIGNATURE_MISSING',
  error: 'PRODUCER_SIGNATURE_MISSING: 1 element(s) of FloodServices_CS are not in its published signature, all listed: ' + element,
  problems: [{ code: 'PRODUCER_SIGNATURE_MISSING', severity: 'error', op: null, pointer: null, cause, element, producer: 'FloodServices_CS',
    message: element + ' is not a visible element of the FloodServices_CS signature', fix }] } } });
const o11Job = (t, element) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upr2-o11-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: 'FloodServices_CS', elements: [element] }] }));
  return { root, job };
};

test('A3 / O1: a CLOSED producer read by the REAL moduleDigest (captureO11 answers its published OML) is never the open model: the kernel\'s refusal stays', async t => {
  const { root, job } = o11Job(t, 'IServerAction:GetQuotes');
  const oml = path.join(root, 'FloodServices_CS-published-v7.oml'); fs.writeFileSync(oml, 'synthetic published OML of FloodServices_CS v7');
  const raw = readCapture(oml, 'o11').rawSha256;
  const digest = { schema: 'ssam-digest/1', extractor: 3, lane: 'o11', adapter: 'kernel', sourceSha256: raw, sourceBytes: 1, createdAt: '2026-10-16T00:00:00Z',
    module: { name: 'FloodServices_CS', key: 'kFS', kind: 'eSpace' }, elements: 1, notRendered: 0, clipped: 0, readErrors: 0,
    sections: DIGEST_SECTIONS.map(id => ({ id, title: id, count: 0, blocks: [] })),
    actions: [{ key: 'kGetQuotes', kind: 'ServerAction', name: 'GetQuotes', section: 'actions', public: true, function: false, in: '', out: '', calls: [], calledBy: [] }] };
  const stored = digestFile('o11', raw); fs.mkdirSync(path.dirname(stored), { recursive: true }); fs.writeFileSync(stored, JSON.stringify(digest));
  t.after(() => fs.rmSync(stored, { force: true }));
  const deps = { captureO11: async name => ({ ok: true, path: oml, sha256: raw, module: name, key: 'kFS', versionId: 7, capturedBy: 'published-oml', reason: 'not-open' }) };
  const read = await moduleDigest({ lane: 'o11', target: 'FloodServices_CS' }, deps);
  assert.equal(read.ok, true, text(read));
  assert.equal(read.capturedBy, 'published-oml', 'the real moduleDigest says how it captured the module');
  assert.equal(read.versionId, 7);
  const kernel = o11Refusal('IServerAction:GetQuotes', 'unpublished', 'publish FloodServices_CS with GetQuotes Public, then capture it again');
  const models = await cycle.o11ProducerModels(kernel, { digestOf: name => moduleDigest({ lane: 'o11', target: name }, deps) });
  assert.equal(models.FloodServices_CS.ok, false);
  assert.match(models.FloodServices_CS.reason, /not open in Service Studio/);
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  assert.equal(answer.code, 'PRODUCER_SIGNATURE_MISSING', text(answer));
  assert.notEqual(answer.continuation?.tool, 'o11_publish');
});

test('A3: the O11 lane\'s own reader of an open model never downloads a closed module\'s published OML', async () => {
  let downloads = 0;
  const bridge = { ok: async method => (method === 'list_open_modules' ? { modules: [{ name: 'QuoteApp_UI', key: 'kQ', hasESpace: true }] } : {}) };
  const read = await cycle.o11OpenModelDigest('FloodServices_CS', { o11: { bridge, assertSelected: async () => {}, download: async () => { downloads++; return { ok: true, file: 'x.oml' }; } } });
  assert.equal(read.ok, false);
  assert.equal(read.code, 'MODULE_NOT_OPEN', text(read));
  assert.equal(downloads, 0);
});

test('A4 / O2 (O11, letter case, published): the kernel\'s "use IServerActionSignature:GetQuotes" stays; never PRODUCER_NOT_PUBLISHED', async t => {
  const { root, job } = o11Job(t, 'IServerAction:getQuotes');
  const kernel = o11Refusal('IServerAction:getQuotes', 'absent', 'use IServerActionSignature:GetQuotes (the kind IServerAction has no getQuotes in FloodServices_CS)');
  const digestOf = async name => ({ ok: true, lane: 'o11', target: name, file: 'C:\\synthetic\\' + name + '.oml', sourceSha256: 'synthetic', capturedBy: 'open-tab',
    digest: { module: { name }, sections: [], actions: [{ key: 'kGetQuotes', kind: 'ServerAction', name: 'GetQuotes', section: 'actions', public: true }] } });
  const models = await cycle.o11ProducerModels(kernel, { digestOf });
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  assert.equal(answer.code, 'PRODUCER_SIGNATURE_MISSING', text(answer));
  assert.ok(text(answer).includes('use IServerActionSignature:GetQuotes'), 'the kernel\'s fix is kept');
  assert.notEqual(answer.continuation?.tool, 'o11_publish');
  assert.ok(!/the job is right/.test(text(answer)));
});

test('A4 (O11, letter case, never published): ONE refusal whose fix names the right spelling and the publication it also needs', async t => {
  const { root, job } = o11Job(t, 'IServerAction:getQuotes');
  const kernel = o11Refusal('IServerAction:getQuotes', 'absent', 'if getQuotes was added or made Public in FloodServices_CS after its last publication, publish FloodServices_CS first (o11_dependencies list shows what it publishes)');
  const digestOf = async name => ({ ok: true, capturedBy: 'open-tab', digest: { module: { name }, sections: [], actions: [{ key: 'kGetQuotes', kind: 'ServerAction', name: 'GetQuotes', section: 'actions', public: true }] } });
  const models = await cycle.o11ProducerModels(kernel, { digestOf });
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  assert.equal(answer.code, 'PRODUCER_SIGNATURE_MISSING', text(answer));
  const problem = answer.problems.find(p => p.element === 'IServerAction:getQuotes');
  assert.match(problem.fix, /^write IServerAction:GetQuotes in place of IServerAction:getQuotes/);
  assert.match(problem.fix, /publish FloodServices_CS \(o11_publish/);
  assert.notEqual(answer.continuation?.tool, 'o11_publish');
});

test('A4 (O11, control): the right spelling, open and public: still PRODUCER_NOT_PUBLISHED with o11_publish then the same o11_deliver', async t => {
  const { root, job } = o11Job(t, 'IServerAction:GetQuotes');
  const kernel = o11Refusal('IServerAction:GetQuotes', 'absent', 'if GetQuotes was added or made Public in FloodServices_CS after its last publication, publish FloodServices_CS first');
  const digestOf = async name => ({ ok: true, capturedBy: 'open-tab', digest: { module: { name }, sections: [], actions: [{ key: 'kGetQuotes', kind: 'ServerAction', name: 'GetQuotes', section: 'actions', public: true }] } });
  const models = await cycle.o11ProducerModels(kernel, { digestOf });
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  assert.equal(answer.code, 'PRODUCER_NOT_PUBLISHED', text(answer));
  assert.deepEqual(answer.sequence, ['o11_publish FloodServices_CS', 'o11_deliver QuoteApp_UI']);
  assert.ok(!/the job is right/.test(text(answer)));
});

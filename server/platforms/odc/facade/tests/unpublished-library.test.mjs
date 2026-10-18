// fix/unpublished-library (family OF; session b67c47db of 2026-10-15, 15 failed deliveries between 19:52 and 20:03 UTC):
// a consumer job references public actions that exist only in the open (unpublished) model of a library. The consumer
// session acquires the PUBLISHED revision (bridge ReferenceCommands.cs, Latest), so the delivery answered "Producer has no
// supported public elements" (REFERENCE_SNAPSHOT_FAILED, no continuation) or the kernel's REFERENCE_ELEMENT_MISSING, whose
// fix ("fix its kind or name ... or remove it from the reference op") invites changing what the job means.
// The family rule: ONE refusal PRODUCER_NOT_PUBLISHED when the published revision lacks what the job references and the
// producer's open model has it public, with the exact sequence: studio_publish {producer} (the person's own words, never
// automatic), studio_refresh_references when the consumer already references it, then the same delivery, unchanged. A
// reused or given capture that lacks it is acquired again first (a publication made by hand). Never "remove it" for an
// element the open model has.
// The REAL applyKernel and interpretKernelResult run; the dotnet process (deps.exec), the bridge and the module digest of the
// producer's open model (deps.producerDigest) are faked. Synthetic values only; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, applyKernel, requiredFlowLayoutEngine, referenceSnapshot } from '../kernel-delivery.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const HOST = 'fixture.test';
const CONSUMER = 'QuoteApp';
const MARKER = "<the user's own words>";

// The kernel's own refusal of an element the frozen signature does not declare (JobRunner.ReferenceProblems).
const missingProblem = (producer, op, k, element) => ({ op, pointer: '/ops/' + op + '/elements/' + k, code: 'REFERENCE_ELEMENT_MISSING', severity: 'error', phase: 'apply',
  message: 'Element not declared in the frozen producer signature: ' + element,
  fix: 'the frozen signature of producer ' + producer + ' has no ' + element + ': fix its kind or name, capture the producer again if it was published since (studio_deliver captures it from the consumer session; studio_reference_snapshot outside a delivery), or remove it from the reference op', patch: null });

// libraries: {Name: {published: [actions] | null (never published with public elements), open: [actions] | null (not open,
// no capture), private: [actions of the open model that are not Public], rev}}.
function world(t, { libraries, references = [], openInStudio = true, captureOnly = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captures = path.join(root, 'snapshots'); fs.mkdirSync(captures);
  const state = { libraries: structuredClone(libraries), consumerRefs: Object.fromEntries(references.map(n => [n, libraries[n].rev])) };
  const calls = [];
  const studio = async ([step, ...rest], pid) => {
    if (step === 'snapshot') {
      const name = rest[0];
      if (name === CONSUMER) {
        const base = path.join(captures, CONSUMER + '-base.oml');
        fs.writeFileSync(base, 'synthetic consumer referencing ' + JSON.stringify(state.consumerRefs));
        calls.push('snapshot ' + name);
        return { ok: true, module: CONSUMER, path: base, sha256: sha(fs.readFileSync(base)).toUpperCase(), host: HOST, developerId: 'dev-synthetic', moduleKey: 'kConsumer',
          dependencies: Object.entries(state.consumerRefs).map(([Name, rev]) => ({ Name, Revision: String(rev) })) };
      }
      const lib = state.libraries[name];
      calls.push('snapshot ' + name);
      if (!lib || !lib.open || !openInStudio) return { ok: false, error: 'Expected exactly one open ' + name + '; found 0.' };
      const bytes = 'synthetic open model of ' + name + ' ' + JSON.stringify(lib.open);
      const file = path.join(captures, name + '-' + sha(bytes).toUpperCase() + '.oml');
      fs.writeFileSync(file, bytes);
      return { ok: true, module: name, moduleKey: 'k' + name, path: file, sha256: sha(bytes).toUpperCase(), capturedAt: new Date().toISOString(), modified: false, host: HOST };
    }
    if (step === 'reference-snapshot') {
      const request = JSON.parse(rest[0]);
      const lib = state.libraries[request.producer];
      calls.push('reference-snapshot ' + request.producer + ' rev ' + lib?.rev);
      if (!lib) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      if (!lib.published?.length) return { ok: false, error: 'Producer has no supported public elements' };
      const bytes = JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: 'k' + request.producer, Name: request.producer, SignatureHash: 'sig-' + request.producer + '-' + lib.rev,
        Revision: String(lib.rev), Elements: lib.published.map(n => ({ Kind: 'action', Name: n, Key: 'key' + n })) });
      fs.mkdirSync(path.dirname(request.output), { recursive: true }); fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: request.producer, producerKey: 'k' + request.producer, revision: String(lib.rev) };
    }
    calls.push(step);
    // Round 3 (N1, N2): the Studio's status lists the open modules with their tenant, as the bridge does.
    if (step === 'status') return { ok: true, modules: [{ name: CONSUMER, key: 'kConsumer', host: HOST }, ...Object.entries(state.libraries).filter(([, lib]) => lib.open && openInStudio).map(([name]) => ({ name, key: 'k' + name, host: HOST }))] };
    if (step === 'reference-producers') return { ok: true, producers: Object.keys(state.libraries).map(name => ({ name, key: 'k' + name })) };
    if (step === 'merge') { Object.assign(state.consumerRefs, state.bound ?? {}); return { ok: true, merged: true, strictlyEqual: true }; }
    return { ok: true };
  };
  // The module digest of an open model (ModuleDigest.cs): the action index with its Public flags.
  const producerDigest = async file => {
    const name = Object.keys(state.libraries).find(n => path.basename(file).startsWith(n + '-'));
    const lib = state.libraries[name];
    calls.push('digest ' + name);
    return { ok: true, sourceSha256: 'synthetic', digest: { schema: 'ssam-digest/1', module: { name, kind: 'ReactiveLibrary' }, sections: [],
      actions: [...lib.open.map(n => ({ key: 'key' + n, kind: 'ServerAction', name: n, section: 'actions', public: true })),
        ...(lib.private ?? []).map(n => ({ key: 'key' + n, kind: 'ServerAction', name: n, section: 'actions', public: false }))] } };
  };
  // A module capture of the producer in the capture folder (the lane's snapshots), when it is not open in the Studio.
  if (captureOnly) for (const [name, lib] of Object.entries(libraries)) if (lib.open) {
    const bytes = 'synthetic capture of ' + name; const file = path.join(captures, name + '-' + sha(bytes).toUpperCase() + '.oml');
    fs.writeFileSync(file, bytes); fs.writeFileSync(file + '.json', JSON.stringify({ capturedAt: '2026-10-15T19:59:27.000Z' }));
  }
  // Round 3 (N2): each open library was merged by an SSAM delivery and not touched since (its receipt has the open model's hash),
  // so studio_publish {module} can take it, as the chain proposes.
  for (const [name, lib] of Object.entries(libraries)) if (lib.open && openInStudio && !captureOnly) {
    const evidence = path.join(root, 'lab', '01-' + name, 'delivery', 'evidence'); fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, '..', 'manifest.json'), JSON.stringify({ module: name, moduleKey: 'k' + name, tenant: HOST, evidenceDir: evidence }));
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-15T19:00:00Z' }));
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256: sha('synthetic open model of ' + name + ' ' + JSON.stringify(lib.open)).toUpperCase() }));
  }
  const cli = path.join(root, 'anvil-odc.dll'); fs.writeFileSync(cli, 'not a CLI');
  const exec = async (_dotnet, argv) => {
    const at = f => argv[argv.indexOf(f) + 1];
    const job = JSON.parse(fs.readFileSync(at('--job'), 'utf8'));
    const bound = Object.fromEntries(argv.filter((_, i) => argv[i - 1] === '--producer').map(p => { const [k, ...f] = p.split('='); return [k, JSON.parse(fs.readFileSync(f.join('='), 'utf8'))]; }));
    calls.push('apply ' + Object.entries(bound).map(([k, s]) => k + '@' + s.Revision).join(','));
    const fail = envelope => { const e = new Error('exit 1'); e.stdout = JSON.stringify({ ok: false, command: 'apply', elapsedMs: 9, verifyRan: false, phases: ['apply'], ...envelope }); e.stderr = ''; e.code = 1; throw e; };
    const results = [];
    for (const [i, op] of job.ops.entries()) {
      if (op.op !== 'reference') continue;
      const signature = bound[op.producer];
      // The kernel stops at the first element its frozen signature lacks (NativeReferenceSnapshot.Select).
      for (const [k, element] of (op.elements ?? []).entries())
        if (!signature.Elements.some(e => e.Name === element.split(':')[1])) fail({ error: 'ArgumentException: Element not declared in the frozen producer signature: ' + element, problems: [missingProblem(op.producer, i, k, element)] });
      const had = state.consumerRefs[op.producer];
      if (had != null && String(had) !== signature.Revision) {
        const message = "Reference version differs from the captured signature; refresh the consumer's reference to it in the Studio, then deliver again: " + op.producer;
        fail({ error: 'InvalidOperationException: ' + message, problems: [{ op: i, pointer: '/ops/' + i, code: 'REFERENCE_OUTDATED', severity: 'error', phase: 'apply', message, fix: 'refresh that reference in the Studio', patch: null }] });
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
  const job = (refs, name = 'job.json') => { fs.writeFileSync(path.join(root, name), JSON.stringify({ ops: refs.map(([producer, elements]) => ({ op: 'reference', producer, elements })) })); return name; };
  const input = (file, extra = {}) => ({ module: CONSUMER, feature: 'f', job: file, owners: ['Owner'], changes: ['Uses the library'], ...extra });
  // The person's own steps, as the continuation names them: publish (the open model becomes the published revision),
  // refresh (the module's reference follows the published revision), then the delivery the chain ends with.
  const publishByHand = name => { const lib = state.libraries[name]; lib.published = [...lib.open]; lib.rev += 1; };
  const follow = async first => {
    const codes = [first.ok ? 'delivered' : first.code];
    let step = first.ok ? null : first.continuation, last = first;
    const tools = [];
    while (step) {
      tools.push(step.tool);
      if (step.tool === 'studio_publish') { assert.equal(step.arguments.authorize, MARKER, 'the publication waits for the person\'s words'); publishByHand(step.arguments.module); }
      else if (step.tool === 'studio_refresh_references') state.consumerRefs[step.arguments.producer] = state.libraries[step.arguments.producer].rev;
      else if (step.tool === 'studio_deliver') {
        assert.equal(step.arguments.patch, undefined, 'the same delivery, never a changed job');
        last = await deliverKernel({ ...step.arguments }, deps); codes.push(last.ok ? 'delivered' : last.code);
        if (last.ok || tools.length > 8) break;
        step = last.continuation; continue;
      } else break;
      step = step.then;
    }
    return { codes, tools, last };
  };
  return { root, state, calls, deps, job, input, follow, publishByHand };
}
const text = value => JSON.stringify(value);

test('OF (form A): a library published with no public element, its open model has the action: ONE PRODUCER_NOT_PUBLISHED, publish then the same delivery', async t => {
  const w = world(t, { libraries: { FloodServices: { published: null, open: ['GetQuotes'], rev: 1 } } });
  const file = w.job([['FloodServices', ['ServerAction:GetQuotes']]]);
  const r = await deliverKernel(w.input(file), w.deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].pointer, '/ops/0/elements/0');
  assert.equal(r.continuation.tool, 'studio_publish');
  assert.deepEqual(r.continuation.arguments, { module: 'FloodServices', authorize: MARKER });
  assert.equal(r.continuation.then.tool, 'studio_deliver');
  assert.deepEqual(r.continuation.then.arguments, { feature: 'f', module: CONSUMER, job: file, owners: ['Owner'], changes: ['Uses the library'] });
  assert.equal(r.continuation.then.then, undefined, 'a module without the reference needs no refresh');
  assert.deepEqual(r.sequence, ['studio_publish FloodServices', 'studio_deliver ' + CONSUMER]);
  assert.equal(r.unpublished[0].openModel.source, 'open-model');
  assert.ok(!/remove it/i.test(text(r)), 'never "remove it" for an element the open model has');
  assert.ok(!w.calls.some(c => c.startsWith('apply') || c === 'merge'), 'nothing built or merged: ' + w.calls.join(' | '));
  const followed = await w.follow(r);
  assert.deepEqual(followed.codes, ['PRODUCER_NOT_PUBLISHED', 'delivered']);
});

test('OF (form B): the published revision lacks one of the actions the job references; the open model has both: ONE refusal naming only the missing one', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails', 'GetQuotes', 'CreateApplication'], rev: 3 } } });
  const file = w.job([['FloodServices', ['ServerAction:GetNcipDetails', 'ServerAction:GetQuotes', 'ServerAction:CreateApplication']]]);
  const r = await deliverKernel(w.input(file), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error, problems: r.problems }));
  assert.deepEqual(r.problems.map(p => p.pointer), ['/ops/0/elements/1', '/ops/0/elements/2'], 'every missing element at once, never the first only');
  assert.match(r.error, /revision 3|published revision/);
  assert.ok(!/remove it/i.test(text(r)));
  assert.ok(!w.calls.some(c => c.startsWith('apply')), 'no build on a revision that cannot hold the job');
  assert.deepEqual((await w.follow(r)).codes, ['PRODUCER_NOT_PUBLISHED', 'delivered']);
});

test('OF + review (a): the module already references the library: the one refusal carries publish, refresh and the same delivery (no chain)', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails', 'GetQuotes'], rev: 2 } }, references: ['FloodServices'] });
  const file = w.job([['FloodServices', ['ServerAction:GetNcipDetails', 'ServerAction:GetQuotes']]]);
  const r = await deliverKernel(w.input(file), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.equal(r.continuation.tool, 'studio_publish');
  assert.equal(r.continuation.then.tool, 'studio_refresh_references');
  assert.deepEqual(r.continuation.then.arguments, { module: CONSUMER, producer: 'FloodServices' });
  assert.match(r.continuation.then.why, /person confirms/);
  assert.equal(r.continuation.then.then.tool, 'studio_deliver');
  assert.equal(r.unpublished[0].referencedByModule, true);
  const followed = await w.follow(r);
  assert.deepEqual(followed.tools, ['studio_publish', 'studio_refresh_references', 'studio_deliver']);
  assert.deepEqual(followed.codes, ['PRODUCER_NOT_PUBLISHED', 'delivered'], 'one refusal, then delivered: no REFERENCE_OUTDATED after the publication');
});

test('OF + review (b): a publication made by hand after the cache kept the old revision: the stale capture is acquired again, never PRODUCER_NOT_PUBLISHED', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails'], rev: 1 } } });
  const first = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetNcipDetails']]], 'first.json')), w.deps);
  assert.equal(first.ok, true, text({ code: first.code, error: first.error }));
  // In the Studio: GetQuotes added to the library and published by hand (revision 2), then the module refreshed by hand too.
  w.state.libraries.FloodServices.open.push('GetQuotes'); w.publishByHand('FloodServices'); w.state.consumerRefs.FloodServices = 2;
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetNcipDetails', 'ServerAction:GetQuotes']]], 'second.json')), w.deps);
  assert.equal(r.ok, true, text({ code: r.code, error: r.error, continuation: r.continuation }));
  assert.equal(r.producers[0].revision, '2');
  assert.equal(r.producers[0].publishedRenewed, true);
  assert.match(r.producers[0].note, /acquired again/);
});

test('OF + review (b): the same by hand without the refresh: ONE REFERENCE_OUTDATED (the module is behind), then delivered', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails'], rev: 1 } } });
  assert.equal((await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetNcipDetails']]], 'first.json')), w.deps)).ok, true);
  w.state.libraries.FloodServices.open.push('GetQuotes'); w.publishByHand('FloodServices');
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetNcipDetails', 'ServerAction:GetQuotes']]], 'second.json')), w.deps);
  assert.equal(r.code, 'REFERENCE_OUTDATED', text({ code: r.code, error: r.error }));
  assert.deepEqual((await w.follow(r)).codes, ['REFERENCE_OUTDATED', 'delivered']);
});

test('OF + review (b): a given capture from before a publication made by hand is acquired again and the build runs on the new one', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails'], rev: 1 } } });
  const first = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetNcipDetails']]], 'first.json')), w.deps);
  const given = path.join(w.root, 'given-rev1.avsig'); fs.copyFileSync(first.producers[0].path, given);
  w.state.libraries.FloodServices.open.push('GetQuotes'); w.publishByHand('FloodServices'); w.state.consumerRefs.FloodServices = 2;
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]], 'second.json'), { producers: { FloodServices: given } }), w.deps);
  assert.equal(r.ok, true, text({ code: r.code, error: r.error, continuation: r.continuation }));
  assert.equal(r.producers[0].revision, '2');
  assert.match(r.producers[0].note, /given capture/);
});

test('OF: two unpublished libraries: ONE refusal with both, the sequence publishes both then delivers once', async t => {
  const w = world(t, { libraries: { FloodServices: { published: null, open: ['GetQuotes'], rev: 1 }, FloodRules: { published: ['Old'], open: ['Old', 'Rate'], rev: 4 } }, references: ['FloodRules'] });
  const file = w.job([['FloodServices', ['ServerAction:GetQuotes']], ['FloodRules', ['ServerAction:Rate']]]);
  const r = await deliverKernel(w.input(file), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.deepEqual(r.problems.map(p => [/FloodServices/.test(p.message) ? 'FloodServices' : /FloodRules/.test(p.message) ? 'FloodRules' : null, p.pointer]),
    [['FloodServices', '/ops/0/elements/0'], ['FloodRules', '/ops/1/elements/0']]);
  assert.deepEqual(r.unpublished.map(u => [u.producer, u.missing.map(m => m.element)]), [['FloodServices', ['ServerAction:GetQuotes']], ['FloodRules', ['ServerAction:Rate']]]);
  assert.deepEqual(r.sequence, ['studio_publish FloodServices', 'studio_publish FloodRules', 'studio_refresh_references ' + CONSUMER + ' (FloodRules)', 'studio_deliver ' + CONSUMER]);
  assert.deepEqual((await w.follow(r)).codes, ['PRODUCER_NOT_PUBLISHED', 'delivered']);
});

// Round 2 (review C:\t\revisoes\unpublished-lib, A2), changed expectation (declared): the first round took the newest module
// capture as the evidence and answered PRODUCER_NOT_PUBLISHED with studio_publish, which needs the module open in a Studio
// (MODULE_NOT_OPEN) and may follow a capture older than a publication. Now only a module open in a Studio is evidence.
test('OF: the library is not open in the Studio; its newest module capture is no evidence: the kernel\'s refusal stays, no publication', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails', 'GetQuotes'], rev: 2 } }, openInStudio: false, captureOnly: true });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.ok(r.problems.some(p => p.code === 'REFERENCE_ELEMENT_MISSING' && p.pointer === '/ops/0/elements/0'), text(r.problems));
  assert.notEqual(r.continuation?.tool, 'studio_publish');
  assert.ok(!w.calls.some(c => c.startsWith('digest')), 'the capture is never read as an open model');
});

test('OF: the open model has the action but not Public: its fix makes it Public and publishes, never "remove it"', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails'], private: ['GetQuotes'], rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.code, 'REFERENCE_ELEMENT_MISSING', text({ code: r.code, error: r.error }));
  assert.match(r.problems[0].fix, /make GetQuotes Public in FloodServices/);
  assert.match(r.problems[0].fix, /publish FloodServices/);
  assert.ok(!/remove it/i.test(text(r)));
  assert.ok(!w.calls.some(c => c.startsWith('apply')));
});

test('OF (control): an action neither published nor in the open model is still the kernel\'s REFERENCE_ELEMENT_MISSING', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: ['GetNcipDetails'], rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotez']]])), w.deps);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => p.code === 'REFERENCE_ELEMENT_MISSING' && p.pointer === '/ops/0/elements/0'), text(r.problems));
  assert.notEqual(r.continuation?.tool, 'studio_publish');
});

test('OF (control): the open model cannot be read and the published revision has other elements: the kernel\'s refusal, as before', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetNcipDetails'], open: null, rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => p.code === 'REFERENCE_ELEMENT_MISSING'), text(r.problems));
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED');
});

test('OF: the published revision exports nothing and the open model cannot be read: one refusal that says both ways out, in English', async t => {
  const w = world(t, { libraries: { FloodServices: { published: null, open: null, rev: 1 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REFERENCE_SNAPSHOT_FAILED', 'the code of before: nothing proves an unpublished change');
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].fix, /publish FloodServices/);
  assert.match(r.unpublished[0].openModel.reason, /not open/);
  assert.equal(r.continuation, undefined, 'without evidence, no publication is proposed as certain');
});

test('OF (control): every element published: delivered, no snapshot of the library, no digest', async t => {
  const w = world(t, { libraries: { FloodServices: { published: ['GetQuotes'], open: ['GetQuotes'], rev: 2 } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.ok, true, text({ code: r.code, error: r.error }));
  assert.ok(!w.calls.includes('snapshot FloodServices') && !w.calls.some(c => c.startsWith('digest')), w.calls.join(' | '));
});

test('OF: studio_reference_snapshot of a library whose published revision exports nothing, its open model public: PRODUCER_NOT_PUBLISHED, publish then the same capture', async t => {
  const w = world(t, { libraries: { FloodServices: { published: null, open: ['GetQuotes'], rev: 1 } } });
  const output = path.join(w.root, 'out', 'FloodServices.avsig');
  // Round 3 (N2), changed input (declared): the root whose lab holds the publication evidence, as mcp.mjs passes it.
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output }, { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, root: w.root });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
  assert.deepEqual(r.continuation.arguments, { module: 'FloodServices', authorize: MARKER });
  assert.deepEqual(r.continuation.then, { tool: 'studio_reference_snapshot', arguments: { module: CONSUMER, producer: 'FloodServices', output }, why: r.continuation.then.why });
  w.publishByHand('FloodServices');
  const again = await referenceSnapshot(r.continuation.then.arguments, { studio: w.deps.studio });
  assert.equal(again.ok, true, text(again));
});

test('OF (control): studio_reference_snapshot without an open model keeps the bridge\'s refusal', async t => {
  const w = world(t, { libraries: { FloodServices: { published: null, open: null, rev: 1 } } });
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output: path.join(w.root, 'x.avsig') }, { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest });
  assert.equal(r.ok, false);
  assert.match(r.error, /no supported public elements/);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED');
});
// fix/unpublished-library round 3 (review C:\t\revisoes\unpublished-lib-2, findings N1-N3): the chain of PRODUCER_NOT_PUBLISHED
// always delivers when followed to the letter, and the job's elements never change in silence.
//  N1 an open module is the producer's open model only on the consumer's tenant (snapshot host), and, when the published
//     signature is held, only with the signature's ModuleKey: a namesake open in another tenant (another ODC Studio, or
//     another session of the same Studio) or with another key never yields studio_publish, and the answer names why;
//  N2 the first step of the chain is executable: studio_publish {module} only when the REAL studio_publish handler would take
//     it (a clean SSAM merge of the library, in that Studio, and the open module unchanged since); otherwise the person
//     publishes the library in that Studio (no tool call), then the same refresh and the same delivery;
//  N3 (O11) the kernel's "use <Kind>:<Name>" fix is kept only when it names the same element (whole name token, same kind
//     family), never because ":GetQuotes" is a substring of ":GetQuotesByState".
// The bridge, the kernel process and the module digest are faked the way the real ones answer; studio_publish runs through
// the REAL handler (publishWithGrant with the deps mcp.mjs passes). Synthetic values only; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, applyKernel, requiredFlowLayoutEngine, referenceSnapshot } from '../kernel-delivery.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import * as cycle from '../o11-cycle.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const A = 'tenant-a.test', B = 'tenant-b.test';
const CONSUMER = 'QuoteApp', CONSUMER_PID = 7;
const MARKER = "<the user's own words>";
const PERSON = 'Yes, publish that library now';
const text = value => JSON.stringify(value);

// libraries: {Name: {open: [action names] (the open model, all public), published: [action names], rev, sessions: [{pid, host,
// key?}] (where it is open; key defaults to the published key "k<Name>"), edits?: n (hand edits after the SSAM merge)}}.
// The consumer is open in the ODC Studio of pid 7, on tenant A; a call without pid reaches that Studio.
function world(t, { libraries, references = [], statusBroken = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upr3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captures = path.join(root, 'snapshots'); fs.mkdirSync(captures);
  const lab = path.join(root, 'lab');
  const state = { libraries: structuredClone(libraries), consumerRefs: Object.fromEntries(references.map(n => [n, libraries[n].rev])) };
  const surfaces = new Map();
  const calls = [];
  const openBytes = name => 'open model of ' + name + ' ' + JSON.stringify(state.libraries[name].open) + (state.libraries[name].edits ? ' edited ' + state.libraries[name].edits : '');
  const openSha = name => sha(openBytes(name)).toUpperCase();
  const sessionAt = (name, pid) => (state.libraries[name]?.sessions ?? []).find(s => s.pid === pid) ?? null;
  const publishOf = name => { const lib = state.libraries[name]; lib.published = [...lib.open]; lib.rev += 1; };
  const studio = async ([step, ...rest], pid) => {
    const at = pid ?? CONSUMER_PID;
    if (step === 'status') {
      calls.push('status@' + at);
      // Round 4 (N4 d): a Studio whose status cannot be read (busy, a modal dialog): the bridge answers no module list.
      if (statusBroken.includes(at)) return { ok: true, busy: { command: 'merge', since: '2026-10-16T12:00:00Z' } };
      return { ok: true, pid: at, modules: [...(at === CONSUMER_PID ? [{ name: CONSUMER, key: 'kConsumer', host: A, loggedIn: true }] : []),
        ...Object.entries(state.libraries).flatMap(([name, lib]) => (lib.sessions ?? []).filter(s => s.pid === at).map(s => ({ name, key: s.key ?? 'k' + name, host: s.host, loggedIn: true })))] };
    }
    if (step === 'snapshot') {
      const name = rest[0];
      calls.push('snapshot ' + name + '@' + at);
      if (name === CONSUMER) {
        const base = path.join(captures, CONSUMER + '-base.oml');
        fs.writeFileSync(base, 'synthetic consumer ' + JSON.stringify(state.consumerRefs));
        return { ok: true, module: CONSUMER, path: base, sha256: sha(fs.readFileSync(base)).toUpperCase(), host: A, developerId: 'dev', moduleKey: 'kConsumer',
          dependencies: Object.entries(state.consumerRefs).map(([Name, rev]) => ({ Name, Revision: String(rev) })) };
      }
      const session = sessionAt(name, at);
      if (!session) return { ok: false, code: 'MODULE_NOT_OPEN', error: "Module '" + name + "' is not open in this ODC Studio." };
      const file = path.join(captures, name + '-' + openSha(name) + '.oml');
      fs.writeFileSync(file, openBytes(name)); surfaces.set(path.basename(file), state.libraries[name].open);
      return { ok: true, module: name, moduleKey: session.key ?? 'k' + name, path: file, sha256: openSha(name), capturedAt: new Date().toISOString(), modified: !!state.libraries[name].edits, host: session.host };
    }
    if (step === 'reference-snapshot') {
      const request = JSON.parse(rest[0]);
      const lib = state.libraries[request.producer];
      calls.push('reference-snapshot ' + request.producer + ' rev ' + lib?.rev);
      if (!lib) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      if (!lib.published?.length) return { ok: false, error: 'Producer has no supported public elements' };
      const bytes = JSON.stringify({ FormatVersion: 2, Environment: A, ModuleKey: 'k' + request.producer, Name: request.producer, ModuleKind: 'eSpace', SignatureHash: 'sig-' + request.producer + '-' + lib.rev,
        Revision: String(lib.rev), Elements: lib.published.map(n => ({ Kind: 'action', Name: n, Key: 'key' + n })) });
      fs.mkdirSync(path.dirname(request.output), { recursive: true }); fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: A, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: request.producer, producerKey: 'k' + request.producer, revision: String(lib.rev) };
    }
    calls.push(step + '@' + at);
    if (step === 'authorize') return { ok: true };
    // The bridge's PublishDispatch: the open module must hash to the merge receipt; then it publishes.
    if (step === 'publish') {
      const manifest = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
      const receipt = JSON.parse(fs.readFileSync(path.join(manifest.evidenceDir, 'receipt.json'), 'utf8'));
      if (!sessionAt(manifest.module, at)) return { ok: false, error: 'Expected exactly one open ' + manifest.module + '; found 0.' };
      if (String(receipt.sha256).toUpperCase() !== openSha(manifest.module)) return { ok: false, error: 'Open module differs from the merged receipt; do not publish an unverified model.' };
      fs.writeFileSync(path.join(manifest.evidenceDir, 'publish-started.json'), JSON.stringify({ at: '2026-10-16T12:00:00Z', pid: at, module: manifest.module }));
      publishOf(manifest.module);
      return { ok: true, module: manifest.module, published: { revision: state.libraries[manifest.module].rev }, completedAt: '2026-10-16T12:01:00Z' };
    }
    if (step === 'reference-producers') return { ok: true, producers: Object.keys(state.libraries).map(name => ({ name, key: 'k' + name })) };
    if (step === 'merge') { Object.assign(state.consumerRefs, state.bound ?? {}); return { ok: true, merged: true, strictlyEqual: true }; }
    return { ok: true };
  };
  const producerDigest = async file => {
    const surface = surfaces.get(path.basename(file)) ?? [];
    const name = path.basename(file).replace(/-[0-9A-F]{64}\.oml$/i, '');
    calls.push('digest ' + name);
    return { ok: true, sourceSha256: 'synthetic', digest: { schema: 'ssam-digest/1', module: { name, kind: 'ReactiveLibrary' }, sections: [],
      actions: surface.map(n => ({ key: 'key' + n, kind: 'ServerAction', name: n, section: 'actions', public: true })) } };
  };
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
        const name = element.slice(element.indexOf(':') + 1);
        if (!signature.Elements.some(e => e.Kind === 'action' && e.Name === name)) {
          const message = 'Element not declared in the frozen producer signature: ' + element;
          fail({ error: 'ArgumentException: ' + message, problems: [{ op: i, pointer: '/ops/' + i + '/elements/' + k, code: 'REFERENCE_ELEMENT_MISSING', severity: 'error', phase: 'apply', message, fix: '(kernel fix text)', patch: null }] });
        }
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
  let consumerLab = 0;
  const deps = { root, studio, guide: null, cache: null, journal: () => {}, prefetch: async () => {}, nextLabDir: () => path.join(root, 'consumer-lab-' + (++consumerLab)),
    signatureCache: path.join(root, '.local', 'producer-cache'), producerDigest, otherPids: async () => [7, 9],
    apply: args => applyKernel(args, { cli, runOnWorker: async () => ({ used: false }), exec, contentSha: null }),
    prepareManifest: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); const m = path.join(output, 'manifest.json'); fs.writeFileSync(m, '{}'); return { ok: true, manifest: m }; } };
  // The deps mcp.mjs gives the studio_publish handler.
  const publishDeps = { studio, readManifest: file => JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8')), lab, root, catalog: () => null };
  // An SSAM delivery merged into the library (the bridge's evidence: manifest, merge-started.json, receipt.json).
  let merges = 0;
  // Round 4 (N4): receipt 'clean' | 'incomplete' (incomplete-receipt.json, known losses) | 'none' (merge-started.json only:
  // uncertain); publishStarted: a publication of that merge was already requested (publish-started.json).
  const libraryMerge = (name, { pid = CONSUMER_PID, sha256 = null, tenant = A, receipt = 'clean', publishStarted = false } = {}) => {
    const dir = path.join(lab, String(++merges).padStart(2, '0') + '-' + name), evidence = path.join(dir, 'delivery', 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(dir, 'delivery', 'manifest.json'), JSON.stringify({ schema: 'odc3-manifest/1', feature: 'AddQuotes', module: name, moduleKey: 'k' + name, tenant, author: 'dev@example.test',
      owners: ['Quotes'], changes: ['Adds the quote actions'], evidenceDir: evidence }));
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-16T11:00:00Z', pid, module: name }));
    if (receipt === 'clean') fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, module: name, outcome: 'merged', sha256: sha256 ?? openSha(name), strictlyEqual: true }));
    if (receipt === 'incomplete') fs.writeFileSync(path.join(evidence, 'incomplete-receipt.json'), JSON.stringify({ ok: false, merged: true, outcome: 'incomplete', gate: 'known_losses', module: name, missing: ['Entity:Quote/Attribute:Total'] }));
    if (publishStarted) fs.writeFileSync(path.join(evidence, 'publish-started.json'), JSON.stringify({ at: '2026-10-16T11:30:00Z', pid, module: name }));
    return { dir, evidence };
  };
  const job = refs => { fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: refs.map(([producer, elements]) => ({ op: 'reference', producer, elements })) })); return 'job.json'; };
  const input = (file, more = {}) => ({ module: CONSUMER, feature: 'f', job: file, owners: ['Owner'], changes: ['Uses the library'], pid: CONSUMER_PID, ...more });
  // Follows a refusal's continuation to the letter: the person's own step, the REAL studio_publish (the marker replaced by
  // the person's words), the refresh, the same delivery; at most four deliveries.
  const follow = async first => {
    const codes = [first.ok ? 'delivered' : first.code], steps = [];
    let step = first.ok ? null : first.continuation, rounds = 0;
    while (step && rounds < 4) {
      if (step.by === 'person') {
        assert.equal(step.tool, undefined, 'the person\'s step is no tool call');
        steps.push('person:' + step.action + '@' + step.pid); publishOf(step.module);
      } else if (step.tool === 'studio_publish') {
        steps.push('studio_publish@' + step.arguments.pid);
        assert.equal(step.arguments.authorize, MARKER, 'the publication waits for the person\'s words');
        const answer = await publishWithGrant({ ...step.arguments, authorize: PERSON }, publishDeps);
        codes.push(answer.ok ? 'published' : answer.code);
        if (!answer.ok) break;
      } else if (step.tool === 'studio_refresh_references') {
        steps.push('studio_refresh_references@' + step.arguments.pid); state.consumerRefs[step.arguments.producer] = state.libraries[step.arguments.producer].rev;
      } else if (step.tool === 'studio_deliver') {
        rounds++; steps.push('studio_deliver@' + step.arguments.pid);
        const last = await deliverKernel({ ...step.arguments }, deps); codes.push(last.ok ? 'delivered' : last.code);
        if (last.ok) break;
        step = last.continuation; continue;
      } else { codes.push('stop:' + step.tool); break; }
      step = step.then;
    }
    return { codes, steps };
  };
  return { root, lab, state, calls, deps, publishDeps, job, input, follow, libraryMerge, openSha, publishOf };
}
const chainOf = r => { const out = []; for (let s = r.continuation; s; s = s.then) out.push(s.by === 'person' ? 'person:' + s.action : s.tool); return out; };
const publishes = r => chainOf(r).includes('studio_publish');

// ---- N1: the open model is the producer's only on the consumer's tenant, and with the published key ------------------

test('N1 (a): consumer in pid 7 on tenant A, the namesake library open only in pid 9 on tenant B: ONE refusal, no studio_publish, the reason names the other tenant', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 9, host: B }] } },
    references: ['FloodServices'] });
  w.libraryMerge('FloodServices', { pid: 9, tenant: B });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.ok(!publishes(r), 'no studio_publish to another tenant: ' + text(chainOf(r)));
  const said = text(r.producerNotes ?? r.unpublished ?? null);
  assert.match(said, /tenant-b\.test/, 'the reason names the other tenant: ' + said);
  assert.match(said, /tenant-a\.test/);
  const followed = await w.follow(r);
  assert.ok(!followed.steps.some(s => s.startsWith('studio_publish')), text(followed));
  assert.ok(followed.codes.length <= 2, 'no chain of refusals: ' + text(followed));
  assert.deepEqual(w.state.libraries.FloodServices.published, ['GetNcipDetails'], 'nothing was published on tenant B');
});

test('N1 (b): studio_reference_snapshot, form A: the library is open only in pid 9 on tenant B: the bridge\'s refusal, no studio_publish, the reason names the other tenant', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetQuotes'], published: [], rev: 1, sessions: [{ pid: 9, host: B }] } } });
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output: path.join(w.root, 'x', 'FloodServices.avsig'), pid: CONSUMER_PID },
    { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, otherPids: w.deps.otherPids, lab: w.lab, root: w.root });
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
  assert.match(r.error, /no supported public elements/);
  assert.equal(r.continuation, undefined, 'no continuation: ' + text(r.continuation));
  assert.equal(r.openModel.read, false);
  assert.match(r.openModel.reason, /tenant-b\.test/);
  assert.match(r.openModel.reason, /tenant-a\.test/);
});

test('N1 (c): the same ODC Studio (pid 7) holds sessions on two tenants, the library is open there on tenant B: ONE refusal, no studio_publish', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 7, host: B }] } } });
  w.libraryMerge('FloodServices', { pid: 7, tenant: B });
  for (const more of [{}, { pid: undefined }]) {
    const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]]), more), w.deps);
    assert.equal(r.ok, false);
    assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
    assert.ok(!publishes(r), text(chainOf(r)));
    assert.match(text(r.producerNotes ?? r.unpublished ?? null), /tenant-b\.test/);
  }
  assert.deepEqual(w.state.libraries.FloodServices.published, ['GetNcipDetails']);
});

test('N1: the module open on the consumer\'s tenant has another key than the published signature: no studio_publish, the reason names the other key', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 7, host: A, key: 'kAnotherFloodServices' }] } } });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.ok(!publishes(r));
  const said = text(r.producerNotes ?? r.unpublished ?? null);
  assert.match(said, /kAnotherFloodServices/);
  assert.match(said, /kFloodServices/);
});

test('N1 (control): the library open in pid 9 on the consumer\'s tenant, with an SSAM merge there: the chain, and following it literally delivers', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 9, host: A }] } },
    references: ['FloodServices'] });
  w.libraryMerge('FloodServices', { pid: 9 });
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.deepEqual(r.continuation.arguments, { module: 'FloodServices', authorize: MARKER, pid: 9 });
  assert.equal(r.unpublished[0].openModel.pid, 9);
  assert.equal(r.unpublished[0].openModel.host, A, 'the evidence carries its host');
  const followed = await w.follow(r);
  assert.deepEqual(followed.codes, ['PRODUCER_NOT_PUBLISHED', 'published', 'delivered']);
  assert.deepEqual(followed.steps, ['studio_publish@9', 'studio_refresh_references@7', 'studio_deliver@7']);
});

// ---- N2: the first step runs (the REAL studio_publish handler) or is the person's -------------------------------------

const firstStepRuns = async (w, r) => {
  const first = r.continuation;
  if (first?.by === 'person') return 'person';
  assert.equal(first?.tool, 'studio_publish', text(first));
  const answer = await publishWithGrant({ ...first.arguments, authorize: PERSON }, w.publishDeps);
  assert.equal(answer.ok, true, 'the first step of the chain is executable: ' + text({ code: answer.code, error: answer.error }));
  return 'studio_publish';
};

for (const [label, setup, code] of [
  ['a library edited by hand (no SSAM merge)', () => {}, 'NO_DELIVERY_TO_PUBLISH'],
  ['an SSAM merge made in another ODC Studio (pid 5)', w => w.libraryMerge('FloodServices', { pid: 5 }), 'DELIVERY_IN_OTHER_STUDIO'],
  ['a library edited after its SSAM merge', w => { w.libraryMerge('FloodServices'); w.state.libraries.FloodServices.edits = 1; }, 'MODULE_CHANGED_SINCE_DELIVERY'],
]) {
  test('N2 (studio_deliver): ' + label + ': the first step is executable or the person\'s; following the chain delivers in one refusal (never ' + code + ')', async t => {
    const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 7, host: A }] } },
      references: ['FloodServices'] });
    setup(w);
    const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
    assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
    assert.deepEqual(chainOf(r), ['person:publish', 'studio_refresh_references', 'studio_deliver'], text(r.continuation));
    assert.equal(r.continuation.module, 'FloodServices');
    assert.equal(r.continuation.pid, 7);
    assert.equal(r.continuation.host, A);
    assert.match(r.continuation.why, /The person publishes FloodServices in the ODC Studio of pid 7 \(tenant-a\.test\)/);
    assert.ok(!text(r.continuation).includes(MARKER), 'no words asked for a step no tool takes');
    const followed = await w.follow(r);
    assert.deepEqual(followed.codes, ['PRODUCER_NOT_PUBLISHED', 'delivered'], text(followed));
    assert.deepEqual(followed.steps, ['person:publish@7', 'studio_refresh_references@7', 'studio_deliver@7']);
  });
}

test('N2 (studio_deliver, the real handler): whatever the chain proposes first runs: hand-edited, other Studio and changed-since all pass firstStepRuns', async t => {
  for (const setup of [() => {}, w => w.libraryMerge('FloodServices', { pid: 5 }), w => { w.libraryMerge('FloodServices'); w.state.libraries.FloodServices.edits = 1; }]) {
    const w = world(t, { libraries: { FloodServices: { open: ['GetQuotes'], published: ['Other'], rev: 2, sessions: [{ pid: 7, host: A }] } } });
    setup(w);
    const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
    assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED');
    assert.equal(await firstStepRuns(w, r), 'person');
  }
});

test('N2 (control): a clean SSAM merge of the library in the same Studio, unchanged since: studio_publish, and the REAL handler publishes it; then delivered', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 7, host: A }] } },
    references: ['FloodServices'] });
  w.libraryMerge('FloodServices');
  const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
  assert.deepEqual(chainOf(r), ['studio_publish', 'studio_refresh_references', 'studio_deliver']);
  const followed = await w.follow(r);
  assert.deepEqual(followed.codes, ['PRODUCER_NOT_PUBLISHED', 'published', 'delivered'], text(followed));
});

test('N2 (studio_reference_snapshot, form A): a library edited by hand: the person publishes it, then the same capture', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetQuotes'], published: [], rev: 1, sessions: [{ pid: 7, host: A }] } } });
  const output = path.join(w.root, 'x', 'FloodServices.avsig');
  const deps = { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, otherPids: w.deps.otherPids, lab: w.lab, root: w.root };
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output, pid: CONSUMER_PID }, deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
  assert.equal(r.continuation.by, 'person', text(r.continuation));
  assert.equal(r.continuation.tool, undefined);
  assert.equal(r.continuation.then.tool, 'studio_reference_snapshot');
  w.publishOf('FloodServices');
  const again = await referenceSnapshot(r.continuation.then.arguments, deps);
  assert.equal(again.ok, true, text(again));
});

test('N2 (studio_reference_snapshot, control): a clean SSAM merge: studio_publish, and the REAL handler publishes it', async t => {
  const w = world(t, { libraries: { FloodServices: { open: ['GetQuotes'], published: [], rev: 1, sessions: [{ pid: 7, host: A }] } } });
  w.libraryMerge('FloodServices');
  const deps = { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, otherPids: w.deps.otherPids, lab: w.lab, root: w.root };
  const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output: path.join(w.root, 'x', 'F.avsig'), pid: CONSUMER_PID }, deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
  assert.equal(r.continuation.tool, 'studio_publish');
  assert.equal(await firstStepRuns(w, r), 'studio_publish');
});

// ---- N3 (O11): the kernel's fix is kept only when it names the same element ---------------------------------------

const TASK = '7a8b9c0d1e2f30415263748596a7b8c9';
const o11Refusal = (element, cause, fix) => ({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-sent', stage: 'producer-signatures', code: 'PRODUCER_SIGNATURE_MISSING',
  error: 'PRODUCER_SIGNATURE_MISSING: 1 element(s) of FloodServices_CS are not in its published signature, all listed: ' + element,
  problems: [{ code: 'PRODUCER_SIGNATURE_MISSING', severity: 'error', op: null, pointer: null, cause, element, producer: 'FloodServices_CS',
    message: element + ' is not a visible element of the FloodServices_CS signature', fix }] } } });
const o11Job = (t, element) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upr3-o11-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: 'FloodServices_CS', elements: [element] }] }));
  return { root, job };
};
const openTab = names => async name => ({ ok: true, capturedBy: 'open-tab', digest: { module: { name }, sections: [],
  actions: names.map(([n, kind = 'ServerAction']) => ({ key: 'k' + n, kind, name: n, section: 'actions', public: true })) } });

test('N3: getQuotes, the open model has GetQuotes (public, unpublished), GetQuotesByState and GetRates: the fix writes GetQuotes and publishes, never "use one of: ...GetQuotesByState"', async t => {
  const { root, job } = o11Job(t, 'IServerAction:getQuotes');
  const kernel = o11Refusal('IServerAction:getQuotes', 'absent', 'use one of: IServerAction:GetQuotesByState, IServerAction:GetRates; if getQuotes was added or made Public in FloodServices_CS after its last publication, publish FloodServices_CS first (o11_dependencies list shows what it publishes)');
  const models = await cycle.o11ProducerModels(kernel, { digestOf: openTab([['GetQuotes'], ['GetQuotesByState'], ['GetRates']]) });
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  assert.equal(answer.code, 'PRODUCER_SIGNATURE_MISSING', text(answer));
  const problem = answer.problems.find(p => p.element === 'IServerAction:getQuotes');
  assert.match(problem.fix, /^write IServerAction:GetQuotes in place of IServerAction:getQuotes/, problem.fix);
  assert.match(problem.fix, /publish FloodServices_CS \(o11_publish/);
  assert.ok(!/use one of/.test(problem.fix) && !/GetQuotesByState/.test(problem.fix), problem.fix);
  assert.ok(!/GetQuotesByState/.test(String(answer.error ?? '')), answer.error);
  assert.notEqual(answer.continuation?.tool, 'o11_publish');
});

test('N3 (family): the kernel names an element of ANOTHER kind with the same name ("use IStructureSignature:GetQuotes"): the right spelling of the job\'s kind replaces it', async t => {
  const { root, job } = o11Job(t, 'IServerAction:getQuotes');
  const kernel = o11Refusal('IServerAction:getQuotes', 'absent', 'use IStructureSignature:GetQuotes (the kind IServerAction has no getQuotes in FloodServices_CS)');
  const models = await cycle.o11ProducerModels(kernel, { digestOf: openTab([['GetQuotes'], ['GetQuotes', 'Structure']]) });
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  const problem = answer.problems.find(p => p.element === 'IServerAction:getQuotes');
  assert.match(problem.fix, /^write IServerAction:GetQuotes in place of IServerAction:getQuotes/, problem.fix);
  assert.ok(!/IStructureSignature/.test(problem.fix), 'never another kind in place of the job\'s element: ' + problem.fix);
  assert.equal(cycle.kernelNamesSpelling('use IStructureSignature:GetQuotes (the kind IServerAction has no getQuotes in FloodServices_CS)', ['IServerAction:GetQuotes']), false);
  assert.equal(cycle.kernelNamesSpelling('use IServerActionSignature:GetQuotes or IStructureSignature:GetQuotes (the kind ...)', ['IServerAction:GetQuotes']), true);
  assert.equal(cycle.kernelNamesSpelling('use one of: IServerAction:GetQuotesByState, IServerAction:GetQuotes2', ['IServerAction:GetQuotes']), false);
  assert.equal(cycle.kernelNamesSpelling('use IMobileBlockSignature:MainFlow/Header (the kind ...)', ['IMobileBlock:MainFlow/Header']), true);
});

test('N3 (control): GetQuotes already published (the kernel says "use IServerActionSignature:GetQuotes") keeps the kernel\'s fix, with GetQuotesByState in the model too', async t => {
  const { root, job } = o11Job(t, 'IServerAction:getQuotes');
  const kernel = o11Refusal('IServerAction:getQuotes', 'absent', 'use IServerActionSignature:GetQuotes (the kind IServerAction has no getQuotes in FloodServices_CS)');
  const models = await cycle.o11ProducerModels(kernel, { digestOf: openTab([['GetQuotes'], ['GetQuotesByState'], ['GetRates']]) });
  const answer = cycle.deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels: models });
  const problem = answer.problems.find(p => p.element === 'IServerAction:getQuotes');
  assert.equal(problem.fix, 'use IServerActionSignature:GetQuotes (the kind IServerAction has no getQuotes in FloodServices_CS)');
  assert.equal(problem.kernelFix, undefined);
});

// ---- N4 (round 4, review C:\t\revisoes\unpublished-lib-3): the handler's safety refusals pass on as they are ------------
// The person's step replaces only the refusals that say "this open module is no SSAM-verified merge" (no delivery, another
// Studio, changed since, already published). Any other refusal of the REAL studio_publish handler (a last merge incomplete
// with known losses, an uncertain merge, a publication already requested, a status that cannot be read) is step 1 as the
// handler answers it: its own continuation (read the receipt, the publish log, the status), and no publication is proposed.

const N4_CASES = [
  ['(a) the last merge is incomplete with known losses', w => w.libraryMerge('FloodServices', { pid: 9, receipt: 'incomplete' }), 'LAST_DELIVERY_NOT_CLEAN'],
  ['(b) merge-started.json without a receipt (uncertain)', w => w.libraryMerge('FloodServices', { pid: 9, receipt: 'none' }), 'LAST_DELIVERY_NOT_CLEAN'],
  ['(c) a publication of the last merge was already requested', w => w.libraryMerge('FloodServices', { pid: 9, publishStarted: true }), 'PUBLISH_ALREADY_REQUESTED'],
  ['(d) the status of the evidence Studio cannot be read', w => w.libraryMerge('FloodServices', { pid: 9 }), 'STUDIO_STATUS_UNAVAILABLE'],
];
const handlerRefusal = async (w, pid) => {
  const answer = await publishWithGrant({ module: 'FloodServices', authorize: PERSON, pid }, w.publishDeps);
  assert.equal(answer.ok, false, 'the real handler refuses: ' + text(answer));
  return answer;
};
const gateChecks = (r, refusal) => {
  assert.notEqual(r.continuation?.by, 'person', 'never "the person publishes" over a safety refusal: ' + text(r.continuation));
  assert.equal(r.continuation?.tool, refusal.continuation.tool, 'step 1 is the handler\'s own continuation');
  assert.deepEqual(r.continuation.arguments, refusal.continuation.arguments);
  assert.ok(!chainOf(r).includes('studio_publish') && !chainOf(r).includes('person:publish'), 'no publication proposed before that is read: ' + text(chainOf(r)));
  assert.match(r.continuation.why, new RegExp(refusal.code));
};

for (const [label, setup, code] of N4_CASES) {
  test('N4 (studio_deliver) ' + label + ': step 1 is the real handler\'s continuation (' + code + '), never the person\'s publication', async t => {
    const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 9, host: A }] } },
      references: ['FloodServices'], statusBroken: code === 'STUDIO_STATUS_UNAVAILABLE' ? [9] : [] });
    setup(w);
    const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
    assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text({ code: r.code, error: r.error }));
    const refusal = await handlerRefusal(w, 9);
    assert.equal(refusal.code, code);
    gateChecks(r, refusal);
    const followed = await w.follow(r);
    assert.deepEqual(followed.codes, ['PRODUCER_NOT_PUBLISHED', 'stop:' + refusal.continuation.tool], 'ONE refusal, then the reading; never a chain of refusals: ' + text(followed));
  });

  test('N4 (studio_reference_snapshot, form A) ' + label + ': step 1 is the real handler\'s continuation (' + code + ')', async t => {
    const w = world(t, { libraries: { FloodServices: { open: ['GetQuotes'], published: [], rev: 1, sessions: [{ pid: 9, host: A }] } },
      statusBroken: code === 'STUDIO_STATUS_UNAVAILABLE' ? [9] : [] });
    setup(w);
    const deps = { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, otherPids: w.deps.otherPids, lab: w.lab, root: w.root };
    const r = await referenceSnapshot({ module: CONSUMER, producer: 'FloodServices', output: path.join(w.root, 'x', 'F.avsig'), pid: CONSUMER_PID }, deps);
    assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r));
    const refusal = await handlerRefusal(w, 9);
    assert.equal(refusal.code, code);
    gateChecks(r, refusal);
  });
}

test('N4 (controls): hand-edited, another Studio and changed since keep the person\'s step and deliver; ALREADY_PUBLISHED too; a clean merge keeps studio_publish', async t => {
  const setups = [['hand-edited', () => {}, 'person:publish'], ['other Studio', w => w.libraryMerge('FloodServices', { pid: 5 }), 'person:publish'],
    ['changed since', w => { w.libraryMerge('FloodServices'); w.state.libraries.FloodServices.edits = 1; }, 'person:publish'],
    ['already published', w => { const m = w.libraryMerge('FloodServices'); fs.writeFileSync(path.join(m.evidence, 'publish-started.json'), '{}');
      fs.writeFileSync(path.join(m.evidence, 'publish-receipt.json'), JSON.stringify({ ok: true, published: { revision: 2 }, completedAt: '2026-10-16T11:40:00Z' })); }, 'person:publish'],
    ['clean merge', w => w.libraryMerge('FloodServices'), 'studio_publish']];
  for (const [label, setup, first] of setups) {
    const w = world(t, { libraries: { FloodServices: { open: ['GetNcipDetails', 'GetQuotes'], published: ['GetNcipDetails'], rev: 2, sessions: [{ pid: 7, host: A }] } },
      references: ['FloodServices'] });
    setup(w);
    const r = await deliverKernel(w.input(w.job([['FloodServices', ['ServerAction:GetQuotes']]])), w.deps);
    assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', label);
    assert.equal(chainOf(r)[0], first, label + ': ' + text(chainOf(r)));
    const followed = await w.follow(r);
    assert.equal(followed.codes.at(-1), 'delivered', label + ': ' + text(followed));
  }
});
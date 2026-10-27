// fix/system-reference round 4 (review C:\t\revisoes\system-ref-3, M3-R on every build path). The REAL applyKernel and
// interpretKernelResult run; only the dotnet process (deps.exec) and the bridge are faked. The fake kernel answers as the
// real one when the module references the producer at another signature than the capture: REFERENCE_OUTDATED (a reference
// op: JobRunner.ReferenceProblems; a prototype data.bind: PrototypeBindPrepass, coded since round 4) or, for an older
// kernel, the same text with no code. One rule for every build path (plain job, prototype op, data.bind): a reused or given
// capture is acquired again in the same call before the module is called outdated; the outdated case has its code and its
// single continuation. Synthetic values only; nothing starts a process or a Studio; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, applyKernel, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const HOST = 'fixture.test';
const HASH = (key, rev) => 'sig-' + key + '-rev-' + rev;
const OUTDATED_TEXT = name => "Reference version differs from the captured signature; refresh the consumer's reference to it in the Studio, then deliver again: " + name;

// kind: 'plain' (a reference op), 'proto' (a prototype op and a reference op), 'bind' (a prototype op whose data.bind names
// the producer, no reference op). coded: whether the kernel codes the outdated reference of a data.bind (round 4) or answers
// with its text only (the kernel before round 4).
function world(t, { kind, name = kind === 'bind' ? 'FolhaPonto_CS' : '(System)', key = 'kP', coded = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { published: 7, consumerRef: null };
  const calls = [];
  const base = path.join(root, 'base.oml');
  const studio = async ([step, ...rest]) => {
    if (step === 'snapshot') {
      fs.writeFileSync(base, 'synthetic base, the module references the producer at ' + state.consumerRef);
      calls.push('snapshot');
      return { ok: true, path: base, sha256: sha(fs.readFileSync(base)).toUpperCase(), host: HOST, developerId: 'dev-synthetic', moduleKey: 'kConsumer' };
    }
    if (step === 'reference-snapshot') {
      const request = JSON.parse(rest[0]);
      calls.push('reference-snapshot ' + request.producer + ' -> rev ' + state.published);
      if (String(request.producer).toLowerCase() !== name.toLowerCase()) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      const bytes = JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: key, Name: name, SignatureHash: HASH(key, state.published), Revision: String(state.published), Elements: [] });
      fs.mkdirSync(path.dirname(request.output), { recursive: true }); fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: name, producerKey: key, revision: String(state.published) };
    }
    if (step === 'refresh-references') { const was = state.consumerRef; state.consumerRef = state.published; calls.push('refresh-references ' + was + '->' + state.consumerRef); return { ok: true }; }
    calls.push(step);
    if (step === 'reference-producers') return { ok: true, producers: [{ name, key }] };
    if (step === 'merge') { state.consumerRef = state.bound; return { ok: true, merged: true, strictlyEqual: true }; }
    return { ok: true };
  };
  const cli = path.join(root, 'anvil-odc.dll'); fs.writeFileSync(cli, 'not a CLI');
  const exec = async (_dotnet, argv) => {
    const at = f => argv[argv.indexOf(f) + 1];
    const job = JSON.parse(fs.readFileSync(at('--job'), 'utf8'));
    const file = argv.filter((_, i) => argv[i - 1] === '--producer')[0]?.split('=').slice(1).join('=');
    const signature = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const at0 = job.ops.findIndex(o => o.op === 'reference');
    const opIndex = at0 >= 0 ? at0 : job.ops.findIndex(o => o.op === 'prototype');
    calls.push('apply rev ' + signature?.Revision + ' vs module ' + state.consumerRef);
    if (signature && state.consumerRef != null && signature.SignatureHash !== HASH(key, state.consumerRef)) {
      const message = OUTDATED_TEXT(name);
      const envelope = { ok: false, command: 'apply', elapsedMs: 9, error: 'InvalidOperationException: ' + message, stack: '   at Anvil.Core.OdcReferenceImporter.Import(...)' };
      if (kind !== 'bind' || coded) Object.assign(envelope, { code: kind === 'bind' ? 'REFERENCE_OUTDATED' : undefined, verifyRan: false, phases: ['apply'], problems: [{ op: opIndex, pointer: '/ops/' + opIndex, code: 'REFERENCE_OUTDATED', severity: 'error', message,
        fix: 'refresh that reference in the Studio (studio_refresh_references {module: the consumer module, producer: "' + name + '"}; the person confirms it first), then deliver the same job again', patch: null, phase: 'apply' }] });
      const e = new Error('exit 1'); e.stdout = JSON.stringify(envelope); e.stderr = ''; e.code = 1; throw e;
    }
    state.bound = Number(signature?.Revision ?? state.consumerRef);
    fs.writeFileSync(at('--out'), 'synthetic candidate');
    return { stdout: JSON.stringify({ ok: true, command: 'apply', data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, validation: {},
      results: signature ? [{ op: 'reference', result: { producer: name, producerKey: key, signatureHash: signature.SignatureHash, referenceExisted: state.consumerRef != null,
        referenceHashBefore: state.consumerRef != null ? HASH(key, state.consumerRef) : null } }] : [] } }), stderr: '' };
  };
  let lab = 0;
  const deps = { root, studio, guide: null, cache: null, journal: () => {}, prefetch: async () => {}, nextLabDir: () => path.join(root, 'lab-' + (++lab)),
    signatureCache: path.join(root, '.local', 'producer-cache'),
    apply: args => applyKernel(args, { cli, runOnWorker: async () => ({ used: false }), exec, contentSha: null }),
    prepareManifest: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); const m = path.join(output, 'manifest.json'); fs.writeFileSync(m, '{}'); return { ok: true, manifest: m }; } };
  // The job and, for a prototype op, its expansion (data.capture set, as expandJobFile writes it).
  const ir = path.join(root, 'capture.json');
  fs.writeFileSync(ir, JSON.stringify({ kind: 'prototype', views: [{ name: 'Home', root: { k: 'n1', t: 'div', c: [] } }], modals: [], events: [] }));
  const reference = { op: 'reference', producer: name, elements: ['ClientAction:ListAppendAll'] };
  const bind = { producer: name, screens: { Home: { source: { action: 'GetEmployees' } } } };
  const prototype = extra => ({ op: 'prototype', data: { source: 'C:/synthetic/proto', entry: 'index.html', ...(kind === 'bind' ? { bind } : {}), ...extra } });
  const ops = kind === 'plain' ? [reference] : kind === 'proto' ? [prototype({}), reference] : [prototype({})];
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops }));
  if (kind !== 'plain') {
    const expanded = path.join(root, 'expanded.json');
    fs.writeFileSync(expanded, JSON.stringify({ ops: ops.map(op => (op.op === 'prototype' ? prototype({ capture: ir, captureSha256: sha(fs.readFileSync(ir)) }) : op)) }));
    deps.expandPrototype = async () => ({ path: expanded, expansion: { captures: [], warnings: [], timings: {} } });
  }
  const input = extra => ({ module: 'FloodQuotes', feature: 'f', job: 'job.json', owners: ['A'], changes: ['B'], ...extra });
  // A refusal's continuation followed literally: studio_refresh_references (the person confirms), then `then`.
  const follow = async (first, max = 4) => {
    const codes = [first.ok ? 'delivered' : first.code]; let r = first;
    for (let i = 0; i < max && !r.ok && r.continuation; i++) {
      const c = r.continuation;
      if (c.tool === 'studio_refresh_references') { await studio(['refresh-references']); r = await deliverKernel({ ...c.then.arguments }, deps); }
      else if (c.tool === 'studio_deliver' && !c.arguments.patch) r = await deliverKernel({ ...c.arguments }, deps);
      else break;
      codes.push(r.ok ? 'delivered' : r.code);
    }
    return { codes, last: r };
  };
  return { root, state, calls, deps, input, follow };
}

// Delivery 1 at revision 7 (the cache keeps it); then, outside the SSAM, the producer is published as 8 and the module's
// reference refreshed to 8 in the Studio.
async function republishedAndRefreshed(w, extra = {}) {
  const first = await deliverKernel(w.input(), w.deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  w.state.published = 8; w.state.consumerRef = 8;
  return deliverKernel(w.input(extra), w.deps);
}

// The prototype import is turned off (2026-10-22, prototype-disabled.mjs): the proto and bind build paths no longer exist,
// so the M3-R rule is proven on the plain path, and a job with the prototype op is refused before any capture or kernel.
for (const kind of ['plain']) {
  test('M3-R (' + kind + ', N5): a cached capture older than the module is acquired again in the same call and delivered', async t => {
    const w = world(t, { kind });
    const r = await republishedAndRefreshed(w);
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, error: r.error, continuation: r.continuation }));
    assert.equal(r.producers[0].revision, '8');
    assert.equal(r.producers[0].outdatedRenewed, true);
    assert.ok(!w.calls.some(c => c.startsWith('refresh-references')), 'no refresh asked');
  });

  test('M3-R (' + kind + ', N5b): a given capture older than the module: acquired again, never re-sent stale', async t => {
    const w = world(t, { kind });
    const first = await deliverKernel(w.input(), w.deps);
    const given = path.join(w.root, 'given-rev7.avsig'); fs.copyFileSync(first.producers[0].path, given);
    w.state.published = 8; w.state.consumerRef = 8;
    const name = kind === 'bind' ? 'FolhaPonto_CS' : '(System)';
    const r = await deliverKernel(w.input({ producers: { [name]: given } }), w.deps);
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, error: r.error, continuation: r.continuation }));
    assert.equal(r.producers[0].revision, '8');
    assert.match(r.producers[0].note ?? '', /given capture/);
  });

  test('M3-R (' + kind + '): a module really behind the producer: ONE REFERENCE_OUTDATED with its single continuation, then delivered', async t => {
    const w = world(t, { kind });
    w.state.consumerRef = 6; // the module references an older revision; the producer is at 7
    const r = await deliverKernel(w.input(), w.deps);
    assert.equal(r.code, 'REFERENCE_OUTDATED', JSON.stringify({ code: r.code, error: r.error }));
    assert.equal(r.continuation.tool, 'studio_refresh_references');
    assert.equal(r.continuation.then.tool, 'studio_deliver');
    assert.deepEqual((await w.follow(r)).codes, ['REFERENCE_OUTDATED', 'delivered']);
  });
}

for (const kind of ['proto', 'bind']) {
  test('M3-R (' + kind + '): the prototype op is refused PROTOTYPE_IMPORT_DISABLED before any capture or kernel', async t => {
    const w = world(t, { kind });
    const r = await deliverKernel(w.input(), w.deps);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROTOTYPE_IMPORT_DISABLED', JSON.stringify({ code: r.code, error: r.error }));
    assert.deepEqual(w.calls, [], 'nothing captured, built or run');
  });
}

// Package 3, lane mb: the ODC delivery (C02 B2 and item 4, C16 G-3, C31). Fakes only: no Studio, no worker process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyKernel, checkJobKernel, deliverKernel, deliveryCache, jobDigest, kernelCli } from '../kernel-delivery.mjs';
import { runOdcOnWorker } from '../anvil-worker.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-mb-delivery-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// A capture on disk and a CLI file (applyKernel checks both exist).
function setup(t) {
  const dir = tmp(t);
  const base = path.join(dir, 'base.oml'); fs.writeFileSync(base, 'OML base bytes');
  const cli = path.join(dir, 'cli', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(cli)); fs.writeFileSync(cli, '');
  const job = path.join(dir, 'job.json'); fs.writeFileSync(job, '{"ops":[]}');
  const output = path.join(dir, 'out'); fs.mkdirSync(output);
  const snapshot = { path: base, sha256: sha(fs.readFileSync(base)).toUpperCase(), developerId: 'author@pa3.test', host: 'pa3.test', moduleKey: 'K' };
  return { dir, base, cli, job, output, snapshot };
}
const envelope = data => ({ ok: true, command: 'apply', data: { accepted: true, isValid: true, flowLayoutEngine: 'anvil-d4d8ece', outSha256: 'x', ...data } });

// A fake worker client: its ping advertises capabilities; run answers like the ODC worker (WorkerServer), recording argv.
function fakeWorker({ capabilities = ['apply:developer-id', 'apply:base-content-sha256'], identity = 'author@pa3.test' } = {}) {
  const runs = [];
  return { runs, ensure: async () => ({ status: { pid: 1, capabilities } }),
    run: async argv => {
      runs.push(argv);
      const asked = argv[argv.indexOf('--developer-id') + 1];
      // A worker that cannot take this identity runs nothing: {ok:false, executed:false}.
      if (asked !== identity) return { used: true, envelope: { ok: false, executed: false, error: 'identity ' + asked + ' not served here' } };
      return { used: true, envelope: envelope({ developerId: asked }) };
    } };
}

test('applyKernel runs on the worker of the same identity, with the author and the content identity in the request', async t => {
  const s = setup(t);
  const worker = fakeWorker();
  let cold = 0;
  const applied = await applyKernel({ job: s.job, snapshot: s.snapshot, output: s.output }, { cli: s.cli, worker, contentSha: () => ({ sha256: 'C0FFEE' }), exec: async () => { cold++; throw new Error('cold'); } });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.kernel.via, 'worker');
  assert.equal(cold, 0);
  const argv = worker.runs[0];
  assert.equal(argv[0], 'apply');
  assert.equal(argv[argv.indexOf('--developer-id') + 1], 'author@pa3.test');
  assert.equal(argv[argv.indexOf('--base-content-sha256') + 1], 'c0ffee');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.output, 'kernel-result.json'), 'utf8')).data.developerId, 'author@pa3.test');
});

test('applyKernel runs cold when the worker cannot take the identity or lacks the capability', async t => {
  for (const worker of [fakeWorker({ identity: 'someone-else@pa3.test' }), fakeWorker({ capabilities: [] })]) {
    const s = setup(t);
    const calls = [];
    const exec = async (file, args, options) => { calls.push({ args, env: options.env.ANVIL_DEVELOPER_ID }); return { stdout: JSON.stringify(envelope({})), stderr: '' }; };
    const applied = await applyKernel({ job: s.job, snapshot: s.snapshot, output: s.output }, { cli: s.cli, worker, contentSha: null, exec });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.kernel.via, 'cold');
    assert.match(applied.kernel.note, /did not run the request|does not advertise apply:developer-id/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env, 'author@pa3.test');                      // the cold process takes the snapshot author
    assert.equal(calls[0].args[calls[0].args.indexOf('--developer-id') + 1], 'author@pa3.test');
  }
});

test('a request the worker took without answering is never replayed cold', async t => {
  const s = setup(t);
  let cold = 0;
  const worker = { ensure: async () => ({ status: { capabilities: ['apply:developer-id'] } }), run: async () => ({ used: true, unknown: true, error: 'connection reset' }) };
  const applied = await applyKernel({ job: s.job, snapshot: s.snapshot, output: s.output }, { cli: s.cli, worker, contentSha: null, exec: async () => { cold++; return {}; } });
  assert.equal(applied.ok, false); assert.equal(applied.code, 'WORKER_OUTCOME_UNKNOWN'); assert.equal(cold, 0);
});

test('runOdcOnWorker with the worker disabled runs nothing there', async () => {
  const r = await runOdcOnWorker(['apply'], { worker: null });
  assert.equal(r.used, false);
});

test('the digest of an inline job is the same for the same content in another path', t => {
  const dir = tmp(t);
  for (const name of ['a', 'b']) { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'part.html'), '<div>x</div>'); }
  const job = '{"ops":[{"op":"html","file":"part.html"}]}';
  fs.writeFileSync(path.join(dir, 'a', 'inline-1.json'), job); fs.writeFileSync(path.join(dir, 'b', 'inline-2.json'), job);
  const first = jobDigest(path.join(dir, 'a', 'inline-1.json'));
  assert.ok(first);
  assert.equal(jobDigest(path.join(dir, 'b', 'inline-2.json')), first);
  fs.writeFileSync(path.join(dir, 'b', 'part.html'), '<div>y</div>');                // another named content: another digest
  assert.notEqual(jobDigest(path.join(dir, 'b', 'inline-2.json')), first);
});

test('the delivery cache keys the base by its content identity', t => {
  const dir = tmp(t);
  const job = path.join(dir, 'job.json'); fs.writeFileSync(job, '{"ops":[]}');
  const cache = deliveryCache({ root: dir, identity: 'kernel-x' });
  const one = cache.key({ job, snapshot: { sha256: 'AAA', contentSha256: 'c1', developerId: 'd', host: 'h' } });
  assert.equal(cache.key({ job, snapshot: { sha256: 'BBB', contentSha256: 'c1', developerId: 'd', host: 'h' } }), one);   // another capture, same content
  assert.notEqual(cache.key({ job, snapshot: { sha256: 'BBB', contentSha256: 'c2', developerId: 'd', host: 'h' } }), one);
  assert.notEqual(cache.key({ job, snapshot: { sha256: 'AAA', developerId: 'd', host: 'h' } }), one);                       // raw only: the raw sha
});

// A delivery over fakes, as kernel-delivery.test.mjs builds it.
function delivery(t, { merge, evidence = {} } = {}) {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [];
  const manifestDir = path.join(root, 'attempt', 'delivery');
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {},
    studio: async ([step]) => {
      calls.push(step);
      if (step === 'snapshot') return { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test' };
      if (step === 'merge') {
        fs.mkdirSync(path.join(manifestDir, 'evidence'), { recursive: true });
        for (const [name, value] of Object.entries(evidence)) fs.writeFileSync(path.join(manifestDir, 'evidence', name), JSON.stringify(value));
        return merge;
      }
      return { ok: true };
    },
    apply: async () => { calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => {
      calls.push('manifest');
      fs.mkdirSync(manifestDir, { recursive: true });
      const manifest = path.join(manifestDir, 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ evidenceDir: path.join(manifestDir, 'evidence') }));
      return { ok: true, manifest };
    } };
  return { root, calls, deps, input: { module: 'Fixture', feature: 'pa3-mb', job: 'job.json', owners: ['Screen'], changes: ['Change'] } };
}

test('an uncertain merge whose evidence shows the merge ran is merged: never "repeat" without "already integrated"', async t => {
  const f = delivery(t, { merge: { ok: false, outcome: 'uncertain', gate: 'equivalence', error: 'Native property differs from the candidate. The merge ran: read the evidence (native-equivalence.txt) before any new attempt; never repeat it.' },
    evidence: { 'merge-started.json': { at: 'now' }, 'native-return.json': { outcome: 'Merged' } } });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false); assert.equal(result.code, 'MERGE_UNCERTAIN');
  assert.equal(result.merged, true); assert.equal(result.equivalence, 'uncertain');
  assert.match(result.error, /already integrated/);
  assert.equal(result.continuation.tool, 'ssam_evidence');
  assert.equal(result.continuation.arguments.file, path.join(result.evidence, 'deliver-result.json'));
  assert.match(result.continuation.why, /Já integrado; não repita/);
  assert.notEqual(result.continuation.tool, 'studio_deliver');
});

test('an uncertain merge without evidence of the merge stays not merged', async t => {
  const f = delivery(t, { merge: { ok: false, outcome: 'uncertain', gate: 'equivalence', error: 'Merge result unknown' } });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.merged, false);
  assert.notEqual(result.continuation?.tool, 'ssam_evidence');
});

test('a merge the bridge proved equal but for the Studio\'s known rewrites is delivered, with one note per element', async t => {
  const normalized = [{ element: 'MainFlow/Produtos/ProductCard', rule: 'CustomNameTrio', local: 'ProductCard', candidate: 'Block1' },
    { element: 'MainFlow/Carrinho/I2', rule: 'IconConversion', local: 'shopping-cart/fill', candidate: 'cart-plus/regular' }];
  const f = delivery(t, { merge: { ok: true, merged: true, strictlyEqual: false, equivalence: 'normalized', normalized, normalizedTotal: 2 } });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true, result.error); assert.equal(result.result, 'entregue');
  assert.equal(result.equivalence, 'normalized'); assert.deepEqual(result.normalized, normalized);
  // Without the bridge's normalized proof, strictlyEqual:false stays uncertain.
  const g = delivery(t, { merge: { ok: true, merged: true, strictlyEqual: false } });
  const uncertain = await deliverKernel(g.input, g.deps);
  assert.equal(uncertain.ok, false); assert.equal(uncertain.code, 'MERGE_UNCERTAIN');
});

test('C31: a job with three pure errors is refused with all of them before any capture', async t => {
  const f = delivery(t, { merge: { ok: true, merged: true, strictlyEqual: true } });
  const problems = [1, 2, 3].map(i => ({ op: i - 1, pointer: `/ops/${i - 1}`, code: 'DATA_INVALID', severity: 'error', message: `$Bad${i}.B.Length must be a positive integer`, fix: null }));
  const exec = async () => ({ stdout: JSON.stringify({ ok: false, command: 'check-job', data: { valid: false, errors: problems.map(p => p.message), problems, warnings: [] } }) });
  const cli = path.join(f.root, 'cli.dll'); fs.writeFileSync(cli, '');
  const result = await deliverKernel(f.input, { ...f.deps, check: input => checkJobKernel(input, { cli, worker: null, exec }) });
  assert.equal(result.ok, false); assert.equal(result.failed, 'preflight'); assert.equal(result.code, 'PREFLIGHT_REFUSED');
  assert.equal(result.problems.length, 3);
  assert.deepEqual(f.calls, []);                       // no snapshot, no apply, nothing sent to the Studio
  assert.equal(result.evidence, undefined);
});

test('C31 with the real ODC CLI: check-job names the three problems', { skip: !fs.existsSync(kernelCli()) }, async t => {
  const dir = tmp(t);
  const job = path.join(dir, 'bad.json');
  fs.writeFileSync(job, JSON.stringify({ ops: ['A', 'B', 'C'].map((n, i) => ({ op: 'spec', data: { entities: [{ name: 'Pa3Bad' + n, attributes: [{ name: 'B', type: 'Text', length: -1 - i }] }] } })) }));
  const checked = await checkJobKernel({ job }, { worker: null });
  assert.equal(checked.ok, false, JSON.stringify(checked));
  assert.equal(checked.problems.length, 3);
  assert.ok(checked.problems.every(p => p.pointer?.startsWith('/ops/')));
});

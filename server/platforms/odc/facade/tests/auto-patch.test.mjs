import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { patchesAppliedOf, normalizationsOf, problemOf, fitProblems } from '../refusal-problems.mjs';
import { appliedJobIdentity, jobIdentity } from '../job-patch.mjs';
import { deliveryFields, deliverArguments } from '../o11-cycle.mjs';
import { interpretKernelResult, requiredFlowLayoutEngine, deliveryCache, applyKernel, deliverKernel } from '../kernel-delivery.mjs';
import { jobTool, jobToolRequest } from '../job-runner.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repair = { code: 'HTML_INVALID', pointer: '/ops/0/data/html', phase: 'apply', patchRule: 'TEXT_LITERAL_QUOTED',
  reason: 'The prose is a literal', from: 'Hello world', to: '"Hello world"', patchSha256: 'a'.repeat(64) };
const metadata = { patchesApplied: [repair], autoPatch: { rounds: 1, elapsedMs: 12 },
  normalizations: [{ rule: repair.patchRule, patchApplied: true, path: repair.pointer, from: repair.from, to: repair.to }] };
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [] }));
  const corrected = path.join(root, 'corrected.json'); fs.writeFileSync(corrected, JSON.stringify({ ops: [{ op: 'get', target: '@espace' }] }));
  return { root, job, corrected, patchedJob: { path: corrected, sha256: hash(fs.readFileSync(corrected)) } };
}

test('applied repairs remain visible in accepted O11 and ODC answers', () => {
  assert.deepEqual(patchesAppliedOf(metadata).patchesApplied, [repair]);
  assert.equal(normalizationsOf(metadata).normalizations.items[0].patchApplied, true);
  const data = { ...metadata, accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine };
  assert.deepEqual(deliveryFields({ apply: data }).patchesApplied, [repair]);
  const interpreted = interpretKernelResult({ ok: true, data }, { output: os.tmpdir() });
  assert.deepEqual(interpreted.patchesApplied, [repair]);
  assert.deepEqual(interpreted.autoPatch, metadata.autoPatch);
  assert.deepEqual(patchesAppliedOf({}), {});
});

test('refusal certainty survives fitting and groups only matching choices', () => {
  const certain = { code: 'ArgumentRequiredExpression', message: 'Missing input', fix: 'Use default', patchRule: 'REQUIRED_ARGUMENT_DEFAULT', patchCertain: true };
  const choice = { ...certain, patchRule: 'REQUIRED_ARGUMENT_TYPE_DEFAULT', patchCertain: false, patchChoice: 'The owner chooses the behavior' };
  assert.equal(problemOf(choice).patchChoice, choice.patchChoice);
  const fitted = fitProblems([certain, certain, choice, choice], { budget: 2000 });
  assert.equal(fitted.problems.filter(p => p.patchCertain === true).length > 0, true);
  assert.equal(fitted.problems.filter(p => p.patchCertain === false).length > 0, true);
});

test('the corrected job identity records its original once and rejects hash drift', t => {
  const s = sandbox(t); const original = { path: s.job, sha256: jobIdentity(s.job).jobSha256 };
  const options = { journalDir: s.root, tool: 'o11_deliver' };
  const corrected = appliedJobIdentity(s.patchedJob, original, options);
  assert.equal(corrected.path, s.corrected); assert.equal(corrected.sha256, s.patchedJob.sha256);
  appliedJobIdentity(s.patchedJob, original, options);
  const lines = fs.readFileSync(path.join(s.root, 'job-patch.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.deepEqual(JSON.parse(lines[0]).basedOn, { job: s.job, sha256: original.sha256 });
  fs.appendFileSync(s.corrected, ' ');
  assert.equal(appliedJobIdentity(s.patchedJob, original, options), original);
});

test('O11 deliver opt-out travels to initial and resume CLI requests', () => {
  for (const input of [{ module: 'Orders', job: 'job.json' }, { resume: 'a'.repeat(32) }]) {
    assert.equal(deliverArguments(input, { work: 'work', port: 123 }).includes('--auto-patch'), false);
    const args = deliverArguments({ ...input, autoPatch: false }, { work: 'work', port: 123 });
    assert.equal(args[args.indexOf('--auto-patch') + 1], 'off');
  }
  assert.equal(jobToolRequest({ job: {}, autoPatch: false }).request.autoPatch, false);
  assert.equal(jobToolRequest({ job: {}, autoPatch: 'off' }).ok, false);
});

test('both fixture job lanes propagate opt-out and return the corrected nextBasedOn', async t => {
  for (const lane of ['o11', 'odc']) {
    const s = sandbox(t); const local = path.join(s.root, '.local');
    fs.mkdirSync(path.join(local, 'lane-odc', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(local, 'lane-odc', 'cli', 'anvil-odc.dll'), 'fake');
    let argv;
    const result = await jobTool({ lane, job: s.job, autoPatch: false }, { root: s.root,
      env: { USERPROFILE: s.root, APPDATA: s.root, LOCALAPPDATA: s.root, ANVIL_AUTHORITY_DIR: path.join(s.root, 'auth'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' },
      runAnvil: async args => { argv = args; return { envelope: { ok: true, data: { ...metadata, accepted: true, isValid: true, patchedJob: s.patchedJob } } }; } });
    assert.equal(argv[argv.indexOf('--auto-patch') + 1], 'off');
    assert.equal(result.ok, true); assert.deepEqual(result.patchesApplied, [repair]);
    assert.deepEqual(result.nextBasedOn, { job: s.corrected, sha256: s.patchedJob.sha256 });
  }
});

test('ODC cache keys separate opt-out and restore corrected job into fresh evidence', t => {
  const s = sandbox(t); const cache = deliveryCache({ root: s.root, identity: 'test-kernel' });
  const snapshot = { sha256: 'b'.repeat(64), developerId: 'dev', host: 'test.local' };
  const key = cache.key({ job: s.job, snapshot });
  assert.notEqual(key, cache.key({ job: s.job, snapshot, autoPatch: false }));
  const output = path.join(s.root, 'first'); const next = path.join(s.root, 'second');
  for (const dir of [output, next]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(output, 'kernel-candidate.oml'), 'candidate');
  fs.writeFileSync(path.join(output, 'kernel-result.json'), JSON.stringify({ ok: true, data: { ...metadata,
    accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, patchedJob: s.patchedJob } }));
  cache.store(key, output); fs.unlinkSync(s.corrected);
  const restored = cache.restore(key, next);
  assert.equal(restored.ok, true); assert.equal(path.dirname(restored.patchedJob.path), next);
  assert.equal(hash(fs.readFileSync(restored.patchedJob.path)), s.patchedJob.sha256);
});

test('ODC apply opt-out is identical for resident-worker and cold execution', async t => {
  const s = sandbox(t); const cli = path.join(s.root, 'cli.dll'); fs.writeFileSync(cli, 'fake');
  const base = path.join(s.root, 'base.oml'); fs.writeFileSync(base, 'base');
  let workerArgs; let coldArgs;
  await applyKernel({ job: s.job, autoPatch: false, output: s.root,
    snapshot: { path: base, sha256: hash(fs.readFileSync(base)), developerId: 'dev', host: 'test.local', moduleKey: 'key' } }, {
    cli, contentSha: null, runOnWorker: async args => { workerArgs = args; return { used: false }; },
    exec: async (_file, args) => { coldArgs = args; return { stdout: JSON.stringify({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine } }) }; } });
  assert.equal(workerArgs[workerArgs.indexOf('--auto-patch') + 1], 'off');
  assert.deepEqual(coldArgs.slice(1), workerArgs);
});

// marco-a6 (review x3-4, trap 1 of the merge recipe): a plain ODC delivery (no prototype op) passes the opt-out to its build
// exactly as a prototype one does; else autoPatch:false applied the repairs anyway while the cache key said "off".
test('a plain ODC delivery passes the autoPatch opt-out to its build', async t => {
  for (const autoPatch of [false, undefined]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-patch-plain-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
    const seen = [];
    const deps = { root, cache: null, signatureCache: null, nextLabDir: () => path.join(root, 'attempt'), journal: () => {},
      studio: async ([step]) => step === 'snapshot' ? { ok: true, path: 'base.oml', sha256: 'HASH', host: 'fixture.test' } : { ok: true },
      apply: async input => { seen.push(input); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
      prepareManifest: async () => ({ ok: true, manifest: 'manifest.json' }) };
    const result = await deliverKernel({ module: 'Fixture', feature: 'fixture-change', job: 'job.json', owners: ['Screen'], changes: ['Change screen'],
      until: 'build', ...(autoPatch === false ? { autoPatch } : {}) }, deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].autoPatch, autoPatch, 'autoPatch reaches the build of a plain job');
  }
});

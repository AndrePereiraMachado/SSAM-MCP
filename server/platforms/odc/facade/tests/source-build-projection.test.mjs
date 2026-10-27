import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliveryFields } from '../o11-cycle.mjs';
import { interpretKernelResult, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { summarize } from '../job-runner.mjs';
import { problemOf, fitProblems, refusalFields, normalizationsOf } from '../refusal-problems.mjs';
import { compactDelivery } from '../responses.mjs';

const repair = { code: 'FUNCTION_UNKNOWN', pointer: '/ops/0/data/actions/0/steps/0/assign/At', phase: 'preflight',
  patchRule: 'BUILTIN_FUNCTION_RENAMED', reason: 'Declared alias', from: 'NullDateTime()', to: 'NullDate()', patchSha256: 'a'.repeat(64) };
const sourceBuilds = [{ role: 'base', spec: 'job:vbase', job: 'C:/input/vbase.json', accepted: true, isValid: true,
  patchesApplied: [repair], normalizations: [{ rule: repair.patchRule, path: repair.pointer, patchApplied: true, from: repair.from, to: repair.to }],
  patchedJob: { path: 'C:/evidence/vbase.oml.patched-job.json', sha256: 'b'.repeat(64),
    source: { path: 'C:/evidence/vbase.oml.patched-job.json.source.json', sha256: 'c'.repeat(64) } },
  autoPatch: { rounds: 1, elapsedMs: 12 } }];
const publicSourceBuilds = sourceBuilds.map(receipt => ({ ...receipt, ...normalizationsOf(receipt) }));
const sourceJob = { role: 'producer', spec: 'job:broken-producer', job: 'C:/input/broken-producer.json' };
const problem = { code: 'FUNCTION_UNKNOWN', severity: 'error', pointer: '/ops/0', op: 0,
  message: 'Unknown function', fix: 'Choose a function', patchRule: 'BUILTIN_FUNCTION_NEAREST', patchCertain: false,
  patchChoice: 'The author chooses the meaning', sourceJob };
const success = { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, sourceBuilds };
const refusal = { sourceJob, sourceBuilds, problems: [problem], verifyRan: true };

test('O11 accepted delivery exposes every source build receipt', () => {
  assert.deepEqual(deliveryFields({ apply: success }).sourceBuilds, publicSourceBuilds);
});

test('ODC accepted kernel projection exposes every source build receipt', () => {
  const projected = interpretKernelResult({ ok: true, data: success }, { output: 'C:/evidence/output' });
  assert.equal(projected.ok, true);
  assert.deepEqual(projected.sourceBuilds, publicSourceBuilds);
});

test('a refusal keeps its root source identity, prior build receipts and each problem source identity', () => {
  const projected = refusalFields(refusal.problems, refusal);
  assert.deepEqual(projected.sourceBuilds, publicSourceBuilds);
  assert.deepEqual(projected.sourceJob, sourceJob);
  assert.deepEqual(projected.problems[0].sourceJob, sourceJob);
  assert.deepEqual(problemOf(problem).sourceJob, sourceJob);
});

test('ODC refused kernel projection retains the refused source and prior corrections', () => {
  const projected = interpretKernelResult({ ok: false, code: 'PREFLIGHT_REFUSED', ...refusal }, { output: 'C:/evidence/output', exitCode: 1 });
  assert.equal(projected.ok, false);
  assert.deepEqual(projected.sourceJob, sourceJob);
  assert.deepEqual(projected.sourceBuilds, publicSourceBuilds);
  assert.deepEqual(projected.problems[0].sourceJob, sourceJob);
});

test('grouped equal pointers in different source jobs keep separate origins', () => {
  const other = { ...sourceJob, spec: 'job:other-producer', job: 'C:/input/other-producer.json' };
  const list = [sourceJob, other].flatMap(origin => [0, 1].map(op => ({ ...problem, op, pointer: '/ops/' + op,
    sourceJob: origin, message: 'Unknown function ' + 'x'.repeat(400) })));
  const projected = fitProblems(list, { budget: 2300 });
  assert.equal(projected.grouped, true);
  assert.equal(projected.problems.length, 2);
  assert.deepEqual(projected.problems.map(p => p.sourceJob), [sourceJob, other]);
  assert.deepEqual(projected.problems.map(p => p.count), [2, 2]);
});

for (const lane of ['o11', 'odc']) {
  test(`${lane} fixture job success and refusal retain source receipts outside the short success budget`, () => {
    const args = { lane, job: null, out: 'candidate.oml', resultFile: 'result.json' };
    const accepted = summarize({ ...args, saved: { ok: true, data: success } });
    assert.deepEqual(accepted.sourceBuilds, publicSourceBuilds);
    const rejected = summarize({ ...args, saved: { ok: false, code: 'PREFLIGHT_REFUSED', ...refusal, data: {} } });
    assert.deepEqual(rejected.sourceBuilds, publicSourceBuilds);
    assert.deepEqual(rejected.sourceJob, sourceJob);
    assert.deepEqual(rejected.problems[0].sourceJob, sourceJob);
  });
}

test('ODC public compaction keeps source receipts on delivered and refused answers', () => {
  const accepted = compactDelivery('studio_deliver', {}, { ok: true, merged: true, strictlyEqual: true, sourceBuilds: publicSourceBuilds });
  assert.deepEqual(accepted.sourceBuilds, publicSourceBuilds);
  const rejected = compactDelivery('studio_deliver', {}, { ok: false, error: 'source refused', ...refusal, sourceBuilds: publicSourceBuilds });
  assert.deepEqual(rejected.sourceBuilds, publicSourceBuilds);
  assert.deepEqual(rejected.sourceJob, sourceJob);
  assert.deepEqual(rejected.problems[0].sourceJob, sourceJob);
});

test('repairs in separate jobs never become a verified patch against the consumer document', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-projection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobFile = path.join(dir, 'consumer.json');
  const job = { ops: [{ op: 'create', name: 'Original' }] };
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const rootProblem = { ...problem, sourceJob: undefined, patch: [{ op: 'replace', path: '/ops/0/name', value: 'RootCorrected' }], patchCertain: true };
  const sourceProblem = { ...problem, sourceJob: { ...sourceJob, job: path.join(dir, 'source.json') },
    patch: [{ op: 'replace', path: '/ops/0/name', value: 'SourceCorrected' }] };
  const projected = refusalFields([rootProblem, sourceProblem], {}, { jobFile, job });
  assert.deepEqual(projected.problems[0].patch, rootProblem.patch, 'a source pointer cannot conflict with a root pointer');
  assert.equal(projected.problems[1].patch, undefined);
  assert.equal(projected.problems[1].patchOmitted, true);
  assert.match(projected.problems[1].patchOmittedWhy, /source job.*hash-bound basedOn/);
  assert.deepEqual(projected.problems[1].sourceJob, sourceProblem.sourceJob);
  assert.equal(projected.verifiedPatch, undefined);
  assert.equal(fs.existsSync(jobFile + '.verified-patch.json'), false);
  const rootOnly = refusalFields([rootProblem], {}, { jobFile, job });
  assert.ok(rootOnly.verifiedPatch, 'ordinary root-only verified repairs still work');
  assert.equal(fs.existsSync(jobFile + '.verified-patch.json'), true);
});

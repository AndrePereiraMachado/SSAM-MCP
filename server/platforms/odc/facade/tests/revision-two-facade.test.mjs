import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failureOf } from '../job-guidance.mjs';
import { patchesAppliedOf, refusalFields, problemOf, normalizationsOf } from '../refusal-problems.mjs';
import { deliveryCache } from '../kernel-delivery.mjs';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-two-facade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const rejected = { ok: true, data: { accepted: false, isValid: false, expectedValid: true,
  validation: { unexpected: [{ id: 'ExpressionUnknownFunction', type: 'Error', path: 'Screen / Value', detail: "Unknown function 'Now'" }],
    ambiguous: [{ id: 'UnusedElement', element: 'Tmp', why: 'Two matching locals' }], missingExpected: [] },
  policyMessages: ['Ambiguous expected message UnusedElement @ Tmp'] } };

test('auto and off rejected Verify receipts keep the verify stage even with a summary error', t => {
  const dir = sandbox(t);
  for (const mode of ['auto', 'off']) {
    const resultFile = path.join(dir, mode + '.result.json'); fs.writeFileSync(resultFile, JSON.stringify(rejected));
    const failure = failureOf({ ok: false, error: 'Verify rejected the candidate', resultFile });
    assert.equal(failure.stage, 'verify');
    assert.equal(failure.verify.unexpected[0].id, 'ExpressionUnknownFunction');
    assert.equal(failure.verify.ambiguous[0].id, 'UnusedElement');
    assert.equal(failure.verify.ambiguous[0].detail, 'Two matching locals');
  }
});

test('an inline rejected Verify receipt has the same failure summary without a result file', () => {
  const failure = failureOf({ ok: false, error: 'Verify rejected', result: rejected });
  assert.equal(failure.stage, 'verify');
  assert.equal(failure.verify.unexpected.length, 1);
  assert.equal(failure.verify.ambiguous.length, 1);
});

test('source repairs without their own hash-bound basedOn are omitted with a reason', t => {
  const dir = sandbox(t); const jobFile = path.join(dir, 'consumer.json'); fs.writeFileSync(jobFile, '{"ops":[]}');
  const sourceJob = { role: 'base', spec: 'job:producer', job: path.join(dir, 'producer.json') };
  const original = { code: 'FUNCTION_UNKNOWN', severity: 'error', message: 'Choose function', sourceJob,
    patch: [{ op: 'replace', path: '/ops/0/name', value: 'Corrected' }] };
  const projected = refusalFields([original], { sourceJob }, { jobFile });
  const shown = projected.problems[0];
  assert.equal(shown.patch, undefined); assert.equal(shown.patchOmitted, true);
  assert.match(shown.patchOmittedWhy, /source job.*(?:hash|basedOn)|(?:hash|basedOn).*source job/i);
  assert.deepEqual(shown.sourceJob, sourceJob); assert.deepEqual(problemOf(original), shown);
  assert.equal(projected.verifiedPatch, undefined);
  assert.equal(fs.existsSync(jobFile + '.verified-patch.json'), false);
  assert.ok(original.patch, 'projection does not mutate the source receipt');
});

test('each source receipt applies the root normalization and repair window budgets recursively', () => {
  const repair = { code: 'HTML_INVALID', from: 'a'.repeat(200) + 'before', to: 'a'.repeat(200) + 'after', patchSha256: 'c'.repeat(64) };
  const normals = Array.from({ length: 20 }, (_, i) => ({ rule: 'RULE_' + (i % 2), from: 'a'.repeat(200), to: 'b'.repeat(200) }));
  const leaf = { role: 'producer', spec: 'job:nested', job: 'C:/input/nested.json', normalizations: normals, patchesApplied: [repair] };
  const source = { role: 'base', spec: 'job:base', job: 'C:/input/base.json', accepted: true,
    normalizations: normals, patchesApplied: [repair], sourceBuilds: [leaf] };
  const projected = patchesAppliedOf({ sourceBuilds: [source] });
  for (const receipt of [projected.sourceBuilds[0], projected.sourceBuilds[0].sourceBuilds[0]]) {
    assert.deepEqual(receipt.normalizations, normalizationsOf({ normalizations: normals }).normalizations);
    assert.equal(receipt.normalizations.items.length, 8); assert.equal(receipt.normalizations.itemsLeft, 12);
    assert.notEqual(receipt.patchesApplied[0].from, receipt.patchesApplied[0].to);
    assert.ok(receipt.patchesApplied[0].from.length <= 160 && receipt.patchesApplied[0].to.length <= 160);
  }
  assert.deepEqual(patchesAppliedOf(projected), projected, 'public receipt budgets are stable across projection layers');
});

test('cache keys distinguish identical job bytes with different resolution origin folders', t => {
  const dir = sandbox(t); const cache = deliveryCache({ root: dir, identity: 'origin-test' });
  const jobs = ['one', 'two'].map(name => { const folder = path.join(dir, name); fs.mkdirSync(folder);
    const job = path.join(folder, 'job.json'); fs.writeFileSync(job, '{"ops":[]}'); return job; });
  const snapshot = { sha256: 'a'.repeat(64), developerId: 'same', host: 'same.local' };
  assert.notEqual(cache.key({ job: jobs[0], snapshot }), cache.key({ job: jobs[1], snapshot }));
});

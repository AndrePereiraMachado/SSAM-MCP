// Families found when the lanes of 2026-10-12 were integrated (integracao/24-1-familias) and the owner's session was replayed
// offline (a model that applies every verified patch and fixes nothing else):
//   1. a refusal carries every problem: a big verified patch (the corrected text of a whole screen) is left out of the
//      answer before any problem is (patchOmitted), and the union of every verified patch stays beside the job
//      (<job>.verified-patch.json); the next call applies it whole with patch "verified" (verifiedPatch.call), any size;
//   2. one field normalizations from two sources: the facade's list [{rule, at, note}] and the kernel's object
//      {total, byRule, items} are joined, neither dropped.
// Fakes only: no Studio, no worker, no CLI.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fitProblems, refusalFields, PROBLEMS_BUDGET } from '../refusal-problems.mjs';
import { resolvePatchedJob, withNamedPatches, verifiedPatchFile, nextBasedOnOf } from '../job-patch.mjs';
import { writeCall } from '../ssam-code.mjs';
import { mergeNormalizations, withNormalizationsOf } from '../normalizations.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const big = n => '<screen name="S">' + 'x'.repeat(n) + '</screen>';
const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'fam-int-'));

test('a problem is never cut for the size of its patch: the patches are left out first', () => {
  const problems = [
    { op: 0, pointer: '/ops/0/data/html', code: 'A_PATCHED', severity: 'error', message: 'a', fix: 'f', patch: [{ op: 'replace', path: '/ops/0/data/html', value: big(20000) }], patchCertain: true },
    { op: 1, pointer: '/ops/1/data/html', code: 'B_PATCHED', severity: 'error', message: 'b', fix: 'f', patch: [{ op: 'replace', path: '/ops/1/data/html', value: big(20000) }], patchCertain: true },
    { op: 2, pointer: '/ops/2', code: 'C_PLAIN', severity: 'error', message: 'c', fix: 'f' },
    { op: 2, pointer: '/ops/2', code: 'D_PLAIN', severity: 'error', message: 'd', fix: 'f' },
    { op: 2, pointer: '/ops/2', code: 'E_PLAIN', severity: 'error', message: 'e', fix: 'f' },
  ];
  const fitted = fitProblems(problems);
  assert.equal(fitted.problems.length, 5);
  assert.equal(fitted.problemsTotal, undefined);
  assert.ok(fitted.problems.some(p => p.patchOmitted));
  assert.ok(Buffer.byteLength(JSON.stringify(fitted.problems)) <= PROBLEMS_BUDGET);
  // With the job file, the union of every patch is written beside it and the fields name the call that applies it.
  const dir = tmp(); const file = path.join(dir, 'job.json'); fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'html', data: { html: 'a' } }, { op: 'html', data: { html: 'b' } }, { op: 'x' }] }));
  const fields = refusalFields(problems, { verifyRan: true }, { jobFile: file });
  assert.equal(fields.problems.length, 5);
  assert.equal(fields.verifiedPatch.ops, 2);
  assert.equal(JSON.parse(fs.readFileSync(fields.verifiedPatch.call.basedOn.job + '.verified-patch.json', 'utf8')).patch.length, 2);
  // Without it, nothing is written and nothing is named.
  assert.equal(refusalFields(problems, {}).verifiedPatch, undefined);
});

test('the verified patches go beside the job and patch "verified" applies them whole, for that job only', () => {
  const dir = tmp();
  const ops = Array.from({ length: 60 }, (_, i) => ({ op: 'set', target: 'T' + i, prop: 'Description', value: 'old' }));
  const jobText = JSON.stringify({ ops }, null, 2) + '\n';
  const file = path.join(dir, 'job.json'); fs.writeFileSync(file, jobText);
  // 60 verified patch operations: more than a written patch may have (50).
  const problems = ops.map((_, i) => ({ op: i, pointer: `/ops/${i}/value`, code: 'FAMILY_' + i, severity: 'error', message: 'm' + i, fix: 'f', patch: [{ op: 'replace', path: `/ops/${i}/value`, value: 'new' }], patchCertain: true }));
  const value = withNamedPatches({ ok: false, ...refusalFields(problems, {}, { jobFile: file }), job: file, ...nextBasedOnOf(file, sha(jobText)) }, file);
  assert.equal(value.verifiedPatch.ops, 60);
  assert.equal(value.verifiedPatch.call.patch, 'verified');
  assert.deepEqual(value.verifiedPatch.call.basedOn, { job: path.resolve(file), sha256: sha(jobText) });
  assert.ok(fs.existsSync(verifiedPatchFile(path.resolve(file))));
  const resolved = resolvePatchedJob({ patch: 'verified', basedOn: value.verifiedPatch.call.basedOn }, { inlineDir: path.join(dir, 'inline') });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.ok(JSON.parse(fs.readFileSync(resolved.path, 'utf8')).ops.every(o => o.value === 'new'));
  // Another version of the job: refused, nothing applied.
  fs.writeFileSync(file, jobText.replace('"old"', '"other"'));
  const stale = resolvePatchedJob({ patch: 'verified', basedOn: { job: file, sha256: sha(jobText.replace('"old"', '"other"')) } }, { inlineDir: path.join(dir, 'inline') });
  assert.equal(stale.ok, false);
  // A job with no refusal beside it: refused, with the reason.
  const other = path.join(dir, 'other.json'); fs.writeFileSync(other, jobText);
  const none = resolvePatchedJob({ patch: 'verified', basedOn: { job: other, sha256: sha(jobText) } }, { inlineDir: path.join(dir, 'inline') });
  assert.equal(none.ok, false);
  assert.match(none.error ?? none.message ?? '', /verified/);
});

test('ssam_code write takes patch "verified" with basedOn (o11: o11_deliver gets it as given)', () => {
  const basedOn = { job: path.resolve(tmp(), 'j.json'), sha256: 'a'.repeat(64) };
  const o11 = writeCall({ lane: 'o11', action: 'write', module: 'M', basedOn, patch: 'verified' });
  assert.equal(o11.tool, 'o11_deliver');
  assert.equal(o11.arguments.patch, 'verified');
  assert.deepEqual(o11.arguments.basedOn, basedOn);
});

test('the facade list and the kernel object of normalizations are joined, neither dropped', () => {
  const facade = [{ rule: 'call-shape', at: '/text', note: 'n' }];
  assert.deepEqual(mergeNormalizations(undefined, facade), facade);
  assert.deepEqual(mergeNormalizations([{ rule: 'x', at: '/a', note: 'y' }], facade), [...facade, { rule: 'x', at: '/a', note: 'y' }]);
  const kernel = { total: 2, byRule: { LITERAL_FOLDED: 2 }, items: [{ rule: 'LITERAL_FOLDED', path: '/ops/1', from: 'a', to: 'b' }], itemsLeft: 1 };
  const joined = mergeNormalizations(kernel, facade);
  assert.equal(joined.total, 3);
  assert.deepEqual(joined.byRule, { LITERAL_FOLDED: 2, 'call-shape': 1 });
  assert.equal(joined.items[0].rule, 'call-shape');
  assert.equal(joined.itemsLeft, 1);
  assert.equal(withNormalizationsOf({ ok: true }, []).normalizations, undefined);
});

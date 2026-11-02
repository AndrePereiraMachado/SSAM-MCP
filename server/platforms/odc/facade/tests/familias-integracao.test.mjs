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


// ---- C-01 (c), 27/10 (F-FitBody-21, F-FitBody-40): "verified" was only the union of the problems' patches without a conflict
// of path. The patch of DDL_BASE_REQUIRED replaced /ddl with the module's read of FBContent (the job's new entities, structures
// and attributes left it after fix:"apply"); the one of HTML_PROPERTY_UNKNOWN left <aggregate k name max/> without its from,
// join, where and sort. A patch that leaves the job without what it declares (job-inventory.mjs) is never verified nor applied.
const FB_READ = [
  'create entity FBContent label Title ( -- @UQMLFQl1qk6FV7uDhSnKuQ',
  '  Id Long Integer identifier auto required, -- @vpIQwxlClkOjWgv7NuhJ7Q',
  '  Title Text(100) required, -- @LGAL_4E2GUy+j9adXRL1PA',
  '  SortOrder Integer required default 0 -- @wizCnIRDC0aNAHQUmgT4mw',
  ');'].join('\n');
const FB_DDL = [
  '/// One item of the FitBody catalog.',
  'create entity FBContent label Title ( -- @UQMLFQl1qk6FV7uDhSnKuQ',
  '  Id Long Integer identifier auto required, -- @vpIQwxlClkOjWgv7NuhJ7Q',
  '  Title Text(100) required, -- @LGAL_4E2GUy+j9adXRL1PA',
  '  SortOrder Integer required default 0, -- @wizCnIRDC0aNAHQUmgT4mw',
  '  /// Position of the workout in its level.',
  '  ProgramOrder Integer default 0,',
  '  IsFeatured Boolean required default False',
  ');', '',
  'create entity FBLevelProgram label Label (', '  Id Long Integer identifier auto required,', '  Label Text(30) required', ');',
  'create unique index UQ_FBLevelProgram_Label on FBLevelProgram (Label);', '',
  'create entity FBRoutine label Name (', '  Id Long Integer identifier auto required,', '  Name Text(50) required', ');', '',
  'type FBCalendarDay = {', '  DayNumber: Integer;', '  IsBlank: Boolean;', '}', '',
  'type FBLogTotals = {', '  Seconds: Integer;', '  Kcal: Integer;', '}'].join('\n');
const FB_AGGREGATE = '<aggregate k="w2" name="GetFeatures" from="FBRecipeFeature" join="FBContent on FBContent.Id = FBRecipeFeature.ContentId" where="FBRecipeFeature.OnNutritionHome" sort="FBRecipeFeature.SortOrder" max="30"/>';
const FB_JOB = { ops: [
  { op: 'spec', data: { ddl: FB_DDL } },
  { op: 'html', data: { screen: 'FB_Nutrition', basedOn: { capture: 'a'.repeat(64), html: 'b'.repeat(64) }, edit: [FB_AGGREGATE, '<div k="w61" if="True"><div k="w62" class="fbx-play"/></div>'] } },
  { op: 'logic', data: { flow: ['server action CreateFBWorkoutLog\n  in MemberId: Long Integer\n  end\n'] } },
] };
const DDL_PROBLEM = { phase: 'apply', op: 0, pointer: '/ops/0/data/ddl', code: 'DDL_BASE_REQUIRED', severity: 'error', message: 'line 2: FBContent names elements of a read by their keys and the op has no basedOn',
  fix: 'send basedOn', patch: [{ op: 'replace', path: '/ops/0/data/ddl', value: FB_READ }], patchCertain: true };
const HTML_PROBLEM = { phase: 'apply', op: 1, pointer: '/ops/1/data/edit/0', code: 'HTML_PROPERTY_UNKNOWN', severity: 'error', message: 'from="FBRecipeFeature" on ScreenAggregate k="w2": ScreenAggregate has no property from',
  fix: 'remove from', patch: [{ op: 'replace', path: '/ops/1/data/edit', value: ['<aggregate k="w2" name="GetFeatures" max="30"/>', FB_JOB.ops[1].data.edit[1]] }], patchCertain: true };
const BASED_ON_PROBLEM = { phase: 'apply', op: 0, pointer: '/ops/0/data/ddl', code: 'DDL_BASE_REQUIRED', severity: 'error', message: 'line 2: FBContent has no basedOn',
  fix: 'add basedOn', patch: [{ op: 'add', path: '/ops/0/data/basedOn', value: 'c'.repeat(64) }], patchCertain: true };

test('C-01 (c): a refusal patch that leaves the job without its statements or its aggregate data is no patch and never verified (F-FitBody-21, -40)', async () => {
  const { jobInventory, inventoryLoss } = await import('../job-inventory.mjs');
  const inventory = jobInventory(FB_JOB);
  assert.deepEqual(inventory.get('ddl entity'), ['FBContent', 'FBLevelProgram', 'FBRoutine']);
  assert.deepEqual(inventory.get('ddl type'), ['FBCalendarDay', 'FBLogTotals']);
  assert.deepEqual(inventory.get('ddl member FBContent'), ['Id', 'Title', 'SortOrder', 'ProgramOrder', 'IsFeatured']);
  assert.deepEqual(inventory.get('html aggregate FB_Nutrition w2'), ['from', 'join', 'where', 'sort']);
  assert.deepEqual(inventory.get('logic action'), ['CreateFBWorkoutLog']);
  assert.deepEqual(inventoryLoss(inventory, jobInventory(FB_JOB)), []);
  const dir = tmp(); const file = path.join(dir, 'job.json'); fs.writeFileSync(file, JSON.stringify(FB_JOB));
  const fields = refusalFields([DDL_PROBLEM, HTML_PROBLEM, BASED_ON_PROBLEM], { verifyRan: true }, { job: FB_JOB, jobFile: file });
  const [ddl, html, basedOn] = fields.problems;
  for (const lost of [ddl, html]) {
    assert.equal(lost.patch, undefined, lost.code + ' keeps no destructive patch');
    assert.equal(lost.patchOmitted, true);
    assert.match(lost.patchOmittedWhy, /^PATCH_DESTRUCTIVE/);
  }
  assert.deepEqual(ddl.patchLost.find(l => l.group === 'ddl entity').lost, ['FBLevelProgram', 'FBRoutine']);
  assert.deepEqual(ddl.patchLost.find(l => l.group === 'ddl type').lost, ['FBCalendarDay', 'FBLogTotals']);
  assert.deepEqual(ddl.patchLost.find(l => l.group === 'ddl member FBContent').lost, ['ProgramOrder', 'IsFeatured']);
  assert.deepEqual(html.patchLost, [{ group: 'html aggregate FB_Nutrition w2', lost: ['from', 'join', 'where', 'sort'], before: 4, after: 0 }]);
  // The patch that keeps every statement (only adds basedOn) stays, and is the only verified one.
  assert.deepEqual(basedOn.patch, BASED_ON_PROBLEM.patch);
  assert.equal(fields.verifiedPatch.ops, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(verifiedPatchFile(path.resolve(file)), 'utf8')).patch, BASED_ON_PROBLEM.patch);
});

test('C-01 (c): fix:"apply" and patch "verified" never apply a patch that loses what the job declares: PATCH_DESTRUCTIVE, nothing sent', async () => {
  const { saveRefusalFixes, proposedPatch } = await import('../job-patch.mjs');
  const dir = tmp(); const text = JSON.stringify(FB_JOB); const file = path.join(dir, 'job.json'); fs.writeFileSync(file, text);
  // Fixes kept before the guard (or by another release): the destructive one among them refuses the whole fix:"apply".
  const fixes = path.join(dir, 'fixes');
  assert.equal(saveRefusalFixes(fixes, { job: file, jobSha256: sha(text), problems: [DDL_PROBLEM, BASED_ON_PROBLEM], module: 'FigmaMobile' }), true);
  const refused = proposedPatch(fixes, { file, sha256: sha(text) });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PATCH_DESTRUCTIVE');
  assert.match(refused.error, /nothing was sent/);
  assert.ok(refused.lost.some(l => l.group === 'ddl entity' && l.lost.includes('FBRoutine')));
  // Only the harmless one: applied.
  const only = path.join(dir, 'fixes-ok');
  saveRefusalFixes(only, { job: file, jobSha256: sha(text), problems: [BASED_ON_PROBLEM], module: 'FigmaMobile' });
  const applied = proposedPatch(only, { file, sha256: sha(text) });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.patch, BASED_ON_PROBLEM.patch);
  // A verified-patch file written before the guard: patch "verified" refuses it too.
  fs.writeFileSync(verifiedPatchFile(path.resolve(file)), JSON.stringify({ schema: 'ssam-verified-patch/1', job: path.resolve(file), jobSha256: sha(text), patch: HTML_PROBLEM.patch }));
  const verified = resolvePatchedJob({ patch: 'verified', basedOn: { job: file, sha256: sha(text) } }, { inlineDir: path.join(dir, 'inline') });
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'PATCH_DESTRUCTIVE');
  assert.deepEqual(verified.lost.map(l => l.group), ['html aggregate FB_Nutrition w2']);
  // A patch of the caller's own may remove what it means to.
  const own = resolvePatchedJob({ patch: HTML_PROBLEM.patch, basedOn: { job: file, sha256: sha(text) } }, { inlineDir: path.join(dir, 'inline') });
  assert.equal(own.ok, true, JSON.stringify(own));
});

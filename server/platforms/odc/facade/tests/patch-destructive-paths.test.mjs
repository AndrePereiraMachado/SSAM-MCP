// C-01 (c), review round 2 of B1 (2026-11-01): the PATCH_DESTRUCTIVE judgement (refusal-problems.mjs withoutDestructivePatches)
// is the one of every answer that carries problems with patches. The ssam_code check (its own CHECK_REFUSED, local and hosted:
// hosted/checks.mjs runs the same codeCheck), the validation contract of o11_deliver / o11_access (contractRefusal) and
// ssam_reference check-job answered the kernel's patches raw: the F-FitBody-21 patch (replace /ddl with the module's read)
// reached the caller there, and on the hosted server the next step is the explicit patch copied from the problem.
// Fakes only: no kernel, no Studio.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codeCheck } from '../code-check.mjs';
import { contractRefusal } from '../o11-cycle.mjs';
import { withoutDestructivePatches } from '../refusal-problems.mjs';
import { deliverKernel } from '../kernel-delivery.mjs';
import { joinPrecheck } from '../ui-precheck.mjs';
import { registerSsamReference } from '../ssam-reference.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'patch-destructive-'));
// F-FitBody-21: the job declares three entities; the module's read has one.
const READ = 'create entity FBContent label Title (\n  Id Long Integer identifier auto required, -- @vpIQwxlClkOjWgv7NuhJ7Q\n  Title Text(100) required -- @LGAL_4E2GUy+j9adXRL1PA\n);';
const DDL = READ + '\n\ncreate entity FBLevelProgram label Label (\n  Id Long Integer identifier auto required,\n  Label Text(30) required\n);\n\n'
  + 'create entity FBRoutine label Name (\n  Id Long Integer identifier auto required,\n  Name Text(50) required\n);';
const JOB = { ops: [{ op: 'spec', data: { ddl: DDL } }] };
const ddlPointer = job => { const ops = Array.isArray(job) ? job : job.ops; const i = ops.findIndex(o => typeof o?.data?.ddl === 'string'); return `${Array.isArray(job) ? '' : '/ops'}/${i}/data/ddl`; };
const destructive = pointer => ({ phase: 'verify', op: 0, pointer, code: 'DDL_BASE_REQUIRED', severity: 'error', message: 'line 1: FBContent names elements of a read by their keys and the op has no basedOn',
  fix: 'send basedOn', patch: [{ op: 'replace', path: pointer, value: READ }], patchCertain: true });
const harmless = pointer => ({ phase: 'verify', op: 0, pointer, code: 'DDL_BASE_REQUIRED', severity: 'error', message: 'line 1: FBContent has no basedOn',
  fix: 'add basedOn', patch: [{ op: 'add', path: pointer.replace(/\/ddl$/, '/basedOn'), value: 'c'.repeat(64) }], patchCertain: true });
const judged = (problem, why = /^PATCH_DESTRUCTIVE/) => {
  assert.equal(problem.patch, undefined, JSON.stringify(problem));
  assert.equal(problem.patchOmitted, true);
  assert.match(problem.patchOmittedWhy, why);
  assert.ok(problem.patchLost.some(l => l.group === 'ddl entity' && l.lost.includes('FBRoutine') && l.lost.includes('FBLevelProgram')), JSON.stringify(problem.patchLost));
};

test('C-01 (c): one judgement takes the job or its file, and leaves a harmless patch and a source job\'s patch as they are', () => {
  const file = path.join(tmp(), 'job.json'); fs.writeFileSync(file, JSON.stringify(JOB));
  const pointer = ddlPointer(JOB);
  const source = { ...destructive(pointer), sourceJob: { role: 'producer', job: 'other.json' } };
  for (const job of [JOB, file]) {
    const [lost, kept, foreign] = withoutDestructivePatches([destructive(pointer), harmless(pointer), source], job);
    judged(lost);
    assert.deepEqual(kept.patch, harmless(pointer).patch);
    assert.deepEqual(foreign.patch, source.patch);
  }
  // Without a job (or an unreadable one) nothing is judged.
  assert.deepEqual(withoutDestructivePatches([destructive(pointer)], null)[0].patch, destructive(pointer).patch);
  assert.deepEqual(withoutDestructivePatches([destructive(pointer)], path.join(tmp(), 'none.json'))[0].patch, destructive(pointer).patch);
});

test('C-01 (c): a refused ssam_code check answers the destructive patch of its problem as PATCH_DESTRUCTIVE (F-FitBody-21; the hosted check is the same codeCheck)', async () => {
  const dir = tmp(), base = path.join(dir, 'base.oml'); fs.writeFileSync(base, 'x');
  let checked = null;
  const runJob = async request => {
    checked = JSON.parse(fs.readFileSync(request.job, 'utf8'));
    const pointer = ddlPointer(checked);
    return { ok: false, code: 'PREFLIGHT_REFUSED', job: request.job, problems: [destructive(pointer), harmless(pointer)] };
  };
  const refused = await codeCheck({ lane: 'o11', module: 'Neutral', base, part: 'ddl', text: DDL }, { root: dir, local: dir, runJob, guidance: async (_l, _j, r) => r });
  assert.equal(refused.code, 'CHECK_REFUSED', JSON.stringify(refused).slice(0, 2000));
  assert.ok(checked, 'the check ran the job');
  const [lost, kept] = refused.problems;
  judged(lost);
  assert.deepEqual(kept.patch, harmless(ddlPointer(checked)).patch);
});

test('C-01 (c): the validation contract (o11_deliver, o11_access) judges the patches of its problems on the job it refused', () => {
  const file = path.join(tmp(), 'job.json'); fs.writeFileSync(file, JSON.stringify(JOB));
  const pointer = ddlPointer(JOB);
  const apply = { isValid: false, problems: [destructive(pointer)] };
  const refused = contractRefusal(apply, null, file);
  assert.ok(refused.fields.contract, 'the contract refused');
  judged(refused.fields.problems[0]);
  // Without the job (an older caller), as before.
  assert.deepEqual(contractRefusal(apply).fields.problems[0].patch, destructive(pointer).patch);
});

test('C-01 (c): ssam_reference check-job judges the patches of its refusal on the stored job', async t => {
  const kernel = tempKernel({ cli: true });
  const run = fakeAnvil({ 'check-job': args => {
    const job = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    return { ok: true, command: 'check-job', data: { valid: false, errors: ['DDL_BASE_REQUIRED'], problems: [destructive(ddlPointer(job))] } };
  } });
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, uuid: () => 'job-1' });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const refused = await mcp.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: JOB });
  assert.equal(refused.code, 'JOB_INVALID', JSON.stringify(refused).slice(0, 2000));
  judged(refused.problems[0]);
});

// Review round 2 of the facade (2026-11-01): the delivery path still answered the static verdict's patches raw. A complete
// verdict of check-job in the ODC delivery (kernel-delivery.mjs deliverKernel) was returned as it came, and the problems an
// incomplete verdict carries (o11_deliver, the ODC delivery, the UI precheck) joined the refusal after its judgement
// (ui-precheck.mjs joinPrecheck). Both are judged on the job they came from.
test('C-01 (c): the ODC delivery judges the patches of a complete static verdict on its job (deliverKernel)', async () => {
  const dir = tmp(), job = path.join(dir, 'job.json'); fs.writeFileSync(job, JSON.stringify(JOB));
  const pointer = ddlPointer(JOB);
  const refused = await deliverKernel({ module: 'M', feature: 'F', job, until: 'merge', owners: ['F'], changes: ['F'] }, { root: dir,
    check: async () => ({ ok: false, static: { complete: true }, code: 'DDL_BASE_REQUIRED', problems: [destructive(pointer), harmless(pointer)], error: 'x' }),
    studio: async () => { throw new Error('no Studio: the static verdict stops the delivery before it'); } });
  assert.equal(refused.failed, 'preflight', JSON.stringify(refused).slice(0, 1500));
  judged(refused.problems[0]);
  assert.deepEqual(refused.problems[1].patch, harmless(pointer).patch);
});

test('C-01 (c): the problems an incomplete static verdict carries are judged on their job when they join the refusal (joinPrecheck)', () => {
  const dir = tmp(), job = path.join(dir, 'job.json'); fs.writeFileSync(job, JSON.stringify(JOB));
  const pointer = ddlPointer(JOB);
  for (const from of [job, JOB]) {
    const carried = { carry: true, problems: [destructive(pointer)], static: { complete: false }, local: dir, lane: 'o11', mode: 'deliver', job: from };
    const withList = joinPrecheck({ ok: false, code: 'VALIDATION_REFUSED', problems: [{ code: 'OTHER', op: 1, message: 'y' }] }, carried);
    judged(withList.problems.find(p => p.code === 'DDL_BASE_REQUIRED'));
    const without = joinPrecheck({ ok: false, code: 'DELIVERY_FAILED' }, carried);
    judged(without.static.problems[0]);
  }
});

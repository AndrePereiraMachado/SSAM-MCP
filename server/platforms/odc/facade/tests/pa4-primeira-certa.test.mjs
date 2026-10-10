// primeira-certa A3 (2026-10-10): what the session sees. The refusal of a job comes back ONCE with every problem of every
// phase over the live capture (the job alone, the base, the apply, the Verify), each with phase, pointer, fix and the patch
// of a certain fix, grouped only to fit the 40 KB ceiling; the job's own preflight is only a shortcut when no capture can
// be had. Fakes only: no Studio, no worker, no CLI.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fitProblems, moldOf, refusalFields } from '../refusal-problems.mjs';
import { deliverKernel, interpretKernelResult } from '../kernel-delivery.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
import { buildBeforeApply } from '../o11-build-phase.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';
import { summarize } from '../job-runner.mjs';
import { registerSsamReference } from '../ssam-reference.mjs';
import { refusalCode } from '../refusal-codes.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(isolatedProfile, 'pa4-pc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// The kernel's single refusal (JobRunner.Diagnosis), as the CLI envelope carries it.
const UNION = [
  { phase: 'preflight', op: 0, pointer: '/ops/0/data/actions/0/steps/0/assign/D', code: 'EXPR_UNKNOWN_IDENTIFIER', severity: 'error', message: "can't identify 'MaxDays' in MaxDays", fix: 'write Site.MaxDays',
    patch: [{ op: 'replace', path: '/ops/0/data/actions/0/steps/0/assign/D', value: 'Site.MaxDays' }] },
  { phase: 'apply', op: 0, pointer: '/ops/0/data/actions/1/steps/0', code: 'LOGIC_INVALID', severity: 'error', message: "action 'Nope' does not exist", fix: 'call an action that exists' },
  { phase: 'verify', op: 0, pointer: '/ops/0/data/actions/2/steps/0/assign/Code', code: 'ExpressionInvalidExpressionType', severity: 'error', message: "'Integer' data type required instead of 'Text'",
    fix: 'convert it with TextToInteger(...)', element: 'App (ESpace) / Good (ServerAction) / Assign1', key: 'k1' },
];
const refusedEnvelope = { ok: false, command: 'apply', code: 'PREFLIGHT_REFUSED', error: 'op #0 (logic) [EXPR_UNKNOWN_IDENTIFIER]: ...', problems: UNION, verifyRan: true, phases: ['preflight', 'apply', 'verify'] };

test('fitProblems keeps every problem whole when it fits, and groups identical ones (same code and mold of fix) when it does not', () => {
  assert.deepEqual(fitProblems(UNION).problems.map(p => p.phase), ['preflight', 'apply', 'verify']);
  assert.equal(fitProblems(UNION).problems[2].element, UNION[2].element);
  assert.equal(moldOf("use Ticket.Id, or declare 'X' in Y"), moldOf("use Order.Id, or declare 'Z' in W"));
  const many = n => Array.from({ length: n }, (_, i) => ({ phase: 'verify', op: 1, pointer: `/ops/1/data/actions/${i}/steps/0/assign/Code`, code: 'ExpressionInvalidExpressionType', severity: 'error',
    message: `'Integer' data type required instead of 'Text' in Action${i}`, fix: `convert it with TextToInteger(Value${i})`,
    patch: [{ op: 'replace', path: `/ops/1/data/actions/${i}/steps/0/assign/Code`, value: `TextToInteger(Value${i})` }] }));
  const fitted = fitProblems([...UNION, ...many(120)], { budget: 30000 });
  assert.ok(Buffer.byteLength(JSON.stringify(fitted.problems)) <= 30000);
  const group = fitted.problems.find(p => p.count === 120);
  assert.ok(group, JSON.stringify(fitted.problems).slice(0, 400));
  assert.equal(group.pointers.length, 120);
  assert.equal(group.patch.length, 120, 'one patch applies every member');
  assert.equal(fitted.grouped, true);
  assert.deepEqual(fitted.problems.filter(p => !p.count).map(p => p.code), UNION.map(p => p.code), 'the other problems stay whole');
  // Far over the budget: the group keeps its fix and pointers, says its patch was left out, and nothing else is cut.
  const huge = fitProblems([...UNION, ...many(400)], { budget: 30000 });
  const big = huge.problems.find(p => p.count === 400);
  assert.equal(big.patchOmitted, true); assert.equal(big.pointers.length, 400); assert.equal(huge.problemsTotal, undefined);
  // The grouped patch applies with patch + basedOn like any other.
  assert.deepEqual(refusalFields(UNION, refusedEnvelope).phases, ['preflight', 'apply', 'verify']);
});

test('studio_deliver: no job preflight before the capture; the apply over it refuses once with every phase, nothing merged', async t => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: [{ op: 'logic', data: { actions: [] } }] }));
  const calls = [];
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {},
    studio: async ([step]) => { calls.push(step); return step === 'snapshot' ? { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test' } : { ok: true }; },
    check: async () => { calls.push('check-job'); return { ok: false, code: 'PREFLIGHT_REFUSED', problems: [UNION[0]], error: 'pure', verifyRan: false }; },
    apply: async () => { calls.push('apply'); return { ok: false, code: 'PREFLIGHT_REFUSED', problems: UNION, verifyRan: true, phases: ['preflight', 'apply', 'verify'], error: 'every phase' }; },
    prepareManifest: async () => { calls.push('manifest'); return { ok: true, manifest: path.join(root, 'm.json') }; } };
  const result = await deliverKernel({ module: 'App', feature: 'pa4', job: 'job.json', owners: ['A'], changes: ['C'] }, deps);
  assert.deepEqual(calls, ['snapshot', 'apply'], 'captured and applied; neither the job alone nor the Studio write');
  assert.equal(result.ok, false); assert.equal(result.failed, 'preflight'); assert.equal(result.code, 'PREFLIGHT_REFUSED');
  assert.deepEqual(result.problems.map(p => p.phase), ['preflight', 'apply', 'verify']);
  assert.deepEqual(result.problems[0].patch, UNION[0].patch);
  assert.equal(result.problems[2].key, 'k1');
  assert.equal(result.verifyRan, true); assert.deepEqual(result.phases, ['preflight', 'apply', 'verify']);
});

test('studio_deliver: without a capture the job alone answers, with verifyRan false and the reason', async t => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: [] }));
  const calls = [];
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {},
    studio: async ([step]) => { calls.push(step); return { ok: false, code: 'BRIDGE_NOT_ATTACHED', error: 'App is not attached to ODC Studio' }; },
    check: async () => { calls.push('check-job'); return { ok: false, code: 'PREFLIGHT_REFUSED', problems: [UNION[0]], error: 'pure', verifyRan: false }; },
    apply: async () => { calls.push('apply'); return { ok: true }; }, prepareManifest: async () => ({ ok: true }) };
  const result = await deliverKernel({ module: 'App', feature: 'pa4', job: 'job.json', owners: ['A'], changes: ['C'] }, deps);
  assert.deepEqual(calls, ['snapshot', 'check-job']);
  assert.equal(result.failed, 'preflight'); assert.equal(result.code, 'PREFLIGHT_REFUSED');
  assert.equal(result.verifyRan, false); assert.match(result.verifyReason, /could not be captured \(App is not attached/);
  assert.equal(result.problems[0].code, 'EXPR_UNKNOWN_IDENTIFIER');
});

test('o11_deliver: the build over the capture answers the single refusal and a lone apply refusal with its own code, before the Studio', async t => {
  const root = tmp(t);
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'delete', target: 'IServerAction:Old' }] }));
  const lone = { ok: false, command: 'apply', code: 'DELETE_HAS_CONSUMERS', error: 'op #0 (delete): used by 1 consumer', verifyRan: true, phases: ['apply'],
    problems: [{ phase: 'apply', op: 0, pointer: '/ops/0', code: 'DELETE_HAS_CONSUMERS', severity: 'error', message: 'IServerAction Old is used by UsesOld', fix: 'delete UsesOld in the same job' }] };
  for (const [envelope, code] of [[refusedEnvelope, 'PREFLIGHT_REFUSED'], [lone, 'DELETE_HAS_CONSUMERS']]) {
    const bridge = { ok: async (method, params) => {
      if (method === 'list_open_modules') return { modules: [{ name: 'App', key: 'K', hasESpace: true, hasOpenedActiveESpace: true }] };
      if (method === 'snapshot_module') { fs.writeFileSync(params.path, 'base'); return { path: params.path, key: 'K' }; }
      throw new Error('a Studio write: ' + method);
    } };
    const ctx = { root, env: {}, now: () => new Date(), bridge: () => bridge, buildPool: createBuildPool({ dir: path.join(root, 'pool-' + code), size: 1 }),
      buildRunner: () => async () => ({ envelope }) };
    const lane = { local: path.join(root, 'local'), work: path.join(root, 'work'), name: 'ss4' };
    const deps = { o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4', connection: () => null };
    const built = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'App', job }, lane: 'o11', deps, phased: true },
      () => buildBeforeApply({ input: { module: 'App' }, job, ctx, lane, task: { id: 'T-' + code } }));
    assert.ok(built?.refused, code + ': answered from the build');
    const answer = deliverOutcome(built.refused, { trackId: 'T', work: lane.work, job, taskId: null, since: Date.now(), input: { module: 'App' } });
    assert.equal(answer.code, code);
    assert.equal(answer.verifyRan, true);
    assert.ok(answer.problems.every(p => typeof p.phase === 'string' && p.fix), JSON.stringify(answer.problems));
  }
  // The single refusal keeps the element and key of a Verify problem, and the patch.
  const answer = deliverOutcome({ envelope: refusedEnvelope }, { trackId: 'T', work: root, job, taskId: null, since: Date.now(), input: {} });
  assert.equal(answer.failed, 'preflight');
  assert.equal(answer.problems[2].element, UNION[2].element); assert.deepEqual(answer.problems[0].patch, UNION[0].patch);
  assert.deepEqual(answer.phases, ['preflight', 'apply', 'verify']);
});

test('ssam_job: the refusal keeps every patch whole, verifyRan and the phases; a refusal with problems is PREFLIGHT_REFUSED', () => {
  const long = [{ op: 'replace', path: '/ops/0/value', value: 'x'.repeat(800) }];
  const value = summarize({ lane: 'o11', job: 'j.json', out: 'o.oml', resultFile: 'r.json', saved: { ...refusedEnvelope, problems: [...UNION, { ...UNION[1], pointer: '/ops/0/value', patch: long }], wallMs: 1 } });
  assert.equal(value.ok, false); assert.equal(value.verifyRan, true); assert.deepEqual(value.phases, ['preflight', 'apply', 'verify']);
  assert.deepEqual(value.problems.at(-1).patch, long);
  assert.equal(refusalCode({ tool: 'studio_deliver', value: { ok: false, error: 'x', problems: UNION } }), 'PREFLIGHT_REFUSED');
});

test('a candidate only the Verify refused shows its problems in ssam_job, studio_deliver and o11_deliver', () => {
  const verify = [UNION[2]];
  const data = { accepted: false, isValid: false, flowLayoutEngine: 'anvil-d4d8ece', problems: verify, verifyRan: true, phases: ['verify'], validation: { unexpected: [{ id: 'ExpressionInvalidExpressionType' }] } };
  const job = summarize({ lane: 'o11', job: 'j.json', out: 'o.oml', resultFile: 'r.json', saved: { ok: true, data, wallMs: 1 } });
  assert.equal(job.ok, false); assert.equal(job.problems[0].pointer, UNION[2].pointer); assert.equal(job.verifyRan, true);
  const odc = interpretKernelResult({ ok: true, data }, { output: 'C:\\out' });
  assert.equal(odc.ok, false); assert.equal(odc.problems[0].key, 'k1'); assert.deepEqual(odc.phases, ['verify']);
  const o11 = deliverOutcome({ envelope: { ok: true, data: { stage: 'apply', apply: data, writeState: 'not-sent', error: 'job rejected by validation contract; merge was not attempted' } } },
    { trackId: 'T', work: 'C:\\nowhere', job: null, taskId: null, since: Date.now(), input: {} });
  assert.equal(o11.code, 'VALIDATION_REFUSED'); assert.equal(o11.problems[0].element, UNION[2].element); assert.equal(o11.verifyRan, true);
});

test('the patches of a refusal apply with patch + basedOn', t => {
  const root = tmp(t);
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'logic', data: { actions: [{ name: 'Read', outputs: [{ name: 'D', type: 'Integer' }], steps: [{ assign: { D: 'MaxDays' } }] }] } }] }));
  const hash = createHash('sha256').update(fs.readFileSync(job)).digest('hex');
  // The patches of the problems, together: what one correction sends.
  const patch = fitProblems(UNION).problems.flatMap(p => p.patch ?? []);
  const patched = resolvePatchedJob({ patch, basedOn: { job, sha256: hash } }, { root, inlineDir: path.join(root, 'inline'), journalDir: path.join(root, 'journal'), tool: 'o11_deliver' });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.equal(JSON.parse(fs.readFileSync(patched.path, 'utf8')).ops[0].data.actions[0].steps[0].assign.D, 'Site.MaxDays');
});

test('ssam_reference check-job: a job with its base is checked over it (every phase); without one it says the Verify did not run', async t => {
  const kernel = tempKernel({ cli: true });
  const run = fakeAnvil({
    'check-job': () => ({ ok: false, command: 'check-job', data: { valid: false, errors: ['op #0 ...'], problems: [UNION[0]], verifyRan: false, verifyReason: 'only the job was read' } }),
    apply: () => ({ exitCode: 1, envelope: refusedEnvelope }) });
  let n = 0;
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, uuid: () => `job-${++n}` });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const based = await mcp.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { base: 'blank-service.oml', ops: [{ op: 'logic', data: { actions: [] } }] } });
  assert.equal(run.calls[0].args[0], 'apply');
  assert.equal(based.code, 'JOB_INVALID'); assert.equal(based.verifyRan, true);
  assert.deepEqual(based.problems.map(p => p.phase), ['preflight', 'apply', 'verify']);
  const alone = await mcp.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { ops: [{ op: 'logic', data: { actions: [] } }] } });
  assert.equal(run.calls[1].args[0], 'check-job');
  assert.equal(alone.verifyRan, false); assert.match(alone.verifyReason, /only the job was read/);
  assert.equal(alone.problems[0].code, 'EXPR_UNKNOWN_IDENTIFIER');
});

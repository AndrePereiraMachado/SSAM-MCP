// VisitaCerta_CS, 2026-10-12 (the owner's 18 server actions in ssam-flow text): two VALIDATION_REFUSED answers of the
// build phase said only "job rejected by validation contract; merge was not attempted", and the task record and the journal
// kept no problem. A refusal of the validation contract now names the part that refused with its counts (the Verify of the
// candidate, the messages no expectation covers, the data contract) and always carries its problems: the kernel's, or one
// per new Verify error. The task record and the journal keep the contract and the problems by code. Fake bridge and fake
// Anvil CLI: no Studio, bridge, port or worker.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { validationContract, contractProblems } from '../o11-build-phase.mjs';
import { deliverOutcome, problemCodes } from '../o11-cycle.mjs';
import { receiptOutcome } from '../o11-access.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'tx-visitacerta-'));
const words = 'pode entregar, Ana 0912';
const job = { ops: [{ op: 'rename', from: 'A', to: 'B' }] };
const option = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// The verdict of the session's fourth job, short: the Verify's new errors, the messages no expectation covers.
const NEW = [
  { type: 'Error', id: 'ExpressionUnknownObject', path: 'M (ESpace) / CancelVisit (ServerAction) / IfNode', detail: "Invalid Expression | Can't identify 'VisitStatusId'", ownerKey: 'K1' },
  { type: 'Error', id: 'ExpressionUnknownObject', path: 'M (ESpace) / CompleteVisit (ServerAction) / IfNode', detail: "Invalid Expression | Can't identify 'VisitStatusId'", ownerKey: 'K2' },
  { type: 'Error', id: 'ExpressionUnknownFunction', path: 'M (ESpace) / GetPlaces (ServerAction) / Q (AggregateNode)', detail: "Unknown function 'Lower'", ownerKey: 'K3' },
  { type: 'Warning', id: 'UnusedVariable', path: 'M (ESpace) / GetPlaces (ServerAction) / X', detail: 'unused' }];
const UNEXPECTED = NEW.slice(0, 3).map(m => ({ id: m.id, element: m.path }));
const verdict = (problems) => ({ isValid: false, accepted: false, expectedValid: true, verifyRan: true,
  validation: { new: NEW, unexpected: UNEXPECTED }, policyMessages: NEW.slice(0, 3).map(m => 'Unexpected ' + m.id + ' @ ' + m.path), ...(problems ? { problems } : {}) });
const KERNEL_PROBLEMS = NEW.slice(0, 3).map((m, i) => ({ phase: 'verify', op: 3, pointer: '/ops/3/data/flow/' + (14 - i), code: m.id, severity: 'error',
  message: 'Error ' + m.id + ': ' + m.detail + ' @ ' + m.path, fix: 'fix the element as the Verify says', element: m.path, key: m.ownerKey }));

test('the validation contract names what refused with its counts; problems come from the Verify when the kernel gave none', () => {
  const contract = validationContract(verdict());
  assert.equal(contract.name, 'validation');
  assert.equal(contract.verifyErrors, 3);
  assert.deepEqual(contract.byCode, { ExpressionUnknownObject: 2, ExpressionUnknownFunction: 1 });
  assert.equal(contract.unexpectedMessages, 3);
  assert.equal(contract.summary, 'the Verify of the candidate: 3 errors (ExpressionUnknownObject 2, ExpressionUnknownFunction 1); 3 messages no expectedMessages entry covers');
  // The kernel's problems count when it gave them (by their codes).
  assert.equal(validationContract(verdict(KERNEL_PROBLEMS)).verifyErrors, 3);
  // A module valid as expected, refused only by an expectation: the Verify is not named.
  assert.equal(validationContract({ isValid: true, accepted: false, validation: { new: [], unexpected: [{ id: 'W1' }] } }).summary, '1 message no expectedMessages entry covers');
  assert.equal(validationContract({ isValid: true, accepted: false, dataContract: { accepted: false } }).summary, 'the data contract');
  assert.equal(validationContract(null), null);
  const fallback = contractProblems(verdict());
  assert.deepEqual(fallback.map(p => p.code), ['ExpressionUnknownObject', 'ExpressionUnknownObject', 'ExpressionUnknownFunction']);
  assert.equal(fallback[0].element, NEW[0].path);
  assert.equal(fallback[0].key, 'K1');
  // Without Verify errors, each uncovered message is a problem: never an empty list.
  assert.equal(contractProblems({ policyMessages: ['Unexpected W1 @ X'] })[0].code, 'UNEXPECTED_MESSAGE');
  assert.deepEqual(problemCodes(KERNEL_PROBLEMS), ['ExpressionUnknownObject 2', 'ExpressionUnknownFunction 1']);
});

test('a refusal of the delivery said only "job rejected by validation contract": it names the contract and carries the problems', () => {
  // The kernel's own sentence (Delivery.cs, a delivery that built under the lock) over a verdict without problems.
  const run = { envelope: { ok: true, command: 'deliver', data: { stage: 'apply', writeState: 'not-sent', apply: verdict(), error: 'job rejected by validation contract; merge was not attempted' } } };
  const out = deliverOutcome(run, { trackId: 'T', work: tmp(), job: null, taskId: null, since: Date.now(), input: { module: 'M' } });
  assert.equal(out.code, 'VALIDATION_REFUSED');
  assert.match(out.error, /^job rejected by validation contract \(the Verify of the candidate: 3 errors/);
  assert.equal(out.contract.verifyErrors, 3);
  assert.equal(out.problems.length, 3);
  assert.ok(out.problems.every(p => p.phase === 'verify' && p.severity === 'error' && p.fix));
});

function lane(root, applyData) {
  const log = { delivers: 0 };
  const bridge = { ok: async (method, params = {}) => {
    if (method === 'list_open_modules') return { modules: [{ name: 'VisitaCerta_CS', key: 'K-VC', hasESpace: true }] };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, 'OML'); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  const runAnvil = fakeAnvil({
    apply: async args => {
      const out = option(args, '--out');
      fs.writeFileSync(out, 'candidate'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), JSON.stringify(applyData));
      return { ok: true, command: 'apply', data: applyData };
    },
    deliver: async () => { log.delivers++; throw new Error('the Studio is never taken for a refused build'); },
  });
  return { log, bridge, runAnvil, buildRunner: () => runAnvil };
}

async function serve(t, root, fake) {
  const pool = createBuildPool({ dir: path.join(root, 'pool'), size: 2, queueMs: 10000 });
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil: fake.runAnvil, assertSelected: async () => {},
    tasksDir: path.join(root, 'tasks'), bridge: fake.bridge, lastPublication: async () => null, lock: { connection: () => null },
    buildPool: pool, buildRunner: fake.buildRunner },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tx-visitacerta', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

const files = (dir, name) => { const found = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === name) found.push(p); } }; walk(dir); return found; };

// Review of 2026-10-12: the policy messages that are no Verify message each have their own code and fix (the data contract,
// the refactor proof), and the contract names the refactor proof.
test('the data contract and the refactor proof are problems of their own, with the fix that resolves them', () => {
  const data = { isValid: true, accepted: false, validation: { new: [], unexpected: [] }, dataContract: { accepted: false, differences: [{}] },
    refactorProof: { accepted: false, differences: [{}] },
    policyMessages: ['Data property mismatch: {"element":"Site","property":"Days","expected":"3","actual":"2"}', 'Refactor reference sets changed after save/reload: [{}]'] };
  assert.equal(validationContract(data).summary, 'the data contract; the refactor proof (reference sets changed after save/reload)');
  assert.equal(validationContract(data).refactorProof, 'refused');
  const problems = contractProblems(data);
  assert.deepEqual(problems.map(p => p.code), ['DATA_CONTRACT', 'REFACTOR_PROOF']);
  assert.ok(problems.every(p => !/expectedMessages/.test(p.fix)), JSON.stringify(problems));
  // With Verify errors, the data contract is still named; an uncovered message is not counted twice.
  const both = contractProblems({ ...verdict(), dataContract: { accepted: false }, policyMessages: [...verdict().policyMessages, 'Data property mismatch: {}'] });
  assert.deepEqual(both.map(p => p.code), ['ExpressionUnknownObject', 'ExpressionUnknownObject', 'ExpressionUnknownFunction', 'DATA_CONTRACT']);
});

// The lane of until=apply: the bridge opens the module and captures it, the fake CLI answers the apply.
function applyLane(applyData) {
  const bridge = { ok: async (method, params = {}) => {
    if (method === 'list_open_modules') return { modules: [{ name: 'VisitaCerta_CS', key: 'K-VC', hasESpace: true }] };
    if (method === 'open_module') return { opened: true };
    if (method === 'get_active_module') return { name: 'VisitaCerta_CS', key: 'K-VC' };
    if (method === 'snapshot_module') { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, 'OML'); return { key: 'K-VC', path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  const runAnvil = fakeAnvil({
    apply: async args => {
      const out = option(args, '--out');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'candidate'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), JSON.stringify(applyData));
      return { ok: true, command: 'apply', data: applyData };
    },
  });
  return { bridge, runAnvil, buildRunner: () => runAnvil };
}

// Review of 2026-10-12: o11_deliver until=apply answered a VALIDATION_REFUSED with messages alone ("Job rejected by the
// validation contract; nothing was merged."), no problems and no contract, and its continuation patched /ops/<i>/<campo>
// blindly. It answers as a delivery does: the contract, every problem, the op they name.
test('o11_deliver until=apply: a candidate the validation contract refuses names the contract and carries every problem and the op', async t => {
  const root = tmp();
  const client = await serve(t, root, applyLane(verdict(KERNEL_PROBLEMS)));
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, until: 'apply', authorize: words } });
  const value = answer.structuredContent ?? JSON.parse(answer.content[0].text);
  assert.equal(value.code, 'VALIDATION_REFUSED', JSON.stringify(value));
  assert.match(value.error, /^Job rejected by the validation contract \(the Verify of the candidate: 3 errors \(ExpressionUnknownObject 2, ExpressionUnknownFunction 1\); 3 messages no expectedMessages entry covers\); nothing was merged\.$/);
  assert.equal(value.contract?.verifyErrors, 3, JSON.stringify(value));
  assert.deepEqual(value.problems?.flatMap(p => p.pointers ?? [p.pointer]), ['/ops/3/data/flow/14', '/ops/3/data/flow/13', '/ops/3/data/flow/12']);
  assert.equal(value.failedOp, 3);
});

test('o11_deliver until=apply: a candidate only the data contract refuses carries its difference as a problem, never only messages', async t => {
  const root = tmp();
  const data = { isValid: true, accepted: false, expectedValid: true, validation: { new: [], unexpected: [] },
    policyMessages: ['Data property mismatch: {"element":"Site","property":"Days"}'], dataContract: { accepted: false, differences: [{}] } };
  const client = await serve(t, root, applyLane(data));
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, until: 'apply', authorize: words } });
  const value = answer.structuredContent ?? JSON.parse(answer.content[0].text);
  assert.equal(value.code, 'VALIDATION_REFUSED', JSON.stringify(value));
  assert.equal(value.contract?.summary, 'the data contract');
  assert.deepEqual(value.problems?.map(p => p.code), ['DATA_CONTRACT']);
});

// Review of 2026-10-12: o11_access answered the refused delivery of a manifest with messages alone.
test('o11_access: a delivery the validation contract refused names the contract and carries every problem', () => {
  const work = tmp();
  const taskId = 'a'.repeat(32);
  fs.mkdirSync(path.join(work, 'deliver', taskId), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', taskId, 'task.json'), JSON.stringify({ taskId, delivered: false, writeState: 'not-sent', stage: 'apply',
    error: 'job rejected by validation contract; merge was not attempted', apply: verdict() }));
  const receipt = { status: 'failed', deliveries: [{ status: 'failed', module: 'VisitaCerta_CS', taskId }] };
  const value = receiptOutcome(receipt, { input: { action: 'apply', manifestPath: 'm.json' }, operationId: 'b'.repeat(32), deliverWork: work });
  assert.equal(value.code, 'VALIDATION_REFUSED', JSON.stringify(value));
  assert.match(value.error, /^job rejected by validation contract \(the Verify of the candidate: 3 errors/);
  assert.equal(value.contract?.verifyErrors, 3);
  assert.equal(value.problems?.length, 3);
  assert.ok(value.problems.every(p => p.phase === 'verify' && p.fix));
});

// Re-check of 2026-10-12 (kernel probe K1, both lanes; facade probe V1): a valid new action on a base the Verify already
// refuses. The candidate is invalid only because of an error the module had before the job: validation.new has no error, the
// error is in validation.preexisting, the kernel gives no problems and only the expectValid message. The refusal named "the
// Verify of the candidate: 0 errors" and no problem. It names the error the module already had, with its element and key.
const K1 = { isValid: false, accepted: false, expectedValid: true, verifyRan: true,
  validation: {
    new: [{ id: 'UnusedUserAction', type: 'Warning', path: 'Headless_CS (ESpace) / PkFine (ServerAction)', detail: "Unused User Action | 'PkFine' action is never used in this module.", ownerKey: 'DAgaUgebaUq7zveK7oBxjQ' }],
    preexisting: [
      { id: 'ExpressionUnknownObject', type: 'Error', key: '["ExpressionUnknownObject","UsurLsqO+UqUjzSbTmgA7Q",["Value"],["NoSuchThing"]]',
        path: 'Headless_CS (ESpace) / PkBroken (ServerAction) / AssignNode / Assignment', detail: "Invalid Expression | Can't identify 'NoSuchThing' element in expression.", ownerKey: 'UsurLsqO+UqUjzSbTmgA7Q' },
      { id: 'UnusedUserAction', type: 'Warning', path: 'Headless_CS (ESpace) / PkBroken (ServerAction)', detail: 'Unused User Action', ownerKey: 'IjGJIQUDcEqoDWzzmRQBTA' }],
    unexpected: [] },
  policyMessages: ['expectValid=True, but Verify isValid=False'] };

const isK1Problem = p => p.code === 'ExpressionUnknownObject' && p.key === 'UsurLsqO+UqUjzSbTmgA7Q'
  && p.element === 'Headless_CS (ESpace) / PkBroken (ServerAction) / AssignNode / Assignment' && /already had this error before the job/.test(p.fix);

test('a candidate invalid only by an error the module already had names that error, its element and its key, never "0 errors"', () => {
  const contract = validationContract(K1);
  assert.equal(contract.summary, 'the module already had 1 error (ExpressionUnknownObject 1), the job added none');
  assert.equal(contract.preexistingErrors, 1);
  assert.equal(contract.verifyErrors, 0);
  const problems = contractProblems(K1);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(isK1Problem(problems[0]), JSON.stringify(problems[0]));
  // A new error of the job is the problem; what the module had is not named then.
  const both = { ...K1, validation: { ...K1.validation, new: [...K1.validation.new, NEW[0]] } };
  assert.deepEqual(contractProblems(both).map(p => p.key), ['K1']);
  assert.match(validationContract(both).summary, /^the Verify of the candidate: 1 error/);
});

test('o11_deliver until=apply, the build phase and o11_access: the error the module already had is the problem', async t => {
  const apply = await serve(t, tmp(), applyLane(K1));
  const atApply = (a => a.structuredContent ?? JSON.parse(a.content[0].text))(await apply.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, until: 'apply', authorize: words } }));
  assert.equal(atApply.code, 'VALIDATION_REFUSED', JSON.stringify(atApply));
  assert.match(atApply.error, /the module already had 1 error/);
  assert.equal(atApply.problems?.length, 1, JSON.stringify(atApply));
  assert.ok(isK1Problem(atApply.problems[0]), JSON.stringify(atApply.problems));
  const root = tmp();
  const build = await serve(t, root, lane(root, K1));
  const built = (a => a.structuredContent ?? JSON.parse(a.content[0].text))(await build.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, authorize: words } }));
  assert.equal(built.code, 'VALIDATION_REFUSED', JSON.stringify(built));
  assert.match(built.error, /the module already had 1 error/);
  assert.ok(isK1Problem(built.problems?.[0] ?? {}), JSON.stringify(built));
  const work = tmp();
  const taskId = 'a'.repeat(32);
  fs.mkdirSync(path.join(work, 'deliver', taskId), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', taskId, 'task.json'), JSON.stringify({ taskId, delivered: false, writeState: 'not-sent', stage: 'apply',
    error: 'job rejected by validation contract; merge was not attempted', apply: K1 }));
  const access = receiptOutcome({ status: 'failed', deliveries: [{ status: 'failed', module: 'VisitaCerta_CS', taskId }] },
    { input: { action: 'apply', manifestPath: 'm.json' }, operationId: 'b'.repeat(32), deliverWork: work });
  assert.equal(access.code, 'VALIDATION_REFUSED', JSON.stringify(access));
  assert.ok(isK1Problem(access.problems?.[0] ?? {}), JSON.stringify(access));
});

// Re-check of 2026-10-12 (facade probe V4): o11_deliver until=apply answered a refusal of the kernel itself (PREFLIGHT_REFUSED
// with problems, no data) with APPLY_FAILED, its problems in one string and a doctor hint. It answers as the build phase does.
test('o11_deliver until=apply: the kernel\'s own refusal of the job comes with every problem, never APPLY_FAILED', async t => {
  const problems = [{ phase: 'preflight', op: 0, pointer: '/ops/0/data/flow/0', code: 'FLOW_SYNTAX', severity: 'error', message: 'logic: line 6: expected a line at depth 2', fix: 'two readings: ...',
      candidates: [{ reading: 'goes on', patch: [{ op: 'replace', path: '/ops/0/data/flow/0', value: 'x' }] }] },
    { phase: 'apply', op: 0, pointer: '/ops/0/data/flow/1', code: 'FLOW_MAPPING_CURSOR', severity: 'error', message: 'the mapping reads Q.List.Current', fix: 'write the item',
      patch: [{ op: 'replace', path: '/ops/0/data/flow', value: ['y'] }] }];
  const fake = applyLane(null);
  fake.runAnvil = fakeAnvil({ apply: async () => ({ ok: false, command: 'apply', code: 'PREFLIGHT_REFUSED', error: 'PREFLIGHT_REFUSED: 2 problems', problems }) });
  const client = await serve(t, tmp(), fake);
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, until: 'apply', authorize: words } });
  const value = answer.structuredContent ?? JSON.parse(answer.content[0].text);
  assert.equal(value.code, 'PREFLIGHT_REFUSED', JSON.stringify(value));
  assert.deepEqual(value.problems?.map(p => p.code), ['FLOW_SYNTAX', 'FLOW_MAPPING_CURSOR']);
  assert.deepEqual(value.problems[1].patch, problems[1].patch);
  assert.ok(value.nextBasedOn?.sha256, JSON.stringify(value));
  assert.notEqual(value.continuation?.tool, 'ssam_doctor');
  // An apply refused with its own code and problems keeps that code.
  const own = applyLane(null);
  own.runAnvil = fakeAnvil({ apply: async () => ({ ok: false, command: 'apply', code: 'DELETE_HAS_CONSUMERS', error: 'DELETE_HAS_CONSUMERS: 1 problem', problems: [problems[1]] }) });
  const second = await serve(t, tmp(), own);
  const refused = (a => a.structuredContent ?? JSON.parse(a.content[0].text))(await second.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, until: 'apply', authorize: words } }));
  assert.equal(refused.code, 'DELETE_HAS_CONSUMERS', JSON.stringify(refused));
  assert.equal(refused.problems?.length, 1);
});

for (const [label, problems] of [['with the kernel\'s problems', KERNEL_PROBLEMS], ['when the kernel gave none', undefined]]) {
  test('o11_deliver: a build the validation contract refuses names it and carries every problem ' + label + '; the task record and the journal keep them', async t => {
    const root = tmp();
    const fake = lane(root, verdict(problems));
    const client = await serve(t, root, fake);
    const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'VisitaCerta_CS', job, authorize: words } });
    const value = answer.structuredContent ?? JSON.parse(answer.content[0].text);
    assert.equal(value.code, 'VALIDATION_REFUSED', JSON.stringify(value));
    assert.equal(fake.log.delivers, 0);
    assert.match(value.error, /job rejected by validation contract \(the Verify of the candidate: 3 errors \(ExpressionUnknownObject 2, ExpressionUnknownFunction 1\); 3 messages no expectedMessages entry covers\); merge was not attempted/);
    assert.equal(value.contract?.verifyErrors, 3, JSON.stringify(value));
    assert.equal(value.problems?.reduce((sum, p) => sum + (p.count ?? 1), 0), 3, JSON.stringify(value));
    if (problems) assert.deepEqual(value.problems.flatMap(p => p.pointers ?? [p.pointer]), ['/ops/3/data/flow/14', '/ops/3/data/flow/13', '/ops/3/data/flow/12']);
    // The task record (ssam_task) says what refused.
    const [record] = files(path.join(root, 'tasks'), fs.readdirSync(path.join(root, 'tasks')).find(n => n.endsWith('.json')));
    const task = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(task.result.code, 'VALIDATION_REFUSED');
    assert.equal(task.result.problemsTotal, 3);
    assert.match(task.result.contract, /^the Verify of the candidate: 3 errors/);
    assert.match(task.result.problems[0], /^ExpressionUnknownObject /);
    // The journal's end line too.
    const [journal] = files(root, 'o11_deliver.jsonl');
    const end = fs.readFileSync(journal, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.event === 'end');
    assert.equal(end.problems, 3);
    assert.deepEqual(end.codes, ['ExpressionUnknownObject 2', 'ExpressionUnknownFunction 1']);
    assert.match(end.contract, /3 errors/);
  });
}

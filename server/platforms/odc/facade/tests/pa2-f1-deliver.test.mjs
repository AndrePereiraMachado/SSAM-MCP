// Lane F1 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md), facade part, on a real McpServer over InMemoryTransport with a
// fake Anvil CLI and temporary folders only (no Studio, no bridge, no kernel CLI):
// - A03 (I9): warnings that block nothing come back in "entregue" (at most 20 plus warningsTotal) and in a refusal with
//   errors, from the kernel task (result.warnings) or, for an older kernel, from the apply's nonblocking verdicts; the ODC
//   studio_deliver path reads them from the kernel apply's verdicts (kernel-delivery.mjs);
// - A12: DATA_PROOF_DIFFERS answers dataProof.differences (at most 20 plus differencesTotal) and the ssam_evidence
//   continuation on the task's result.json;
// - A28: MODULE_RESERVED_FOREIGN, or a holder task this root does not have, continues with ssam_doctor {lane:"o11"};
// - A17: a task never sent closes without the selected Studio (the kernel closes it without any Studio call).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle, deliveryFields, deliverOutcome, dataProofOf } from '../o11-cycle.mjs';
import { interpretKernelResult, warningsOf, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { warningFields, warningsFromVerdicts, fixOf, readVerifyHints, UNUSED_FIX } from '../delivery-warnings.mjs';
import { anvilRoot } from '../workspace.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const WORDS = 'sim, pode entregar o Orders';
const TASK = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const HOLDER = '3c4d5e6f708192a3b4c5d6e7f8091a2b';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f1-deliver-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45998,
    studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const job = (name, document) => { const file = path.join(base, 'jobs', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(document)); return file; };
  let clock = Date.parse('2026-10-06T10:00:00.000Z');
  return { base, root, env, job, local: path.join(root, '.local'), work: path.join(root, '.local', 'work'), now: () => new Date(clock += 1000) };
}

async function serve(t, deps) {
  const server = new McpServer({ name: 'pa2-f1-deliver', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f1-deliver-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: args.__tool ?? 'o11_deliver', arguments: Object.fromEntries(Object.entries(args).filter(([k]) => k !== '__tool')) })
    .then(reply => reply.structuredContent ?? JSON.parse(reply.content[0].text === 'entregue' ? '{"ok":true,"result":"entregue"}' : reply.content[0].text));
}

function setup(t, { deliver, extra = {} } = {}) {
  const box = sandbox(t);
  const selected = [];
  const runAnvil = fakeAnvil({ deliver });
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, lastPublication: async () => null,
    assertSelected: async () => { selected.push(true); }, grantsFile: path.join(box.base, 'grants.json'), ...extra };
  return { ...box, runAnvil, selected, deps };
}

function writeKernelTask(work, id, state) {
  const dir = path.join(work, 'deliver', id); fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ taskId: id, module: 'Orders', work: dir, ...state });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
}

const warning = i => ({ id: i % 2 ? 'UnusedElement' : 'JSNodeTooLarge', path: 'Orders (ESpace) / E' + i + ' (Structure)', key: 'k' + i,
  detail: 'Structure E' + i + ' is never used.', fix: i % 2 ? 'Remova o elemento ou use-o.' : null });

// ---- A03
test('a delivery with only warnings answers "entregue" with at most 20 warnings and warningsTotal, each with path and fix', async t => {
  const warnings = Array.from({ length: 25 }, (_, i) => warning(i));
  const s = setup(t, { deliver: () => ({ ok: true, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: true, writeState: 'applied',
    validation: { newErrors: 0 }, warnings } }) });
  const value = await (await serve(t, s.deps))({ module: 'Orders', job: s.job('a.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value)); assert.equal(value.result, 'entregue');
  assert.equal(value.warnings.length, 20); assert.equal(value.warningsTotal, 25);
  assert.deepEqual(value.warnings[1], { id: 'UnusedElement', path: 'Orders (ESpace) / E1 (Structure)', key: 'k1', detail: 'Structure E1 is never used.', fix: 'Remova o elemento ou use-o.' });
  // Up to 20, no total.
  assert.deepEqual(Object.keys(warningFields(warnings.slice(0, 20))), ['warnings']);
  assert.deepEqual(warningFields([]), {});
});

test('an older kernel without result.warnings: the warnings come from the apply\'s nonblocking verdicts, with the curated fix', () => {
  const hints = readVerifyHints(anvilRoot);
  assert.ok(typeof hints.UnusedElement === 'string' && hints.UnusedElement.length > 0, 'the kernel catalog has the UnusedElement hint');
  const fields = deliveryFields({ delivered: true, apply: { validation: { verdicts: [
    { id: 'UnusedElement', type: 'Warning', path: 'Orders / Board (Structure)', ownerKey: 'b-key', detail: 'Structure\n Board is never used.', verdict: 'nonblocking', reason: 'warning-non-blocking' },
    { id: 'UnusedFancy', type: 'Warning', path: 'Orders / X', verdict: 'nonblocking' },
    { id: 'UnusedAction', type: 'Warning', path: 'Orders / Helper', verdict: 'allowlisted', reason: 'unused-created-by-job' }] } } });
  assert.deepEqual(fields.warnings, [
    { id: 'UnusedElement', path: 'Orders / Board (Structure)', key: 'b-key', detail: 'Structure Board is never used.', fix: hints.UnusedElement },
    { id: 'UnusedFancy', path: 'Orders / X', detail: '', fix: UNUSED_FIX }]);
  assert.equal(fields.leftovers.length, 1, 'the allowlisted Unused* stays a leftover');
  assert.equal(fixOf('JSNodeTooLarge', {}), null);
  assert.equal(warningsFromVerdicts([{ id: 'X', verdict: 'nonblocking', detail: 'y'.repeat(500) }], { hints: {} })[0].detail.length, 200);
});

test('a refusal with errors also names the warnings that block nothing', async t => {
  const s = setup(t, { deliver: () => ({ ok: false, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'apply',
    error: 'job rejected by validation contract; merge was not attempted',
    apply: { isValid: false, accepted: false, validation: { new: [{ id: 'ExpressionUnknownObject', type: 'Error', path: 'Orders / A', detail: "Can't identify 'GrupoSelecionado' element" }] } },
    warnings: [warning(1)] } }) });
  const value = await (await serve(t, s.deps))({ module: 'Orders', job: s.job('b.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(value.ok, false); assert.equal(value.code, 'VALIDATION_REFUSED');
  assert.deepEqual(value.warnings, [warning(1)]);
  assert.ok(value.messages.some(m => /ExpressionUnknownObject/.test(m)));
});

test('studio_deliver (ODC): the kernel apply\'s nonblocking verdicts become warnings, in a refusal too', () => {
  const validation = { verdicts: [{ id: 'UnusedElement', type: 'Warning', path: 'Quotes / WF_Bld_AttachedGarage (ClientVariable)', ownerKey: '_3NEpL+lfEmiAvkDE1T8xg',
    detail: "Client Variable 'WF_Bld_AttachedGarage' is never used in App 'Quotes'. Consider deleting it.", verdict: 'nonblocking' },
    { id: 'UnusedAction', path: 'Quotes / Tmp', verdict: 'allowlisted' }] };
  const accepted = interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, validation } }, { output: 'o' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.warnings.length, 1);
  assert.equal(accepted.warnings[0].key, '_3NEpL+lfEmiAvkDE1T8xg');
  assert.ok(accepted.warnings[0].fix, 'the curated hint of UnusedElement');
  const refused = interpretKernelResult({ ok: false, error: 'x', data: { accepted: false, isValid: false, flowLayoutEngine: requiredFlowLayoutEngine, validation } }, { output: 'o' });
  assert.equal(refused.ok, false); assert.equal(refused.warnings.length, 1);
  assert.deepEqual(warningsOf({}), []);
});

// ---- A12
test('DATA_PROOF_DIFFERS answers the differences (20 plus differencesTotal) and the ssam_evidence continuation on result.json', async t => {
  const differences = Array.from({ length: 25 }, (_, i) => ({ element: 'SS360_Portal (ESpace) / E' + i, property: 'Description', expected: 'a' + i, actual: 'b' + i, platformRewrites: null }));
  const box = sandbox(t);
  const taskDir = path.join(box.work, 'deliver', TASK);
  const state = { taskId: TASK, module: 'SS360_Portal', work: taskDir, delivered: false, writeState: 'applied', stage: 'data-proof', code: 'DATA_PROOF_DIFFERS',
    merge: { merged: true }, validation: { newErrors: 0 }, dataProof: { accepted: false, differences },
    failures: [{ stage: 'data-proof', error: 'Merge kept for review: delivered data differs from the task (25 difference(s)); inspect dataProof.differences' }],
    error: 'Merge kept for review: delivered data differs from the task (25 difference(s)); inspect dataProof.differences' };
  const value = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: state } }, { trackId: 't', work: box.work, job: null, input: { module: 'SS360_Portal' } });
  assert.equal(value.code, 'DATA_PROOF_DIFFERS'); assert.equal(value.merged, true);
  assert.equal(value.dataProof.differences.length, 20); assert.equal(value.dataProof.differencesTotal, 25);
  assert.deepEqual(value.dataProof.differences[0], { element: 'SS360_Portal (ESpace) / E0', property: 'Description', expected: 'a0', actual: 'b0' });
  assert.deepEqual(value.continuation, { tool: 'ssam_evidence', arguments: { file: path.join(taskDir, 'result.json'), pointer: '/dataProof/differences' },
    why: value.continuation.why });
  assert.match(value.continuation.why, /Ctrl\+Z/);
  // A proof that did not fail, or names nothing, adds no field.
  assert.equal(dataProofOf({ dataProof: { accepted: true, differences } }), null);
  assert.equal(dataProofOf({ dataProof: { accepted: false, differences: [] } }), null);
  // Another kernel code keeps its own continuation; the differences still come.
  const other = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { ...state, code: 'VERIFY_UNAVAILABLE' } } }, { trackId: 't', work: box.work, job: null, input: {} });
  assert.equal(other.code, 'VERIFY_UNAVAILABLE'); assert.equal(other.dataProof.differences.length, 20); assert.equal(other.continuation, undefined);
});

// ---- A28
test('a module reserved by another SSAM root, or by a task this root does not have, continues with ssam_doctor', async t => {
  const foreign = setup(t, { deliver: () => ({ ok: false, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'active-module',
    code: 'MODULE_RESERVED_FOREIGN', error: 'Module is reserved by task ' + HOLDER + ' of another SSAM root (C:\\Users\\andre\\SSAM-Hybrid\\kernel, pid 4711, since 2026-09-29T10:00:00Z); release it with ssam_doctor {lane:"o11", release}' } }) });
  const a = await (await serve(t, foreign.deps))({ module: 'Orders', job: foreign.job('c.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(a.code, 'MODULE_RESERVED_FOREIGN');
  assert.deepEqual(a.continuation.tool, 'ssam_doctor'); assert.deepEqual(a.continuation.arguments, { lane: 'o11' });
  // The same-root sentence naming a task this root does not have (the orphan reservation of 2026-09-29: TASK_NOT_FOUND).
  const orphan = setup(t, { deliver: () => ({ ok: false, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'active-module',
    error: 'InvalidOperationException: Module has an unfinished delivery; resume task ' + HOLDER + ' before starting another' } }) });
  const b = await (await serve(t, orphan.deps))({ module: 'Orders', job: orphan.job('d.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(b.continuation.tool, 'ssam_doctor'); assert.deepEqual(b.continuation.arguments, { lane: 'o11' });
  assert.ok(!JSON.stringify(b).includes('"resume"'), 'never resume a task this root does not have');
  // A holder of this root is still resumed (uncertain) or closed with the corrected job (refused).
  writeKernelTask(orphan.work, HOLDER, { moduleKey: 'k1', writeState: 'unknown', stage: 'merge', error: 'timed out' });
  const c = await (await serve(t, orphan.deps))({ module: 'Orders', job: orphan.job('e.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.deepEqual(c.continuation.arguments, { resume: HOLDER });
});

// ---- A17
test('a task never sent closes without the selected Studio, through o11_deliver close and ssam_task close', async t => {
  const s = setup(t, { deliver: args => ({ ok: true, command: 'deliver', data: { taskId: args[2], closed: true, closedWithoutStudio: true, writeState: 'not-sent' } }),
    extra: { assertSelected: async () => { throw new Error('The selected Studio session is no longer connected.'); } } });
  const notSent = 'a'.repeat(32), applied = 'b'.repeat(32);
  writeKernelTask(s.work, notSent, { moduleKey: 'k', environment: 'lab.example', writeState: 'not-sent', delivered: false,
    error: 'op #280 (html ): InvalidOperationException: html: line 1 col 3002 <label>: <label> takes text, not child elements' });
  writeKernelTask(s.work, applied, { moduleKey: 'k', environment: 'lab.example', writeState: 'applied', delivered: false, validation: { newErrors: 1 }, error: 'kept for review' });
  const call = await serve(t, s.deps);
  const closed = await call({ close: { taskId: notSent, reason: 'superseded by a corrected job' }, authorize: WORDS });
  assert.equal(closed.ok, true, JSON.stringify(closed)); assert.equal(closed.result, 'fechada');
  const viaTask = await call({ __tool: 'ssam_task', id: notSent, close: { reason: 'again' } });
  assert.equal(viaTask.ok, true, JSON.stringify(viaTask));
  assert.deepEqual(s.runAnvil.calls.map(c => c.args.slice(0, 3)), [['deliver', '--close', notSent], ['deliver', '--close', notSent]]);
  // A task with something to prove still needs the selected Studio.
  const refused = await call({ close: { taskId: applied, reason: 'x' }, authorize: WORDS });
  assert.equal(refused.code, 'STUDIO_NOT_SELECTED');
  assert.equal(s.runAnvil.calls.length, 2);
});

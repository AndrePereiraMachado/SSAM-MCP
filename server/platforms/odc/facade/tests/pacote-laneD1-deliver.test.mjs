// Lane D1 of the 2026-10-05 session package (docs/PACOTE-SESSOES-NOVO.md): o11_deliver and ssam_task rules, on a real
// McpServer over InMemoryTransport with a fake Anvil CLI, a fake publication runner and temporary folders only.
// publish:true (C08), standing grants (I6), preflight problems (C20/C28), producers captured by name (C27), the StyleSheet
// touch (C32), the section 3.2 fields and ssam_task close (C15).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle, WORDS_MARKER, autoCaptures, deliveryFields, publishField, preflightProblems } from '../o11-cycle.mjs';
import { addGrant } from '../standing-grants.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

const sha256 = text => createHash('sha256').update(text).digest('hex');
const WORDS = 'sim, pode entregar e publicar o Orders';
const TASK = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-deliver-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45998,
    studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const job = (name, document) => { const file = path.join(base, 'jobs', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(document)); return file; };
  let clock = Date.parse('2026-10-05T10:00:00.000Z');
  return { base, root, env, auth, job, local: path.join(root, '.local'), work: path.join(root, '.local', 'work'),
    grants: path.join(base, 'grants', 'standing-grants.json'), now: () => new Date(clock += 1000) };
}

async function serve(t, deps) {
  const server = new McpServer({ name: 'pacote-d1-deliver', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-d1-deliver-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: args.__tool ?? 'o11_deliver', arguments: Object.fromEntries(Object.entries(args).filter(([k]) => k !== '__tool')) })
    .then(reply => reply.structuredContent ?? JSON.parse(reply.content[0].text === 'delivered' ? '{"ok":true,"result":"delivered"}' : reply.content[0].text));
}

function setup(t, { handlers, publish, extra = {} } = {}) {
  const box = sandbox(t);
  const runAnvil = fakeAnvil(handlers ?? { deliver: () => envelopes.delivered });
  const published = [];
  const publisher = publish === undefined ? null : async (input, options) => { published.push({ input, options }); return typeof publish === 'function' ? publish(input) : publish; };
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => {}, grantsFile: box.grants,
    lastPublication: async () => null, ...(publisher ? { publish: publisher } : {}), ...extra };
  return { ...box, runAnvil, published, deps };
}

// ---- C08: publish:true
test('publish:true publishes only after a clean merge, with the same words, and answers "delivered and published"', async t => {
  const s = setup(t, { publish: { ok: true, result: 'published', lastPublication: { at: '2026-10-05T10:01:00Z', status: 'succeeded', version: null, author: null, by: 'ssam', source: 'publish-result' }, dialogsSeen: ['login: Sign in'] } });
  const call = await serve(t, s.deps);
  const value = await call({ module: 'Orders', job: s.job('a.json', { ops: [{ op: 'get', target: 'ServerAction:SaveOrder' }] }), publish: true, authorize: WORDS });
  assert.equal(value.ok, true); assert.equal(value.result, 'delivered and published');
  assert.deepEqual(value.publish, { requested: true, outcome: 'published', at: '2026-10-05T10:01:00Z', dialogsSeen: ['login: Sign in'] });
  assert.equal(value.lastPublication.by, 'ssam');
  assert.equal(s.published.length, 1);
  assert.deepEqual(s.published[0].input, { module: 'Orders', authorize: WORDS });
  assert.equal(s.runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 1);
});

test('a merge that is not clean skips the publication; a failed or uncertain one never repeats the delivery', async t => {
  const refused = setup(t, { handlers: { deliver: () => envelopes.refusedBeforeMerge }, publish: { ok: true } });
  const skipped = await (await serve(t, refused.deps))({ module: 'Orders', job: refused.job('b.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(skipped.ok, false);
  assert.deepEqual(skipped.publish, { requested: true, outcome: 'skipped' });
  assert.equal(refused.published.length, 0);

  const failed = setup(t, { publish: { ok: false, outcome: 'failed', code: 'PUBLISH_FAILED', error: 'The publication of Orders failed at Compilation: x; it is not published.',
    messages: [{ type: 'Warning', text: 'w' }, { type: 'Error', stage: 'Compilation', text: 'x' }] } });
  const answer = await (await serve(t, failed.deps))({ module: 'Orders', job: failed.job('c.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(answer.ok, false); assert.equal(answer.result, 'delivered'); assert.equal(answer.code, 'PUBLISH_FAILED');
  assert.equal(answer.publish.outcome, 'failed'); assert.equal(answer.publish.messages[0].type, 'Error', 'errors first');
  assert.equal(answer.continuation.tool, 'o11_publish');
  assert.deepEqual(answer.continuation.arguments, { module: 'Orders', authorize: WORDS_MARKER });
  assert.equal(failed.runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 1, 'the delivery is never repeated');

  const uncertain = setup(t, { publish: { ok: false, outcome: 'uncertain', code: 'PUBLISH_UNCERTAIN', error: 'no confirmed end' } });
  const unsure = await (await serve(t, uncertain.deps))({ module: 'Orders', job: uncertain.job('d.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(unsure.code, 'PUBLISH_UNCERTAIN'); assert.equal(unsure.outcome, 'uncertain'); assert.equal(unsure.result, 'delivered');
});

// ---- I6: standing grants
test('without authorize a standing grant of the module for deliver is used and named; without one nothing runs', async t => {
  const s = setup(t);
  const call = await serve(t, s.deps);
  const job = s.job('e.json', { ops: [{ op: 'get', target: 'X:Y' }] });
  const none = await call({ module: 'Orders', job });
  assert.equal(none.code, 'WORDS_REQUIRED'); assert.equal(s.runAnvil.calls.length, 0);
  const granted = addGrant({ lane: 'o11', app: 'Orders App', modules: ['Orders'], verbs: ['deliver'], words: 'pode entregar o Orders App sempre' }, { file: s.grants });
  assert.equal(granted.ok, true);
  const value = await call({ module: 'Orders', job });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.authorization, { source: 'standing-grant', grantId: granted.grant.grantId });
  const journal = fs.readFileSync(path.join(s.local, 'journal', 'o11_deliver.jsonl'), 'utf8');
  assert.ok(journal.includes(sha256('pode entregar o Orders App sempre')));
  assert.ok(!journal.includes('pode entregar o Orders App sempre'), 'only the sha256 of the grant words');
  // A grant for publish only does not cover deliver.
  const other = setup(t);
  addGrant({ lane: 'o11', app: 'Orders App', modules: ['Orders'], verbs: ['publish'], words: 'pode publicar o Orders App' }, { file: other.grants });
  assert.equal((await (await serve(t, other.deps))({ module: 'Orders', job })).code, 'WORDS_REQUIRED');
});

// ---- C20/C28: preflight
test('a refused preflight answers PREFLIGHT_REFUSED with every problem, from the task or from the CLI envelope', async t => {
  const problems = [{ op: 0, pointer: '/ops/0', code: 'A_CODE', severity: 'error', message: 'first', fix: 'use x' },
    { op: 2, pointer: '/ops/2', code: 'B_CODE', severity: 'error', message: 'second', fix: null }, { op: 4, pointer: null, code: 'C_CODE', severity: 'error', message: 'third', fix: 'z' }];
  const fromTask = setup(t, { handlers: { deliver: () => ({ ok: false, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: false, writeState: 'not-sent',
    stage: 'preflight', code: 'PREFLIGHT_REFUSED', problems, error: 'Job refused by the preflight before any Studio call; nothing was sent.' } }) } });
  const a = await (await serve(t, fromTask.deps))({ module: 'Orders', job: fromTask.job('f.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(a.code, 'PREFLIGHT_REFUSED'); assert.equal(a.stage, 'preflight'); assert.equal(a.failed, 'preflight');
  assert.deepEqual(a.problems.map(p => p.code), ['A_CODE', 'B_CODE', 'C_CODE']);
  assert.ok(a.job && a.jobSha256, 'names the job to patch');
  const fromCli = setup(t, { handlers: { deliver: () => ({ ok: false, code: 'PREFLIGHT_REFUSED', problems, error: 'PREFLIGHT_REFUSED' }) } });
  const b = await (await serve(t, fromCli.deps))({ module: 'Orders', job: fromCli.job('g.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(b.code, 'PREFLIGHT_REFUSED'); assert.equal(b.problems.length, 3);
  assert.equal(preflightProblems([{ message: 'm'.repeat(1000) }])[0].message.length, 300);
  const [mapping] = preflightProblems([{ message: 'map', text: 't'.repeat(5000), corrected: { steps: [{ call: 'ListAppendAll' }] },
    patch: [{ op: 'replace', path: '/ops/0/data/actions/0/steps/0', value: { call: 'ListAppendAll' } }] }]);
  // (review refusal-followups L-A: the text of a problem is code, the line or block of its fix: whole, as ssam_job has it)
  assert.equal(mapping.text.length, 5000);
  assert.deepEqual(mapping.corrected, { steps: [{ call: 'ListAppendAll' }] });
  assert.equal(mapping.patch[0].value.call, 'ListAppendAll');
});

// ---- C27: producers captured by name
test('every producer a reference op names is captured read-only, unless bound or already captured', async t => {
  const s = setup(t);
  const call = await serve(t, s.deps);
  const job = s.job('h.json', { ops: [{ op: 'reference', producer: 'Primitives', elements: ['IServerActionSignature:A'] },
    { op: 'reference', producer: 'System', elements: ['IEntitySignature:User'] }, { op: 'reference', producer: 'Bound', elements: ['IStructureSignature:S'] }] });
  await call({ module: 'Orders', job, producers: { Bound: path.join(s.base, 'bound.avsig') }, authorize: WORDS });
  const args = s.runAnvil.calls[0].args;
  const captures = args.flatMap((a, i) => a === '--capture-producer' ? [args[i + 1]] : []);
  assert.deepEqual(captures, ['Primitives', 'System=(System)']);
  assert.deepEqual(autoCaptures(job, { captureProducers: ['Primitives=Other'] }), ['System=(System)', 'Bound']);
});

test('deliver publish:true preserves a failed publication diagnostic instead of suggesting another publication', async t => {
  const continuation = { tool: 'o11_service_center_read', arguments: { action: 'logs', kind: 'error', source: 'CompilerService' }, why: 'Read the server error before repair.' };
  const diagnosis = { code: 'COMPILER_ESPACE_DUMP', causeKnown: false };
  const s = setup(t, { publish: { ok: false, code: 'PUBLISH_FAILED', outcome: 'failed', diagnosis, continuation } });
  const value = await (await serve(t, s.deps))({ module: 'Orders', job: s.job('dump.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(value.code, 'PUBLISH_FAILED');
  assert.equal(value.result, 'delivered');
  assert.deepEqual(value.continuation, continuation);
  assert.deepEqual(value.publish.diagnosis, diagnosis);
  assert.equal(s.published.length, 1);
});

// ---- C32: the StyleSheet touch (F1 round 2: the kernel's, chosen on the candidate after every op resolved)
test('the answer names the kernel\'s touch of the delivery and the elements none reached; the job given is delivered as written', async t => {
  const data = structuredClone(envelopes.delivered.data);
  data.apply.styleSheets = [
    { key: 'blk', kind: 'block', name: 'SalemCat', flow: 'Common', flavor: 'reactive', baseStyleSheet: '', styleSheet: '.a{color:red}',
      touch: { key: 'w2', name: 'Inner', prop: 'Style', value: '""', from: '' }, reason: null },
    { key: 'thm', kind: 'theme', name: 'Main', flow: null, flavor: 'reactive', baseStyleSheet: '', styleSheet: '.t{x:y}', touch: null, reason: 'a theme has no widget to change' }];
  const s = setup(t, { handlers: { deliver: () => ({ ...envelopes.delivered, data }) } });
  const call = await serve(t, s.deps);
  const only = s.job('i.json', { ops: [{ op: 'set', target: 'IMobileBlock:SalemCat', prop: 'StyleSheet', value: '.a{color:red}' }] });
  const value = await call({ module: 'OfficePetMobile', job: only, authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.touch, { target: 'IMobileBlock:SalemCat/Inner', op: { op: 'set', target: '@w2', prop: 'Style', value: '""' } });
  assert.deepEqual(value.untouched, [{ element: 'IMobileTheme:Main', reason: 'a theme has no widget to change' }]);
  const delivered = s.runAnvil.calls[0].args[s.runAnvil.calls[0].args.indexOf('--job') + 1];
  assert.equal(delivered, only, 'the facade adds no op: the kernel touches on the candidate');
  // A delivery whose kernel reports no stylesheet: no touch field.
  const plain = await (await serve(t, setup(t).deps))({ module: 'OfficePetMobile', job: s.job('k.json', { ops: [{ op: 'set', target: 'IMobileBlock:SalemCat', prop: 'Description', value: 'x' }] }), authorize: WORDS });
  assert.equal(plain.touch, undefined); assert.equal(plain.untouched, undefined);
});

test('a delivery answers leftovers and screenRoles from the apply; the kernel codes pass through', async t => {
  const data = structuredClone(envelopes.delivered.data);
  data.apply.validation = { matched: [{ id: 'UnusedVariable', element: 'Orders/SaveOrder', why: 'kept for the next screen', preexisting: false, count: 1 }],
    verdicts: [{ id: 'UnusedAction', type: 'Warning', path: 'Orders/Helper', verdict: 'allowlisted', reason: 'unused-created-by-job' }, { id: 'X', verdict: 'matched' }] };
  data.apply.results = [{ op: 'html', result: { screen: 'Home', mode: 'create', roles: ['Registered'], anonymous: false } }, { op: 'html', result: { parent: 'w' } }];
  const fields = deliveryFields(data);
  assert.deepEqual(fields.leftovers, [{ id: 'UnusedVariable', element: 'Orders/SaveOrder', why: 'kept for the next screen', source: 'expectedMessages' },
    { id: 'UnusedAction', element: 'Orders/Helper', why: 'unused-created-by-job', source: 'allowlist' }]);
  assert.deepEqual(fields.screenRoles, [{ screen: 'Home', mode: 'create', roles: ['Registered'], anonymous: false }]);
  const s = setup(t, { handlers: { deliver: () => ({ ...envelopes.delivered, data }) } });
  const value = await (await serve(t, s.deps))({ module: 'Orders', job: s.job('k.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(value.result, 'delivered'); assert.equal(value.leftovers.length, 2); assert.equal(value.screenRoles[0].screen, 'Home');
  assert.ok(JSON.stringify(value).length < 1024, 'a delivered answer stays under ~1 KB');

  const rolled = setup(t, { handlers: { deliver: () => ({ ok: false, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: false, writeState: 'not-applied',
    stage: 'reconcile', code: 'MERGE_ROLLED_BACK', closed: true, error: 'The Studio rolled the merge back (rolled back (kernel hash proof)).' } }) } });
  const back = await (await serve(t, rolled.deps))({ module: 'Orders', job: rolled.job('l.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(back.code, 'MERGE_ROLLED_BACK'); assert.equal(back.closed, true); assert.equal(back.continuation.tool, 'o11_deliver');
  const unavailable = setup(t, { handlers: { deliver: () => ({ ok: false, command: 'deliver', data: { taskId: TASK, module: 'Orders', delivered: false, writeState: 'applied',
    stage: 'verify', code: 'VERIFY_UNAVAILABLE', validation: { newErrors: 0 }, failures: [{ stage: 'verify', error: 'merge kept for review: VERIFY_UNAVAILABLE' }], error: 'merge kept for review' } }) } });
  assert.equal((await (await serve(t, unavailable.deps))({ module: 'Orders', job: unavailable.job('m.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS })).code, 'VERIFY_UNAVAILABLE');
  assert.deepEqual(publishField({ ok: true, consumers: [{ module: 'C', outcome: 'published' }] }), { requested: true, outcome: 'published', consumers: [{ module: 'C', outcome: 'published' }] });
});

// ---- C15: ssam_task close
test('ssam_task close: an uncertain task is closed through deliver --close (the kernel proves it), a delivered one is refused', async t => {
  const s = setup(t, { handlers: { deliver: args => args[1] === '--close'
    ? { ok: true, command: 'deliver', data: { taskId: args[2], closed: true, writeState: 'not-applied' } } : envelopes.delivered } });
  const writeTask = (id, state) => {
    const dir = path.join(s.work, 'deliver', id); fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ taskId: id, module: 'Orders', moduleKey: 'k', ...state });
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  };
  const uncertain = 'a'.repeat(32), delivered = 'b'.repeat(32);
  writeTask(uncertain, { writeState: 'unknown', delivered: false, error: 'Merge outcome is unknown' });
  writeTask(delivered, { writeState: 'applied', delivered: true });
  const call = await serve(t, s.deps);
  // No facade record names this kernel id: since C37 (atritos 3, contract 2.fa) the read answers from the kernel's own task
  // folder with the next call its close state allows (the read of an uncertain facade task carries the close continuation).
  const read = await call({ __tool: 'ssam_task', id: uncertain });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual([read.kernelTask.id, read.kernelTask.writeState, read.kernelTask.closeState], [uncertain, 'unknown', 'uncertain']);
  assert.deepEqual([read.continuation.tool, read.continuation.arguments], ['o11_deliver', { resume: uncertain }]);
  const closed = await call({ __tool: 'ssam_task', id: uncertain, close: { reason: 'the merge was rolled back by the Studio' } });
  assert.equal(closed.ok, true, JSON.stringify(closed)); assert.equal(closed.result, 'closed');
  assert.match(closed.proof, /nothing was applied/);
  assert.deepEqual(s.runAnvil.calls[0].args.slice(0, 5), ['deliver', '--close', uncertain, '--reason', 'the merge was rolled back by the Studio']);
  const refused = await call({ __tool: 'ssam_task', id: delivered, close: { reason: 'x' } });
  assert.equal(refused.code, 'PREVIOUS_NOT_REFUSED');
  const missing = await call({ __tool: 'ssam_task', id: 'c'.repeat(32), close: { reason: 'x' } });
  assert.equal(missing.code, 'CLOSE_TASK_NOT_FOUND');
  assert.equal(s.runAnvil.calls.length, 1);
  // The read of an uncertain delivery names the close with proof as its continuation.
  const { trackTask } = await import('../ssam-task.mjs');
  await trackTask({ tool: 'o11_deliver', summary: { module: 'Orders' }, dir: path.join(s.root, '.local', 'tasks'), now: s.now },
    async () => ({ ok: false, outcome: 'uncertain', code: 'DELIVERY_UNCERTAIN', taskId: uncertain, error: 'unknown' }));
  const tasks = await call({ __tool: 'ssam_task' });
  const facadeId = tasks.tasks.find(x => x.result?.taskId === uncertain).id;
  const one = await call({ __tool: 'ssam_task', id: facadeId });
  assert.equal(one.task.state, 'uncertain');
  assert.deepEqual(one.continuation.arguments, { id: uncertain, close: { reason: '<reason>' } });
  assert.equal(one.continuation.tool, 'ssam_task');
});

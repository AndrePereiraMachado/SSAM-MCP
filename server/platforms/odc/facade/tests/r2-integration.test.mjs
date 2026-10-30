// R2-H, the integration of the accepted R2 packages (fase4-28/r2): the decisions the Integradora took where two packages
// meet. Each test names its decision; each failed on the merged line before its own commit. Fakes only: no Studio, no
// kernel, no agent, no tenant.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { classifyTool, isStudioWrite, isMutation } from '../tool-classification.mjs';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

// (b) R2-E x R2-F: the inline preview of o11_data (request.preview:true) runs the kernel's checker and never the data
// writer, so the one classification (cancellation, relays, the Studio queue) reads it as a read.
test('decision b: an o11_data inline preview is a read, never a Studio write; the same records without preview still write', () => {
  const records = [{ Name: 'Ana' }];
  const preview = { host: 'sample.example.test', module: 'Sample', request: { operation: 'insert', entity: 'Customer', records, preview: true } };
  assert.equal(classifyTool('o11_data', preview).isReadOnly, true);
  assert.equal(isMutation('o11_data', preview), false);
  assert.equal(isStudioWrite('o11_data', preview), false);
  const write = { ...preview, request: { operation: 'insert', entity: 'Customer', records } };
  assert.equal(classifyTool('o11_data', write).isReadOnly, false);
  assert.equal(isStudioWrite('o11_data', write), true);
  // A preview inside a batch item is refused by o11_data (INPUT_INVALID) before anything runs; it stays classified as the
  // write its batch is, never widened into a read.
  const batch = { ...preview, request: { batch: [{ operation: 'insert', entity: 'Customer', records, preview: true }] } };
  assert.equal(classifyTool('o11_data', batch).isReadOnly, false);
});

// (f) R2-G x the agent's file.upload design (DESENHO-PREVIEW-UPLOAD.md 3.6): the extension rule of the upload is checked
// before the agent is asked, so a path the server would refuse anyway never sends a byte; an agent refusal that says it sent
// nothing (sent:false) reaches the model as outcome "not-sent".
test('decision f: a local path without an extension is refused before the agent is asked; an agent refusal with sent:false says outcome not-sent', async t => {
  const before = process.env.SSAM_LOCAL_UPLOAD; process.env.SSAM_LOCAL_UPLOAD = '1';
  t.after(() => { if (before === undefined) delete process.env.SSAM_LOCAL_UPLOAD; else process.env.SSAM_LOCAL_UPLOAD = before; });
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected: true, handlers: { 'file.upload': () => {
    throw Object.assign(new Error('The folder is not one the user approved for SSAM uploads.'), { code: 'UPLOAD_ROOT_NOT_APPROVED', executed: false, delivered: true, sent: false });
  } } });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    mirror: { receive: async () => { throw new Error('nothing reaches the mirror in this test'); } },
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile() { throw new Error('no pull in this test'); } };
  const context = { id: 'ctx-r2h-upload', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const ran = [];
  const wrapped = wrapHostedTool('o11_deliver', { inputSchema: {} }, async args => { ran.push(args); return reply({ ok: true }); },
    { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
  const uploads = () => link.calls.filter(c => c.kind === 'file.upload').length;
  const noExtension = (await wrapped({ module: 'M', job: 'local:C:\\Approved\\job' }, { requestId: 1 })).structuredContent;
  assert.equal(noExtension.code, 'INPUT_INVALID', JSON.stringify(noExtension).slice(0, 300));
  assert.equal(uploads(), 0, 'the agent was asked to upload a path the server refuses by its extension');
  const refused = (await wrapped({ module: 'M', job: 'local:C:\\Approved\\job.json' }, { requestId: 2 })).structuredContent;
  assert.equal(uploads(), 1);
  assert.equal(refused.code, 'UPLOAD_ROOT_NOT_APPROVED', JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.outcome, 'not-sent');
  assert.equal(ran.length, 0);
});

// The o11_deliver of the line as the ssam server runs it (phased, the reservation deferred to after the pure checks), over a
// fake bridge and kernel: R2-F's own fixture (r2-review.test.mjs), the UI precheck off unless a test turns it on.
async function deliveryFixture(t, runner, overrides = {}, env = {}) {
  const fs = (await import('node:fs')).default, path = (await import('node:path')).default;
  const { registerO11Cycle } = await import('../o11-cycle.mjs');
  const { withStudioWriteLock } = await import('../studio-write-lock.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-integration-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = path.join(root, 'authority'); fs.mkdirSync(authority);
  const laneEnv = { ANVIL_WORKER: '0', ANVIL_LANE: 'ss4', ANVIL_AUTHORITY_DIR: authority, SSAM_UI_PRECHECK: '0', ...env };
  const lock = { o11Root: root, odcRoot: root, o11Lane: 'ss4', env: laneEnv, queueMs: 600, connection: () => ({ pid: process.pid, port: 45801, authorityDir: authority }) };
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, '{"ops":[{"op":"get","target":"ServerAction:Read"}]}');
  const state = { environment: 'sample.example.test', preflight: { valid: true }, apply: { isValid: true, accepted: true }, commands: [], checked: [] };
  const bridge = { ok: async (method, args = {}) => {
    state.commands.push(method);
    if (method === 'list_open_modules') return { modules: [{ name: 'Sample', key: 'key', environment: state.environment }] };
    if (method === 'snapshot_module') { fs.mkdirSync(path.dirname(args.path), { recursive: true }); fs.writeFileSync(args.path, 'model'); return { path: args.path, key: 'key' }; }
    if (method === 'bridge_manifest') return { capabilities: ['merge_from_oml:module_key'] };
    if (method === 'get_active_module') return { name: 'Sample', key: 'key', environment: state.environment };
    if (method === 'get_errors') return { isValid: true, errors: 0 };
    if (method === 'open_module') return { name: 'Sample', opened: true, alreadyOpen: true };
    return {};
  } };
  // Every check-job is recorded with the ops of the job file it was given, as they were when it ran.
  const run = runner ?? (async args => {
    if (args[0] === 'check-job') { const file = args[args.indexOf('--job') + 1]; state.checked.push({ args, ops: JSON.parse(fs.readFileSync(file, 'utf8')).ops }); return { envelope: { ok: true, data: state.preflight } }; }
    return { envelope: { ok: true, data: state.apply } };
  });
  const handlers = new Map(); const server = { registerTool: (name, config, handler) => handlers.set(name, handler) };
  const deps = { root, env: laneEnv, lane: 'ss4', bridge, runAnvil: run, buildRunner: () => run, assertSelected: async () => {}, registerTask: false, registerGrant: false, lock, ...overrides };
  registerO11Cycle(server, deps);
  const words = 'Deliver the sample module for the integration regression';
  const call = (args = {}) => withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Sample', job, authorize: words, ...args }, lane: 'o11', deps: lock, phased: true, deferReservation: true },
    () => handlers.get('o11_deliver')({ module: 'Sample', job, authorize: words, ...args }));
  const reserve = () => {
    laneEnv.SSAM_RESERVATION_QUEUE_MS = '1500'; lock.queueMs = 3000;
    const directory = path.join(authority, 'reservations'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'held.json'), JSON.stringify({ owner: 'a'.repeat(32), moduleKey: 'Sample' }));
  };
  return { root, authority, env: laneEnv, lock, job, state, bridge, handlers, call, reserve, deps, run };
}
const valueOf = result => result?.structuredContent ?? result;

// (c) R2-E x R2-F: the static preflight judges the job that runs. A direct o11_deliver of deletes is reordered by the
// native consumers (prepareDeleteJob, staged as a new job file); check-job must read that staged job, never the job as
// received.
test('decision c: the static preflight runs on the job the delete order staged, never on the job as received', async t => {
  const fs = (await import('node:fs')).default, path = (await import('node:path')).default;
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-integration-index-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const native = deletionIndex(dir, 3);
  const f = await deliveryFixture(t, null, { dependencyMap: native.map });
  // A complete static refusal: the delivery stops at the preflight, so the job it judged is the whole question.
  f.state.preflight = { valid: false, static: { complete: true }, problems: [{ code: 'STATIC_PROBLEM', severity: 'error', message: 'Invalid job' }] };
  fs.writeFileSync(f.job, JSON.stringify({ ops: [0, 1, 2].map(i => ({ op: 'delete', target: 'ServerAction:Action' + i })) }));
  const answer = valueOf(await f.call());
  assert.equal(answer.code, 'PREFLIGHT_REFUSED', JSON.stringify(answer).slice(0, 400));
  assert.equal(f.state.checked.length, 1);
  assert.deepEqual(f.state.checked[0].ops.map(op => op.target), ['ServerAction:Action2', 'ServerAction:Action1', 'ServerAction:Action0'],
    'check-job judged the job as received, not the job the delivery runs');
  assert.notEqual(f.state.checked[0].args[f.state.checked[0].args.indexOf('--job') + 1], f.job, 'the staged job, never the original file');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.job, 'utf8')).ops.map(op => op.target), ['ServerAction:Action0', 'ServerAction:Action1', 'ServerAction:Action2'], 'the original job file is kept');
  assert.deepEqual(f.state.commands, [], 'nothing reached the Studio');
});

// (d) R2-F x T12: closing a pending access restore ({"temporary":{"close":"<id>"}}) writes the restore journal of the module.
// With R2-F the reservation is awaited after the pure checks; the close must wait for it too, never act on a module another
// owner holds: it is refused with MODULE_RESERVED and the restore stays pending.
test('decision d: a temporary close waits for the module reservation and changes nothing while another owner holds it', async t => {
  const { o11LaneOf } = await import('../o11-lane.mjs');
  const { recordAccessRestore, pendingAccessRestores } = await import('../o11-access.mjs');
  const fs = (await import('node:fs')).default;
  const f = await deliveryFixture(t);
  const local = o11LaneOf('ss4', { root: f.root, env: f.env }).local;
  const id = 'd'.repeat(32);
  const change = { screen: 'OpsHome', key: 'ScreenOpsHome0001', property: 'Roles', from: [], to: ['@RoleRegisteredKey00001'], fromNames: [], toNames: [] };
  recordAccessRestore(local, { module: 'Sample', environment: f.state.environment, taskId: id,
    apply: { accessChanges: [change], accessRestore: { ops: [{ op: 'set', target: '@ScreenOpsHome0001', prop: 'Roles', value: [], ifCurrent: change.to }] } } });
  assert.deepEqual(pendingAccessRestores(local).map(p => p.id), [id]);
  fs.writeFileSync(f.job, JSON.stringify({ temporary: { close: id }, ops: [] }));
  f.reserve();
  const answer = valueOf(await f.call());
  assert.equal(answer.code, 'MODULE_RESERVED', JSON.stringify(answer).slice(0, 400));
  assert.deepEqual(pendingAccessRestores(local).map(p => p.id), [id], 'the restore was closed while another owner held the module');
  assert.deepEqual(f.state.commands, []);
});

// (e) R2-F x CX16: a job of screens the UI precheck judges (local, SSAM_UI_PRECHECK on) had two check-jobs and two joins:
// R2-F's static preflight before the reservation, and the UI precheck's check-job (with the module index) alongside the
// build. The UI precheck's is the one that knows the module, so it runs alone: one check-job, one join, the static problem once.
test('decision e: a job the UI precheck judges runs one check-job and joins its static problems once', async t => {
  const fs = (await import('node:fs')).default;
  const f = await deliveryFixture(t, null, {}, { SSAM_UI_PRECHECK: '1' });
  const problem = { phase: 'static', op: 0, pointer: '/ops/0/data/html', code: 'UI_BLOCK_UNKNOWN', severity: 'error', message: "'Cardd' is not a block of the module's UI catalogs", fix: 'use Card' };
  f.state.preflight = { valid: false, static: { complete: false, rest: [{ phase: 'apply' }] }, problems: [problem] };
  f.state.apply = { isValid: false, accepted: false, expectedValid: true, verifyRan: true, validation: { new: [{ id: 'UndefinedWidget', type: 'Error', detail: 'Cardd is undefined', path: 'Sample / Home' }] } };
  fs.writeFileSync(f.job, JSON.stringify({ ops: [{ op: 'html', data: { html: '<screen name="Home"><Cardd/></screen>' } }] }));
  const answer = valueOf(await f.call());
  assert.equal(answer.ok, false, JSON.stringify(answer).slice(0, 400));
  assert.equal(f.state.checked.length, 1, 'check-job ran ' + f.state.checked.length + ' times for one delivery');
  const said = [...(Array.isArray(answer.problems) ? answer.problems : []), ...(Array.isArray(answer.static?.problems) ? answer.static.problems : [])].filter(p => p.code === 'UI_BLOCK_UNKNOWN');
  assert.equal(said.length, 1, JSON.stringify(answer).slice(0, 600));
});

// R2-H review H3 (after decision e): a job the UI precheck took over from R2-F's static check is never delivered without a
// verdict. When the precheck reaches none (here its check-job answers no data), the static check of R2-F runs before the
// Studio step: no verdict there either is PREFLIGHT_UNAVAILABLE, nothing merged; a verdict that passes lets the delivery go on.
test('review H3: a job the UI precheck judges without a verdict falls back on the static check before the Studio', async t => {
  const fs = (await import('node:fs')).default;
  const screens = JSON.stringify({ ops: [{ op: 'html', data: { html: '<screen name="Home"><Card/></screen>' } }] });
  const answers = [];
  const runner = state => async args => {
    if (args[0] === 'check-job') { state.checked.push({ args }); return answers.shift() ?? { envelope: { ok: false, error: 'check-job exited 1 without an answer' } }; }
    return { envelope: { ok: true, data: state.apply } };
  };
  const state = { checked: [], apply: { isValid: true, accepted: true } };
  const f = await deliveryFixture(t, runner(state), {}, { SSAM_UI_PRECHECK: '1' });
  fs.writeFileSync(f.job, screens);
  const none = valueOf(await f.call());
  assert.equal(none.code, 'PREFLIGHT_UNAVAILABLE', JSON.stringify(none).slice(0, 500));
  assert.equal(state.checked.length, 2, 'the precheck check-job, then the static check of R2-F');
  assert.deepEqual(f.state.commands.filter(c => !['list_open_modules', 'snapshot_module'].includes(c)), [], 'the Studio was only read (the capture by key)');
  // The precheck has no verdict but the static check passes: the delivery goes on as before.
  const passed = { checked: [], apply: { isValid: true, accepted: true } };
  const g = await deliveryFixture(t, runner(passed), {}, { SSAM_UI_PRECHECK: '1' });
  fs.writeFileSync(g.job, screens);
  answers.push({ envelope: { ok: false, error: 'check-job exited 1 without an answer' } }, { envelope: { ok: true, data: { valid: true } } });
  const went = valueOf(await g.call());
  assert.notEqual(went.code, 'PREFLIGHT_UNAVAILABLE', JSON.stringify(went).slice(0, 500));
  assert.equal(passed.checked.length, 2);
});

// (a) R2-G x R2-F: a hosted until=apply validation (R2-F's keyed capture, no promotion) keeps its accepted candidate the way
// R2-G's checks and builds do: written in the customer's private state (builds/<task>), kept under the one rule of the job
// bytes the kernel read, answered as candidateRef (or a retention note), and reused by a delivery on the same base. No new
// listing text: candidateRef is already an o11_deliver argument.
test('decision a: a hosted until=apply validation answers the candidateRef of its accepted candidate, kept from the private state, reusable on the same base', async t => {
  const fs = (await import('node:fs')).default, path = (await import('node:path')).default;
  const { createHash } = await import('node:crypto');
  const { runWithExecutor } = await import('../executor.mjs');
  const { customerStateDir } = await import('../hosted/storage.mjs');
  const store = await import('../hosted/verified-store.mjs');
  const { registerO11Cycle } = await import('../o11-cycle.mjs');
  const { withStudioWriteLock } = await import('../studio-write-lock.mjs');
  const { buildBeforeApply, withCheckedCandidate } = await import('../o11-build-phase.mjs');
  const { createBuildPool } = await import('../build-pool.mjs');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const oml = model => { const h = Buffer.from('{}'), n = Buffer.alloc(4); n.writeUInt32LE(h.length); return Buffer.concat([Buffer.from('OML'), n, h, Buffer.from(model)]); };
  const dirs = hostedDirs(os.tmpdir()), ws = dirs.workspace;
  const context = { hosted: true, workspace: ws, agent: fakeAgentLink({ agentRoot: dirs.agentRoot, connected: true }), lanes: ['o11'],
    executor: { call: async () => { throw Error('No machine call'); }, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }) } };
  const commands = [], applied = [];
  const bridge = { ok: async (method, args) => {
    commands.push(method);
    if (method === 'list_open_modules') return { modules: [{ name: 'Inventory', key: 'K', hasESpace: true }] };
    if (method === 'snapshot_module') return { path: put(args.path, oml('base')), key: 'K' };
    throw Error('not in this test: ' + method);
  } };
  let onApply = null;
  const runner = async args => {
    if (args[0] === 'check-job') return { envelope: { ok: true, data: { valid: true } } };
    if (args[0] !== 'apply') throw Error('not in this test: ' + args[0]);
    const out = args[args.indexOf('--out') + 1], job = args[args.indexOf('--job') + 1];
    applied.push(out); onApply?.(job);
    put(out, oml('candidate')); put(out.replace(/\.oml$/, '.result.json'), JSON.stringify({ isValid: true, accepted: true, sources: [{ path: job, sha256: sha(fs.readFileSync(job)) }] }));
    return { envelope: { ok: true, data: { isValid: true, accepted: true } } };
  };
  let handler;
  registerO11Cycle({ registerTool: (name, c, h) => { if (name === 'o11_deliver') handler = h; } }, { root: ws, lane: 'ss4', env: { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', USERPROFILE: ws, LOCALAPPDATA: ws, SSAM_UI_PRECHECK: '0' },
    runAnvil: runner, buildRunner: () => runner, registerTask: false, journal: () => {}, assertSelected: async () => {}, lastPublication: async () => null, bridge });
  const job = put(path.join(ws, 'o11', 'delivery.json'), JSON.stringify({ ops: [] }));
  const args = { module: 'Inventory', job, until: 'apply', authorize: 'Validate the Inventory module for the integration regression' };
  const validate = () => runWithExecutor(context, () => withStudioWriteLock({ tool: 'o11_deliver', args, lane: 'o11',
    deps: { o11Root: ws, odcRoot: ws, connection: () => null }, phased: true }, () => handler(args)));
  const answer = valueOf(await validate());
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400));
  assert.match(answer.candidateRef ?? '', /^[a-f0-9]{64}$/, JSON.stringify(answer).slice(0, 400));
  assert.equal(answer.retention, undefined);
  const builds = path.join(customerStateDir(ws), 'builds');
  assert.equal(path.dirname(path.dirname(applied[0])), builds, 'the candidate is written in the private builds/<task> folder: ' + applied[0]);
  assert.deepEqual(commands.filter(c => !['list_open_modules', 'snapshot_module'].includes(c)), [], 'nothing was opened, merged or published');
  // The ref serves a delivery of the same job on the same base: the build reuses it, no apply of its own.
  const offer = store.candidateOffer(ws, answer.candidateRef, { lane: 'o11', module: 'Inventory' });
  const lane = { local: path.join(ws, 'o11'), work: path.join(ws, 'o11', 'work'), name: 'ss4' };
  const ctx = { root: ws, env: {}, now: () => new Date(), bridge: () => bridge, buildPool: createBuildPool({ dir: path.join(ws, 'pool'), size: 1 }), buildRunner: () => runner };
  const before = applied.length;
  const built = await runWithExecutor(context, () => withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Inventory', job }, lane: 'o11', deps: { o11Root: ws, odcRoot: ws, connection: () => null }, phased: true },
    () => withCheckedCandidate(offer, () => buildBeforeApply({ input: { module: 'Inventory' }, job, ctx, lane, task: { id: 'reuse' } }))));
  assert.equal(offer.outcome?.reused, true, JSON.stringify(offer.outcome));
  assert.equal(applied.length, before, 'the delivery reused the validated candidate');
  assert.ok(built?.manifest);
  // A job changed while it was validated keeps no candidate: the answer says why, the validation itself stands.
  onApply = file => fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'prototype', data: { source: 'C:/outside' } }] }));
  const changed = valueOf(await validate());
  fs.writeFileSync(job, JSON.stringify({ ops: [] }));
  assert.equal(changed.ok, true);
  assert.equal(changed.candidateRef, undefined);
  assert.match(changed.retention ?? '', /^The validation passed; its candidate was not retained because the job changed while it was built\.$/);
});
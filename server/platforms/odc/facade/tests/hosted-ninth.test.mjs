// The ninth release in hosted mode (docs/FASE2-AGENTE.md 5 and 6.1, O11-BRIDGE-FINA.md 14), on fakes only: standing
// grants, paged answers, the o11_data batch, ssam_task close, ssam_connect, studio_status while busy and the friction
// queue stay inside each customer's workspace. One customer's grant never authorizes another customer or the owner,
// paged answers are read back only by the customer that produced them, and nothing reaches this machine's Studios
// (child_process and net are spies installed before any facade module loads).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [];
const connections = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  spawned.push({ file, args: [...(args ?? [])] });
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace, setDefaultExecutor, DenyExecutor } = await import('../executor.mjs');
const { workspaceRoot, anvilRoot, o11Lane } = await import('../workspace.mjs');
const grants = await import('../standing-grants.mjs');
const { publishAuthorization } = await import('../kernel-delivery.mjs');
const { createSsamServer, customerFrictionDirectory } = await import('../ssam.mjs');
const { registerO11Publish } = await import('../o11-publish.mjs');
const { registerO11Cycle } = await import('../o11-cycle.mjs');
const { connectAll } = await import('../studio-connect.mjs');
const lib = await import('../lib.mjs');
const { wrapHostedTool, hostedTools } = await import('../hosted/policy.mjs');
const { insideVisible } = await import('../hosted/mirror.mjs');
const frictionStore = await import('../../../../facade/friction-store.mjs');

const LANE = o11Lane.lane;
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const OWNER_GRANTS = path.join(workspaceRoot, '.local', 'grants', 'standing-grants.json');
const ownerGrantsBefore = fs.existsSync(OWNER_GRANTS) ? fs.readFileSync(OWNER_GRANTS, 'utf8') : null;

// The customer's machine, as an executor answers for it (hosted-roots.test.mjs has the long version).
class FakeExecutor {
  constructor({ record = null, odcPids = [4120], relay = null } = {}) {
    this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.record = record; this.odcPids = odcPids; this.relay = relay;
  }
  relayPort() { return this.relay; }
  async call(kind, params = {}) {
    this.calls.push({ kind, params: structuredClone(params) });
    if (kind === 'studio.processes') return { processes: params.image === 'ODCStudio.exe' ? this.odcPids.map(pid => ({ pid, path: 'C:\\Customer\\ODCStudio.exe', version: '1.7.28.1' })) : [] };
    if (kind === 'odc.pipe') return { line: JSON.stringify(params.args[0] === 'auth-status' ? { ok: true, sessions: [{ host: 'customer.example', loggedIn: true, user: 'dev@customer.example' }] } : { ok: true, command: params.args[0] }) };
    if (kind === 'odc.attach') return { ok: true, attached: true, pid: params.pid, version: 'v38' };
    if (kind === 'o11.bridge') return { reply: { success: true, data: {} } };
    if (kind === 'o11.selected') return { connected: true, pid: 5150 };
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.1.0', kernel: { odc: '1.7.28', odcBridge: 'v38', o11: '11.55.91' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted({ lanes = ['odc', 'o11'], record = false, ...options } = {}) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-ninth-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  const relay = 41000 + Math.floor(Math.random() * 8000);
  const executor = new FakeExecutor({ ...options, relay, record: record ? { ok: true, lane: 'o11', anvilLane: LANE, pid: 5150, startedUtc: '2026-10-05T10:00:00.0000000Z',
    studioVersion: '11.55.91', port: relay, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-05T10:00:05.000Z', hosted: true } : null });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tokenId, lanes, workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const within = (context, fn) => runWithExecutor(context, fn);
const collector = () => { const tools = new Map(); return { tools, registerTool: (name, config, handler) => { tools.set(name, handler); } }; };
const call = async (tools, name, input) => (await tools.get(name)(input)).structuredContent;
async function hostedServer(context, deps = {}, { o11 = false } = {}) {
  const server = await within(context, () => createSsamServer({ o11, odc: false, deps, hosted: { context, session: { agent, lanes: context.lanes } } }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-ninth-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); await server.close(); },
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}

test('a standing grant is the customer\'s own: another customer and the owner never see it, and a served process without context fails closed', async () => {
  const a = hosted(), b = hosted();
  const words = 'pode publicar o Orders ' + randomUUID();
  const fileA = await within(a, async () => {
    const granted = grants.addGrant({ lane: 'odc', app: 'Orders', verbs: ['publish', 'deliver'], words });
    assert.equal(granted.ok, true);
    assert.equal((await publishAuthorization({ module: 'Orders' }, grants))?.authorization?.source, 'standing-grant', 'the customer\'s own grant authorizes');
    return grants.grantsFile();
  });
  assert.equal(fileA, path.join(a.workspace, 'state', 'grants', 'standing-grants.json'));
  assert.equal(insideVisible(a.workspace, fileA), false, 'state/ is internal: no tool reads the verbatim words back');
  await within(b, async () => {
    assert.equal(grants.grantsFile(), path.join(b.workspace, 'state', 'grants', 'standing-grants.json'));
    assert.equal(grants.findGrant({ lane: 'odc', app: 'Orders', module: 'Orders', verb: 'publish' }), null);
    assert.deepEqual(grants.listGrants({}).grants, []);
    assert.equal(await publishAuthorization({ module: 'Orders' }, grants), null, 'customer A\'s grant never authorizes customer B');
    assert.deepEqual(grants.wordsFor({ lane: 'odc', app: 'Orders', module: 'Orders', verb: 'deliver' }), { words: '' });
  });
  // The owner (no context, local executor) reads only the owner's file, never a customer's.
  assert.equal(grants.grantsFile(), OWNER_GRANTS);
  assert.equal(grants.findGrant({ lane: 'odc', app: 'Orders', module: 'Orders', verb: 'publish' })?.words === words, false);
  const previous = setDefaultExecutor(new DenyExecutor());
  try { assert.throws(() => grants.grantsFile(), e => e.code === 'HOSTED_CONTEXT_LOST'); }
  finally { setDefaultExecutor(previous); }
});

test('ssam_grant in hosted mode writes and lists only the customer\'s grants; o11_publish of another customer never uses them', async () => {
  const a = hosted(), b = hosted();
  const words = 'pode publicar o Billing ' + randomUUID();
  const serverOf = context => within(context, () => { const s = collector(); registerO11Publish(s, { lane: LANE, bridge: () => { throw new Error('no bridge in this test'); }, assertSelected: async () => {} }); return s; });
  const toolsA = (await serverOf(a)).tools, toolsB = (await serverOf(b)).tools;
  const granted = await within(a, () => call(toolsA, 'ssam_grant', { action: 'grant', lane: 'o11', app: 'Billing', verbs: ['publish'], words }));
  assert.equal(granted.ok, true); assert.equal(granted.grant.words, undefined, 'the words never come back');
  assert.ok(fs.existsSync(path.join(a.workspace, 'state', 'grants', 'standing-grants.json')));
  assert.equal((await within(a, () => call(toolsA, 'ssam_grant', { action: 'list' }))).grants.length, 1);
  assert.deepEqual((await within(b, () => call(toolsB, 'ssam_grant', { action: 'list' }))).grants, []);
  assert.equal(fs.existsSync(path.join(b.workspace, 'state', 'grants', 'standing-grants.json')), false);
  const refused = await within(b, () => call(toolsB, 'o11_publish', { module: 'Billing' }));
  assert.equal(refused.ok, false); assert.match(refused.code, /WORDS_REQUIRED|AUTHORIZATION/, 'without words and without a grant of its own nothing is published');
  assert.ok(!b.executor.calls.some(c => c.kind === 'o11.bridge' && c.params.method === 'publish'));
});

test('a paged answer is written in the customer\'s ws:o11/answers and read back only by that customer', async () => {
  const a = hosted({ lanes: ['o11'] }), b = hosted({ lanes: ['o11'] });
  const rows = Array.from({ length: 1500 }, (_, i) => ({ i, text: 'x'.repeat(60) }));
  const big = { ok: true, lane: 'o11', note: 'n', rows };
  const sa = await hostedServer(a, { jobTool: async () => big });
  const sb = await hostedServer(b, { jobTool: async () => ({ ok: true }) });
  try {
    const value = await sa.call('o11_job', { job: [{ op: 'find', kind: 'Entity' }] });
    // servidor/fase4-25: marco-a5 fits each answer to the budget of its kind before the ceiling (answer-size.mjs fitResult):
    // the whole answer is kept in the same file either way, paged (above the ceiling) or omitted (above its kind's budget),
    // with the ssam_evidence call that reads it.
    assert.ok(value.paged || value.omitted, 'the answer is above its budget: kept in a file');
    const file = value.paged ? value.paged.file : value.omitted.arguments.file;
    assert.match(file, /^ws:o11\/answers\/[0-9a-f]{64}\.json$/, 'presented as a workspace path');
    if (value.omitted) assert.equal(value.omitted.tool, 'ssam_evidence');
    const sha = file.match(/([0-9a-f]{64})\.json$/)[1];
    assert.ok(fs.existsSync(path.join(a.workspace, 'o11', 'answers', sha + '.json')));
    assert.equal(fs.existsSync(path.join(anvilRoot, '.local', 'answers', sha + '.json')), false, 'never in the owner\'s .local/answers');
    const read = await sa.call('ssam_evidence', { file, pointer: '/rows/1499/i' });
    assert.equal(read.ok, true); assert.equal(read.value, 1499);
    // Customer B: the same ws: name is B's own (absent), A's absolute path is outside B's workspace.
    assert.equal((await sb.call('ssam_evidence', { file })).ok, false);
    const outside = await sb.call('ssam_evidence', { file: path.join(a.workspace, 'o11', 'answers', sha + '.json') });
    assert.equal(outside.ok, false); assert.equal(outside.code, 'PATH_OUTSIDE_WORKSPACE');
  } finally { await sa.close(); await sb.close(); }
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('an o11_data batch with $ref steps is one request file in the customer\'s ws:o11/data/requests; $ref is a record, never a path', async () => {
  const context = hosted({ lanes: ['o11'], record: true });
  const runs = [];
  const runAnvil = async args => { runs.push(args); return { ok: true, via: 'process', envelope: { ok: true, command: 'data', data: { results: [] } } }; };
  const server = await hostedServer(context, { runAnvil }, { o11: true });
  try {
    fs.mkdirSync(path.join(context.workspace, 'o11', 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(context.workspace, 'o11', 'snapshots', 'Shop.oml'), 'oml');
    const request = { authorization: 'pode gravar no Shop', batch: [
      { step: 'order', operation: 'insert', entity: 'Order', operationId: randomUUID(), records: [{ Name: 'A' }] },
      { step: 'line', operation: 'insert', entity: 'OrderLine', operationId: randomUUID(), records: [{ OrderId: { $ref: 'order' }, Qty: 1 }] }] };
    const value = await server.call('o11_data', { host: 'customer.example', module: 'Shop', oml: 'ws:o11/snapshots/Shop.oml', request });
    assert.equal(value.ok, true);
    const args = runs[0];
    const at = flag => args[args.indexOf(flag) + 1];
    assert.ok(inside(at('--request'), path.join(context.workspace, 'o11', 'data', 'requests')), at('--request'));
    assert.ok(inside(at('--work'), context.workspace) || at('--work') === path.join(context.workspace, 'o11', 'data'), at('--work'));
    assert.equal(at('--oml'), path.join(context.workspace, 'o11', 'snapshots', 'Shop.oml'));
    assert.deepEqual(JSON.parse(fs.readFileSync(at('--request'), 'utf8')).batch[1].records[0].OrderId, { $ref: 'order' });
  } finally { await server.close(); }
});

test('ssam_task close stays in the customer\'s work folder: another customer\'s task id is never found or closed', async () => {
  const a = hosted({ lanes: ['o11'], record: true }), b = hosted({ lanes: ['o11'], record: true });
  const idB = randomUUID().replace(/-/g, '');
  const taskDir = path.join(b.workspace, 'o11', 'work', 'deliver', idB);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ taskId: idB, writeState: 'not-sent', error: 'refused', module: 'Shop' }));
  const runs = [];
  const register = context => within(context, () => { const s = collector(); registerO11Cycle(s, { lane: LANE, runAnvil: async args => { runs.push(args); return { ok: true, exitCode: 0, envelope: { ok: true, data: { closed: true } } }; },
    assertSelected: async () => {}, bridge: { ok: async () => ({}) } }); return s; });
  const toolsA = (await register(a)).tools, toolsB = (await register(b)).tools;
  const fromA = await within(a, () => call(toolsA, 'ssam_task', { id: idB, close: { reason: 'refused job' } }));
  assert.equal(fromA.ok, false); assert.equal(fromA.code, 'CLOSE_TASK_NOT_FOUND');
  assert.deepEqual(runs, [], 'nothing ran for customer A');
  await within(b, () => call(toolsB, 'ssam_task', { id: idB, close: { reason: 'refused job' } }));
  assert.equal(runs.length, 1);
  assert.equal(runs[0][runs[0].indexOf('--work') + 1], path.join(b.workspace, 'o11', 'work'));
  // The gate: close needs the customer's agent; a plain read does not.
  const rule = hostedTools().ssam_task.agent;
  assert.deepEqual(rule, { when: 'present', arg: 'close' });
});

test('ssam_connect hosted: every Studio is the customer\'s, listed, probed and attached through the executor; the gate is laned only when lane is named', async () => {
  const context = hosted({ lanes: ['odc'], odcPids: [4120, 4121] });
  const value = await within(context, () => connectAll({}, { served: ['odc'] }));
  assert.equal(value.studios.length, 2);
  assert.ok(value.studios.every(s => s.lane === 'odc' && s.attached === true), JSON.stringify(value.studios));
  const pipes = context.executor.calls.filter(c => c.kind === 'odc.pipe');
  assert.ok(pipes.length >= 2 && pipes.every(c => c.params.args[0] === 'auth-status' && c.params.connectMs > 0), 'the probe went down the customer\'s pipe');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, [], 'no pipe or socket of this machine');
  // The gate of ssam_connect (lane arg:none): no lane passes for a customer with one lane; a lane outside the token is refused.
  const handler = async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } });
  const wrapped = wrapHostedTool('ssam_connect', { inputSchema: {} }, handler, { context: { ...context, lanes: ['o11'] }, link: agent, lanes: ['o11'] });
  assert.equal((await wrapped({}, {})).structuredContent.ok, true);
  assert.equal((await wrapped({ lane: 'odc' }, {})).structuredContent.code, 'HOSTED_LANE_DISABLED');
});

test('studio_status while the bridge is busy reads only the customer\'s own command and lab folder', async () => {
  const a = hosted(), b = hosted();
  const flightsA = within(a, () => lib.flightRegistry()), flightsB = within(b, () => lib.flightRegistry());
  assert.notEqual(flightsA, flightsB); assert.notEqual(flightsA, lib.inFlight);
  const manifest = path.join(a.workspace, 'odc', 'lab', 'f1', 'delivery', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, '{}');
  flightsA.set(4120, { command: 'merge', since: '2026-10-05T10:00:00Z', args: ['merge', manifest] });
  const seenA = within(a, () => lib.busyEvidence({ pid: 4120 }));
  assert.equal(seenA.busy.command, 'merge');
  assert.ok(inside(seenA.delivery.evidence, path.join(a.workspace, 'odc', 'lab')));
  const seenB = within(b, () => lib.busyEvidence({ pid: 4120 }));
  assert.equal(seenB.busy.command, null, 'the same pid on another customer\'s machine is not this command');
  assert.equal(seenB.delivery, undefined);
});

test('the friction queue of each customer is its own folder, whatever SSAM_FRICTION_DIR says', () => {
  const a = hosted(), b = hosted();
  const shared = temp('ssam-friction-shared-');
  const storeOf = context => frictionStore.createStore({ root: context.workspace, directory: customerFrictionDirectory(context.workspace), env: { SSAM_FRICTION_DIR: shared } });
  assert.equal(storeOf(a).directory, path.join(a.workspace, '.local', 'friction'));
  assert.equal(storeOf(b).directory, path.join(b.workspace, '.local', 'friction'));
  assert.equal(frictionStore.createStore({ root: a.workspace, env: { SSAM_FRICTION_DIR: shared } }).directory, shared, 'without the explicit folder the variable would win');
});

test('nothing of these hosted calls reached the owner\'s grants file', () => {
  assert.equal(fs.existsSync(OWNER_GRANTS) ? fs.readFileSync(OWNER_GRANTS, 'utf8') : null, ownerGrantsBefore);
});

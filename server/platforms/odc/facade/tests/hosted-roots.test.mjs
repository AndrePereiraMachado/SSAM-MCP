// The hosted side of the seam (docs/FASE2-AGENTE.md 4.1, 4.7, 6.1): with a FAKE executor in a hosted context and a
// temporary workspace, the facade's machine calls reach the executor (never this machine), every data path lands in the
// workspace, O11 fails closed without the customer's connection record, child processes get the closed environment,
// and the vault and prompt of the server are refused. child_process and net are spies installed before any facade
// module loads: a spawn answers from a programmed fake CLI, a socket throws, and both are counted.
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
let respond = () => ({ stdout: JSON.stringify({ ok: true, data: {} }) });
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  const call = { file, args: [...(args ?? [])], options: { ...(options ?? {}) } };
  spawned.push(call);
  let out;
  try { out = respond(file, call.args, call.options) ?? {}; } catch (error) { out = { error }; }
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(out.error ?? null, out.stdout ?? '', out.stderr ?? ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
cp.execFileSync = (file, args) => { spawned.push({ file, args, sync: true }); throw new Error('execFileSync is not allowed in hosted tests'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const z = await import('zod/v4');
const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace, currentExecutor } = await import('../executor.mjs');
const { anvilRoot, odcRoot, o11Lane } = await import('../workspace.mjs');
const lib = await import('../lib.mjs');
const { o11Bridge, bridgeTarget } = await import('../o11-bridge.mjs');
const { probeO11, assertSelectedO11 } = await import('../studio-connect.mjs');
const { registerO11Cycle } = await import('../o11-cycle.mjs');
const { registerSsamTask, tasksDir } = await import('../ssam-task.mjs');
const { jobTool, runJob } = await import('../job-runner.mjs');
const { createStudioCreateApp } = await import('../studio-create-app.mjs');
const { registerSsamReference } = await import('../ssam-reference.mjs');
const { createFacadeServer } = await import('../mcp.mjs');
const lanes = await import('../lanes.mjs');
const { readConnection } = await import('../studio-session.mjs');
const { workerDisabled } = await import('../anvil-worker.mjs');
const { studioWriteTarget, withStudioWriteLock } = await import('../studio-write-lock.mjs');
const { o11LaneOf } = await import('../o11-lane.mjs');
const { readLocalSettings } = await import('../local-settings.mjs');
const { previewFile } = await import('../destructive-operations.mjs');
const { evidenceRoots } = await import('../ssam-evidence.mjs');
const { kernelReading } = await import('../kernel-reading.mjs');
const { locateStudioBridge } = await import('../service-center/bridge.mjs');
const { Resolver, hiddenSignIn, stateDir } = await import('../service-center/auth.mjs');
const { runServiceCenter, journalDefault } = await import('../service-center/index.mjs');
const { BridgeError } = await import('../service-center/errors.mjs');

const LANE = o11Lane.lane;
const TENANT = 'customer-x.outsystems.dev';
const SERVER_STUDIO = path.join(os.tmpdir(), 'ssam-server-kernel', 'Service Studio');
const OWNER = { ANVIL_BRIDGE_PORT: '4516', ANVIL_CSHARP_RUNTIME_REGISTRATION: path.join(os.tmpdir(), 'owner-csharp-runtime.json'), SSAM_HYBRID_ODC_TENANT: 'owner.outsystems.dev' };
const ownerAuthority = process.env.ANVIL_AUTHORITY_DIR; // the isolated profile's stand-in for the owner's controller key folder
Object.assign(process.env, OWNER);
const markers = { files: [], text: [] }; // what this file wrote, checked against the repository at the end
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const fakeCli = path.join(temp('ssam-fake-cli-'), 'anvil-odc.dll'); fs.writeFileSync(fakeCli, '');
const reset = () => { spawned.length = 0; connections.length = 0; };
const envelope = data => ({ stdout: JSON.stringify({ ok: true, command: 'fake', data }) });
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];
const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

// The customer's machine, as an executor answers for it.
class FakeExecutor {
  constructor({ record = null, pids = [4120], selected = { connected: true, pid: 5150 }, relay = null } = {}) {
    this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.record = record; this.pids = pids; this.selected = selected; this.relay = relay;
  }
  // The customer's relay, open with or without a record (AgentExecutor.relayPort).
  relayPort() { return this.relay; }
  async call(kind, params = {}) {
    this.calls.push({ kind, params: structuredClone(params) });
    if (kind === 'studio.processes') return { processes: this.pids.map(pid => ({ pid, path: 'C:\\Customer\\Studio.exe', version: '1.7.28.1' })) };
    if (kind === 'odc.pipe') return { line: JSON.stringify(this.odc(params.args)) };
    if (kind === 'odc.attach') return { ok: true, attached: true, pid: params.pid, version: 'v35', note: 'fake' };
    if (kind === 'o11.bridge') return { reply: this.o11(params.method) };
    if (kind === 'o11.selected') return this.selected;
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  odc(args) {
    if (args[0] === 'status') return { ok: true, bridge: 'v35', busy: null, modules: [] };
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v35', sessions: [{ host: TENANT, loggedIn: true, user: 'dev@customer' }], portalWindows: [] };
    if (args[0] === 'templates') return { ok: true, tenant: TENANT, templates: [] };
    if (args[0] === 'create-app') return { ok: true, assetKey: 'A1', assetName: 'ZZ Hosted Lib', assetType: 'library', revision: 1 };
    if (args[0] === 'open') return { ok: true, developerId: 'dev' };
    return { ok: true, command: args[0] };
  }
  o11(method) {
    if (method === 'ping') return { success: true, data: { bridge: 'anvil', pid: 5150, version: '2.0' } };
    if (method === 'bridge_manifest') return { success: true, data: { protocolVersion: 2, authentication: true, verbs: [], capabilities: [] } };
    return { success: true, data: {} };
  }
  o11Connection() { return this.record; }
  async close() {}
  kinds() { return this.calls.map(c => c.kind); }
}
const agent = { tokenId: 'tok_test', customer: 'Cliente X', connected: () => true,
  info: () => ({ connected: true, credential: true, agentVersion: '0.1.0', kernel: { odc: '1.7.28', odcBridge: 'v35', o11: '11.55.91' },
    compatible: { odc: { ok: true }, o11: { ok: true } }, studios: { odc: { installed: { version: '1.7.28.4021' } } } }) };
function hosted({ record = false, noRelay = false, ...options } = {}) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-hosted-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  const relay = 41000 + Math.floor(Math.random() * 8000);
  const executor = new FakeExecutor({ ...options, relay: noRelay ? null : relay, record: record ? { ok: true, lane: 'o11', anvilLane: LANE, pid: 5150, startedUtc: '2026-10-04T10:00:00.0000000Z',
    studioVersion: '11.55.91', port: relay, studioDir: SERVER_STUDIO, authorityDir: path.join(workspace, 'state', 'relay-authority'),
    connectedAt: '2026-10-04T10:00:05.000Z', hosted: true } : null });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Cliente X', lanes: ['odc', 'o11'], workspace, agent, executor,
    o11: { studioDir: SERVER_STUDIO, lane: LANE }, close: async () => {}, relay };
}
const within = (context, fn) => runWithExecutor(context, fn);
// A server that only collects handlers: the registered tools are called as the MCP server would call them.
const collector = () => { const tools = new Map(); return { tools, registerTool: (name, config, handler) => { tools.set(name, handler); } }; };
const result = async (tools, name, input) => (await tools.get(name)(input)).structuredContent;

// Every O11 child: the relay and the workspace; nothing of this process beyond the closed list.
function assertO11Spawn(call, context) {
  const env = call.options.env;
  assert.equal(env.ANVIL_BRIDGE_PORT, String(context.relay));
  assert.equal(env.ANVIL_AUTHORITY_DIR, path.join(context.workspace, 'state', 'relay-authority'));
  assert.notEqual(env.ANVIL_AUTHORITY_DIR, ownerAuthority);
  assert.equal(env.ANVIL_STUDIO_DIR, SERVER_STUDIO);
  assert.equal(env.ANVIL_LANE, LANE);
  assert.equal(call.options.cwd, path.join(context.workspace, 'o11'));
  assert.equal(env.TEMP, path.join(context.workspace, 'o11', 'tmp')); assert.equal(env.TMP, env.TEMP);
  assert.equal(env.ANVIL_CSHARP_RUNTIME_REGISTRATION, undefined);
  // The kernel talks to the customer's thin bridge (docs/O11-BRIDGE-FINA.md §4.4-4.5).
  assert.equal(env.ANVIL_BRIDGE_FLAVOR, 'thin'); assert.equal(env.ANVIL_BRIDGE_TIMEOUT_SECONDS, '600');
  // servidor/fase4-26: the CX14 probes off (A1) and kept html readings only for the job's own base capture (M2).
  assert.equal(env.ANVIL_BRIDGE_PROBE_MS, '0'); assert.equal(env.ANVIL_KEPT_READINGS, 'own');
  const foreign = Object.keys(env).filter(k => /^(ANVIL|SSAM|ODC)_/.test(k) && !['ANVIL_BRIDGE_PORT', 'ANVIL_AUTHORITY_DIR', 'ANVIL_STUDIO_DIR', 'ANVIL_LANE', 'ANVIL_ODC_STUDIO_DIR', 'ANVIL_ODC_FEATURES_DIR', 'ANVIL_BRIDGE_FLAVOR', 'ANVIL_BRIDGE_TIMEOUT_SECONDS', 'ANVIL_BRIDGE_PROBE_MS', 'ANVIL_KEPT_READINGS'].includes(k));
  assert.deepEqual(foreign, []);
}
function assertOdcSpawn(call, context) {
  const env = call.options.env;
  assert.equal(env.SSAM_HYBRID_ODC_ROOT, path.join(context.workspace, 'odc'));
  assert.equal(env.ANVIL_AUTHORITY_DIR, path.join(context.workspace, 'state', 'relay-authority'));
  assert.equal(call.options.cwd, path.join(context.workspace, 'odc'));
  assert.equal(env.TEMP, path.join(context.workspace, 'odc', 'tmp'));
  assert.equal(env.ANVIL_BRIDGE_PORT, undefined); assert.equal(env.ANVIL_CSHARP_RUNTIME_REGISTRATION, undefined); assert.equal(env.SSAM_HYBRID_ODC_TENANT, undefined);
  assert.equal(env.ANVIL_BRIDGE_FLAVOR, undefined); assert.equal(env.ANVIL_BRIDGE_TIMEOUT_SECONDS, undefined);
  assert.equal(env.ANVIL_BRIDGE_PROBE_MS, undefined); assert.equal(env.ANVIL_KEPT_READINGS, 'own');
}

test('studio(["status"]) lists the Studio processes through the executor, then sends the command down its pipe', async () => {
  reset();
  const context = hosted();
  const value = await within(context, () => lib.studio(['status']));
  assert.equal(value.ok, true);
  assert.deepEqual(context.executor.kinds(), ['studio.processes', 'odc.pipe']);
  assert.deepEqual(context.executor.calls[0].params, { image: 'ODCStudio.exe' });
  assert.equal(context.executor.calls[1].params.pid, 4120);
  assert.deepEqual(context.executor.calls[1].params.args, ['status']);
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('the O11 bridge client and the probe call o11.bridge with no port and no key', async () => {
  reset();
  const context = hosted({ record: true });
  await within(context, async () => {
    const target = bridgeTarget();
    assert.equal(target.port, context.relay); assert.equal(target.authorization, null); assert.equal(target.keyFile, null);
    assert.deepEqual(await o11Bridge(bridgeTarget()).ok('get_active_module'), {});
    assert.deepEqual(await probeO11(context.relay), { connected: true, pid: 5150, version: '2.0', port: context.relay });
  });
  const bridgeCalls = context.executor.calls.filter(c => c.kind === 'o11.bridge');
  assert.deepEqual(bridgeCalls.map(c => c.params.method), ['get_active_module', 'ping', 'bridge_manifest']);
  for (const call of bridgeCalls) { assert.ok(!('port' in call.params), 'no port'); assert.ok(!('authorization' in call.params), 'no key'); }
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('without the customer\'s O11 record nothing that needs the Studio runs: no spawn, no socket, O11_NOT_CONNECTED', async () => {
  reset();
  const context = hosted();
  const server = collector();
  await within(context, async () => {
    assert.equal(readConnection(anvilRoot, LANE), null);
    assert.throws(() => bridgeTarget(), e => e.code === 'O11_NOT_CONNECTED' && e.continuation?.tool === 'ssam_connect');
    assert.throws(() => o11LaneOf(LANE).bridge, e => e.code === 'O11_NOT_CONNECTED');
    assert.equal(o11LaneOf(LANE).asDict().bridge, null);
    await assert.rejects(assertSelectedO11(), e => e.code === 'O11_NOT_CONNECTED');
    await assert.rejects(locateStudioBridge(), e => e instanceof BridgeError && e.code === 'STUDIO_NOT_CONNECTED');
    const data = await lanes.run('o11', 'data', ['--studio', '--host', 'x.outsystemscloud.com']);
    assert.equal(data.ok, false); assert.equal(data.code, 'O11_NOT_CONNECTED');
    registerO11Cycle(server);
    const delivered = await result(server.tools, 'o11_deliver', { module: 'Orders', job: [{ op: 'get', target: 'ServerAction:SaveOrder' }], authorize: 'pode entregar no Orders' });
    assert.equal(delivered.ok, false); assert.equal(delivered.code, 'O11_NOT_CONNECTED');
    assert.ok(inside(delivered.job, path.join(context.workspace, 'o11', 'jobs', 'inline')), 'the inline job is the customer\'s');
    markers.files.push(path.join(anvilRoot, '.local', 'jobs', 'inline', path.basename(delivered.job)));
    const captured = await jobTool({ job: { ops: [{ op: 'get', target: 'ServerAction:SaveOrder' }] }, captureProducers: ['System=(System)'] });
    assert.equal(captured.ok, false); assert.equal(captured.code, 'O11_NOT_CONNECTED');
  });
  // With a record whose Studio the agent no longer sees connected.
  const stale = hosted({ record: true, selected: { connected: false } });
  await within(stale, () => assert.rejects(assertSelectedO11(), e => e.code === 'O11_NOT_CONNECTED'));
  assert.deepEqual(spawned, [], 'no process started'); assert.deepEqual(connections, [], 'no socket opened');
});

test('without the record the O11 runs that never call the bridge still work, on the customer\'s relay port', async () => {
  reset();
  const context = hosted();
  const server = collector();
  const fakeO11Cli = path.join(temp('ssam-fake-o11-cli-'), 'anvil.dll'); fs.writeFileSync(fakeO11Cli, '');
  const oml = path.join(context.workspace, 'o11', 'snapshots', 'Orders.oml'); fs.mkdirSync(path.dirname(oml), { recursive: true }); fs.writeFileSync(oml, 'oml');
  respond = (file, args) => (args.includes('apply') ? envelope({ accepted: true, isValid: true, ops: 1 }) : envelope({ name: 'IForEachNode' }));
  try {
    await within(context, async () => {
      assert.equal(readConnection(anvilRoot, LANE), null);
      // o11_job / ssam_job without captureProducers: a plain apply.
      const job = await jobTool({ job: { ops: [{ op: 'get', target: 'ServerAction:SaveOrder' }] } });
      assert.equal(job.ok, true, JSON.stringify(job));
      assert.equal(spawned.length, 1);
      assertO11Spawn(spawned[0], context);
      assert.ok(inside(job.out, path.join(context.workspace, 'o11', 'jobs')));
      markers.files.push(path.join(anvilRoot, '.local', 'jobs', 'inline', path.basename(job.job)));
      // ssam_reference {lane:"o11"}: the kernel catalogs of the server.
      reset();
      registerSsamReference(server, { cli: { o11: fakeO11Cli } });
      const api = await result(server.tools, 'ssam_reference', { lane: 'o11', kind: 'api', query: 'IForEachNode' });
      assert.equal(api.ok, true, JSON.stringify(api));
      assertO11Spawn(spawned[0], context);
      // o11_dependencies inspect (an offline OML read) and help.
      for (const args of [['inspect', '--oml', oml], ['help']]) {
        reset();
        const value = await lanes.run('o11', 'dependencies', args);
        assert.equal(value.ok, true, JSON.stringify(value));
        assertO11Spawn(spawned[0], context);
      }
      // What needs the Studio still refuses before any spawn.
      reset();
      assert.equal((await lanes.run('o11', 'dependencies', ['list', '--producer', 'Core'])).code, 'O11_NOT_CONNECTED');
      assert.equal((await lanes.run('o11', 'data', ['--studio', '--host', 'x.outsystemscloud.com'])).code, 'O11_NOT_CONNECTED');
      assert.deepEqual(spawned, []);
    });
    // An executor without a relay (no real hosted context has one): refused, and the tool answer keeps the seam code.
    const bare = hosted({ noRelay: true });
    const other = collector();
    await within(bare, async () => {
      registerSsamReference(other, { cli: { o11: fakeO11Cli } });
      const refused = await result(other.tools, 'ssam_reference', { lane: 'o11', kind: 'api', query: 'IForEachNode' });
      assert.equal(refused.ok, false); assert.equal(refused.code, 'O11_NOT_CONNECTED'); assert.equal(refused.continuation?.tool, 'ssam_connect');
    });
    assert.deepEqual(spawned, []);
  } finally { respond = () => envelope({}); }
  assert.deepEqual(connections, []);
});

test('with the record every O11 child gets the relay port, the relay key folder and the workspace, never this process\'s variables', async () => {
  reset();
  const context = hosted({ record: true });
  const server = collector();
  respond = (file, args) => {
    if (args.includes('deliver')) return envelope({ delivered: true });
    if (args.includes('signature')) return envelope({ producer: '(System)', kind: 'system', avsigPath: argAfter(args, '--out'), avsigSha256: 'ab'.repeat(32) });
    if (args.includes('apply')) return envelope({ accepted: true, isValid: true, ops: 1 });
    return envelope({});
  };
  try {
    await within(context, async () => {
      assert.equal(readConnection(anvilRoot, LANE), context.executor.record, 'the record is the executor\'s');
      assert.equal(workerDisabled('o11', {}), true, 'no O11 worker for a customer');
      assert.equal(workerDisabled('odc', {}), false, 'the shared ODC worker stays');
      const lane = o11LaneOf(LANE);
      assert.equal(lane.local, path.join(context.workspace, 'o11')); assert.equal(lane.worker, null); assert.equal(lane.bridge, context.relay);
      assert.ok(!inside(lane.cli, context.workspace), 'the CLI stays the server\'s');

      registerO11Cycle(server);
      const delivered = await result(server.tools, 'o11_deliver', { module: 'Orders', job: [{ op: 'get', target: 'ServerAction:SaveOrder' }], authorize: 'pode entregar no Orders' });
      // 23rd release: every delivered answer names nextBasedOn {job, sha256}; hosted, that job is the customer's inline job.
      const { nextBasedOn, ...deliveredRest } = delivered;
      assert.deepEqual(deliveredRest, { ok: true, result: 'entregue' });
      assert.ok(inside(nextBasedOn?.job, path.join(context.workspace, 'o11', 'jobs', 'inline')) && /^[0-9a-f]{64}$/.test(nextBasedOn.sha256), JSON.stringify(nextBasedOn));
      const deliver = spawned.find(c => c.args.includes('deliver'));
      assertO11Spawn(deliver, context);
      assert.equal(argAfter(deliver.args, '--port'), String(context.relay));
      assert.equal(argAfter(deliver.args, '--work'), path.join(context.workspace, 'o11', 'work'));
      const tasks = (await result(server.tools, 'ssam_task', {})).tasks;
      assert.equal(tasks.length, 1); assert.equal(tasks[0].state, 'ok');
      assert.ok(fs.existsSync(path.join(context.workspace, 'o11', 'tasks', tasks[0].id + '.json')));
      markers.files.push(path.join(anvilRoot, '.local', 'tasks', tasks[0].id + '.json'));
      assert.ok(fs.existsSync(path.join(context.workspace, 'o11', 'journal', 'o11_deliver.jsonl')));

      reset();
      const job = await jobTool({ job: { ops: [{ op: 'get', target: 'ServerAction:SaveOrder' }] }, captureProducers: ['System=(System)'] });
      assert.equal(job.ok, true, JSON.stringify(job));
      assert.equal(spawned.length, 2);
      const [signature, apply] = spawned;
      for (const call of spawned) assertO11Spawn(call, context);
      assert.equal(argAfter(signature.args, '--bridge-port'), String(context.relay));
      assert.ok(inside(argAfter(signature.args, '--out'), path.join(context.workspace, 'o11', 'jobs', 'captured')));
      assert.equal(argAfter(apply.args, '--work'), path.join(context.workspace, 'o11', 'work'));
      assert.ok(inside(job.out, path.join(context.workspace, 'o11', 'jobs')) && fs.existsSync(job.resultFile));
      markers.files.push(path.join(anvilRoot, '.local', 'jobs', 'inline', path.basename(job.job)));

      reset();
      const data = await lanes.run('o11', 'data', ['--studio', '--host', 'x.outsystemscloud.com']);
      assert.equal(data.ok, true, JSON.stringify(data));
      assertO11Spawn(spawned[0], context);
    });
  } finally { respond = () => envelope({}); }
  assert.deepEqual(connections, []);
});

test('the ODC kernel, the builder and the reference CLI run with the customer\'s ODC root; a stale builder is never rebuilt', async () => {
  reset();
  const context = hosted();
  const server = collector();
  const NAME = 'ZZ Hosted Lib';
  respond = (file, args) => {
    if (args.includes('create-app')) {
      const manifest = path.join(argAfter(args, '--out'), 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ module: 'ZZHostedLib', author: 'dev@customer' }));
      return envelope({ ok: true, manifest, moduleKey: 'KEY1', content: {}, settings: {} });
    }
    if (args.includes('check-job')) return envelope({ valid: true });
    if (args.includes('apply')) return envelope({ accepted: true, isValid: true });
    if (args.includes('list')) return { stdout: 'list  ZZHostedLib\n' };
    return envelope({});
  };
  try {
    await within(context, async () => {
      const created = await createStudioCreateApp({ cli: fakeCli })({ kind: 'library', name: NAME, authorize: 'pode criar a ZZ Hosted Lib', publish: false });
      assert.equal(created.ok, true, JSON.stringify(created));
      assert.ok(inside(created.evidence, path.join(context.workspace, 'odc', 'lab', 'create-app')));
      assert.ok(fs.existsSync(path.join(context.workspace, 'odc', 'journal', 'studio_create_app.jsonl')));
      markers.files.push(path.join(anvilRoot, '.local', 'lane-odc', 'create-app', path.basename(created.evidence)));
      const kernel = spawned.find(c => c.args.includes('create-app'));
      assertOdcSpawn(kernel, context);
      assert.deepEqual(context.executor.calls.filter(c => c.kind === 'odc.pipe').map(c => c.params.args[0]), ['auth-status', 'create-app', 'open']);

      reset();
      registerSsamReference(server, { cli: { odc: fakeCli } });
      const checked = await result(server.tools, 'ssam_reference', { lane: 'odc', kind: 'check-job', query: { ops: [] } });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.ok(inside(checked.job, path.join(context.workspace, 'odc', '.local', 'jobs', 'inline')));
      markers.files.push(path.join(anvilRoot, '.local', 'lane-odc', 'jobs', 'inline', path.basename(checked.job)));
      assertOdcSpawn(spawned[0], context);

      // 22nd release: a job that declares its base is checked over it locally (apply, every phase). Hosted, that base would
      // resolve on the server (a suite fixture is a customer capture, an absolute path anything): only the job is read,
      // and the answer says why the Verify did not run.
      for (const base of ['tests/fixtures/odc/blank-crossdevice.oml', 'job:some-suite-job', path.join(os.tmpdir(), 'another-customer.oml')]) {
        reset();
        const withBase = await result(server.tools, 'ssam_reference', { lane: 'odc', kind: 'check-job', query: { base, ops: [] } });
        assert.equal(withBase.ok, true, JSON.stringify(withBase));
        assert.equal(withBase.verifyRan, false);
        assert.match(withBase.verifyReason, /^hosted SSAM server: the base this job declares is not read here/);
        assert.equal(spawned.length, 1); assert.ok(spawned[0].args.includes('check-job')); assert.ok(!spawned[0].args.includes('apply'), 'never the apply over the declared base');
        assertOdcSpawn(spawned[0], context);
        markers.files.push(path.join(anvilRoot, '.local', 'lane-odc', 'jobs', 'inline', path.basename(withBase.job)));
      }

      // 23rd release (servidor/fase4-23): check-job over basedOn, by a patch by name or a partial job. The job of basedOn,
      // the whole job written and the patch journal are the customer's (<ws>/odc/.local), and every answer names nextBasedOn
      // there for the next call; still only check-job runs.
      const inline = path.join(context.workspace, 'odc', '.local', 'jobs', 'inline');
      reset();
      const first = await result(server.tools, 'ssam_reference', { lane: 'odc', kind: 'check-job',
        query: { ops: [{ op: 'logic', data: { actions: [{ name: 'Alpha', kind: 'server', steps: [] }] } }] } });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.ok(inside(first.job, inline)); assert.deepEqual(first.nextBasedOn, { job: first.job, sha256: first.jobSha256 });
      markers.files.push(path.join(anvilRoot, '.local', 'lane-odc', 'jobs', 'inline', path.basename(first.job)));
      for (const query of [{ basedOn: first.nextBasedOn, patch: [{ op: 'replace', path: 'actions/Alpha/kind', value: 'service' }] },
        { basedOn: first.nextBasedOn, job: { ops: [{ op: 'logic', data: { actions: [{ name: 'Beta', kind: 'server', steps: [] }] } }] } }]) {
        reset();
        const next = await result(server.tools, 'ssam_reference', { lane: 'odc', kind: 'check-job', query });
        assert.equal(next.ok, true, JSON.stringify(next));
        assert.ok(inside(next.job, inline) && next.job !== first.job, next.job);
        assert.deepEqual(next.nextBasedOn, { job: next.job, sha256: next.jobSha256 });
        if (query.job) assert.ok(next.partial, 'a partial job says what it merged');
        const written = JSON.parse(fs.readFileSync(next.job, 'utf8'));
        assert.equal(query.patch ? written.ops[0].data.actions[0].kind : written.ops.flatMap(o => o.data?.actions ?? []).map(a => a.name).join(','),
          query.patch ? 'service' : 'Alpha,Beta');
        assert.equal(spawned.length, 1); assert.ok(spawned[0].args.includes('check-job')); assertOdcSpawn(spawned[0], context);
        markers.files.push(path.join(anvilRoot, '.local', 'lane-odc', 'jobs', 'inline', path.basename(next.job)));
      }
      assert.ok(fs.existsSync(path.join(context.workspace, 'odc', '.local', 'journal', 'job-patch.jsonl')), 'the provenance stays in the customer\'s journal');

      reset();
      const odcJob = await runJob({ lane: 'odc', job: { ops: [] } });
      if (odcJob.code === 'odc-cli-missing') assert.deepEqual(spawned, []);
      else {
        assert.ok(inside(odcJob.out, path.join(context.workspace, 'odc', '.local', 'jobs')), JSON.stringify(odcJob));
        assertOdcSpawn(spawned[0], context);
      }

      reset();
      const stale = await lib.ensureBuilder({ needsBuild: () => true });
      assert.equal(stale.ok, false); assert.equal(stale.code, 'COMPONENT_STALE');
      assert.deepEqual(spawned, [], 'no dotnet build');
      const built = await lib.builder(['list']);
      if (lib.builderNeedsBuild()) { assert.equal(built.code, 'COMPONENT_STALE'); assert.deepEqual(spawned, []); }
      else {
        assert.equal(built.ok, true, JSON.stringify(built));
        const builder = spawned.find(c => c.args[0] === lib.paths.builder);
        assertOdcSpawn(builder, context);
        assert.ok(!spawned.some(c => c.args.includes('build')), 'no dotnet build');
      }
    });
  } finally { respond = () => envelope({}); }
  assert.deepEqual(connections, []);
});

// Bridge v36+ names the ODC Studio's model plugin cache in template-download. That folder is on the customer's machine (and
// whatever the agent sends): the server's kernel never receives it as --plugins-dir, since a model plugin is code it loads.
test('hosted studio_create_app never hands the kernel the plugin folder the customer\'s bridge named', async () => {
  reset();
  const context = hosted();
  const CUSTOMER_PLUGINS = 'C:\\Users\\customer\\AppData\\Local\\OutSystems\\ODC Studio\\Plugins';
  const odc = context.executor.odc.bind(context.executor);
  context.executor.odc = args => args[0] === 'template-download'
    ? { ok: true, name: 'Mobile App', revision: 3, sha256: 'ab'.repeat(32), path: path.join(context.workspace, 'odc', 'lab', 'mobile-template.oml'),
      pluginsDirectory: CUSTOMER_PLUGINS, modelPlugins: [{ name: 'MobileUI', version: '1.5.0.0', cached: true }] }
    : odc(args);
  respond = (file, args) => {
    if (!args.includes('create-app')) return envelope({});
    const manifest = path.join(argAfter(args, '--out'), 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ module: 'ZZHostedMobile', author: 'dev@customer' }));
    return envelope({ ok: true, manifest, moduleKey: 'KEY2', content: {}, settings: {} });
  };
  try {
    await within(context, async () => {
      const created = await createStudioCreateApp({ cli: fakeCli })({ kind: 'mobile', name: 'ZZ Hosted Mobile', authorize: 'pode criar o ZZ Hosted Mobile', publish: false });
      assert.equal(created.ok, true, JSON.stringify(created));
      markers.files.push(path.join(anvilRoot, '.local', 'lane-odc', 'create-app', path.basename(created.evidence)));
      const kernel = spawned.find(c => c.args.includes('create-app'));
      assertOdcSpawn(kernel, context);
      assert.equal(argAfter(kernel.args, '--template-oml'), path.join(context.workspace, 'odc', 'lab', 'mobile-template.oml'));
      assert.ok(!kernel.args.includes('--plugins-dir'), kernel.args.join(' '));
      assert.ok(!kernel.args.some(a => String(a).includes(CUSTOMER_PLUGINS)));
    });
  } finally { respond = () => envelope({}); }
  assert.deepEqual(connections, []);
});

test('every data path of the facade lands in the workspace; code locations stay', async () => {
  const context = hosted({ record: true });
  const ws = context.workspace;
  const marker = 'hosted-roots-' + randomUUID();
  await within(context, async () => {
    const expected = {
      tenants: [lib.paths.tenants, path.join(ws, 'odc', 'tenants.json')],
      catalog: [lib.paths.catalog, path.join(ws, 'odc', 'snapshots', 'modules.json')],
      journal: [lib.paths.journal, path.join(ws, 'odc', 'journal', 'operations.jsonl')],
      tasks: [tasksDir(), path.join(ws, 'o11', 'tasks')],
      'o11 locks': [studioWriteTarget({ tool: 'o11_deliver' }).dir, path.join(ws, 'state', 'locks')],
      'odc locks': [studioWriteTarget({ tool: 'studio_merge' }).dir, path.join(ws, 'state', 'locks')],
      'o11 catalog': [lanes.LANES.o11.catalog, path.join(ws, 'o11', 'inventory.json')],
      'odc catalog': [lanes.LANES.odc.catalog, path.join(ws, 'odc', 'snapshots', 'modules.json')],
      'lane local': [o11LaneOf(LANE).local, path.join(ws, 'o11')],
      'lane work': [o11LaneOf(LANE).work, path.join(ws, 'o11', 'work')],
      'SC receipts': [journalDefault().root, path.join(ws, 'o11', 'service-center', 'receipts')],
      'SC state': [stateDir(), path.join(ws, 'state', 'service-center')],
      'evidence roots': [evidenceRoots().join('|'), ['odc', 'o11', 'inbox'].map(f => path.join(ws, f)).join('|')],
      // servidor/fase4-26 (A2): the CX15 destructive store (previews, operations, backups, seen words) of the customer.
      'destructive store': [path.dirname(path.dirname(previewFile(randomUUID()))), path.join(ws, 'state', 'destructive')],
    };
    for (const [name, [actual, wanted]] of Object.entries(expected)) assert.equal(actual, wanted, name);
    // 24th release: requestFile is async (locally it asks the loaded bridge for its root); hosted it is a file of ws:odc.
    assert.ok(inside(await lib.requestFile({ marker }), path.join(ws, 'odc', 'journal', 'portal', 'requests')));
    const records = lib.recordsFile([{ marker }]);
    assert.ok(inside(records, path.join(ws, 'odc', 'journal', 'data', 'requests')));
    markers.files.push(path.join(lib.root, 'journal', 'data', 'requests', path.basename(records)));
    assert.ok(inside(lib.nextLabDir('hosted'), path.join(ws, 'odc', 'lab')));
    lib.journal({ tool: 'hosted-test', command: marker, outcome: 'ok' });
    assert.match(fs.readFileSync(path.join(ws, 'odc', 'journal', 'operations.jsonl'), 'utf8'), new RegExp(marker));
    markers.text.push([path.join(lib.root, 'journal', 'operations.jsonl'), marker]);
    // The Studio write lock of a customer: in the workspace, keyed by the customer's Studio.
    const repoLock = path.join(anvilRoot, '.local', 'locks', 'o11-' + LANE + '~pid5150-port' + context.relay + '.lock');
    await withStudioWriteLock({ tool: 'o11_deliver', args: {}, lane: 'o11' }, async () => {
      assert.deepEqual(fs.readdirSync(path.join(ws, 'state', 'locks')), ['o11-' + LANE + '~pid5150-port' + context.relay + '.lock']);
      assert.equal(fs.existsSync(repoLock), false);
    });
    // ssam_task registered on its own reads the customer's tasks; the O11 reads journal in the customer's o11/reading.
    const tasks = collector(); registerSsamTask(tasks);
    // marco-a6: ssam_task also lists the customer's CX15 destructive operations (none here).
    assert.deepEqual(await result(tasks.tools, 'ssam_task', {}), { ok: true, tasks: [], destructive: [] });
    await assert.rejects(kernelReading({ root: anvilRoot }, ['--bogus']), /Unknown reading argument/);
    assert.ok(fs.existsSync(path.join(ws, 'o11', 'reading', 'operations.jsonl')));
    // Code locations never move.
    assert.equal(lib.paths.builder, path.join(lib.root, 'studio', 'builder', 'bin', 'Release', 'net10.0', 'ODC3.Builder.dll'));
    assert.equal(lanes.LANES.o11.root, anvilRoot); assert.ok(!inside(lanes.LANES.odc.cli, ws) && !inside(lib.paths.portalRuntime, ws));
    assert.equal(readLocalSettings(), null, 'the settings of this machine are the owner\'s');
    assert.deepEqual(lib.tenants(), { default: null, tenants: {} }, 'never the repository tenants.json');
  });
  assert.equal(lib.paths.tenants, path.join(lib.root, 'tenants.json'), 'outside the context, as before');
  assert.equal(tasksDir(), path.join(anvilRoot, '.local', 'tasks'));
  assert.equal(studioWriteTarget({ tool: 'studio_merge' }).dir, path.join(odcRoot, '.local', 'locks'));
});

test('createFacadeServer in a hosted call: its handlers keep the context when called from outside; no vault, no owner tenant', async () => {
  reset();
  const context = hosted();
  fs.writeFileSync(path.join(context.workspace, 'odc', 'tenants.json'), JSON.stringify({ default: null, tenants: { [TENANT]: { portalOrigin: 'https://' + TENANT, class: 'personal' } } }));
  const m = await lib.portal();
  const original = m.registerOdcTools;
  // registerOdcTools' own handlers touch no machine; a probe registered with them shows the context they run in.
  m.registerOdcTools = (server, ...rest) => {
    const value = original(server, ...rest);
    server.registerTool('probe_context', { description: 'test probe', inputSchema: z.object({}).strict() },
      async () => ({ content: [{ type: 'text', text: currentExecutor().id }], structuredContent: { id: currentExecutor().id } }));
    return value;
  };
  let server;
  try { server = await within(context, () => createFacadeServer()); } finally { m.registerOdcTools = original; }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-roots-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
    assert.equal((await call('probe_context')).id, context.executor.id, 'a registerOdcTools handler runs in the context');
    const tenants = await call('hybrid_tenants');
    assert.deepEqual(tenants.tenants.map(t => t.host), [TENANT]);
    assert.equal(tenants.default, null); assert.equal(tenants.selected, null);
    assert.equal(tenants.tenants[0].credentialAvailable, undefined); assert.equal(tenants.tenants[0].vault, 'not used in hosted mode');
    assert.equal((await call('studio_status')).ok, true);
    assert.equal((await call('studio_create_app', { action: 'templates' })).ok, true, 'a registerStudioCreateApp handler reaches the executor');
    const inserted = await call('studio_data_insert', { module: 'Orders', entity: 'Order', records: [{ Name: 'x' }], authorize: 'pode inserir no Orders' });
    assert.equal(inserted.ok, true);
    const pipes = context.executor.calls.filter(c => c.kind === 'odc.pipe').map(c => c.params.args);
    assert.ok(pipes.some(a => a[0] === 'templates'), 'templates went down the customer\'s pipe');
    const insert = pipes.find(a => a[0] === 'data-insert');
    assert.ok(inside(argAfter(insert, '--records-file'), path.join(context.workspace, 'odc', 'journal', 'data', 'requests')));
    const refused = await call('odc_read', { tenant: TENANT, auth: 'api-client', operationId: 'portfolio-api-v2:get:/environments' });
    assert.equal(refused.ok, false); assert.equal(refused.code, 'HOSTED_STUDIO_SESSION_ONLY');
    const authStatus = await call('odc_auth_status', { tenant: TENANT });
    assert.equal(authStatus.tenants[0].apiClient.available, null);
    const doctor = await call('studio_doctor');
    assert.equal(doctor.hosted, true);
    assert.deepEqual(doctor.checks.map(c => c.name), ['agent', 'versions', 'ODC Studio running', 'bridge attached', 'asset catalog', 'journal']);
    assert.ok(!doctor.checks.some(c => c.name === 'dotnet'));
    assert.deepEqual(spawned, [], 'no vault, prompt, dotnet or Studio process of this machine'); assert.deepEqual(connections, []);
  } finally { await client.close(); await server.close(); }
});

test('two hosted contexts keep separate Studio listings', async () => {
  const a = hosted({ pids: [111] }), b = hosted({ pids: [222] });
  assert.deepEqual(await within(a, () => lib.studioPids()), [111]);
  assert.deepEqual(await within(b, () => lib.studioPids()), [222]);
  assert.deepEqual(await within(a, () => lib.studioPids()), [111]);
  assert.equal(a.executor.calls.filter(c => c.kind === 'studio.processes').length, 1, 'the listing is kept per executor');
  assert.equal(b.executor.calls.filter(c => c.kind === 'studio.processes').length, 1);
});

test('the vault, the API Client and the prompt of the server are refused in hosted mode; nothing is read', async () => {
  reset();
  const context = hosted({ record: true });
  const present = [], opened = [];
  const spyPresent = async target => { present.push(target); return true; };
  const spyOpener = async (...args) => { opened.push(args); return { opened: true }; };
  await within(context, async () => {
    const access = await lib.createAccess();
    assert.equal(access, await lib.createAccess(), 'one OdcAccess per context');
    await assert.rejects(access.vault.apiClient(TENANT), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(access.vault.bridge(TENANT), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(access.prompt.apiClient(TENANT), e => e.code === 'HOSTED_PROMPT_UNAVAILABLE');
    await assert.rejects(access.prompt.portal(TENANT), e => e.code === 'HOSTED_PROMPT_UNAVAILABLE');
    assert.equal((await access.portalLogin({ tenant: TENANT, auth: 'portal-credential' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
    assert.equal((await access.openPrompt('api-client', TENANT)).code, 'HOSTED_PROMPT_UNAVAILABLE');
    assert.equal(await lib.credentialStatus({ portalOrigin: 'https://' + TENANT }), false);
    await assert.rejects(lib.portalBridge(TENANT, { portalOrigin: 'https://' + TENANT }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    // The tenant policy file is the customer's own file in ws:odc, never another file of this server.
    const tenantsFile = path.join(context.workspace, 'odc', 'tenants.json');
    const withPolicy = policyFile => fs.writeFileSync(tenantsFile, JSON.stringify({ default: null, tenants: { [TENANT]: { portalOrigin: 'https://' + TENANT, policyFile } } }));
    withPolicy('..\\..\\..\\owner-policy.json');
    assert.throws(() => access.policyOf(TENANT), e => e.code === 'PATH_OUTSIDE_WORKSPACE');
    fs.writeFileSync(path.join(context.workspace, 'odc', 'policy.json'), JSON.stringify({ allowedWriteOperations: ['op-1'] }));
    withPolicy('policy.json');
    assert.deepEqual([...access.policyOf(TENANT)], ['op-1']);

    // Service Center: LifeTime and session "vault" refused before any vault read; no prompt.
    const resolver = (session = 'auto') => new Resolver(TENANT, { session, locate: async () => null, present: spyPresent, running: async () => false, opener: spyOpener });
    await assert.rejects(resolver().resolve('lifetime'), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(resolver('vault').resolve('web'), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(resolver().resolve('web'), e => e.code === 'STUDIO_NOT_CONNECTED', 'no Studio: connect it, never the vault');
    assert.equal((await runServiceCenter(['session-sign-in', '--host', TENANT, '--surface', 'lifetime'], { present: spyPresent, opener: spyOpener })).code, 'HOSTED_STUDIO_SESSION_ONLY');
    const status = await runServiceCenter(['session-status', '--host', TENANT], { locate: async () => null });
    assert.equal(status.vault, 'not used in hosted mode');
    // 24th release: the compatibility sign-in goes through the headless session of the customer's Studio (sc_http,
    // capability sc_http:studioSession), never a vault entry or a window; a bridge without it is refused, nothing sent.
    const sent = [];
    const signedIn = await hiddenSignIn({ capabilities: async () => new Set(['sc_http:studioSession']),
      web: async (...args) => { sent.push(args); return { signedIn: true, submitted: true }; } }, TENANT);
    assert.equal(signedIn.signedIn, true);
    assert.deepEqual(sent, [[TENANT, 'login', { studioSession: true }]]);
    await assert.rejects(hiddenSignIn({ capabilities: async () => new Set(), web: async () => { throw new BridgeError('SECRET_NOT_FOUND', 'no entry'); } }, TENANT),
      e => e.code === 'HEADLESS_AUTH_UNAVAILABLE');
  });
  assert.deepEqual(present, [], 'the server vault is never asked'); assert.deepEqual(opened, [], 'no prompt opens');
  assert.deepEqual(spawned, [], 'no PowerShell vault read'); assert.deepEqual(connections, []);
});

// 23rd release (W3): the O11 discover binds the Studio of the connection record, then ANVIL_STUDIO_DIR, then the one this
// machine's registry names. Hosted, the registry is never read (studio-locate.mjs, behind the seam): no reg.exe, and the
// Studio is the server kernel's that the customer's record names.
test('hosted, the O11 discover reads no registry of this machine (no reg.exe); the Studio is the server kernel\'s of the customer\'s record', async () => {
  reset();
  const { laneSources } = await import('../discovery.mjs');
  const { registryInstallLocation } = await import('../studio-locate.mjs');
  const regs = () => spawned.filter(c => /reg(\.exe)?$/i.test(String(c.file)));
  await within(hosted({ record: true }), async () => {
    assert.equal(registryInstallLocation(), null);
    const bound = laneSources('o11', { studio: { exists: file => path.dirname(file) === SERVER_STUDIO } });
    assert.equal(bound.studioDir, SERVER_STUDIO); assert.equal(bound.studioSource, 'connection');
    const none = laneSources('o11', { studio: { exists: () => false } });
    assert.ok(!none.studioSource || none.studioSource === 'none', JSON.stringify(none.studioSource));
  });
  assert.deepEqual(regs(), [], 'no reg.exe inside a hosted call');
  registryInstallLocation('SSAM test key that does not exist');
  assert.ok(regs().length >= 1, 'outside a hosted call the registry is read as before');
});

test('nothing of the hosted calls lands in the repository data folders or in the user profile', () => {
  for (const file of markers.files) assert.equal(fs.existsSync(file), false, file);
  for (const [file, text] of markers.text) assert.ok(!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(text), file);
  assert.ok(markers.files.length >= 6);
  assert.equal(fs.existsSync(path.join(process.env.USERPROFILE, '.ssam-hybrid')), false, '%USERPROFILE%\\.ssam-hybrid untouched');
  for (const [key, value] of Object.entries(OWNER)) assert.equal(process.env[key], value, 'the owner variables of this process are unchanged: ' + key);
});

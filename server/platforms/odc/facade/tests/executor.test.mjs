// The executor seam (executor.mjs, docs/FASE2-AGENTE.md 4.1): the closed list of kinds, the local executor's dispatch,
// the context on AsyncLocalStorage, the guards, and the served default that fails closed. Nothing here touches a Studio
// or spawns a process: child_process and net are replaced by spies before any facade module loads.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [];
const connections = [];
// answer(file, args, options) -> {stdout} | {error}: set only by the test of the local listing; nothing ever starts.
let answer = null;
cp.execFile = (file, args, options, callback) => {
  spawned.push({ file, args, options });
  if (!answer) throw new Error('no process may start in executor tests');
  const out = answer(file, args, options);
  setImmediate(() => callback(out.error ?? null, out.stdout ?? '', ''));
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr }))));
cp.spawn = (file, args) => { spawned.push({ file, args }); throw new Error('no process may start in executor tests'); };
cp.execFileSync = (file, args) => { spawned.push({ file, args }); throw new Error('no process may start in executor tests'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no connection may open in executor tests'); };
syncBuiltinESMExports();

const executor = await import('../executor.mjs');
const { CALL_KINDS, MACHINE_KINDS, LocalExecutor, DenyExecutor, setDefaultExecutor, runWithExecutor, currentExecutor, hostedContext,
  servedWithoutContext, workspacePath, usesWorkspace, hostedSpawnEnv, fileVersion, createHostedContext, prepareWorkspace, SPAWN_ALLOWED, LOCAL_CALLS } = executor;
const { anvilRoot } = await import('../workspace.mjs');

const fakeExecutor = (record = null) => ({ id: 'fake-' + randomUUID(), hosted: true, calls: [], record,
  async call(kind, params) { this.calls.push({ kind, params }); return {}; }, o11Connection() { return this.record; }, async close() {} });
const hosted = (exec = fakeExecutor(), workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-exec-ws-'))) => ({ id: randomUUID(), hosted: true,
  tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace, agent: null, executor: exec, o11: { studioDir: 'C:\\server\\Service Studio', lane: 'ss4' }, close: async () => {} });
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };

test('the closed list: 10 kinds, 6 that touch a machine, both frozen', () => {
  assert.equal(CALL_KINDS.length, 10);
  assert.ok(Object.isFrozen(CALL_KINDS) && Object.isFrozen(MACHINE_KINDS));
  // file.sync (C14, servidor/fase4): several file.put in one call, between the mirror and an agent 0.2.0+.
  assert.deepEqual([...CALL_KINDS], ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected', 'file.put', 'file.get', 'file.list', 'file.sync']);
  assert.deepEqual([...MACHINE_KINDS], CALL_KINDS.slice(0, 6));
  assert.throws(() => { CALL_KINDS.push('agent.info'); });
});

test('the local executor dispatches each machine kind to its low-level function and refuses the file kinds', async () => {
  const seen = [];
  const fake = kind => async (params, options) => { seen.push({ kind, params, options }); return { kind }; };
  const local = new LocalExecutor(Object.fromEntries(MACHINE_KINDS.map(kind => [kind, fake(kind)])));
  assert.equal(local.id, 'local'); assert.equal(local.hosted, false); assert.equal(local.o11Connection(), undefined);
  const params = { 'studio.processes': { image: 'ODCStudio.exe' }, 'odc.pipe': { pid: 1, version: 'v35', args: ['status'] }, 'odc.attach': { pid: 1, dll: 'x.dll' },
    'o11.bridge': { method: 'ping', params: {}, port: 4516 }, 'o11.connect': { pid: 2 }, 'o11.selected': {} };
  for (const kind of MACHINE_KINDS) assert.deepEqual(await local.call(kind, params[kind], { timeoutMs: 5 }), { kind });
  assert.deepEqual(seen.map(s => s.kind), [...MACHINE_KINDS]);
  assert.deepEqual(seen.map(s => s.params), MACHINE_KINDS.map(kind => params[kind]));
  for (const kind of ['file.put', 'file.get', 'file.list', 'agent.info'])
    await assert.rejects(local.call(kind, {}), error => error.code === 'KIND_NOT_ALLOWED' && error.executed === false);
  assert.equal(seen.length, MACHINE_KINDS.length);
  await local.close();
});

test('the context: local default, nesting, and propagation across promises and timers', async () => {
  assert.ok(currentExecutor() instanceof LocalExecutor);
  assert.equal(hostedContext(), null); assert.equal(servedWithoutContext(), false);
  const a = hosted(), b = hosted();
  await runWithExecutor(a, async () => {
    assert.equal(currentExecutor(), a.executor); assert.equal(hostedContext(), a);
    await Promise.resolve();
    assert.equal(currentExecutor(), a.executor);
    await new Promise(resolve => setTimeout(() => { assert.equal(currentExecutor(), a.executor); resolve(); }, 5));
    await new Promise(resolve => setImmediate(() => { assert.equal(hostedContext(), a); resolve(); }));
    await runWithExecutor(b, async () => { await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(currentExecutor(), b.executor); });
    assert.equal(currentExecutor(), a.executor);
    // A non-hosted context carries an executor and no workspace.
    const deny = new DenyExecutor();
    runWithExecutor({ executor: deny }, () => { assert.equal(currentExecutor(), deny); assert.equal(hostedContext(), null); assert.equal(servedWithoutContext(), true); });
  });
  // Concurrent contexts never see each other.
  const seen = await Promise.all([a, b].map(context => runWithExecutor(context, async () => {
    await new Promise(resolve => setTimeout(resolve, context === a ? 10 : 1));
    return currentExecutor();
  })));
  assert.deepEqual(seen, [a.executor, b.executor]);
  assert.ok(currentExecutor() instanceof LocalExecutor);
  assert.throws(() => runWithExecutor({}, () => {}), TypeError);
});

test('the local executor inside a hosted call refuses with SEAM_LOCAL_IN_HOSTED and runs nothing', async () => {
  const seen = [];
  const local = new LocalExecutor({ 'studio.processes': async () => { seen.push(1); return { processes: [] }; } });
  await runWithExecutor(hosted(), () => assert.rejects(local.call('studio.processes', { image: 'ODCStudio.exe' }), code('SEAM_LOCAL_IN_HOSTED')));
  assert.deepEqual(seen, []);
  assert.deepEqual(await local.call('studio.processes', { image: 'ODCStudio.exe' }), { processes: [] });
});

test('workspace paths and the root rule follow the hosted context only', () => {
  assert.throws(() => workspacePath('odc'), /only valid inside a hosted call/);
  assert.equal(usesWorkspace(undefined, anvilRoot), false);
  assert.equal(usesWorkspace(anvilRoot, anvilRoot), false);
  const context = hosted();
  runWithExecutor(context, () => {
    assert.equal(workspacePath('odc', 'lab'), path.join(context.workspace, 'odc', 'lab'));
    assert.equal(usesWorkspace(anvilRoot, anvilRoot), true);
    assert.equal(usesWorkspace(undefined, anvilRoot), true);
    assert.equal(usesWorkspace(anvilRoot.toUpperCase(), anvilRoot), process.platform === 'win32');
    assert.equal(usesWorkspace(path.join(os.tmpdir(), 'bench'), anvilRoot), false, 'a root passed on purpose stays');
  });
});

test('hostedSpawnEnv is a closed list: the workspace, the relay, and nothing else of this process', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANVIL_BRIDGE_PORT: '4516', ANVIL_AUTHORITY_DIR: 'C:\\owner\\authority', ANVIL_CSHARP_RUNTIME_REGISTRATION: 'C:\\owner\\reg.json',
    SSAM_HYBRID_ODC_TENANT: 'owner.outsystems.dev', ODC_CLIENT_SECRET: 'owner-secret', ANVIL_ODC_FEATURES_DIR: 'C:\\server\\features',
    ANVIL_BRIDGE_FLAVOR: 'owner-flavor', ANVIL_BRIDGE_TIMEOUT_SECONDS: '7' });
  try {
    assert.throws(() => hostedSpawnEnv('odc'), code('HOSTED_CONTEXT_LOST'));
    const record = { ok: true, lane: 'o11', anvilLane: 'ss4', pid: 9, port: 47001, studioDir: 'C:\\record\\Studio' };
    // No record: the customer's relay is still the bridge port (a bridge call there ends at this customer's agent).
    const relayed = hosted({ ...fakeExecutor(null), relayPort: () => 47002 });
    runWithExecutor(relayed, () => {
      const { env, cwd } = hostedSpawnEnv('o11');
      assert.equal(env.ANVIL_BRIDGE_PORT, '47002');
      assert.equal(env.ANVIL_STUDIO_DIR, 'C:\\server\\Service Studio'); assert.equal(env.ANVIL_LANE, 'ss4');
      assert.equal(env.ANVIL_AUTHORITY_DIR, path.join(relayed.workspace, 'state', 'relay-authority'));
      assert.equal(cwd, path.join(relayed.workspace, 'o11'));
      // The thin O11 bridge (docs/O11-BRIDGE-FINA.md 4.4, 4.5): the kernel computes on the server and waits at least 600 s.
      assert.equal(env.ANVIL_BRIDGE_FLAVOR, 'thin'); assert.equal(env.ANVIL_BRIDGE_TIMEOUT_SECONDS, '600');
    });
    // Neither a record nor a relay: refused before any spawn.
    const none = hosted(fakeExecutor(null));
    runWithExecutor(none, () => {
      assert.throws(() => hostedSpawnEnv('o11'), code('O11_NOT_CONNECTED'));
      const { env, cwd } = hostedSpawnEnv('odc');
      assert.equal(cwd, path.join(none.workspace, 'odc'));
      assert.equal(env.SSAM_HYBRID_ODC_ROOT, path.join(none.workspace, 'odc'));
      assert.equal(env.TEMP, path.join(none.workspace, 'odc', 'tmp')); assert.equal(env.TMP, env.TEMP); assert.ok(fs.existsSync(env.TEMP));
      assert.equal(env.TMPDIR, env.TEMP, 'TMPDIR: the temp folder of .NET on Linux');
      assert.equal(env.ANVIL_AUTHORITY_DIR, path.join(none.workspace, 'state', 'relay-authority'));
      assert.equal(env.ANVIL_ODC_FEATURES_DIR, 'C:\\server\\features');
      assert.equal(env.ANVIL_BRIDGE_PORT, undefined);
      assert.equal(env.ANVIL_BRIDGE_FLAVOR, undefined); assert.equal(env.ANVIL_BRIDGE_TIMEOUT_SECONDS, undefined);
    });
    const context = hosted(fakeExecutor(record));
    runWithExecutor(context, () => {
      const { env, cwd } = hostedSpawnEnv('o11');
      assert.equal(cwd, path.join(context.workspace, 'o11'));
      assert.equal(env.ANVIL_BRIDGE_PORT, '47001');
      assert.equal(env.ANVIL_STUDIO_DIR, 'C:\\server\\Service Studio', 'the kernel Studio of the server, not the record');
      assert.equal(env.ANVIL_LANE, 'ss4');
      assert.equal(env.ANVIL_BRIDGE_FLAVOR, 'thin', 'set here, never copied from this process');
      assert.equal(env.ANVIL_BRIDGE_TIMEOUT_SECONDS, '600');
      assert.equal(env.TMPDIR, path.join(context.workspace, 'o11', 'tmp'));
      const allowed = new Set([...SPAWN_ALLOWED, 'TEMP', 'TMP', 'TMPDIR', 'ANVIL_AUTHORITY_DIR', 'ANVIL_BRIDGE_PORT', 'ANVIL_STUDIO_DIR', 'ANVIL_LANE',
        'ANVIL_BRIDGE_FLAVOR', 'ANVIL_BRIDGE_TIMEOUT_SECONDS', 'ANVIL_BRIDGE_PROBE_MS', 'ANVIL_KEPT_READINGS',
    'SSAM_STUDIO_DEFAULTS_ROOT']); // a7 (SD): the customer's own folder of the Studio defaults
      assert.deepEqual(Object.keys(env).filter(k => !allowed.has(k)), []);
      // servidor/fase4-26: the CX14 probes off (A1) and kept readings of the job's own capture only (M2), set here.
      assert.equal(env.ANVIL_BRIDGE_PROBE_MS, '0'); assert.equal(env.ANVIL_KEPT_READINGS, 'own');
      for (const leaked of ['ANVIL_CSHARP_RUNTIME_REGISTRATION', 'SSAM_HYBRID_ODC_TENANT', 'ODC_CLIENT_SECRET', 'SSAM_HYBRID_ODC_ROOT']) assert.equal(env[leaked], undefined, leaked);
    });
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('a served process defaults to DenyExecutor: a lost context fails closed with HOSTED_CONTEXT_LOST and touches nothing', async () => {
  const lib = await import('../lib.mjs');
  const { tasksDir } = await import('../ssam-task.mjs');
  const { o11LaneOf } = await import('../o11-lane.mjs');
  const { readConnection } = await import('../studio-session.mjs');
  const previous = setDefaultExecutor(new DenyExecutor());
  spawned.length = 0; connections.length = 0;
  try {
    assert.ok(previous instanceof LocalExecutor);
    assert.equal(servedWithoutContext(), true);
    await assert.rejects(lib.studio(['status']), error => error.code === 'HOSTED_CONTEXT_LOST' && error.executed === false);
    await assert.rejects(currentExecutor().call('o11.bridge', { method: 'ping' }), code('HOSTED_CONTEXT_LOST'));
    // The data roots fail closed too, instead of answering with this machine's folders.
    assert.throws(() => tasksDir(), code('HOSTED_CONTEXT_LOST'));
    assert.throws(() => lib.paths.journal, code('HOSTED_CONTEXT_LOST'));
    assert.throws(() => o11LaneOf('ss4'), code('HOSTED_CONTEXT_LOST'));
    assert.throws(() => hostedSpawnEnv('odc'), code('HOSTED_CONTEXT_LOST'));
    assert.equal(readConnection(anvilRoot, 'ss4'), null, 'no connection file of this machine is read');
    // A root passed on purpose stays valid (tests, the bench).
    assert.equal(tasksDir('C:\\bench'), path.join('C:\\bench', '.local', 'tasks'));
    assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
  } finally { setDefaultExecutor(previous); }
  assert.ok(currentExecutor() instanceof LocalExecutor);
  assert.equal(servedWithoutContext(), false);
});

test('createHostedContext lays out the workspace, writes a new relay key and starts the AgentExecutor', async () => {
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-exec-ctx-')), 'customers', 'tok_abc');
  const built = [];
  class AgentExecutor {
    constructor(options) { this.options = options; this.id = 'agent-tok_abc'; this.hosted = true; this.started = false; this.closed = 0; built.push(this); }
    async start() { this.started = true; }
    async call() { return {}; }
    o11Connection() { return null; }
    async close() { this.closed++; }
  }
  const link = { tokenId: 'tok_abc', customer: 'Cliente X' };
  const context = await createHostedContext({ tokenId: 'tok_abc', customer: 'Cliente X', lanes: ['odc'], agent: link, workspace }, { loadExecutor: async () => ({ AgentExecutor }) });
  assert.equal(context.hosted, true); assert.equal(context.workspace, workspace); assert.equal(context.agent, link);
  assert.deepEqual([...context.lanes], ['odc']); assert.ok(Object.isFrozen(context));
  const [agent] = built;
  assert.equal(context.executor, agent); assert.equal(agent.started, true);
  assert.equal(agent.options.link, link); assert.equal(agent.options.workspace, workspace);
  assert.equal(agent.options.relayAuthorityDir, path.join(workspace, 'state', 'relay-authority'));
  assert.equal(agent.options.o11.lane, context.o11.lane); assert.ok(path.isAbsolute(agent.options.o11.studioDir));
  for (const folder of ['odc/snapshots', 'odc/journal/staging', 'odc/lab', 'odc/.local/jobs/inline', 'o11/tasks', 'o11/service-center/receipts', 'inbox', 'state/locks', 'state/transfers', '.local/friction'])
    assert.ok(fs.statSync(path.join(workspace, folder)).isDirectory(), folder);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'odc', 'tenants.json'), 'utf8')), { default: null, tenants: {} });
  const keyFile = path.join(workspace, 'state', 'relay-authority', 'bridge.key');
  const first = fs.readFileSync(keyFile, 'utf8');
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  // A customer's own tenants.json is kept; the relay key is new for every context.
  fs.writeFileSync(path.join(workspace, 'odc', 'tenants.json'), JSON.stringify({ default: null, tenants: { 'x.outsystems.dev': { portalOrigin: 'https://x.outsystems.dev' } } }));
  await createHostedContext({ tokenId: 'tok_abc', customer: 'Cliente X', agent: link, workspace }, { loadExecutor: async () => ({ AgentExecutor }) });
  assert.notEqual(fs.readFileSync(keyFile, 'utf8'), first);
  assert.ok(JSON.parse(fs.readFileSync(path.join(workspace, 'odc', 'tenants.json'), 'utf8')).tenants['x.outsystems.dev']);
  await context.close(); await context.close();
  assert.equal(agent.closed, 1);
  await assert.rejects(createHostedContext({ tokenId: '../x', agent: link, workspace }), /tokenId/);
  assert.ok(typeof prepareWorkspace === 'function');
  assert.deepEqual(spawned, []);
});

test('the local listing: pids only by tasklist (15 s, errors thrown) as before the seam; with paths by CIM', async () => {
  spawned.length = 0;
  const list = LOCAL_CALLS['studio.processes'];
  try {
    answer = file => (file === 'tasklist' ? { stdout: '"ODCStudio.exe","4120","Console","1","500.000 K"\r\n"ODCStudio.exe","4188","Console","1","10 K"\r\n' }
      : { stdout: JSON.stringify([{ ProcessId: 4120, ExecutablePath: 'C:\\ODC\\ODCStudio.exe' }]) });
    assert.deepEqual(await list({ image: 'ODCStudio.exe', paths: false }), { processes: [{ pid: 4120, path: null, version: null }, { pid: 4188, path: null, version: null }] });
    assert.equal(spawned[0].file, 'tasklist');
    assert.deepEqual(spawned[0].args, ['/FI', 'IMAGENAME eq ODCStudio.exe', '/FO', 'CSV', '/NH']);
    assert.equal(spawned[0].options.timeout, 15000);
    // No process: tasklist prints an INFO line, which lists nothing.
    answer = () => ({ stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' });
    assert.deepEqual(await list({ image: 'ServiceStudio.exe', paths: false }), { processes: [] });
    answer = () => ({ error: Object.assign(new Error('tasklist failed'), { code: 1 }) });
    await assert.rejects(list({ image: 'ODCStudio.exe', paths: false }), /tasklist failed/);
    // The lanes' listing keeps the executable path (CIM) and says whether each process has a main window (D5: true, false,
    // null when unknown), and a failed listing lists nothing.
    answer = () => ({ stdout: JSON.stringify([{ ProcessId: 4120, ExecutablePath: 'C:\\ODC\\ODCStudio.exe', MainWindowHandle: 77, MainWindowTitle: 'ODC Studio' },
      { ProcessId: 4188, ExecutablePath: 'C:\\ODC\\ODCStudio.exe', MainWindowHandle: 0, MainWindowTitle: '' }, { ProcessId: 4200, ExecutablePath: null }]) });
    assert.deepEqual(await list({ image: 'ODCStudio.exe' }), { processes: [{ pid: 4120, path: 'C:\\ODC\\ODCStudio.exe', window: true, version: null },
      { pid: 4188, path: 'C:\\ODC\\ODCStudio.exe', window: false, version: null }, { pid: 4200, path: null, window: null, version: null }] });
    assert.equal(spawned.at(-1).file, 'powershell');
    assert.ok(spawned.at(-1).args.includes('-EncodedCommand'), 'the windowed script goes encoded (its type definition has quotes and line breaks)');
    answer = () => ({ error: new Error('wmi') });
    assert.deepEqual(await list({ image: 'ODCStudio.exe' }), { processes: [] });
  } finally { answer = null; spawned.length = 0; }
});

test('fileVersion answers null for a missing executable without starting anything', async () => {
  spawned.length = 0;
  assert.equal(await fileVersion(path.join(os.tmpdir(), 'missing-' + randomUUID() + '.exe')), null);
  assert.equal(await fileVersion(''), null);
  assert.deepEqual(spawned, []);
});

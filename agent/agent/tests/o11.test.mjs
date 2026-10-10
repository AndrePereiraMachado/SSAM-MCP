// o11.bridge against a fake TCP bridge, o11.connect (4.9) and o11.selected with fake connector steps. Nothing here
// touches a Service Studio: describe/attach are fakes and the "bridge" is a loopback test server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createKinds } from '../lib/kinds.mjs';
import { hookExchangeDir, hookH1Dll } from '../lib/o11-connect.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { readPack } from '../lib/agent.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { freePort } from './fixtures/ports.mjs';
import { makeRoot, removeRoot } from './fixtures/agent-root.mjs';

const KERNEL = { odc: '1.7.27', o11: '11.55.91', odcBridge: 'v35' };
const STARTED = '2026-10-04T10:00:00.0000000Z';
const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); assert.equal(error.executed, false); return true; });

function connected(root, port, pid = 6000) {
  fs.writeFileSync(path.join(root, 'private', 'o11-connection.json'), JSON.stringify({ ok: true, lane: 'o11', pid, startedUtc: STARTED, port, studioVersion: '11.55.91.65012' }));
  fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'local-agent-key\n');
}

function kindsFor(root, deps = {}) {
  return createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => KERNEL, limits: () => ({}),
    deps: { processes: async () => [], fileVersion: async () => null, sleep: async () => {}, ...deps }, o11Port: deps.o11Port ?? 4516 });
}

test('o11.bridge: the local key replaces any incoming authorization and the port comes only from the agent record', async () => {
  const root = makeRoot();
  const bridge = await fakeBridge(request => ({ success: true, data: { method: request.method, params: request.params,
    path: path.join(root, 'o11', 'snapshots', 'M.oml'), dll: path.join(root, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll') } }));
  try {
    const kinds = kindsFor(root);
    await refused(kinds.execute('o11.bridge', { method: 'ping', params: {} }), 'O11_NOT_CONNECTED');
    connected(root, bridge.port);
    const { reply, paths } = await kinds.execute('o11.bridge', { method: 'get_active_module', params: {}, port: 1, authorization: 'server-controller-key' });
    assert.equal(reply.success, true);
    assert.deepEqual(paths, [['data', 'path']], 'the key path of the one string rewritten');
    assert.equal(bridge.seen.length, 1);
    assert.equal(bridge.seen[0].authorization, 'local-agent-key');
    assert.equal(bridge.seen[0].method, 'get_active_module');
    // The reply's paths under the agent root come back as agent: (readable prefixes only).
    assert.equal(reply.data.path, 'agent:o11/snapshots/M.oml');
    assert.equal(reply.data.dll, path.join(root, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll'));
    // A nested authorization inside params is just a parameter; the request line carries the local key.
    await kinds.execute('o11.bridge', { method: 'ping', params: {}, authorization: 'x', port: bridge.port + 1 });
    assert.equal(bridge.seen[1].authorization, 'local-agent-key');
  } finally { await bridge.close(); removeRoot(root); }
});

test('o11.bridge path positions: sc_api file, outFile, snapshot, merge and download outputDirectory', async () => {
  const root = makeRoot();
  const bridge = await fakeBridge(request => ({ success: true, data: { echo: request.params } }));
  try {
    connected(root, bridge.port);
    const kinds = kindsFor(root);
    await refused(kinds.execute('o11.bridge', { method: 'sc_api', params: { operation: 'PublishSolution', args: { file: 'C:\\Users\\cliente\\x.osp' } } }), 'PATH_NOT_AGENT');
    await refused(kinds.execute('o11.bridge', { method: 'sc_api', params: { operation: 'GetSolution', args: { outFile: 'agent:o11/x.osp' } } }), 'PATH_FORBIDDEN');
    await refused(kinds.execute('o11.bridge', { method: 'sc_web', params: { path: '/ServiceCenter/x', args: { outFile: 'C:\\x.bin' } } }), 'PATH_FORBIDDEN');
    for (const outputDirectory of ['agent:odc/lab/downloads', 'agent:inbox/x', 'agent:private/x', 'agent:o11'])
      await refused(kinds.execute('o11.bridge', { method: 'environment_session', params: { operation: 'download', lease: 'l', arguments: { outputDirectory } } }), 'PATH_FORBIDDEN');
    await refused(kinds.execute('o11.bridge', { method: 'environment_session', params: { operation: 'download', lease: 'l', arguments: { outputDirectory: null } } }), 'PATH_NOT_AGENT');
    await refused(kinds.execute('o11.bridge', { method: 'snapshot_module', params: { path: 'agent:odc/lab/M.oml' } }), 'PATH_FORBIDDEN');
    assert.equal(bridge.seen.length, 0, 'nothing reached the bridge');

    const staged = path.join(root, 'o11', 'journal', 'staging', 'abc.osp');
    let { reply } = await kinds.execute('o11.bridge', { method: 'sc_api', params: { operation: 'PublishSolution', args: { file: 'agent:o11/journal/staging/abc.osp', commitMessage: 'x' } } });
    assert.equal(bridge.seen[0].params.args.file, staged);
    assert.equal(reply.data.echo.args.file, 'agent:o11/journal/staging/abc.osp');
    await kinds.execute('o11.bridge', { method: 'environment_session', params: { operation: 'download', lease: 'l', arguments: { outputDirectory: 'agent:o11/downloads/42', module: { name: 'M' } } } });
    assert.equal(bridge.seen[1].params.arguments.outputDirectory, path.join(root, 'o11', 'downloads', '42'));
    await kinds.execute('o11.bridge', { method: 'environment_session', params: { operation: 'modules', lease: 'l', arguments: {} } });
    await kinds.execute('o11.bridge', { method: 'snapshot_module', params: { path: 'agent:o11/snapshots/M.oml' } });
    assert.equal(bridge.seen[3].params.path, path.join(root, 'o11', 'snapshots', 'M.oml'));
    ({ reply } = await kinds.execute('o11.bridge', { method: 'merge_from_oml', params: { foreign_path: 'agent:o11/work/c.oml', base_path: 'agent:inbox/base.oml', mode: 'auto' } }));
    assert.equal(bridge.seen[4].params.foreign_path, path.join(root, 'o11', 'work', 'c.oml'));
    assert.equal(bridge.seen[4].params.base_path, path.join(root, 'inbox', 'base.oml'));
    // The merge order's first-pass copy is a read position like the candidate; its sha256 passes unchanged.
    await kinds.execute('o11.bridge', { method: 'merge_from_oml', params: { foreign_path: 'agent:o11/work/c.oml', base_path: 'agent:inbox/base.oml',
      first_pass_path: 'agent:o11/work/first-pass.oml', first_pass_sha256: 'ab'.repeat(32), mode: 'auto' } });
    assert.equal(bridge.seen[5].params.first_pass_path, path.join(root, 'o11', 'work', 'first-pass.oml'));
    assert.equal(bridge.seen[5].params.first_pass_sha256, 'ab'.repeat(32));
  } finally { await bridge.close(); removeRoot(root); }
});

test('o11.bridge transport failures keep the bridge codes and what may have run', async () => {
  const root = makeRoot();
  try {
    connected(root, await freePort());
    await assert.rejects(kindsFor(root).execute('o11.bridge', { method: 'ping', params: {} }),
      error => error.code === 'BRIDGE_NOT_LISTENING' && error.executed === false);
    const silent = await fakeBridge(() => undefined);
    connected(root, silent.port);
    await assert.rejects(kindsFor(root).execute('o11.bridge', { method: 'publish', params: {}, timeoutMs: 200 }),
      error => error.code === 'BRIDGE_TIMEOUT' && error.executed === null);
    await silent.close();
  } finally { removeRoot(root); }
});

test('o11.connect attaches with the pack binaries, authenticates with the agent key and writes the record; then reuses it', async () => {
  const root = makeRoot();
  const port = await freePort();
  let bridge = null; const attaches = [];
  try {
    fs.mkdirSync(path.join(root, 'bin', 'o11', 'hook'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), 'hook');
    const describe = async pid => ({ ok: true, pid, startedUtc: STARTED, version: '11.55.91.65012', diagnosticsAvailable: true, bridgePath: bridge ? 'x' : null, corePath: null });
    const attachO11 = async (pid, startedUtc, hook) => {
      attaches.push({ pid, startedUtc, hook, config: JSON.parse(fs.readFileSync(hook + '.json', 'utf8')) });
      fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'fresh-key');
      bridge = await fakeBridge(request => {
        if (request.method === 'ping') return { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: 6000, version: '1.0' } };
        if (request.method === 'bridge_manifest') return { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true } };
        if (request.method === 'ui_alive') return request.authorization === 'fresh-key' ? { success: true, data: { alive: true } } : { success: false, error: 'unauthorized' };
        return { success: false };
      }, { port });
      return { ok: true, hookRequested: true };
    };
    const kinds = kindsFor(root, { o11Port: port, describe, attachO11,
      processes: async image => (image === 'ServiceStudio.exe' ? [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.65012' }] : []) });
    const record = await kinds.execute('o11.connect', {});
    assert.equal(record.ok, true); assert.equal(record.connected, true); assert.equal(record.reused, false);
    assert.equal(record.pid, 6000); assert.equal(record.port, port); assert.equal(record.studioVersion, '11.55.91.65012'); assert.equal(record.uiResponsive, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'private', 'o11-connection.json'), 'utf8')), record);
    assert.equal(attaches.length, 1);
    const [attach] = attaches;
    assert.equal(path.dirname(path.dirname(attach.hook)), path.join(root, 'private', 'runtime-connect'));
    assert.equal(path.basename(attach.hook), 'Anvil.RuntimeHook.Agent.dll');
    assert.deepEqual(attach.config, { pid: 6000, startedUtc: STARTED, port, bridgePath: path.join(root, 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll'),
      authorityDir: path.join(root, 'private', 'authority') });
    assert.equal(fs.existsSync(path.join(root, 'private', 'runtime-connect', 'port-' + port + '.lock')), false);
    // Connected again: the same bridge answers for the same Studio, nothing is attached twice.
    const again = await kinds.execute('o11.connect', { pid: 6000 });
    assert.equal(again.reused, true);
    assert.equal(attaches.length, 1);
    // o11.selected: ping + describe against the record.
    assert.deepEqual(await kinds.execute('o11.selected', {}), { connected: true, pid: 6000, startedUtc: STARTED, version: '11.55.91.65012' });
    const restarted = kindsFor(root, { o11Port: port, describe: async pid => ({ ok: true, pid, startedUtc: '2026-10-04T11:00:00.0000000Z' }) });
    assert.equal((await restarted.execute('o11.selected', {})).connected, false);
  } finally { await bridge?.close(); removeRoot(root); }
});

// The owner's full bridge (or an older pack's) answers ping and bridge_manifest like the thin one, without flavor.
const fullBridge = pid => request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', pid, version: '1.0' } }
  : request.method === 'bridge_manifest' ? { success: true, data: { bridge: 'anvil', protocolVersion: 2, authentication: true } }
  : request.method === 'ui_alive' ? { success: true, data: { alive: true } } : { success: false };

test('o11.connect talks only to the thin bridge: a bridge without flavor "thin" is ATTACH_FAILED and nothing is attached', async () => {
  const root = makeRoot();
  const port = await freePort();
  const full = await fakeBridge(fullBridge(6000), { port });
  try {
    fs.mkdirSync(path.join(root, 'bin', 'o11', 'hook'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), 'hook');
    fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'key');
    let attached = 0;
    const processes = async () => [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.65012' }];
    // Already serving this very Studio: the full bridge is not reused.
    const kinds = kindsFor(root, { processes, o11Port: port, attachO11: async () => { attached++; },
      describe: async pid => ({ ok: true, pid, startedUtc: STARTED, diagnosticsAvailable: true, bridgePath: 'C:\\Owner\\Anvil.Bridge.dll', corePath: 'C:\\Owner\\Anvil.Core.dll' }) });
    await assert.rejects(kinds.execute('o11.connect', {}), error => {
      assert.equal(error.code, 'ATTACH_FAILED');
      assert.equal(error.executed, false);
      assert.equal(error.message, `A non-thin Anvil bridge answers on port ${port}. The agent only talks to the thin bridge of its package; restart Service Studio.`);
      return true;
    });
    assert.equal(attached, 0);
    assert.equal(fs.existsSync(path.join(root, 'private', 'o11-connection.json')), false, 'no connection record');
    assert.deepEqual(full.seen.map(r => r.method), ['ping', 'bridge_manifest'], 'only the open probes reached it; never the agent key');
    await full.close();

    // A pack whose bridge turns out not to be thin after the attach: refused, and the attach is never repeated.
    let late = null;
    const after = kindsFor(root, { processes, o11Port: port,
      attachO11: async () => { attached++; late = await fakeBridge(fullBridge(6000), { port }); },
      describe: async pid => ({ ok: true, pid, startedUtc: STARTED, diagnosticsAvailable: true, bridgePath: null, corePath: null }) });
    await assert.rejects(after.execute('o11.connect', {}), error => {
      assert.equal(error.code, 'ATTACH_FAILED');
      assert.equal(error.executed, null, 'the attach may have run');
      assert.match(error.message, /A non-thin Anvil bridge answers on port/);
      return true;
    });
    assert.equal(attached, 1);
    await late?.close();
  } finally { await full.close().catch(() => {}); removeRoot(root); }
});

// A pack with the release layout (pack.json o11Hook "h1"): the hook and the bridge b1 signed by release.sig.jws (an
// unsigned compact JWS here: the agent checks only that the payload covers each file; the hook checks the chain).
const BRIDGE_BYTES = Buffer.from('MZ thin bridge b1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function releasePack(root, { sign = true } = {}) {
  const files = { 'studio/o11/hook/Anvil.Hook.h1.dll': Buffer.from('MZ hook h1'), 'studio/o11/bridge/b1/Anvil.Bridge.dll': BRIDGE_BYTES,
    'studio/o11/bridge/b1/Anvil.Bridge.deps.json': Buffer.from('{}'), 'release.json': Buffer.from('{"schema":"ssam-agent-release/1","version":"2026.10.5"}') };
  for (const [rel, bytes] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), bytes); }
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ ...pack, o11Hook: 'h1',
    o11Bridge: { id: 'b1', hookAbi: 'h1', path: 'studio/o11/bridge/b1/Anvil.Bridge.dll', sha256: sha(BRIDGE_BYTES) } }));
  if (sign) {
    const payload = { typ: 'ssam-release/1', iat: 1, version: '2026.10.5', files: Object.entries(files).map(([p, bytes]) => ({ path: p, size: bytes.length, sha256: sha(bytes) })) };
    fs.writeFileSync(path.join(root, 'release.sig.jws'), ['{"alg":"ES256","typ":"ssam-release/1"}', JSON.stringify(payload)].map(t => Buffer.from(t).toString('base64url')).join('.') + '.sig');
  }
}
const releaseManifest = (pid, extra = {}) => ({ bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true, pid, bridgeId: 'b1', hookAbi: 'h1',
  ideVersion: '11.55.91.65012', bridgeSha256: sha(BRIDGE_BYTES), ...extra });

// The release hook h1 of the test: reads the request the agent wrote in the exchange folder of the temporary profile,
// "loads" the bridge (a fake one on the requested port) and writes its receipt, or refuses with a receipt only.
function fakeHookH1(root, profile, { refuse = null, manifest = releaseManifest } = {}) {
  const state = { attaches: [], request: null, bridge: null };
  state.attach = async (pid, startedUtc, hook) => {
    state.attaches.push({ pid, startedUtc, hook });
    const exchange = hookExchangeDir(pid, startedUtc, { USERPROFILE: profile });
    state.request = JSON.parse(fs.readFileSync(path.join(exchange, 'request-b1.json'), 'utf8'));
    const receipt = file => fs.writeFileSync(path.join(exchange, 'receipt-b1.json'), JSON.stringify(file));
    if (refuse) { receipt({ ok: false, pid, bridgeId: 'b1', port: state.request.port, error: refuse }); return { ok: true, hookRequested: true }; }
    fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'h1-key');
    state.bridge = await fakeBridge(request => {
      if (request.method === 'ping') return { success: true, data: { bridge: 'anvil', flavor: 'thin', pid, version: '1.0' } };
      if (request.method === 'bridge_manifest') return { success: true, data: manifest(pid) };
      if (request.method === 'ui_alive') return request.authorization === 'h1-key' ? { success: true, data: { alive: true } } : { success: false, error: 'unauthorized' };
      return { success: false };
    }, { port: state.request.port });
    receipt({ ok: true, pid, bridgeId: 'b1', port: state.request.port });
    return { ok: true, hookRequested: true };
  };
  return state;
}

test('o11.connect with the release hook h1: coverage of the signed manifest, request in the exchange folder, receipt, handshake', async () => {
  const root = makeRoot();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-profile-'));
  const port = await freePort();
  const hook = fakeHookH1(root, profile);
  try {
    releasePack(root);
    const describe = async pid => ({ ok: true, pid, startedUtc: STARTED, version: '11.55.91.65012', diagnosticsAvailable: true, bridgePath: null, corePath: null });
    const kinds = kindsFor(root, { o11Port: port, describe, attachO11: hook.attach, env: { USERPROFILE: profile },
      processes: async image => (image === 'ServiceStudio.exe' ? [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.65012' }] : []) });
    const record = await kinds.execute('o11.connect', {});
    assert.equal(record.connected, true); assert.equal(record.reused, false);
    assert.equal(record.hook, 'h1'); assert.equal(record.bridgeId, 'b1'); assert.equal(record.bridgeSha256, sha(BRIDGE_BYTES));
    // The hook is attached in place; nothing is copied beside it and no <hook>.json is written.
    assert.deepEqual(hook.attaches.map(a => a.hook), [hookH1Dll(root)]);
    assert.deepEqual(fs.readdirSync(path.dirname(hookH1Dll(root))), ['Anvil.Hook.h1.dll']);
    const exchange = path.join(profile, '.ssam-hybrid', 'data', 'o11', 'runtime-connect', '6000-' + Date.parse(STARTED));
    assert.equal(hookExchangeDir(6000, STARTED, { USERPROFILE: profile }), exchange);
    assert.deepEqual(hook.request, { pid: 6000, startedUtc: STARTED, bridgeId: 'b1', bridgeDir: path.join(root, 'studio', 'o11', 'bridge', 'b1'), port,
      dataDir: path.join(root, 'private', 'o11-bridge'), authorityDir: path.join(root, 'private', 'authority') });
    assert.deepEqual(fs.readdirSync(exchange).sort(), ['receipt-b1.json', 'request-b1.json']);
    // Again: the same bridge answers with the same handshake; nothing is attached twice.
    assert.equal((await kinds.execute('o11.connect', {})).reused, true);
    assert.equal(hook.attaches.length, 1);
    assert.deepEqual(hook.bridge.seen.filter(r => r.authorization).map(r => r.authorization), ['h1-key', 'h1-key'], 'only the agent key, after the handshake');
  } finally { await hook.bridge?.close(); removeRoot(root); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('o11.connect h1 refusals: a pack changed after signing, a receipt already there, a hook that refuses, a bridge of another pack', async () => {
  const processes = async image => (image === 'ServiceStudio.exe' ? [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.65012' }] : []);
  const describe = async pid => ({ ok: true, pid, startedUtc: STARTED, version: '11.55.91.65012', diagnosticsAvailable: true, bridgePath: null, corePath: null });
  const run = async (label, prepare, check) => {
    const root = makeRoot();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-profile-'));
    const port = await freePort();
    const options = {};
    try {
      releasePack(root);
      prepare({ root, profile, options });
      const hook = fakeHookH1(root, profile, options);
      try {
        const error = await kindsFor(root, { o11Port: port, describe, attachO11: hook.attach, env: { USERPROFILE: profile }, processes }).execute('o11.connect', {})
          .then(() => null, e => e);
        assert.ok(error, label + ': refused');
        check(error, hook, root);
        assert.equal(fs.existsSync(path.join(root, 'private', 'o11-connection.json')), false, label + ': no connection record');
        assert.equal((hook.bridge?.seen ?? []).some(r => r.method === 'ui_alive'), false, label + ': the agent key never went to the bridge');
      } finally { await hook.bridge?.close(); }
    } finally { removeRoot(root); fs.rmSync(profile, { recursive: true, force: true }); }
  };
  await run('changed after signing', ({ root }) => fs.appendFileSync(path.join(root, 'studio', 'o11', 'bridge', 'b1', 'Anvil.Bridge.dll'), 'x'), (error, hook) => {
    assert.equal(error.code, 'ATTACH_FAILED'); assert.equal(error.executed, false);
    assert.match(error.message, /studio\/o11\/bridge\/b1\/Anvil\.Bridge\.dll does not match release\.sig\.jws/);
    assert.equal(hook.attaches.length, 0);
  });
  await run('unsigned', ({ root }) => fs.rmSync(path.join(root, 'release.sig.jws')), (error, hook) => {
    assert.equal(error.code, 'ATTACH_FAILED'); assert.equal(error.executed, false); assert.match(error.message, /release\.sig\.jws\) is missing/);
    assert.equal(hook.attaches.length, 0);
  });
  await run('receipt already there', ({ profile }) => {
    const exchange = hookExchangeDir(6000, STARTED, { USERPROFILE: profile });
    fs.mkdirSync(exchange, { recursive: true });
    fs.writeFileSync(path.join(exchange, 'receipt-b1.json'), JSON.stringify({ ok: false, error: 'earlier' }));
  }, (error, hook) => {
    assert.equal(error.code, 'ATTACH_FAILED'); assert.equal(error.executed, false); assert.match(error.message, /already answered for this Studio/);
    assert.equal(hook.attaches.length, 0);
  });
  await run('hook refuses', ({ options }) => { options.refuse = 'manifest_signature'; }, (error, hook) => {
    assert.equal(error.code, 'ATTACH_FAILED'); assert.equal(error.executed, null);
    assert.match(error.message, /The release hook refused the bridge of this pack: manifest_signature/);
    assert.equal(hook.attaches.length, 1);
  });
  await run('another bridge id', ({ options }) => { options.manifest = pid => releaseManifest(pid, { bridgeId: 'b2' }); }, error => {
    assert.equal(error.code, 'BRIDGE_VERSION_MISMATCH'); assert.equal(error.executed, null); assert.match(error.message, /bridgeId b2, the pack loads b1/);
  });
  await run('another file', ({ options }) => { options.manifest = pid => releaseManifest(pid, { bridgeSha256: 'f'.repeat(64) }); }, error => {
    assert.equal(error.code, 'BRIDGE_VERSION_MISMATCH'); assert.match(error.message, /its file is f{64}, the pack carries /);
  });
  await run('no hook abi', ({ options }) => { options.manifest = pid => releaseManifest(pid, { hookAbi: undefined }); }, error => {
    assert.equal(error.code, 'BRIDGE_VERSION_MISMATCH'); assert.match(error.message, /hookAbi none, the pack needs h1/);
  });
});

test('o11.connect version handshake with the development hook: a thin bridge whose file is not the pack\'s is never used, even reused', async () => {
  const root = makeRoot();
  const port = await freePort();
  const thin = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: 6000, version: '1.0' } }
    : request.method === 'bridge_manifest' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true, pid: 6000, bridgeSha256: 'a'.repeat(64) } }
    : { success: true, data: { alive: true } }, { port });
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'));
    fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ ...pack, o11Hook: 'dev', o11Bridge: { id: null, hookAbi: null, path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: 'b'.repeat(64) } }));
    fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'key');
    const kinds = kindsFor(root, { o11Port: port, attachO11: async () => { throw new Error('never attached'); },
      describe: async pid => ({ ok: true, pid, startedUtc: STARTED, diagnosticsAvailable: true, bridgePath: 'C:\\SSAM-Agent\\bin\\o11\\bridge\\Anvil.Bridge.dll', corePath: null }),
      processes: async () => [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.65012' }] });
    await assert.rejects(kinds.execute('o11.connect', {}), error => {
      assert.equal(error.code, 'BRIDGE_VERSION_MISMATCH'); assert.equal(error.executed, false);
      assert.match(error.message, /its file is a{64}, the pack carries b{64}/);
      return true;
    });
    assert.deepEqual(thin.seen.map(r => r.method), ['ping', 'bridge_manifest']);
  } finally { await thin.close(); removeRoot(root); }
});

test('o11.connect refuses a Studio the pack bridge was not built for, and a port another service holds', async () => {
  const root = makeRoot({ o11BuiltFor: '11.55.80' });
  const squatter = await fakeBridge(() => ({ success: true, data: { bridge: 'something-else' } }));
  try {
    const processes = async () => [{ pid: 6000, path: 'C:\\SS\\ServiceStudio.exe', version: '11.55.91.1' }];
    await refused(kindsFor(root, { processes }).execute('o11.connect', {}), 'STUDIO_VERSION_MISMATCH');
    const pack = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'));
    fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ ...pack, o11BuiltFor: '11.55.91' }));
    let attached = false;
    const kinds = kindsFor(root, { processes, o11Port: squatter.port, attachO11: async () => { attached = true; },
      describe: async pid => ({ ok: true, pid, startedUtc: STARTED, diagnosticsAvailable: true }) });
    await refused(kinds.execute('o11.connect', {}), 'ATTACH_FAILED');
    assert.equal(attached, false);
  } finally { await squatter.close(); removeRoot(root); }
});

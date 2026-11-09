// Window 4x4, phase S1 R2 (review C:\t\r5\janela-4x4\S1-REVISAO.md M1 and B9): the REAL hosted paths of an O11 customer on
// a backend whose default O11 kernel is not the customer's Service Studio. Nothing here is a hand-built kernel or context:
//   - the kernel is ssam.mjs startupKernel over a fake multi-O11 image tree (four Studio folders with their FileVersion,
//     four kernel CLIs), default 11.55.95 (kernel.json), as the server starts;
//   - the hub is createAgentHub with that kernel and the agent says Hello over HTTP with Service Studio 11.55.92;
//   - the hosted context is executor.mjs createHostedContext over the hub's link (AgentExecutor and its relay);
//   - inside runWithExecutor, the paths ssam_discover serves (discovery.mjs laneSources, laneMap, laneDigest, laneOwner,
//     o11Inspect), the O11 worker spec (anvil-worker.mjs hostedWorkerSpec) and the executor's o11Connection.
// Only the reader process itself is replaced (module-map's deps.read, kernel-reading): the test records the reader config
// each path would start, and asserts its dll, Studio runtime folder and module index are all the customer's version. Then
// the customer switches Service Studio under the same context (pong.versions, Hello again): every path follows.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { makePe } from './fixtures/pe-image.mjs';
import { STUDIO_FILE } from '../kernel-image.mjs';
import { createAgentHub } from '../agent-hub.mjs';
import { createTokenStore } from '../server-tokens.mjs';
import { createHostedContext, runWithExecutor, hostedSpawnEnv } from '../executor.mjs';
import { laneSources, laneMap, laneDigest, laneOwner, o11Inspect } from '../discovery.mjs';
import { hostedWorkerSpec } from '../anvil-worker.mjs';
import { o11IndexRoot } from '../o11-kernels.mjs';

const O11 = { '11.55.92': '11.55.92.65269', '11.55.93': '11.55.93.65289', '11.55.94': '11.55.94.65328', '11.55.95': '11.55.95.65352' };
const ODC = '1.7.31', ODC_BUILD = '1.7.31.11065';
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a, b) => path.resolve(a) === path.resolve(b);

test('window 4x4: a .92 customer on a .95-default backend reads, indexes and works with the .92 kernel on every hosted path', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-4x4-paths-'));
  const saved = { ...process.env };
  const studios = path.join(tmp, 'studio', 'o11'), clis = path.join(tmp, 'kernel', '.local', 'o11'), odcDir = path.join(tmp, 'studio', 'odc');
  for (const [v, build] of Object.entries(O11)) {
    fs.mkdirSync(path.join(studios, v), { recursive: true });
    fs.writeFileSync(path.join(studios, v, STUDIO_FILE), makePe(build.split('.').map(Number)));
    fs.mkdirSync(path.join(clis, v, 'cli'), { recursive: true });
    for (const name of ['anvil.dll', 'Anvil.Core.dll']) fs.writeFileSync(path.join(clis, v, 'cli', name), name + ' ' + v);
  }
  fs.mkdirSync(odcDir, { recursive: true });
  fs.writeFileSync(path.join(odcDir, STUDIO_FILE), makePe(ODC_BUILD.split('.').map(Number)));
  for (const name of ['OutSystems.ModelAPILoader.dll', 'OutSystems.Model.dll']) fs.writeFileSync(path.join(odcDir, name), 'x');
  const indexRoot = path.join(tmp, 'module-index');
  // The ENV of the generated multi-O11 Dockerfile (deploy/gen-dockerfile.mjs) on backend odc-1.7.31, default 11.55.95.
  Object.assign(process.env, { SSAM_IMAGE_O11: Object.keys(O11).join(','), SSAM_O11_STUDIO_ROOT: studios, SSAM_O11_CLI_ROOT: clis,
    ANVIL_STUDIO_DIR: path.join(studios, '11.55.95'), SSAM_IMAGE_ODC: ODC, ANVIL_ODC_STUDIO_DIR: odcDir, SSAM_MODULE_INDEX_ROOT: indexRoot,
    SSAM_READER_CACHE_ROOT: path.join(tmp, 'readers'), SSAM_SERVED_VERSIONS: JSON.stringify({ odc: ['1.7.32', '1.7.31', '1.7.30', '1.7.29'], o11: Object.keys(O11) }) });
  const runtime = path.join(tmp, 'runtime'); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'kernel.json'), JSON.stringify({ o11: '11.55.95', odc: ODC, odcBridge: 'v109' }));
  let hub, server, context;
  t.after(async () => {
    await context?.close().catch(() => {});
    await hub?.close();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const { startupKernel } = await import('../ssam.mjs');
  const { kernel } = await startupKernel({ dir: runtime, env: process.env, fileVersion: async () => null });
  assert.equal(kernel.o11, '11.55.95', 'the default kernel of the image');
  assert.deepEqual(kernel.o11Builds, O11, 'the four kernels are on');

  const store = createTokenStore(path.join(tmp, 'tokens'));
  const license = store.issue({ customer: 'Synthetic 4x4', lanes: ['odc', 'o11'] });
  hub = createAgentHub({ dir: path.join(tmp, 'hub'), store, kernel, limits: { sweepMs: 60000, deadAfterMs: 600000 } });
  server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const post = async (url, body) => {
    const r = await fetch('http://127.0.0.1:' + server.address().port + url, { method: 'POST', headers: { authorization: 'Bearer ' + license.agentCredential, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const helloOf = v => ({ t: 'hello', protocol: 'ssam-agent/1', instance: randomUUID(), agent: { odcCommands: ['merge', 'reconcile-merge'] },
    pack: { lanes: ['odc', 'o11'], odcBridge: 'v109', o11BuiltFor: v, o11Hook: 'dev' },
    studios: { odc: { installed: { version: ODC_BUILD } }, o11: { installed: { version: O11[v] } } },
    o11Connection: { pid: 4242, studioVersion: O11[v], startedUtc: '2026-11-09T10:00:00Z' } });

  let welcome = await post('/agent/v1/hello', helloOf('11.55.92'));
  assert.equal(welcome.status, 200, JSON.stringify(welcome.body));
  assert.equal(welcome.body.kernel.o11, '11.55.92');
  const link = hub.link(license.id);
  context = await createHostedContext({ tokenId: 'tok_4x4_paths', customer: 'Synthetic 4x4', lanes: ['odc', 'o11'], agent: link, workspace: path.join(tmp, 'ws') });

  const fingerprints = new Set();
  // .92 first (the M1 scenario), then the customer switches its Service Studio under the same live context.
  for (const v of ['11.55.92', '11.55.94', '11.55.93', '11.55.95']) {
    if (v !== '11.55.92') {
      const next = helloOf(v);
      await post('/agent/v1/messages?channel=' + welcome.body.channel, { messages: [{ t: 'pong', versions: { studios: next.studios } }] });
      assert.equal(link.connected(), false, v + ': a Studio change closes the channel');
      welcome = await post('/agent/v1/hello', next);
      assert.equal(welcome.status, 200, v + ' ' + JSON.stringify(welcome.body)); assert.equal(welcome.body.kernel.o11, v);
    }
    const cli = path.join(clis, v, 'cli', 'anvil.dll'), studio = path.join(studios, v), index = o11IndexRoot(indexRoot, v);
    await runWithExecutor(context, async () => {
      // ssam_discover's sources: the CLI, the kernel dll beside it, the Studio and the CLI processes' environment.
      const sources = laneSources('o11');
      assert.ok(same(sources.cli, cli), v + ' discover cli ' + sources.cli);
      assert.ok(same(sources.kernelDll, path.join(clis, v, 'cli', 'Anvil.Core.dll')), v + ' kernel dll');
      assert.ok(same(sources.studioDir, studio), v + ' discover studio ' + sources.studioDir); assert.equal(sources.studioSource, 'hosted-kernel');
      assert.ok(same(sources.env.ANVIL_STUDIO_DIR, studio), v + ' discover env');
      // The capture of the customer's Studio, read by map, digest and owner: each reader config the path would start.
      const file = path.join(context.workspace, 'o11', 'snapshots', 'M' + v.replaceAll('.', '') + '.oml');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'capture of Service Studio ' + v);
      const started = [];
      const read = async config => { started.push(config); throw new Error('no reader process in this test'); };
      await laneMap('o11', undefined, { read })({ target: file, view: 'map' });
      await laneDigest('o11', undefined, { read })(file);
      await laneOwner('o11', undefined, { read })({ file, sourceSha256: sha256(file), targets: [{ kind: 'flow', name: 'Action1' }] });
      assert.equal(started.length, 3, v + ': map, digest and owner each ask the reader');
      for (const config of started) {
        assert.ok(same(config.dll, cli), v + ' reader dll ' + config.dll);
        assert.ok(same(config.runtimeDir, studio), v + ' reader runtime ' + config.runtimeDir);
        assert.ok(same(config.indexRoot, index), v + ' reader index ' + config.indexRoot);
      }
      // studio_inspect / --app element reads: the lane's resident reader with the customer's CLI and --ss-dir.
      let inspected = null;
      await o11Inspect(undefined, { reading: async (entry, argv) => { inspected = { entry, argv }; return { data: { ok: true } }; } })({ target: file });
      assert.ok(same(inspected.entry.cli, cli), v + ' inspect cli');
      assert.ok(same(inspected.argv[inspected.argv.indexOf('--ss-dir') + 1], studio), v + ' inspect --ss-dir');
      // The O11 worker of this customer (jobs, deliveries): CLI, Studio and index of the same version, its own fingerprint.
      const spec = hostedWorkerSpec();
      assert.ok(same(spec.cli, cli), v + ' worker cli'); assert.ok(same(spec.studioDir, studio), v + ' worker studio');
      assert.ok(same(spec.env.SSAM_MODULE_INDEX_ROOT, index), v + ' worker index');
      assert.ok(same(hostedSpawnEnv('o11').env.ANVIL_STUDIO_DIR, studio), v + ' spawn env');
      fingerprints.add(spec.fingerprint);
      // The connection record the O11 modules read (studio-session readConnection): the Studio of the kernel now.
      const connection = context.executor.o11Connection();
      assert.ok(connection, v + ': connected');
      assert.ok(same(connection.studioDir, studio), v + ' o11Connection studioDir ' + connection.studioDir);
      assert.equal(connection.studioVersion, O11[v]);
    });
  }
  assert.equal(fingerprints.size, 4, 'one worker fingerprint per kernel: no worker of one version serves another');
  // Nothing was indexed under another version's store, nor under the shared root's O11 store.
  for (const v of Object.keys(O11)) {
    const store = o11IndexRoot(indexRoot, v);
    const files = fs.existsSync(store) ? fs.readdirSync(store, { recursive: true }).filter(f => /\.json$/.test(String(f))) : [];
    assert.deepEqual(files, [], v + ' store untouched');
  }
});

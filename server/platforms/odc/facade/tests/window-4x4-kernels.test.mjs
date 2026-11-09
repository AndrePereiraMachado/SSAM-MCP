// Window 4x4, phase S1 (design B: C:\t\r5\janela-4x4\DESENHO.md 1.4 items 2-6): the O11 kernels of a multi-O11 image
// (o11-kernels.mjs) and every place a hosted call reads its customer's own kernel from: the hub's per-client kernel
// (agent-hub.mjs normalizeKernel/compatibility), the served window (studio-identity.mjs servedVersions), the hosted context
// (executor.mjs hostedO11Kernel, hostedSpawnEnv), the O11 lane (o11-lane.mjs, lanes.mjs anvilCli/LANES.o11.cli) and the
// module index (module-map.mjs laneIndexRoot, readerConfig). A single-O11 image (no roots) keeps every value it had.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageO11Versions, o11KernelRoots, o11KernelPaths, isMultiO11Image, o11BuildsOf, selectedO11, clientKernel, o11IndexRoot,
  hostedO11, O11_INDEX_FOLDER } from '../o11-kernels.mjs';
import { servedVersions } from '../studio-identity.mjs';
import { normalizeKernel, compatibility } from '../agent-hub.mjs';
import { runWithExecutor, hostedO11Kernel, hostedSpawnEnv } from '../executor.mjs';
import { anvilCli, LANES } from '../lanes.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { laneIndexRoot, indexRoot, indexFile, readerConfig } from '../module-map.mjs';
import { STORE_GENERATION } from '../store-generation.mjs';

const BUILDS = { '11.55.92': '11.55.92.65269', '11.55.93': '11.55.93.65289', '11.55.94': '11.55.94.65328', '11.55.95': '11.55.95.65352' };
const ROOTS = { SSAM_O11_STUDIO_ROOT: path.resolve('/studio/o11'), SSAM_O11_CLI_ROOT: path.resolve('/app/kernel/.local/o11') };
const MULTI_ENV = { ...ROOTS, SSAM_IMAGE_O11: '11.55.95,11.55.92, 11.55.94,11.55.93' };
const posix = p => p.split(path.sep).join('/');

test('o11-kernels: the image declares its kernels and roots; a single-O11 image is not multi', () => {
  assert.deepEqual(imageO11Versions(MULTI_ENV), ['11.55.92', '11.55.93', '11.55.94', '11.55.95'], 'sorted, trimmed');
  assert.deepEqual(imageO11Versions({ SSAM_IMAGE_O11: '11.55.94' }), ['11.55.94']);
  assert.deepEqual(imageO11Versions({}), []);
  assert.equal(isMultiO11Image(MULTI_ENV), true);
  assert.equal(isMultiO11Image({ SSAM_IMAGE_O11: '11.55.94' }), false, 'the pairs image: no roots');
  assert.equal(o11KernelRoots({ ...MULTI_ENV, SSAM_O11_CLI_ROOT: 'relative/o11' }), null, 'relative roots are refused');
  const at = o11KernelPaths('11.55.93', MULTI_ENV);
  assert.equal(posix(path.relative(ROOTS.SSAM_O11_STUDIO_ROOT, at.studioDir)), '11.55.93');
  assert.equal(posix(path.relative(ROOTS.SSAM_O11_CLI_ROOT, at.cli)), '11.55.93/cli/anvil.dll');
  for (const bad of ['11.55.93.65289', '11.55', '../11.55.93', null]) assert.equal(o11KernelPaths(bad, MULTI_ENV), null, String(bad));
  assert.equal(o11KernelPaths('11.55.93', {}), null);
});

test('o11-kernels: o11Builds normalized; the client kernel is the customer Service Studio when served, else the default', () => {
  assert.equal(o11BuildsOf({ o11: '11.55.94' }), null);
  assert.deepEqual(o11BuildsOf({ o11Builds: { '11.55.93': '11.55.93.65289', '11.55.92': '11.55.93.1', x: 'y' } }), { '11.55.92': null, '11.55.93': '11.55.93.65289' });
  const kernel = { odc: '1.7.32', o11: '11.55.95', odcBridge: 'v109', builds: { odc: '1.7.32.11065', o11: BUILDS['11.55.95'] }, o11Builds: BUILDS,
    o11PackBuiltFor: ['11.55.95'] };
  assert.equal(selectedO11(kernel, { version: '11.55.93.65289' }), '11.55.93');
  assert.equal(selectedO11(kernel, '11.55.92.1'), '11.55.92');
  assert.equal(selectedO11(kernel, { version: '11.55.96.1' }), '11.55.95', 'not served here: the default');
  assert.equal(selectedO11(kernel, null), '11.55.95');
  const view = clientKernel(kernel, { version: '11.55.93.65289' });
  assert.equal(view.o11, '11.55.93'); assert.equal(view.builds.o11, BUILDS['11.55.93']); assert.equal(view.builds.odc, '1.7.32.11065');
  assert.deepEqual(view.o11PackBuiltFor, [], 'the default kernel pack proofs never stand for another Service Studio');
  assert.deepEqual(clientKernel(kernel, { version: BUILDS['11.55.95'] }).o11PackBuiltFor, ['11.55.95']);
  assert.equal(kernel.o11, '11.55.95', 'the server kernel is never changed');
  const single = { odc: '1.7.31', o11: '11.55.94' };
  assert.equal(clientKernel(single, { version: '11.55.93.1' }), single, 'a single-O11 kernel comes back as it is');
});

test('o11-kernels: the per-version index root and the hosted context getters', () => {
  assert.equal(posix(path.relative('/idx', o11IndexRoot('/idx', '11.55.94'))), O11_INDEX_FOLDER + '/11.55.94');
  assert.throws(() => o11IndexRoot('/idx', '11.55.94.1'));
  assert.throws(() => o11IndexRoot('/idx', '../x'));
  const fallback = { studioDir: '/studio/o11/11.55.95', lane: 'ss4' };
  const single = hostedO11({ agent: { kernel: () => ({ o11: '11.55.93' }) }, fallback, env: { SSAM_IMAGE_O11: '11.55.94' } });
  assert.deepEqual({ ...single }, fallback, 'single-O11 image: the context of before');
  let current = { o11: '11.55.93' };
  const multi = hostedO11({ agent: { kernel: () => current }, fallback, env: MULTI_ENV });
  assert.equal(multi.version, '11.55.93'); assert.equal(multi.lane, 'ss4');
  assert.equal(posix(path.relative(ROOTS.SSAM_O11_STUDIO_ROOT, multi.studioDir)), '11.55.93');
  current = { o11: '11.55.92' };
  assert.equal(multi.version, '11.55.92', 'read at each use: a Studio change under a live context follows the new Hello');
  current = { o11: null };
  assert.equal(multi.version, null); assert.equal(multi.studioDir, fallback.studioDir); assert.equal(multi.cli, null);
  const broken = hostedO11({ agent: { kernel: () => { throw new Error('gone'); } }, fallback, env: MULTI_ENV });
  assert.equal(broken.version, null); assert.equal(broken.studioDir, fallback.studioDir);
});

test('hub: a multi-O11 kernel keeps o11Builds and always names its O11 window; compatibility judges the customer kernel', () => {
  const saved = process.env.SSAM_SERVED_VERSIONS; delete process.env.SSAM_SERVED_VERSIONS;
  try {
    const kernel = normalizeKernel({ odc: '1.7.31', o11: '11.55.95', odcBridge: 'v109', o11Builds: BUILDS });
    assert.deepEqual(kernel.o11Builds, BUILDS);
    assert.deepEqual(kernel.servedVersions.o11, Object.keys(BUILDS));
    assert.deepEqual(servedVersions('o11', kernel, { SSAM_SERVED_VERSIONS: '{"o11":["11.55.90"]}' }), Object.keys(BUILDS), 'o11Builds is the O11 window');
    assert.deepEqual(servedVersions('odc', kernel, { SSAM_SERVED_VERSIONS: '{"odc":["1.7.32","1.7.29"]}' }), ['1.7.29', '1.7.31', '1.7.32']);
    assert.deepEqual(servedVersions('o11', { o11: '11.55.94' }, { SSAM_IMAGE_O11: '11.55.92,11.55.93' }), ['11.55.92', '11.55.93', '11.55.94'], 'a list image without o11Builds');
    const single = normalizeKernel({ odc: '1.7.31', o11: '11.55.94', odcBridge: 'v109' });
    assert.equal(single.o11Builds, undefined); assert.equal(single.servedVersions, undefined, 'a pair kernel: unchanged');
    for (const [o11, build] of Object.entries(BUILDS)) {
      const hello = { agent: { odcCommands: ['merge', 'reconcile-merge'] }, studios: { o11: { installed: { version: build } } }, pack: { lanes: ['o11'], o11BuiltFor: o11, o11Hook: 'dev' } };
      const result = compatibility(hello, { odc: '1.7.31', o11: '11.55.95', odcBridge: 'v109', builds: { o11: BUILDS['11.55.95'] }, o11Builds: BUILDS }, ['o11']).o11;
      assert.equal(result.ok, true, o11 + ' ' + JSON.stringify(result)); assert.equal(result.warning, undefined, o11);

    }
  } finally { if (saved === undefined) delete process.env.SSAM_SERVED_VERSIONS; else process.env.SSAM_SERVED_VERSIONS = saved; }
});

// A hosted context as createHostedContext builds it (executor.mjs) with the o11 of hostedO11, on a fake executor.
const fakeExecutor = () => ({ id: 'fake-' + randomUUID(), hosted: true, call: async () => ({}), o11Connection: () => null, relayPort: () => 47002 });
const hostedWith = (o11, workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-4x4-ws-'))) => ({ id: randomUUID(), hosted: true, tokenId: 'tok_4x4',
  customer: 'Synthetic', lanes: ['odc', 'o11'], workspace, agent: null, executor: fakeExecutor(), o11, close: async () => {} });

test('hosted call: the customer kernel reaches the spawn environment, the O11 lane, the CLI and the module index', () => {
  const saved = { ...process.env };
  const serverIndex = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-4x4-index-'));
  Object.assign(process.env, MULTI_ENV, { SSAM_MODULE_INDEX_ROOT: serverIndex });
  try {
    const context = hostedWith(hostedO11({ agent: { kernel: () => ({ o11: '11.55.93' }) }, fallback: { studioDir: '/studio/o11/11.55.95', lane: 'ss4' }, env: MULTI_ENV }));
    const pairDefault = LANES.o11.cli;
    runWithExecutor(context, () => {
      const kernel = hostedO11Kernel();
      assert.equal(kernel.version, '11.55.93');
      const { env } = hostedSpawnEnv('o11');
      assert.equal(posix(path.relative(ROOTS.SSAM_O11_STUDIO_ROOT, env.ANVIL_STUDIO_DIR)), '11.55.93');
      assert.equal(env.SSAM_MODULE_INDEX_ROOT, o11IndexRoot(serverIndex, '11.55.93'), 'its own O11 index store');
      assert.equal(hostedSpawnEnv('odc').env.SSAM_MODULE_INDEX_ROOT, serverIndex, 'the ODC store stays shared');
      assert.equal(anvilCli(), kernel.cli); assert.equal(LANES.o11.cli, kernel.cli);
      const lane = o11LaneOf('ss4');
      assert.equal(lane.studioDir, kernel.studioDir); assert.equal(lane.cli, kernel.cli);
      assert.equal(laneIndexRoot('o11'), o11IndexRoot(serverIndex, '11.55.93')); assert.equal(laneIndexRoot('odc'), indexRoot());
      assert.equal(path.relative(serverIndex, indexFile('o11', 'AB')).split(path.sep).slice(0, 4).join('/'), `${O11_INDEX_FOLDER}/11.55.93/${STORE_GENERATION}/o11`);
      const reader = readerConfig('o11');
      assert.equal(reader.dll, kernel.cli); assert.equal(reader.runtimeDir, kernel.studioDir); assert.equal(reader.indexRoot, o11IndexRoot(serverIndex, '11.55.93'));
    });
    assert.equal(LANES.o11.cli, pairDefault, 'outside the call: the default CLI of the image');
    assert.equal(laneIndexRoot('o11'), indexRoot(), 'outside a hosted call the shared root');
    // A customer whose kernel the hub does not name (O11 off): the server's own Studio and CLI, the shared store.
    const off = hostedWith(hostedO11({ agent: { kernel: () => ({ o11: null }) }, fallback: { studioDir: '/studio/o11/11.55.95', lane: 'ss4' }, env: MULTI_ENV }));
    runWithExecutor(off, () => {
      assert.equal(hostedO11Kernel(), null);
      assert.equal(hostedSpawnEnv('o11').env.SSAM_MODULE_INDEX_ROOT, serverIndex);
      assert.equal(hostedSpawnEnv('o11').env.ANVIL_STUDIO_DIR, '/studio/o11/11.55.95');
      assert.equal(anvilCli(), pairDefault);
    });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(serverIndex, { recursive: true, force: true });
  }
});

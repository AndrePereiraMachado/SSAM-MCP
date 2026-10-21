// The interim image of the multi-version design (rev. 3, O.6.1; kernel-image.mjs and ssam.mjs startupKernel): the PE
// version reader that works on Linux, the image's declared versions against its Studio folders, the per-lane start refusal
// when kernel.json names another version (KERNEL_UNAVAILABLE, kernel-version-missing), kernel.json v1 only, the caches
// without a Studio version emptied when a lane's version changes, the `kernel` event with its old shape, the hub's answers
// (KERNEL_VERSION_MISSING; an older installed Studio is STUDIO_UPDATE_REQUIRED before any package check) and the gate's;
// the served builds of A-M1 (kernel.builds, studio-builds) and kernel.json studioBuildPolicy.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peFileVersion, studioFolderVersion, imageKernel, kernelPair, kernelFileNotes, legacyCacheRoots, resetStaleCaches, checkImage, STUDIO_FILE, STAMP_FILE }
  from '../kernel-image.mjs';
import { compatibility } from '../agent-hub.mjs';
import { incompatible } from '../hosted/policy.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-kernel-image-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = path.join(tmp, 'd' + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };

// A minimal PE32+ image with one .rsrc section holding RT_VERSION / 1 / 0x409 -> VS_VERSIONINFO (VS_FIXEDFILEINFO).
export function makePe(file, product = file) {
  const rsrc = Buffer.alloc(0x58 + 40 + 52);
  const dir = (at, id, to) => { rsrc.writeUInt16LE(1, at + 14); rsrc.writeUInt32LE(id, at + 16); rsrc.writeUInt32LE(to >>> 0, at + 20); };
  dir(0x00, 16, 0x80000000 | 0x18);
  dir(0x18, 1, 0x80000000 | 0x30);
  dir(0x30, 0x409, 0x48);
  rsrc.writeUInt32LE(0x1000 + 0x58, 0x48); rsrc.writeUInt32LE(40 + 52, 0x4c);
  rsrc.writeUInt16LE(40 + 52, 0x58); rsrc.writeUInt16LE(52, 0x5a);
  Buffer.from('VS_VERSION_INFO\0', 'utf16le').copy(rsrc, 0x58 + 6);
  const fixed = 0x58 + 40;
  rsrc.writeUInt32LE(0xfeef04bd, fixed); rsrc.writeUInt32LE(0x10000, fixed + 4);
  rsrc.writeUInt32LE(((file[0] << 16) | file[1]) >>> 0, fixed + 8); rsrc.writeUInt32LE(((file[2] << 16) | file[3]) >>> 0, fixed + 12);
  rsrc.writeUInt32LE(((product[0] << 16) | product[1]) >>> 0, fixed + 16); rsrc.writeUInt32LE(((product[2] << 16) | product[3]) >>> 0, fixed + 20);
  const head = Buffer.alloc(0x200);
  head.write('MZ', 0, 'latin1'); head.writeUInt32LE(0x40, 0x3c); head.write('PE\0\0', 0x40, 'latin1');
  head.writeUInt16LE(0x8664, 0x44); head.writeUInt16LE(1, 0x46); head.writeUInt16LE(240, 0x54);
  const opt = 0x58;
  head.writeUInt16LE(0x20b, opt); head.writeUInt32LE(16, opt + 108); head.writeUInt32LE(0x1000, opt + 112 + 16); head.writeUInt32LE(rsrc.length, opt + 112 + 20);
  const sec = opt + 240;
  head.write('.rsrc', sec, 'latin1'); head.writeUInt32LE(rsrc.length, sec + 8); head.writeUInt32LE(0x1000, sec + 12); head.writeUInt32LE(rsrc.length, sec + 16); head.writeUInt32LE(0x200, sec + 20);
  return Buffer.concat([head, rsrc]);
}
const studioFolder = (version, extra = []) => {
  const d = fresh();
  fs.writeFileSync(path.join(d, STUDIO_FILE), makePe(version.split('.').map(Number)));
  for (const name of extra) fs.writeFileSync(path.join(d, name), 'x');
  return d;
};

test('peFileVersion reads VS_FIXEDFILEINFO of RT_VERSION; anything else is null', () => {
  assert.deepEqual(peFileVersion(makePe([11, 55, 92, 65269], [11, 55, 92, 65269])), { file: '11.55.92.65269', product: '11.55.92.65269' });
  assert.deepEqual(peFileVersion(makePe([1, 7, 28, 10850])), { file: '1.7.28.10850', product: '1.7.28.10850' });
  assert.equal(peFileVersion(Buffer.from('not a pe')), null);
  assert.equal(peFileVersion(makePe([11, 55, 92, 65269]).subarray(0, 0x220)), null, 'truncated');
  const noResource = makePe([1, 2, 3, 4]); noResource.writeUInt32LE(0, 0x58 + 112 + 16);
  assert.equal(peFileVersion(noResource), null);
  // a real Studio folder of this machine when the run names one (ANVIL_STUDIO_DIR): four numbers
  const real = process.env.ANVIL_STUDIO_DIR && fs.existsSync(path.join(process.env.ANVIL_STUDIO_DIR, STUDIO_FILE)) ? studioFolderVersion(process.env.ANVIL_STUDIO_DIR) : null;
  if (real) assert.match(real, /^\d+\.\d+\.\d+\.\d+$/);
});

test('imageKernel: the declared versions and the Studio folders; no variable, nothing declared', () => {
  const o11 = studioFolder('11.55.92.65269'), odc = studioFolder('1.7.28.10850');
  assert.deepEqual(imageKernel({ env: { SSAM_IMAGE_O11: '11.55.92', SSAM_IMAGE_ODC: '1.7.28' }, studioDirs: { o11, odc } }), {
    o11: { declared: '11.55.92', studio: '11.55.92.65269', studioThree: '11.55.92' }, odc: { declared: '1.7.28', studio: '1.7.28.10850', studioThree: '1.7.28' } });
  assert.deepEqual(imageKernel({ env: {}, studioDirs: { o11, odc } }), { o11: null, odc: null });
  assert.deepEqual(checkImage([o11 + '=11.55.92', odc + '=1.7.28']).ok, true);
  assert.deepEqual(checkImage([o11 + '=11.55.91']).ok, false, 'the build refuses an image whose Studio is not the declared version');
  assert.deepEqual(checkImage([fresh() + '=11.55.92']).ok, false, 'no Studio file');
});

test('kernelPair: the interim pair serves both lanes; another kernel.json version turns that lane off', () => {
  const image = { o11: { declared: '11.55.92', studio: '11.55.92.65269', studioThree: '11.55.92' }, odc: { declared: '1.7.28', studio: '1.7.28.10850', studioThree: '1.7.28' } };
  const interim = { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', o11Hook: null, odcBridgeAccepted: ['v96', 'v48', 'v45'] };
  assert.deepEqual(kernelPair(interim, image), { kernel: interim, refused: {} });
  // a857a1e's kernel.json left on the interim image (a forgotten rollback step, the reverse of O.6.1 item 9)
  const old = { o11: '11.55.91', odc: '1.7.27', odcBridge: 'v96', o11Hook: null, odcBridgeAccepted: ['v48', 'v45'] };
  assert.deepEqual(kernelPair(old, image), { kernel: { ...old, o11: null, odc: null },
    refused: { o11: { kernel: '11.55.91', image: '11.55.92', studio: '11.55.92.65269', reason: 'other-version' }, odc: { kernel: '1.7.27', image: '1.7.28', studio: '1.7.28.10850', reason: 'other-version' } } });
  assert.deepEqual(kernelPair({ ...interim, o11: null }, image).refused.o11.reason, 'not-pinned');
  const lying = { ...image, o11: { declared: '11.55.92', studio: '11.55.91.65258', studioThree: '11.55.91' } };
  assert.deepEqual(kernelPair(interim, lying).refused.o11, { kernel: '11.55.92', image: '11.55.92', studio: '11.55.91.65258', reason: 'image-inconsistent' });
  assert.deepEqual(kernelPair(old, { o11: null, odc: null }), { kernel: old, refused: {} }, 'an image that declares nothing (the owner\'s PC) judges nothing');
});

test('kernel.json v1 only: kernel.v2.json is ignored and named; a v2-shaped kernel.json is named', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97' }));
  assert.deepEqual(kernelFileNotes(dir), []);
  fs.writeFileSync(path.join(dir, 'kernel.v2.json'), '{}');
  fs.writeFileSync(path.join(dir, 'kernel.json'), '\uFEFF' + JSON.stringify({ schema: 2, default: { o11: '11.55.92' }, served: {} }));
  assert.deepEqual(kernelFileNotes(dir), [{ event: 'kernel-v2-ignored', file: 'kernel.v2.json' }, { event: 'kernel-json-unsupported', keys: ['schema', 'default', 'served'] }]);
});

test('resetStaleCaches: the roots of a lane whose Studio version changed are emptied once; the stamp keeps the versions', () => {
  const cache = fresh();
  const indexRoot = path.join(cache, 'module-index'), readerRoot = path.join(cache, 'readers'), prefetchRoot = readerRoot + '-prefetch';
  const roots = legacyCacheRoots({ indexRoot, readerRoot, prefetchRoot, o11Platform: 'ss4' });
  assert.deepEqual(roots.o11.map(r => path.relative(cache, r).split(path.sep).join('/')), ['module-index/v1/o11', 'readers/ss4', 'readers-prefetch/ss4', 'readers/ss4-prefetch']);
  assert.deepEqual(roots.odc.map(r => path.relative(cache, r).split(path.sep).join('/')), ['module-index/v1/odc']);
  const seed = () => { for (const r of [...roots.o11, ...roots.odc]) { fs.mkdirSync(r, { recursive: true }); fs.writeFileSync(path.join(r, 'built-before.json'), '{}'); } };
  const odcReader = path.join(readerRoot, 'odc-manifest', 'gen1'); fs.mkdirSync(odcReader, { recursive: true });
  seed();
  const events = [];
  // first start of the interim over a857a1e's cache: no stamp, both lanes emptied
  let r = resetStaleCaches({ kernel: { o11: '11.55.92', odc: '1.7.28' }, indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, ['o11', 'odc']);
  for (const root of [...roots.o11, ...roots.odc]) assert.equal(fs.existsSync(root), false, root);
  assert.equal(fs.existsSync(odcReader), true, 'the ODC readers are keyed by generation (builder and Studio): kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(indexRoot, STAMP_FILE), 'utf8')), { o11: '11.55.92', odc: '1.7.28' });
  assert.deepEqual(events, [{ event: 'kernel-cache-reset', lanes: ['o11', 'odc'], from: { o11: null, odc: null }, to: { o11: '11.55.92', odc: '1.7.28' } }]);
  // a restart: nothing emptied
  seed();
  r = resetStaleCaches({ kernel: { o11: '11.55.92', odc: '1.7.28' }, indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, []); assert.equal(events.length, 1);
  for (const root of roots.o11) assert.equal(fs.existsSync(path.join(root, 'built-before.json')), true);
  // only O11 changes: only the O11 roots; a lane that is null without being off (nothing declared) is left alone
  r = resetStaleCaches({ kernel: { o11: '11.55.93', odc: null }, indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, ['o11']);
  assert.equal(fs.existsSync(path.join(roots.odc[0], 'built-before.json')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(indexRoot, STAMP_FILE), 'utf8')), { o11: '11.55.93', odc: '1.7.28' });
  // an off lane (refused at start) is an invalid stamp: its roots are emptied and its stamp dropped
  seed(); events.length = 0;
  r = resetStaleCaches({ kernel: { o11: null, odc: '1.7.28' }, off: ['o11'], indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, ['o11']);
  for (const root of roots.o11) assert.equal(fs.existsSync(root), false, root);
  assert.equal(fs.existsSync(path.join(roots.odc[0], 'built-before.json')), true, 'the lane that is on keeps its index');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(indexRoot, STAMP_FILE), 'utf8')), { odc: '1.7.28' });
  assert.deepEqual(events, [{ event: 'kernel-cache-reset', lanes: ['o11'], from: { o11: '11.55.93' }, to: { o11: null } }]);
  // still off on the next start, nothing there: nothing to log
  r = resetStaleCaches({ kernel: { o11: null, odc: '1.7.28' }, off: ['o11'], indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, []); assert.equal(events.length, 1);
  // something left in an off lane's root (by any path) is emptied on the next start
  fs.mkdirSync(roots.o11[0], { recursive: true }); fs.writeFileSync(path.join(roots.o11[0], 'late.json'), '{}');
  r = resetStaleCaches({ kernel: { o11: null, odc: '1.7.28' }, off: ['o11'], indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, ['o11']); assert.equal(fs.existsSync(roots.o11[0]), false);
  // the lane comes back on with the valid pair: no stamp, so its roots are emptied once more
  seed();
  r = resetStaleCaches({ kernel: { o11: '11.55.92', odc: '1.7.28' }, indexRoot, roots, log: e => events.push(e) });
  assert.deepEqual(r.reset, ['o11']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(indexRoot, STAMP_FILE), 'utf8')), { odc: '1.7.28', o11: '11.55.92' });
});

test('startupKernel: the interim with a857a1e\'s kernel.json starts with both lanes off, logs kernel-version-missing and keeps the kernel event shape', async () => {
  const { startupKernel } = await import('../ssam.mjs');
  const dir = fresh(), cache = fresh();
  const o11 = studioFolder('11.55.92.65269'), odc = studioFolder('1.7.28.10850', ['OutSystems.ModelAPILoader.dll', 'OutSystems.Model.dll']);
  const env = { ...process.env, SSAM_IMAGE_O11: '11.55.92', SSAM_IMAGE_ODC: '1.7.28', ANVIL_STUDIO_DIR: o11, ANVIL_ODC_STUDIO_DIR: odc,
    SSAM_MODULE_INDEX_ROOT: path.join(cache, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(cache, 'readers') };
  const write = value => fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify(value));
  write({ o11: '11.55.91', odc: '1.7.27', odcBridge: 'v96', odcBridgeAccepted: ['v48', 'v45'] });
  fs.mkdirSync(path.join(cache, 'module-index', 'v1', 'o11'), { recursive: true });
  let events = [];
  let started = await startupKernel({ dir, env, fileVersion: async () => null, log: e => events.push(e) });
  assert.equal(started.kernel.o11, null); assert.equal(started.kernel.odc, null);
  const kernelEvent = events.find(e => e.event === 'kernel');
  assert.deepEqual(Object.keys(kernelEvent), ['event', 'kernel'], 'the kernel event keeps its shape');
  assert.deepEqual(Object.keys(kernelEvent.kernel).sort(), ['o11', 'o11Hook', 'odc', 'odcBridge', 'odcBridgeAccepted']);
  assert.deepEqual(events.filter(e => e.event === 'kernel-version-missing'), [
    { event: 'kernel-version-missing', lane: 'o11', kernel: '11.55.91', image: '11.55.92', studio: '11.55.92.65269', reason: 'other-version' },
    { event: 'kernel-version-missing', lane: 'odc', kernel: '1.7.27', image: '1.7.28', studio: '1.7.28.10850', reason: 'other-version' }]);
  // a lane that is off is an invalid stamp: the index another Studio version built is not left for ssam_map/ssam_discover
  assert.deepEqual(events.filter(e => e.event === 'kernel-cache-reset').map(e => e.lanes), [['o11']]);
  assert.equal(fs.existsSync(path.join(cache, 'module-index', 'v1', 'o11')), false);
  // the interim's own pair (deploy step 5): both lanes, the legacy indexes emptied once (no stamp for them)
  fs.mkdirSync(path.join(cache, 'module-index', 'v1', 'o11'), { recursive: true });
  write({ o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', odcBridgeAccepted: ['v96', 'v48', 'v45'] });
  events = [];
  started = await startupKernel({ dir, env, fileVersion: async () => null, log: e => events.push(e) });
  assert.deepEqual({ o11: started.kernel.o11, odc: started.kernel.odc, refused: started.refused }, { o11: '11.55.92', odc: '1.7.28', refused: {} });
  assert.deepEqual(events.map(e => e.event), ['kernel', 'studio-builds', 'kernel-cache-reset']);
  assert.equal(fs.existsSync(path.join(cache, 'module-index', 'v1', 'o11')), false);
  // without the image variables (the owner's PC) nothing is judged and no cache is touched
  events = [];
  started = await startupKernel({ dir, env: { ...env, SSAM_IMAGE_O11: '', SSAM_IMAGE_ODC: '' }, fileVersion: async () => null, log: e => events.push(e) });
  assert.deepEqual(events.map(e => e.event), ['kernel', 'studio-builds']);
});

// A-M1 (C:\t\multiver\minimo\PROPOSTA.md): the build each lane serves is the image's Studio folder (four numbers), passed to
// the hub as kernel.builds; kernel.json studioBuildPolicy ("warn" by default, "refuse") goes with it. The `kernel` event keeps
// its shape; the new `studio-builds` event names the builds and the policy.
test('startupKernel: the served builds come from the image\'s Studio folders (else this machine\'s Studio); kernel.json studioBuildPolicy goes to the hub', async () => {
  const { startupKernel } = await import('../ssam.mjs');
  const dir = fresh(), cache = fresh();
  const o11 = studioFolder('11.55.92.6000'), odc = studioFolder('1.7.28.5000', ['OutSystems.ModelAPILoader.dll', 'OutSystems.Model.dll']);
  const env = { ...process.env, SSAM_IMAGE_O11: '11.55.92', SSAM_IMAGE_ODC: '1.7.28', ANVIL_STUDIO_DIR: o11, ANVIL_ODC_STUDIO_DIR: odc,
    SSAM_MODULE_INDEX_ROOT: path.join(cache, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(cache, 'readers') };
  const write = value => fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify(value));
  const INTERIM_FILE = { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', odcBridgeAccepted: ['v96', 'v48', 'v45'] };
  // the interim's kernel.json as it is (no policy): the image's builds, policy "warn"
  write(INTERIM_FILE);
  let events = [];
  let started = await startupKernel({ dir, env, fileVersion: async () => '9.9.9.9', log: e => events.push(e) });
  assert.deepEqual(started.kernel.builds, { o11: '11.55.92.6000', odc: '1.7.28.5000' }, 'the image wins over this machine\'s executables');
  assert.equal(started.kernel.studioBuildPolicy, undefined);
  assert.deepEqual(Object.keys(events.find(e => e.event === 'kernel').kernel).sort(), ['o11', 'o11Hook', 'odc', 'odcBridge', 'odcBridgeAccepted'], 'the kernel event keeps its shape');
  assert.deepEqual(events.find(e => e.event === 'studio-builds'), { event: 'studio-builds', builds: { o11: '11.55.92.6000', odc: '1.7.28.5000' },
    studioBuildPolicy: { o11: 'warn', odc: 'warn' } });
  // the owner's choice D-M2b: refuse another build of the ODC Studio
  write({ ...INTERIM_FILE, studioBuildPolicy: { odc: 'refuse' } });
  events = [];
  started = await startupKernel({ dir, env, fileVersion: async () => null, log: e => events.push(e) });
  assert.deepEqual(started.kernel.studioBuildPolicy, { odc: 'refuse' }, 'as written; the hub normalizes it');
  assert.deepEqual(Object.keys(events.find(e => e.event === 'kernel').kernel).sort(), ['o11', 'o11Hook', 'odc', 'odcBridge', 'odcBridgeAccepted']);
  assert.deepEqual(events.find(e => e.event === 'studio-builds').studioBuildPolicy, { o11: 'warn', odc: 'refuse' });
  assert.equal(events.some(e => e.event === 'kernel-json-unsupported'), false, 'the field keeps kernel.json v1');
  // a value the server does not know: both lanes refuse another build, and the start says so
  write({ ...INTERIM_FILE, studioBuildPolicy: 'block' });
  events = [];
  await startupKernel({ dir, env, fileVersion: async () => null, log: e => events.push(e) });
  assert.deepEqual(events.find(e => e.event === 'studio-builds'), { event: 'studio-builds', builds: { o11: '11.55.92.6000', odc: '1.7.28.5000' },
    studioBuildPolicy: { o11: 'refuse', odc: 'refuse' }, policyInvalid: true });
  // a lane the image refused at start serves no build
  write({ ...INTERIM_FILE, odc: '1.7.27' });
  started = await startupKernel({ dir, env, fileVersion: async () => null, log: () => {} });
  assert.deepEqual(started.kernel.builds, { o11: '11.55.92.6000', odc: null });
  // without the image (the owner's PC): this machine's Studio executables, when they have the lane's three numbers
  write(INTERIM_FILE);
  const exe = { 'ServiceStudio.exe': '11.55.92.6001', 'ODCStudio.exe': '1.7.29.1' };
  started = await startupKernel({ dir, env: { ...env, SSAM_IMAGE_O11: '', SSAM_IMAGE_ODC: '' }, fileVersion: async file => exe[path.basename(file)] ?? null, log: () => {} });
  assert.deepEqual(started.kernel.builds, { o11: '11.55.92.6001', odc: null }, 'an ODC Studio of another version is not the build kernel.json serves');
});

const hello = (o11Installed, o11BuiltFor = '11.55.92.65269') => ({ pack: { lanes: ['odc', 'o11'], odcBridge: 'v97', o11BuiltFor },
  studios: { odc: { installed: { version: '1.7.28.10850' } }, o11: { installed: o11Installed ? { version: o11Installed } : null } } });
const INTERIM = { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', odcBridgeAccepted: ['v96', 'v48', 'v45'] };

// A-M1: the older Studio's cause is STUDIO_UPDATE_REQUIRED (it was STUDIO_VERSION_NOT_SERVED) and a newer one has its own,
// STUDIO_VERSION_NOT_SERVED_YET (it had none); installed is the version the agent reports, four numbers.
test('hub: a Service Studio 11.55.91 customer gets STUDIO_UPDATE_REQUIRED on the 11.55.92 server, with either package; a newer one STUDIO_VERSION_NOT_SERVED_YET', () => {
  for (const pack of ['11.55.91.65258', '11.55.92.65269']) {
    const c = compatibility(hello('11.55.91.65258', pack), INTERIM, ['odc', 'o11']);
    assert.equal(c.o11.code, 'STUDIO_VERSION_MISMATCH', pack);
    assert.equal(c.o11.cause, 'STUDIO_UPDATE_REQUIRED');
    assert.deepEqual(c.o11.served, ['11.55.92']); assert.equal(c.o11.installed, '11.55.91.65258');
    assert.match(c.o11.message, /Your Service Studio 11\.55\.91\.65258 is older than the versions this server serves \(11\.55\.92\)/);
    assert.deepEqual(c.odc, { ok: true }, 'the ODC lane is judged on its own');
  }
  assert.deepEqual(compatibility(hello('11.55.92.65269'), INTERIM, ['odc', 'o11']).o11, { ok: true });
  assert.equal(compatibility(hello('11.55.92.65269', '11.55.91.65258'), INTERIM, ['odc', 'o11']).o11.code, 'AGENT_PACK_MISMATCH', 'an 11.55.92 Studio with the old package: the new package helps');
  const newer = compatibility(hello('11.55.93.65300'), INTERIM, ['odc', 'o11']).o11;
  assert.equal(newer.ok, true); assert.equal(newer.warning.code, 'studioNewerThanServed');
});

test('hub and gate: a lane refused at start answers KERNEL_UNAVAILABLE with cause KERNEL_VERSION_MISSING', () => {
  const refused = { o11: { kernel: '11.55.91', image: '11.55.92', reason: 'other-version' } };
  const c = compatibility(hello('11.55.92.65269'), { ...INTERIM, o11: null }, ['odc', 'o11'], { refused });
  assert.equal(c.o11.code, 'KERNEL_UNAVAILABLE'); assert.equal(c.o11.cause, 'KERNEL_VERSION_MISSING');
  assert.match(c.o11.message, /image carries the kernel for Service Studio 11\.55\.92, but its kernel\.json names Service Studio 11\.55\.91/);
  assert.deepEqual(c.odc, { ok: true });
  const gate = incompatible('o11', c.o11, { kernel: { ...INTERIM, o11: null }, studios: hello('11.55.92.65269').studios });
  assert.equal(gate.cause, 'KERNEL_VERSION_MISSING'); assert.equal(gate.continuation.tool, 'ssam_doctor');
  const notServed = compatibility(hello('11.55.91.65258'), INTERIM, ['odc', 'o11']).o11;
  const g2 = incompatible('o11', notServed, { kernel: INTERIM, studios: hello('11.55.91.65258').studios });
  assert.deepEqual({ code: g2.code, cause: g2.cause, served: g2.served }, { code: 'STUDIO_VERSION_MISMATCH', cause: 'STUDIO_UPDATE_REQUIRED', served: ['11.55.92'] });
  assert.match(g2.error, /Update Service Studio and reconnect/); assert.match(g2.continuation.why, /update Service Studio to 11\.55\.92/);
});

test('gate: a lane refused at start is off for the server-only tools too (ssam_job, ssam_map, ssam_discover, o11_job...); the state reports still answer', async () => {
  const { wrapHostedTool, kernelLaneOff } = await import('../hosted/policy.mjs');
  const { fakeAgentLink, hostedDirs } = await import('./fixtures/fake-agent-link.mjs');
  const dirs = hostedDirs(tmp);
  const refusedO11 = { o11: { kernel: '11.55.91', image: '11.55.92', studio: '11.55.92.65269', reason: 'other-version' } };
  for (const connected of [true, false]) {
    const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected });
    const executor = { id: 'fake', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 1 }), async call() { return {}; }, async pullFile() { throw new Error('no pull'); } };
    const context = { id: 'ctx', hosted: true, tokenId: 'tok_test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor };
    const ran = [];
    const gate = (name, args) => wrapHostedTool(name, { inputSchema: {} }, async a => { ran.push(name); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; },
      { context, link, lanes: ['odc', 'o11'], kernelRefused: refusedO11 })(args, { requestId: 1 });
    for (const [name, args] of [['ssam_job', { lane: 'o11', job: { ops: [] } }], ['ssam_job', {}], ['ssam_map', { lane: 'o11', target: 'ws:o11/x.oml' }],
      ['ssam_discover', { intent: 'x', lane: 'o11' }], ['ssam_reference', { lane: 'o11', kind: 'ops' }], ['o11_job', { job: { ops: [] } }]]) {
      const r = await gate(name, args);
      assert.equal(r.isError, true, name);
      assert.deepEqual({ code: r.structuredContent.code, cause: r.structuredContent.cause, lane: r.structuredContent.lane }, { code: 'KERNEL_UNAVAILABLE', cause: 'KERNEL_VERSION_MISSING', lane: 'o11' }, name + ' ' + JSON.stringify(args));
      assert.equal(r.structuredContent.continuation.tool, 'ssam_doctor');
    }
    assert.deepEqual(ran, [], 'nothing of the off lane ran (connected=' + connected + ')');
    for (const [name, args] of [['ssam_discover', { intent: 'x', lane: 'odc' }], ['ssam_discover', { intent: 'x' }], ['ssam_doctor', {}], ['odc_search_operations', { query: 'x' }]]) {
      const r = await gate(name, args);
      assert.equal(r.structuredContent?.code, undefined, name + ' ' + JSON.stringify(r.structuredContent));
    }
    assert.deepEqual(ran, ['ssam_discover', 'ssam_discover', 'ssam_doctor', 'odc_search_operations'], 'the lane that is on and the state report still run');
    // the ODC lane off: studio_doctor (a state report) answers, odc_search_operations does not
    ran.length = 0;
    const offOdc = { odc: { kernel: '1.7.27', image: '1.7.28', reason: 'other-version' } };
    const g2 = (name, args) => wrapHostedTool(name, { inputSchema: {} }, async () => { ran.push(name); return { content: [], structuredContent: { ok: true } }; },
      { context, link, lanes: ['odc', 'o11'], kernelRefused: offOdc })(args, { requestId: 1 });
    assert.equal((await g2('odc_search_operations', { query: 'x' })).structuredContent.code, 'KERNEL_UNAVAILABLE');
    assert.equal((await g2('ssam_job', { lane: 'odc', job: { ops: [] } })).structuredContent.code, 'KERNEL_UNAVAILABLE');
    await g2('studio_doctor', {});
    assert.deepEqual(ran, ['studio_doctor']);
  }
  const text = kernelLaneOff('o11', refusedO11.o11);
  assert.match(text.error, /carries the kernel for Service Studio 11\.55\.92, but its kernel\.json names Service Studio 11\.55\.91: the o11 lane is off on this server, server-only tools included, and nothing ran\./);
  assert.match(kernelLaneOff('odc', { image: '1.7.28', kernel: null }).error, /names no ODC Studio version/);
});

test('createSsamServer({hosted: {kernelRefused}}): ssam_job {lane:"o11"} answers KERNEL_UNAVAILABLE and never runs the kernel; the warm-up skips the off lane', async t => {
  const { createSsamServer, hostedWarmLanes } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const { fakeAgentLink, hostedDirs } = await import('./fixtures/fake-agent-link.mjs');
  const dirs = hostedDirs(tmp);
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'fake', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 1 }), async call() { return {}; }, async pullFile() { throw new Error('no pull'); } };
  const context = { id: 'ctx-k', hosted: true, tokenId: 'tok_test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const runs = [];
  const session = { tokenId: 'tok_test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link };
  const kernelRefused = { o11: { kernel: '11.55.91', image: '11.55.92', reason: 'other-version' } };
  const server = await createSsamServer({ o11: false, odc: false, hosted: { context, session, run: (ctx, fn) => { runs.push(ctx.id); return fn(); }, kernelRefused } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kernel-off-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = new Set((await client.listTools()).tools.map(tool => tool.name));
  const offCalls = [['ssam_job', { lane: 'o11', job: { ops: [] } }], ['ssam_map', { lane: 'o11', target: 'ws:o11/x.oml' }], ['ssam_discover', { intent: 'x', lane: 'o11' }], ['ssam_reference', { lane: 'o11', kind: 'ops' }]].filter(([name]) => listed.has(name));
  assert.ok(offCalls.some(([name]) => name === 'ssam_job'), 'ssam_job is listed: ' + [...listed].join(','));
  for (const [name, args] of offCalls) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.structuredContent?.code, 'KERNEL_UNAVAILABLE', name + ' ' + JSON.stringify(r).slice(0, 400));
    assert.equal(r.structuredContent.cause, 'KERNEL_VERSION_MISSING');
  }
  assert.deepEqual(runs, [], 'no handler of the off lane ran');
  assert.deepEqual(hostedWarmLanes({ odc: true, o11: true }, kernelRefused), ['odc']);
  assert.deepEqual(hostedWarmLanes({ odc: true, o11: true }, {}), ['odc', 'o11']);
  assert.deepEqual(hostedWarmLanes({ odc: false, o11: true }, { o11: {} }), []);
});

test('telemetry adds event names only: warm keeps {event, indexes, delivery, ms}', async () => {
  const { warmServer } = await import('../ssam.mjs');
  const events = [];
  await warmServer({ lanes: ['odc', 'o11'], log: e => events.push(e), indexes: async () => ({ ok: true }), processes: async () => ({ builder: { ok: true }, worker: { ok: true } }) });
  assert.deepEqual(events.map(e => Object.keys(e)), [['event', 'indexes', 'delivery', 'ms']]);
});

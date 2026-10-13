// The image/kernel.json pair check of the deploy folder (kernel-pair-check.mjs; multi-version design rev. 3, O.6.1 items
// 9-10) and the release record it prints from (release-record.json):
//   - the pair of each image, as O.6.1 item 9 records it: a857a1e = 11.55.91 / 1.7.27 / v96, the interim = 11.55.92 /
//     1.7.28 / v97; a rollback to a857a1e that left the interim's kernel.json is refused, and the reverse too;
//   - the Studio versions come from ServiceStudio.Framework.dll under /studio/<lane> and one level below (the multi image);
//   - a kernel.json in the v2 shape is refused (the interim and a857a1e read v1 only);
//   - the PE reader is byte for byte the server line's (platforms/odc/facade/kernel-image.mjs peFileVersion).
// Run: node --test server/deploy/tests/kernel-pair-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPair, main, peFileVersion, recordEntry, studioVersions } from '../kernel-pair-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const deploy = path.resolve(here, '..');
const record = JSON.parse(fs.readFileSync(path.join(deploy, 'release-record.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-pair-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// A minimal PE32+ image with RT_VERSION / 1 / 0x409 -> VS_VERSIONINFO (VS_FIXEDFILEINFO), as the line's kernel-image test.
function makePe(file) {
  const rsrc = Buffer.alloc(0x58 + 40 + 52);
  const dir = (at, id, to) => { rsrc.writeUInt16LE(1, at + 14); rsrc.writeUInt32LE(id, at + 16); rsrc.writeUInt32LE(to >>> 0, at + 20); };
  dir(0x00, 16, 0x80000000 | 0x18); dir(0x18, 1, 0x80000000 | 0x30); dir(0x30, 0x409, 0x48);
  rsrc.writeUInt32LE(0x1000 + 0x58, 0x48); rsrc.writeUInt32LE(92, 0x4c);
  rsrc.writeUInt16LE(92, 0x58); rsrc.writeUInt16LE(52, 0x5a); Buffer.from('VS_VERSION_INFO\0', 'utf16le').copy(rsrc, 0x58 + 6);
  const fixed = 0x58 + 40;
  rsrc.writeUInt32LE(0xfeef04bd, fixed); rsrc.writeUInt32LE(0x10000, fixed + 4);
  rsrc.writeUInt32LE(((file[0] << 16) | file[1]) >>> 0, fixed + 8); rsrc.writeUInt32LE(((file[2] << 16) | file[3]) >>> 0, fixed + 12);
  rsrc.writeUInt32LE(((file[0] << 16) | file[1]) >>> 0, fixed + 16); rsrc.writeUInt32LE(((file[2] << 16) | file[3]) >>> 0, fixed + 20);
  const head = Buffer.alloc(0x200);
  head.write('MZ', 0, 'latin1'); head.writeUInt32LE(0x40, 0x3c); head.write('PE\0\0', 0x40, 'latin1');
  head.writeUInt16LE(0x8664, 0x44); head.writeUInt16LE(1, 0x46); head.writeUInt16LE(240, 0x54);
  head.writeUInt16LE(0x20b, 0x58); head.writeUInt32LE(16, 0x58 + 108); head.writeUInt32LE(0x1000, 0x58 + 128); head.writeUInt32LE(rsrc.length, 0x58 + 132);
  const sec = 0x58 + 240;
  head.write('.rsrc', sec, 'latin1'); head.writeUInt32LE(rsrc.length, sec + 8); head.writeUInt32LE(0x1000, sec + 12); head.writeUInt32LE(rsrc.length, sec + 16); head.writeUInt32LE(0x200, sec + 20);
  return Buffer.concat([head, rsrc]);
}
// An image's /studio: { o11: ['11.55.92.65269'], odc: ['1.7.28.10850'] }; several versions of a lane go one level below.
function studioRoot(lanes) {
  const root = path.join(tmp, 'studio' + (++n));
  for (const [lane, versions] of Object.entries(lanes)) for (const v of versions) {
    const dir = versions.length > 1 ? path.join(root, lane, v.split('.').slice(0, 3).join('.')) : path.join(root, lane);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ServiceStudio.Framework.dll'), makePe(v.split('.').map(Number)));
  }
  return root;
}
const INTERIM = { o11: ['11.55.92.65269'], odc: ['1.7.28.10850'] };
const A857 = { o11: ['11.55.91.65258'], odc: ['1.7.27.10846'] };
const run = (argv, studio) => { let out = '', err = ''; const code = main(argv, { out: { write: s => { out += s; } }, err: { write: s => { err += s; } }, studioRoot: studio }); return { code, out, err }; };
const kernelFile = value => { const f = path.join(tmp, 'kernel' + (++n) + '.json'); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return f; };

test('the release record holds the pair of each image (O.6.1 item 9)', () => {
  assert.deepEqual(recordEntry(record, 'previous').kernelV1, { o11: '11.55.91', odc: '1.7.27', odcBridge: 'v96', odcBridgeAccepted: ['v48', 'v45'] });
  assert.equal(recordEntry(record, 'previous').tag, 'prod-20261012-a857a1e');
  assert.deepEqual(recordEntry(record, 'released').kernelV1, { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', odcBridgeAccepted: ['v96', 'v48', 'v45'] });
  assert.deepEqual(recordEntry(record, 'prod-20261012-a857a1e').kernelV1, recordEntry(record, 'previous').kernelV1);
  assert.equal(recordEntry(record, 'prod-unknown'), null);
  const printed = run(['print', 'previous', path.join(deploy, 'release-record.json')]);
  assert.equal(printed.code, 0); assert.deepEqual(JSON.parse(printed.out), recordEntry(record, 'previous').kernelV1);
  assert.equal(run(['print', 'prod-unknown', path.join(deploy, 'release-record.json')]).code, 1);
});

test('check: each image starts only with its own pair; the reverse pairs are refused (exit 2, refused-pair)', () => {
  const interim = studioRoot(INTERIM), a857 = studioRoot(A857);
  const released = kernelFile(recordEntry(record, 'released').kernelV1), previous = kernelFile(recordEntry(record, 'previous').kernelV1);
  let r = run(['check', released], interim);
  assert.equal(r.code, 0); assert.deepEqual(JSON.parse(r.out), { ok: true, status: 'pair-ok', o11: { kernel: '11.55.92', image: ['11.55.92.65269'], ok: true }, odc: { kernel: '1.7.28', image: ['1.7.28.10850'], ok: true } });
  assert.equal(run(['check', previous], a857).code, 0);
  // a rollback that restored a857a1e but left the interim's kernel.json: a857a1e would run its 11.55.91 kernel for 11.55.92
  r = run(['check', released], a857);
  assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).status, 'refused-pair');
  assert.equal(JSON.parse(r.out).o11.ok, false); assert.equal(JSON.parse(r.out).odc.ok, false);
  assert.equal(run(['check', previous], interim).code, 2, 'the interim with a857a1e\'s kernel.json');
  // one lane off is enough to refuse
  assert.equal(run(['check', kernelFile({ ...recordEntry(record, 'released').kernelV1, odc: '1.7.27' })], interim).code, 2);
  assert.equal(run(['check', kernelFile({ odc: '1.7.28' })], interim).code, 2, 'a lane without a version');
});

test('check: kernel.json v1 only; a usage or read error is exit 1', () => {
  const interim = studioRoot(INTERIM);
  const v2 = run(['check', kernelFile({ schema: 2, default: { o11: '11.55.92', odc: '1.7.28' }, served: {} })], interim);
  assert.equal(v2.code, 2); assert.match(JSON.parse(v2.out).reason, /v1 only/);
  assert.equal(run(['check', kernelFile('\uFEFF' + JSON.stringify(recordEntry(record, 'released').kernelV1))], interim).code, 0, 'a BOM is read');
  assert.equal(run(['check', path.join(tmp, 'missing.json')], interim).code, 1);
  assert.equal(run(['check'], interim).code, 1);
  assert.equal(run(['nope'], interim).code, 1);
});

test('the Studio versions are read under /studio/<lane> and one level below (the multi-version layout)', () => {
  const multi = studioRoot({ o11: ['11.55.92.65269', '11.55.91.65258'], odc: ['1.7.28.10850'] });
  assert.deepEqual(studioVersions(path.join(multi, 'o11')), ['11.55.91.65258', '11.55.92.65269']);
  assert.equal(checkPair({ o11: '11.55.91', odc: '1.7.28' }, { studioRoot: multi }).ok, true);
  assert.deepEqual(studioVersions(path.join(tmp, 'none')), []);
});

test('the PE reader is the server line\'s, answer for answer', async () => {
  const line = [path.resolve(deploy, '..', 'platforms', 'odc', 'facade', 'kernel-image.mjs')].find(f => fs.existsSync(f));
  if (!line) return;
  const { peFileVersion: linePe } = await import(pathToFileURL(line).href);
  const cases = [makePe([11, 55, 92, 65269]), makePe([1, 7, 28, 10850]), makePe([11, 55, 92, 65269]).subarray(0, 0x230), Buffer.from('MZ but nothing'), Buffer.alloc(0)];
  const studio = process.env.ANVIL_STUDIO_DIR && path.join(process.env.ANVIL_STUDIO_DIR, 'ServiceStudio.Framework.dll');
  if (studio && fs.existsSync(studio)) cases.push(fs.readFileSync(studio));
  for (const bytes of cases) assert.deepEqual(peFileVersion(bytes), linePe(bytes));
  assert.deepEqual(peFileVersion(cases[0]), { file: '11.55.92.65269', product: '11.55.92.65269' });
});

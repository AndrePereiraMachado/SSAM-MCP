// Review M-R3-1 of agent/mac-028: the update gate and Squirrel.Mac (ditto, which may read the local headers in sequence) must see
// the same entries. core/zip-structure.mjs accepts only a ZIP whose every byte belongs to a listed entry, whose local headers
// repeat the central directory, and whose features it can check. The ZIPs here are written byte by byte; the review's probe
// (PROBE_ZIP below: the exact bytes made by C:\t\r5\mac-028\review\m1r3-cd-probe.py, a local Old.app entry the central
// directory does not list; base64 because *.zip is ignored by git) must be refused, and the real build A ZIP
// (SSAM_REAL_MAC_UPDATE_ZIP) must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipStructure } from '../../src/main/core/zip-structure.mjs';
import { macZipProblem } from '../../src/main/core/update-verify.mjs';

// sha256 0279b25ac31470e06d0a05d7bf96e93963c539469c781ee4881a6d590c80a78a (517 bytes).
const PROBE_ZIP = Buffer.from(
  'UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAPAAAAU1NBTSBBZ2VudC5hcHAvUEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAYAAAAU1NBTSBBZ2' +
  'VudC5hcHAvQ29udGVudHMvUEsDBBQAAAAAAAAAIQAY1m+2HgAAAB4AAAAiAAAAU1NBTSBBZ2VudC5hcHAvQ29udGVudHMvSW5mby5wbGlzdDxw' +
  'bGlzdD5nYXRlLXJlYWRzLXRoaXM8L3BsaXN0PlBLAwQUAAAAAAAAACEAxYueFCIAAAAiAAAAGwAAAE9sZC5hcHAvQ29udGVudHMvSW5mby5wbG' +
  'lzdDxwbGlzdD5vbmx5LWEtbG9jYWwtaGVhZGVyPC9wbGlzdD5QSwECFAMUAAAAAAAAACEAAAAAAAAAAAAAAAAADwAAAAAAAAAAAAAA7UEAAAAA' +
  'U1NBTSBBZ2VudC5hcHAvUEsBAhQDFAAAAAAAAAAhAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAO1BLQAAAFNTQU0gQWdlbnQuYXBwL0NvbnRlbn' +
  'RzL1BLAQIUAxQAAAAAAAAAIQAY1m+2HgAAAB4AAAAiAAAAAAAAAAAAAACkgWMAAABTU0FNIEFnZW50LmFwcC9Db250ZW50cy9JbmZvLnBsaXN0' +
  'UEsFBgAAAAADAAMA0wAAABwBAAAAAA==',
  'base64');
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const MODE = { d: 0o040755, '-': 0o100644, l: 0o120755 };

// entries: [{name, type, data, deflate, descriptor, signed, localName, flags, madeBy, extra, localExtra}]; tweak(parts) may change
// the pieces (local records, central records) before they are joined.
function writeZip(entries, { tweak = null, comment = '', prefix = Buffer.alloc(0), trailer = Buffer.alloc(0) } = {}) {
  const locals = []; const centrals = []; let offset = prefix.length;
  for (const e of entries) {
    const plain = Buffer.from(e.data ?? '');
    const method = e.deflate ? 8 : 0;
    const body = e.deflate ? zlib.deflateRawSync(plain) : plain;
    const crc = crc32(plain);
    const flags = (e.flags ?? 0) | (e.descriptor ? 0x0008 : 0);
    const name = Buffer.from(e.name), localName = Buffer.from(e.localName ?? e.name);
    const extra = e.extra ?? Buffer.alloc(0), localExtra = e.localExtra ?? extra;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14); local.writeUInt32LE(e.descriptor ? 0 : body.length, 18); local.writeUInt32LE(e.descriptor ? 0 : plain.length, 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (e.descriptor) {
      descriptor = Buffer.alloc(e.signed === false ? 12 : 16); let at = 0;
      if (e.signed !== false) { descriptor.writeUInt32LE(0x08074b50, 0); at = 4; }
      descriptor.writeUInt32LE(e.descriptorCrc ?? crc, at); descriptor.writeUInt32LE(body.length, at + 4); descriptor.writeUInt32LE(plain.length, at + 8);
    }
    const record = Buffer.concat([local, localName, localExtra, body, descriptor]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.madeBy ?? 0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE((MODE[e.type ?? (e.name.endsWith('/') ? 'd' : '-')] << 16) >>> 0, 38);
    central.writeUInt32LE(e.offset ?? offset, 42);
    locals.push({ entry: e, bytes: record }); centrals.push({ entry: e, bytes: Buffer.concat([central, name, extra]) });
    offset += record.length;
  }
  if (tweak) tweak({ locals, centrals });
  const data = Buffer.concat([prefix, ...locals.map(l => l.bytes)]);
  const directory = Buffer.concat(centrals.filter(c => !c.entry.hidden).map(c => c.bytes));
  const end = Buffer.alloc(22);
  const count = centrals.filter(c => !c.entry.hidden).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(data.length, 16); end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([data, directory, end, Buffer.from(comment), trailer]);
}

const ROOT = 'SSAM Agent.app';
const tree = () => [
  { name: ROOT + '/' }, { name: ROOT + '/Contents/' }, { name: ROOT + '/Contents/Info.plist', data: '<plist>0.2.9</plist>', deflate: true },
  { name: ROOT + '/Contents/Resources/' }, { name: ROOT + '/Contents/Resources/app-update.yml', data: 'url: https://dist.ssam.pro/u/ssam-agent\n' },
  { name: ROOT + '/Contents/Frameworks/' }, { name: ROOT + '/Contents/Frameworks/X.framework/' },
  { name: ROOT + '/Contents/Frameworks/X.framework/Resources', type: 'l', data: 'Versions/Current/Resources' },
  { name: ROOT + '/Contents/Frameworks/X.framework/Versions/Current', type: 'l', data: 'A', deflate: true },
];

function structureOf(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-structure-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'u.zip'); fs.writeFileSync(file, bytes);
  return zipStructure(file);
}

test('a well-formed ZIP is read whole: names, types and symlink targets (stored and deflated)', t => {
  const answer = structureOf(t, writeZip(tree()));
  assert.equal(answer.problem, undefined);
  assert.deepEqual(answer.entries.map(e => [e.type, e.name, e.link]), tree().map(e => [e.type ?? (e.name.endsWith('/') ? 'd' : '-'), e.name, e.type === 'l' ? e.data : null]));
  // Data descriptors (with and without their signature) are allowed when they repeat the directory's CRC and sizes.
  const described = tree().map((e, i) => ({ ...e, descriptor: i % 2 === 0, signed: i % 4 !== 0 }));
  assert.equal(structureOf(t, writeZip(described)).problem, undefined);
  // UTF-8 flag allowed.
  assert.equal(structureOf(t, writeZip(tree().map(e => ({ ...e, flags: 0x0800 })))).problem, undefined);
});

test('the review probe (a local Old.app entry the central directory does not list) is refused', t => {
  const answer = structureOf(t, PROBE_ZIP);
  assert.match(answer.problem, /91 bytes between its last listed entry and the central directory that no listed entry covers/);
  // The same trick in the middle of the ZIP, at its start, and with a local name other than the listed one.
  const hiddenMiddle = tree(); hiddenMiddle.splice(3, 0, { name: 'Old.app/Contents/Info.plist', data: '<plist>0.2.7</plist>', hidden: true });
  assert.match(structureOf(t, writeZip(hiddenMiddle)).problem, /bytes before the entry "SSAM Agent\.app\/Contents\/Resources\/" belong to no listed entry/);
  const hiddenFirst = [{ name: 'Old.app/', hidden: true }, ...tree()];
  assert.match(structureOf(t, writeZip(hiddenFirst)).problem, /bytes before the entry "SSAM Agent\.app\/" belong to no listed entry/);
  const renamed = tree().map(e => e.name.endsWith('Info.plist') ? { ...e, localName: 'Old.app/Contents/Info.plist' } : e);
  assert.match(structureOf(t, writeZip(renamed)).problem, /has another name in its local header \("Old\.app\/Contents\/Info\.plist"\)/);
});

test('bytes outside the entries, a comment, ZIP64, encryption, other methods, other hosts and broken records are refused', t => {
  const cases = [
    [writeZip(tree(), { prefix: Buffer.from('MZ stub') }), /7 bytes before the entry "SSAM Agent\.app\/" belong to no listed entry/],
    [writeZip(tree(), { trailer: Buffer.from('x') }), /does not end with its end-of-central-directory record/],
    [writeZip(tree(), { comment: 'hello' }), /does not end with its end-of-central-directory record/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, flags: 0x0001 } : e)), /flags 0x1 \(encryption/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, extra: Buffer.from([1, 0, 0, 0]) } : e)), /ZIP64 extra field/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, extra: Buffer.from([0x55, 0x54, 9, 0]) } : e)), /extra fields overrun/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, madeBy: 0x0014 } : e)), /was not made on Unix/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, descriptor: true, descriptorCrc: 1 } : e)), /data descriptor that does not match/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, offset: 0 } : e)), /overlaps the entry before it/],
    [writeZip(tree().map((e, i) => i === 1 ? { ...e, type: '-' } : e)), /folder name and a file mode/],
    [writeZip(tree(), { tweak: ({ locals }) => { locals[4].bytes.writeUInt16LE(12, 8); } }), /other flags or method in its local header/],
    [writeZip(tree(), { tweak: ({ locals }) => { locals[4].bytes.writeUInt32LE(1, 14); } }), /another CRC or size in its local header/],
    [writeZip(tree(), { tweak: ({ centrals }) => { centrals[2].bytes.writeUInt16LE(12, 10); } }), /compression method 12/],
    [writeZip(tree(), { tweak: ({ centrals }) => { centrals[2].bytes.writeUInt32LE(0xffffffff, 20); } }), /needs ZIP64/],
    [writeZip(tree(), { tweak: ({ locals }) => { locals[0].bytes.writeUInt32LE(0x12345678, 0); } }), /no local header at its offset/],
    [Buffer.from('not a zip'), /too short/],
  ];
  for (const [bytes, pattern] of cases) assert.match(String(structureOf(t, bytes).problem), pattern);
  assert.match(zipStructure(path.join(os.tmpdir(), 'no-such-ssam-update.zip')).problem, /cannot be read/);
});

test('the real build A ZIP (signed 0.2.8, 139 entries, 14 symlinks) passes the structure check and the gate', { skip: !process.env.SSAM_REAL_MAC_UPDATE_ZIP && 'set SSAM_REAL_MAC_UPDATE_ZIP to the build A ZIP (C:\\t\\r5\\mac-028\\build-A\\ssam-agent-app-0.2.8-mac-arm64.zip)' }, () => {
  const answer = zipStructure(process.env.SSAM_REAL_MAC_UPDATE_ZIP);
  assert.equal(answer.problem, undefined);
  assert.equal(answer.entries.length, 139);
  const links = answer.entries.filter(e => e.type === 'l');
  assert.equal(links.length, 14);
  for (const l of links) assert.match(l.link, /^(A|Versions\/Current\/[A-Za-z ]+)$/);
  // The gate over the same entries, with unzip's own listing format (the names and modes the structure gives).
  const names = answer.entries.map(e => e.name);
  const modes = { d: 'drwxr-xr-x', '-': '-rw-r--r--', l: 'lrwxr-xr-x' };
  const listing = { entries: names.length, rows: answer.entries.map(e => ({ mode: modes[e.type], name: e.name })) };
  assert.equal(macZipProblem({ names, listing, structure: answer }), null);
});

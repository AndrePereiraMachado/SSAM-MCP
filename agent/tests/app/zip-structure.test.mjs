// Review M-R3-1 of agent/mac-028: the update gate and Squirrel.Mac (ditto, which may read the local headers in sequence) must see
// the same entries. core/zip-structure.mjs accepts only a ZIP whose every byte belongs to a listed entry, whose local headers
// repeat the central directory, and whose features it can check. The ZIPs here are written byte by byte; the review's probe
// (PROBE_ZIP below: the exact bytes made by C:\t\r5\mac-028\review\m1r3-cd-probe.py, a local Old.app entry the central
// directory does not list; base64 because *.zip is ignored by git) must be refused, and the real update ZIPs
// (SSAM_REAL_MAC_UPDATE_ZIP) must pass.
// Review R4 (M-R4-1, B-R4-1, B-R4-4): only the profile of the real ZIPs passes: extra fields 0x5455 and 0x7875 only, the same in
// the local header and the central record, flags 0, printable ASCII names. The review's R4 probes (fixtures/review-r4-probes.json,
// the exact bytes of C:\t\r5\mac-028\review\r4-probes\zips) are checked one by one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const R4_PROBES = JSON.parse(fs.readFileSync(new URL('./fixtures/review-r4-probes.json', import.meta.url), 'utf8')).probes;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const MODE = { d: 0o040755, '-': 0o100644, l: 0o120755 };

// One extra field: ID, size, data.
const field = (id, data) => { const head = Buffer.alloc(4); head.writeUInt16LE(id, 0); head.writeUInt16LE(data.length, 2); return Buffer.concat([head, data]); };
// The extra fields of the real update ZIPs: extended timestamp 0x5455 (5 bytes in the central record, 9 in the local header) and
// Unix uid/gid 0x7875 (11 bytes), 24 bytes in the central record and 28 in the local header.
const UX = field(0x7875, Buffer.from([1, 4, 0xf5, 1, 0, 0, 4, 0x14, 0, 0, 0]));
const UNIX_EXTRA = {
  central: Buffer.concat([field(0x5455, Buffer.from([3, 1, 2, 3, 4])), UX]),
  local: Buffer.concat([field(0x5455, Buffer.from([3, 1, 2, 3, 4, 1, 2, 3, 4])), UX]),
};

// entries: [{name, type, data, deflate, descriptor, signed, localName, flags, madeBy, extra, localExtra}] (extra defaults to the
// real ZIPs' fields; localExtra to extra when it is given, else to the real local fields); tweak(parts) may change the pieces
// (local records, central records) before they are joined.
function writeZip(entries, { tweak = null, comment = '', prefix = Buffer.alloc(0), trailer = Buffer.alloc(0) } = {}) {
  const locals = []; const centrals = []; let offset = prefix.length;
  for (const e of entries) {
    const plain = Buffer.from(e.data ?? '');
    const method = e.deflate ? 8 : 0;
    const body = e.deflate ? zlib.deflateRawSync(plain) : plain;
    const crc = crc32(plain);
    const flags = (e.flags ?? 0) | (e.descriptor ? 0x0008 : 0);
    const name = Buffer.from(e.name), localName = Buffer.from(e.localName ?? e.name);
    const extra = e.extra ?? UNIX_EXTRA.central, localExtra = e.localExtra ?? e.extra ?? UNIX_EXTRA.local;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14); local.writeUInt32LE(e.descriptor ? 0 : body.length, 18); local.writeUInt32LE(e.descriptor ? 0 : plain.length, 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (e.descriptor) {
      descriptor = Buffer.alloc(e.signed === false ? 12 : 16); let at = 0;
      if (e.signed !== false) { descriptor.writeUInt32LE(0x08074b50, 0); at = 4; }
      descriptor.writeUInt32LE(crc, at); descriptor.writeUInt32LE(body.length, at + 4); descriptor.writeUInt32LE(plain.length, at + 8);
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

// The gate over a structure's entries, with unzip's own listing format (the names and modes the structure gives).
function gateOf(answer) {
  const names = answer.entries.map(e => e.name);
  const modes = { d: 'drwxr-xr-x', '-': '-rw-r--r--', l: 'lrwxr-xr-x' };
  return macZipProblem({ names, listing: { entries: names.length, rows: answer.entries.map(e => ({ mode: modes[e.type], name: e.name })) }, structure: answer });
}

test('a well-formed ZIP is read whole: names, types and symlink targets (stored and deflated)', t => {
  const answer = structureOf(t, writeZip(tree()));
  assert.equal(answer.problem, undefined);
  assert.deepEqual(answer.entries.map(e => [e.type, e.name, e.link]), tree().map(e => [e.type ?? (e.name.endsWith('/') ? 'd' : '-'), e.name, e.type === 'l' ? e.data : null]));
  assert.equal(gateOf(answer), null);
  // Without extra fields, or with only one of the two, the same in both headers.
  assert.equal(structureOf(t, writeZip(tree().map(e => ({ ...e, extra: Buffer.alloc(0) })))).problem, undefined);
  assert.equal(structureOf(t, writeZip(tree().map(e => ({ ...e, extra: UX })))).problem, undefined);
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
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, flags: 0x0001 } : e)), /flags 0x1 \(a data descriptor, the UTF-8 flag, encryption/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, extra: Buffer.from([1, 0, 0, 0]) } : e)), /extra field 0x0001 \(only 0x5455 and 0x7875 are accepted\)/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, extra: Buffer.from([0x55, 0x54, 9, 0]) } : e)), /extra fields overrun/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, extra: Buffer.from([0x55, 0x54, 0]) } : e)), /extra fields are cut/],
    [writeZip(tree().map((e, i) => i === 2 ? { ...e, madeBy: 0x0014 } : e)), /was not made on Unix/],
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

test('review R4: only the real ZIPs\' profile passes (extra fields 0x5455/0x7875 alike in both headers, flags 0, ASCII names)', t => {
  const at2 = change => writeZip(tree().map((e, i) => i === 2 ? { ...e, ...change } : e));
  // M-R4-1: an Info-ZIP Unicode Path (0x7075) that renames the entry for readers that honour it, in either header.
  const unicodePath = field(0x7075, Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from(ROOT + '/Contents/Resources/app-update.yml')]));
  const extra = /^the (local header|central record) of the entry "SSAM Agent\.app\/Contents\/Info\.plist" has extra field 0x([0-9a-f]{4}) \(only 0x5455 and 0x7875 are accepted\)$/;
  const cases = [
    [at2({ localExtra: Buffer.concat([UNIX_EXTRA.local, unicodePath]) }), 'local header', '7075'],
    [at2({ extra: Buffer.concat([UNIX_EXTRA.central, unicodePath]), localExtra: UNIX_EXTRA.local }), 'central record', '7075'],
    [at2({ extra: Buffer.concat([UNIX_EXTRA.central, unicodePath]), localExtra: Buffer.concat([UNIX_EXTRA.local, unicodePath]) }), 'central record', '7075'],
    [at2({ extra: field(0x6375, Buffer.from([1, 0, 0, 0, 0, 0x41])) }), 'central record', '6375'],
    [at2({ localExtra: Buffer.concat([UNIX_EXTRA.local, field(0x0001, Buffer.alloc(16))]) }), 'local header', '0001'],
    [at2({ extra: field(0xcafe, Buffer.alloc(0)) }), 'central record', 'cafe'],
  ];
  for (const [bytes, where, id] of cases) {
    const m = extra.exec(String(structureOf(t, bytes).problem));
    assert.ok(m, String(structureOf(t, bytes).problem)); assert.equal(m[1], where); assert.equal(m[2], id);
  }
  // The allowed fields, but not the same ones in the same order in both headers.
  const swapped = Buffer.concat([UX, field(0x5455, Buffer.from([3, 1, 2, 3, 4, 1, 2, 3, 4]))]);
  for (const localExtra of [swapped, UX, Buffer.alloc(0), Buffer.concat([UNIX_EXTRA.local, UX])])
    assert.match(String(structureOf(t, at2({ localExtra })).problem), /Info\.plist" has other extra fields in its local header than in its central record/);
  // B-R4-1: any flag, the data descriptor (signed or not, even when it repeats the directory's CRC and sizes) and UTF-8 among them.
  for (const [change, shown] of [[{ descriptor: true }, '8'], [{ descriptor: true, signed: false }, '8'], [{ flags: 0x0800 }, '800'], [{ flags: 0x0002 }, '2'], [{ flags: 0x0040 }, '40'], [{ flags: 0x2000 }, '2000']])
    assert.match(String(structureOf(t, at2(change)).problem), new RegExp(`Info\\.plist" has flags 0x${shown} \\(`));
  // B-R4-4: names in printable ASCII only (UTF-8 with or without its flag, other bytes, control characters).
  const named = (name, more = {}) => writeZip([...tree(), { name: ROOT + '/Contents/Resources/' + name, data: 'x', ...more }]);
  assert.match(String(structureOf(t, named('caf\u00e9.txt')).problem), /Resources\/caf\\xc3\\xa9\.txt" has a name that is not printable ASCII/);
  assert.match(String(structureOf(t, named('caf\u00e9.txt', { flags: 0x0800 })).problem), /caf\\xc3\\xa9\.txt" has a name that is not printable ASCII/);
  assert.match(String(structureOf(t, named('A\u030a.txt')).problem), /not printable ASCII/);
  assert.match(String(structureOf(t, named('a\tb')).problem), /a\\x09b" has a name that is not printable ASCII/);
  assert.match(String(structureOf(t, named('a\x7fb')).problem), /not printable ASCII/);
  const latin1 = writeZip([...tree(), { name: ROOT + '/x', data: 'x' }], { tweak: ({ locals, centrals }) => {
    for (const part of [locals.at(-1).bytes, centrals.at(-1).bytes]) part[part.indexOf(Buffer.from(ROOT + '/x')) + ROOT.length + 1] = 0xe9;
  } });
  assert.match(String(structureOf(t, latin1).problem), /SSAM Agent\.app\/\\xe9" has a name that is not printable ASCII/);
});

test('the review R4 probes (exact bytes): the Unicode Path extras, the data descriptors, the UTF-8 name and the symlink bomb are refused', t => {
  const expected = {
    'p0-control.zip': null,
    'pA1-up-local-old.zip': /^the local header of the entry "SSAM Agent\.app\/Contents\/Resources\/x\.txt" has extra field 0x7075/,
    'pA2-up-local-infoplist.zip': /^the local header of the entry "SSAM Agent\.app\/Contents\/Resources\/x\.txt" has extra field 0x7075/,
    'pA3-up-both.zip': /^the central record of the entry "SSAM Agent\.app\/Contents\/Resources\/x\.txt" has extra field 0x7075/,
    'pB-stored-descriptor.zip': /blob\.bin" has flags 0x8 \(a data descriptor/,
    'pB2-stored-descriptor-unsigned-tail.zip': /blob\.bin" has flags 0x8 \(a data descriptor/,
    'pC-deflate-descriptor-slack.zip': /c\.txt" has flags 0x8 \(a data descriptor/,
    // B-R4-2 is not checked (zip-structure.mjs header): the slack after the deflate stream is inside the entry's sizes, which every
    // header repeats (flags 0, no descriptor).
    'pD-deflate-slack.zip': null,
    // A stored entry whose data happens to be a local record: inside the entry's sizes, as in pD.
    'pE-stored-fake-header.zip': null,
    'pF-utf8-noflag.zip': /caf\\xc3\\xa9\.txt" has a name that is not printable ASCII/,
    'pG-symlink-bomb.zip': /cannot be read|target that is too long/,
  };
  assert.deepEqual(Object.keys(R4_PROBES).sort(), Object.keys(expected).sort());
  assert.equal(R4_PROBES['pA2-up-local-infoplist.zip'].sha256, '08d09366132c783007c82ba2cecef2bc7c1690f426c3370b7dfadd5c7d3c5a2e');
  for (const [name, pattern] of Object.entries(expected)) {
    const bytes = Buffer.from(R4_PROBES[name].base64, 'base64');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), R4_PROBES[name].sha256, name);
    const answer = structureOf(t, bytes);
    if (pattern === null) { assert.equal(answer.problem, undefined, name); assert.equal(gateOf(answer), null, name); }
    else assert.match(String(answer.problem), pattern, name);
  }
});

const REAL = (process.env.SSAM_REAL_MAC_UPDATE_ZIP ?? '').split(path.delimiter).filter(Boolean);
test('the real update ZIPs (build A R4 0.2.8 staging: 139 entries; CI 0.2.5: 130; 14 symlinks each) pass the structure check and the gate', { skip: REAL.length === 0 && `set SSAM_REAL_MAC_UPDATE_ZIP to the real ZIPs, separated by "${path.delimiter}" (C:\\t\\r5\\mac-028\\build-A-r4\\ssam-agent-app-0.2.8-staging-mac-arm64.zip, C:\\t\\r4\\subida-r42\\mac\\ssam-agent-app-0.2.5-test-unsigned-mac-arm64.zip)` }, t => {
  for (const file of REAL) {
    const answer = zipStructure(file);
    assert.equal(answer.problem, undefined, file);
    t.diagnostic(`${file}: ${answer.entries.length} entries`);
    assert.ok([139, 130].includes(answer.entries.length), `${file}: ${answer.entries.length} entries`);
    const links = answer.entries.filter(e => e.type === 'l');
    assert.equal(links.length, 14, file);
    for (const l of links) assert.match(l.link, /^(A|Versions\/Current\/[A-Za-z ]+)$/);
    assert.equal(gateOf(answer), null, file);
  }
});

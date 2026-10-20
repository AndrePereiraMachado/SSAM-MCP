// scripts/zip.mjs: stored and deflated entries of a ZIP come back byte for byte, folders are skipped, and an entry that
// names a parent folder, a drive or a root is refused before anything is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { listZip, readEntry, extractZip } from '../scripts/zip.mjs';

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buffer => { let c = -1; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// A ZIP writer for the test only: entries [{name, data, deflate}], folders as names ending in '/'.
function makeZip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const stored = entry.deflate ? zlib.deflateRawSync(data) : data;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(stored.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored); centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test('stored and deflated entries, nested folders and an empty file come back as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-app-zip-'));
  try {
    const big = Buffer.from('x'.repeat(100000) + 'end');
    const zip = makeZip([{ name: 'agent/', data: null }, { name: 'agent/ssam-agent.mjs', data: Buffer.from('console.log(1)\n'), deflate: true }, { name: 'bin/o11/bridge/Anvil.Bridge.dll', data: big, deflate: true },
      { name: 'pack.json', data: Buffer.from('{}') }, { name: 'odc/empty.txt', data: Buffer.alloc(0), deflate: true }]);
    const file = path.join(dir, 'pack.zip');
    fs.writeFileSync(file, zip);
    const entries = listZip(zip);
    assert.deepEqual(entries.map(e => e.name), ['agent/', 'agent/ssam-agent.mjs', 'bin/o11/bridge/Anvil.Bridge.dll', 'pack.json', 'odc/empty.txt']);
    assert.equal(readEntry(zip, entries[2]).equals(big), true);
    const written = extractZip(file, path.join(dir, 'out'));
    assert.deepEqual(written, ['agent/ssam-agent.mjs', 'bin/o11/bridge/Anvil.Bridge.dll', 'pack.json', 'odc/empty.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'agent', 'ssam-agent.mjs'), 'utf8'), 'console.log(1)\n');
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'bin', 'o11', 'bridge', 'Anvil.Bridge.dll')).equals(big), true);
    assert.equal(fs.statSync(path.join(dir, 'out', 'odc', 'empty.txt')).size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an entry with .., a drive or a root, an unknown method, or no central directory is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-app-zip-'));
  try {
    for (const name of ['../escape.txt', 'agent/../../x', 'C:/x.txt', '/etc/x', 'agent//x']) {
      const file = path.join(dir, 'bad.zip');
      fs.writeFileSync(file, makeZip([{ name, data: Buffer.from('x') }]));
      assert.throws(() => extractZip(file, path.join(dir, 'out')), /refused/, name);
      assert.equal(fs.existsSync(path.join(dir, 'out')), false);
    }
    const bzip = makeZip([{ name: 'a.txt', data: Buffer.from('x'), method: 12 }]);
    const entries = listZip(bzip);
    assert.equal(entries[0].method, 12);
    assert.throws(() => readEntry(bzip, entries[0]), /compression method 12/);
    assert.throws(() => listZip(Buffer.from('not a zip at all, not a zip at all')), /end of central directory/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

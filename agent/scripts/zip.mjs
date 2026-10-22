// A small reader of the ZIP the pack script writes (scripts/agent-pack.ps1, .NET ZipArchive: stored or deflated
// entries, no encryption, no ZIP64), so scripts/build.mjs extracts ssam-agent.zip on any system without a tool.
//   extractZip(file, folder) -> [relative paths written]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD = 0x06054b50; const CENTRAL = 0x02014b50; const LOCAL = 0x04034b50;

export function listZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP file (no end of central directory)');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error('damaged central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressed, size, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.local) !== LOCAL) throw new Error('damaged local header: ' + entry.name);
  const nameLength = buffer.readUInt16LE(entry.local + 26);
  const extraLength = buffer.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`entry ${entry.name} uses compression method ${entry.method}, which this reader does not know`);
}

const safe = name => name.replace(/\\/g, '/').split('/').every(part => part !== '' && part !== '.' && part !== '..') && !/^[A-Za-z]:/.test(name) && !name.startsWith('/');

export function extractZip(file, folder) {
  const buffer = fs.readFileSync(file);
  const written = [];
  for (const entry of listZip(buffer)) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (!safe(name)) throw new Error('refused entry of the ZIP: ' + entry.name);
    const target = path.join(folder, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = readEntry(buffer, entry);
    if (data.length !== entry.size) throw new Error(`entry ${name}: ${data.length} bytes, expected ${entry.size}`);
    fs.writeFileSync(target, data);
    written.push(name);
  }
  return written;
}

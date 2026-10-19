// The tar.gz of the macOS agent pack (scripts/agent-pack.ps1 -Platform mac): written here, in Node, because the tar of
// Windows does not record Unix modes, and install.sh and agent/ssam-agent.sh must arrive executable (0755). The format is
// POSIX ustar (macOS bsdtar and GNU tar read it), entries sorted, owner 0:0 without names, one mtime for all.
//   node scripts/tar-gz.mjs write <folder> <out.tar.gz> [<mtime seconds>]
//   node scripts/tar-gz.mjs verify <out.tar.gz> <folder>    every file of the folder, same bytes and mode, nothing else
//   node scripts/tar-gz.mjs extract <out.tar.gz> <new folder>
//   node scripts/tar-gz.mjs list <out.tar.gz>               one JSON line per entry {name, type, mode, size, sha256}
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BLOCK = 512;
export const modeOf = name => (/\.sh$/.test(name) ? 0o755 : 0o644);
const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';

function header({ name, size, mode, mtime, type }) {
  const b = Buffer.alloc(BLOCK);
  let base = name; let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error('path too long for ustar: ' + name);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  b.write(base, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100, 8, 'latin1');
  b.write(octal(0, 8), 108, 8, 'latin1');
  b.write(octal(0, 8), 116, 8, 'latin1');
  b.write(octal(size, 12), 124, 12, 'latin1');
  b.write(octal(mtime, 12), 136, 12, 'latin1');
  b.fill(0x20, 148, 156);
  b.write(type, 156, 1, 'latin1');
  b.write('ustar\0', 257, 6, 'latin1');
  b.write('00', 263, 2, 'latin1');
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return b;
}

// [{name, full, dir}] of a folder, sorted, with '/' separators; folders before their files.
function walk(folder) {
  const out = [];
  const visit = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, item.name); const name = prefix ? prefix + '/' + item.name : item.name;
      if (item.isSymbolicLink()) throw new Error('links are not packed: ' + name);
      if (item.isDirectory()) { out.push({ name, full, dir: true }); visit(full, name); }
      else if (item.isFile()) out.push({ name, full, dir: false });
    }
  };
  visit(folder, '');
  return out;
}

export function writeTarGz(folder, out, mtime = Math.floor(Date.now() / 1000)) {
  const parts = [];
  for (const entry of walk(folder)) {
    if (entry.dir) { parts.push(header({ name: entry.name + '/', size: 0, mode: 0o755, mtime, type: '5' })); continue; }
    const data = fs.readFileSync(entry.full);
    parts.push(header({ name: entry.name, size: data.length, mode: modeOf(entry.name), mtime, type: '0' }), data);
    if (data.length % BLOCK) parts.push(Buffer.alloc(BLOCK - (data.length % BLOCK)));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zlib.gzipSync(Buffer.concat(parts), { level: 9 }));
}

// [{name, type: 'file'|'dir', mode, size, mtime, data}] of a tar.gz, every header checksum checked.
export function readTarGz(file) {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  const entries = [];
  for (let at = 0; at + BLOCK <= tar.length;) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every(byte => byte === 0)) break;
    const field = (start, length) => h.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const number = (start, length) => parseInt(field(start, length).trim() || '0', 8);
    let sum = 0; for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== number(148, 8)) throw new Error('bad tar header checksum at ' + at);
    if (field(257, 6) !== 'ustar') throw new Error('not a ustar entry at ' + at);
    const prefix = field(345, 155);
    const name = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = number(124, 12);
    const type = field(156, 1);
    const data = tar.subarray(at + BLOCK, at + BLOCK + size);
    entries.push({ name: name.replace(/\/$/, ''), type: type === '5' ? 'dir' : type === '0' || type === '' ? 'file' : 'other:' + type, mode: number(100, 8), size, mtime: number(136, 12), data: Buffer.from(data) });
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The archive holds exactly the folder: same names, bytes and modes; no link or other entry type.
export function verifyTarGz(file, folder) {
  const expected = new Map(walk(folder).map(e => [e.name, e]));
  const problems = [];
  const seen = new Set();
  for (const entry of readTarGz(file)) {
    seen.add(entry.name);
    const want = expected.get(entry.name);
    if (!want) { problems.push('extra entry ' + entry.name); continue; }
    if (want.dir !== (entry.type === 'dir')) { problems.push('wrong type ' + entry.name); continue; }
    if (entry.type === 'dir') { if (entry.mode !== 0o755) problems.push('mode ' + entry.mode.toString(8) + ' ' + entry.name); continue; }
    if (entry.type !== 'file') { problems.push('entry type ' + entry.type + ' ' + entry.name); continue; }
    if (entry.mode !== modeOf(entry.name)) problems.push('mode ' + entry.mode.toString(8) + ' ' + entry.name);
    if (sha(entry.data) !== sha(fs.readFileSync(want.full))) problems.push('bytes ' + entry.name);
  }
  for (const name of expected.keys()) if (!seen.has(name)) problems.push('missing ' + name);
  return problems;
}

export function extractTarGz(file, folder) {
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error('not empty: ' + folder);
  for (const entry of readTarGz(file)) {
    if (entry.name.split('/').some(part => part === '..' || part === '') || path.isAbsolute(entry.name)) throw new Error('unsafe entry ' + entry.name);
    const target = path.join(folder, ...entry.name.split('/'));
    if (entry.type === 'dir') fs.mkdirSync(target, { recursive: true });
    else if (entry.type === 'file') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, entry.data); }
    else throw new Error('unexpected entry type ' + entry.type + ' ' + entry.name);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, a, b, c] = process.argv.slice(2);
  try {
    if (command === 'write') writeTarGz(path.resolve(a), path.resolve(b), c ? Number(c) : undefined);
    else if (command === 'verify') { const problems = verifyTarGz(path.resolve(a), path.resolve(b)); if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('ok'); }
    else if (command === 'extract') extractTarGz(path.resolve(a), path.resolve(b));
    else if (command === 'list') for (const e of readTarGz(path.resolve(a))) console.log(JSON.stringify({ name: e.name, type: e.type, mode: e.mode.toString(8), size: e.size, sha256: e.type === 'file' ? sha(e.data) : null }));
    else { console.log('Usage: tar-gz.mjs write <folder> <out> [mtime] | verify <tar.gz> <folder> | extract <tar.gz> <folder> | list <tar.gz>'); process.exitCode = 1; }
  } catch (error) { console.log('Error: ' + error.message); process.exitCode = 1; }
}

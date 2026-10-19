// A prototype given as a .zip (docs/PROTOTIPO-NATIVO.md 1.2): read with the central directory and zlib.inflateRawSync (no
// dependency), checked entry by entry and extracted ONCE into <lane .local>/prototype/sources/<sha256 of the zip>/, then
// resolved exactly as a folder (the entry rules of resolveSource). The archive is untrusted content: an entry that would land
// outside the folder (zip-slip: '..', an absolute or drive path, a backslash trick, an alternate data stream), a link, an
// encrypted entry, a method other than stored/deflate, more than ARCHIVE_LIMITS.entries entries or more than the byte caps
// refuses the whole archive (nothing is extracted), with every bad entry named. A declared size the inflate does not match
// and a CRC that differs refuse too (a zip bomb or a damaged file is never half written).
//
//   readArchive(file)                      -> {ok, sha256, bytes, entries:[{name, method, size, compressed, crc, offset}], problems}
//   extractArchive(file, {sourcesDir})     -> {ok, root, dir, sha256, entries, reused} | {ok:false, problems}
//   archiveRoot(dir, entries)              the single top-level folder when every entry is inside it, else dir
//   isArchive(file)                        a .zip by name (the magic number is checked when read)
//   allowedSource(abs, {agentRoot})        hosted mode: the source must be under the agent's inbox/, odc/ or o11/
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { agentPath, agentJoin, AGENT_FOLDERS } from '../agent-paths.mjs';

export const ARCHIVE_LIMITS = Object.freeze({ entries: 2000, fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, archiveBytes: 64 * 1024 * 1024 });
export const ARCHIVE_MARKER = '.ssam-archive.json';

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
// The legacy code pages of a zip entry name without the UTF-8 flag (bit 11), for the bytes 0x80-0xFF: CP850 (the OEM code
// page of Windows in pt-BR and the rest of Western Europe: the Explorer and 7-Zip write it), CP437 (the zip specification's
// default, the OEM code page of en-US) and CP1252 (some tools write the ANSI code page).
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐'
  + '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
const CP1252 = new TextDecoder('windows-1252');
export const LEGACY_CODE_PAGES = Object.freeze(['cp850', 'cp437', 'cp1252']);

export const isArchive = file => typeof file === 'string' && /\.zip$/i.test(file);
const sha256 = data => createHash('sha256').update(data).digest('hex');

const isUtf8 = bytes => !bytes.toString('utf8').includes('�');
function legacyName(bytes, codePage) {
  if (codePage === 'cp1252') return CP1252.decode(bytes);
  const table = codePage === 'cp437' ? CP437 : CP850;
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
  return out;
}
// no UTF-8 flag: a name that is valid UTF-8 is UTF-8 (most tools write it so without the flag), else the legacy code page
// the archive was written in (chooseCodePage)
function decodeName(bytes, utf8, codePage = 'cp850') {
  if (utf8 || isUtf8(bytes)) return bytes.toString('utf8');
  return legacyName(bytes, codePage);
}

// The local files an .html page refers to (href, src), decoded and resolved against the page's folder.
function pageReferences(html, page) {
  const out = [];
  const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/') + 1) : '';
  for (const [, , a, b, c] of String(html).matchAll(/\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (a ?? b ?? c ?? '').trim().split(/[?#]/)[0];
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(raw)) continue;
    let text = raw; try { text = decodeURIComponent(raw); } catch { /* as written */ }
    out.push(path.posix.normalize(dir + text.replace(/^\.\//, '')));
  }
  return out;
}
// The code page of the names without the UTF-8 flag that are not UTF-8: the one under which the .html pages of the archive
// find the most files they refer to (a CP850 name read as CP437 turns "ação" into "aç╞o" and the page loses its stylesheet);
// CP850 when they tie. raw: [{bytes, utf8, entry?}] from the central directory; inflate(entry) -> Buffer.
function chooseCodePage(raw, inflate) {
  if (!raw.some(item => !item.utf8 && !isUtf8(item.bytes))) return 'cp850';
  const namesOf = codePage => raw.map(item => decodeName(item.bytes, item.utf8, codePage));
  const candidates = LEGACY_CODE_PAGES.map(codePage => ({ codePage, names: namesOf(codePage) }));
  if (candidates.every(c => JSON.stringify(c.names) === JSON.stringify(candidates[0].names))) return 'cp850';
  const pages = raw.map((item, index) => ({ item, index })).filter(({ item, index }) => item.entry && item.entry.size <= 4 * 1024 * 1024 && /\.html?$/i.test(candidates[0].names[index]));
  const texts = new Map();
  for (const { item, index } of pages) { try { texts.set(index, inflate(item.entry).toString('utf8')); } catch { /* a damaged page scores nothing */ } }
  let best = candidates[0], bestScore = -1;
  for (const candidate of candidates) {
    const known = new Set(candidate.names.map(name => name.replace(/\/+$/, '').normalize('NFC')));
    let score = 0;
    for (const [index, html] of texts) for (const reference of pageReferences(html, candidate.names[index])) if (known.has(reference.normalize('NFC'))) score++;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best.codePage;
}

// Why an entry name cannot be extracted inside the folder (null when it can): the zip-slip rules.
export function unsafeName(name) {
  if (!name || name.includes('\0')) return 'an empty name or a NUL character';
  if (name.includes('\\')) return 'a backslash in the name (a Windows path trick)';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'an absolute path';
  const parts = name.replace(/\/+$/, '').split('/');
  if (parts.some(part => part === '..')) return 'a ".." segment (outside the folder)';
  if (parts.some(part => part.includes(':'))) return 'a ":" in a segment (an alternate data stream or a drive)';
  if (parts.some(part => /[<>"|?*\x00-\x1f]/.test(part))) return 'a character Windows does not accept in a file name';
  if (parts.some(part => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part))) return 'a reserved Windows device name';
  if (parts.some(part => /[. ]$/.test(part) && part !== '.')) return 'a segment ending in a dot or a space (Windows renames it)';
  return null;
}

// The central directory of a zip, every entry checked; nothing is inflated here.
export function readArchive(file, { limits = ARCHIVE_LIMITS } = {}) {
  const problems = [];
  let data;
  try {
    const stat = fs.statSync(file);
    if (stat.size > limits.archiveBytes) return { ok: false, problems: [{ message: 'the archive has ' + stat.size + ' bytes; the limit is ' + limits.archiveBytes }] };
    data = fs.readFileSync(file);
  } catch (error) { return { ok: false, problems: [{ message: 'the archive ' + file + ' cannot be read: ' + error.message }] }; }
  const hash = sha256(data);
  if (data.length < 22 || data.readUInt32LE(0) !== LOCAL && data.readUInt32LE(0) !== EOCD) return { ok: false, sha256: hash, problems: [{ message: 'not a zip archive (no local file header at the start)' }] };
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at--) if (data.readUInt32LE(at) === EOCD) { end = at; break; }
  if (end < 0) return { ok: false, sha256: hash, problems: [{ message: 'not a zip archive (no end of central directory)' }] };
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return { ok: false, sha256: hash, problems: [{ message: 'a ZIP64 archive (more than 65535 entries or 4 GB): not a prototype' }] };
  if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0) return { ok: false, sha256: hash, problems: [{ message: 'a multi-part (spanned) archive' }] };
  if (count > limits.entries) return { ok: false, sha256: hash, problems: [{ message: 'the archive has ' + count + ' entries; the limit is ' + limits.entries }] };
  if (offset + size > end) return { ok: false, sha256: hash, problems: [{ message: 'the central directory lies outside the archive' }] };
  const entries = [];
  const seen = new Map();
  let total = 0;
  // first pass: the raw names, for the code page of the names written without the UTF-8 flag
  const raw = [];
  for (let i = 0, at = offset; i < count && at + 46 <= end && data.readUInt32LE(at) === CENTRAL; i++) {
    const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32);
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const size = data.readUInt32LE(at + 24);
    const plain = (flags & 0x1) === 0 && (method === 0 || method === 8) && size <= limits.fileBytes;
    raw.push({ bytes: data.subarray(at + 46, at + 46 + nameLength), utf8: (flags & 0x800) !== 0,
      entry: plain ? { name: '(page)', method, size, compressed: data.readUInt32LE(at + 20), crc: data.readUInt32LE(at + 16), offset: data.readUInt32LE(at + 42) } : null });
    at += 46 + nameLength + extraLength + commentLength;
  }
  const codePage = chooseCodePage(raw, entry => inflateEntry(data, entry));
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || data.readUInt32LE(at) !== CENTRAL) { problems.push({ message: 'the central directory is damaged at entry ' + (i + 1) }); break; }
    const madeBy = data.readUInt16LE(at + 4) >> 8;
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), uncompressed = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32);
    const external = data.readUInt32LE(at + 38), local = data.readUInt32LE(at + 42);
    const name = decodeName(data.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0, codePage);
    const mtime = entryTime(data.readUInt16LE(at + 12), data.readUInt16LE(at + 14), data.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    at += 46 + nameLength + extraLength + commentLength;
    // a Mac's resource forks are never extracted (they are no file of the prototype)
    if (macMetadata(name)) continue;
    const directory = name.endsWith('/');
    const mode = external >>> 16;
    // a link: a unix symlink (S_IFLNK) or a Windows reparse point (FILE_ATTRIBUTE_REPARSE_POINT)
    if ((madeBy === 3 && (mode & 0o170000) === 0o120000) || (external & 0x400) !== 0) { problems.push({ entry: name, message: 'the entry ' + name + ' is a link; links are never extracted' }); continue; }
    const unsafe = unsafeName(name);
    if (unsafe) { problems.push({ entry: name, message: 'the entry ' + name + ' has ' + unsafe + '; it would land outside the folder' }); continue; }
    const folded = name.replace(/\/+$/, '').toLowerCase();
    if (seen.has(folded) && !directory) { problems.push({ entry: name, message: 'the entry ' + name + ' repeats ' + seen.get(folded) + ' (Windows does not tell case apart)' }); continue; }
    seen.set(folded, name);
    if (directory) { entries.push({ name, directory: true }); continue; }
    if (flags & 0x1) { problems.push({ entry: name, message: 'the entry ' + name + ' is encrypted' }); continue; }
    if (method !== 0 && method !== 8) { problems.push({ entry: name, message: 'the entry ' + name + ' uses compression method ' + method + ' (only stored and deflate)' }); continue; }
    if (uncompressed === 0xffffffff || compressed === 0xffffffff) { problems.push({ entry: name, message: 'the entry ' + name + ' is a ZIP64 entry' }); continue; }
    if (uncompressed > limits.fileBytes) { problems.push({ entry: name, message: 'the entry ' + name + ' has ' + uncompressed + ' bytes; the limit per file is ' + limits.fileBytes }); continue; }
    total += uncompressed;
    entries.push({ name, method, size: uncompressed, compressed, crc, offset: local, mtime });
  }
  if (total > limits.totalBytes) problems.push({ message: 'the archive expands to ' + total + ' bytes; the limit is ' + limits.totalBytes });
  return { ok: problems.length === 0, sha256: hash, bytes: data.length, entries, problems, data, codePage };
}

// The modification time of an entry: the UTC extended timestamp (extra field 0x5455) when present, else the DOS date and time
// read as UTC (the archive carries no zone; reading it as UTC keeps the capture clock the same on every machine).
function entryTime(time, date, extra) {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at), size = extra.readUInt16LE(at + 2);
    if (id === 0x5455 && size >= 5 && (extra[at + 4] & 1)) return new Date(extra.readUInt32LE(at + 5) * 1000);
    at += 4 + size;
  }
  const year = 1980 + (date >> 9), month = ((date >> 5) & 15) - 1, day = date & 31;
  return new Date(Date.UTC(year, Math.max(0, month), Math.max(1, day), time >> 11, (time >> 5) & 63, (time & 31) * 2));
}

// The bytes of one entry, checked against its declared size and CRC.
function inflateEntry(data, entry) {
  const at = entry.offset;
  if (at + 30 > data.length || data.readUInt32LE(at) !== LOCAL) throw new Error('the local header of ' + entry.name + ' is damaged');
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
  const raw = data.subarray(start, start + entry.compressed);
  if (raw.length !== entry.compressed) throw new Error('the data of ' + entry.name + ' is truncated');
  let out;
  if (entry.method === 0) out = Buffer.from(raw);
  else {
    try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size + 1) }); }
    catch (error) { throw new Error('the entry ' + entry.name + ' does not inflate to its declared ' + entry.size + ' bytes (' + error.message + ')'); }
  }
  if (out.length !== entry.size) throw new Error('the entry ' + entry.name + ' inflates to ' + out.length + ' bytes, not the declared ' + entry.size);
  if (typeof zlib.crc32 === 'function' && (zlib.crc32(out) >>> 0) !== (entry.crc >>> 0)) throw new Error('the CRC of ' + entry.name + ' does not match (a damaged archive)');
  return out;
}

// The resource forks a Mac writes into a zip (__MACOSX/, ._<name>, .DS_Store): never part of the prototype.
export const macMetadata = name => /(^|\/)__MACOSX(\/|$)/.test(name) || /(^|\/)\._[^/]*$/.test(name) || /(^|\/)\.DS_Store$/.test(name);
// The folder the prototype is in: the single top-level folder when every entry is inside it (the usual "zip of a folder"),
// the Mac's __MACOSX/ and ._* entries left out of the count.
export function archiveRoot(dir, entries) {
  entries = entries.filter(entry => !macMetadata(entry.name));
  const files = entries.filter(entry => !entry.directory);
  const tops = new Set(entries.map(entry => entry.name.split('/')[0]));
  if (tops.size === 1 && files.length && files.every(entry => entry.name.includes('/'))) return path.join(dir, [...tops][0]);
  return dir;
}

// Extracts once into <sourcesDir>/<sha256>: an extraction already there (its marker names the same hash and entries) is
// reused; a new one is written in a temporary sibling and renamed into place, so a half-written folder is never read.
export function extractArchive(file, { sourcesDir, limits = ARCHIVE_LIMITS } = {}) {
  const read = readArchive(file, { limits });
  if (!read.ok) return { ok: false, sha256: read.sha256 ?? null, problems: read.problems };
  const dir = path.join(sourcesDir, read.sha256);
  const marker = path.join(dir, ARCHIVE_MARKER);
  const names = read.entries.map(entry => entry.name);
  try {
    const known = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (known?.sha256 === read.sha256 && JSON.stringify(known.entries) === JSON.stringify(names)) return { ok: true, dir, root: archiveRoot(dir, read.entries), sha256: read.sha256, entries: names, reused: true };
  } catch { /* not extracted yet */ }
  const temp = dir + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8);
  try {
    fs.mkdirSync(temp, { recursive: true });
    const base = path.resolve(temp);
    for (const entry of read.entries) {
      const target = path.resolve(base, ...entry.name.replace(/\/+$/, '').split('/'));
      // the last guard of zip-slip: the resolved path is inside the folder whatever the name said
      if (target !== base && !target.startsWith(base + path.sep)) throw new Error('the entry ' + entry.name + ' resolves outside the folder');
      if (entry.directory) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, inflateEntry(read.data, entry), { flag: 'wx' });
      // the entry's own time: the capture clock (the newest mtime of the files read) is the archive's, not the extraction's
      if (entry.mtime && Number.isFinite(entry.mtime.getTime())) fs.utimesSync(target, entry.mtime, entry.mtime);
    }
    fs.writeFileSync(path.join(temp, ARCHIVE_MARKER), JSON.stringify({ sha256: read.sha256, archive: path.resolve(file), entries: names }));
    try { fs.renameSync(temp, dir); }
    catch (error) {
      // another capture extracted the same archive meanwhile: its folder stands; a folder of an older release with other
      // names (the CP437 names before 2026-10-13) is replaced
      if (!fs.existsSync(marker)) throw error;
      let same = false;
      try { same = JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8')).entries) === JSON.stringify(names); } catch { same = false; }
      if (same) fs.rmSync(temp, { recursive: true, force: true });
      else { fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(temp, dir); }
    }
  } catch (error) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, sha256: read.sha256, problems: [{ message: String(error.message ?? error) }] };
  }
  return { ok: true, dir, root: archiveRoot(dir, read.entries), sha256: read.sha256, entries: names, reused: false };
}

// The .html pages under a folder (relative paths with '/'), the shallowest first then by name, at most `depth` folders down;
// links (junctions), dot folders, node_modules and a Mac's metadata are never walked.
export function htmlPages(root, { depth = 4, limit = 400 } = {}) {
  const out = [];
  const walk = (dir, prefix, level) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= limit || item.isSymbolicLink()) continue;
      const name = prefix + item.name;
      if (macMetadata(name)) continue;
      if (item.isDirectory()) { if (level < depth && !item.name.startsWith('.') && item.name !== 'node_modules') walk(path.join(dir, item.name), name + '/', level + 1); }
      else if (item.isFile() && /\.html?$/i.test(item.name)) out.push(name);
    }
  };
  walk(root, '', 0);
  return out.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}
// The one .zip of a folder that has no .html page anywhere (a zip inside the zip, a folder that only holds the zip): the
// prototype is in it. null when there is a page, or none or several zips (within two folders down).
export function innerArchive(root) {
  if (htmlPages(root).length) return null;
  const zips = [];
  const walk = (dir, level) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.isSymbolicLink() || macMetadata(item.name)) continue;
      if (item.isDirectory() && level < 2 && !item.name.startsWith('.')) walk(path.join(dir, item.name), level + 1);
      else if (item.isFile() && isArchive(item.name)) zips.push(path.join(dir, item.name));
    }
  };
  walk(root, 0);
  return zips.length === 1 ? zips[0] : null;
}

// The archive hash of a file (captureCurrent checks it: a zip changed in place is captured again).
export function archiveSha256(file) { try { return sha256(fs.readFileSync(file)); } catch { return null; } }

// Hosted mode (the server answers for a customer): a source is read only from the agent's own folders (inbox/, odc/, o11/
// of its root); 'agent:inbox/x.zip' names a file there. -> {ok, path} | {ok:false, message, fix}
export function allowedSource(source, { agentRoot = null } = {}) {
  if (!agentRoot) return { ok: true, path: source };
  let abs = source;
  const reference = /^agent:(.+)$/i.exec(String(source ?? ''));
  if (reference) abs = agentJoin(agentRoot, ...reference[1].split('/'));
  if (agentPath(abs, { agentRoot })) return { ok: true, path: abs };
  return { ok: false, message: 'In the hosted SSAM the prototype is read only from the folders of the agent (' + AGENT_FOLDERS.map(f => f + '/').join(', ') + ' of ' + agentRoot + '); ' + source + ' is outside them.',
    fix: 'copy the prototype folder or its .zip into ' + agentJoin(agentRoot, 'inbox') + ' and give data.source as agent:inbox/<name>' };
}

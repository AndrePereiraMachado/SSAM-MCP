// Review M-R3-1 of agent/mac-028: the ZIP a Mac update is checked with and the ZIP Squirrel.Mac unpacks must be the same entries.
// The gate (update-verify.mjs macZipProblem, through `unzip -Z1`/`-Z`/`-p`) reads the central directory; Squirrel.Mac unpacks
// with `ditto -x -k`, which may read the local headers in sequence. A ZIP whose data area holds local entries the central
// directory does not list (a genuine older Old.app next to a fake SSAM Agent.app), or local names other than the listed ones,
// would show one app to the gate and another to Squirrel. zipStructure reads the file itself, without extracting anything, and
// accepts only a ZIP whose every byte is accounted for:
//   - one end-of-central-directory record, exactly the last 22 bytes (no comment, one disk, no ZIP64);
//   - the central directory right before it, exactly its declared size and entry count;
//   - the entries back to back from byte 0: each local header at the offset the directory gives, with the same name bytes,
//     flags, method, CRC and sizes, then its data (the directory's compressed size), and the next entry right after;
//     the directory starts where the last entry ends;
//   - only the profile the real update ZIPs have (electron-builder 0.2.5 from CI and 0.2.8 build A, review R4): flags 0 (no
//     data descriptor, no UTF-8 flag, no encryption), methods stored/deflate, made on Unix (the mode is in the external
//     attributes), printable ASCII names, and extra fields only 0x5455 (extended timestamp) and 0x7875 (Unix uid/gid), the
//     same IDs in the same order in the local header and the central record, each list whole.
// Review R4 (M-R4-1, B-R4-1, B-R4-4): an extra field such as the Info-ZIP Unicode Path (0x7075) renames an entry for readers
// that honour it (libarchive does, per the review; ditto is not proven either way) while unzip shows the plain name; a data
// descriptor (flag 3) lets local sizes be 0 so a sequential reader looks for the end of the data itself; a non-ASCII name may
// be decoded differently by each reader (the review saw libarchive read it as CP437). None of them is in the real ZIPs, so all
// fail closed.
// Not checked (B-R4-2, optional in the review): that a deflate stream ends exactly at the compressed size. With flags 0 there
// is no data descriptor and the local sizes equal the directory's, so a reader that follows the sizes skips any slack; checking
// it means inflating the whole update in the main process.
// Anything else fails closed. Answers {entries: [{name, type ('d' | '-' | 'l'), link}]} (link: a symlink's target) or {problem}.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
const EXTRAS = new Set([0x5455, 0x7875]);
const MAX_DIRECTORY = 32 << 20, MAX_LINK = 1024;
const TYPES = { 0o040000: 'd', 0o100000: '-', 0o120000: 'l' };

// The IDs of a whole extra field list made only of allowed fields, or {problem}.
function extraIds(buffer, start, length, where) {
  const ids = []; let at = start; const end = start + length;
  while (at < end) {
    if (at + 4 > end) return { problem: `the ${where} extra fields are cut` };
    const id = buffer.readUInt16LE(at), size = buffer.readUInt16LE(at + 2);
    if (!EXTRAS.has(id)) return { problem: `the ${where} has extra field 0x${id.toString(16).padStart(4, '0')} (only 0x5455 and 0x7875 are accepted)` };
    ids.push(id);
    at += 4 + size;
  }
  return at === end ? { ids } : { problem: `the ${where} extra fields overrun` };
}

const ASCII_NAME = /^[\x20-\x7e]+$/;
// A name read byte by byte (latin1), for messages: at most 120 characters, other bytes as \xNN.
const shown = name => name.slice(0, 120).replace(/[^\x20-\x7e]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));

export function zipStructure(file, { open = fs.openSync, read = fs.readSync, close = fs.closeSync, stat = fs.fstatSync } = {}) {
  let fd = null;
  try {
    fd = open(file, 'r');
    const size = stat(fd).size;
    const bytes = (position, length) => {
      const buffer = Buffer.alloc(length);
      let got = 0;
      while (got < length) { const n = read(fd, buffer, got, length - got, position + got); if (n <= 0) break; got += n; }
      if (got !== length) throw new Error(`the ZIP ends at ${position + got}, inside a record that needs ${length} bytes from ${position}`);
      return buffer;
    };
    if (size < 22) return { problem: 'the file is too short to be a ZIP' };
    const end = bytes(size - 22, 22);
    if (end.readUInt32LE(0) !== END) return { problem: 'the ZIP does not end with its end-of-central-directory record (a comment or bytes after it)' };
    const [disk, cdDisk, onDisk, count, cdSize, cdOffset, comment] = [end.readUInt16LE(4), end.readUInt16LE(6), end.readUInt16LE(8), end.readUInt16LE(10), end.readUInt32LE(12), end.readUInt32LE(16), end.readUInt16LE(20)];
    if (disk || cdDisk || onDisk !== count) return { problem: 'the ZIP spans several disks' };
    if (comment) return { problem: 'the ZIP has a comment' };
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { problem: 'the ZIP is a ZIP64 archive' };
    if (cdOffset + cdSize !== size - 22) return { problem: 'the central directory does not end where the end record starts (bytes between them)' };
    if (cdSize > MAX_DIRECTORY) return { problem: 'the central directory is too large' };
    const directory = bytes(cdOffset, cdSize);
    const entries = []; let at = 0; let expected = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > cdSize || directory.readUInt32LE(at) !== CENTRAL) return { problem: `central directory record ${index + 1} is not where it should be` };
      const madeBy = directory.readUInt16LE(at + 4), flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16), compressed = directory.readUInt32LE(at + 20), plain = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
      const startDisk = directory.readUInt16LE(at + 34), external = directory.readUInt32LE(at + 38), offset = directory.readUInt32LE(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > cdSize) return { problem: `central directory record ${index + 1} overruns the directory` };
      const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
      const name = nameBytes.toString('latin1');
      const label = `the entry "${shown(name)}"`;
      if (!ASCII_NAME.test(name)) return { problem: `${label} has a name that is not printable ASCII (byte values shown as \\xNN)` };
      if (compressed === 0xffffffff || plain === 0xffffffff || offset === 0xffffffff || startDisk) return { problem: `${label} needs ZIP64` };
      const extra = extraIds(directory, at + 46 + nameLength, extraLength, `central record of ${label}`);
      if (extra.problem) return { problem: extra.problem };
      if (commentLength) return { problem: `${label} has a comment` };
      if (flags !== 0) return { problem: `${label} has flags 0x${flags.toString(16)} (a data descriptor, the UTF-8 flag, encryption or another feature the real update ZIPs do not use)` };
      if (method !== 0 && method !== 8) return { problem: `${label} uses compression method ${method}` };
      if (method === 0 && compressed !== plain) return { problem: `${label} is stored with two sizes` };
      if (madeBy >> 8 !== 3) return { problem: `${label} was not made on Unix (no mode to check)` };
      const type = TYPES[(external >>> 16) & 0o170000];
      if (!type) return { problem: `${label} is not a file, a folder or a symlink` };
      if ((type === 'd') !== name.endsWith('/')) return { problem: `${label} has a folder name and a file mode, or the reverse` };
      if (offset !== expected) return { problem: offset > expected ? `the ${offset - expected} bytes before ${label} belong to no listed entry` : `${label} overlaps the entry before it` };
      // The local header: the same entry, at that offset.
      const local = bytes(offset, 30);
      if (local.readUInt32LE(0) !== LOCAL) return { problem: `${label} has no local header at its offset` };
      const localFlags = local.readUInt16LE(6), localMethod = local.readUInt16LE(8), localCrc = local.readUInt32LE(14), localCompressed = local.readUInt32LE(18), localPlain = local.readUInt32LE(22);
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
      if (localFlags !== flags || localMethod !== method) return { problem: `${label} has other flags or method in its local header` };
      const localNameAndExtra = bytes(offset + 30, localNameLength + localExtraLength);
      if (!localNameAndExtra.subarray(0, localNameLength).equals(nameBytes)) return { problem: `${label} has another name in its local header ("${shown(localNameAndExtra.subarray(0, localNameLength).toString('latin1'))}")` };
      const localExtra = extraIds(localNameAndExtra, localNameLength, localExtraLength, `local header of ${label}`);
      if (localExtra.problem) return { problem: localExtra.problem };
      if (localExtra.ids.join() !== extra.ids.join()) return { problem: `${label} has other extra fields in its local header than in its central record` };
      if (localCrc !== crc || localCompressed !== compressed || localPlain !== plain) return { problem: `${label} has another CRC or size in its local header` };
      const dataStart = offset + 30 + localNameLength + localExtraLength;
      const next = dataStart + compressed;
      if (next > cdOffset) return { problem: `${label} runs into the central directory` };
      let link = null;
      if (type === 'l') {
        if (compressed > MAX_LINK * 4 || plain > MAX_LINK) return { problem: `${label} is a symlink with a target that is too long` };
        const data = bytes(dataStart, compressed);
        link = (method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_LINK }) : data).toString('utf8');
      }
      entries.push({ name, type, link });
      expected = next;
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== cdSize) return { problem: 'the central directory has bytes after its last record' };
    if (expected !== cdOffset) return { problem: `the ZIP has ${cdOffset - expected} bytes between its last listed entry and the central directory that no listed entry covers` };
    return { entries };
  } catch (error) {
    return { problem: 'the ZIP cannot be read: ' + String(error?.message ?? error).split('\n')[0].slice(0, 200) };
  } finally {
    if (fd !== null) try { close(fd); } catch { /* already closed */ }
  }
}

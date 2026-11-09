// Review M-R3-1 of agent/mac-028: the ZIP a Mac update is checked with and the ZIP Squirrel.Mac unpacks must be the same entries.
// The gate (update-verify.mjs macZipProblem, through `unzip -Z1`/`-Z`/`-p`) reads the central directory; Squirrel.Mac unpacks
// with `ditto -x -k`, which may read the local headers in sequence. A ZIP whose data area holds local entries the central
// directory does not list (a genuine older Old.app next to a fake SSAM Agent.app), or local names other than the listed ones,
// would show one app to the gate and another to Squirrel. zipStructure reads the file itself, without extracting anything, and
// accepts only a ZIP whose every byte is accounted for:
//   - one end-of-central-directory record, exactly the last 22 bytes (no comment, one disk, no ZIP64);
//   - the central directory right before it, exactly its declared size and entry count;
//   - the entries back to back from byte 0: each local header at the offset the directory gives, with the same name bytes,
//     flags, method and (unless a data descriptor follows) CRC and sizes, then its data (the directory's compressed size),
//     then the data descriptor its flags announce (12 or 16 bytes, the same CRC and sizes), and the next entry right after;
//     the directory starts where the last entry ends;
//   - only what can be checked: methods stored/deflate, flags 3 (descriptor) and 11 (UTF-8) only (no encryption), no ZIP64
//     field or extra, made on Unix (the mode is in the external attributes), each extra field list whole.
// Anything else fails closed. Answers {entries: [{name, type ('d' | '-' | 'l'), link}]} (link: a symlink's target) or {problem}.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50, DESCRIPTOR = 0x08074b50;
const MAX_DIRECTORY = 32 << 20, MAX_LINK = 1024;
const TYPES = { 0o040000: 'd', 0o100000: '-', 0o120000: 'l' };

function extrasProblem(buffer, start, length, where) {
  let at = start; const end = start + length;
  while (at < end) {
    if (at + 4 > end) return `the ${where} extra fields are cut`;
    const id = buffer.readUInt16LE(at), size = buffer.readUInt16LE(at + 2);
    if (id === 0x0001) return `the ${where} has a ZIP64 extra field`;
    at += 4 + size;
  }
  return at === end ? null : `the ${where} extra fields overrun`;
}

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
      const name = nameBytes.toString('utf8');
      const label = `the entry "${name.slice(0, 120)}"`;
      if (!Buffer.from(name, 'utf8').equals(nameBytes)) return { problem: `${label} is not valid UTF-8` };
      if (compressed === 0xffffffff || plain === 0xffffffff || offset === 0xffffffff || startDisk) return { problem: `${label} needs ZIP64` };
      const extra = extrasProblem(directory, at + 46 + nameLength, extraLength, `central record of ${label}`);
      if (extra) return { problem: extra };
      if (commentLength) return { problem: `${label} has a comment` };
      if (flags & ~(0x0008 | 0x0800)) return { problem: `${label} has flags 0x${flags.toString(16)} (encryption or another feature this check cannot verify)` };
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
      if (!localNameAndExtra.subarray(0, localNameLength).equals(nameBytes)) return { problem: `${label} has another name in its local header ("${localNameAndExtra.subarray(0, localNameLength).toString('utf8').slice(0, 120)}")` };
      const localExtra = extrasProblem(localNameAndExtra, localNameLength, localExtraLength, `local header of ${label}`);
      if (localExtra) return { problem: localExtra };
      const descriptor = Boolean(flags & 0x0008);
      if (descriptor ? [localCrc, localCompressed, localPlain].some((v, i) => v !== 0 && v !== [crc, compressed, plain][i]) : localCrc !== crc || localCompressed !== compressed || localPlain !== plain)
        return { problem: `${label} has another CRC or size in its local header` };
      const dataStart = offset + 30 + localNameLength + localExtraLength;
      let next = dataStart + compressed;
      if (descriptor) {
        if (next + 12 > cdOffset) return { problem: `${label} has no room for its data descriptor` };
        const head = bytes(next, Math.min(16, cdOffset - next));
        const signed = head.length >= 16 && head.readUInt32LE(0) === DESCRIPTOR;
        const base = signed ? 4 : 0;
        if (head.readUInt32LE(base) !== crc || head.readUInt32LE(base + 4) !== compressed || head.readUInt32LE(base + 8) !== plain) return { problem: `${label} has a data descriptor that does not match its directory record` };
        next += signed ? 16 : 12;
      }
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

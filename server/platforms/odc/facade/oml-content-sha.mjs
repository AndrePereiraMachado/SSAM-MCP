// The content identity of an OML capture (contract I1 of the atritos 3 package, C15). The ODC Studio writes Studio state
// into the textual header of every save: two captures of a module nobody changed differ in two header fields and nowhere
// else (2026-10-06, the friend's captures BA9045AE and DDC1600C, 2,904,197 bytes each: the node list after
// "/NodesShownInESpaceTree." and a 28-character base64 field, 20 bytes). Every cache keyed by the raw sha256 of the file
// (the module index of ssam_map, the delivery cache) then missed for an unchanged module.
//
//   contentSha256(fileOrBytes)          {sha256, rawSha256, rule}. Rule 'oml-content-v1': the sha256 of the bytes with the
//                                       volatile header fields masked (below). A header that is not the expected one: rule 'raw'
//                                       and sha256 = rawSha256 (never throws for a format). Memo by (path, size, mtime).
//   canonicalCapture({file, module, dir}) the capture that answers READS of this content: the first capture registered in
//                                       dir with the same content, while it is still intact (same size and mtime as when it
//                                       was registered); else this one, registered now. {file, rawSha256, contentSha256,
//                                       reused}. A delivery never uses it as a base: the new capture stays the base, the
//                                       content only identifies it.
//
// Rule oml-content-v1 (measured on the 34 captures of 2026-10-06): the file starts with "OML", a 32-bit little-endian
// length N (bytes 3-6) and N bytes of header text, records separated by '|'; the binary model follows. The text is UTF-8:
// the Studio writes the module's description there (the battery of 2026-10-08: 29 of the friend's 86 captures, "Aplicação"
// in CooperadoExames, fell to the raw rule while the bytes were read as ASCII); a control byte or invalid UTF-8 is not a
// header. Each
// volatile field is found by its place in the records, never by a fixed offset:
//   - the record holding "/NodesShownInESpaceTree.": everything after that marker to the end of the record (the nodes the
//     Studio's eSpace tree shows, keys separated by '.'); it becomes one '0', whatever its length; the record may be absent;
//   - record 15: exactly 28 base64 characters ending in '=' (a 20-byte value); its bytes become '0'.
// The length N follows from the header text, so it is left out of the content hash (a longer node list changes it).
// Any other shape (a length past the end, a header byte that is not printable, fewer records, record 15 not that field,
// a node list with other characters) is the rule 'raw'.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CONTENT_RULE = 'oml-content-v1';
const NODES = '/NodesShownInESpaceTree.';
const STATE_RECORD = 15;
const STATE_FIELD = /^[A-Za-z0-9+/]{27}=$/;
const NODE_LIST = /^[A-Za-z0-9+/_.=-]*$/;
const HEADER_AT = 7;
const PIPE = 0x7c;
const printable = b => b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const isUtf8 = bytes => { try { utf8.decode(bytes); return true; } catch { return false; } };

// The volatile fields of an OML capture: [{start, end, with}] (bytes [start, end) are hashed as `with`), sorted, or null
// when the header is not the expected one. The length field (bytes 3-6) is always one of them, replaced by nothing.
export function volatileFields(input) {
  if (!input) return null;
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < HEADER_AT + 1 || bytes[0] !== 0x4f || bytes[1] !== 0x4d || bytes[2] !== 0x4c) return null; // "OML"
  const end = HEADER_AT + bytes.readUInt32LE(3);
  if (end > bytes.length) return null;
  for (let i = HEADER_AT; i < end; i++) if (!printable(bytes[i])) return null;
  if (!isUtf8(bytes.subarray(HEADER_AT, end))) return null;
  const records = [];
  let start = HEADER_AT;
  for (let i = HEADER_AT; i <= end; i++) if (i === end || bytes[i] === PIPE) { records.push([start, i]); start = i + 1; }
  if (records.length <= STATE_RECORD) return null;
  const text = ([a, b]) => bytes.toString('latin1', a, b);
  const state = records[STATE_RECORD];
  if (!STATE_FIELD.test(text(state))) return null;
  const fields = [{ start: 3, end: HEADER_AT, with: Buffer.alloc(0) }, { start: state[0], end: state[1], with: Buffer.alloc(state[1] - state[0], '0') }];
  for (const record of records) {
    const value = text(record);
    const at = value.indexOf(NODES);
    if (at < 0) continue;
    if (!NODE_LIST.test(value.slice(at + NODES.length))) return null;
    fields.push({ start: record[0] + at + NODES.length, end: record[1], with: Buffer.from('0') });
  }
  return fields.sort((a, b) => a.start - b.start);
}
// The volatile [start, end) byte ranges, or null (see volatileFields).
export const volatileRanges = input => volatileFields(input)?.map(f => [f.start, f.end]) ?? null;

function hashBytes(bytes) {
  const raw = createHash('sha256').update(bytes).digest('hex');
  const fields = volatileFields(bytes);
  if (!fields) return { sha256: raw, rawSha256: raw, rule: 'raw' };
  const content = createHash('sha256');
  let at = 0;
  for (const field of fields) {
    if (field.start > at) content.update(bytes.subarray(at, field.start));
    content.update(field.with);
    at = field.end;
  }
  if (at < bytes.length) content.update(bytes.subarray(at));
  return { sha256: content.digest('hex'), rawSha256: raw, rule: CONTENT_RULE };
}
const memo = new Map(); // resolved path -> {size, mtimeMs, value}
const MEMO_MAX = 256;
export function contentSha256(fileOrBytes) {
  if (typeof fileOrBytes !== 'string') return hashBytes(Buffer.isBuffer(fileOrBytes) ? fileOrBytes : Buffer.from(fileOrBytes));
  const file = path.resolve(fileOrBytes);
  const stat = fs.statSync(file);
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const hit = memo.get(key);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.value;
  const value = hashBytes(fs.readFileSync(file));
  memo.delete(key);
  memo.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return value;
}

const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const sameName = (a, b) => a == null || b == null || String(a).toLowerCase() === String(b).toLowerCase();
const REGISTRY_SCHEMA = 'ssam-canonical-capture/1';

// dir: the folder of the registry (one <contentSha256>.json per content). Without dir nothing is registered and the
// capture answers for itself.
export function canonicalCapture({ file, module = null, dir } = {}) {
  const own = contentSha256(file);
  const self = { file: path.resolve(file), rawSha256: own.rawSha256, contentSha256: own.sha256, reused: false, rule: own.rule };
  if (own.rule !== CONTENT_RULE || !dir) return self;
  const entryFile = path.join(dir, own.sha256 + '.json');
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(entryFile, 'utf8')); } catch { entry = null; }
  if (entry?.schema === REGISTRY_SCHEMA && typeof entry.file === 'string' && entry.contentSha256 === own.sha256 && sameName(entry.module, module)) {
    if (samePath(entry.file, file)) return self;
    try {
      const stat = fs.statSync(entry.file);
      if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) return { ...self, file: path.resolve(entry.file), rawSha256: entry.rawSha256, reused: true, capturedFile: self.file };
    } catch { /* the canonical capture is gone: this one takes its place */ }
  }
  try {
    const stat = fs.statSync(file);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = entryFile + '.' + process.pid + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ schema: REGISTRY_SCHEMA, contentSha256: own.sha256, rule: own.rule, rawSha256: own.rawSha256,
      file: self.file, size: stat.size, mtimeMs: stat.mtimeMs, module: module ?? null, registeredAt: new Date().toISOString() }));
    try { fs.renameSync(temporary, entryFile); } finally { try { fs.unlinkSync(temporary); } catch { /* moved */ } }
  } catch { /* a registry that cannot be written only loses the reuse */ }
  return self;
}

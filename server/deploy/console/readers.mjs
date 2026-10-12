// Incremental readers of the server's files (DESIGN 3.2). server.log with its rotations (rotate-logs.sh renames it to
// server.log.<stamp> and gzips that file 2 s later into a NEW inode), the daily files <prefix>-YYYYMMDD.jsonl (+ .jsonl.gz)
// per UTC day (audit-*, and quality-* of DESIGN-QUALIDADE 4.1 with lines capped at 4096 bytes), and
// access-alerts.jsonl. Positions are byte offsets at a line boundary: a checkpoint taken between two awaits matches the
// records already applied, so a restart re-reads only a partial last line and never applies a complete line twice.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { endOfUtcKey, utcKey } from './tz.mjs';

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;
const YIELD_EVERY = 2000;
const EMPTY = Buffer.alloc(0);
const ROTATED = /^server\.log\.(\d{8}T\d{6}Z)(\.gz)?$/;
const PREFIX = /^[a-z]{1,16}$/;
const breathe = () => new Promise(resolve => setImmediate(resolve));

// A JSON object with a string `time` that parses as a date, or null.
export function parseLine(buf) {
  let end = buf.length;
  if (end && buf[end - 1] === 13) end--;
  if (!end || buf[0] !== 123) return null;
  let value;
  try { value = JSON.parse(buf.toString('utf8', 0, end)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.time !== 'string' || Number.isNaN(Date.parse(value.time))) return null;
  return value;
}

// Splits chunks into lines. A partial last line waits in `carry` (at most 1 MiB; a longer one is dropped up to its
// newline and counted). `onLine(buf, endInChunk)` gets each complete line and the index just past its newline.
export class LineBuffer {
  constructor(maxLine = MAX_LINE_BYTES) { this.maxLine = maxLine; this.carry = EMPTY; this.skipping = false; this.skipped = 0; }
  reset() { this.carry = EMPTY; this.skipping = false; }
  *split(chunk) {
    let start = 0;
    for (let nl = chunk.indexOf(10, start); nl >= 0; nl = chunk.indexOf(10, start)) {
      if (this.skipping) { this.skipping = false; this.skipped++; yield [null, nl + 1]; }
      else if (this.carry.length + (nl - start) > this.maxLine) { this.carry = EMPTY; this.skipped++; yield [null, nl + 1]; }
      else if (this.carry.length) { const line = Buffer.concat([this.carry, chunk.subarray(start, nl)]); this.carry = EMPTY; yield [line, nl + 1]; }
      else yield [chunk.subarray(start, nl), nl + 1];
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (this.skipping || !rest.length) return;
    if (this.carry.length + rest.length > this.maxLine) { this.carry = EMPTY; this.skipping = true; return; }
    this.carry = this.carry.length ? Buffer.concat([this.carry, rest]) : Buffer.from(rest);
  }
  // End of a closed file: a last line without a newline still counts.
  take() { const line = this.skipping ? null : this.carry; this.reset(); return line && line.length ? line : null; }
}

// One complete line: its record goes to apply. A line that does not parse, or whose apply throws (a record the
// aggregates cannot take), is counted as skipped and never stops the reader: the caller marks the position past it, so
// the rest of the chunk is applied now and a restart from the checkpoint never meets that line again.
export function applyLine(line, apply, stats) {
  const record = parseLine(line);
  if (!record) { stats.skipped++; return; }
  try { apply(record); } catch { stats.skipped++; stats.failed++; }
}

// Feeds one chunk read at file offset `base`; `mark(offset)` is called after each complete line with the boundary.
async function feed(lb, chunk, base, apply, mark, stats) {
  for (const [line, end] of lb.split(chunk)) {
    if (line) applyLine(line, apply, stats);
    else stats.skipped++;
    mark(base + end);
    if (++stats.lines % YIELD_EVERY === 0) await breathe();
  }
}

// Decompresses a .gz, skipping the first `skip` decompressed bytes; onChunk(chunk, decompressedOffset).
async function readGzip(file, skip, onChunk, onCompressed = () => {}) {
  const handle = await fsp.open(file, 'r');
  try {
    const source = handle.createReadStream({ autoClose: false });
    const gunzip = zlib.createGunzip();
    source.on('error', error => gunzip.destroy(error));
    let compressed = 0;
    source.on('data', c => { compressed += c.length; onCompressed(c.length); });
    source.pipe(gunzip);
    let seen = 0;
    for await (const raw of gunzip) {
      let chunk = raw;
      if (seen < skip) {
        const drop = Math.min(skip - seen, chunk.length);
        seen += drop;
        chunk = chunk.subarray(drop);
        if (!chunk.length) continue;
      }
      const at = seen;
      seen += chunk.length;
      await onChunk(chunk, at);
    }
    return compressed;
  } finally { await handle.close(); }
}

async function readRange(file, from, max) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(max);
    const { bytesRead } = await handle.read(buf, 0, max, from);
    return buf.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export function rotatedFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const byStamp = new Map();
  for (const name of names) {
    const m = ROTATED.exec(name);
    if (!m) continue;
    const current = byStamp.get(m[1]);
    if (!current || (current.gz && !m[2])) byStamp.set(m[1], { stamp: m[1], name, gz: !!m[2] });
  }
  return [...byStamp.values()].sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
}

// ---- server.log
// A rotation is noticed by a rotated stamp newer than lastRotatedStamp (inode numbers are reused on Linux: after gzip
// deletes the renamed file, the next server.log may get its inode back) or by an inode change; a file replaced in place
// is noticed by its first bytes (a fingerprint kept in the checkpoint).
export const HEAD_BYTES = 128;
export async function headHash(file, len) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, 0);
    return createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex').slice(0, 32);
  } finally { await handle.close(); }
}

export function createServerLogReader({ dir, onRecord, onLoss = () => {}, onProblem = () => {}, onOk = () => {}, progress = null, chunkBytes = CHUNK_BYTES }) {
  const file = path.join(dir, 'server.log');
  const lb = new LineBuffer();
  const stats = { lines: 0, skipped: 0, failed: 0 };
  let pos = 0;                 // read position in the current file
  let boundary = 0;            // offset just past the last complete line applied
  const cp = { ino: null, size: 0, mtimeMs: 0, lastRotatedStamp: null, head: null };
  let busy = false;

  const apply = record => { if (typeof record.event === 'string') onRecord(record); else stats.skipped++; };
  const mark = at => { boundary = at; };
  const restart = () => { pos = 0; boundary = 0; lb.reset(); };
  function closeFile() { const line = lb.take(); if (line) applyLine(line, apply, stats); restart(); }
  // The fingerprint grows with the file up to HEAD_BYTES.
  async function noteHead(size) {
    const len = Math.min(HEAD_BYTES, size);
    if (len > 0 && (!cp.head || cp.head.len < len)) cp.head = { len, hash: await headHash(file, len) };
  }

  async function readPlain(name, untilEnd) {
    const full = path.join(dir, name);
    for (;;) {
      const chunk = await readRange(full, pos, chunkBytes);
      if (!chunk.length) return;
      const base = pos;
      pos += chunk.length;
      if (progress) progress.done += chunk.length;
      await feed(lb, chunk, base, apply, mark, stats);
      if (!untilEnd) return;
    }
  }
  async function readGz(name) {
    lb.reset();
    pos = boundary;
    await readGzip(path.join(dir, name), boundary, async (chunk, at) => {
      pos = at + chunk.length;
      await feed(lb, chunk, at, apply, mark, stats);
    }, n => { if (progress) progress.done += n; });
  }
  const pendingRotations = () => rotatedFiles(dir).filter(r => !cp.lastRotatedStamp || r.stamp > cp.lastRotatedStamp);
  // The rotated files newer than lastRotatedStamp, oldest first: the first holds the saved position, the others are read
  // in full. 'retry' when gzip was replacing a file between the listing and the read; the next tick reads the .gz.
  async function drain(pending) {
    if (!pending.length) { onLoss(); return 'ok'; }
    for (const r of pending) {
      try {
        if (r.gz) await readGz(r.name); else await readPlain(r.name, true);
      } catch (error) {
        if (error.code === 'ENOENT') return 'retry';
        onProblem(r.name, error.code ?? 'READ');
        onLoss();
      }
      closeFile();
      cp.lastRotatedStamp = r.stamp;
    }
    return 'ok';
  }

  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      let st = null;
      try { st = await fsp.stat(file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') { onProblem('server.log', error.code ?? 'READ'); return false; } }
      const ino = st ? String(st.ino) : null;
      const size = st ? Number(st.size) : 0;
      const pending = pendingRotations();
      let replaced = cp.ino !== null && ino !== cp.ino;
      if (!replaced && !pending.length && st && cp.head && size >= cp.head.len && pos >= cp.head.len) {
        replaced = (await headHash(file, cp.head.len)) !== cp.head.hash;
      }
      if (pending.length || replaced) {
        if (await drain(pending) === 'retry') return false;
        cp.ino = null;
        cp.head = null;
        restart();
      }
      if (!st) return true;
      if (cp.ino === null) { cp.ino = ino; cp.head = null; restart(); }
      if (size < pos) { restart(); cp.head = null; }
      if (size > pos) await readPlain('server.log', false);
      await noteHead(size);
      cp.size = size;
      cp.mtimeMs = Number(st.mtimeMs);
      onOk('server.log');
      return pos >= size;
    } catch (error) {
      onProblem('server.log', error.code ?? 'READ');
      return false;
    } finally { busy = false; }
  }

  // No checkpoint: every retained file in stamp order, then server.log to its current end.
  async function coldStart() {
    busy = true;
    try {
      for (const r of rotatedFiles(dir)) {
        if (progress) progress.file = r.name;
        try { restart(); if (r.gz) await readGz(r.name); else await readPlain(r.name, true); } catch (error) { onProblem(r.name, error.code ?? 'READ'); }
        closeFile();
        cp.lastRotatedStamp = r.stamp;
      }
      if (progress) progress.file = 'server.log';
      let st = null;
      try { st = await fsp.stat(file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') onProblem('server.log', error.code ?? 'READ'); }
      if (st) {
        cp.ino = String(st.ino); cp.head = null; restart();
        await readPlain('server.log', true);
        await noteHead(pos);
        cp.size = pos;
        cp.mtimeMs = Number(st.mtimeMs);
      }
    } finally { busy = false; }
  }

  return {
    tick, coldStart,
    get busy() { return busy; },
    stats,
    checkpoint: () => ({ ino: cp.ino, offset: boundary, size: cp.size, mtimeMs: cp.mtimeMs, carry: '', lastRotatedStamp: cp.lastRotatedStamp, head: cp.head }),
    restore(saved) {
      cp.ino = saved?.ino ?? null; cp.size = saved?.size ?? 0; cp.mtimeMs = saved?.mtimeMs ?? 0; cp.lastRotatedStamp = saved?.lastRotatedStamp ?? null;
      cp.head = saved?.head && Number.isInteger(saved.head.len) && typeof saved.head.hash === 'string' ? { len: saved.head.len, hash: saved.head.hash } : null;
      restart(); pos = boundary = Number(saved?.offset) || 0;
    },
  };
}

// ---- <prefix>-YYYYMMDD.jsonl (+ .gz), keyed by the UTC day of the file name
// maxLineBytes caps a line with its newline (the quality contract: 4096 bytes); a longer line is skipped and counted
// before any parse. The default is the audit's cap: 1 MiB without the newline, as before the daily reader existed.
export function createDailyReader({ dir, prefix, maxLineBytes = MAX_LINE_BYTES + 1, onRecord, onProblem = () => {}, onOk = () => {}, now = Date.now,
  progress = null, chunkBytes = CHUNK_BYTES }) {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw new Error('daily reader: the prefix is a lowercase word');
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 2) throw new Error('daily reader: maxLineBytes is an integer above 1');
  const NAME = new RegExp('^' + prefix + '-(\\d{8})\\.jsonl(\\.gz)?$');
  const lineBuffer = () => new LineBuffer(maxLineBytes - 1);
  let files = {};              // key -> { offset, complete }
  const open = new Map();      // key -> { lb, pos }
  const stats = { lines: 0, skipped: 0, failed: 0 };
  let busy = false;

  function listing() {
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { onProblem(prefix, error.code ?? 'READ'); return []; }
    const keys = new Map();
    for (const name of names) {
      const m = NAME.exec(name);
      if (!m) continue;
      const k = keys.get(m[1]) ?? { key: m[1], plain: false, gz: false };
      if (m[2]) k.gz = true; else k.plain = true;
      keys.set(m[1], k);
    }
    return [...keys.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  // One pass; true when every file is at its end (or complete).
  async function tick() {
    if (busy) return false;
    busy = true;
    let caughtUp = true;
    try {
      const today = utcKey(now());
      for (const entry of listing()) {
        const f = files[entry.key] ??= { offset: 0, complete: false };
        if (f.complete) continue;
        let o = open.get(entry.key);
        if (!o) { o = { lb: lineBuffer(), pos: f.offset }; open.set(entry.key, o); }
        const mark = at => { f.offset = at; };
        if (entry.plain) {
          const name = `${prefix}-${entry.key}.jsonl`;
          let size;
          try {
            size = (await fsp.stat(path.join(dir, name))).size;
            if (size < o.pos) { o.pos = 0; f.offset = 0; o.lb.reset(); }
            if (size > o.pos) {
              const chunk = await readRange(path.join(dir, name), o.pos, chunkBytes);
              const base = o.pos;
              o.pos += chunk.length;
              if (progress) progress.done += chunk.length;
              await feed(o.lb, chunk, base, onRecord, mark, stats);
            }
          } catch (error) {
            if (error.code !== 'ENOENT') onProblem(name, error.code ?? 'READ');
            caughtUp = false;
            continue;
          }
          onOk(prefix);
          if (o.pos < size) { caughtUp = false; continue; }
          if (entry.key < today && now() >= endOfUtcKey(entry.key) + 60000) {
            const last = o.lb.take();
            if (last) { applyLine(last, onRecord, stats); f.offset = o.pos; }
            f.complete = true;
            open.delete(entry.key);
          }
        } else if (entry.gz) {
          const name = `${prefix}-${entry.key}.jsonl.gz`;
          o.lb.reset();
          try {
            await readGzip(path.join(dir, name), f.offset, async (chunk, at) => { await feed(o.lb, chunk, at, onRecord, mark, stats); },
              n => { if (progress) progress.done += n; });
            const last = o.lb.take();
            if (last) applyLine(last, onRecord, stats);
          } catch (error) {
            onProblem(name, error.code ?? 'READ');
          }
          f.complete = true;
          open.delete(entry.key);
        }
      }
    } finally { busy = false; }
    return caughtUp;
  }

  return {
    tick,
    get busy() { return busy; },
    stats,
    sizes() {
      let total = 0;
      for (const e of listing()) {
        if (files[e.key]?.complete) continue;
        const name = e.plain ? `${prefix}-${e.key}.jsonl` : `${prefix}-${e.key}.jsonl.gz`;
        try { total += fs.statSync(path.join(dir, name)).size; } catch { /* gone */ }
      }
      return total;
    },
    checkpoint: () => ({ files: structuredClone(files) }),
    restore(saved) { files = structuredClone(saved?.files ?? {}); open.clear(); },
  };
}
// The audit reader of DESIGN 3.2, unchanged: the daily reader with the audit prefix and the 1 MiB line cap.
export const createAuditReader = opts => createDailyReader({ ...opts, prefix: 'audit' });

// ---- access-alerts.jsonl (offset + inode; never rotated)
export function createAccessAlertsReader({ dir, onRecord, onReset = () => {}, onProblem = () => {}, progress = null, chunkBytes = CHUNK_BYTES }) {
  const file = path.join(dir, 'access-alerts.jsonl');
  const lb = new LineBuffer();
  const stats = { lines: 0, skipped: 0, failed: 0 };
  const cp = { ino: null, offset: 0, head: null };
  let pos = 0;
  let busy = false;
  // true when the file is read to its end (or absent); a replaced file (inode or first bytes) is read again
  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      let st;
      try { st = await fsp.stat(file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') { onProblem('access-alerts.jsonl', error.code ?? 'READ'); return false; } return true; }
      const ino = String(st.ino), size = Number(st.size);
      let replaced = (cp.ino !== null && ino !== cp.ino) || size < pos;
      if (!replaced && cp.head && size >= cp.head.len) replaced = (await headHash(file, cp.head.len)) !== cp.head.hash;
      if (replaced) { onReset(); pos = 0; cp.offset = 0; cp.head = null; lb.reset(); }
      cp.ino = ino;
      if (size > pos) {
        const chunk = await readRange(file, pos, chunkBytes);
        const base = pos;
        pos += chunk.length;
        if (progress) progress.done += chunk.length;
        await feed(lb, chunk, base, onRecord, at => { cp.offset = at; }, stats);
      }
      const len = Math.min(HEAD_BYTES, size);
      if (len > 0 && (!cp.head || cp.head.len < len)) cp.head = { len, hash: await headHash(file, len) };
      return pos >= size;
    } catch (error) {
      onProblem('access-alerts.jsonl', error.code ?? 'READ');
      return false;
    } finally { busy = false; }
  }
  return {
    tick, stats,
    get busy() { return busy; },
    checkpoint: () => ({ ino: cp.ino, offset: cp.offset, head: cp.head }),
    restore(saved) {
      cp.ino = saved?.ino ?? null; cp.offset = pos = Number(saved?.offset) || 0; lb.reset();
      cp.head = saved?.head && Number.isInteger(saved.head.len) && typeof saved.head.hash === 'string' ? { len: saved.head.len, hash: saved.head.hash } : null;
    },
  };
}

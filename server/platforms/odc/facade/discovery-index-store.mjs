// The persisted pieces of the discover index (discovery.mjs buildIndex): files named <kind>-<key>.json in the lane's
// cache (<odc>/.local/discovery/<lane>), where <key> is the identity of the sources that produce the piece. A piece is
// served only when the file holds that same identity (its `key`) and schema: a file of another identity, a torn write or
// unreadable bytes are never served; they are rebuilt, and the answer says why (`note`). Writes are atomic (a temporary
// file renamed over the target) and only under a `.local` folder (or the system temporary folder, where tests keep their
// private caches): a cache never lands in the tree git tracks. Builds of the same piece in one process are shared: the
// warm-up at the server start and the first discover that needs the same index wait for ONE build (`shared`), and a
// caller's AbortSignal cancels that build only when every caller waiting for it has cancelled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const storeFile = (dir, kind, key) => path.join(dir, `${kind}-${key}.json`);

// A cache folder may be written when it is inside a `.local` folder or inside the system temporary folder.
const fold = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
export function writableDir(dir, { tmp = os.tmpdir() } = {}) {
  if (typeof dir !== 'string' || !dir) return false;
  const full = fold(dir);
  if (full.split(path.sep).includes('.local')) return true;
  const temp = fold(tmp);
  return full === temp || full.startsWith(temp + path.sep);
}

// The stored piece when its identity is the expected one: { value } on a hit, { value: null } when there is no file, and
// { value: null, note } when a file is there but cannot be served (unreadable, torn, another schema or another key).
export function readStored(file, { key, schema }) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return error?.code === 'ENOENT' ? { value: null } : { value: null, note: `stored ${path.basename(file)} unreadable (${error?.code ?? error?.message}): rebuilt` }; }
  let value;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { return { value: null, note: `stored ${path.basename(file)} is not JSON (torn or corrupted): rebuilt` }; }
  if (value === null || typeof value !== 'object') return { value: null, note: `stored ${path.basename(file)} is not an object: rebuilt` };
  if (value.schemaVersion !== schema) return { value: null, note: `stored ${path.basename(file)} has schema ${value.schemaVersion ?? 'none'}, not ${schema}: rebuilt` };
  if (value.key !== key) return { value: null, note: `stored ${path.basename(file)} holds identity ${value.key ?? 'none'}, not ${key}: rebuilt` };
  return { value };
}

// Writes `text` to `file` atomically, only in a writable folder. -> { written: true } or { written: false, note }.
export function writeStored(file, text, { tmp } = {}) {
  const dir = path.dirname(file);
  if (!writableDir(dir, tmp ? { tmp } : {})) return { written: false, note: `not persisted: ${dir} is outside .local` };
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
    return { written: true };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean */ }
    // Another process renamed the same identity over it first (Windows refuses to replace an open file): the same bytes.
    return { written: false, note: `not persisted (${error?.code ?? error?.message})` };
  }
}

// One build per id in flight in this process. `produce(signal)` runs once; every caller gets its result (or its error).
// The signal given to `produce` aborts only when every caller that joined passed a signal and all of them aborted: a
// caller without a signal (a discover) keeps the build alive for the others (the warm-up).
const inFlight = new Map();
export function shared(id, produce, { signal = null } = {}) {
  const joined = inFlight.has(id);
  if (!joined) {
    const controller = new AbortController();
    const entry = { controller, waiting: 0, keeps: 0 };
    entry.promise = Promise.resolve().then(() => produce(controller.signal)).finally(() => { if (inFlight.get(id) === entry) inFlight.delete(id); });
    entry.promise.catch(() => {}); // a build every caller left must not end the process as an unhandled rejection
    inFlight.set(id, entry);
  }
  const entry = inFlight.get(id);
  if (!signal) entry.keeps++;
  else {
    entry.waiting++;
    const drop = () => { entry.waiting--; if (entry.keeps === 0 && entry.waiting === 0) entry.controller.abort(signal.reason); };
    if (signal.aborted) drop(); else signal.addEventListener('abort', drop, { once: true });
    // The caller that cancelled stops waiting at once, whether or not the build goes on for the others.
    const cancelled = new Promise((_, reject) => { const stop = () => reject(signal.reason ?? new Error('cancelled')); if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); });
    cancelled.catch(() => {});
    return { promise: Promise.race([entry.promise, cancelled]), joined };
  }
  return { promise: entry.promise, joined };
}
export const inFlightCount = () => inFlight.size;

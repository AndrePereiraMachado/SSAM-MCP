// Known captures of O11 modules, by model (speed lane vel-entrega; lentidão 2026-10-12, recommendation Q5).
// In the production test every build capture of a delivery had the same model as a file the server already held: the
// delivered snapshot of the previous delivery, the capture of a refused call corrected by patch, or an o11_studio snapshot.
// Each capture is a snapshot_module, which in hosted mode is an upload from the owner's PC (one of them took 48 s).
// The build phase (o11-build-phase.mjs captureByKey) now asks the bridge for the tab's model fingerprint
// (list_open_modules {model_sha256_of}, capability list_open_modules:model_sha256) and, when a capture recorded here has
// that model, copies it instead of capturing. Equal model hash means equal model bytes, so the copy is exactly what a new
// capture would hold (only the window-state header can differ, which no model read uses); the delivery still takes its own
// snapshot and reuses the build only for the same model (Anvil.Core.Delivery.PrebuiltCandidate).
//
// Model hash: the SHA-256 of the OML after its textual header ("OML", a 32-bit little-endian length N, N header bytes), the
// rule of PrebuiltCandidate.ModelSha256 and of the bridge's MergeRollbackProof.ModelSha256Hex. Index:
// <lane.local>/snapshots/captures.json {schema, modules: {<moduleKey>: [{path, model, module, source, at}]}}, newest first,
// at most PER_MODULE rows per module, written whole through a temporary file. It is a cache: a lost or unreadable index
// only means a capture; a row is used only after its file is read again and still has the model asked for.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CAPTURES_SCHEMA = 'ssam-captures/1';
export const PER_MODULE = 8;
const SHA = /^[0-9a-f]{64}$/;
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export const isModelSha = value => typeof value === 'string' && SHA.test(value);

// The model identity of an OML file (see the header).
export function modelSha256(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 7 && bytes[0] === 0x4f && bytes[1] === 0x4d && bytes[2] === 0x4c) {
    const length = bytes.readUInt32LE(3);
    if (length <= bytes.length - 7) return createHash('sha256').update(bytes.subarray(7 + length)).digest('hex');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export const capturesFile = local => path.join(local, 'snapshots', 'captures.json');

function readIndex(local) {
  try {
    const document = JSON.parse(fs.readFileSync(capturesFile(local), 'utf8'));
    if (document?.schema === CAPTURES_SCHEMA && document.modules && typeof document.modules === 'object' && !Array.isArray(document.modules)) return document;
  } catch { /* a missing or unreadable index is an empty one */ }
  return { schema: CAPTURES_SCHEMA, modules: {} };
}

function writeIndex(local, index) {
  const file = capturesFile(local);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID().slice(0, 8) + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(index));
  fs.renameSync(temporary, file);
}

// Records a capture file of a module; its model hash is read from the file (or given, when the caller just verified it).
// Answers the model hash, or null when nothing was recorded. Never throws: a record that cannot be written never changes
// what the caller does.
export function rememberCapture(local, { moduleKey, module = null, file, model = null, source = null, now = new Date() } = {}) {
  try {
    if (typeof local !== 'string' || !local || typeof moduleKey !== 'string' || !moduleKey || typeof file !== 'string' || !isFile(file)) return null;
    const sha = isModelSha(model) ? model : modelSha256(file);
    const index = readIndex(local);
    const rows = (Array.isArray(index.modules[moduleKey]) ? index.modules[moduleKey] : []).filter(row => typeof row?.path === 'string' && !same(row.path, file));
    rows.unshift({ path: path.resolve(file), model: sha, ...(module ? { module } : {}), ...(source ? { source } : {}), at: now.toISOString() });
    index.modules[moduleKey] = rows.slice(0, PER_MODULE);
    writeIndex(local, index);
    return sha;
  } catch { return null; }
}

// The newest recorded capture of moduleKey whose file still exists and, read now, still has the model `model`; null
// otherwise. {path, source, at}.
export function findCapture(local, { moduleKey, model } = {}) {
  if (typeof local !== 'string' || !local || typeof moduleKey !== 'string' || !isModelSha(model)) return null;
  const rows = readIndex(local).modules[moduleKey];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.model !== model || typeof row.path !== 'string' || !isFile(row.path)) continue;
    try { if (modelSha256(row.path) === model) return { path: row.path, source: row.source ?? null, at: row.at ?? null }; } catch { /* next row */ }
  }
  return null;
}

// After a delivery: its own snapshot (the module before the merge, and still the module when nothing was merged) and the
// delivered snapshot (after the merge, taken for the data proof) of the kernel's task state. Never throws.
// L3b: answers what was recorded, {base, delivered} each {path, model, moduleKey} or null: the delivered capture is the
// module now, the one the worker prepares next (its spare).
export function rememberDelivery(local, state, { now = new Date() } = {}) {
  const recorded = { base: null, delivered: null };
  if (!state || typeof state !== 'object') return recorded;
  const key = typeof state.moduleKey === 'string' ? state.moduleKey : null;
  for (const [snapshot, source, slot] of [[state.snapshot, 'deliver-base', 'base'], [state.deliveredSnapshot, 'delivered', 'delivered']]) {
    if (!snapshot || typeof snapshot.path !== 'string') continue;
    const moduleKey = typeof snapshot.key === 'string' && snapshot.key ? snapshot.key : key;
    if (key && moduleKey !== key) continue;
    const model = rememberCapture(local, { moduleKey, module: typeof snapshot.name === 'string' ? snapshot.name : state.module ?? null, file: snapshot.path, source, now });
    if (model) recorded[slot] = { path: path.resolve(snapshot.path), model, moduleKey };
  }
  return recorded;
}

// L3b (pré-aquecimento): the newest known capture of each module, newest module first, at most `limit`, whose file still
// exists; `moduleKeys` (the tabs open in the Studio, in their order) narrows and orders it. Rows {path, model, moduleKey,
// module, at}. The model is the one recorded (the worker reads the file again before loading it). Never throws.
export function recentCaptures(local, { limit = 3, moduleKeys = null } = {}) {
  try {
    if (typeof local !== 'string' || !local) return [];
    const modules = readIndex(local).modules;
    const newest = moduleKey => (Array.isArray(modules[moduleKey]) ? modules[moduleKey] : [])
      .find(row => typeof row?.path === 'string' && isModelSha(row.model) && isFile(row.path));
    const keys = Array.isArray(moduleKeys) ? moduleKeys.filter(k => typeof k === 'string' && k) : Object.keys(modules);
    const rows = keys.map(moduleKey => ({ moduleKey, row: newest(moduleKey) })).filter(r => r.row)
      .map(({ moduleKey, row }) => ({ path: row.path, model: row.model, moduleKey, module: row.module ?? null, at: row.at ?? null }));
    if (!Array.isArray(moduleKeys)) rows.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    return rows.slice(0, Math.max(0, limit));
  } catch { return []; }
}

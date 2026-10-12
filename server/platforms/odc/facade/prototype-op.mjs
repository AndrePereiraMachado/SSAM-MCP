// The facade side of the prototype importer (docs/PROTOTIPO-NATIVO.md sections 1.1-1.6 and 7.6, lane surface): one job op
// `prototype` turns a prototype folder into native screens inside the delivery tools that already exist (o11_deliver,
// studio_deliver, ssam_job/o11_job), so it inherits the fresh capture of the module, the headless build, the Verify, the
// merge, publish:true and the authorization words with no step of its own.
//
//   expandPrototypeOps(job, {work, capture, now})   every prototype op gets data.capture/data.captureSha256 (the bundle of
//                                                   the capture lane, prototype/capture.mjs), before any Studio or build
//                                                   work. A capture that is missing, or whose hash or source files diverge,
//                                                   is captured again in silence (warning captureRefreshed). Problems of the
//                                                   prototype (and of the op's own data) come back ONCE, all of them, from
//                                                   every op: {refusal} with problems[], the combined JSON Patch over
//                                                   /ops/<i>/data and correctedJob (the call with every patch applied).
//   buildWithDegradation({jobFile, attempt, ...})   1.4.1: a build or Verify problem that names a generated item (its k)
//                                                   is an SSAM defect: the item is degraded in the capture (property out,
//                                                   node literal, event not compiled) and the build runs ONCE more; a second
//                                                   failure is VALIDATION_REFUSED with ssamDefect and the ready
//                                                   mapping.ignore patch.
//   prototypeReceipt(kernelReport, {...})           report.prototype (ssam-prototype-receipt/1) completed with the measured
//                                                   fidelity, the degraded items, the seed and the timings of every phase.
//   prototypeCall({lane, ...})                      the ready one-call example the discover route and the guides give.
//   prototypeCli(argv, deps)                        `ssam prototype <folder> --lane o11|odc --module <M> [--base <oml>] [--dry]`.
//
// The facade reads the prototype only to resolve the entry and the prefix (a few hundred bytes); the capture lane reads
// and renders it, the kernel reads only the bundle. Nothing here talks to a Studio.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const RECEIPT_SCHEMA = 'ssam-prototype-receipt/1';
export const CAPTURE_SCHEMA = 'ssam-prototype-capture/1';
// The codes of the importer's own refusals (refusal-codes.mjs registers them). CAPTURE_STALE does not exist: a divergent
// capture is captured again, never refused.
export const PROTOTYPE_CODES = Object.freeze(['PROTOTYPE_SOURCE_INVALID', 'PROTOTYPE_RENDER_FAILED', 'PROTOTYPE_AMBIGUOUS',
  'PROTOTYPE_NAME_COLLISION', 'PROTOTYPE_IR_INVALID']);
export const DATA_KEYS = Object.freeze(['source', 'entry', 'app', 'prefix', 'mapping', 'clock', 'tz', 'home', 'seed', 'capture', 'captureSha256']);
// names: the name map of a PROTOTYPE_NAME_COLLISION ("<Owner>/<Name>" or "<Name>" -> the free name every reference uses).
export const MAPPING_KEYS = Object.freeze(['screens', 'default', 'routes', 'shell', 'states', 'modals', 'data', 'vendor', 'events', 'ignore', 'names']);
// The facade fills these; the model never writes them.
export const FACADE_KEYS = Object.freeze(['capture', 'captureSha256']);
export const WORDS_MARKER = '<palavras do usuário>'; // the marker of o11-cycle.mjs and next-steps.mjs
// The sentence the delivery tools (o11_deliver, studio_deliver) carry about the op; catalog/tools.json routes its verb
// "prototype" by it (selector documented).
export const PROTOTYPE_DELIVER_TEXT = 'A prototype folder (HTML/CSS/JS) becomes native screens in ONE call: job {ops:[{op:"prototype", data:{source:"<absolute folder>"}}]} '
  + 'with publish:true and the owner\'s words in authorize (they cover the import, the publication and the demo data); never read nor hand-convert the prototype, '
  + 'and add data.mapping only when a refusal asks for it (apply its patch). The answer carries the receipt in prototype (screens, popups, blocks, data, events, fidelity per state, seed, timings).';
export const TIMING_KEYS = Object.freeze(['captureMs', 'expandMs', 'buildMs', 'verifyMs', 'fidelityMs', 'mergeMs', 'publishMs', 'seedMs']);
// The order of the top-level code of a refusal with several codes: an SSAM defect first, then what stops the capture.
const CODE_ORDER = ['PROTOTYPE_IR_INVALID', 'PROTOTYPE_SOURCE_INVALID', 'PROTOTYPE_RENDER_FAILED', 'INPUT_INVALID', 'PROTOTYPE_NAME_COLLISION', 'PROTOTYPE_AMBIGUOUS'];

const sha256 = data => createHash('sha256').update(data).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isDir = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const escapeToken = t => String(t).replace(/~/g, '~0').replace(/\//g, '~1');
const clip = (text, max = 400) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };

// ---- the ops of a job
// {ops:[...]} (base "/ops") or an array of ops (base ""): the prototype ops with their index. A composite {jobs} job has none
// here (its parts are read by the kernel; a prototype op belongs in a part of its own).
export function opsOfDocument(document) {
  if (Array.isArray(document)) return { ops: document, base: '' };
  if (isObject(document) && !Array.isArray(document.jobs) && Array.isArray(document.ops)) return { ops: document.ops, base: '/ops' };
  return { ops: [], base: '/ops' };
}
export function prototypeOps(document) {
  const { ops, base } = opsOfDocument(document);
  return { base, list: ops.map((op, index) => ({ index, op })).filter(x => isObject(x.op) && x.op.op === 'prototype') };
}
export const hasPrototypeOps = document => prototypeOps(document).list.length > 0;
export function readJobDocument(file) { try { return readJson(file); } catch { return null; } }
export const jobHasPrototype = file => { const doc = readJobDocument(file); return !!doc && hasPrototypeOps(doc); };

// ---- names
const ascii = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
export function pascal(text) {
  const words = ascii(text).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(name) ? name : '';
}
export const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
// The title up to the first separator (|, -, en dash, :), in ASCII PascalCase; else the folder name (1.2).
export function prefixFromTitle(title) {
  const head = String(title ?? '').split(/\s*[|:–—]\s*|\s+-\s+/)[0];
  return pascal(head);
}
function titleOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const buffer = Buffer.alloc(65536); const n = fs.readSync(fd, buffer, 0, buffer.length, 0); return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buffer.subarray(0, n).toString('utf8'))?.[1]?.trim() ?? null; }
    finally { fs.closeSync(fd); }
  } catch { return null; }
}
export function inferPrefix(data = {}, resolved = null) {
  if (typeof data.prefix === 'string' && PREFIX_PATTERN.test(data.prefix)) return { prefix: data.prefix, from: 'data.prefix' };
  const source = resolved ?? resolveSource(data);
  if (source.ok) {
    const fromTitle = prefixFromTitle(titleOf(path.join(source.root, source.entry)));
    if (fromTitle) return { prefix: fromTitle, from: 'title' };
    const fromFolder = pascal(path.basename(source.root));
    if (fromFolder) return { prefix: fromFolder, from: 'folder' };
  } else if (typeof data.source === 'string' && data.source) {
    const fromFolder = pascal(path.basename(/\.html?$/i.test(data.source) ? path.dirname(data.source) : data.source));
    if (fromFolder) return { prefix: fromFolder, from: 'folder' };
  }
  return { prefix: null, from: null };
}

// ---- the source: a folder or an .html file in it; entry = data.entry, else index.html, else the only .html of the root.
export function resolveSource(data = {}) {
  const source = data.source;
  if (typeof source !== 'string' || !source.trim()) return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/source', message: 'data.source is required: the absolute path of the prototype folder (or of an .html file in it).' } };
  if (!path.isAbsolute(source)) return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/source', message: 'data.source must be an absolute path; got ' + clip(source, 200) + '.' } };
  let root = path.resolve(source); let entry = typeof data.entry === 'string' && data.entry.trim() ? data.entry.trim() : null;
  if (isFile(root)) {
    if (!/\.html?$/i.test(root)) return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/source', message: 'data.source is a file but not an .html page: ' + root } };
    entry ??= path.basename(root); root = path.dirname(root);
  } else if (!isDir(root)) return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/source', message: 'No prototype folder or file at ' + root + '.' } };
  let pages = [];
  try { pages = fs.readdirSync(root).filter(f => /\.html?$/i.test(f) && isFile(path.join(root, f))).sort(); } catch { pages = []; }
  if (entry) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..') || !isFile(path.join(root, entry)))
      return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/entry', message: 'data.entry ' + clip(entry, 200) + ' is not an .html file of ' + root + '.',
        ...(pages.length ? { patch: [{ op: 'replace', path: '/entry', value: pages.includes('index.html') ? 'index.html' : pages[0] }], alternatives: pages.slice(0, 8) } : {}) } };
    return { ok: true, root, entry: entry.replace(/\\/g, '/') };
  }
  if (pages.includes('index.html')) return { ok: true, root, entry: 'index.html' };
  if (pages.length === 1) return { ok: true, root, entry: pages[0] };
  if (!pages.length) return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/source', message: 'The prototype folder ' + root + ' has no .html page at its root.' } };
  return { ok: false, problem: { code: 'PROTOTYPE_SOURCE_INVALID', at: '/entry', message: 'The prototype folder has ' + pages.length + ' .html pages and no index.html: data.entry says which one is the entry.',
    patch: [{ op: 'add', path: '/entry', value: pages[0] }], alternatives: pages.slice(1, 9) } };
}

// ---- the op's own data (closed keys, 1.2): every problem at once
function distance(a, b) {
  const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
export function nearest(word, choices) {
  let best = null, score = Infinity;
  for (const c of choices) { const s = distance(String(word).toLowerCase(), c.toLowerCase()); if (s < score) { score = s; best = c; } }
  return score <= Math.max(2, Math.floor(String(word).length / 3)) ? best : null;
}
const validZone = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
// Problems as {code, at (relative to /ops/<i>/data), message, patch? (relative), alternatives?}.
export function dataProblems(data) {
  const problems = [];
  if (!isObject(data)) return [{ code: 'PROTOTYPE_SOURCE_INVALID', at: '', message: 'The prototype op needs data {source: "<absolute folder of the prototype>"}.' }];
  for (const key of Object.keys(data).filter(k => !DATA_KEYS.includes(k))) {
    const near = nearest(key, DATA_KEYS.filter(k => !FACADE_KEYS.includes(k)));
    problems.push({ code: 'INPUT_INVALID', at: '/' + escapeToken(key), message: 'data.' + key + ' is not a key of the prototype op' + (near ? '; did you mean ' + near + '?' : '') + ' Keys: ' + DATA_KEYS.filter(k => !FACADE_KEYS.includes(k)).join(', ') + '.',
      patch: [{ op: 'remove', path: '/' + escapeToken(key) }, ...(near && !Object.hasOwn(data, near) ? [{ op: 'add', path: '/' + near, value: data[key] }] : [])] });
  }
  if (data.prefix !== undefined && !(typeof data.prefix === 'string' && PREFIX_PATTERN.test(data.prefix))) {
    const fixed = pascal(data.prefix);
    problems.push({ code: 'INPUT_INVALID', at: '/prefix', message: 'data.prefix must match ^[A-Za-z][A-Za-z0-9]*$.', patch: [fixed ? { op: 'replace', path: '/prefix', value: fixed } : { op: 'remove', path: '/prefix' }] });
  }
  if (data.app !== undefined && !['reactive', 'mobile'].includes(data.app))
    problems.push({ code: 'INPUT_INVALID', at: '/app', message: 'data.app is reactive or mobile (default: the type of the open module).', patch: [{ op: 'remove', path: '/app' }] });
  if (data.tz !== undefined && !(typeof data.tz === 'string' && validZone(data.tz)))
    problems.push({ code: 'INPUT_INVALID', at: '/tz', message: 'data.tz must be an IANA time zone (default UTC).', patch: [{ op: 'replace', path: '/tz', value: 'UTC' }] });
  if (data.clock !== undefined && !(typeof data.clock === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(data.clock) && !Number.isNaN(Date.parse(data.clock))))
    problems.push({ code: 'INPUT_INVALID', at: '/clock', message: 'data.clock must be an ISO-8601 UTC instant (2026-10-10T21:00:00Z); default: the newest mtime of the files the capture reads.', patch: [{ op: 'remove', path: '/clock' }] });
  for (const key of ['home', 'seed']) if (data[key] !== undefined && typeof data[key] !== 'boolean')
    problems.push({ code: 'INPUT_INVALID', at: '/' + key, message: 'data.' + key + ' is a boolean.', patch: [{ op: 'replace', path: '/' + key, value: key === 'seed' }] });
  if (data.mapping !== undefined) {
    if (!isObject(data.mapping)) problems.push({ code: 'INPUT_INVALID', at: '/mapping', message: 'data.mapping is an object (1.3); only what a refusal asks for.', patch: [{ op: 'remove', path: '/mapping' }] });
    else for (const key of Object.keys(data.mapping).filter(k => !MAPPING_KEYS.includes(k))) {
      const near = nearest(key, MAPPING_KEYS);
      problems.push({ code: 'INPUT_INVALID', at: '/mapping/' + escapeToken(key), message: 'mapping.' + key + ' is not a mapping key' + (near ? '; did you mean ' + near + '?' : '') + ' Keys: ' + MAPPING_KEYS.join(', ') + '.',
        patch: [{ op: 'remove', path: '/mapping/' + escapeToken(key) }, ...(near && !Object.hasOwn(data.mapping, near) ? [{ op: 'add', path: '/mapping/' + near, value: data.mapping[key] }] : [])] });
    }
  }
  return problems;
}

// ---- JSON Pointer helpers over the job
const tokensOf = pointer => (pointer === '' ? [] : String(pointer).replace(/^\//, '').split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~')));
// Applies a patch leniently (missing parents of an add are created): used to build correctedJob and the strict patch.
export function applyLenient(document, patch) {
  const copy = structuredClone(document);
  for (const operation of patch ?? []) {
    if (!isObject(operation) || typeof operation.path !== 'string') continue;
    const tokens = tokensOf(operation.path);
    if (!tokens.length) continue;
    let parent = copy;
    for (const token of tokens.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[Number(token)];
      else { if (!isObject(parent[token]) && !Array.isArray(parent[token])) parent[token] = {}; parent = parent[token]; }
      if (parent == null) break;
    }
    if (parent == null || typeof parent !== 'object') continue;
    const key = tokens.at(-1);
    if (operation.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (operation.op === 'add' || operation.op === 'replace') {
      if (Array.isArray(parent)) { if (key === '-') parent.push(structuredClone(operation.value)); else parent[Number(key)] = structuredClone(operation.value); }
      else parent[key] = structuredClone(operation.value);
    }
  }
  return copy;
}
// The strict patch (RFC 6902: every parent exists) that turns `before` into `after`, per prototype op and per top-level
// key of its data: add (an object member is replaced by add) or remove. It applies with patch + basedOn (job-patch.mjs).
export function strictPatch(before, after) {
  const out = [];
  const { base, list } = prototypeOps(before);
  const afterOps = opsOfDocument(after).ops;
  for (const { index, op } of list) {
    const was = isObject(op.data) ? op.data : null;
    const now = isObject(afterOps[index]?.data) ? afterOps[index].data : null;
    if (!now) continue;
    if (!was) { out.push({ op: 'add', path: `${base}/${index}/data`, value: now }); continue; }
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!Object.hasOwn(now, key)) out.push({ op: 'remove', path: `${base}/${index}/data/${escapeToken(key)}` });
      else if (JSON.stringify(was[key]) !== JSON.stringify(now[key])) out.push({ op: 'add', path: `${base}/${index}/data/${escapeToken(key)}`, value: now[key] });
    }
  }
  return out;
}
// A path a capture or a check names, made absolute for op i: /ops/<n>/data/..., /<n>/data/..., /data/..., or relative to data.
export function opPath(raw, index, base) {
  const head = `${base}/${index}`;
  if (typeof raw !== 'string' || !raw) return head + '/data';
  let m = /^\/ops\/\d+(\/.*)?$/.exec(raw) ?? (base === '' ? /^\/\d+(\/.*)?$/.exec(raw) : null);
  if (m) return head + (m[1] ?? '');
  if (raw === '/data' || raw.startsWith('/data/')) return head + raw;
  return head + '/data' + (raw.startsWith('/') ? raw : '/' + raw);
}
const withPaths = (patch, index, base) => (Array.isArray(patch) ? patch.filter(isObject).map(p => ({ ...p, path: opPath(p.path, index, base) })) : null);

// ---- the IR hash: the render lane's own (prototype/ir.mjs) when present, else the same rule (canonical JSON, keys sorted,
// without timings, engine.node and source.root). Either one, or the raw bytes, proves the file is the one named.
const canonical = value => (Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : isObject(value) ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value) ?? 'null');
export function canonicalSha256(ir) {
  const copy = structuredClone(ir);
  if (isObject(copy)) { delete copy.timings; if (isObject(copy.engine)) delete copy.engine.node; if (isObject(copy.source)) delete copy.source.root; }
  return sha256(canonical(copy));
}
let irModule;
async function renderHash() {
  if (irModule === undefined) irModule = await import('./prototype/ir.mjs').catch(() => null);
  const fn = ['irSha256', 'captureSha256', 'hashIr', 'irHash', 'sha256Of'].map(n => irModule?.[n]).find(f => typeof f === 'function');
  return fn ?? null;
}
export async function irHashes(ir, bytes) {
  const out = new Set([canonicalSha256(ir)]);
  if (bytes) out.add(sha256(bytes));
  try { const fn = await renderHash(); if (fn) { const h = await fn(ir); if (typeof h === 'string') out.add(h.toLowerCase()); } } catch { /* the own rule stands */ }
  return out;
}
export async function irSha256(ir) {
  try { const fn = await renderHash(); if (fn) { const h = await fn(ir); if (typeof h === 'string' && /^[a-f0-9]{64}$/i.test(h)) return h.toLowerCase(); } } catch { /* the own rule */ }
  return canonicalSha256(ir);
}
// Whether data.capture is still the capture of data.source: the file is there, one of its hashes is data.captureSha256, and
// every source file the IR lists still has its sha256. Anything else is captured again (never a refusal).
export async function captureCurrent(data, root) {
  if (typeof data?.capture !== 'string' || typeof data?.captureSha256 !== 'string' || !isFile(data.capture)) return { current: false, why: 'no capture' };
  let bytes, ir;
  try { bytes = fs.readFileSync(data.capture); ir = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return { current: false, why: 'unreadable capture' }; }
  if (ir?.schema !== CAPTURE_SCHEMA) return { current: false, why: 'not a ' + CAPTURE_SCHEMA };
  if (!(await irHashes(ir, bytes)).has(data.captureSha256.toLowerCase())) return { current: false, why: 'captureSha256 differs from the capture file' };
  for (const f of Array.isArray(ir.source?.files) ? ir.source.files : []) {
    if (typeof f?.path !== 'string' || typeof f?.sha256 !== 'string') continue;
    const file = path.join(root, f.path);
    if (!isFile(file) || sha256(fs.readFileSync(file)) !== f.sha256.toLowerCase()) return { current: false, why: 'the prototype file ' + f.path + ' changed' };
  }
  return { current: true, ir };
}

// ---- the capture engine (lane render), loaded on demand; its absence is an SSAM defect, never a problem of the prototype.
export async function capturePrototype(args) {
  let mod;
  try { mod = await import('./prototype/capture.mjs'); }
  catch (error) { return { ok: false, problems: [{ code: 'PROTOTYPE_IR_INVALID', ssamDefect: true, message: 'The capture engine of this release (prototype/capture.mjs) could not be loaded: ' + clip(error.message, 300) }] }; }
  if (typeof mod.capturePrototype !== 'function') return { ok: false, problems: [{ code: 'PROTOTYPE_IR_INVALID', ssamDefect: true, message: 'prototype/capture.mjs has no capturePrototype export.' }] };
  return mod.capturePrototype(args);
}

const fixOf = code => ({
  PROTOTYPE_SOURCE_INVALID: 'Point data.source to the absolute folder of the prototype (or its .html entry); the patch names the entry when the folder has several pages.',
  PROTOTYPE_RENDER_FAILED: 'The prototype did not load headless; when the cause is an external script the patch maps its URL to a local copy (mapping.vendor).',
  PROTOTYPE_AMBIGUOUS: 'Apply the patch as it is: it is the exact mapping the capture could not infer.',
  PROTOTYPE_NAME_COLLISION: 'A name you asked for is taken by an element the import does not own; the patch uses the free name.',
  PROTOTYPE_IR_INVALID: 'SSAM defect: nothing to correct in the call; report it.',
  INPUT_INVALID: 'Apply the patch: the op data keys are closed (source, entry, app, prefix, mapping, clock, tz, home, seed).',
}[code] ?? 'Apply the patch.');
function problemFor(raw, index, base) {
  const code = typeof raw?.code === 'string' ? raw.code : 'PROTOTYPE_IR_INVALID';
  const pointer = opPath(raw?.at ?? raw?.path ?? raw?.pointer, index, base);
  const patch = withPaths(raw?.patch, index, base);
  return { phase: 'prototype', op: index, pointer, code, severity: 'error', message: clip(raw?.message ?? code, 600), fix: raw?.fix ?? fixOf(code),
    ...(patch?.length ? { patch } : {}), ...(Array.isArray(raw?.alternatives) && raw.alternatives.length ? { alternatives: raw.alternatives.slice(0, 8) } : {}),
    ...(raw?.ssamDefect === true || code === 'PROTOTYPE_IR_INVALID' ? { ssamDefect: true } : {}) };
}
// Strips what the facade wrote (capture, captureSha256) from every prototype op: the job as the model gave it.
export function modelJob(document) {
  const copy = structuredClone(document);
  for (const { op } of prototypeOps(copy).list) if (isObject(op.data)) for (const key of FACADE_KEYS) delete op.data[key];
  return copy;
}
// The single refusal: every problem, the strict combined patch and the corrected call.
export function prototypeRefusal(problems, job, { code = null, error = null, ssamDefect = false, stage = 'prototype', extra = {} } = {}) {
  const original = modelJob(job);
  const lenient = problems.flatMap(p => p.patch ?? []);
  const corrected = lenient.length ? applyLenient(original, lenient) : null;
  const patch = corrected ? strictPatch(original, corrected) : [];
  // Each problem's own patch, made strict over the call as the model sent it (applies alone with patch + basedOn).
  const strictOne = p => { if (!p.patch?.length) return p; const one = strictPatch(original, applyLenient(original, p.patch)); return { ...p, patch: one.length ? one : p.patch }; };
  const all = problems.map(strictOne);
  const codes = [...new Set(all.map(p => p.code))];
  const top = code ?? CODE_ORDER.find(c => codes.includes(c)) ?? codes[0] ?? 'PROTOTYPE_IR_INVALID';
  const defect = ssamDefect || all.some(p => p.ssamDefect);
  return { ok: false, outcome: 'refused', code: top, stage, failed: stage,
    error: error ?? (all.length === 1 ? all[0].message : all.length + ' problems in the prototype op(s); nothing was captured into the Studio or built. Apply the whole patch in ONE call.'),
    problems: all, ...(patch.length ? { patch } : {}), ...(corrected && patch.length ? { correctedJob: corrected } : {}),
    ...(defect ? { ssamDefect: true } : {}), ...extra };
}

// ---- the expansion
// job: the job document (object or array). work: the folder of this expansion (the bundles go to <work>/op-<i>/bundle).
// -> {job, expanded:false} when there is no prototype op; {job, expanded:true, captures, warnings, timings}; or {refusal}.
export async function expandPrototypeOps(job, { work, capture = capturePrototype, now = Date.now } = {}) {
  const started = now();
  const document = structuredClone(job);
  const { base, list } = prototypeOps(document);
  if (!list.length) return { job: document, expanded: false };
  const problems = []; const warnings = []; const captures = [];
  const ready = [];
  for (const { index, op } of list) {
    const own = dataProblems(op.data).map(p => problemFor(p, index, base));
    problems.push(...own);
    if (!isObject(op.data)) continue;
    const source = resolveSource(op.data);
    if (!source.ok) { problems.push(problemFor(source.problem, index, base)); continue; }
    if (!own.some(p => p.code === 'INPUT_INVALID' && /\/mapping/.test(p.pointer))) ready.push({ index, op, source });
  }
  let captureMs = 0;
  for (const { index, op, source } of ready) {
    const data = op.data;
    if (data.capture != null || data.captureSha256 != null) {
      const check = await captureCurrent(data, source.root);
      if (check.current) { captures.push({ op: index, capture: data.capture, captureSha256: data.captureSha256.toLowerCase(), reused: true, ...summaryOf(check.ir) }); continue; }
      warnings.push({ code: 'captureRefreshed', op: index, why: check.why });
    }
    const out = path.join(work ?? path.join(source.root, '.ssam-prototype'), 'op-' + index, 'bundle');
    const begin = now();
    let result;
    try {
      result = await capture({ source: source.root, entry: source.entry, mapping: isObject(data.mapping) ? data.mapping : {},
        ...(typeof data.clock === 'string' ? { clock: data.clock } : {}), tz: typeof data.tz === 'string' ? data.tz : 'UTC', out });
    } catch (error) { result = { ok: false, problems: [{ code: 'PROTOTYPE_IR_INVALID', ssamDefect: true, message: 'The capture threw: ' + clip(error?.message ?? error, 300) }] }; }
    captureMs += now() - begin;
    for (const w of Array.isArray(result?.warnings) ? result.warnings : []) warnings.push(isObject(w) ? { op: index, ...w } : { op: index, message: String(w) });
    if (result?.ok === true && typeof result.capturePath === 'string' && typeof result.sha256 === 'string') {
      data.capture = path.resolve(result.capturePath); data.captureSha256 = result.sha256.toLowerCase();
      captures.push({ op: index, capture: data.capture, captureSha256: data.captureSha256, entry: source.entry, ...(isObject(result.summary) ? { summary: result.summary } : {}) });
      continue;
    }
    const raw = Array.isArray(result?.problems) && result.problems.length ? result.problems
      : [{ code: 'PROTOTYPE_IR_INVALID', ssamDefect: true, message: 'The capture answered neither a bundle nor problems.' }];
    problems.push(...raw.map(p => problemFor(p, index, base)));
  }
  if (problems.length) return { refusal: prototypeRefusal(problems, document, { extra: warnings.length ? { warnings } : {} }) };
  return { job: document, expanded: true, captures, warnings, timings: { captureMs, expandMs: now() - started } };
}
const summaryOf = ir => (isObject(ir?.stats) ? { summary: { kind: ir.kind ?? null, ...ir.stats } } : {});

// A job file with prototype ops expanded into a new file of inlineDir; null when the job has none (nothing written).
// -> {path, sha256, expansion} | {refusal}
export async function expandJobFile(file, { inlineDir, work, capture = capturePrototype, now = Date.now, uuid = randomUUID } = {}) {
  const document = readJobDocument(file);
  if (!document || !hasPrototypeOps(document)) return null;
  const expansion = await expandPrototypeOps(document, { work: work ?? path.join(inlineDir, '..', '..', 'prototype', uuid()), capture, now });
  if (expansion.refusal) return { refusal: expansion.refusal };
  return { ...writeJobFile(inlineDir, expansion.job, uuid), expansion };
}
export function writeJobFile(inlineDir, document, uuid = randomUUID) {
  fs.mkdirSync(inlineDir, { recursive: true });
  const file = path.join(inlineDir, uuid() + '.json');
  const text = JSON.stringify(document, null, 2);
  fs.writeFileSync(file, text);
  return { path: file, sha256: sha256(text) };
}

// ---- 1.4.1: degradation of generated items
// The problems of one build: the CLI envelope (problems, data.problems, data.apply.problems, data.preflight.problems), a
// refused build phase ({refused: run}), an ODC apply ({problems}) or a delivery outcome ({problems}).
export function buildProblems(result) {
  const out = []; const seen = new Set();
  const add = list => { if (!Array.isArray(list)) return; for (const p of list) if (isObject(p)) { const key = JSON.stringify(p); if (!seen.has(key)) { seen.add(key); out.push(p); } } };
  const visit = value => {
    if (!isObject(value)) return;
    add(value.problems);
    for (const key of ['envelope', 'refused', 'data', 'apply', 'preflight', 'outcome', 'result']) if (isObject(value[key])) visit(value[key]);
  };
  visit(result);
  return out;
}
const sourceKey = p => (typeof p?.k === 'string' && p.k ? p.k : typeof p?.sourceKey === 'string' && p.sourceKey ? p.sourceKey : typeof p?.origin?.k === 'string' ? p.origin.k : null);
const propertyOf = p => [p?.property, p?.prop, p?.attribute].find(v => typeof v === 'string' && v) ?? null;
// The node of a capture by k, with its chain of ancestors (root first).
export function findNode(ir, k) {
  const roots = [];
  if (isObject(ir?.shell?.root)) roots.push(ir.shell.root);
  for (const v of Array.isArray(ir?.views) ? ir.views : []) if (isObject(v?.root)) roots.push(v.root);
  for (const m of Array.isArray(ir?.modals) ? ir.modals : []) if (isObject(m?.root)) roots.push(m.root);
  if (isObject(ir?.trees)) for (const t of Object.values(ir.trees)) if (isObject(t)) roots.push(t);
  for (const root of roots) {
    const stack = [[root, []]];
    while (stack.length) {
      const [node, chain] = stack.pop();
      if (!isObject(node)) continue;
      if (node.k === k) return { node, chain };
      const kids = Array.isArray(node.c) ? node.c : [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], [...chain, node]]);
    }
  }
  return null;
}
const attrOf = (node, name) => (Array.isArray(node?.a) ? node.a.find(a => Array.isArray(a) && a[0] === name)?.[1] : undefined);
const cssIdent = s => String(s).replace(/([^A-Za-z0-9_-])/g, '\\$1');
// A CSS selector of the node for mapping.ignore: from its nearest ancestor with an id (or the node's own id), each step tag
// plus classes plus :nth-child among element siblings.
export function selectorOf(ir, k) {
  const found = findNode(ir, k);
  if (!found || typeof found.node.t !== 'string') return null;
  const path_ = [...found.chain, found.node];
  const stepOf = (node, parent) => {
    const id = attrOf(node, 'id');
    if (typeof id === 'string' && id) return { anchor: true, text: '#' + cssIdent(id) };
    const classes = String(attrOf(node, 'class') ?? '').split(/\s+/).filter(Boolean).map(c => '.' + cssIdent(c)).join('');
    const siblings = Array.isArray(parent?.c) ? parent.c.filter(c => isObject(c) && typeof c.t === 'string') : [];
    const at = siblings.indexOf(node);
    return { anchor: false, text: node.t + classes + (parent && at >= 0 ? ':nth-child(' + (at + 1) + ')' : '') };
  };
  const steps = [];
  for (let i = path_.length - 1; i >= 0; i--) {
    const s = stepOf(path_[i], path_[i - 1]);
    steps.unshift(s.text);
    if (s.anchor) break;
  }
  return steps.join(' > ');
}
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'button', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'input', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'textarea', 'time', 'u', 'var']);
const textOf = node => (!isObject(node) ? '' : typeof node.x === 'string' ? node.x : (Array.isArray(node.c) ? node.c.map(textOf).join('') : ''));
// Property names of the native widget that come from an attribute of the element (3.2/3.3).
const PROPERTY_ATTRIBUTE = { style: 'class', customstyle: 'style', prompt: 'placeholder', maxlength: 'maxlength', enabled: 'disabled', mandatory: 'required', name: 'id', url: 'src' };
// The degradable items of the problems that name a generated k: {k, code, message, kind: property|node|event, property?, op}.
export function degradableItems(problems, document) {
  const captures = captureDocuments(document);
  const items = []; const seen = new Set();
  for (const p of problems ?? []) {
    const k = sourceKey(p); if (!k) continue;
    const owner = captures.find(c => (Array.isArray(c.ir?.events) && c.ir.events.some(e => e?.key === k)) || findNode(c.ir, k));
    if (!owner) continue;
    const isEvent = Array.isArray(owner.ir.events) && owner.ir.events.some(e => e?.key === k);
    const property = propertyOf(p);
    const kind = isEvent ? 'event' : property ? 'property' : 'node';
    const key = owner.op + ':' + k + ':' + kind + ':' + (property ?? '');
    if (seen.has(key)) continue; seen.add(key);
    items.push({ op: owner.op, k, code: String(p.code ?? 'BUILD_PROBLEM'), message: clip(p.message ?? p.detail ?? '', 300), kind, ...(property ? { property } : {}) });
  }
  return items;
}
// The capture IR of every prototype op of a job document (read from data.capture).
export function captureDocuments(document) {
  const out = [];
  for (const { index, op } of prototypeOps(document).list) {
    const file = op?.data?.capture;
    if (typeof file !== 'string' || !isFile(file)) continue;
    try { out.push({ op: index, file, ir: readJson(file) }); } catch { /* an unreadable capture degrades nothing */ }
  }
  return out;
}
// Degrades the items in one capture IR (a copy): property -> the attribute out (the widget stays); node -> a literal of
// the substitute tag with its class and its text (no children, no annotation); event -> not compiled. Returns {ir, done}.
export function degradeCapture(ir, items) {
  const copy = structuredClone(ir); const done = [];
  for (const item of items) {
    if (item.kind === 'event') {
      const event = (copy.events ?? []).find(e => e?.key === item.k);
      if (event) { event.compiled = false; done.push({ ...item, action: 'event not compiled (listed in events.notCompiled)' }); }
      const strip = node => { if (!isObject(node)) return; if (Array.isArray(node.events)) node.events = node.events.filter(e => e !== item.k); for (const c of node.c ?? []) strip(c); };
      for (const root of [copy.shell?.root, ...(copy.views ?? []).map(v => v?.root), ...(copy.modals ?? []).map(m => m?.root), ...Object.values(copy.trees ?? {})]) strip(root);
      continue;
    }
    const found = findNode(copy, item.k);
    if (!found) continue;
    const { node } = found;
    if (item.kind === 'property') {
      const wanted = String(item.property).toLowerCase();
      const attribute = (node.a ?? []).find(a => Array.isArray(a) && (a[0].toLowerCase() === wanted || a[0] === PROPERTY_ATTRIBUTE[wanted]));
      if (attribute) { node.a = node.a.filter(a => a !== attribute); done.push({ ...item, action: 'property ' + item.property + ' left out (attribute ' + attribute[0] + '); the widget stays' }); continue; }
    }
    const tag = typeof node.t === 'string' && INLINE.has(node.t) ? 'span' : 'div';
    const cls = attrOf(node, 'class');
    const text = textOf(node);
    for (const key of Object.keys(node)) if (!['k'].includes(key)) delete node[key];
    node.t = tag; node.a = typeof cls === 'string' && cls ? [['class', cls]] : [];
    node.c = text ? [{ k: item.k + '/0', x: text }] : [];
    done.push({ ...item, action: 'node made literal (' + tag + ' with its class and text)' });
  }
  return { ir: copy, done };
}
// Writes the degraded capture of every op next to its bundle (capture.degraded.json: the relative sheets/assets stay valid)
// and returns the job document pointing to them. -> {job, done}
export async function degradeJob(document, items) {
  const job = structuredClone(document); const done = [];
  const { list } = prototypeOps(job);
  for (const { index, op } of list) {
    const mine = items.filter(i => i.op === index);
    if (!mine.length || typeof op.data?.capture !== 'string') continue;
    const ir = readJson(op.data.capture);
    const degraded = degradeCapture(ir, mine);
    if (!degraded.done.length) continue;
    const file = path.join(path.dirname(op.data.capture), 'capture.degraded.json');
    fs.writeFileSync(file, JSON.stringify(degraded.ir));
    op.data.capture = file; op.data.captureSha256 = await irSha256(degraded.ir);
    done.push(...degraded.done);
  }
  return { job, done };
}
// The answer of a second failure: an SSAM defect, with the mapping.ignore patch of the nodes that still fail.
// The selectors are those of the prototype's own elements: computed on the capture before the degradation (selectorsFrom).
export function degradationRefusal({ document, problems, done, selectorsFrom = document }) {
  const original = modelJob(document);
  const { base } = prototypeOps(original);
  const captures = captureDocuments(selectorsFrom);
  const byOp = new Map();
  for (const p of problems) {
    const k = sourceKey(p); if (!k) continue;
    for (const c of captures) { const s = selectorOf(c.ir, k); if (s) { if (!byOp.has(c.op)) byOp.set(c.op, new Set()); byOp.get(c.op).add(s); break; } }
  }
  const patch = [];
  for (const [index, selectors] of byOp) {
    const data = opsOfDocument(original).ops[index]?.data ?? {};
    const existing = Array.isArray(data.mapping?.ignore) ? data.mapping.ignore : [];
    const ignore = [...new Set([...existing, ...selectors])];
    patch.push(isObject(data.mapping) ? { op: 'add', path: `${base}/${index}/data/mapping/ignore`, value: ignore } : { op: 'add', path: `${base}/${index}/data/mapping`, value: { ignore } });
  }
  const corrected = patch.length ? applyLenient(original, patch) : null;
  return { ok: false, outcome: 'refused', code: 'VALIDATION_REFUSED', ssamDefect: true, stage: 'build', failed: 'build',
    error: 'SSAM defect: the module generated from the prototype still fails the build after one rebuild without the failing items. Nothing was merged. '
      + (patch.length ? 'The patch leaves the remaining nodes out of the capture (mapping.ignore); apply it in ONE call.' : 'No node of the capture is named; report it.'),
    problems: problems.map(p => ({ phase: p.phase ?? 'build', op: Number.isInteger(p.op) ? p.op : null, pointer: p.pointer ?? null, code: String(p.code ?? 'BUILD_PROBLEM'), severity: 'error',
      message: clip(p.message ?? '', 600), fix: 'SSAM defect: leave the node out with mapping.ignore (the patch) and report it.', ...(sourceKey(p) ? { k: sourceKey(p) } : {}) })),
    ...(patch.length ? { patch, correctedJob: corrected } : {}), degraded: done };
}
// One build, and when it fails on generated items exactly one rebuild without them.
// attempt(jobFile, previous) -> result; ok(result) -> boolean; problemsOf(result) -> problems.
// -> {result, jobFile, sha256?, degraded, refusal?, rebuilt}
export async function buildWithDegradation({ jobFile, attempt, ok = r => r?.ok === true, problemsOf = buildProblems, inlineDir, journal = null, uuid = randomUUID }) {
  const first = await attempt(jobFile, null);
  if (ok(first)) return { result: first, jobFile, degraded: [], rebuilt: false };
  const document = readJobDocument(jobFile);
  if (!document || !hasPrototypeOps(document)) return { result: first, jobFile, degraded: [], rebuilt: false };
  const items = degradableItems(problemsOf(first), document);
  if (!items.length) return { result: first, jobFile, degraded: [], rebuilt: false };
  const { job, done } = await degradeJob(document, items);
  if (!done.length) return { result: first, jobFile, degraded: [], rebuilt: false };
  const written = writeJobFile(inlineDir ?? path.dirname(jobFile), job, uuid);
  try { journal?.({ event: 'prototype-degraded', job: written.path, items: done.map(d => ({ k: d.k, code: d.code, kind: d.kind, action: d.action })) }); } catch { /* the journal never changes the build */ }
  const second = await attempt(written.path, first);
  if (ok(second)) return { result: second, jobFile: written.path, sha256: written.sha256, degraded: done, rebuilt: true };
  const left = problemsOf(second);
  return { result: second, jobFile: written.path, sha256: written.sha256, degraded: done, rebuilt: true,
    refusal: degradationRefusal({ document: job, problems: left.length ? left : problemsOf(first), done, selectorsFrom: document }) };
}
// The lane journal line of a degradation (friction of the SSAM, never of the model), and the same event in the friction
// store (facade/friction-store.mjs recordEvent: metadata only, code PROTOTYPE_DEGRADED, step build) so the SSAM's own defect
// reaches the friction queue. Neither ever changes the build.
export const DEGRADED_CODE = 'PROTOTYPE_DEGRADED';
export const journalTo = (dir, { lane = 'unknown', record = recordFriction } = {}) => entry => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'prototype.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  try { record?.({ operation: 'build', lane, code: DEGRADED_CODE, step: 'build', outcome: 'failure' }); } catch { /* the journal line stands */ }
};
let frictionModule;
function recordFriction(event) {
  const load = frictionModule ??= import(new URL('../../../facade/friction-store.mjs', import.meta.url).href).catch(() => null);
  load.then(m => m?.recordEvent?.(event)).catch(() => {});
}

// ---- the kernel's report and the fidelity
// report.prototype of the kernel's apply data: data.prototype, data.report.prototype, or the result of the op "prototype".
export function kernelPrototypeReport(data) {
  if (!isObject(data)) return null;
  for (const candidate of [data.prototype, data.report?.prototype, data.apply?.prototype]) if (isObject(candidate)) return candidate;
  for (const list of [data.results, data.apply?.results]) {
    const hit = (Array.isArray(list) ? list : []).find(r => r?.op === 'prototype' && isObject(r.result));
    if (hit) return isObject(hit.result.prototype) ? hit.result.prototype : hit.result;
  }
  return null;
}
// prototype-dom.json (lane css, PrototypeSeams.Render): the path the report names, else next to the bundle, the candidate
// or the build work folders.
export function findNativeDom({ report = null, captures = [], dirs = [] } = {}) {
  const named = [report?.nativeDom, report?.dom, report?.prototypeDom, report?.fidelity?.nativeDom].find(v => typeof v === 'string' && v);
  const candidates = [named, ...captures.flatMap(c => (typeof c?.capture === 'string' ? [path.join(path.dirname(c.capture), 'prototype-dom.json'), path.join(path.dirname(c.capture), '..', 'prototype-dom.json')] : [])),
    ...dirs.filter(Boolean).flatMap(d => [path.join(d, 'prototype-dom.json'), path.join(d, 'model', 'prototype-dom.json'), path.join(d, 'work', 'prototype-dom.json')])];
  return candidates.find(f => typeof f === 'string' && isFile(f)) ?? null;
}
let fidelityModule;
export async function measurePrototypeFidelity({ captures = [], nativeDom, measure = null, now = Date.now } = {}) {
  const started = now();
  if (!nativeDom || !isFile(nativeDom)) return { fidelity: { measured: false, why: 'the built module was not read back (no prototype-dom.json)' }, fidelityMs: now() - started };
  let fn = measure;
  if (!fn) { if (fidelityModule === undefined) fidelityModule = await import('./prototype/fidelity.mjs').catch(() => null); fn = fidelityModule?.measureFidelity ?? null; }
  if (typeof fn !== 'function') return { fidelity: { measured: false, why: 'the fidelity engine of this release (prototype/fidelity.mjs) is not there' }, fidelityMs: now() - started };
  try {
    const dom = readJson(nativeDom);
    const results = [];
    // the bundle folder gives the measure the prototype's own sheets (the selector match sets of 4.4 b)
    for (const c of captures) { if (typeof c?.capture !== 'string' || !isFile(c.capture)) continue; results.push(await fn({ capture: readJson(c.capture), nativeDom: dom, bundle: path.dirname(c.capture) })); }
    return { fidelity: results.length === 1 ? results[0] : results.length ? { perOp: results, score: Math.min(...results.map(r => (typeof r?.score === 'number' ? r.score : 0))) } : { measured: false, why: 'no capture' }, fidelityMs: now() - started };
  } catch (error) { return { fidelity: { measured: false, why: 'the fidelity measure failed: ' + clip(error.message, 300) }, fidelityMs: now() - started }; }
}

// ---- the receipt (1.4)
const EFFECTS = ['navigate', 'openPopup', 'closePopup', 'setDimension', 'toggle', 'increment', 'remove', 'update', 'insert', 'upsert', 'insertFrom', 'updateFrom', 'removeWhere', 'validate', 'toast'];
const COUNT_KEYS = ['ops', 'widgets', 'extendedProperties', 'screenActions', 'serverActions', 'ifWidgets', 'lists'];
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function verifyWarningsOf(report, verify) {
  if (isObject(report?.verifyWarnings) && isObject(report.verifyWarnings.byCode)) return { total: num(report.verifyWarnings.total) ?? Object.values(report.verifyWarnings.byCode).reduce((n, v) => n + (num(v) ?? 0), 0), byCode: report.verifyWarnings.byCode };
  const byCode = {};
  for (const w of Array.isArray(verify) ? verify : []) { const id = String(w?.id ?? w?.code ?? 'Warning').split(/[\s:]/)[0]; byCode[id] = (byCode[id] ?? 0) + 1; }
  return { total: Object.values(byCode).reduce((n, v) => n + v, 0), byCode };
}
function fidelityOf(report, measured) {
  const own = isObject(report?.fidelity) ? report.fidelity : {};
  const m = isObject(measured) ? measured : {};
  const out = { states: 0, elements: { prototype: 0, matched: 0 }, score: null, classes: { prototype: 0, matched: 0 }, texts: { prototype: 0, matched: 0 },
    attributes: { prototype: 0, matched: 0 }, selectors: { rules: 0, selectors: 0, equal: 0, gained: 0, lost: 0 }, css: { verbatim: null, rules: 0, rewrites: [] },
    wrappers: [], runtimeUnverified: [], references: [], unevaluable: [], perState: [], mismatches: [], ...own, ...m };
  // The construction facts come from the kernel (css, wrappers, runtimeUnverified); the comparison from the measure.
  for (const key of ['css', 'wrappers', 'runtimeUnverified', 'references']) if (own[key] != null && m[key] == null) out[key] = own[key];
  if (m.measured === false) { out.measured = false; out.why = m.why; }
  return out;
}
// kernelReport: report.prototype of the kernel (or null). fidelity: the measure (prototype/fidelity.mjs) or {measured:false}.
// phases: {captureMs, expandMs, buildMs, verifyMs, fidelityMs, mergeMs, publishMs, seedMs} as measured by the facade
// (null for a phase that did not run). seed: the seed result. degraded: the items of 1.4.1. verify: the new Verify
// warnings (when the kernel did not count them). captures: the expansion's captures. warnings: the expansion's warnings.
export function prototypeReceipt(kernelReport, { fidelity = null, phases = {}, seed = null, degraded = [], verify = null, captures = [], warnings = [], links = null } = {}) {
  const k = isObject(kernelReport) ? kernelReport : {};
  const first = captures[0] ?? {};
  const timings = {};
  for (const key of TIMING_KEYS) timings[key] = num(phases[key]) ?? num(k.timings?.[key]);
  const events = isObject(k.events) ? k.events : {};
  const byEffect = Object.fromEntries(EFFECTS.map(e => [e, num(events.byEffect?.[e]) ?? 0]));
  const counts = Object.fromEntries(COUNT_KEYS.map(c => [c, num(k.counts?.[c]) ?? 0]));
  // The screens as the kernel built them (renamedFrom and why kept), each with its link when the delivery named the app.
  const screens = Array.isArray(k.screens) ? k.screens : [];
  const linked = links ? screens.map(s => (isObject(s) && typeof s.name === 'string' && links[s.name] ? { ...s, url: links[s.name] } : s)) : screens;
  const seeded = isObject(seed) ? seed : { ran: false, entities: 0, rows: 0, skippedNotEmpty: [] };
  const data = isObject(k.data) ? k.data : {};
  const entities = (Array.isArray(data.entities) ? data.entities : []).map(e => {
    const s = (seeded.seeded ?? []).find(x => x.entity === e?.name);
    return isObject(e) ? { ...e, seeded: s ? s.rows : num(e.seeded) ?? 0 } : e;
  });
  return {
    schema: RECEIPT_SCHEMA,
    source: { ...(isObject(k.source) ? k.source : {}), ...(first.captureSha256 && !k.source?.captureSha256 ? { captureSha256: first.captureSha256 } : {}) },
    flow: k.flow ?? null, theme: k.theme ?? null,
    screens: linked,
    blocks: Array.isArray(k.blocks) ? k.blocks : [],
    popups: Array.isArray(k.popups) ? k.popups : [],
    resources: isObject(k.resources) ? k.resources : { images: [], icons: null, imports: [] },
    data: { staticEntities: [], extraAttributes: [], serverActions: 0, sql: 0, clientVariables: [], ...data, entities },
    events: { total: num(events.total) ?? 0, compiled: num(events.compiled) ?? 0, ...events, byEffect, notCompiled: Array.isArray(events.notCompiled) ? events.notCompiled : [], targetGuarded: Array.isArray(events.targetGuarded) ? events.targetGuarded : [] },
    fidelity: fidelityOf(k, fidelity),
    verifyWarnings: verifyWarningsOf(k, verify),
    degraded: [...(Array.isArray(k.degraded) ? k.degraded : []), ...degraded.map(d => ({ k: d.k, code: d.code, message: d.message, kind: d.kind, done: d.action }))],
    seed: { ran: seeded.ran === true, entities: num(seeded.entities) ?? 0, rows: num(seeded.rows) ?? 0, skippedNotEmpty: Array.isArray(seeded.skippedNotEmpty) ? seeded.skippedNotEmpty : [],
      ...(seeded.reason ? { reason: seeded.reason } : {}), ...(Array.isArray(seeded.failed) && seeded.failed.length ? { failed: seeded.failed } : {}) },
    counts,
    capture: { probes: num(k.capture?.probes) ?? num(first.summary?.probes) ?? 0, windows: num(k.capture?.windows) ?? num(first.summary?.windows) ?? 0,
      pool: num(k.capture?.pool) ?? num(first.summary?.pool) ?? null, ...(captures.length ? { reused: captures.every(c => c.reused === true) } : {}) },
    timings,
    outOfScope: Array.isArray(k.outOfScope) ? k.outOfScope : [],
    padroes: isObject(k.padroes) ? k.padroes : { notes: [] },
    modelBytes: num(k.modelBytes) ?? 0,
    ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}),
  };
}

// The receipt with the seed's result (seed, the rows per entity, seedMs).
export function receiptWithSeed(receipt, seed) {
  if (!isObject(receipt) || !isObject(seed)) return receipt;
  return { ...receipt, seed: { ran: seed.ran === true, entities: num(seed.entities) ?? 0, rows: num(seed.rows) ?? 0, skippedNotEmpty: Array.isArray(seed.skippedNotEmpty) ? seed.skippedNotEmpty : [],
    ...(seed.reason ? { reason: seed.reason } : {}), ...(Array.isArray(seed.failed) && seed.failed.length ? { failed: seed.failed } : {}) },
    data: { ...receipt.data, entities: (receipt.data?.entities ?? []).map(e => { const s = (seed.seeded ?? []).find(x => x.entity === e?.name); return s ? { ...e, seeded: s.rows } : e; }) },
    timings: { ...receipt.timings, seedMs: num(seed.seedMs) } };
}

// ---- the ready call (1.1), for the discover route, the guides and the CLI
export function prototypeCall({ lane = 'o11', source = '<pasta do protótipo>', module = '<módulo aberto>', prefix = null, rehearsal = false } = {}) {
  const job = { ops: [{ op: 'prototype', data: { source } }] };
  if (lane === 'odc') {
    const p = prefix ?? '<Prefixo>';
    return { tool: 'studio_deliver', arguments: { feature: 'Protótipo ' + p, module, job, owners: [p], changes: ['Protótipo ' + p + ' importado como telas nativas'],
      ...(rehearsal ? { until: 'preview' } : { publish: true, authorize: WORDS_MARKER }) } };
  }
  return { tool: 'o11_deliver', arguments: { module, job, ...(rehearsal ? { until: 'apply' } : { publish: true, authorize: WORDS_MARKER }) } };
}
// The ODC delivery fields a prototype job implies when the call leaves them out (owners [<prefix>], changes, feature).
export function prototypeDeliveryDefaults(document, args = {}) {
  const { list } = prototypeOps(document);
  if (!list.length) return null;
  const prefixes = [...new Set(list.map(({ op }) => inferPrefix(op.data ?? {}).prefix).filter(Boolean))];
  if (!prefixes.length) return null;
  const name = prefixes.join(', ');
  return { ...(typeof args.feature === 'string' && args.feature.trim() ? {} : { feature: 'Protótipo ' + name }),
    ...(Array.isArray(args.owners) && args.owners.length ? {} : { owners: prefixes }),
    ...(Array.isArray(args.changes) && args.changes.length ? {} : { changes: prefixes.map(p => 'Protótipo ' + p + ' importado como telas nativas') }) };
}

// ---- CLI: ssam prototype <folder> --lane o11|odc --module <M> [--base <oml>] [--dry] [--prefix P] [--entry E] [--out <oml>]
export function parsePrototypeArguments(argv, { cwd = process.env.SSAM_CLIENT_CWD || process.cwd() } = {}) {
  const out = { lane: 'o11', dry: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (['--lane', '--module', '--base', '--prefix', '--entry', '--out', '--clock', '--tz'].includes(a)) { const v = argv[++i]; if (v === undefined) throw new Error('Usage: ' + a + ' needs a value'); out[a.slice(2)] = v; }
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a + '. Usage: ssam prototype <folder> --lane o11|odc --module <M> [--base <oml>] [--dry]');
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error('Usage: ssam prototype <folder> --lane o11|odc --module <M> [--base <oml>] [--dry]');
  if (!['o11', 'odc'].includes(out.lane)) throw new Error('--lane is o11 or odc');
  out.source = path.resolve(cwd, positional[0]);
  if (out.base) out.base = path.resolve(cwd, out.base);
  if (out.out) out.out = path.resolve(cwd, out.out);
  return out;
}
// deps: runJob (job-runner.mjs runJob, with its own deps: root, env, runAnvil, worker, capturePrototype...), print.
export async function prototypeCli(argv, deps = {}) {
  let request;
  try { request = parsePrototypeArguments(argv, deps.cwd ? { cwd: deps.cwd } : {}); }
  catch (error) { return { ok: false, code: 'INPUT_INVALID', error: error.message }; }
  const data = { source: request.source, ...(request.entry ? { entry: request.entry } : {}), ...(request.prefix ? { prefix: request.prefix } : {}),
    ...(request.clock ? { clock: request.clock } : {}), ...(request.tz ? { tz: request.tz } : {}) };
  const call = prototypeCall({ lane: request.lane, source: request.source, module: request.module ?? '<módulo aberto>', prefix: request.prefix ?? inferPrefix(data).prefix });
  if (!request.dry) return { ok: false, code: 'DELIVERY_NEEDS_WORDS', lane: request.lane,
    error: 'The CLI only rehearses (--dry with --base <oml>): the import into a Studio is ONE MCP call with the owner\'s words, which also publish and load the demo data.', continuation: { ...call, why: 'the one call of the import; authorize: as palavras do usuário no lugar do marcador' } };
  if (!request.base) return { ok: false, code: 'INPUT_INVALID', error: '--dry needs --base <oml>: the local OML the rehearsal applies the import to.' };
  if (!isFile(request.base)) return { ok: false, code: 'FILE_NOT_FOUND', error: 'No base OML at ' + request.base };
  const run = deps.runJob ?? (await import('./job-runner.mjs')).runJob;
  const value = await run({ lane: request.lane, job: { ops: [{ op: 'prototype', data }] }, base: request.base, ...(request.out ? { out: request.out } : {}) }, deps.jobDeps ?? {});
  return { ...value, dry: true, ...(request.module ? { module: request.module } : {}), next: call };
}

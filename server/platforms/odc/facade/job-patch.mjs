// A refused job corrected by a small patch instead of the whole job again (measured: resending the job costs ~48 s a
// correction, a patch ~5-8 s, and no Read+Edit of the file). The subset of JSON Patch (RFC 6902) a job needs: add,
// remove, replace, test; at most 500 operations; paths only inside the job's ops (/ops/<i>/... of {ops:[...]},
// /<i>/... of an array job) and the expectedMessages of an {ops} job (/expectedMessages/-), never base, expectValid or a
// composite job's parts. The base is either a job file a
// refusal named ({job, sha256}) or the job of an O11 kernel delivery task ({taskId}: request.JobPath of
// <lane.work>/deliver/<taskId>/task.json, checked against the sha256 the kernel recorded in its sources or, on every task,
// in its job record {path, sha256}: a refused preflight keeps no sources, only that record). The bytes
// read are the bytes hashed: a base that changed since the refusal is refused (BASE_CHANGED). The patched job goes to a
// NEW file <inlineDir>/<uuid>.json; the base is never rewritten, and nothing is added to the job (the kernel may refuse
// unknown fields): the provenance goes to a journal only. The kernel resolves a job's own references from the job's
// folder, so the copy in inlineDir has each reference of the base that would resolve elsewhere from there pinned to the
// file it named from the base's folder (pinReferences). No shell, no Python, no network.
//
// Patch by name (lane "patch por nome", 2026-10-10: a model counting positions in a 60 KB job rewrote the whole job
// instead, ~2.5 min a correction). A path may name elements instead of counting them:
//   - a segment that is not a number, inside an array of objects, is the element whose identity equals it; the identity
//     of an element is its first non-empty text among name, as, key, id, label (IDENTITY_KEYS: an action by name, a step
//     by as, a record by name); zero or several matches refuse the patch (PATCH_NAME_NOT_FOUND, PATCH_NAME_AMBIGUOUS) with
//     the candidates. A segment of digits is always an index; "-" appends (add only).
//   - a path without the leading "/" is the same path ("ops/0/name" = "/ops/0/name").
//   - a shortcut without /ops/<i>/data: a first segment that is not ops nor expectedMessages (nor an index, in an array
//     job) is a list of the ops' data (actions, entities, structures, static, screens, methods...): "actions/<Name>/..."
//     is the only element named so in the data.actions of every op; an index or "-" after it needs a single op holding
//     that list; add of a new name appends to the last op holding it.
//   The resolution is the numeric patch of always, applied in order over the job of basedOn (sha256 checked).
// Partial job (mergePartialJob): basedOn + job that brings only the changed or new elements. An element of a named list
// in data (actions, entities, structures, static, screens, methods...) with the identity (and owner, when it has one) of
// an element of the same list in an op of the same verb replaces it; a new one is appended to the last such op; an op
// whose verb (and other data) no op has is a new op. A raw op replaces the op with its identity (set: target+prop;
// create/duplicate: as, else parent+type+name; delete/move/rename/layout: target; link: from+connector, else from+to;
// reference: producer+as; html: parent); others are appended. An html page op (data.screen, no parent) is identified by
// its screen, without regard to case: it takes each field of data the partial brings (vars and the other named lists by
// name) and keeps the rest; never a second page of one screen. New ops go to the end, a reference after the last
// reference, a spec before the first logic/screen/html op. Nothing is removed: removal is a patch remove. A patch given
// with it applies after the merge. The whole job generated is the new file, and its sha256 the next basedOn.
// namedPatch: the numeric patch of a refusal written by name, checked by resolving it back (patchByName).
import { appendJsonLine } from './correlation.mjs';
import fs from 'node:fs';
import { isProducerName } from './producer-names.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeCodeOps } from './ssam-code.mjs';
import { readVerifiedPatch, verifiedPatchFile } from './verified-patch.mjs';
export { verifiedPatchFile };

// 500 since 20/10/2026 (goal list of 2026-10-20, item 4, report d9398179: a refusal with 61 fixes could not be answered in one call at 50,
// against the rule "correct everything in one call"); the bound only keeps a runaway call out.
export const PATCH_MAX_OPS = 500;
export const PATCH_OPS = Object.freeze(['add', 'remove', 'replace', 'test']);
export const IDENTITY_KEYS = Object.freeze(['name', 'as', 'key', 'id', 'label']);
const SHA256 = /^[a-fA-F0-9]{64}$/;
const TASK_ID = /^[0-9a-fA-F]{32}$/;
const INDEX = /^(?:0|[1-9][0-9]*)$/;
const DIGITS = /^[0-9]+$/;
const OP_KEYS = new Set(['op', 'path', 'value']);
const CANDIDATES_MAX = 30;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

export class PatchError extends Error {
  constructor(code, message, at, candidates) {
    super(message); this.code = code; if (at != null) this.at = at;
    if (Array.isArray(candidates) && candidates.length) this.candidates = candidates.slice(0, CANDIDATES_MAX);
  }
}
// The fields of a refusal for a PatchError: at (the operation index) and the candidates of a name.
export const patchErrorFields = error => ({ ...(error.at != null ? { at: error.at } : {}), ...(error.candidates ? { candidates: error.candidates } : {}) });

// The identity of an element: its first non-empty text among IDENTITY_KEYS; null when it has none.
export function identityOf(element) {
  if (!isObject(element)) return null;
  for (const key of IDENTITY_KEYS) if (typeof element[key] === 'string' && element[key]) return element[key];
  return null;
}
const escapeToken = t => String(t).replace(/~/g, '~0').replace(/\//g, '~1');
const toPointer = tokens => '/' + tokens.map(escapeToken).join('/');

// The JSON Schema of the two arguments, for tools registered from JSON Schema (ssam.mjs o11_job / ssam_job and the
// studio_deliver proxy). o11-cycle.mjs declares the same shape in zod.
export const patchJsonSchema = Object.freeze({
  anyOf: [{ type: 'array', minItems: 1, maxItems: PATCH_MAX_OPS,
    items: { type: 'object', additionalProperties: false, required: ['op', 'path'],
      properties: { op: { type: 'string', enum: [...PATCH_OPS] }, path: { type: 'string', minLength: 1 }, value: {} } } },
  { type: 'string', enum: ['verified'] }],
  description: 'JSON Patch (RFC 6902: add, remove, replace, test; at most 500) over the job of basedOn, paths /ops/<i>/... '
    + '(or /<i>/... of an array job) and /expectedMessages/- (a declaration {id, element, why} a refusal asked for). '
    + 'A path may name elements instead of counting them: actions/<Action>/steps/<as>/assign/<Var> (a list of the ops\' data '
    + 'first, then names: name, as, key, id or label; digits stay an index); a refusal gives each patch by name too (patchByName). '
    + 'Instead of job (or after a partial job given in job with basedOn): the patched job is written to a new file. '
    + '"verified": every verified patch of the refusal of that job (its verifiedPatch.call).',
});
export const basedOnJsonSchema = Object.freeze({
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['job', 'sha256'],
      properties: { job: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: SHA256.source } } },
    { type: 'object', additionalProperties: false, required: ['taskId'],
      properties: { taskId: { type: 'string', pattern: TASK_ID.source }, sha256: { type: 'string', pattern: SHA256.source } } },
  ],
  description: 'The job the patch (or a partial job: only the changed or new elements in job) applies to: {job, sha256} as an answer '
    + 'returned them (nextBasedOn), or {taskId} of an O11 delivery task.',
});

// ---- JSON Patch over the ops of one job
// A path without the leading "/" is the same path: a path by name reads as one (actions/<Name>/steps/<as>/...).
function pointer(text, at, label) {
  if (typeof text !== 'string') throw new PatchError('PATCH_INVALID', `${label}: path must be a JSON pointer such as /ops/0/value`, at);
  if (/~(?![01])/.test(text)) throw new PatchError('PATCH_INVALID', `${label}: "~" in a path is written ~0 ("/" is ~1)`, at);
  const rooted = text === '' || text.startsWith('/') ? text : '/' + text;
  return rooted === '' ? [] : rooted.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// ---- names in a path
const namesOf = array => [...new Set(array.map(identityOf).filter(Boolean))];
const isName = token => typeof token === 'string' && token !== '' && token !== '-' && !DIGITS.test(token);
const hitsOf = (array, name) => array.reduce((hits, e, i) => (identityOf(e) === name ? [...hits, i] : hits), []);
// The index of the only element of `array` named `name` (where: the array's tokens, for the candidates' pointers).
function nameIn(array, name, where, at, label) {
  const hits = hitsOf(array, name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new PatchError('PATCH_NAME_AMBIGUOUS', `${label}: "${name}" names ${hits.length} elements of ${toPointer(where)}; write the index (candidates) or name a longer path`,
    at, hits.map(i => toPointer([...where, i])));
  throw new PatchError('PATCH_NAME_NOT_FOUND', `${label}: no element of ${toPointer(where)} is named "${name}" (name, as, key, id or label); candidates are the names there`, at, namesOf(array));
}
const existingByName = (label, name, at) => new PatchError('PATCH_INVALID',
  `${label}: an element named "${name}" exists; add inserts before an index: replace it, or append a new one with - (or with its new name)`, at);

// The shortcut "<list>/<name>/..." (or "<list>/<i>|-/...") over the ops holding data.<list>: the tokens from the root.
function shortcut(ops, holders, tokens, prefix, op, value, at, label) {
  const [list, second, ...rest] = tokens;
  const where = i => [...prefix, String(i), 'data', list];
  if (!isName(second)) {
    if (holders.length !== 1) throw new PatchError('PATCH_NAME_AMBIGUOUS', `${label}: ${holders.length} ops hold data.${list}; name the element (${list}/<name>) or write ${toPointer([...prefix, '<i>', 'data', list])}`,
      at, holders.map(i => toPointer(where(i))));
    return [...where(holders[0]), ...tokens.slice(1)];
  }
  const hits = holders.flatMap(i => hitsOf(ops[i].data[list], second).map(j => [i, j]));
  if (hits.length === 1) {
    if (op === 'add' && !rest.length) throw existingByName(label, second, at);
    return [...where(hits[0][0]), String(hits[0][1]), ...rest];
  }
  if (hits.length > 1) throw new PatchError('PATCH_NAME_AMBIGUOUS', `${label}: "${second}" names ${hits.length} elements of data.${list}; write /ops/<i>/data/${list}/<j> (candidates) or name a longer path`,
    at, hits.map(([i, j]) => toPointer([...where(i), j])));
  // A new name appended by add: to the last op holding the list.
  if (op === 'add' && !rest.length && identityOf(value) === second) return [...where(holders.at(-1)), '-'];
  throw new PatchError('PATCH_NAME_NOT_FOUND', `${label}: no element of data.${list} is named "${second}" (name, as, key, id or label); candidates are the names there`,
    at, [...new Set(holders.flatMap(i => namesOf(ops[i].data[list])))]);
}

// R1 (plano 24/10): a path rooted the other way is read as the one it can only mean, and said (notes): /<i>/... of an
// {ops} job is /ops/<i>/...; /ops/<i>/... of an array job is /<i>/...; a first segment that names one op of an {ops} job
// (name, as, key, id or label) is that op. Without notes (namedPatch's check) nothing is re-rooted.
function rooted(job, tokens, at, notes) {
  const ops = opsOf(job);
  if (!notes || !ops || !tokens.length) return tokens;
  const said = (to, why) => { notes.push({ rule: 'patch-path', at: '/patch/' + at, note: toPointer(tokens) + ' is ' + toPointer(to) + ': ' + why }); return to; };
  if (!Array.isArray(job) && INDEX.test(tokens[0]) && Number(tokens[0]) < ops.length) return said(['ops', ...tokens], 'the ops of an {ops} job are /ops/<i>');
  if (Array.isArray(job) && tokens[0] === 'ops' && tokens.length > 1 && !ops.some(o => isObject(o) && identityOf(o) === 'ops')) return said(tokens.slice(1), 'an array job is its ops: /<i>');
  if (!Array.isArray(job) && isName(tokens[0]) && !['ops', 'expectedMessages'].includes(tokens[0])
    && !ops.some(o => isObject(o) && isObject(o.data) && Array.isArray(o.data[tokens[0]]))) {
    const hits = hitsOf(ops, tokens[0]);
    if (hits.length === 1) return said(['ops', String(hits[0]), ...tokens.slice(1)], 'the op named ' + tokens[0]);
  }
  return tokens;
}
// The tokens of a path with every name replaced by its index (the shortcut expanded). A part of the path that does not
// exist is left as written: applyOne then says what is missing, as for a numeric path. notes (R1): the readings taken as
// meant (rooted, and a list of an op's data written without its data segment: /ops/<i>/actions/... is /ops/<i>/data/actions/...).
function resolveTokens(job, tokens, op, value, at, label, notes = null) {
  const ops = opsOf(job);
  let out = rooted(job, tokens, at, notes);
  if (ops && tokens.length && isName(out[0]) && (Array.isArray(job) || !['ops', 'expectedMessages'].includes(out[0]))) {
    const holders = ops.map((o, i) => (isObject(o) && isObject(o.data) && Array.isArray(o.data[out[0]]) ? i : -1)).filter(i => i >= 0);
    if (holders.length) out = shortcut(ops, holders, out, Array.isArray(job) ? [] : ['ops'], op, value, at, label);
    else if (!Array.isArray(job)) return out; // not a list of the ops' data: area() refuses it as before
  }
  const resolved = [];
  let node = job;
  for (let k = 0; k < out.length; k++) {
    let token = out[k];
    const last = k === out.length - 1;
    if (Array.isArray(node) && isName(token) && node.some(isObject)) {
      const hits = hitsOf(node, token);
      if (last && op === 'add' && !hits.length && identityOf(value) === token) { resolved.push('-'); return resolved; }
      if (last && op === 'add' && hits.length === 1) throw existingByName(label, token, at);
      token = String(nameIn(node, token, resolved, at, label));
    }
    if (notes && ops?.includes(node) && token !== 'data' && !Object.hasOwn(node, token) && isObject(node.data) && Object.hasOwn(node.data, token) && !(last && op === 'add')) {
      notes.push({ rule: 'patch-path', at: '/patch/' + at, note: token + ' of op ' + toPointer(resolved.slice(0, -1)) + ' is in its data: ' + toPointer([...resolved, 'data', token]) });
      resolved.push('data'); node = node.data;
    }
    resolved.push(token);
    if (last) break;
    const next = Array.isArray(node) ? (INDEX.test(token) ? node[Number(token)] : undefined) : isObject(node) && Object.hasOwn(node, token) ? node[token] : undefined;
    if (next === null || typeof next !== 'object') return [...resolved, ...out.slice(k + 1)];
    node = next;
  }
  return resolved;
}

// The ops array a patch may touch: the job itself (array job) or job.ops ({ops:[...]}, not a composite {jobs}).
const opsOf = job => (Array.isArray(job) ? job : job && typeof job === 'object' && job.jobs == null && Array.isArray(job.ops) ? job.ops : null);

// The job's ops, and the expectedMessages of a {ops} job (the declarations a refusal asks for: adding one is a patch, not
// the whole job again). An array job has no expectedMessages; base, expectValid and a composite's parts stay closed.
function area(tokens, job, at, label) {
  const inside = Array.isArray(job) ? tokens.length >= 1
    : (tokens.length >= 2 && tokens[0] === 'ops') || (tokens.length >= 1 && tokens[0] === 'expectedMessages');
  if (!inside) throw new PatchError('PATCH_PATH_FORBIDDEN', `${label}: only the job's ops${Array.isArray(job) ? '' : ' and expectedMessages'} are patched (${Array.isArray(job) ? '/<i>/...' : '/ops/<i>/..., /expectedMessages/-'}`
    + `, or a list of the ops' data by name such as actions/<Name>/...)`, at);
  if (tokens.includes('__proto__')) throw new PatchError('PATCH_PATH_FORBIDDEN', `${label}: "__proto__" is not a job key`, at);
}

function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

// One operation on the (cloned) job. Every location but the last token must exist (RFC 6902 4.1). The numeric path it
// resolved to (names replaced by indices) goes to `resolved` when given.
function applyOne(job, operation, at, resolved, notes = null) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new PatchError('PATCH_INVALID', `patch[${at}] is not an object {op, path, value?}`, at);
  const extra = Object.keys(operation).filter(k => !OP_KEYS.has(k));
  const { op, path: where } = operation;
  const label = `patch[${at}] ${typeof op === 'string' ? op : '?'} ${typeof where === 'string' ? where : '?'}`;
  if (extra.length) throw new PatchError('PATCH_INVALID', `${label}: unknown key(s) ${extra.join(', ')} (op, path, value)`, at);
  if (!PATCH_OPS.includes(op)) throw new PatchError('PATCH_INVALID', `${label}: op is one of ${PATCH_OPS.join(', ')} (move/copy: remove + add)`, at);
  if (op !== 'remove' && !Object.hasOwn(operation, 'value')) throw new PatchError('PATCH_INVALID', `${label}: ${op} needs value`, at);
  const tokens = resolveTokens(job, pointer(where, at, label), op, operation.value, at, label, notes);
  area(tokens, job, at, label);
  resolved?.push({ op, path: toPointer(tokens), ...(Object.hasOwn(operation, 'value') ? { value: operation.value } : {}) });
  const missing = upTo => new PatchError('PATCH_INVALID', `${label}: no value at ${'/' + tokens.slice(0, upTo).map(t => t.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`, at);
  let parent = job;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (Array.isArray(parent) ? !(INDEX.test(token) && Number(token) < parent.length) : !(parent && typeof parent === 'object' && Object.hasOwn(parent, token))) throw missing(i + 1);
    parent = Array.isArray(parent) ? parent[Number(token)] : parent[token];
  }
  const key = tokens.at(-1);
  if (!parent || typeof parent !== 'object') throw missing(tokens.length - 1);
  const value = op === 'remove' ? undefined : structuredClone(operation.value);
  if (Array.isArray(parent)) {
    if (op === 'add' && key === '-') { parent.push(value); return; }
    if (!INDEX.test(key)) throw new PatchError('PATCH_INVALID', `${label}: "${key}" is not an array index${op === 'add' ? ' (or - to append)' : ''}`, at);
    const index = Number(key);
    if (op === 'add') { if (index > parent.length) throw missing(tokens.length); parent.splice(index, 0, value); return; }
    if (index >= parent.length) throw missing(tokens.length);
    if (op === 'remove') parent.splice(index, 1);
    else if (op === 'replace') parent[index] = value;
    else if (!jsonEqual(parent[index], operation.value)) throw new PatchError('PATCH_TEST_FAILED', `${label}: the value there differs; nothing was patched`, at);
    return;
  }
  if (op === 'add') { parent[key] = value; return; }
  if (!Object.hasOwn(parent, key)) throw missing(tokens.length);
  if (op === 'remove') delete parent[key];
  else if (op === 'replace') parent[key] = value;
  else if (!jsonEqual(parent[key], operation.value)) throw new PatchError('PATCH_TEST_FAILED', `${label}: the value there differs; nothing was patched`, at);
}

// The patched copy of a job (the job given is never changed) and the numeric patch it resolved to. All operations or
// none: the first failure throws a PatchError {code, message, at, candidates?}.
export function patchJob(job, patch, { max = PATCH_MAX_OPS } = {}) {
  if (!Array.isArray(patch) || patch.length === 0) throw new PatchError('PATCH_INVALID', 'patch is a non-empty array of {op, path, value?}');
  if (patch.length > max) throw new PatchError('PATCH_INVALID', `patch has ${patch.length} operations; at most ${PATCH_MAX_OPS} (send only the changed elements as a partial job with basedOn instead)`);
  if (!opsOf(job)) throw new PatchError('PATCH_PATH_FORBIDDEN', 'only a job with ops ({ops:[...]} or an array of ops) is patched; a composite {jobs} job is patched in its part file');
  const copy = structuredClone(job);
  const resolved = [], notes = [];
  patch.forEach((operation, at) => applyOne(copy, operation, at, resolved, notes));
  const ops = opsOf(copy);
  if (!ops.length) throw new PatchError('PATCH_INVALID', 'the patched job has no ops left');
  const bad = ops.findIndex(o => !o || typeof o !== 'object' || Array.isArray(o));
  if (bad >= 0) throw new PatchError('PATCH_INVALID', `the patched job's op #${bad} is not an object`);
  return { job: copy, resolved, named: resolved.some((r, i) => r.path !== toPointer(pointer(patch[i].path, i, ''))), notes };
}
export const applyJobPatch = (job, patch) => patchJob(job, patch).job;

// ---- the numeric patch of a refusal, written by name
const countIn = (array, id) => array.reduce((n, e) => n + (identityOf(e) === id ? 1 : 0), 0);
const nameable = id => isName(id);
// The tokens of a numeric path with each index replaced by the name of its element when that name is unique where it is,
// and /ops/<i>/data/<list>/<j> as the shortcut <list>/<name> when that name is unique in every op's list. Null when the
// path names nothing. The last token of an add stays as written (an insert position, not an element).
function nameTokens(job, tokens, op) {
  const ops = opsOf(job);
  const array = Array.isArray(job);
  const at = array ? 0 : 1;
  if (!ops || (!array && tokens[0] !== 'ops') || !INDEX.test(tokens[at] ?? '')) return null;
  const opNode = ops[Number(tokens[at])];
  if (!isObject(opNode)) return null;
  const keep = k => op === 'add' && k === tokens.length - 1;
  let head = null; let node; let k;
  const list = tokens[at + 2];
  if (tokens[at + 1] === 'data' && isObject(opNode.data) && Array.isArray(opNode.data[list]) && INDEX.test(tokens[at + 3] ?? '') && !keep(at + 3)) {
    const element = opNode.data[list][Number(tokens[at + 3])];
    const id = identityOf(element);
    const total = ops.reduce((n, o) => n + (isObject(o) && isObject(o.data) && Array.isArray(o.data[list]) ? countIn(o.data[list], id) : 0), 0);
    if (nameable(id) && total === 1 && !(array ? false : ['ops', 'expectedMessages'].includes(list))) { head = [list, id]; node = element; k = at + 4; }
  }
  if (!head) {
    const id = identityOf(opNode);
    head = [...(array ? [] : ['ops']), nameable(id) && !keep(at) && countIn(ops, id) === 1 ? id : tokens[at]];
    node = opNode; k = at + 1;
  }
  const rest = [];
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (Array.isArray(node) && INDEX.test(t)) {
      const element = node[Number(t)];
      const id = identityOf(element);
      rest.push(nameable(id) && !keep(k) && countIn(node, id) === 1 ? id : t);
      node = element;
    } else {
      rest.push(t);
      node = node !== null && typeof node === 'object' && Object.hasOwn(node, t) ? node[t] : undefined;
    }
    if (node === undefined || node === null || typeof node !== 'object') { rest.push(...tokens.slice(k + 1)); break; }
  }
  const all = [...head, ...rest];
  if (all.length === tokens.length && all.every((t, n) => t === tokens[n])) return null;
  return { tokens: all, text: head[0] === 'ops' || (array && INDEX.test(head[0])) ? toPointer(all) : all.map(escapeToken).join('/') };
}

// The same patch with each path written by name where that is unique, each one checked by resolving it back to the
// numeric path, over the job as the earlier operations left it. Null when no path names anything (or the job is not one
// a patch applies to); an operation that does not apply stops the naming there (the rest stay numeric).
export function namedPatch(job, patch) {
  if (!Array.isArray(patch) || !patch.length || !opsOf(job)) return null;
  const copy = structuredClone(job);
  const out = [];
  let changed = false;
  for (let at = 0; at < patch.length; at++) {
    const operation = patch[at];
    if (!isObject(operation) || typeof operation.path !== 'string') return changed ? [...out, ...patch.slice(at)] : null;
    let path = operation.path;
    try {
      const tokens = pointer(operation.path, at, '');
      const named = nameTokens(copy, tokens, operation.op);
      if (named && toPointer(resolveTokens(copy, named.tokens, operation.op, operation.value, at, '')) === toPointer(tokens)) { path = named.text; changed = true; }
    } catch { /* stays numeric */ }
    out.push({ ...operation, path });
    try { applyOne(copy, operation, at); } catch { return changed ? [...out, ...patch.slice(at + 1)] : null; }
  }
  return changed ? out : null;
}

// ---- the answers: the job used, ready for the next basedOn, and the patches of a refusal by name too
// nextBasedOn {job, sha256} of a job file and its hash; {} without both.
export const nextBasedOnOf = (file, hash) => (typeof file === 'string' && file && SHA256.test(String(hash ?? '')) ? { nextBasedOn: { job: path.resolve(file), sha256: String(hash).toLowerCase() } } : {});
// Each problem's patch also by name (patchByName) over the job file the answer names, within the room left under the
// answer ceiling (NAMED_CEILING bytes of the whole answer); the problems left out keep the numeric patch
// (patchByNameOmitted counts them). A value without problems with patches, or a job that cannot be read, is returned as it is.
export const NAMED_CEILING = 36000;
const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
export function withNamedPatches(value, file, { ceiling = NAMED_CEILING } = {}) {
  const holder = isObject(value) && Array.isArray(value.problems) ? value : isObject(value?.refusal) && Array.isArray(value.refusal.problems) ? value.refusal : null;
  if (!holder || !holder.problems.some(p => Array.isArray(p?.patch) && p.patch.length) || typeof file !== 'string') return value;
  let job;
  try { job = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return value; }
  if (!opsOf(job)) return value;
  let room = ceiling - bytes(value);
  let omitted = 0;
  const problems = holder.problems.map(p => {
    if (!isObject(p) || !Array.isArray(p.patch) || !p.patch.length || p.patchByName) return p;
    const named = namedPatch(job, p.patch);
    if (!named) return p;
    const cost = bytes(named) + 16;
    if (cost > room) { omitted++; return p; }
    room -= cost;
    return { ...p, patchByName: named };
  });
  if (!omitted && problems.every((p, i) => p === holder.problems[i])) return value;
  const filled = { ...holder, problems, ...(omitted ? { patchByNameOmitted: omitted } : {}) };
  return holder === value ? filled : { ...value, refusal: filled };
}

// ---- a partial job over the job of basedOn
// The fields that identify a raw op (no named lists in data); null: no identity, the op is appended.
function rawIdentity(op) {
  const fields = { set: ['target', 'prop'], delete: ['target'], move: ['target'], rename: ['target'], layout: ['target'], html: ['parent'] }[op.op]
    ?? (op.op === 'create' || op.op === 'duplicate' ? (typeof op.as === 'string' ? ['as'] : ['parent', 'type', 'name'])
      : op.op === 'link' ? (op.connector != null ? ['from', 'connector'] : ['from', 'to'])
        : op.op === 'reference' ? ['producer', ...(op.as != null ? ['as'] : [])] : null);
  if (!fields || fields.some(f => typeof op[f] !== 'string' || !op[f])) return null;
  return fields;
}
// The named lists of an op's data: arrays of objects that all have an identity. An array of objects where one has none
// cannot be merged by name.
function namedLists(op, at) {
  if (!isObject(op.data)) return [];
  const lists = [];
  for (const [key, value] of Object.entries(op.data)) {
    if (!Array.isArray(value) || !value.length || !value.some(isObject)) continue;
    const unnamed = value.findIndex(e => !identityOf(e));
    if (unnamed >= 0) throw new PatchError('PARTIAL_UNNAMED', `partial op #${at} (${op.op}): data.${key}[${unnamed}] has no name (name, as, key, id or label); a partial job names every element it brings (an unnamed one: patch)`, at);
    lists.push(key);
  }
  return lists;
}
// An element of a list in a partial job and in the job: the same identity, and the same owner when either has one.
const sameElement = (a, b) => identityOf(a) === identityOf(b) && (a?.owner ?? null) === (b?.owner ?? null);
// The html op of a whole page ({op:"html", data:{screen, html, bindings...}}, no parent) or of a whole document (data.html
// is <screen name="X"> or <block name="X">, the document form of B1): its screen, compared as OutSystems compares names
// (without regard to case); null for any other op (the fragment form keeps parent as its identity).
const DOCUMENT_ROOT = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\s[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const pageName = op => {
  if (!isObject(op) || op.op !== 'html' || !isObject(op.data)) return null;
  if (typeof op.data.screen === 'string' && op.data.screen.trim()) return op.data.screen.trim();
  const root = op.parent == null && typeof op.data.html === 'string' ? DOCUMENT_ROOT.exec(op.data.html) : null;
  return root && (root[1] ?? root[2] ?? '').trim() ? (root[1] ?? root[2]).trim() : null;
};
const pageScreen = op => pageName(op)?.toLowerCase() ?? null;
const POSITION_LATER = new Set(['logic', 'screen', 'html']);
// Where a new op goes: a reference after the last reference, a spec before the first logic/screen/html op, others at the end.
function newOpIndex(ops, verb) {
  if (verb === 'reference') { const last = ops.findLastIndex(o => o?.op === 'reference'); return last + 1; }
  if (verb === 'spec') { const first = ops.findIndex(o => POSITION_LATER.has(o?.op)); return first < 0 ? ops.length : first; }
  return ops.length;
}
const PARTIAL_KEYS = new Set(['ops', 'expectedMessages', 'description', 'base', 'expectValid']);

// The whole job: the job of basedOn with the partial job's elements merged by name (see the head of this file). Returns
// {job, summary: {replaced, added, ops}} (the pointers, in the merged job, of what was replaced, appended to a list and
// added as an op); throws a PatchError (PARTIAL_INVALID, PARTIAL_UNNAMED, PARTIAL_AMBIGUOUS).
export function mergePartialJob(base, partial) {
  if (!opsOf(base)) throw new PatchError('PATCH_PATH_FORBIDDEN', 'only a job with ops ({ops:[...]} or an array of ops) takes a partial job; a composite {jobs} job is changed in its part file');
  const given = Array.isArray(partial) ? { ops: partial } : partial;
  if (!isObject(given)) throw new PatchError('PARTIAL_INVALID', 'the partial job is {ops:[...]} or an array of ops with only the changed or new elements');
  const unknown = Object.keys(given).filter(k => !PARTIAL_KEYS.has(k));
  if (unknown.length) throw new PatchError('PARTIAL_INVALID', `the partial job takes ops and expectedMessages (not ${unknown.join(', ')}); its base and expectValid stay those of basedOn`);
  for (const key of ['base', 'expectValid'])
    if (given[key] !== undefined && !jsonEqual(given[key], Array.isArray(base) ? undefined : base[key]))
      throw new PatchError('PARTIAL_INVALID', `the partial job's ${key} differs from basedOn's: the ${key} stays that of basedOn (drop it from the partial job)`);
  const partialOps = given.ops ?? [];
  if (!Array.isArray(partialOps) || (!partialOps.length && !(Array.isArray(given.expectedMessages) && given.expectedMessages.length)))
    throw new PatchError('PARTIAL_INVALID', 'the partial job brings no ops (and no expectedMessages)');
  const job = structuredClone(base);
  const ops = opsOf(job);
  // What was merged, by reference: the pointers are taken at the end, once every new op has its place.
  const merged = { replaced: [], added: [], ops: [] };
  const placed = new Set(); // what the partial job already put in place: a second one with the same identity is refused
  const twice = (at, what) => new PatchError('PARTIAL_AMBIGUOUS', `partial op #${at}: ${what} comes twice in the partial job`, at);
  const where = (i, ...rest) => toPointer([...(Array.isArray(job) ? [] : ['ops']), i, ...rest]);
  partialOps.forEach((entry, at) => {
    if (!isObject(entry) || typeof entry.op !== 'string' || !entry.op) throw new PatchError('PARTIAL_INVALID', `partial op #${at} is not an op {op, ...}`, at);
    const op = structuredClone(entry);
    const lists = namedLists(op, at);
    const screen = pageScreen(op);
    if (screen) {
      // An html page: the page of the same screen in basedOn takes each field the partial brings (a named list such as vars
      // by name); a field it does not bring stays. Another screen is a new page. Never a second page of one screen.
      const hits = ops.map((o, i) => (pageScreen(o) === screen ? i : -1)).filter(i => i >= 0);
      if (hits.length > 1) throw new PatchError('PARTIAL_AMBIGUOUS', `partial op #${at} (html page ${pageName(op)}) matches ${hits.length} html ops of basedOn for that screen; change it with a patch at one of them`, at, hits.map(i => where(i)));
      if (!hits.length) { for (const list of lists) op.data[list].forEach(e => placed.add(e)); placed.add(op); ops.splice(newOpIndex(ops, op.op), 0, op); merged.ops.push({ op }); return; }
      const target = ops[hits[0]];
      if (placed.has(target)) throw twice(at, 'the html page ' + pageName(op));
      placed.add(target);
      let fields = false;
      for (const [key, value] of Object.entries(op)) if (key !== 'op' && key !== 'data') { target[key] = value; fields = true; }
      for (const [key, value] of Object.entries(op.data)) {
        if (key === 'screen') continue; // the name basedOn gave the screen stays
        if (!lists.includes(key) || !Array.isArray(target.data[key])) { target.data[key] = value; fields = true; continue; }
        const seen = new Set();
        for (const element of value) {
          const name = identityOf(element) + '\u0001' + (element.owner ?? '');
          if (seen.has(name)) throw new PatchError('PARTIAL_AMBIGUOUS', `partial op #${at}: data.${key} brings "${identityOf(element)}" twice`, at);
          seen.add(name);
          const j = target.data[key].findIndex(e => sameElement(e, element));
          if (j >= 0) { target.data[key][j] = element; merged.replaced.push({ op: target, list: key, element }); }
          else { target.data[key].push(element); merged.added.push({ op: target, list: key, element }); }
        }
      }
      if (fields) merged.replaced.unshift({ op: target });
      return;
    }
    if (!lists.length) {
      // A raw op: it replaces the op with its identity, else it is a new op.
      const fields = rawIdentity(op);
      const hits = fields ? ops.map((o, i) => (isObject(o) && o.op === op.op && fields.every(f => o[f] === op[f]) ? i : -1)).filter(i => i >= 0) : [];
      if (hits.length > 1) throw new PatchError('PARTIAL_AMBIGUOUS', `partial op #${at} (${op.op} ${fields.map(f => op[f]).join(' ')}) matches ${hits.length} ops of basedOn; change it with a patch at one of them`, at, hits.map(i => where(i)));
      if (hits.length === 1 && placed.has(ops[hits[0]])) throw twice(at, op.op + ' ' + fields.map(f => op[f]).join(' '));
      placed.add(op);
      if (hits.length === 1) { ops[hits[0]] = op; merged.replaced.push({ op }); return; }
      ops.splice(newOpIndex(ops, op.op), 0, op); merged.ops.push({ op });
      return;
    }
    // A grammar op: its context (every other field, and the data that is not a named list) picks the ops it merges into.
    const context = Object.keys(op).filter(k => k !== 'op' && k !== 'data' && !k.startsWith('_'));
    const dataContext = Object.keys(op.data).filter(k => !lists.includes(k) && !(Array.isArray(op.data[k]) && !op.data[k].length));
    const candidates = ops.map((o, i) => (isObject(o) && o.op === op.op && isObject(o.data) && context.every(k => jsonEqual(o[k], op[k]))
      && dataContext.every(k => jsonEqual(o.data[k], op.data[k])) ? i : -1)).filter(i => i >= 0);
    if (!candidates.length) { for (const list of lists) op.data[list].forEach(e => placed.add(e)); ops.splice(newOpIndex(ops, op.op), 0, op); merged.ops.push({ op }); return; }
    for (const list of lists) {
      const seen = new Set();
      for (const element of op.data[list]) {
        const key = identityOf(element) + '\u0001' + (element.owner ?? '');
        if (seen.has(key)) throw new PatchError('PARTIAL_AMBIGUOUS', `partial op #${at}: data.${list} brings "${identityOf(element)}" twice`, at);
        seen.add(key);
        const hits = candidates.flatMap(i => (Array.isArray(ops[i].data[list]) ? ops[i].data[list].map((e, j) => (sameElement(e, element) ? [i, j] : null)).filter(Boolean) : []));
        if (hits.length > 1) throw new PatchError('PARTIAL_AMBIGUOUS', `partial op #${at}: "${identityOf(element)}" names ${hits.length} elements of data.${list} in basedOn; change it with a patch at one of them`,
          at, hits.map(([i, j]) => where(i, 'data', list, j)));
        if (hits.length === 1 && placed.has(ops[hits[0][0]].data[list][hits[0][1]])) throw twice(at, '"' + identityOf(element) + '" of data.' + list);
        placed.add(element);
        if (hits.length === 1) { const [i, j] = hits[0]; ops[i].data[list][j] = element; merged.replaced.push({ op: ops[i], list, element }); continue; }
        const home = [...candidates].reverse().find(i => Array.isArray(ops[i].data[list])) ?? candidates.at(-1);
        if (!Array.isArray(ops[home].data[list])) ops[home].data[list] = [];
        ops[home].data[list].push(element); merged.added.push({ op: ops[home], list, element });
      }
    }
  });
  const pointerOf = ({ op, list, element }) => {
    const i = ops.indexOf(op);
    return list ? where(i, 'data', list, op.data[list].indexOf(element)) : where(i);
  };
  const summary = { replaced: merged.replaced.map(pointerOf), added: merged.added.map(pointerOf), ops: merged.ops.map(pointerOf) };
  if (given.expectedMessages !== undefined) {
    if (!Array.isArray(given.expectedMessages) || given.expectedMessages.some(m => !isObject(m)))
      throw new PatchError('PARTIAL_INVALID', 'the partial job\'s expectedMessages is a list of {id, element, why}');
    if (Array.isArray(job)) throw new PatchError('PARTIAL_INVALID', 'an array job has no expectedMessages: basedOn is an array of ops');
    const declared = Array.isArray(job.expectedMessages) ? job.expectedMessages : (job.expectedMessages = []);
    for (const message of given.expectedMessages) {
      const hit = declared.findIndex(m => isObject(m) && m.id === message.id && (m.element ?? null) === (message.element ?? null));
      if (hit >= 0) { declared[hit] = structuredClone(message); summary.replaced.push(toPointer(['expectedMessages', hit])); }
      else { declared.push(structuredClone(message)); summary.added.push(toPointer(['expectedMessages', declared.length - 1])); }
    }
  }
  return { job, summary };
}
// The short account of a merge for an answer: how many of each, and the first pointers.
export function partialSummary(summary) {
  if (!summary) return undefined;
  const cut = list => list.slice(0, 20);
  return { replaced: summary.replaced.length, added: summary.added.length, newOps: summary.ops.length,
    ...(summary.replaced.length ? { replacedAt: cut(summary.replaced) } : {}), ...(summary.added.length ? { addedAt: cut(summary.added) } : {}),
    ...(summary.ops.length ? { newOpsAt: cut(summary.ops) } : {}) };
}

// ---- the references of a job, as the kernel resolves them from the job's folder (JobRunner.ResolveJobFile,
// JobSources.Resolve/FixturePath; the same code in both lanes): "job:<name>" is <name>.json in that folder, then in the
// positive folder of a "-negative" one, then <repo>/tests/jobs (repo = the first folder up with MANIFESTO.md); a relative
// .oml (base or producer) is the first of <folder>/<spec>, <repo>/<spec> (a bare name: <repo>/tests/fixtures/<name>)
// that lies inside <repo>/tests/fixtures; a binding name (Lib) comes from --producer. A rooted "job:" name is the file
// itself (Path.Combine keeps a rooted second part), so "job:<absolute path without .json>" names one file from anywhere.
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;
const lower = p => (process.platform === 'win32' ? p.toLowerCase() : p);
function repoRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (isFile(path.join(d, 'MANIFESTO.md'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
function jobFileFrom(spec, dir) {
  const name = spec.slice(4) + '.json';
  const folder = path.resolve(dir);
  const candidates = [path.resolve(folder, name)];
  const own = path.basename(folder);
  if (/-negative$/i.test(own)) candidates.push(path.resolve(path.dirname(folder), own.slice(0, -'-negative'.length), name));
  const root = repoRoot(folder);
  if (root) candidates.push(path.join(root, 'tests', 'jobs', name));
  return candidates.find(isFile) ?? null;
}
function fixtureFrom(spec, dir) {
  if (!/\.oml$/i.test(spec) || path.isAbsolute(spec)) return null;
  const root = repoRoot(dir);
  if (!root) return null; // the kernel then uses its own root, unknown here: left as it is
  const fixtures = path.join(root, 'tests', 'fixtures') + path.sep;
  const candidates = [path.resolve(dir, spec), path.resolve(root, spec), path.basename(spec) === spec ? path.resolve(fixtures, spec) : path.resolve(root, spec)];
  return candidates.find(c => lower(c).startsWith(lower(fixtures))) ?? null;
}
// One reference of a job moved from baseDir to dir: as it was when it names the same file from both folders (or nothing
// from baseDir: the kernel refuses it as it would have refused the base), else pinned to the file it named.
function pinned(spec, baseDir, dir) {
  if (typeof spec !== 'string' || !spec || BINDING.test(spec) || isProducerName(spec)) return spec;
  const job = spec.startsWith('job:');
  const from = job ? jobFileFrom(spec, baseDir) : fixtureFrom(spec, baseDir);
  if (!from) return spec;
  const here = job ? jobFileFrom(spec, dir) : fixtureFrom(spec, dir);
  if (here && lower(here) === lower(from)) return spec;
  return job ? 'job:' + from.slice(0, -'.json'.length) : from;
}
// The job (already a copy) with its base and the producers of its reference ops pinned for a file in dir. Ops a patch
// added are read as written in the base, the file the patch edits.
export function pinReferences(job, baseDir, dir) {
  if (!baseDir || lower(path.resolve(baseDir)) === lower(path.resolve(dir))) return job;
  if (job && typeof job === 'object' && !Array.isArray(job) && typeof job.base === 'string') job.base = pinned(job.base, baseDir, dir);
  for (const op of opsOf(job) ?? [])
    if (op && typeof op === 'object' && op.op === 'reference' && typeof op.producer === 'string') op.producer = pinned(op.producer, baseDir, dir);
  return job;
}

// ---- the base job
// The kernel's checkpoint (DurableJson {format, sha256, payload}); null when absent, unreadable or not matching its hash.
export function readKernelTaskState(work, taskId) {
  try {
    const document = JSON.parse(fs.readFileSync(path.join(work, 'deliver', taskId, 'task.json'), 'utf8').replace(/^﻿/, ''));
    if (typeof document.payload !== 'string') return document && typeof document === 'object' ? document : null;
    if (document.sha256 != null && sha256(document.payload) !== String(document.sha256).toLowerCase()) return null;
    return JSON.parse(document.payload);
  } catch { return null; }
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// The kernel's job record of a task (Delivery.JobIdentity: {path, sha256}, written before anything can refuse the job and
// kept on every refusal), when it names this file; else undefined.
const recordedJobSha256 = (state, file) => {
  const job = state?.job;
  return job && typeof job === 'object' && samePath(job.path, file) && SHA256.test(String(job.sha256 ?? '')) ? String(job.sha256) : undefined;
};

function readBase(file, expected, taskId) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return fail('BASE_NOT_FOUND', 'No job file at ' + file + '; nothing was patched.'); }
  const actual = sha256(bytes);
  if (expected.some(e => String(e).toLowerCase() !== actual))
    return fail('BASE_CHANGED', 'The base job changed after that refusal (sha256 differs); nothing was patched.', { job: file });
  return { ok: true, file, bytes, sha256: actual, ...(taskId ? { taskId } : {}) };
}

function baseOf(basedOn, { root, work }) {
  if (!basedOn || typeof basedOn !== 'object' || Array.isArray(basedOn)) return fail('PATCH_INVALID', 'basedOn is {job, sha256} or {taskId}');
  const keys = Object.keys(basedOn);
  if (basedOn.sha256 != null && !SHA256.test(String(basedOn.sha256))) return fail('PATCH_INVALID', 'basedOn.sha256 is the 64-hex jobSha256 a refusal returned');
  if (basedOn.taskId != null) {
    if (keys.some(k => k !== 'taskId' && k !== 'sha256')) return fail('PATCH_INVALID', 'basedOn {taskId} takes only taskId and, optionally, sha256');
    const id = String(basedOn.taskId);
    if (!TASK_ID.test(id)) return fail('PATCH_INVALID', 'basedOn.taskId is the 32-hex kernel taskId of a delivery');
    if (!work) return fail('BASE_TASK_UNSUPPORTED', 'basedOn.taskId names an O11 delivery task; here give basedOn {job, sha256}');
    const state = readKernelTaskState(work, id);
    if (!state) return fail('BASE_NOT_FOUND', 'No delivery task ' + id + ' in the lane work folder.');
    const jobPath = state.request?.JobPath ?? state.request?.jobPath;
    if (typeof jobPath !== 'string' || !jobPath) return fail('BASE_NOT_FOUND', 'Task ' + id + ' records no job file.');
    const file = path.resolve(jobPath);
    const recorded = (Array.isArray(state.sources) ? state.sources : []).find(s => samePath(s?.path, file))?.sha256
      ?? recordedJobSha256(state, file);
    const expected = [recorded, basedOn.sha256].filter(Boolean);
    if (!expected.length) return fail('BASE_UNVERIFIED', 'Task ' + id + ' recorded no sha256 of its job; give basedOn {job, sha256}.', { job: file });
    return readBase(file, expected, id);
  }
  if (keys.some(k => k !== 'job' && k !== 'sha256')) return fail('PATCH_INVALID', 'basedOn {job, sha256} takes only job and sha256');
  if (typeof basedOn.job !== 'string' || !basedOn.job) return fail('PATCH_INVALID', 'basedOn.job is the job path a refusal returned');
  if (basedOn.sha256 == null) return fail('PATCH_INVALID', 'basedOn {job} needs sha256 (the jobSha256 of the refusal)');
  const file = path.isAbsolute(basedOn.job) ? path.resolve(basedOn.job) : root ? path.resolve(root, basedOn.job) : null;
  if (!file) return fail('JOB_PATH_NOT_ABSOLUTE', 'basedOn.job must be an absolute path: ' + basedOn.job);
  return readBase(file, [basedOn.sha256]);
}

function writeInline(inlineDir, text, uuid) {
  const file = path.join(inlineDir, uuid() + '.json');
  fs.mkdirSync(inlineDir, { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx' }); // a new file, never an existing one
  return file;
}

// A job given as a path or as itself (as o11_deliver took it): a path is checked, an inline job written once.
function plainJob(job, { root, inlineDir, uuid }) {
  if (typeof job === 'string' && /^\s*[[{]/.test(job)) {
    try { job = JSON.parse(job); } catch (error) { return fail('JOB_INVALID', 'job is neither a path nor valid JSON: ' + error.message); }
  }
  if (typeof job === 'string') {
    const file = path.isAbsolute(job) ? job : root ? path.resolve(root, job) : null;
    if (!file) return fail('JOB_PATH_NOT_ABSOLUTE', 'job must be an absolute path or the job itself: ' + job);
    if (!isFile(file)) return fail('JOB_NOT_FOUND', 'No job file at ' + file);
    // A file with op shapes of one meaning (the ssam_code aliases, set props{}, keys inside data, ...: ssam-code.mjs
    // normalizeCodeOps) runs as a new inline file in the kernel form; what was taken as meant is listed (normalizations).
    let aliased = null;
    try { aliased = normalizeCodeOps(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); } catch { /* the kernel reports an unreadable job */ }
    if (aliased?.changed) { const text = JSON.stringify(aliased.job, null, 2) + '\n'; return { ok: true, path: writeInline(inlineDir, text, uuid), sha256: sha256(text), ...notesOf(aliased) }; }
    return { ok: true, path: file, sha256: sha256(fs.readFileSync(file)) };
  }
  if (!job || typeof job !== 'object') return fail('JOB_INVALID', 'job is a path or the job itself ({ops:[...]} or an array of ops)');
  const shaped = normalizeCodeOps(job);
  const text = JSON.stringify(shaped.job, null, 2) + '\n';
  return { ok: true, path: writeInline(inlineDir, text, uuid), sha256: sha256(text), ...notesOf(shaped) };
}
// The normalizations field of a resolved job (empty when nothing was taken as meant).
const notesOf = shaped => (shaped?.normalizations?.length ? { normalizations: shaped.normalizations } : {});

// The partial job given with basedOn: the job itself, its JSON text, or a file (absolute, or relative to root).
function partialOf(job, root) {
  if (typeof job === 'string' && /^\s*[[{]/.test(job)) {
    try { return { ok: true, value: JSON.parse(job) }; } catch (error) { return fail('JOB_INVALID', 'job is neither a path nor valid JSON: ' + error.message); }
  }
  if (typeof job === 'string') {
    const file = path.isAbsolute(job) ? job : root ? path.resolve(root, job) : null;
    if (!file) return fail('JOB_PATH_NOT_ABSOLUTE', 'job must be an absolute path or the job itself: ' + job);
    try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) }; }
    catch (error) { return fail(isFile(file) ? 'JOB_INVALID' : 'JOB_NOT_FOUND', isFile(file) ? 'The partial job is not valid JSON: ' + error.message : 'No job file at ' + file); }
  }
  return job && typeof job === 'object' ? { ok: true, value: job } : fail('JOB_INVALID', 'job is a path or the job itself ({ops:[...]} or an array of ops)');
}

// {job} alone: the job file (an inline job written to <inlineDir>/<uuid>.json). {patch, basedOn}: the base read and
// checked, the patch applied (paths by index or by name), the result written to a NEW <inlineDir>/<uuid>.json.
// {job, basedOn} (and a patch, applied after): job is a partial job merged into the base by name (mergePartialJob), the
// whole job written to a new file. -> {ok, path, sha256, basedOn?, partial?} or {ok:false, code, error, at?, candidates?,
// job?}. options: inlineDir (required), root (relative paths resolve there; without it they are refused), work (the O11
// lane work folder, for basedOn.taskId), journalDir (the provenance line goes to <journalDir>/job-patch.jsonl, best
// effort), tool (named in that line), uuid, now.
export function resolvePatchedJob({ job, patch, basedOn } = {}, { root = null, inlineDir, work = null, journalDir = null, tool = null, uuid = randomUUID, now = () => new Date() } = {}) {
  if (!inlineDir) throw new Error('resolvePatchedJob needs inlineDir');
  if (patch == null && basedOn == null) return plainJob(job, { root, inlineDir, uuid });
  if (basedOn == null) return fail('PATCH_INVALID', 'patch needs basedOn: {job, sha256} as a refusal returned them (nextBasedOn), or {taskId} of the refused delivery');
  if (patch == null && job == null) return fail('PATCH_INVALID', 'basedOn goes with patch, or with job: a partial job with only the changed or new elements');
  const base = baseOf(basedOn, { root, work });
  if (!base.ok) return base;
  // patch "verified": every verified patch the refusal of that job wrote beside it (refusalFields with jobFile, verified-patch.mjs), for that job only.
  let verified = false;
  if (patch === 'verified') {
    const saved = readVerifiedPatch(base.file, base.sha256);
    if (!saved.ok) return fail('PATCH_INVALID', saved.error);
    patch = saved.patch; verified = true;
  }
  let parsed;
  try { parsed = JSON.parse(base.bytes.toString('utf8').replace(/^﻿/, '')); }
  catch (error) { return fail('PATCH_INVALID', 'The base job is not valid JSON: ' + error.message, { job: base.file }); }
  let result = parsed; let summary = null; let patched = null;
  try {
    if (job != null) {
      const partial = partialOf(job, root);
      if (!partial.ok) return partial;
      ({ job: result, summary } = mergePartialJob(parsed, partial.value));
    }
    if (patch != null) {
      try { patched = patchJob(result, patch, verified ? { max: Infinity } : {}); }
      // R1: a patch refused never comes back dry: the same patch mended where one reading is certain, by name, ready to send.
      catch (error) { if (error instanceof PatchError && Array.isArray(patch)) return fail(error.code, error.message, { ...patchErrorFields(error), ...mendedFields(result, patch) }); throw error; }
      result = patched.job;
    }
  } catch (error) { if (error instanceof PatchError) return fail(error.code, error.message, patchErrorFields(error)); throw error; }
  const shaped = normalizeCodeOps(result);
  if (patched?.notes?.length) shaped.normalizations = [...patched.notes, ...(shaped.normalizations ?? [])];
  const text = JSON.stringify(pinReferences(shaped.job, path.dirname(base.file), inlineDir), null, 2) + '\n';
  const file = writeInline(inlineDir, text, uuid);
  const done = { ok: true, path: file, sha256: sha256(text), basedOn: { job: base.file, sha256: base.sha256, ...(base.taskId ? { taskId: base.taskId } : {}) },
    ...(summary ? { partial: partialSummary(summary) } : {}), ...notesOf(shaped) };
  if (journalDir) {
    try {
      fs.mkdirSync(journalDir, { recursive: true });
      appendJsonLine(path.join(journalDir, 'job-patch.jsonl'), { at: now().toISOString(), event: summary ? 'partial' : 'patch', ...(tool ? { tool } : {}),
        job: file, jobSha256: done.sha256, basedOn: done.basedOn, ...(patch != null ? { patchOps: patch.length } : {}),
        ...(patched?.named ? { resolved: patched.resolved.map(r => r.path) } : {}), ...(summary ? { partial: done.partial } : {}) });
    } catch { /* the patched file stands; the line is provenance only */ }
  }
  return done;
}

// 'array' when the job text is an array of ops (its patch paths are /<i>/...); null for {ops} (/ops/<i>/..., the
// default a continuation assumes) or anything unreadable.
const shapeOfText = text => { try { return Array.isArray(JSON.parse(String(text).replace(/^﻿/, ''))) ? 'array' : null; } catch { return null; } };
export function jobShapeOf(file) {
  try { return shapeOfText(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// {job, jobSha256, nextBasedOn} of a job file (and jobShape 'array' for an array job), for an answer the next call
// patches or completes (basedOn = nextBasedOn); {job} when it cannot be read; {} without a path.
export function jobIdentity(file) {
  if (typeof file !== 'string' || !file) return {};
  const job = path.resolve(file);
  let content;
  try { content = fs.readFileSync(job); } catch { return { job }; }
  const shape = shapeOfText(content.toString('utf8'));
  const hash = sha256(content);
  return { job, jobSha256: hash, ...(shape ? { jobShape: shape } : {}), ...nextBasedOnOf(job, hash) };
}

// Record the kernel's corrected job as a descendant of its input. Use only a hash-checked
// file; the original is kept intact, and G16 can follow both identities after delivery.
export function appliedJobIdentity(patchedJob, original, { journalDir, tool, now = () => new Date() } = {}) {
  if (typeof patchedJob?.path !== 'string' || !/^[a-fA-F0-9]{64}$/.test(String(patchedJob.sha256 ?? ''))) return original;
  const identity = jobIdentity(patchedJob.path);
  if (identity.jobSha256?.toLowerCase() !== patchedJob.sha256.toLowerCase()) return original;
  const basedOn = original?.path ? { job: original.path, sha256: original.sha256 } : null;
  if (journalDir && basedOn?.sha256 && identity.jobSha256 !== basedOn.sha256) {
    try {
      fs.mkdirSync(journalDir, { recursive: true });
      const journalFile = path.join(journalDir, 'job-patch.jsonl');
      let recorded = false;
      try { recorded = fs.readFileSync(journalFile, 'utf8').split('\n').some(line => {
        try { const entry = JSON.parse(line); return entry.event === 'auto-patch' && entry.jobSha256 === identity.jobSha256 && entry.basedOn?.sha256 === basedOn.sha256 && entry.job === identity.job; } catch { return false; }
      }); } catch { /* first line */ }
      if (!recorded) appendJsonLine(journalFile, { at: now().toISOString(), event: 'auto-patch',
        ...(tool ? { tool } : {}), job: identity.job, jobSha256: identity.jobSha256, basedOn });
    } catch { /* provenance does not change the accepted candidate */ }
  }
  return { ...original, path: identity.job, sha256: identity.jobSha256, ...(basedOn ? { basedOn } : {}) };
}

// The index of the op the kernel refused, only when it says so reliably: its error starts with Verbs.Apply's
// `op #N (<verb> <name|prop>):` (or JobPreflight's `op #N (<verb>) [CODE]:`, I2), the job file is a plain job (array or
// {ops}, not a composite {jobs}, whose indices span its parts), op N exists there with that verb and, when named, that
// name or prop. Anything else: null (the caller omits failedOp).
const OP_PREFIX = /^(?:[A-Za-z.]+Exception: )?op #(\d+) \(([A-Za-z-]+)(?: ([^)]*))?\)(?: \[[A-Z0-9_]+\])?:/;
export function failedOpOf(error, jobFile) {
  const m = OP_PREFIX.exec(String(error ?? ''));
  if (!m || typeof jobFile !== 'string') return null;
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8').replace(/^﻿/, '')); } catch { return null; }
  const index = Number(m[1]);
  const op = opsOf(job)?.[index];
  if (!op || typeof op !== 'object' || op.op !== m[2]) return null;
  const named = (m[3] ?? '').trim();
  const own = typeof op.name === 'string' ? op.name : typeof op.prop === 'string' ? op.prop : '';
  return named && named !== own ? null : index;
}

// ---- R1 (plano 24/10): the correction loop without a JSON path to write
// mendPatch(job, patch): the patch with each operation that does not apply mended where one reading is certain (only
// op, path and value kept; a verb of another name: set/update -> replace, insert/append/create -> add, delete -> remove;
// add of what exists -> replace; replace of a key that is not there -> add; a name that differs only in case -> the
// name there), each checked by applying it over the job as the earlier operations left it.
// -> {patch, repaired: [{at, was, now, why}], ready, at?} (ready: the whole patch applies), or null (not a patch of a job).
const VERB_OF = { set: 'replace', update: 'replace', modify: 'replace', change: 'replace', insert: 'add', append: 'add', create: 'add', push: 'add', delete: 'remove', del: 'remove', drop: 'remove' };
function mendsOf(operation, error) {
  if (!isObject(operation)) return [];
  const verb = typeof operation.op === 'string' ? (PATCH_OPS.includes(operation.op) ? operation.op : VERB_OF[operation.op.toLowerCase()] ?? null) : null;
  if (!verb || typeof operation.path !== 'string') return [];
  const base = { op: verb, path: operation.path, ...(verb !== 'remove' && Object.hasOwn(operation, 'value') ? { value: operation.value } : {}) };
  const out = [];
  const add = (op, why) => { if (!out.some(o => jsonEqual(o.op, op))) out.push({ op, why }); };
  if (verb !== operation.op) add(base, operation.op + ' is ' + verb);
  else if (Object.keys(operation).some(k => !OP_KEYS.has(k))) add(base, 'only op, path and value');
  if (verb === 'add' && Object.hasOwn(base, 'value')) add({ ...base, op: 'replace' }, 'add of what exists is replace');
  if (verb === 'replace') add({ ...base, op: 'add' }, 'replace of a key that is not there is add');
  // A name that differs only in case from one candidate the refusal named.
  const candidates = Array.isArray(error?.candidates) ? error.candidates.filter(c => typeof c === 'string' && !c.startsWith('/')) : [];
  if (candidates.length) {
    const tokens = base.path.replace(/^\//, '').split('/');
    let renamed = false;
    const fixed = tokens.map(t => { const hit = candidates.filter(c => c !== t && c.toLowerCase() === t.toLowerCase()); if (hit.length === 1) { renamed = true; return hit[0]; } return t; });
    if (renamed) {
      const path = (base.path.startsWith('/') ? '/' : '') + fixed.join('/');
      for (const o of [base, ...out.map(x => x.op)]) add({ ...o, path }, 'the name as it is in the job');
    }
  }
  return out;
}
export function mendPatch(job, patch) {
  if (!Array.isArray(patch) || !patch.length || !opsOf(job)) return null;
  let copy = structuredClone(job);
  const out = [], repaired = [];
  for (let at = 0; at < patch.length; at++) {
    const operation = patch[at];
    let trial = structuredClone(copy);
    try { applyOne(trial, operation, at, null, []); copy = trial; out.push(operation); continue; }
    catch (error) {
      if (!(error instanceof PatchError)) throw error;
      // A mend may show the next thing to mend (extra keys first, then the case of a name): at most three steps.
      let mended = null;
      let queue = mendsOf(operation, error).map(c => ({ ...c, depth: 1 }));
      const tried = new Set();
      while (queue.length && !mended) {
        const candidate = queue.shift();
        const key = JSON.stringify(candidate.op);
        if (tried.has(key)) continue;
        tried.add(key);
        trial = structuredClone(copy);
        try { applyOne(trial, candidate.op, at, null, []); mended = candidate; }
        catch (again) {
          if (!(again instanceof PatchError)) throw again;
          if (candidate.depth < 3) queue.push(...mendsOf(candidate.op, again).map(c => ({ ...c, why: candidate.why + '; ' + c.why, depth: candidate.depth + 1 })));
        }
      }
      if (!mended) return { patch: [...out, ...patch.slice(at)], repaired, ready: false, at };
      copy = trial; out.push(mended.op); repaired.push({ at, was: operation, now: mended.op, why: mended.why });
    }
  }
  return { patch: out, repaired, ready: true };
}
// The fields of a refused patch: patchByName (the mended patch written by name where unique, else as mended), ready (the
// whole patch applies over that job) and repaired; {} when nothing can be said.
export function mendedFields(job, patch) {
  let mended;
  try { mended = mendPatch(job, patch); } catch { return {}; }
  if (!mended) return {};
  let named = null;
  try { named = namedPatch(job, mended.patch); } catch { named = null; }
  return { patchByName: named ?? mended.patch, ready: mended.ready, ...(mended.repaired.length ? { repaired: mended.repaired } : {}) };
}

// applyFixes(job, fixes): the patches a refusal proposed ([{code, pointer?, pointers?, patch}]), applied in order over the
// job, each whole or not at all; an operation another fix already applied is not applied twice, and a fix that writes a
// different value where an earlier one wrote is not applied (it would undo it). -> {patch: the operations applied, in
// order, applied: [{code, pointer, ops}], notApplied: [{code, pointer, patch, error}]}.
export function applyFixes(job, fixes) {
  let copy = structuredClone(job);
  const patch = [], applied = [], notApplied = [], seen = new Set(), written = new Map();
  for (const fix of Array.isArray(fixes) ? fixes : []) {
    const ops = Array.isArray(fix?.patch) ? fix.patch : [];
    const where = { code: fix?.code ?? null, pointer: fix?.pointer ?? (Array.isArray(fix?.pointers) ? fix.pointers[0] ?? null : null) };
    if (!ops.length) continue;
    const fresh = ops.filter(op => !seen.has(JSON.stringify(op)));
    const clash = fresh.find(op => isObject(op) && ['add', 'replace'].includes(op.op) && written.has(op.path) && written.get(op.path) !== JSON.stringify(op.value ?? null));
    if (clash) { notApplied.push({ ...where, patch: ops, error: 'another fix of this refusal writes a different value at ' + clash.path + ' (applying both would undo it)' }); continue; }
    const trial = structuredClone(copy);
    try { fresh.forEach((op, i) => applyOne(trial, op, patch.length + i)); }
    catch (error) { if (!(error instanceof PatchError)) throw error; notApplied.push({ ...where, patch: ops, error: error.message }); continue; }
    copy = trial;
    for (const op of fresh) { seen.add(JSON.stringify(op)); patch.push(op); if (isObject(op) && ['add', 'replace'].includes(op.op)) written.set(op.path, JSON.stringify(op.value ?? null)); }
    applied.push({ ...where, ops: ops.length });
  }
  return { patch, applied, notApplied };
}

// changeOnly(base, changed): a job with only what changed from base to changed (the ops of changed that base has not; of
// an op whose named data lists changed, only the changed or new elements of those lists, the rest of its data kept), as a
// new job over a module where base is already delivered. null when changed removes anything (a removal is a delete op,
// never computable here) or nothing changed.
export function changeOnly(base, changed) {
  const before = opsOf(base), after = opsOf(changed);
  if (!before || !after || after.length < before.length) return null;
  const used = new Set();
  const differing = [];
  for (let i = 0; i < after.length; i++) {
    const same = before.findIndex((b, j) => !used.has(j) && jsonEqual(b, after[i]));
    if (same >= 0) used.add(same); else differing.push(i);
  }
  const unmatched = before.map((_, j) => j).filter(j => !used.has(j));
  if (unmatched.length > differing.length) return null;
  const removesFrom = (was, op, lists) => lists.some(k => Array.isArray(was.data?.[k]) && was.data[k].some(e => !(Array.isArray(op.data?.[k]) ? op.data[k] : []).some(x => sameElement(x, e))));
  const ops = [];
  for (const i of differing) {
    const op = after[i];
    // the op of base it changed: the one at the same place with the same verb, left unmatched
    const was = unmatched.includes(i) && isObject(before[i]) && before[i].op === op?.op ? before[i] : null;
    if (!was) { ops.push(structuredClone(op)); continue; }
    let lists;
    try { lists = namedLists(op, i); } catch { lists = []; }
    try { lists = [...new Set([...lists, ...namedLists(was, i)])]; } catch { /* unnamed elements: compared whole */ }
    if (removesFrom(was, op, lists)) return null;
    const whole = !lists.length || !isObject(was.data) || !isObject(op.data) || Object.keys(op).some(k => k !== 'data' && !jsonEqual(op[k], was[k]))
      || Object.keys(op.data).some(k => !lists.includes(k) && !jsonEqual(op.data[k], was.data[k]));
    if (whole) { ops.push(structuredClone(op)); continue; }
    const data = {};
    for (const [k, v] of Object.entries(op.data)) {
      if (!lists.includes(k)) { data[k] = structuredClone(v); continue; }
      const old = Array.isArray(was.data[k]) ? was.data[k] : [];
      const kept = (Array.isArray(v) ? v : []).filter(e => !old.some(x => sameElement(x, e) && jsonEqual(x, e)));
      if (kept.length) data[k] = structuredClone(kept);
    }
    if (lists.some(k => Array.isArray(data[k]))) ops.push({ ...structuredClone(op), data });
  }
  const added = !Array.isArray(changed) && Array.isArray(changed.expectedMessages)
    ? changed.expectedMessages.filter(m => !(Array.isArray(base?.expectedMessages) ? base.expectedMessages : []).some(x => jsonEqual(x, m))) : [];
  if (!ops.length && !added.length) return null;
  if (Array.isArray(changed)) return ops;
  return { ...(changed.base !== undefined ? { base: changed.base } : {}), ops, ...(added.length ? { expectedMessages: added } : {}) };
}

// ---- R1: the patches a refusal proposed, kept by the job they patch (<dir>/<sha256>.json), for fix:"apply" on both lanes:
// each problem's patch, and the verified patches left out of the answer for size (verified-patch.mjs) as one more fix.
export const FIXES_SCHEMA = 'ssam-fixes/1';
const fixesFile = (dir, hash) => path.join(dir, String(hash).toLowerCase() + '.json');
export function saveRefusalFixes(dir, { job, jobSha256, problems, module = null }) {
  try {
    if (!dir || !SHA256.test(String(jobSha256 ?? ''))) return false;
    // T16: only a certain patch (patchCertain true: no choice of the author's) is applied for the author; a choice
    // (CREATE_USES_EXISTING, DELETE_RECONNECTS, a nearest name) stays on its problem, as for the verified patch.
    const fixes = (Array.isArray(problems) ? problems : []).filter(p => isObject(p) && Array.isArray(p.patch) && p.patch.length && p.patchCertain === true)
      .map(p => ({ code: p.code ?? null, ...(p.pointer != null ? { pointer: p.pointer } : {}), ...(Array.isArray(p.pointers) ? { pointers: p.pointers } : {}), patch: p.patch }));
    const verified = typeof job === 'string' ? readVerifiedPatch(job, jobSha256) : null;
    if (verified?.ok) {
      const given = new Set(fixes.flatMap(f => f.patch.map(op => JSON.stringify(op))));
      const rest = verified.patch.filter(op => !given.has(JSON.stringify(op)));
      if (rest.length) fixes.push({ code: 'verified', patch: rest });
    }
    if (!fixes.length) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fixesFile(dir, jobSha256), JSON.stringify({ schema: FIXES_SCHEMA, job, jobSha256: String(jobSha256).toLowerCase(), module, fixes }));
    return true;
  } catch { return false; /* fix:"apply" then says there is nothing to apply */ }
}
export function readRefusalFixes(dir, hash) {
  try { const saved = JSON.parse(fs.readFileSync(fixesFile(dir, hash), 'utf8')); return saved?.schema === FIXES_SCHEMA && Array.isArray(saved.fixes) ? saved : null; } catch { return null; }
}
// The patch fix:"apply" sends over the job file of basedOn (its bytes checked against sha256): every patch its refusal
// proposed that applies, in order. -> {ok:true, patch, applied, module} or {ok:false, code (FIX_NONE, BASE_CHANGED,
// BASE_NOT_FOUND, FIX_NOT_APPLIED), error, module?, notApplied?, fixesApplicable?, patchByName? (the ones that apply)}.
export function proposedPatch(dir, { file, sha256: hash }) {
  const saved = SHA256.test(String(hash ?? '')) ? readRefusalFixes(dir, hash) : null;
  const module = saved?.module ?? null;
  if (!saved?.fixes?.length) return fail('FIX_NONE', 'No refusal of this job proposed patches; nothing was sent.', { module });
  let document;
  try {
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== String(hash).toLowerCase()) return fail('BASE_CHANGED', 'The base job changed after that refusal (sha256 differs); nothing was patched.', { job: file, module });
    document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch { return fail('BASE_NOT_FOUND', 'No job file at ' + file + '; nothing was patched.', { module }); }
  const { patch, applied, notApplied } = applyFixes(document, saved.fixes);
  if (notApplied.length) return fail('FIX_NOT_APPLIED', notApplied.length + ' of the ' + (applied.length + notApplied.length) + ' patches this refusal proposed do not apply over its job; nothing was sent.',
    { module, notApplied, fixesApplicable: applied, patchByName: patch.length ? namedPatch(document, patch) ?? patch : [] });
  return { ok: true, patch, applied, module, patchByName: namedPatch(document, patch) ?? patch };
}
// servidor/fase4-27 a12: on a hosted server the next call after a refusal is the explicit patch, never fix "apply" nor patch
// "verified": the gate refuses both (it cannot read the server files they apply, hosted/policy.mjs verifiedPatchUnavailable).
// The patches of the refusal of the job of basedOn (proposedPatch), by name, as the patch of the same call; the gate then
// checks them like any patch (confineJobs). -> {tool, arguments, why} or null (none applies over that job).
export function explicitFixCall(dir, { tool, basedOn, file = basedOn?.job, keep = {} }) {
  if (!isObject(basedOn) || typeof file !== 'string') return null;
  const proposed = proposedPatch(dir, { file, sha256: basedOn.sha256 });
  if (!proposed.ok || !proposed.patch.length) return null;
  return { tool, arguments: { ...keep, basedOn, patch: proposed.patchByName },
    why: 'Every certain patch of the problems above, by name, as the patch over this job: the server checks it and delivers. A choice and a problem without a patch need your own operations in the same patch.' };
}

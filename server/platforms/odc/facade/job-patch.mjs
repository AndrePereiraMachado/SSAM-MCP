// A refused job corrected by a small patch instead of the whole job again (measured: resending the job costs ~48 s a
// correction, a patch ~5-8 s, and no Read+Edit of the file). The subset of JSON Patch (RFC 6902) a job needs: add,
// remove, replace, test; at most 50 operations; paths only inside the job's ops (/ops/<i>/... of {ops:[...]},
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
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PATCH_MAX_OPS = 50;
export const PATCH_OPS = Object.freeze(['add', 'remove', 'replace', 'test']);
const SHA256 = /^[a-fA-F0-9]{64}$/;
const TASK_ID = /^[0-9a-fA-F]{32}$/;
const INDEX = /^(?:0|[1-9][0-9]*)$/;
const OP_KEYS = new Set(['op', 'path', 'value']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

export class PatchError extends Error {
  constructor(code, message, at) { super(message); this.code = code; if (at != null) this.at = at; }
}

// The JSON Schema of the two arguments, for tools registered from JSON Schema (ssam.mjs o11_job / ssam_job and the
// studio_deliver proxy). o11-cycle.mjs declares the same shape in zod.
export const patchJsonSchema = Object.freeze({
  type: 'array', minItems: 1, maxItems: PATCH_MAX_OPS,
  items: { type: 'object', additionalProperties: false, required: ['op', 'path'],
    properties: { op: { type: 'string', enum: [...PATCH_OPS] }, path: { type: 'string', minLength: 1 }, value: {} } },
  description: 'JSON Patch (RFC 6902: add, remove, replace, test; at most 50) over the job of basedOn, paths /ops/<i>/... '
    + '(or /<i>/... of an array job) and /expectedMessages/- (a declaration {id, element, why} a refusal asked for). '
    + 'Instead of job: the patched job is written to a new file.',
});
export const basedOnJsonSchema = Object.freeze({
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['job', 'sha256'],
      properties: { job: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: SHA256.source } } },
    { type: 'object', additionalProperties: false, required: ['taskId'],
      properties: { taskId: { type: 'string', pattern: TASK_ID.source }, sha256: { type: 'string', pattern: SHA256.source } } },
  ],
  description: 'The job the patch applies to: {job, sha256} as a refusal returned them (job, jobSha256), or {taskId} of an O11 delivery task.',
});

// ---- JSON Patch over the ops of one job
function pointer(text, at, label) {
  if (typeof text !== 'string' || (text !== '' && !text.startsWith('/')))
    throw new PatchError('PATCH_INVALID', `${label}: path must be a JSON pointer such as /ops/0/value`, at);
  if (/~(?![01])/.test(text)) throw new PatchError('PATCH_INVALID', `${label}: "~" in a path is written ~0 ("/" is ~1)`, at);
  return text === '' ? [] : text.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// The ops array a patch may touch: the job itself (array job) or job.ops ({ops:[...]}, not a composite {jobs}).
const opsOf = job => (Array.isArray(job) ? job : job && typeof job === 'object' && job.jobs == null && Array.isArray(job.ops) ? job.ops : null);

// The job's ops, and the expectedMessages of a {ops} job (the declarations a refusal asks for: adding one is a patch, not
// the whole job again). An array job has no expectedMessages; base, expectValid and a composite's parts stay closed.
function area(tokens, job, at, label) {
  const inside = Array.isArray(job) ? tokens.length >= 1
    : (tokens.length >= 2 && tokens[0] === 'ops') || (tokens.length >= 1 && tokens[0] === 'expectedMessages');
  if (!inside) throw new PatchError('PATCH_PATH_FORBIDDEN', `${label}: only the job's ops${Array.isArray(job) ? '' : ' and expectedMessages'} are patched (${Array.isArray(job) ? '/<i>/...' : '/ops/<i>/..., /expectedMessages/-'})`, at);
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

// One operation on the (cloned) job. Every location but the last token must exist (RFC 6902 4.1).
function applyOne(job, operation, at) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new PatchError('PATCH_INVALID', `patch[${at}] is not an object {op, path, value?}`, at);
  const extra = Object.keys(operation).filter(k => !OP_KEYS.has(k));
  const { op, path: where } = operation;
  const label = `patch[${at}] ${typeof op === 'string' ? op : '?'} ${typeof where === 'string' ? where : '?'}`;
  if (extra.length) throw new PatchError('PATCH_INVALID', `${label}: unknown key(s) ${extra.join(', ')} (op, path, value)`, at);
  if (!PATCH_OPS.includes(op)) throw new PatchError('PATCH_INVALID', `${label}: op is one of ${PATCH_OPS.join(', ')} (move/copy: remove + add)`, at);
  if (op !== 'remove' && !Object.hasOwn(operation, 'value')) throw new PatchError('PATCH_INVALID', `${label}: ${op} needs value`, at);
  const tokens = pointer(where, at, label);
  area(tokens, job, at, label);
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

// The patched copy of a job (the job given is never changed). All operations or none: the first failure throws a
// PatchError {code, message, at}.
export function applyJobPatch(job, patch) {
  if (!Array.isArray(patch) || patch.length === 0) throw new PatchError('PATCH_INVALID', 'patch is a non-empty array of {op, path, value?}');
  if (patch.length > PATCH_MAX_OPS) throw new PatchError('PATCH_INVALID', `patch has ${patch.length} operations; at most ${PATCH_MAX_OPS} (send the whole job instead)`);
  if (!opsOf(job)) throw new PatchError('PATCH_PATH_FORBIDDEN', 'only a job with ops ({ops:[...]} or an array of ops) is patched; a composite {jobs} job is patched in its part file');
  const copy = structuredClone(job);
  patch.forEach((operation, at) => applyOne(copy, operation, at));
  const ops = opsOf(copy);
  if (!ops.length) throw new PatchError('PATCH_INVALID', 'the patched job has no ops left');
  const bad = ops.findIndex(o => !o || typeof o !== 'object' || Array.isArray(o));
  if (bad >= 0) throw new PatchError('PATCH_INVALID', `the patched job's op #${bad} is not an object`);
  return copy;
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
  if (typeof spec !== 'string' || !spec || BINDING.test(spec)) return spec;
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
    return { ok: true, path: file, sha256: sha256(fs.readFileSync(file)) };
  }
  if (!job || typeof job !== 'object') return fail('JOB_INVALID', 'job is a path or the job itself ({ops:[...]} or an array of ops)');
  const text = JSON.stringify(job, null, 2) + '\n';
  return { ok: true, path: writeInline(inlineDir, text, uuid), sha256: sha256(text) };
}

// {job} alone: the job file (an inline job written to <inlineDir>/<uuid>.json). {patch, basedOn}: the base read and
// checked, the patch applied, the result written to a NEW <inlineDir>/<uuid>.json. -> {ok, path, sha256, basedOn?} or
// {ok:false, code, error, at?, job?}. options: inlineDir (required), root (relative paths resolve there; without it
// they are refused), work (the O11 lane work folder, for basedOn.taskId), journalDir (the provenance line goes to
// <journalDir>/job-patch.jsonl, best effort), tool (named in that line), uuid, now.
export function resolvePatchedJob({ job, patch, basedOn } = {}, { root = null, inlineDir, work = null, journalDir = null, tool = null, uuid = randomUUID, now = () => new Date() } = {}) {
  if (!inlineDir) throw new Error('resolvePatchedJob needs inlineDir');
  if (patch == null && basedOn == null) return plainJob(job, { root, inlineDir, uuid });
  if (job != null) return fail('PATCH_INVALID', 'patch replaces job: send the whole job without patch, or patch with basedOn and no job');
  if (patch == null) return fail('PATCH_INVALID', 'basedOn goes with patch');
  if (basedOn == null) return fail('PATCH_INVALID', 'patch needs basedOn: {job, sha256} as a refusal returned them, or {taskId} of the refused delivery');
  const base = baseOf(basedOn, { root, work });
  if (!base.ok) return base;
  let parsed;
  try { parsed = JSON.parse(base.bytes.toString('utf8').replace(/^﻿/, '')); }
  catch (error) { return fail('PATCH_INVALID', 'The base job is not valid JSON: ' + error.message, { job: base.file }); }
  let patched;
  try { patched = applyJobPatch(parsed, patch); }
  catch (error) { if (error instanceof PatchError) return fail(error.code, error.message, error.at != null ? { at: error.at } : {}); throw error; }
  const text = JSON.stringify(pinReferences(patched, path.dirname(base.file), inlineDir), null, 2) + '\n';
  const file = writeInline(inlineDir, text, uuid);
  const result = { ok: true, path: file, sha256: sha256(text), basedOn: { job: base.file, sha256: base.sha256, ...(base.taskId ? { taskId: base.taskId } : {}) } };
  if (journalDir) {
    try {
      fs.mkdirSync(journalDir, { recursive: true });
      fs.appendFileSync(path.join(journalDir, 'job-patch.jsonl'), JSON.stringify({ at: now().toISOString(), event: 'patch', ...(tool ? { tool } : {}),
        job: file, jobSha256: result.sha256, basedOn: result.basedOn, patchOps: patch.length }) + '\n');
    } catch { /* the patched file stands; the line is provenance only */ }
  }
  return result;
}

// 'array' when the job text is an array of ops (its patch paths are /<i>/...); null for {ops} (/ops/<i>/..., the
// default a continuation assumes) or anything unreadable.
const shapeOfText = text => { try { return Array.isArray(JSON.parse(String(text).replace(/^﻿/, ''))) ? 'array' : null; } catch { return null; } };
export function jobShapeOf(file) {
  try { return shapeOfText(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// {job, jobSha256} of a job file (and jobShape 'array' for an array job), for a refusal the next call patches; {job}
// when it cannot be read; {} without a path.
export function jobIdentity(file) {
  if (typeof file !== 'string' || !file) return {};
  const job = path.resolve(file);
  let bytes;
  try { bytes = fs.readFileSync(job); } catch { return { job }; }
  const shape = shapeOfText(bytes.toString('utf8'));
  return { job, jobSha256: sha256(bytes), ...(shape ? { jobShape: shape } : {}) };
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

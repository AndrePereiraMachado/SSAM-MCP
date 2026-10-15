// The paths INSIDE a hosted job (servidor/fase4-24, item 1 of the rehearsal of the 24th release). The gate (policy.mjs)
// confines the path ARGUMENTS of a tool (tools.json paths); a job also names files the kernel and the facade read or
// build, and before this module nothing confined them: a hosted customer's job could name a file of this server or of
// another customer, and the kernel read it (a base or a producer loaded and written back into the customer's output, an
// html fragment, a WSDL, a composite part, a prototype capture).
//
// Every path-typed field of a job, enumerated from the kernel's job contracts and the facade's job readers:
//   - base (JobRunner.Sources.Base, JobSources.Resolve: a binding name, job:<name>, or a fixture/capture .oml);
//   - jobs[i] of a composite job (JobRunner.CollectOps/ResolveJobFile: job:<name>, or a path; each part is read and its own
//     fields resolve against the part's folder);
//   - ops[i].producer of a reference op (CollectOps resolveProducer, same rule as base; any op that carries it);
//   - ops[i].file of an html fragment op (HtmlVisual.Source: the working directory and the repository roots, never the
//     job's folder; any op that carries it);
//   - ops[i].data.source and data.capture of a prototype op (prototype-op.mjs expandJobFile, PrototypePreflight,
//     PrototypeCapture.Load);
//   - ops[i].data.wsdl of a soap op (a URL or a path; or {path, imports:{<uri>:{path}}}: integration-documents.mjs pin,
//     JobRunner.ResolveDocuments, SoapPlan) and ops[i].data.openapi.path / openapi.external.<uri>.path of a rest op
//     (RestOpenApi, OdcRestOpenApi);
//   - a job:<name> named by base or producer is a job the kernel BUILDS (Sources.Resolve -> Build): its own fields count.
// The other files of a call (manifests, assets, outputs, the job file itself, basedOn.job, producers) are tool arguments,
// confined by tools.json; no other field of the job schema (JobDocument.cs, VerbSurface.cs) names a file.
//
// How each value is taken, by where the job comes from:
//   - inline (an object, or its JSON text on a job pointer, parsed first by parseJobTexts): every path is REWRITTEN to the
//     absolute path inside the customer's workspace the gate resolves (ws:<rel>, agent:<rel> with the mirror's rule, an
//     absolute path inside the visible area, or a relative one under ws:<lane>/, as the tool arguments are), or refused;
//   - a job file of the workspace (the job, a composite part, a job:<name> target, the job of basedOn): read and checked,
//     never rewritten (its bytes are what the kernel reads). An absolute path must be inside; a name relative to the
//     file's folder is accepted only where the kernel tries that folder FIRST (a part, job:<name>, a WSDL/OpenAPI document)
//     and the file is there; anything the kernel would resolve elsewhere (the working directory, the repository, its
//     tests/jobs and tests/fixtures) is refused;
//   - the job a patch or a partial job produces over basedOn (moved: the handler writes it to another folder, job-patch.mjs
//     resolvePatchedJob): computed here in memory with the same functions, and stricter than a file: only base and
//     producers are pinned from the base's folder (pinReferences); every other relative name is refused.
// Never a path: a binding name (base, producer), an http(s) URL of a document (the facade pins it), and the server's own
// product fixtures by their suite name (base, producer: NEUTRAL_FIXTURE, e.g. tests/fixtures/odc/blank-mobile.oml; the
// hosted gate itself uses one as base). A file: URL is a path.
// A refusal is PATH_OUTSIDE_WORKSPACE naming the job pointer (e.g. /job/ops/2/file, or /job/jobs/0 > /ops/1/file inside a
// part); nothing was read outside the workspace and nothing ran.
// Fail closed (finding 2 of the confinement review): a job file the call reaches (the job, the job of basedOn, a composite
// part, a job:<name> target of base or producer) that exists but that the gate cannot read whole as the kernel reads it is
// JOB_PATHS_UNCHECKED, whatever its field: the kernel's File.ReadAllText takes a UTF-8, UTF-16 LE/BE or UTF-32 byte-order
// mark, so the gate decodes UTF-8 and UTF-16 the same way (strictly) and refuses UTF-32, an invalid byte sequence, a text
// that is not JSON and a key written twice in one object (JSON.parse keeps the last value; another reader may not).
// A URL of a document is no path here: what the server may fetch is decided where it fetches (integration-documents.mjs,
// hosted/public-fetch.mjs: public addresses only, each redirect checked). The prototype op (D2) keeps its own refusal first: the
// walk also says whether any document it reached names the op, or could not be read whole (fail closed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideVisible } from './mirror.mjs';
import { PatchError, patchErrorFields, patchJob, mergePartialJob, readKernelTaskState } from '../job-patch.mjs';

export class PathRefusal extends Error { constructor(code, message, value, fix) { super(message); this.code = code; this.value = value; if (fix) this.fix = fix; } }
export const outside = value => new PathRefusal('PATH_OUTSIDE_WORKSPACE', 'Path outside the workspace of this account: ' + JSON.stringify(String(value).slice(0, 300)), value);

export const JOB_TOOLS = Object.freeze(['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job']);
export const MAX_JOB_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_DEPTH = 64;
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The server's own product fixtures a base or a producer may name by its suite name (the kernel resolves it under its
// tests/fixtures only): the blanks, the anonymized ODC lane fixture and the O11 UI fixtures. Never a customer capture
// (scripts/release/client-content.json fixtures.excluded, which the hosted image does not ship); anything else is refused.
export const NEUTRAL_FIXTURE = /^(?:tests[\\/]fixtures[\\/])?(?:(?:odc[\\/])?blank-[A-Za-z0-9_-]+|odc[\\/]insurance-reactive-r8|reactive-ui|traditional-ui|mobile-ui)\.oml$/i;
const HTTP_URL = /^https?:\/\//i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const looksLikeJson = value => typeof value === 'string' && /^\s*[[{]/.test(value);
const absoluteText = value => path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value);
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const escapeKey = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

// ---- D2: whether a value names the prototype op (moved here from policy.mjs, which re-exports it)
const isPrototypeName = value => typeof value === 'string' && value.trim().toLowerCase() === 'prototype';
// Whether a value (an inline job, a partial job, a patch, a basedOn) names the prototype op anywhere: an op
// {op:"prototype"}, or a patch entry that turns an op into one ({path:".../op", value:"prototype"}). JSON text is read
// as JSON. A value too large or too deep to read whole counts as naming it (the gate fails closed). Structural: the ops
// a composite job pulls from its part FILES are followed by confineJobs.
export function namesPrototype(value, budget = { left: 4000000 }, depth = 0) {
  if (looksLikeJson(value)) { try { return namesPrototype(JSON.parse(value), budget, depth + 1); } catch { return false; } }
  if (value === null || typeof value !== 'object') return false;
  if (--budget.left < 0 || depth > 128) return true;
  if (Array.isArray(value)) return value.some(item => namesPrototype(item, budget, depth + 1));
  if (isPrototypeName(value.op)) return true;
  if (typeof value.path === 'string' && /(^|[/.])op$/.test(value.path) && isPrototypeName(value.value)) return true;
  return Object.values(value).some(item => namesPrototype(item, budget, depth + 1));
}

// ---- servidor/fase4-25 (D2 of C:\t\vps-a5\PLANO.md, 3.2-E): whether a value names a generator op
// The generators of generators.mjs (GENERATOR_APPROVAL): entity-actions, rest-consume, and the op screen with data.generate
// (gen-screen). The id of the first one a value names, anywhere: an op {op:"entity-actions"}, {op:"screen", data:{generate}},
// a patch entry that turns an op into one ({path:".../op", value:"rest-consume"}) or that adds data.generate
// ({path:".../data/generate"}); JSON text is read as JSON; else null. A value too large or too deep to read whole is
// 'unreadable' (the gate fails closed). wanted(id): which generators count (the gate passes the pending ones, policy.mjs),
// so an approved one never hides a pending one further on; every one by default.
const GENERATOR_NAMES = new Map([['entity-actions', 'entity-actions'], ['gen-entity', 'entity-actions'], ['rest-consume', 'rest-consume'],
  ['gen-rest', 'rest-consume'], ['gen-screen', 'gen-screen']]);
const generatorOfName = value => (typeof value === 'string' ? GENERATOR_NAMES.get(value.trim().toLowerCase()) ?? null : null);
export function namesGenerator(value, wanted = () => true, budget = { left: 4000000 }, depth = 0) {
  if (looksLikeJson(value)) { try { return namesGenerator(JSON.parse(value), wanted, budget, depth + 1); } catch { return null; } }
  if (value === null || typeof value !== 'object') return null;
  if (--budget.left < 0 || depth > 128) return 'unreadable';
  if (Array.isArray(value)) { for (const item of value) { const found = namesGenerator(item, wanted, budget, depth + 1); if (found) return found; } return null; }
  const hit = id => (id && wanted(id) ? id : null);
  const byName = hit(generatorOfName(value.op));
  if (byName) return byName;
  if (typeof value.op === 'string' && value.op.trim().toLowerCase() === 'screen' && isObject(value.data) && value.data.generate != null && hit('gen-screen')) return 'gen-screen';
  if (typeof value.path === 'string') {
    if (/(^|[/.])op$/.test(value.path) && hit(generatorOfName(value.value))) return generatorOfName(value.value);
    if (/(^|\/)data\/generate(\/|$)/.test(value.path) && hit('gen-screen')) return 'gen-screen';
  }
  for (const item of Object.values(value)) { const found = namesGenerator(item, wanted, budget, depth + 1); if (found) return found; }
  return null;
}

// ---- where a call carries jobs
// The pointers where the JSON text of a job is the job itself (vel-hosted, narrowed here): the job of the four job tools,
// and the query of ssam_reference check-job (the job, or the partial job of {basedOn, patch, job}). Anywhere else a value
// that starts with "{" or "[" is a path like any other. basedOn.job is always a file.
export function jobTextPointers(name, args) {
  if (JOB_TOOLS.includes(name)) return ['/job'];
  if (name === 'ssam_reference' && args?.kind === 'check-job') return ['/query', '/query/job'];
  return [];
}
// servidor/fase4-25 (finding A1 of C:\t\vps-a5\conf-rapida\RELATORIO.md): patch "verified" makes the handler read its
// operations from <job of basedOn>.verified-patch.json, a file the gate never reads (job-patch.mjs resolvePatchedJob,
// verified-patch.mjs readVerifiedPatch), so the job it would build is one the gate cannot check. The pointer of such a
// patch in a call (/patch of the four job tools, /query/patch of ssam_reference check-job), or null. The gate refuses it
// (policy.mjs verifiedPatchUnavailable), and confineJobs refuses any patch it cannot apply itself.
export function namesVerifiedPatch(name, args) {
  if (!isObject(args)) return null;
  const slot = jobSlot(name, args);
  if (!slot || !isObject(slot.holder)) return null;
  const patch = slot.holder.patch;
  return typeof patch === 'string' && patch.trim().toLowerCase() === 'verified' ? slot.at + '/patch' : null;
}
// {holder, at, key}: the object that holds the job (key) and its basedOn and patch, with the pointer of that object.
function jobSlot(name, args) {
  if (JOB_TOOLS.includes(name)) return { holder: args, at: '', key: 'job' };
  if (name !== 'ssam_reference' || args?.kind !== 'check-job') return null;
  const query = args.query;
  if (isObject(query) && (query.basedOn !== undefined || query.patch !== undefined)) return { holder: query, at: '/query', key: 'job' };
  return { holder: args, at: '', key: 'query' };
}
export class JobTextError extends Error { constructor(pointer, message) { super(message); this.code = 'JOB_INVALID'; this.pointer = pointer; } }
// The arguments with the JSON text of each job pointer parsed into the job (a fresh copy when something changed). A text
// that looks like JSON there and does not parse is no path either: JobTextError (JOB_INVALID), and nothing runs.
export function parseJobTexts(name, args) {
  const pointers = jobTextPointers(name, args);
  if (!pointers.length || !isObject(args)) return args;
  let copy = null;
  for (const pointer of pointers) {
    const [, head, tail] = pointer.split('/');
    const holder = tail === undefined ? (copy ?? args) : (copy ?? args)[head];
    const key = tail === undefined ? head : tail;
    if (!isObject(holder) || !looksLikeJson(holder[key])) continue;
    let value;
    try { value = JSON.parse(holder[key]); }
    catch (error) { throw new JobTextError(pointer, `${pointer.slice(1)} is neither a path nor valid JSON: ${error.message}`); }
    if (value === null || typeof value !== 'object') throw new JobTextError(pointer, `${pointer.slice(1)} is neither a path nor a job ({ops:[...]} or an array of ops)`);
    copy ??= structuredClone(args);
    (tail === undefined ? copy : copy[head])[key] = value;
  }
  return copy ?? args;
}

// ---- the path-typed fields of one job document: {owner, key, at, kind}
//   kind 'source': base, producer (binding | job:<name> | .oml path); 'part': a composite part (job:<name> | path);
//   'jobdir': a WSDL/OpenAPI document (URL | path; a relative one is tried in the job's folder first); 'cwd': a file read
//   as written (html file, prototype source and capture, the imports of a pinned document).
function* pathFields(doc, at = '') {
  if (Array.isArray(doc)) { yield* opFields(doc, at); return; }
  if (!isObject(doc)) return;
  if (typeof doc.base === 'string') yield { owner: doc, key: 'base', at: at + '/base', kind: 'source' };
  if (Array.isArray(doc.jobs)) {
    for (const [i, part] of doc.jobs.entries()) {
      if (typeof part === 'string') yield { owner: doc.jobs, key: i, at: `${at}/jobs/${i}`, kind: 'part' };
      else if (part !== null && typeof part === 'object') yield* pathFields(part, `${at}/jobs/${i}`); // a part written inline
    }
  }
  if (Array.isArray(doc.ops)) yield* opFields(doc.ops, at + '/ops');
}
function* opFields(ops, at) {
  for (const [i, op] of ops.entries()) {
    if (!isObject(op)) continue;
    const here = `${at}/${i}`;
    const verb = typeof op.op === 'string' ? op.op.trim().toLowerCase() : '';
    if (typeof op.producer === 'string') yield { owner: op, key: 'producer', at: here + '/producer', kind: 'source' };
    if (typeof op.file === 'string') yield { owner: op, key: 'file', at: here + '/file', kind: 'cwd' };
    const data = op.data;
    if (!isObject(data)) continue;
    if (verb === 'prototype') for (const key of ['source', 'capture']) if (typeof data[key] === 'string') yield { owner: data, key, at: `${here}/data/${key}`, kind: 'cwd' };
    if (verb === 'soap') yield* documentFields(data, 'wsdl', 'imports', here + '/data');
    if (verb === 'rest') yield* documentFields(data, 'openapi', 'external', here + '/data');
  }
}
function* documentFields(owner, key, dependencies, at) {
  const value = owner[key];
  if (typeof value === 'string') { yield { owner, key, at: `${at}/${key}`, kind: 'jobdir' }; return; }
  if (!isObject(value)) return;
  if (typeof value.path === 'string') yield { owner: value, key: 'path', at: `${at}/${key}/path`, kind: 'jobdir' };
  if (isObject(value[dependencies]))
    for (const [uri, dependency] of Object.entries(value[dependencies]))
      if (isObject(dependency) && typeof dependency.path === 'string')
        yield { owner: dependency, key: 'path', at: `${at}/${key}/${dependencies}/${escapeKey(uri)}/path`, kind: 'cwd' };
}

// ---- the walk
const fileKey = file => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
// The text of a job file as the kernel's File.ReadAllText reads it (byte-order mark: UTF-8, UTF-16 LE/BE; none: UTF-8),
// decoded strictly; null for UTF-32 (no job is written so) and for any invalid byte sequence (the readers' replacements
// could differ).
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function decodeJobText(bytes) {
  const b = bytes;
  if (b.length >= 4 && ((b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) || (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff))) return null;
  try {
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(b.subarray(2));
    return UTF8.decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b);
  } catch { return null; }
}
// The first key written twice in one object of a JSON text that JSON.parse accepted, or null.
export function duplicateKey(text) {
  const stack = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (expectKey && top) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.has(key)) return key;
        top.add(key);
      }
      expectKey = false;
      i = j;
    } else if (c === '{') { stack.push(new Set()); expectKey = true; }
    else if (c === '[') { stack.push(null); expectKey = false; }
    else if (c === '}' || c === ']') { stack.pop(); expectKey = false; }
    else if (c === ',') expectKey = stack.at(-1) instanceof Set;
  }
  return null;
}
// A job file of the workspace: {doc} or why it was not read: 'missing' (the kernel's own answer, it reads nothing more),
// 'large' or 'invalid' (with what): both refused by the caller, since the gate cannot check what the kernel would read.
function readJob(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { why: 'missing' }; }
  if (!stat.isFile()) return { why: 'missing' };
  if (stat.size > MAX_JOB_BYTES) return { why: 'large', detail: 'a job file over ' + MAX_JOB_BYTES + ' bytes' };
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return { why: 'invalid', detail: 'a job file the gate cannot read' }; }
  const text = decodeJobText(bytes);
  if (text === null) return { why: 'invalid', detail: 'a job file that is not UTF-8 or UTF-16 text' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { why: 'invalid', detail: 'a job file that is not valid JSON' }; }
  const twice = duplicateKey(text);
  if (twice !== null) return { why: 'invalid', detail: 'a job file with the key ' + JSON.stringify(twice).slice(0, 80) + ' twice in one object' };
  return { doc };
}
const unchecked = (pointer, why) => new PathRefusal('JOB_PATHS_UNCHECKED', `The gate could not check every path this job names (${why}), so nothing ran.`, pointer,
  'save each job file as JSON in UTF-8 (or UTF-16 with its byte-order mark), every key once per object, at most ' + MAX_JOB_BYTES + ' bytes, and call again');
// servidor/fase4-25 (finding A1): the job a call makes over basedOn that the gate could not build (code: the handler's own
// PatchError code when its functions refused it; fields: its at and candidates, as the handler answers them).
const unbuilt = (pointer, code, why, error = null) => {
  const refusal = new PathRefusal(code, `The gate could not build and check the job this call makes over basedOn (${why}), so nothing ran.`, pointer,
    'send basedOn {job, sha256} as a refusal returned them (nextBasedOn) with patch: the JSON Patch operations themselves (at most 50), or a partial job as job; the gate checks the job they make');
  if (error instanceof PatchError) refusal.fields = patchErrorFields(error);
  return refusal;
};

class JobWalk {
  // resolve(value) -> the absolute workspace path of a ws:, agent:, absolute or relative value (policy.mjs resolveValue,
  // role 'in'), or throws a PathRefusal. prototype: whether D2 asks (the walk then also notes the prototype op).
  // generator(id) -> whether the gate refuses that generator (policy.mjs; null: the generators are not asked).
  constructor({ workspace, resolve, prototype, generator = null }) {
    this.workspace = path.resolve(workspace); this.resolver = resolve; this.prototypeOn = prototype; this.generatorOn = generator;
    this.prototype = false; this.generator = null; this.unknown = false; this.refusal = null; this.files = 0; this.seen = new Set(); this.resolved = new Map();
  }
  // One resolution per value and call (an agent: file is brought once).
  async resolve(value) {
    if (this.resolved.has(value)) return this.resolved.get(value);
    const abs = await this.resolver(value);
    this.resolved.set(value, abs);
    return abs;
  }
  // The first refusal is kept with its pointer and the walk goes on (a prototype op further on still answers first).
  refuse(error, pointer) {
    if (!(error instanceof PathRefusal)) throw error;
    error.pointer ??= pointer;
    this.refusal ??= error;
    return null;
  }
  inside(file) { return insideVisible(this.workspace, file); }
  notePrototype(doc) { if (this.prototypeOn && !this.prototype && namesPrototype(doc)) this.prototype = true; }
  noteGenerator(doc) {
    if (!this.generatorOn || this.generator) return;
    const id = namesGenerator(doc, this.generatorOn);
    if (id) this.generator = id;
  }

  // One document: every path-typed field checked (and, inline, rewritten in place).
  async document(doc, { mode, dir, at, depth }) {
    this.notePrototype(doc);
    this.noteGenerator(doc);
    for (const field of [...pathFields(doc)]) {
      const value = field.owner[field.key];
      const next = await this.value(value, field.kind, { mode, dir, pointer: at + field.at, depth });
      if (mode === 'inline' && typeof next === 'string' && next !== value) field.owner[field.key] = next;
    }
  }

  async value(value, kind, where) {
    if (value.trim() === '') return value;
    if (kind === 'source' && (BINDING.test(value) || NEUTRAL_FIXTURE.test(value))) return value;
    if (HTTP_URL.test(value)) return value; // a document's URL: the facade pins it; never a file of this server
    const job = (kind === 'source' || kind === 'part') && value.startsWith('job:');
    const file = job ? await this.jobName(value.slice(4), kind, where) : await this.path(value, kind, where);
    if (kind === 'part' || job) await this.follow(file, kind, where);
    if (where.mode !== 'inline' || !file) return value;
    return job ? 'job:' + file.slice(0, -'.json'.length) : file;
  }

  // A path value -> its absolute workspace path, or null after a refusal.
  async path(value, kind, { mode, dir, pointer }) {
    let text = value;
    if (/^file:/i.test(text)) {
      try { text = fileURLToPath(text); } catch { return this.refuse(outside(value), pointer); }
    }
    try {
      if (text.startsWith('ws:') || text.startsWith('agent:') || absoluteText(text) || mode === 'inline') return await this.resolve(text);
    } catch (error) { return this.refuse(error, pointer); }
    // A relative name in a file: only the file's own folder, where the kernel looks first (a part, a WSDL/OpenAPI document).
    if (mode === 'file' && (kind === 'part' || kind === 'jobdir')) {
      const candidate = path.resolve(dir, text);
      if (this.inside(candidate) && isFile(candidate)) return candidate;
    }
    return this.refuse(outside(value), pointer);
  }

  // job:<name> -> the job file the kernel reads (<name>.json), or null after a refusal. Inline: the name resolves like any
  // inline path (and is rewritten). A file: in the file's folder or the positive folder of a -negative one (ResolveJobFile)
  // when the file is there; the kernel would go on to the repository's tests/jobs, so nothing else is accepted. The moved
  // job of a patch: base and producers are pinned from the base's folder the same way (pinReferences); a part is not.
  async jobName(name, kind, { mode, dir, pointer }) {
    if (name.trim() === '') return this.refuse(outside('job:' + name), pointer);
    const file = name + '.json';
    try {
      if (file.startsWith('ws:') || file.startsWith('agent:') || absoluteText(file) || mode === 'inline') return await this.resolve(file);
    } catch (error) { return this.refuse(error, pointer); }
    if (mode === 'file' || (mode === 'moved' && kind === 'source')) {
      const folder = path.resolve(dir);
      const candidates = [path.resolve(folder, file)];
      const own = path.basename(folder);
      if (/-negative$/i.test(own)) candidates.push(path.resolve(path.dirname(folder), own.slice(0, -'-negative'.length), file));
      for (const candidate of candidates) if (this.inside(candidate) && isFile(candidate)) return candidate;
    }
    return this.refuse(outside('job:' + name), pointer);
  }

  // A job file the kernel reads where it is (a composite part, a job:<name> target): its own fields, against its own
  // folder. One that exists and the gate cannot read whole (not JSON, not UTF-8/UTF-16, a key twice, too large) is
  // JOB_PATHS_UNCHECKED, whatever the field; a part the gate does not read (refused, missing, too deep) also leaves the
  // prototype question open: D2 then fails closed (unknown), as the kernel's CollectOps would have read that part.
  async follow(file, kind, { pointer, depth }) {
    const open = () => { if (kind === 'part') this.unknown = true; };
    if (!file) return open();
    const key = fileKey(file);
    if (this.seen.has(key)) return; // read once (a cycle is the kernel's own refusal)
    if (depth >= MAX_DEPTH || this.files >= MAX_FILES) { open(); this.refuse(unchecked(pointer, 'more job files, or deeper, than the gate reads'), pointer); return; }
    this.seen.add(key); this.files++;
    const read = readJob(file);
    if (read.why === 'large' || read.why === 'invalid') this.refuse(unchecked(pointer, read.detail), pointer);
    if (!read.doc) return open();
    await this.document(read.doc, { mode: 'file', dir: path.dirname(file), at: pointer + ' > ', depth: depth + 1 });
  }

  // A top-level job file (the job, the job of basedOn): its document, or undefined (refused when it exists and the gate
  // cannot read it whole).
  top(file, pointer) {
    this.seen.add(fileKey(file)); this.files++;
    const read = readJob(file);
    if (read.why === 'large' || read.why === 'invalid') this.refuse(unchecked(pointer, read.detail), pointer);
    return read.doc;
  }
}

// The jobs of one call, after resolvePaths (every tool-level path already absolute in the workspace). Returns
// {resolved, prototype, refusal}: the arguments with every inline job rewritten (a fresh copy), whether a document the
// call reaches names the prototype op or could not be read whole (only when prototype is asked), and the first PathRefusal
// (its pointer set) or null. options: workspace, resolve(value) (policy.mjs, with the call's lane), prototype (D2).
// generator(id): servidor/fase4-25, whether the gate refuses that generator op (null: not asked); the answer then names the
// first refused generator the call reaches, or 'unreadable' for a part the gate could not read whole.
export async function confineJobs(name, resolved, { workspace, resolve, prototype = false, generator = null } = {}) {
  if (!jobSlot(name, resolved)) return { resolved, prototype: false, generator: null, refusal: null };
  const copy = structuredClone(resolved);
  const { holder, at, key } = jobSlot(name, copy);
  const walk = new JobWalk({ workspace, resolve, prototype, generator });
  const jobAt = at + '/' + key;
  const job = holder[key];
  // The job: inline (rewritten in the copy), or a file of the workspace (checked where it is). A missing or invalid job
  // file is the tool's own answer.
  let partial;
  if (job !== null && typeof job === 'object') {
    await walk.document(job, { mode: 'inline', dir: null, at: jobAt, depth: 0 });
    partial = job;
  } else if (typeof job === 'string' && path.isAbsolute(job) && isFile(job)) {
    partial = walk.top(job, jobAt);
    if (partial !== undefined) await walk.document(partial, { mode: 'file', dir: path.dirname(job), at: jobAt + ' > ', depth: 1 });
  }
  // basedOn + patch or partial job: the base file where it is, then the job the handler will write from it (moved),
  // computed here with the handler's own functions (job-patch.mjs).
  // servidor/fase4-25 (finding A1): fail closed. A job the gate could not build here is never let through unchecked: a
  // patch that is not a JSON Patch array (patch "verified" reads a file the gate does not), a patch or partial job the
  // handler's functions refuse (that same refusal answers here, before the handler), and a basedOn {taskId} whose recorded
  // job the gate cannot read are each refused, and nothing runs. A basedOn {job} that names no file is the handler's own
  // BASE_NOT_FOUND: it reads that same path and builds nothing.
  if (holder.basedOn != null || holder.patch != null) {
    if (holder.patch != null && !Array.isArray(holder.patch)) walk.refuse(unbuilt(at + '/patch', 'PATCH_INVALID', 'a patch that is not a JSON Patch array (patch "verified" is not available on a hosted server)'), at + '/patch');
    const base = baseFile(holder.basedOn, workspace, at, walk);
    if (!base && isObject(holder.basedOn) && holder.basedOn.taskId != null && !walk.refusal)
      walk.refuse(unbuilt(at + '/basedOn/taskId', 'JOB_PATHS_UNCHECKED', 'no job of this customer recorded by that delivery task'), at + '/basedOn/taskId');
    const baseDoc = base ? walk.top(base, at + '/basedOn/job') : undefined;
    if (baseDoc !== undefined) {
      await walk.document(baseDoc, { mode: 'file', dir: path.dirname(base), at: at + '/basedOn/job > ', depth: 1 });
      let effective;
      try {
        effective = structuredClone(baseDoc);
        if (partial !== undefined && partial !== null) effective = mergePartialJob(effective, partial).job;
        if (holder.patch != null) effective = patchJob(effective, holder.patch).job;
      } catch (error) {
        effective = undefined;
        walk.refuse(unbuilt(at + (holder.patch != null ? '/patch' : '/' + key), error?.code ?? 'JOB_PATHS_UNCHECKED', error?.message ?? String(error), error), at + (holder.patch != null ? '/patch' : '/' + key));
      }
      if (effective !== undefined) await walk.document(effective, { mode: 'moved', dir: path.dirname(base), at: at + '/basedOn/job (patched) > ', depth: 1 });
    }
  }
  return { resolved: copy, prototype: prototype && (walk.prototype || walk.unknown),
    generator: generator ? walk.generator ?? (walk.unknown ? 'unreadable' : null) : null, refusal: walk.refusal };
}

// The base job of basedOn: {job} (already confined by tools.json) or {taskId} (the job an O11 delivery of this customer
// ran, from its task state in <ws>/o11/work). A recorded job outside the workspace is refused; none: the handler answers.
function baseFile(basedOn, workspace, at, walk) {
  if (!isObject(basedOn)) return null;
  if (typeof basedOn.job === 'string') return path.isAbsolute(basedOn.job) && isFile(basedOn.job) ? basedOn.job : null;
  if (basedOn.taskId == null || !/^[0-9a-fA-F]{32}$/.test(String(basedOn.taskId))) return null;
  const state = readKernelTaskState(path.join(workspace, 'o11', 'work'), String(basedOn.taskId));
  const recorded = state?.request?.JobPath ?? state?.request?.jobPath;
  if (typeof recorded !== 'string' || !recorded) return null;
  const file = path.resolve(recorded);
  if (!walk.inside(file)) { walk.refuse(outside(recorded), at + '/basedOn/taskId'); return null; }
  return isFile(file) ? file : null;
}

// A check uses captured bytes only. It neither acquires a Studio nor updates its capture indexes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { anvilRoot, odcRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { modelSha256 } from './o11-capture-store.mjs';
import { cacheEntries, odcCaptures } from './producer-signatures.mjs';
import { canonicalKeyOf, sameProducer, studioNameOf } from './producer-names.mjs';
import { writeCall } from './ssam-code.mjs';
import { runJob, withJobIdentity } from './job-runner.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { residentWorkerClient, workerDisabled } from './anvil-worker.mjs';
import { mergeNormalizations } from './normalizations.mjs';
import { prototypeImportRefusal } from './prototype-disabled.mjs';
import { rememberSlotModel } from './build-pool.mjs';

// S9: what a check built, for the draft's write (code-draft.mjs): a symbol key, so no answer the model reads carries it.
export const CHECK_CANDIDATE = Symbol.for('ssam.check.candidate');

const forbidden = ['publish', 'authorize', 'until', 'captureProducers', 'closePrevious', 'resume', 'patch', 'expectedEnvironment'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lower = value => String(value ?? '').toLowerCase();
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const stat = file => { try { const s = fs.statSync(file); return s.isFile() ? s : null; } catch { return null; } };
const filesIn = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const nowMs = deps => Number(typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now());
// feat/ssam-code-hosted: deps.roots, the folders of a session that a server keeps apart from every other one (a hosted
// server: the customer's workspace), all absolute:
//   o11      the O11 lane folder: captures (snapshots/), producer cache (producer-cache/), check jobs (jobs/check/), plans/
//   odc      the ODC data folder: captures (snapshots/) and the producer captures
//   odcWork  the ODC work folder: check jobs (jobs/check/), plans/
// Given, the check and the plan read and write only there, never the folders of this checkout, and a base is only a capture
// of the lane's capture folder (<o11|odc>/snapshots), never any .oml. Without them, the folders of this checkout, as before.
export function codeRoots(deps = {}) {
  if (deps.roots != null) {
    const given = deps.roots;
    for (const key of ['o11', 'odc', 'odcWork'])
      if (typeof given?.[key] !== 'string' || !path.isAbsolute(given[key])) throw new Error(`roots.${key} must be an absolute folder`);
    return { o11: path.resolve(given.o11), odc: path.resolve(given.odc), odcWork: path.resolve(given.odcWork), confined: true };
  }
  const root = deps.root ?? anvilRoot;
  const o11 = deps.local ?? o11LaneOf(deps.o11Lane ?? o11Lane.lane, { root, env: deps.env ?? process.env, ...(deps.workspace ? { workspace: deps.workspace } : {}) }).local;
  return { o11, odc: deps.odcRoot ?? odcRoot, odcWork: path.join(root, '.local', 'lane-odc'), confined: false };
}
function locations(deps) {
  const roots = codeRoots(deps);
  return { root: deps.root ?? anvilRoot, local: roots.o11, odc: roots.odc, odcWork: roots.odcWork, confined: roots.confined };
}
const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The capture folder of a lane: the folder the newest capture is taken from.
const captureFolder = (lane, { local, odc }) => path.join(lane === 'o11' ? local : odc, 'snapshots');
const real = file => { try { return fs.realpathSync.native(file); } catch { return path.resolve(file); } };
const inside = (dir, file) => { const rel = path.relative(real(dir), real(file)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
/** Why a base is refused, or null: an existing absolute .oml; with deps.roots, a capture of the lane's capture folder only. */
export function baseProblem({ lane = 'o11', base } = {}, deps = {}) {
  if (base == null) return null;
  if (typeof base !== 'string' || !path.isAbsolute(base) || !/\.oml$/i.test(base) || !stat(base)) return 'base must be an existing absolute .oml file';
  const where = locations(deps);
  if (where.confined && !inside(captureFolder(lane, where), base))
    return 'base must be a capture of this ' + lane + ' lane, a file of ' + captureFolder(lane, where) + ' (the capture a read of the module made), never another .oml';
  return null;
}

export function newestCapture({ lane = 'o11', module, base } = {}, deps = {}) {
  const where = locations(deps);
  const { local, odc } = where;
  const candidates = [];
  const add = (file, source, at) => {
    const s = stat(file); if (!s) return;
    // With roots, a capture is a file of the lane's capture folder: an index row that names any other file is no capture.
    if (where.confined && !inside(captureFolder(lane, where), file)) return;
    const parsed = Date.parse(at);
    candidates.push({ path: path.resolve(file), source, time: Number.isFinite(parsed) ? parsed : s.mtimeMs });
  };
  if (base != null) {
    if (baseProblem({ lane, base }, deps)) return null;
    add(base, 'given');
  } else if (lane === 'o11') {
    const dir = path.join(local, 'snapshots');
    const index = readJson(path.join(dir, 'captures.json'));
    for (const rows of Object.values(index?.modules ?? {})) for (const row of Array.isArray(rows) ? rows : []) {
      if (lower(row?.module) === lower(module) && typeof row.path === 'string') add(path.resolve(dir, row.path), row.source ?? 'capture', row.at);
    }
    const safe = escape(String(module ?? '').replace(/[^\w.-]/g, '_'));
    const pattern = new RegExp(`^(?:build-)?${safe}-(?:\\d{14}-[a-f0-9]{8}|\\d{4}-?\\d{2}-?\\d{2}T?[\\d_.:-]+Z?)\\.oml$`, 'i');
    for (const name of filesIn(dir)) if (pattern.test(name)) add(path.join(dir, name), 'snapshot');
  } else {
    const dir = path.join(odc, 'snapshots');
    const namePattern = new RegExp(`^${escape(module)}-[a-f0-9]{64}\\.oml$`, 'i');
    for (const name of filesIn(dir)) {
      if (!namePattern.test(name)) continue;
      const file = path.join(dir, name), meta = readJson(file + '.json');
      if (meta && (meta.module == null || lower(meta.module) === lower(module))) add(file, 'snapshot', meta.capturedAt);
    }
    if (!candidates.length) {
      const revision = new RegExp(`^${escape(module)}-revision-\\d+\\.oml$`, 'i');
      for (const name of filesIn(dir)) if (revision.test(name)) add(path.join(dir, name), 'revision');
    }
  }
  candidates.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    try {
      return { path: candidate.path, sha256: hash(fs.readFileSync(candidate.path)), model: modelSha256(candidate.path),
        source: candidate.source, at: new Date(candidate.time).toISOString(), ageSeconds: Math.max(0, (nowMs(deps) - candidate.time) / 1000) };
    } catch { /* A removed capture cannot be used; try the next one. */ }
  }
  return null;
}

// Read references even when another file failed facade validation, so one refusal reports missing inputs together.
function referenceOps(input, call) {
  if (call.arguments?.job) return call.arguments.job.ops ?? [];
  const ops = Array.isArray(input.ops) ? [...input.ops] : [];
  for (const file of Array.isArray(input.files) ? input.files : []) {
    if (typeof file !== 'string' || !/\.json$/i.test(file)) continue;
    const value = readJson(file); ops.push(...(Array.isArray(value) ? value : Array.isArray(value?.ops) ? value.ops : []));
  }
  return ops;
}

// fix/system-reference (d): a producer is one by its binding key ("(System)" and "System" are System); the check binds the
// capture the lane already has of it (o11: the producer cache; odc: the delivery cache and the capture folder
// <odcRoot>/snapshots, producer-signatures.mjs odcCaptures), and a producer with none is ONE problem with the exact capture
// to take, read-only, as its continuation (the check itself never reads the Studio).
function resolveProducers(input, ops, deps, problems, { module, capture } = {}) {
  const { local, odc } = locations(deps);
  const provided = input.producers && typeof input.producers === 'object' && !Array.isArray(input.producers) ? input.producers : {};
  const bindings = {}, receipts = {};
  if (input.producers != null && provided !== input.producers) problems.push({ code: 'INPUT_INVALID', at: 'producers', message: 'producers is an object of binding names and absolute file paths' });
  for (const [name, file] of Object.entries(provided)) {
    const key = canonicalKeyOf(name);
    if (key == null) problems.push({ code: 'INPUT_INVALID', at: 'producers/' + name, message: 'Invalid producer binding name: ' + name + ' (a name such as Users, or the Studio form (System))' });
    else if (typeof file !== 'string' || !path.isAbsolute(file) || !stat(file)) problems.push({ code: 'INPUT_INVALID', at: 'producers/' + name, message: 'producer binding needs an existing absolute file path' });
    else { bindings[key] = file; receipts[key] = { path: file, storedAtUtc: null }; }
  }
  const requested = new Map();
  for (const op of ops) {
    if (op?.op !== 'reference' || !op.producer) continue;
    const name = String(op.producer);
    const key = canonicalKeyOf(name);
    if (key == null) continue; // a job: source or a fixture path: the kernel resolves it offline
    const held = [...requested.keys()].find(k => lower(k) === lower(key)) ?? key;
    const row = requested.get(held) ?? { elements: new Set(), written: [] };
    if (!row.written.includes(name)) row.written.push(name);
    for (const e of Array.isArray(op.elements) ? op.elements : []) row.elements.add(String(e));
    requested.set(held, row);
  }
  // The environment of the base capture (an ODC snapshot names its tenant in <capture>.oml.json), when it is known.
  const environment = input.lane === 'odc' && capture?.path ? readJson(capture.path + '.json')?.host ?? null : null;
  const entries = input.lane === 'o11' ? cacheEntries(path.join(local, 'producer-cache')) : null;
  for (const [key, { elements, written }] of requested) {
    if (Object.keys(bindings).some(k => lower(k) === lower(key))) continue;
    let found;
    if (input.lane === 'o11') {
      const matches = entries.filter(entry => sameProducer(entry.producer, key) && [...elements].every(e => entry.elements.includes(e)));
      matches.sort((a, b) => a.elements.length - b.elements.length || (Date.parse(b.storedAtUtc) || 0) - (Date.parse(a.storedAtUtc) || 0));
      found = matches[0];
    } else {
      const newest = odcCaptures(odc, { producer: key, environment })[0];
      found = newest && { path: newest.path, storedAtUtc: newest.observedAtUtc, source: newest.source };
    }
    if (found) {
      bindings[key] = found.path;
      receipts[key] = { path: found.path, storedAtUtc: found.storedAtUtc, ageSeconds: found.storedAtUtc ? Math.max(0, (nowMs(deps) - Date.parse(found.storedAtUtc)) / 1000) : null,
        ...(written.some(w => w !== key) ? { requested: written } : {}), ...(found.source ? { source: found.source } : {}) };
    } else problems.push(notCaptured({ lane: input.lane, key, written, elements: [...elements], module, odc }));
  }
  return { bindings, receipts };
}
// The one capture that lets the check bind the producer: read-only, through the lane's Studio, into the capture folder the
// check reads (o11: o11_dependencies capture keeps it in the producer cache; odc: studio_reference_snapshot keeps it in the
// delivery cache, and its file lands in <odcRoot>/snapshots).
function notCaptured({ lane, key, written, elements, module, odc }) {
  const studioName = studioNameOf(written[0] ?? key) ?? key;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const continuation = lane === 'o11'
    ? { tool: 'o11_dependencies', arguments: { action: 'capture', producer: studioName, ...(elements.length ? { elements } : {}) },
      why: `captures ${studioName} once, read-only, into the producer cache; the same check then binds it as ${key}` }
    : { tool: 'studio_reference_snapshot', arguments: { module: module ?? '<the open consumer module>', producer: studioName, output: path.join(odc, 'snapshots', 'producers', `${key}-${stamp}.avsig`) },
      why: `captures ${studioName} once, read-only, from the consumer session into the capture folder; the same check then binds it as ${key}` };
  return { code: 'PRODUCER_NOT_CAPTURED', producer: written[0] ?? key, ...(studioName !== (written[0] ?? key) ? { studioName } : {}),
    message: `No capture of ${studioName} is in this workspace (the job names ${written.map(w => '"' + w + '"').join(', ')})`,
    fix: (lane === 'o11' ? 'o11_dependencies capture' : 'studio_reference_snapshot') + ` of ${studioName} once (continuation), or a delivery, which captures it by itself; the check never reads the Studio`,
    continuation };
}

function withOrigin(problem, origins = []) {
  if (!problem || typeof problem !== 'object') return problem;
  const match = String(problem.pointer ?? '').match(/^\/ops\/(\d+)(?:\/data\/flow\/(\d+))?/);
  let origin = match ? origins[Number(match[1])] : null;
  if (origin && match[2] != null) origin = origin.flows?.[Number(match[2])] ?? { ...origin, action: origin.actions?.[Number(match[2])] };
  if (!origin) return problem;
  const { at, file, action } = origin;
  return { ...problem, origin: { at, ...(file ? { file } : {}), ...(action ? { action } : {}) } };
}

// S9 (check through the hot module): the lane's resident worker runs the check's apply when it is already up, idle, of the
// check's Studio installation and of the CLI on disk (anvil-worker.mjs residentWorkerClient: it never starts or stops one).
// The worker keeps the module hot by the model hash of the capture (R3, BaseModelCache): the next check or build of the same
// model skips load and walk. Without such a worker, with ANVIL_WORKER=0 (ANVIL_ODC_NO_WORKER on odc), or with an injected
// runner (tests, the bench), the check runs cold as before. deps.worker: a client of that shape, or null for cold.
function checkWorkerOf(lane, deps, root) {
  if (deps.worker !== undefined) return deps.worker;
  const env = deps.env ?? process.env;
  if (deps.runAnvil || deps.runJob || deps.execFileFn || workerDisabled(lane, env)) return null;
  try {
    return residentWorkerClient(lane, { root, env, o11: deps.o11Lane ?? o11Lane.lane, ...(deps.workspace ? { workspace: deps.workspace } : {}),
      // the lane's own environment, never the connection record (74087239: a check reads no Studio connection)
      laneEnv: ({ lane: name, root: home, env: base }) => o11LaneOf(name, { root: home, env: base }).env(base) });
  } catch { return null; }
}
// The check's runner with its apply on the worker; any other verb, and an apply the worker did not run, run cold. A request
// written with no reply is an unknown outcome: never replayed (a timeout, as the cold runner reports one).
function onWorker(worker, cold, seen) {
  return async (args, options = {}) => {
    if (String(args[0]) !== 'apply') return cold(args, options);
    const started = Date.now();
    const w = await worker.run(args.map(String), { timeoutMs: options.timeoutMs });
    const unrun = w.used && !w.unknown && w.envelope?.ok === false && w.envelope?.executed === false;
    if (!w.used || unrun) { seen.note = unrun ? 'the worker did not run the request (' + String(w.envelope.error ?? 'refused').slice(0, 160) + ')' : w.note; return cold(args, options); }
    seen.via = 'worker';
    if (w.unknown) return { ok: false, exitCode: 1, envelope: null, timedOut: true, unknown: true, code: w.code, stderr: [w.error].filter(Boolean), stdout: '', wallMs: Date.now() - started, via: 'worker' };
    return { ok: w.envelope?.ok === true, exitCode: w.envelope?.ok === true ? 0 : 1, envelope: w.envelope, stderr: w.warning ? [w.warning] : [], wallMs: Date.now() - started, via: 'worker' };
  };
}
// The kernel's own result of the apply (with provenance and sources, what PrebuiltCandidate reads), kept beside the
// candidate before the job runner writes its answer over <candidate>.result.json.
const KERNEL_RESULT = '.kernel-result.json';
function keepingKernelResult(run) {
  return async (args, options = {}) => {
    const r = await run(args, options);
    const out = String(args[0]) === 'apply' ? args[args.indexOf('--out') + 1] : null;
    if (typeof out === 'string' && /\.oml$/i.test(out)) { try { fs.copyFileSync(out.replace(/\.oml$/i, '.result.json'), out.replace(/\.oml$/i, KERNEL_RESULT)); } catch { /* no result: nothing to keep */ } }
    return r;
  };
}
// The kernel's time of the check (accepted or refused), from the result the job runner saved beside the candidate: where it
// ran, the kernel's own timings and the hot module (JobRunner hot {reused, reason, savedMs}).
function timingsOf(saved, via) {
  const data = saved?.data && typeof saved.data === 'object' ? saved.data : null;
  if (!saved || typeof saved !== 'object') return null;
  const own = Object.fromEntries(Object.entries(data?.timings ?? {}).filter(([, v]) => Number.isFinite(v)));
  const hot = data?.hot && typeof data.hot === 'object' ? { reused: data.hot.reused === true, reason: data.hot.reason ?? null, savedMs: Number.isFinite(data.hot.savedMs) ? data.hot.savedMs : 0 } : null;
  return { via, ...(Number.isFinite(saved.elapsedMs) ? { kernelMs: saved.elapsedMs } : {}), ...own, hot: hot ?? { reused: false, reason: via === 'worker' ? 'the kernel gave no hot receipt' : 'cold process', savedMs: 0 } };
}

export async function codeCheck(input = {}, deps = {}) {
  const lane = input.lane ?? 'o11', module = input.module ?? input.target;
  const problems = [];
  for (const field of forbidden) if (Object.hasOwn(input, field)) problems.push({ code: 'INPUT_INVALID', at: field, message: `${field} is not allowed in a check` });
  if (!['o11', 'odc'].includes(lane)) problems.push({ code: 'INPUT_INVALID', at: 'lane', message: 'lane is o11 or odc' });
  const clean = { ...input, lane };
  for (const field of forbidden) delete clean[field];
  delete clean.stubs;
  const stubs = Array.isArray(input.stubs) ? input.stubs : [];
  if (input.stubs != null && !Array.isArray(input.stubs)) problems.push({ code: 'INPUT_INVALID', at: 'stubs', message: 'stubs is a list of absolute .flow or .html paths' });
  for (const [i, file] of stubs.entries()) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.(flow|html)$/i.test(file)) problems.push({ code: 'INPUT_INVALID', at: `stubs/${i}`, message: 'a stub needs an absolute .flow or .html path', ...(typeof file === 'string' ? { origin: { at: `stubs/${i}`, file } } : {}) });
  }
  if (stubs.length) {
    if (input.files != null && !Array.isArray(input.files)) problems.push({ code: 'INPUT_INVALID', at: 'files', message: 'files must be a list of absolute paths' });
    clean.files = [...stubs, ...(Array.isArray(input.files) ? input.files : [])];
  }
  const originalAt = at => typeof at === 'string' ? at.replace(/^(\/?files\/)(\d+)/, (_, prefix, index) => {
    const i = Number(index), slash = prefix.startsWith('/') ? '/' : '';
    return i < stubs.length ? `${slash}stubs/${i}` : `${slash}files/${i - stubs.length}`;
  }) : at;
  const originalSource = origin => origin && ({ ...origin, at: originalAt(origin.at), ...(origin.flows ? { flows: origin.flows.map(originalSource) } : {}) });
  // The read of an action an edit expands (readReading) and the job file of a correction (readJob) are the server's to give.
  const call = (deps.writeCall ?? writeCall)(clean, { origins: true, ...(deps.readReading ? { readReading: deps.readReading } : {}), ...(deps.readJob ? { readJob: deps.readJob } : {}) });
  if (call.origins) call.origins = call.origins.map(originalSource);
  if (call.refusal) problems.push(...(call.refusal.problems?.length ? call.refusal.problems : [{ code: 'INPUT_INVALID', message: call.refusal.error }]).map(p => {
    const index = String(p.at ?? '').match(/^\/?files\/(\d+)/);
    const file = index ? clean.files?.[Number(index[1])] : null;
    const at = originalAt(p.at);
    return { code: 'INPUT_INVALID', ...p, ...(at != null ? { at } : {}), ...(typeof file === 'string' ? { origin: { at: String(at).replace(/^\//, ''), file } } : {}) };
  }));
  const capture = newestCapture({ lane, module, base: input.base }, deps);
  if (!capture) problems.push({ code: input.base != null ? 'INPUT_INVALID' : 'CAPTURE_MISSING', at: 'base', message: input.base != null ? baseProblem({ lane, base: input.base }, deps) ?? 'base must be an existing absolute .oml file' : `No capture of ${module ?? 'the module'} is available`, fix: 'the main agent reads the module once; that capture serves every check' });
  // CX16: a write refusal's own problem codes (HTML_EDIT_INVALID, EDIT_*, BASE_CHANGED) are input problems of the check: the
  // code stays as reason. Edits of the texts of the job of basedOn {job, sha256} came back as writeCall's generated patch
  // (its patch route has no job; the model's own patch stays forbidden above): the corrected job is resolved here, before the
  // reference ops are read from it (referenceOps) and before it is written as the job of this check.
  if (call.refusal) for (const p of problems) if (p.code !== 'INPUT_INVALID' && p.code !== 'CAPTURE_MISSING') { p.reason = p.code; p.code = 'INPUT_INVALID'; }
  if (!call.refusal && call.arguments?.patch != null && call.arguments.job == null) {
    const { root: home, local: laneLocal, odcWork } = locations(deps);
    const { resolvePatchedJob } = await import('./job-patch.mjs');
    const patched = resolvePatchedJob({ patch: call.arguments.patch, basedOn: call.arguments.basedOn }, { root: home,
      inlineDir: path.join(lane === 'o11' ? laneLocal : odcWork, 'jobs', 'check'), ...(deps.uuid ? { uuid: deps.uuid } : {}) });
    if (!patched.ok) problems.push({ code: 'INPUT_INVALID', at: 'basedOn', reason: patched.code, message: patched.error, ...(patched.candidates ? { candidates: patched.candidates } : {}) });
    else { call.arguments.job = readJson(patched.path); fs.rmSync(patched.path, { force: true }); }
  }
  // The prototype import is turned off (prototype-disabled.mjs): its one refusal, before any capture or kernel check.
  { const disabled = call.arguments?.job != null ? prototypeImportRefusal(call.arguments.job, { lane, module }) : null;
    if (disabled) return { ...disabled, lane, module, action: 'check' }; }
  // CX16 (b): a refused check names the job it checked (job, jobSha256, nextBasedOn: the base of a correction by edits); the
  // static refusal of the precheck (stage "static", stopped before the apply) passes stage, stoppedBefore, static and, at the
  // refusal below, its continuation instead of the whole input again.
  const refusalFields = (r, file) => ({ ...(({ job: j, jobSha256, nextBasedOn }) => ({ job: j, ...(jobSha256 ? { jobSha256 } : {}), ...(nextBasedOn ? { nextBasedOn } : {}) }))(r.jobSha256 ? r : withJobIdentity({ ok: false, job: r.job ?? file })),
    ...(r.stage === 'static' ? { stage: r.stage, ...(r.stoppedBefore ? { stoppedBefore: r.stoppedBefore } : {}), ...(r.static ? { static: r.static } : {}) } : {}) });
  const ops = referenceOps(clean, call);
  const { bindings, receipts } = resolveProducers(clean, ops, deps, problems, { module, capture });
  // fix/system-reference (d): a check refused only for producers with no capture continues with the capture to take.
  const capturing = problems.filter(p => p.code === 'PRODUCER_NOT_CAPTURED');
  const continuation = !capture && input.base == null ? { tool: 'ssam_map', arguments: { lane, target: module }, why: 'the main agent reads the module once; that capture serves every check' }
    : capturing.length && capturing.length === problems.length ? capturing[0].continuation
    : { tool: 'ssam_code', arguments: { ...input, lane, action: 'check' } };
  if (problems.length) return { ok: false, code: problems.some(p => p.code === 'INPUT_INVALID') ? 'INPUT_INVALID' : !capture ? 'CAPTURE_MISSING' : 'PRODUCER_NOT_CAPTURED', lane, module, action: 'check', problems, ...(capture ? { capture } : {}), continuation };
  const { root, local, odcWork, odc: odcData, confined } = locations(deps);
  const dir = path.join(lane === 'o11' ? local : odcWork, 'jobs', 'check', (deps.uuid ?? randomUUID)());
  fs.mkdirSync(dir, { recursive: true });
  const job = path.join(dir, 'job.json');
  fs.writeFileSync(job, JSON.stringify(call.arguments.job, null, 2));
  const start = nowMs(deps);
  let result;
  const env = { ...(deps.env ?? process.env), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const cold = deps.runAnvil ?? createAnvilRunner({ root, env, lane: deps.o11Lane ?? o11Lane.lane,
    environment: ({ lane, root, env }) => o11LaneOf(lane, { root, env }).env(env),
    ...(deps.execFileFn ? { execFileFn: deps.execFileFn } : {}) });
  // S9: the job runner keeps env without its worker (the precheck and the guidance run as before); its apply goes to the
  // resident worker through this runner.
  const worker = checkWorkerOf(lane, deps, root);
  const seen = { via: 'process' };
  const runAnvil = keepingKernelResult(worker ? onWorker(worker, cold, seen) : cold);
  try {
    // With roots, the producers a job runner binds by itself (an ODC job's captures) are the session's too.
    result = await (deps.runJob ?? runJob)({ lane, job, base: capture.path, out: path.join(dir, 'candidate.oml'), work: path.join(dir, 'work'), producers: bindings, quiet: true },
      { ...deps, env, runAnvil, ...(confined ? { odcRoot: odcData } : {}) });
    if (!result.ok && result.stage !== 'static') { // CX16 (c): a static refusal carries its own correction; guidance measured ~0.2 s, ~2.9 KB
      if (deps.guidance) result = await deps.guidance(lane, result.job ?? job, result);
      else {
        // The normal guidance, with installation metadata only: laneSources otherwise reads the Studio connection.
        const { jobGuidance } = await import('./job-guidance.mjs');
        const { laneSources } = await import('./discovery.mjs');
        try {
          const discovery = await jobGuidance({ lane, job: result.job ?? job, run: result,
            sources: laneSources(lane, { env, studio: { connection: () => null } }) });
          if (discovery) result = { ...result, discovery };
        } catch (error) { result = { ...result, discovery: { available: false, reason: 'guidance failed: ' + error.message } }; }
      }
    }
    result = withJobIdentity(result);
  } catch (error) { result = { ok: false, error: error.message }; }
  const resultFile = path.join(dir, 'candidate.result.json');
  const timings = timingsOf(readJson(resultFile), seen.via);
  const common = { lane, module, action: 'check', capture, ...(Object.keys(receipts).length ? { producers: receipts } : {}), wallMs: nowMs(deps) - start, ...(timings ? { timings } : {}) };
  // The worker that built it keeps the module's spare (R3): the build pool prefers its slot for that model (slot 0 is the
  // lane's own worker, build-pool.mjs slotWorkerPort).
  if (seen.via === 'worker' && lane === 'o11' && capture.model && worker?.target?.port != null) rememberSlotModel(capture.model, { port: worker.target.port });
  // One `normalizations` field, accepted or refused (normalizations.mjs): the facade's list of what writeCall took as meant
  // beside what the job runner reports, which is the kernel's JobNormalizer object {total, byRule, items} or a list.
  const notes = mergeNormalizations(result.normalizations, call.normalizations);
  const normalizations = notes != null && (!Array.isArray(notes) || notes.length) ? { normalizations: notes } : {};
  if (result.ok) {
    const answer = { ok: true, ...common, valid: true, verifyRan: result.verifyRan ?? true, job: result.job ?? job, jobSha256: result.jobSha256 ?? hash(fs.readFileSync(job)),
      ...normalizations, next: 'answer only the file path; the main agent delivers ONE ssam_code write {module, files}' };
    const candidate = path.join(dir, 'candidate.oml'), kernelResult = path.join(dir, 'candidate' + KERNEL_RESULT);
    if (stat(candidate) && stat(kernelResult)) answer[CHECK_CANDIDATE] = { path: candidate, sha256: hash(fs.readFileSync(candidate)), result: kernelResult, job: result.job ?? job,
      base: capture.path, baseSha256: capture.sha256, baseModelSha256: capture.model ?? null, producers: bindings, via: seen.via };
    return answer;
  }
  return { ok: false, code: 'CHECK_REFUSED', refusalCode: result.code, ...common, ...refusalFields(result, job), problems: (result.problems ?? []).map(p => withOrigin(p, call.origins)),
    verifyRan: result.verifyRan ?? false, ...(result.phases ? { phases: result.phases } : {}), ...(result.error ? { error: result.error } : {}), ...normalizations,
    ...(result.discovery ? { discovery: result.discovery } : {}), continuation: result.stage === 'static' && result.continuation ? result.continuation : { tool: 'ssam_code', arguments: { ...input, lane, action: 'check' } } };
}

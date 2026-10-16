// A check uses captured bytes only. It neither acquires a Studio nor updates its capture indexes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { anvilRoot, odcRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { modelSha256 } from './o11-capture-store.mjs';
import { cacheEntries } from './producer-signatures.mjs';
import { writeCall } from './ssam-code.mjs';
import { runJob, withJobIdentity } from './job-runner.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { mergeNormalizations } from './normalizations.mjs';

const forbidden = ['publish', 'authorize', 'until', 'captureProducers', 'closePrevious', 'resume', 'patch', 'expectedEnvironment'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lower = value => String(value ?? '').toLowerCase();
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const stat = file => { try { const s = fs.statSync(file); return s.isFile() ? s : null; } catch { return null; } };
const filesIn = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const nowMs = deps => Number(typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now());
function locations(deps) {
  const root = deps.root ?? anvilRoot;
  const local = deps.local ?? o11LaneOf(deps.o11Lane ?? o11Lane.lane, { root, env: deps.env ?? process.env, ...(deps.workspace ? { workspace: deps.workspace } : {}) }).local;
  return { root, local, odc: deps.odcRoot ?? odcRoot };
}
const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function newestCapture({ lane = 'o11', module, base } = {}, deps = {}) {
  const { local, odc } = locations(deps);
  const candidates = [];
  const add = (file, source, at) => {
    const s = stat(file); if (!s) return;
    const parsed = Date.parse(at);
    candidates.push({ path: path.resolve(file), source, time: Number.isFinite(parsed) ? parsed : s.mtimeMs });
  };
  if (base != null) {
    if (typeof base !== 'string' || !path.isAbsolute(base) || !/\.oml$/i.test(base) || !stat(base)) return null;
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

function odcEntries(root) {
  const dir = path.join(root, '.local', 'producer-cache', 'odc');
  return filesIn(dir).filter(name => /\.json$/i.test(name)).flatMap(name => {
    const record = readJson(path.join(dir, name)), file = path.join(dir, name.replace(/\.json$/i, '.avsig'));
    if (!record?.producer || !stat(file)) return [];
    try { if (record.sha256 !== hash(fs.readFileSync(file))) return []; } catch { return []; }
    return [{ ...record, path: file, storedAtUtc: record.storedAtUtc ?? record.observedAtUtc ?? null }];
  });
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

function resolveProducers(input, ops, deps, problems) {
  const { local, odc } = locations(deps);
  const provided = input.producers && typeof input.producers === 'object' && !Array.isArray(input.producers) ? input.producers : {};
  const bindings = {}, receipts = {};
  if (input.producers != null && provided !== input.producers) problems.push({ code: 'INPUT_INVALID', at: 'producers', message: 'producers is an object of binding names and absolute file paths' });
  for (const [name, file] of Object.entries(provided)) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !stat(file)) problems.push({ code: 'INPUT_INVALID', at: 'producers/' + name, message: 'producer binding needs an existing absolute file path' });
    else { bindings[name] = file; receipts[name] = { path: file, storedAtUtc: null }; }
  }
  const requested = new Map();
  for (const op of ops) {
    if (op?.op !== 'reference' || !op.producer) continue;
    const name = String(op.producer);
    const row = requested.get(name) ?? new Set();
    for (const e of Array.isArray(op.elements) ? op.elements : []) row.add(String(e));
    requested.set(name, row);
  }
  const entries = input.lane === 'o11' ? cacheEntries(path.join(local, 'producer-cache')) : odcEntries(odc);
  for (const [name, elements] of requested) {
    if (Object.keys(bindings).some(key => lower(key) === lower(name))) continue;
    const matches = entries.filter(entry => lower(entry.producer) === lower(name) && (input.lane !== 'o11' || [...elements].every(e => entry.elements.includes(e))));
    matches.sort((a, b) => (input.lane === 'o11' ? a.elements.length - b.elements.length : 0) || (Date.parse(b.storedAtUtc) || 0) - (Date.parse(a.storedAtUtc) || 0));
    const found = matches[0];
    if (found) {
      bindings[name] = found.path;
      receipts[name] = { path: found.path, storedAtUtc: found.storedAtUtc, ageSeconds: found.storedAtUtc ? Math.max(0, (nowMs(deps) - Date.parse(found.storedAtUtc)) / 1000) : null };
    } else problems.push({ code: 'PRODUCER_NOT_CAPTURED', producer: name, message: `No captured producer covers ${name}`, fix: 'one delivery or o11_job captureProducers captures it once; check never reads the Studio' });
  }
  return { bindings, receipts };
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
  const call = (deps.writeCall ?? writeCall)(clean, { origins: true });
  if (call.origins) call.origins = call.origins.map(originalSource);
  if (call.refusal) problems.push(...(call.refusal.problems?.length ? call.refusal.problems : [{ code: 'INPUT_INVALID', message: call.refusal.error }]).map(p => {
    const index = String(p.at ?? '').match(/^\/?files\/(\d+)/);
    const file = index ? clean.files?.[Number(index[1])] : null;
    const at = originalAt(p.at);
    return { code: 'INPUT_INVALID', ...p, ...(at != null ? { at } : {}), ...(typeof file === 'string' ? { origin: { at: String(at).replace(/^\//, ''), file } } : {}) };
  }));
  const capture = newestCapture({ lane, module, base: input.base }, deps);
  if (!capture) problems.push({ code: input.base != null ? 'INPUT_INVALID' : 'CAPTURE_MISSING', at: 'base', message: input.base != null ? 'base must be an existing absolute .oml file' : `No capture of ${module ?? 'the module'} is available`, fix: 'the main agent reads the module once; that capture serves every check' });
  // CX16: a write refusal's own problem codes (HTML_EDIT_INVALID, EDIT_*, BASE_CHANGED) are input problems of the check: the
  // code stays as reason. Edits of the texts of the job of basedOn {job, sha256} came back as writeCall's generated patch
  // (its patch route has no job; the model's own patch stays forbidden above): the corrected job is resolved here, before the
  // reference ops are read from it (referenceOps) and before it is written as the job of this check.
  if (call.refusal) for (const p of problems) if (p.code !== 'INPUT_INVALID' && p.code !== 'CAPTURE_MISSING') { p.reason = p.code; p.code = 'INPUT_INVALID'; }
  if (!call.refusal && call.arguments?.patch != null && call.arguments.job == null) {
    const { root: home, local: laneLocal } = locations(deps);
    const { resolvePatchedJob } = await import('./job-patch.mjs');
    const patched = resolvePatchedJob({ patch: call.arguments.patch, basedOn: call.arguments.basedOn }, { root: home,
      inlineDir: path.join(lane === 'o11' ? laneLocal : path.join(home, '.local', 'lane-odc'), 'jobs', 'check'), ...(deps.uuid ? { uuid: deps.uuid } : {}) });
    if (!patched.ok) problems.push({ code: 'INPUT_INVALID', at: 'basedOn', reason: patched.code, message: patched.error, ...(patched.candidates ? { candidates: patched.candidates } : {}) });
    else { call.arguments.job = readJson(patched.path); fs.rmSync(patched.path, { force: true }); }
  }
  // CX16 (b): a refused check names the job it checked (job, jobSha256, nextBasedOn: the base of a correction by edits); the
  // static refusal of the precheck (stage "static", stopped before the apply) passes stage, stoppedBefore, static and, at the
  // refusal below, its continuation instead of the whole input again.
  const refusalFields = (r, file) => ({ ...(({ job: j, jobSha256, nextBasedOn }) => ({ job: j, ...(jobSha256 ? { jobSha256 } : {}), ...(nextBasedOn ? { nextBasedOn } : {}) }))(r.jobSha256 ? r : withJobIdentity({ ok: false, job: r.job ?? file })),
    ...(r.stage === 'static' ? { stage: r.stage, ...(r.stoppedBefore ? { stoppedBefore: r.stoppedBefore } : {}), ...(r.static ? { static: r.static } : {}) } : {}) });
  const ops = referenceOps(clean, call);
  const { bindings, receipts } = resolveProducers(clean, ops, deps, problems);
  // Prototype capture is a Studio operation in runJob; a check must never enter that path.
  for (let i = 0; i < ops.length; i++) if (ops[i]?.op === 'prototype') problems.push({ code: 'INPUT_INVALID', pointer: `/ops/${i}`, message: 'prototype requires a live capture and cannot run in an offline check' });
  const continuation = !capture && input.base == null ? { tool: 'ssam_map', arguments: { lane, target: module }, why: 'the main agent reads the module once; that capture serves every check' }
    : { tool: 'ssam_code', arguments: { ...input, lane, action: 'check' } };
  if (problems.length) return { ok: false, code: problems.some(p => p.code === 'INPUT_INVALID') ? 'INPUT_INVALID' : !capture ? 'CAPTURE_MISSING' : 'PRODUCER_NOT_CAPTURED', lane, module, action: 'check', problems, ...(capture ? { capture } : {}), continuation };
  const { root, local } = locations(deps);
  const dir = path.join(lane === 'o11' ? local : path.join(root, '.local', 'lane-odc'), 'jobs', 'check', (deps.uuid ?? randomUUID)());
  fs.mkdirSync(dir, { recursive: true });
  const job = path.join(dir, 'job.json');
  fs.writeFileSync(job, JSON.stringify(call.arguments.job, null, 2));
  const start = nowMs(deps);
  let result;
  const env = { ...(deps.env ?? process.env), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const runAnvil = deps.runAnvil ?? createAnvilRunner({ root, env, lane: deps.o11Lane ?? o11Lane.lane,
    environment: ({ lane, root, env }) => o11LaneOf(lane, { root, env }).env(env),
    ...(deps.execFileFn ? { execFileFn: deps.execFileFn } : {}) });
  try {
    result = await (deps.runJob ?? runJob)({ lane, job, base: capture.path, out: path.join(dir, 'candidate.oml'), work: path.join(dir, 'work'), producers: bindings, quiet: true },
      { ...deps, env, runAnvil });
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
  const common = { lane, module, action: 'check', capture, ...(Object.keys(receipts).length ? { producers: receipts } : {}), wallMs: nowMs(deps) - start };
  // One `normalizations` field, accepted or refused (normalizations.mjs): the facade's list of what writeCall took as meant
  // beside what the job runner reports, which is the kernel's JobNormalizer object {total, byRule, items} or a list.
  const notes = mergeNormalizations(result.normalizations, call.normalizations);
  const normalizations = notes != null && (!Array.isArray(notes) || notes.length) ? { normalizations: notes } : {};
  if (result.ok) return { ok: true, ...common, valid: true, verifyRan: result.verifyRan ?? true, job: result.job ?? job, jobSha256: result.jobSha256 ?? hash(fs.readFileSync(job)),
    ...normalizations, next: 'answer only the file path; the main agent delivers ONE ssam_code write {module, files}' };
  return { ok: false, code: 'CHECK_REFUSED', refusalCode: result.code, ...common, ...refusalFields(result, job), problems: (result.problems ?? []).map(p => withOrigin(p, call.origins)),
    verifyRan: result.verifyRan ?? false, ...(result.phases ? { phases: result.phases } : {}), ...(result.error ? { error: result.error } : {}), ...normalizations,
    ...(result.discovery ? { discovery: result.discovery } : {}), continuation: result.stage === 'static' && result.continuation ? result.continuation : { tool: 'ssam_code', arguments: { ...input, lane, action: 'check' } } };
}

// CX16 (W7): the UI precheck and its stop rule. Before any Studio step of a delivery (o11_deliver, the studio_deliver
// relay of the ssam server) and before the apply of a headless job (ssam_job, o11_job, and ssam_code check, which runs
// runJob with a base), a job of screens or blocks (an op html in any form, or an op screen) is judged by the lane CLI's
// `check-job` with the static flags (CheckJobCommand: --module-index, --producer-index, --ui-catalog, --basis-fresh):
// what the documents of the job, the module index of its base, the indexes of the producers its reference ops name and
// the UI catalogs of the libraries the module references decide, in one answer. The stop rule (CX16 r2, M3; the owner's
// rule is ONE refusal with everything): an error of the preflight or of the static check refuses alone (PREFLIGHT_REFUSED,
// stage "static", stoppedBefore "studio" for a delivery, "apply" for a check or a job) only when check-job says the apply
// path can add nothing to it (static.complete: the job does not read, or every op is refused whole by its shape).
// Otherwise the precheck CARRIES its problems ({carry: true, ...}) and joinPrecheck puts them in the refusal of the apply
// path (one refusal, the same problem once); when the apply accepts the job, the static errors were no proof and only the
// lane journal keeps them.
// CX16 r3 (M3): the hooks call startUiPrecheck, and check-job runs ALONGSIDE the apply path, never before it (the r2 serial
// precheck added 1.3-6.4 s to every UI job): {pending} once the base is known (on an O11 delivery after the capture by key,
// which the build phase then shares), joined where the apply path answers. Only an o11_deliver has a step to spare: its
// Studio step waits for the verdict (the build ran meanwhile) and static.complete stops it there (pending.stop); a headless
// job and the ODC relay are their own apply path, so their verdict always joins. A warning never stops
// (a delivery that goes on leaves its warnings in the lane journal ui-precheck.jsonl, never in its answer). Whatever the precheck cannot decide (no capture of the module, a CLI
// without the static check, an answer that cannot be read, a timeout, an exception) lets the call go on exactly as
// before. A job without html/screen ops pays nothing: no bridge call, no CLI run, no file written. Never for resume,
// close or a job with a prototype op (the callers do not call it there; a prototype op is refused here too).
// CX16 r4 (plan B, agreed with the owner): OFF by default; SSAM_UI_PRECHECK=1 (or on, true) turns it on. Off, every call
// runs as before CX16 (review cx16-3 M3: with the resident worker check-job queues behind the apply on the same worker). SSAM_UI_PRECHECK_STOP=error restores the stop rule of the
// first round (CX16 r1: any error of the preflight or of the static check refuses before the apply; serial, opt-in only,
// never the default), the owner's way back.
//
// Base and freshness (fresh: the base is provably the module the call works on; a name missing from an index that is not
// fresh is a warning, never an error, which the kernel decides from --basis-fresh):
//   - delivery O11: captureByKey (o11-build-phase.mjs: bridge reads only, never the Studio lock) = fresh; a module not
//     open, two tabs, an older bridge or a failed capture -> the newest capture (code-check.mjs newestCapture), not fresh;
//   - check and ssam_job/o11_job with base: that capture, fresh (the verdict is about it); without a base (a proof on the
//     kernel's own fixture) there is no module to judge against: null;
//   - delivery ODC: the newest snapshot, not fresh (a proof of ODC freshness is later work);
//   - producers of the reference ops: the newest capture of each; fresh only when it was taken after the lane's last
//     delivery to that producer (journal o11_deliver.jsonl: its start/end lines; the delivered snapshot of that delivery
//     counts); without a recorded delivery, or on the ODC lane, not fresh. The kernel reads a producer index only as evidence
//     of what it has (never of what it lacks): every producer index of the store is passed, its freshness reported.
// Index of the base: the store (module-map.mjs indexFile; on ODC also <sha>.kernel.json, what the ODC CLI writes) or the
// index of the first capture with the same content (module-map.mjs readCapture). CX16 r3 (M3): the precheck never builds
// one (a cold `inspect` takes ~9 s, the r2 budget of 4 s was spent in vain and wrote none): without a stored index the
// flag is not passed, the index classes are skipped and static.skipped says so (SSAM_UI_PRECHECK_INDEX_MS is gone).
// UI catalogs: kernel/catalog/ui/<Library>-<version>.json of each library the module digest (section "module",
// reference lines) names; without the digest, none. The kernel says which versions match.
// The answer goes the way of every refusal (job-runner, o11-cycle withJob, the relay's reply, answer-size fitProblems);
// nothing here cuts it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostedContext } from './executor.mjs';

export const PRECHECK_CODE = 'PREFLIGHT_REFUSED';
// The values of SSAM_UI_PRECHECK that turn the precheck on (CX16 r4: off by default).
const PRECHECK_ON = /^(1|on|true)$/i;
// Time: the precheck within SSAM_UI_PRECHECK_MS (default 20000, inside the 25 s of a call). The capture by key is never cut
// (bridge reads with their own timeouts, as the build phase's); what it used is taken from the rest: check-job within
// SSAM_UI_PRECHECK_CHECK_MS and what is left (at least CHECK_MIN_MS). A run past its time decides nothing: the call goes on.
export const PRECHECK_BUDGET_MS = 20000;
export const CHECK_BUDGET_MS = 12000;
export const CHECK_MIN_MS = 3000;
// The text o11-cycle.mjs WORDS_MARKER carries (the user's words are never repeated in a continuation).
const WORDS_MARKER = '<palavras do usuário>';
const UI_OPS = new Set(['html', 'screen']);
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA = /^[a-f0-9]{64}$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isFile = file => { try { return typeof file === 'string' && fs.statSync(file).isFile(); } catch { return false; } };
const lower = value => String(value ?? '').toLowerCase();
const clip = (text, max = 300) => (text.length > max ? text.slice(0, max - 3) + '...' : text);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const budgetOf = (env, name, fallback) => { const raw = String(env?.[name] ?? '').trim(); return /^\d+$/.test(raw) ? Number(raw) : fallback; };

// The ops of a plain job (an array, or {ops}); null for a composite {jobs} (its parts are read by the kernel) or anything else.
export function opsOf(document) {
  if (Array.isArray(document)) return document;
  if (plain(document) && !Array.isArray(document.jobs) && Array.isArray(document.ops)) return document.ops;
  return null;
}
// A job of screens or blocks: an op html (document, edit, edits, components) or an op screen (the generator).
export function isUiJob(document) {
  const ops = opsOf(document);
  return Boolean(ops?.some(op => UI_OPS.has(op?.op)));
}

// ---- base, producers, index, catalogs
// O11 delivery journal: the last delivery of each module {startAt, endAt} (ms), from the start/end lines of o11_deliver.
export function lastDeliveries(local) {
  const out = new Map(); const starts = new Map();
  let text = '';
  try { text = fs.readFileSync(path.join(local, 'journal', 'o11_deliver.jsonl'), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"event"')) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.event === 'start' && entry.task && entry.module) starts.set(entry.task, { module: lower(entry.module), at: Date.parse(entry.at) });
    else if (entry?.event === 'end' && entry.outcome === 'delivered' && starts.has(entry.task)) {
      const start = starts.get(entry.task); const endAt = Date.parse(entry.at);
      if (Number.isFinite(endAt) && !(out.get(start.module)?.endAt > endAt)) out.set(start.module, { startAt: start.at, endAt });
    }
  }
  return out;
}
// A producer capture is fresh only after the lane's last delivery to it (the delivered snapshot of that delivery counts).
export function producerFresh(capture, delivery) {
  const at = Date.parse(capture?.at);
  if (!delivery || !Number.isFinite(at)) return false;
  return at >= delivery.endAt || (capture.source === 'delivered' && Number.isFinite(delivery.startAt) && at >= delivery.startAt);
}
// The library names the module digest's section "module" references ("reference OutSystemsUI @key (ReactiveLibrary)").
export function referencedLibraries(digest) {
  const section = (Array.isArray(digest?.sections) ? digest.sections : []).find(s => s?.id === 'module');
  return [...new Set((Array.isArray(section?.blocks) ? section.blocks : []).map(b => (b?.kind === 'Reference' && typeof b.name === 'string' ? b.name
    : /^reference (\S+)/.exec(String(b?.text ?? ''))?.[1])).filter(Boolean))];
}
// The UI catalogs (<Library>-<version>.json) of those libraries.
export function uiCatalogs(root, libraries) {
  const wanted = new Set(libraries.map(lower));
  if (!wanted.size) return [];
  const dir = path.join(root, 'catalog', 'ui');
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map(name => /^(.+)-([^-]+)\.json$/i.exec(name)).filter(m => m && wanted.has(lower(m[1])))
    .map(m => ({ file: path.join(dir, m[0]), library: m[1], version: m[2] })).sort((a, b) => a.file.localeCompare(b.file));
}
// The module a capture file names (O11 <Module>-<stamp>[-<id>].oml, build-<Module>-...; ODC <Module>-<sha256>.oml).
export function moduleOfCapture(file) {
  const name = path.basename(String(file ?? ''), path.extname(String(file ?? '')));
  const m = /^(?:build-)?(.+?)-(?:\d{14}(?:-[a-f0-9]{8})?|[a-f0-9]{64}|revision-\d+)$/i.exec(name);
  return m ? m[1] : null;
}

// The index of a capture in the store: <sha>.<adapter>.json of module-map.mjs, and on ODC also <sha>.kernel.json.
function storedIndex(map, lane, sha, env) {
  const files = [map.indexFile(lane, sha, env), ...(lane === 'odc' ? [path.join(map.indexRoot(env), 'v1', 'odc', sha.toLowerCase() + '.kernel.json')] : [])];
  return files.find(isFile) ?? null;
}
// The runner of check-job: the lane's (in a phased call the cycle's runner never takes the Studio for check-job).
async function defaultRunner(deps, lane, root, env) {
  if (deps.runAnvil) return deps.runAnvil;
  const name = deps.o11Lane ?? (typeof deps.lane === 'function' ? deps.lane()?.name : typeof deps.lane === 'string' ? deps.lane : undefined);
  if (lane === 'odc') return (await import('./anvil-cli.mjs')).createAnvilRunner({ root, env, ...(name ? { lane: name } : {}) });
  return (await import('./anvil-worker.mjs')).createWorkerFirstRunner({ root, env, ...(name ? { o11: name } : {}) });
}
// The index of the base (see the header): {file, sha256, source, ms} or {skipped, ms}. Never built here (CX16 r3, M3).
function baseIndex({ map, lane, capture, module, env }) {
  const begin = performance.now();
  const done = value => ({ ...value, ms: Math.round(performance.now() - begin) });
  const stored = storedIndex(map, lane, capture.sha256, env);
  if (stored) return done({ file: stored, sha256: capture.sha256, source: 'stored' });
  try {
    const canonical = map.readCapture(capture.path, lane, { module, env });
    if (canonical?.rawSha256 && SHA.test(canonical.rawSha256) && canonical.reused) {
      const sha = canonical.rawSha256.toLowerCase();
      const same = storedIndex(map, lane, sha, env);
      if (same) return done({ file: same, sha256: sha, source: 'same-content' });
    }
  } catch { /* the content registry only saves a build */ }
  return done({ skipped: 'no stored index of capture ' + capture.sha256.slice(0, 12) + ': the precheck never builds one (it reads the store only); the classes that need it are skipped' });
}

// ---- the answer
// A problem as the kernel gave it, its texts cut at 300 characters (edit and patch whole: they are the fix); an error
// given only as text (`op #i (kind) [CODE]: message`) keeps its code.
function problemOf(p) {
  if (!plain(p)) return { phase: 'preflight', severity: 'error', code: /\[([A-Z][A-Z0-9_]*)\]/.exec(String(p ?? ''))?.[1] ?? PRECHECK_CODE, message: clip(String(p ?? '')) };
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k] = typeof v === 'string' ? clip(v) : v;
  if (out.phase == null) out.phase = 'preflight';
  if (out.severity == null) out.severity = 'error';
  return out;
}
const isEdit = e => plain(e) && typeof e.element === 'string' && e.element && typeof e.find === 'string' && e.find && typeof e.with === 'string';
// The screen or block of the first problem that names one (its op's data.screen, or the name of its document).
function firstElement(problems, ops) {
  for (const p of problems) {
    const at = Number.isInteger(p?.op) ? p.op : Number(/^(?:\/ops)?\/(\d+)(?:\/|$)/.exec(String(p?.pointer ?? ''))?.[1] ?? NaN);
    const op = Number.isInteger(at) ? ops?.[at] : null;
    if (op?.op !== 'html' || !plain(op.data)) continue;
    const name = typeof op.data.screen === 'string' && op.data.screen ? op.data.screen
      : /<(?:screen|block)\b[^>]*?\bname\s*=\s*"([^"]+)"/i.exec(String(op.data.html ?? ''))?.[1];
    if (name) return name;
  }
  return null;
}
const PASS = { o11: ['publish', 'until', 'checks', 'producers', 'captureProducers', 'expectedEnvironment', 'closePrevious'],
  odc: ['feature', 'owners', 'changes', 'tenant', 'pid', 'publish', 'until'] };
// The continuation (7.7): every problem with its certain edit -> ONE ssam_code (write on a delivery, check otherwise) with
// basedOn {job, sha256} and the edits grouped by element; otherwise the reading of the first element (ssam_map html).
export function continuationOf({ lane, mode, module, base, basedOn, problems, ops, input = {} }) {
  const edits = problems.map(p => p?.edit);
  if (problems.length && edits.every(isEdit)) {
    const groups = new Map(); let conflict = false;
    for (const e of edits) {
      const list = groups.get(e.element) ?? [];
      const same = list.find(x => x.find === e.find);
      if (same) { if (same.with !== e.with) conflict = true; continue; }
      list.push({ find: e.find, with: e.with }); groups.set(e.element, list);
    }
    if (!conflict) {
      const [[element, first], ...rest] = [...groups];
      const options = {};
      if (mode === 'deliver') {
        for (const k of PASS[lane]) if (input[k] != null && !(k === 'until' && input[k] === 'merge')) options[k] = input[k];
        if (input.authorize != null) options.authorize = WORDS_MARKER;
      }
      return { tool: 'ssam_code', arguments: { lane, action: mode === 'deliver' ? 'write' : 'check', ...(module ? { module } : base ? { base } : {}), basedOn, element, edits: first,
        ...(rest.length ? { also: rest.map(([name, list]) => ({ element: name, edits: list })) } : {}), ...options },
        why: 'applies the certain fix of every problem to the texts of the job of basedOn (nextBasedOn) and ' + (mode === 'deliver' ? 'delivers it' : 'checks it')
          + ' again; only the edits travel' + (options.authorize ? '; authorize: the user\'s words in place of the marker' : '') };
    }
  }
  const screen = firstElement(problems, ops);
  return { tool: 'ssam_map', arguments: { lane, target: module ?? base, view: 'html', ...(screen ? { screen } : {}) },
    why: 'not every problem has a certain fix: read ' + (screen ? 'the screen ' + screen : 'the screens') + ', then correct the job with ssam_code basedOn = nextBasedOn and edits '
      + '[{find, with}] per element (a reference element by patch); never resend the whole job' };
}

function journalTo(local, entry) {
  if (!local) return;
  try {
    const dir = path.join(local, 'journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ui-precheck.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* the journal never changes the answer */ }
}
const codesOf = list => { const counts = new Map(); for (const p of list) { const c = String(p?.code ?? 'unknown'); counts.set(c, (counts.get(c) ?? 0) + 1); } return [...counts].map(([c, n]) => c + ' ' + n).slice(0, 10); };

// uiPrecheck({lane, module, job (file or object), document?, mode: "deliver"|"check"|"job", base?, input?, signal?}, deps)
// -> null (go on) | {carry: true, ...} | the refusal of 7.7, in series (the r1 stop and direct callers). deps: runAnvil (the
// lane runner; check-job), bridge (O11 delivery: the cycle's bridge function), now, root (kernel root: catalogs, ODC CLI),
// env, local / laneLocal / lane (the lane's local folder, or the cycle's lane()), odcRoot (ODC snapshots), odcCli, o11Lane.
export async function uiPrecheck(request = {}, deps = {}) { return precheck(request, deps, false); }

// startUiPrecheck(request, deps) -> null (nothing to judge) | {stop: refusal} (SSAM_UI_PRECHECK_STOP=error: in series, before
// the apply) | {pending: Promise<null | {carry: true, ..., static.complete, stop?}>}: the base is found first (on an O11
// delivery the capture by key, which the build phase shares), check-job then runs alongside the apply path; the promise
// never rejects. With static.complete the carried object holds `stop`, the refusal alone, for a hook with a step to spare.
export async function startUiPrecheck(request = {}, deps = {}) {
  const value = await precheck(request, deps, true);
  if (!value) return null;
  if (value.pending) return { pending: value.pending.catch(() => null) };
  return value.carry ? { pending: Promise.resolve(value) } : { stop: value };
}

async function precheck(request, deps, parallel) {
  deps = deps ?? {};
  // servidor/fase4-26 (M5): never on a hosted server, whatever its SSAM_UI_PRECHECK says: check-job would read the module index
  // the server shares with every customer and write its job beside the server's lane; the delivery runs as before CX16.
  if (hostedContext()) return null;
  const lane = request.lane === 'odc' ? 'odc' : 'o11';
  const input = plain(request.input) ? request.input : {};
  if (input.resume != null || input.close != null) return null;
  let document = plain(request.document) || Array.isArray(request.document) ? request.document : null;
  let jobFile = typeof request.job === 'string' && request.job ? path.resolve(request.job) : null;
  if (!document && request.job != null && typeof request.job === 'object') document = request.job;
  if (!document && jobFile) document = readJson(jobFile);
  const ops = opsOf(document);
  if (!ops || !ops.some(op => UI_OPS.has(op?.op)) || ops.some(op => op?.op === 'prototype')) return null;
  if (request.signal?.aborted) return null;
  const env = deps.env ?? process.env;
  // CX16 r4 (plan B, agreed with the owner): OFF by default; SSAM_UI_PRECHECK=1 (or on, true) turns it on. Off, every call
  // runs as before CX16 (review cx16-3 M3: with the resident worker check-job queues behind the apply).
  if (!PRECHECK_ON.test(String(env.SSAM_UI_PRECHECK ?? process.env.SSAM_UI_PRECHECK ?? '').trim())) return null;
  const started = performance.now();
  const mode = ['deliver', 'check', 'job'].includes(request.mode) ? (request.mode === 'job' && /[\\/]jobs[\\/]check[\\/]/i.test(jobFile ?? '') ? 'check' : request.mode) : 'job';
  const { anvilRoot, odcRoot } = await import('./workspace.mjs');
  const root = deps.root ?? anvilRoot;
  const odc = deps.odcRoot ?? odcRoot;
  let laneRow = null; try { laneRow = typeof deps.lane === 'function' ? deps.lane() : null; } catch { laneRow = null; }
  const local = lane === 'odc' ? deps.laneLocal ?? path.join(odc, '.local') : deps.local ?? laneRow?.local ?? deps.laneLocal ?? null;
  const odcCli = deps.odcCli ?? path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
  const module = typeof request.module === 'string' && request.module.trim() ? request.module.trim() : null;
  const note = entry => journalTo(local, { lane, mode, module, ...(jobFile ? { job: jobFile } : {}), ...entry, elapsedMs: Math.round(performance.now() - started) });
  // SSAM_UI_PRECHECK_STOP=error (r1, opt-in): any error stops before the apply, so it runs in series.
  const stopOnError = String(env.SSAM_UI_PRECHECK_STOP ?? process.env.SSAM_UI_PRECHECK_STOP ?? '').trim().toLowerCase() === 'error';
  try {
    const nowValue = () => { const v = typeof deps.now === 'function' ? deps.now() : new Date(); return v instanceof Date ? v : new Date(Number(v)); };
    const { newestCapture } = await import('./code-check.mjs');
    const locate = { root, local: local ?? undefined, odcRoot: odc, now: () => nowValue().getTime() };
    // the base
    const captureBegin = performance.now();
    let base = null;
    if (typeof request.base === 'string' && request.base && isFile(request.base)) base = { path: path.resolve(request.base), fresh: true, source: 'base' };
    if (!base && mode === 'deliver' && lane === 'o11' && module && typeof deps.bridge === 'function' && local) {
      try {
        const { captureByKey } = await import('./o11-build-phase.mjs');
        const shot = await captureByKey(module, { bridge: deps.bridge, local, now: nowValue, signal: request.signal });
        if (shot?.path && isFile(shot.path)) base = { path: shot.path, fresh: true, source: shot.reused ? 'capture-by-key-reused' : 'capture-by-key' };
      } catch { base = null; }
    }
    if (!base && module) {
      const newest = newestCapture({ lane, module }, locate);
      if (newest?.path) base = { path: newest.path, fresh: false, source: lane === 'odc' ? 'newest-snapshot' : 'newest-capture' };
    }
    const captureMs = Math.round(performance.now() - captureBegin);
    if (!base) { note({ outcome: 'no-basis', captureMs }); return null; }
    if (lane === 'odc' && !isFile(odcCli)) { note({ outcome: 'undecided', reason: 'the ODC lane CLI is not built: ' + odcCli, captureMs }); return null; }
    if (request.signal?.aborted) return null;
    // CX16 r3 (M3): from here on, alongside the apply path (startUiPrecheck), unless the r1 stop is asked.
    const judge = async () => { try {
    base.sha256 = sha256(fs.readFileSync(base.path));
    // the job file (a job given as an object is written once, beside the inline jobs of the lane)
    if (!jobFile || !isFile(jobFile)) {
      if (!local) return null;
      const dir = path.join(local, 'jobs', 'precheck');
      fs.mkdirSync(dir, { recursive: true });
      jobFile = path.join(dir, randomUUID() + '.json');
      fs.writeFileSync(jobFile, JSON.stringify(document, null, 2), { flag: 'wx' });
    }
    const jobSha256 = sha256(fs.readFileSync(jobFile));
    // the index, its digest and the UI catalogs
    const map = await import('./module-map.mjs');
    const skipped = [];
    const deadline = started + budgetOf(env, 'SSAM_UI_PRECHECK_MS', PRECHECK_BUDGET_MS);
    const index = baseIndex({ map, lane, capture: { path: base.path, sha256: base.sha256 }, module, env });
    if (index.skipped) skipped.push({ class: 'module-index', reason: index.skipped });
    const digest = index.file ? readJson(map.digestFile(lane, index.sha256, env)) : null;
    const catalogs = digest ? uiCatalogs(root, referencedLibraries(digest)) : [];
    if (index.file && !digest) skipped.push({ class: 'ui-catalog', reason: 'no module digest beside the index: the libraries the module references are unknown' });
    const moduleName = module ?? (typeof digest?.module?.name === 'string' ? digest.module.name : null) ?? moduleOfCapture(base.path);
    // the producers of the reference ops
    const names = [...new Set(ops.filter(op => op?.op === 'reference').map(op => String(op.producer ?? '')).filter(n => BINDING.test(n) && lower(n) !== 'system'))];
    const deliveries = names.length && lane === 'o11' && local ? lastDeliveries(local) : new Map();
    const producers = [];
    for (const name of names) {
      const capture = newestCapture({ lane, module: name }, locate);
      const fresh = lane === 'o11' && producerFresh(capture, deliveries.get(lower(name)));
      const file = capture?.sha256 ? storedIndex(map, lane, capture.sha256, env) : null;
      // The kernel reads a producer index only as evidence of what it HAS (a type, its attributes), never of what it lacks:
      // an index that is not fresh is passed too (fresh is reported in static.basis.producers).
      producers.push({ name, capture: capture?.path ?? null, sha256: capture?.sha256 ?? null, fresh, ...(file ? { file } : {}) });
      if (!capture) skipped.push({ class: 'producer-index', reason: name + ': no capture of the producer' });
      else if (!file) skipped.push({ class: 'producer-index', reason: name + ': no index of its newest capture' });
    }
    // check-job with the static flags
    const checkBegin = performance.now();
    const runner = await defaultRunner(deps, lane, root, env);
    const args = ['check-job', '--job', jobFile, ...(index.file ? ['--module-index', index.file] : []),
      ...producers.filter(p => p.file).flatMap(p => ['--producer-index', p.name + '=' + p.file]), ...catalogs.flatMap(c => ['--ui-catalog', c.file]),
      '--basis-fresh', String(base.fresh)];
    let run;
    const checkTimeout = Math.max(CHECK_MIN_MS, Math.min(budgetOf(env, 'SSAM_UI_PRECHECK_CHECK_MS', CHECK_BUDGET_MS), Math.floor(deadline - performance.now())));
    try { run = await runner(args, { timeoutMs: checkTimeout, cwd: root, ...(lane === 'odc' ? { cli: odcCli } : {}) }); }
    catch (error) { run = { error }; }
    const checkMs = Math.round(performance.now() - checkBegin);
    const data = run?.envelope?.data;
    const timings = { captureMs, indexMs: index.ms, checkMs };
    const basisNote = { capture: base.path, sha256: base.sha256, fresh: base.fresh, source: base.source, index: index.file ?? null, indexSource: index.source ?? null };
    if (!plain(data)) { note({ outcome: 'undecided', reason: clip(String(run?.error?.message ?? run?.envelope?.error ?? (run?.exitCode != null ? 'exit ' + run.exitCode : 'no answer')), 200), basis: basisNote, timings }); return null; }
    const listed = Array.isArray(data.problems) ? data.problems : [];
    let problems = listed.filter(p => !plain(p) || p.severity !== 'warning').map(problemOf);
    if (!problems.length && data.valid === false && Array.isArray(data.errors)) problems = data.errors.map(problemOf);
    const warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), ...listed.filter(p => plain(p) && p.severity === 'warning')];
    const kernelStatic = plain(data.static) ? data.static : null;
    if (!kernelStatic) skipped.push({ class: 'static', reason: 'the lane CLI answered check-job without its static check (phases ' + JSON.stringify(data.phases ?? ['preflight']) + ')' });
    if (!problems.length) {
      note({ outcome: 'passed', warnings: warnings.length, ...(warnings.length ? { warningCodes: codesOf(warnings), warningSamples: warnings.slice(0, 20).map(problemOf) } : {}), basis: basisNote, timings });
      return null;
    }
    const elapsedMs = Math.round(performance.now() - started);
    const basedOn = { job: jobFile, sha256: jobSha256 };
    const complete = kernelStatic?.complete === true;
    const refusal = {
      ok: false, code: PRECHECK_CODE, outcome: 'refused', writeState: 'not-sent', stage: 'static', phases: ['preflight', 'static'], verifyRan: false,
      verifyReason: 'stopped before the Studio and the apply: the job and the module index already decide ' + problems.length + ' problem(s); the apply and the Verify run once they are fixed',
      stoppedBefore: mode === 'deliver' ? 'studio' : 'apply',
      problems,
      static: {
        basis: { module: { capture: base.path, sha256: base.sha256, fresh: base.fresh, source: base.source },
          producers: producers.map(({ name, capture, sha256: sha, fresh }) => ({ name, capture, sha256: sha, fresh })),
          uiCatalog: Array.isArray(kernelStatic?.basis?.uiCatalog) ? kernelStatic.basis.uiCatalog : catalogs.map(({ file, library, version }) => ({ file, library, version })) },
        checked: Array.isArray(kernelStatic?.checked) ? kernelStatic.checked : [],
        skipped: [...(Array.isArray(kernelStatic?.skipped) ? kernelStatic.skipped : []), ...skipped],
        complete: kernelStatic?.complete === true, ...(kernelStatic?.complete === true ? {} : { rest: Array.isArray(kernelStatic?.rest) ? kernelStatic.rest : [], stopRule: 'SSAM_UI_PRECHECK_STOP=error' }),
        elapsedMs, indexMs: index.ms, checkMs },
      nextBasedOn: basedOn,
      continuation: continuationOf({ lane, mode, module: moduleName, base: base.path, basedOn, problems, ops, input }),
    };
    // M3: the precheck answers alone only when the apply path provably adds nothing (static.complete) or the r1 stop is
    // asked; otherwise it carries. Alongside the apply path (r3) it always carries, `stop` holding the refusal of a
    // complete verdict for the hook that still has a step to spare (o11_deliver: the Studio).
    if ((!complete || parallel) && !stopOnError) {
      const rest = complete ? [] : Array.isArray(kernelStatic?.rest) ? kernelStatic.rest : [{ phase: 'apply', reason: kernelStatic ? 'check-job did not say the apply path adds nothing' : 'the lane CLI answered without its static check' }];
      note({ outcome: 'carried', jobSha256, problems: problems.length, codes: codesOf(problems), warnings: warnings.length, basis: basisNote, timings,
        complete, rest: rest.map(r => r?.phase ?? 'apply'), ...(parallel ? { parallel: true } : {}) });
      return { carry: true, code: PRECHECK_CODE, problems, local, lane, mode, jobSha256,
        static: { basis: { module: { capture: base.path, sha256: base.sha256, fresh: base.fresh, source: base.source } },
          checked: Array.isArray(kernelStatic?.checked) ? kernelStatic.checked : [], skipped: [...(Array.isArray(kernelStatic?.skipped) ? kernelStatic.skipped : []), ...skipped],
          complete, rest, elapsedMs, indexMs: index.ms, checkMs },
        ...(complete ? { stop: refusal } : {}) };
    }
    note({ outcome: 'refused', jobSha256, problems: problems.length, codes: codesOf(problems), warnings: warnings.length, ...(warnings.length ? { warningCodes: codesOf(warnings) } : {}),
      basis: basisNote, timings });
    return refusal;
    } catch (error) {
      note({ outcome: 'undecided', reason: clip(String(error?.message ?? error), 200) });
      return null;
    } };
    if (parallel && !stopOnError) return { pending: judge() };
    return await judge();
  } catch (error) {
    note({ outcome: 'undecided', reason: clip(String(error?.message ?? error), 200) });
    return null;
  }
}

// ---- the carried problems in the refusal of the apply path (M3, provisional)
// The first quoted name of a message ('X', "X"): two phases that say the same problem name the same thing.
const quotedOf = message => /['"]([^'"]{1,120})['"]/.exec(String(message ?? ''))?.[1]?.toLowerCase() ?? '';
const opIndexOf = p => (Number.isInteger(p?.op) ? p.op : Number(/^(?:\/ops)?\/(\d+)(?:\/|$)/.exec(String(p?.pointer ?? ''))?.[1] ?? NaN));
const sameProblem = (a, b) => plain(a) && plain(b) && String(a.code ?? '') === String(b.code ?? '')
  && (String(a.pointer ?? '') === String(b.pointer ?? '') || opIndexOf(a) === opIndexOf(b)) && quotedOf(a.message) === quotedOf(b.message);
// joinPrecheck(answer, carried) -> the answer of the apply path with the carried problems: a refusal (ok false or accepted
// false) gains the ones it does not already say (the same code, place and name once; the apply path's own wording, with its
// patch, stays), phases with "static" and static {complete:false, rest, carried, joined}; a refusal without a problems list
// carries them in static.problems. An accepted job, an uncertain outcome or anything else is returned as it is (the lane
// journal records that the apply accepted what the static check refused). Never throws.
export function joinPrecheck(answer, carried) {
  if (!carried?.carry || !plain(answer)) return answer;
  try {
    const statics = Array.isArray(carried.problems) ? carried.problems : [];
    const refused = answer.ok === false || answer.accepted === false;
    if (!refused || answer.outcome === 'uncertain') {
      journalTo(carried.local, { lane: carried.lane, mode: carried.mode, jobSha256: carried.jobSha256, outcome: refused ? 'carried-uncertain' : 'carried-accepted',
        problems: statics.length, codes: codesOf(statics), samples: statics.slice(0, 10) });
      return answer;
    }
    const list = Array.isArray(answer.problems) ? answer.problems : null;
    const added = statics.filter(s => !(list ?? []).some(p => sameProblem(p, s)));
    const phases = [...new Set([...(Array.isArray(answer.phases) ? answer.phases : []), 'static'])];
    const block = { ...(plain(answer.static) ? answer.static : {}), ...carried.static, carried: statics.length, joined: added.length, ...(list ? {} : { problems: statics }) };
    journalTo(carried.local, { lane: carried.lane, mode: carried.mode, jobSha256: carried.jobSha256, outcome: 'carried-joined', problems: statics.length, joined: added.length });
    return { ...answer, ...(list ? { problems: [...list, ...added] } : {}), phases, static: block };
  } catch { return answer; }
}

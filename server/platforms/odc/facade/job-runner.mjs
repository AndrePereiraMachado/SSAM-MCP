// The job runner of both lanes in the facade's own process (ported from kernel/scripts/run_job.py, so no Python
// runs): one verb job applied to a fixture; nothing is delivered to any Studio.
//   O11: dotnet <lane cli> apply --job <abs> --out <abs> --work <lane.work> [--base <abs>] [--producer N=<abs>]*
//        (anvil_cli.py apply); out defaults to <lane.jobs>/<stem>.oml. captureProducers first reads each producer's
//        signature read-only (dotnet <cli> signature --producer P --job J --binding B --out
//        <lane.jobs>/captured/<stem>/B.avsig --bridge-port <lane bridge>) and binds B to that .avsig.
//   ODC: dotnet <kernel>/.local/lane-odc/cli/anvil-odc.dll apply --job --out [--base] [--producer]* --work
//        <kernel>/.local/lane-odc/jobs/work; out defaults to <kernel>/.local/lane-odc/jobs/<stem>.oml.
// The lane's resident worker answers first when it is up (anvil-worker.mjs), else a cold process (createAnvilRunner):
// the same Dispatch, the same envelope. <out>.result.json keeps run_job.py's content, because discovery.mjs and
// job-guidance.mjs read it: O11 the envelope + via (+ stderr when cold) + wallMs; ODC {ok, data, via, wallMs}; both
// + capturedProducers. ok = envelope.ok && data.accepted (run_job.py's exit code). The answer is a short JSON summary
// of that file, never text lines. A job may be a path (absolute or relative to the kernel root, as before) or the job
// itself (object or array of ops), written to <lane local>/jobs/inline/<uuid>.json first, or patch + basedOn: a JSON
// Patch over an earlier job applied into a new file there (job-patch.mjs; the base never changes, the provenance goes
// to <lane local>/journal/job-patch.jsonl), paths by index or by name; or a partial job + basedOn (only the changed or new
// elements, merged by name into the earlier job). jobTool answers the job it ran with its sha256 and nextBasedOn, for
// the next patch, and a refusal's patches also by name (patchByName).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { anvilRoot, o11Lane, odcRoot as workspaceOdcRoot } from './workspace.mjs';
import { odcCaptures } from './producer-signatures.mjs';
import { producersNamed, bindingKeyOf, listedKeyOf, slotKeyOf, sameProducer, studioNameOf, o11UnknownProducer } from './producer-names.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { readConnection } from './studio-session.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { createWorkerClient, hostedWorkerClient, workerDisabled } from './anvil-worker.mjs';
import { resolvePatchedJob, jobIdentity, failedOpOf, withNamedPatches, appliedJobIdentity } from './job-patch.mjs';
import { hostedContext, seamFields, usesWorkspace, workspacePath } from './executor.mjs';
import { highWarningsOf } from './delivery-warnings.mjs';
import { jobSummary } from './job-summary.mjs';
import { refusalFields, diagnosisOf, normalizationsOf, patchesAppliedOf, CONTINUATION_FIELDS } from './refusal-problems.mjs';
import { withNormalizationsOf } from './normalizations.mjs';
import { textFormRefusal, partReader } from './text-routes.mjs';
import { normalizeCodeOps } from './ssam-code.mjs';
// The prototype op of a headless run (docs/PROTOTIPO-NATIVO.md 1.1, the rehearsal of the delivery): the capture first, the
// rebuild of 1.4.1, the receipt.
import { expandJobFile, capturePrototype, buildWithDegradation, buildProblems, journalTo, kernelPrototypeReport, findNativeDom, withoutIdentityPatches, untypedBuildRefusal, readJobDocument,
  measurePrototypeFidelity, prototypeReceipt, bindingCorrection } from './prototype-op.mjs';
import {captureJobArtifacts,bindJobArtifacts} from './job-artifacts.mjs';

export const JOB_LANES = ['o11', 'odc'];
const clip = (text, max = 400) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };
const tail = (lines, max) => (Array.isArray(lines) ? lines.join('\n') : String(lines ?? '')).slice(-max);
// pathlib.Path.with_suffix: the last suffix replaced (or added).
const withSuffix = (file, suffix) => { const p = path.parse(file); return path.join(p.dir, p.name + suffix); };
const refusal = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// "Name=path" with the path made absolute against the kernel root (run_job.py ran there); anything else as it came.
function producerArg(entry, abs) {
  const text = String(entry); const at = text.indexOf('=');
  return at >= 0 && text.slice(at + 1) ? text.slice(0, at) + '=' + abs(text.slice(at + 1)) : text;
}
const producerList = value => (!value ? [] : Array.isArray(value) ? value.map(String) : Object.entries(value).map(([name, file]) => name + '=' + file));
// fix/system-reference (b): each producer an ODC job names with no binding is bound to the capture the lane already has of it
// (the delivery cache, then the capture folder <odcRoot>/snapshots: producer-signatures.mjs odcCaptures), by its binding key
// ((System) and System are System); a producer with none is left to the kernel, which names the capture to take.
// servidor/fase4-26 a7 (R1): hosted, the captures a job is bound to are the customer's own (<ws>/odc: its snapshots and its
// delivery cache), never the server's ODC root, which no customer writes and every customer shares.
export const jobOdcRoot = () => { const context = hostedContext(); return context ? path.join(context.workspace, 'odc') : workspaceOdcRoot; };
export function odcCapturesForJob(job, bound, { odcRoot, base = null } = {}) {
  let document = null;
  try { document = JSON.parse(fs.readFileSync(job, 'utf8').replace(/^﻿/, '')); } catch { return []; }
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  const named = producersNamed(ops.map(op => (op?.op === 'reference' ? op.producer : null)));
  const boundNames = bound.map(entry => String(entry).split('=')[0]);
  let environment = null;
  try { environment = base ? JSON.parse(fs.readFileSync(base + '.json', 'utf8').replace(/^﻿/, ''))?.host ?? null : null; } catch { environment = null; }
  const found = [];
  for (const { key, written } of named) {
    if (boundNames.some(name => sameProducer(name, key))) continue;
    const newest = odcCaptures(odcRoot, { producer: key, environment })[0];
    if (newest) found.push({ name: key, ...(written.some(w => w !== key) ? { requested: written } : {}), path: newest.path, source: newest.source, observedAtUtc: newest.observedAtUtc,
      ...(newest.revision != null ? { revision: newest.revision } : {}) });
  }
  return found;
}
// The worker is a cache of the same CLI: a refusal it answers with executed:false (another controller's key, "Worker
// operation requires the trusted Hybrid controller") ran nothing, so the same command runs cold in this process. The
// worker's refusal is never the answer: it named no fix the session can apply (QuizLive, 2026-10-05).
const notExecuted = envelope => envelope?.ok === false && envelope?.executed === false;
const coldNote = envelope => 'the resident worker did not run the request (' + clip(envelope?.error ?? 'refused', 160) + '); ran cold';

// run_job.py walk(): the dump tree as indented lines, without lifecycle events and arguments, at most ~120 lines.
function walk(node, depth = 0, out = []) {
  if (out.length > 120 || !node || typeof node !== 'object') return out;
  if (!['IUILifeCycleEvent', 'IArgument'].includes(node.type))
    out.push('  '.repeat(depth) + `${node.type} ${node.name ?? ''}` + (node.text ? ` = ${String(node.text).slice(0, 120)}` : ''));
  for (const child of node.children ?? []) walk(child, depth + 1, out);
  return out;
}
const fitted = (value, max = 1500) => { const text = JSON.stringify(value); return text === undefined || text.length <= max ? value : { truncated: true, text: text.slice(0, max) }; };
const DEFAULTISH = new Set([null, 0, '0', false, 'False', '']);
// What run_job.py printed of the op results (unless --quiet): get, dump, find and the refactor verbs, each capped.
function resultsOf(results) {
  const out = [];
  for (const r of results ?? []) {
    if (out.length >= 20) break;
    if (r?.op === 'get') out.push({ op: 'get', type: r.result?.type, name: r.result?.name ?? null,
      properties: fitted(Object.fromEntries(Object.entries(r.result?.properties ?? {}).filter(([, v]) => !DEFAULTISH.has(v)))) });
    else if (r?.op === 'dump') out.push({ op: 'dump', tree: walk(r.result) });
    else if (r?.op === 'find') out.push({ op: 'find', total: (r.result ?? []).length, found: (r.result ?? []).slice(0, 20).map(x => [x?.type ?? null, x?.name ?? null]) });
    else if (['usages', 'rename', 'reference', 'delete', 'layout'].includes(r?.op)) out.push({ op: r.op, result: fitted(r.result) });
  }
  return out;
}

// Problems of the single refusal (I2 and primeira-certa A3: {phase, op, pointer, code, severity, message, fix, patch,
// element, key}) as the answer keeps them: all of them, each text cut at 300 characters, the patch whole (it is the fix
// that patch + basedOn applies); grouped only to fit the answer (refusal-problems.mjs).
// Review vps-a9, E1: what a problem carries to go on (refusal-problems.mjs CONTINUATION_FIELDS: the screen's text now, the
// next basedOn, the k, the edit ready...) stays whole, as the patch does.
export function problemsOf(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map(p => {
    if (!p || typeof p !== 'object') return clip(typeof p === 'string' ? p : JSON.stringify(p), 300);
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (CONTINUATION_FIELDS.includes(k) && v != null) out[k] = v;
      else if (typeof v === 'string') out[k] = clip(v, 300);
      else if (k === 'patch' && v != null) out[k] = v;
      else if (v === null || typeof v !== 'object') out[k] = v;
      else out[k] = fitted(v, 300);
    }
    return out;
  });
}
// The problems field of an answer, fitted to the budget, with whether the Verify ran and the phases.
// With the job file it ran, a problem that only follows from another failed op of it is summarized (CASCADE).
const jobDocumentOf = file => { if (typeof file !== 'string' || !file) return null; try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const refusalOf = (list, source, job = null) => { const problems = problemsOf(list); return problems?.length ? refusalFields(problems, source, { limit: 300, job: jobDocumentOf(job), jobFile: job }) : diagnosisOf(source); };
// A successful run answers in about 1 KB (C19): what it proved (ok, accepted, isValid, counts) and where the whole result
// is (resultFile, read with ssam_evidence). Results, details and messages stay in that file; the results of a small read
// job still come inline when they fit.
export const SUCCESS_BYTES = 1024;
const bytesOf = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function successOf(value, results, budget = SUCCESS_BYTES, resultsTotal = results?.length ?? 0) {
  // Only non-zero validation counts: a zero says nothing a success does not already say.
  if (value.validation) { const v = Object.fromEntries(Object.entries(value.validation).filter(([, n]) => n !== 0)); if (Object.keys(v).length) value.validation = v; else delete value.validation; }
  if (results?.length) {
    const withResults = { ...value, results };
    if (bytesOf(withResults) <= budget) return withResults;
    value.resultsTotal = resultsTotal;
  }
  // The op results that did not fit are one read away; details and messages of a success stay in the file (resultFile).
  if (value.resultsTotal) value.continuation = { tool: 'ssam_evidence', arguments: { file: value.resultFile, pointer: '/data/results' },
    why: 'the op results of the run (' + value.resultsTotal + ')' };
  // Over the budget, the details go first, in this order (the result file keeps them all): the capture receipts keep only
  // their producer, then the data contract, the worker note (cut) and the validation counts.
  for (const k of ['capturedProducers', 'dataContract', 'worker', 'validation']) {
    if (bytesOf(value) <= budget) break;
    if (k === 'capturedProducers' && value.capturedProducers) value.capturedProducers = value.capturedProducers.map(r => ({ producer: r.producer }));
    else if (k === 'worker' && value.worker) value.worker = clip(value.worker, 120);
    else delete value[k];
  }
  return value;
}

// The short answer: the fields run_job.py printed, read from the same object it saved. A success is compact (successOf);
// a failure keeps what explains it: problems (all, I2), messages, details, validation, stderr.
export function summarize({ lane, job, out, resultFile, saved, note, quiet = false }) {
  const x = saved.data ?? {};
  const value = { ok: Boolean(saved.ok && x.accepted), lane, job, out, resultFile, via: saved.via, wallMs: saved.wallMs };
  if (saved.code) value.code = saved.code;
  if (saved.error) value.error = clip(saved.error, 2000);
  for (const k of ['accepted', 'isValid', 'expectedValid', 'ops', 'objects', 'applyMs']) if (x[k] !== undefined) value[k] = x[k];
  if (x.validation && typeof x.validation === 'object')
    value.validation = Object.fromEntries(Object.entries(x.validation).filter(([, v]) => Array.isArray(v) || typeof v !== 'object').map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
  if (x.dataContract) value.dataContract = { count: x.dataContract.count ?? null, accepted: x.dataContract.accepted ?? null,
    ...(!value.ok && x.dataContract.differences?.length ? { differences: x.dataContract.differences.slice(0, 10) } : {}) };
  // F5: a capture the kernel reused from the workspace (same producer, environment and published version, observed lately,
  // no publication since: no lease) says so.
  if (saved.capturedProducers) value.capturedProducers = saved.capturedProducers.map(r => ({ producer: r?.producer, kind: r?.kind,
    versionIdBefore: r?.versionIdBefore, signatureHash: r?.signatureHash, avsigPath: r?.avsigPath, avsigSha256: r?.avsigSha256,
    ...(r?.reused === true ? { reused: true, observed: r?.observed?.by ?? 'ledger', mergeReady: false } : {}) }));
  // The candidate of a job round built on a signature nothing read on the server now is not valid for a direct OML merge.
  if (value.capturedProducers?.some(r => r.reused === true))
    value.capturedProducersNote = 'producer signature reused from the cache, without a read on the server now: this result does not hold for a direct merge of the OML; o11_deliver checks the version of each producer on the server before the merge';
  if (note) value.worker = note;
  // The HIGH warnings of the data-access rules (QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE): always in the answer,
  // success or refusal, outside the 1 KB budget of a success (never blocking, never hidden).
  const high = highWarningsOf(x.highWarnings);
  if (high.length) value.highWarnings = high.slice(0, 10);
  // CX17 review 1 (M2): the kernel orders them (data and owner rules first); a cut says how many there were.
  if (high.length > 10) value.highWarningsTotal = high.length;
  const results = !quiet && x.results?.length ? resultsOf(x.results) : [];
  if (value.ok) {
    if (Array.isArray(x.messages)) value.messages = x.messages.length; else if (x.messages !== undefined) value.messages = x.messages;
    if (x.details?.length) value.detailsTotal = x.details.length;
    const warnings = x.preflight?.warnings;
    if (Array.isArray(warnings) && warnings.length) value.preflightWarnings = warnings.length;
    // jobTool adds jobSha256 and jobShape (about 100 bytes) after this, and nextBasedOn (the job path and its sha256 again,
    // ready for the next basedOn).
    const success = successOf(value, results, SUCCESS_BYTES - 120, x.results?.length ?? 0);
    // lentidao 2026-10-12: what the kernel rewrote in the job instead of refusing it (JobNormalizer), outside the 1 KB budget
    // like the HIGH warnings and the summary: a rewrite is never hidden.
    return { ...success, ...normalizationsOf(x), ...patchesAppliedOf(x) };
  }
  // A refusal of the job (I2): every problem of every phase, from the CLI's error envelope or from the apply's own
  // preflight, with verifyRan and the phases (primeira-certa A3).
  // A candidate only the Verify refused carries its errors the same way (data.problems).
  Object.assign(value, refusalOf(saved.problems ?? x.problems ?? x.preflight?.problems, saved.problems ? saved : x, job));
  if (x.messages !== undefined) value.messages = Array.isArray(x.messages) ? x.messages.slice(0, 10).map(m => clip(typeof m === 'string' ? m : JSON.stringify(m), 300)) : x.messages;
  if (x.details?.length) { value.details = x.details.slice(0, 10).map(d => clip(d)); if (x.details.length > 10) value.detailsTotal = x.details.length; }
  if (x.preflight?.actions) value.preflight = { actions: x.preflight.actions, publicActions: x.preflight.publicActions, helpers: x.preflight.helpers,
    ...(x.preflight.alwaysRaises?.length ? { alwaysRaises: x.preflight.alwaysRaises } : {}),
    ...(x.preflight.identicalImplementations?.length ? { identicalImplementations: x.preflight.identicalImplementations.map(g => g.names) } : {}) };
  if (x.policyMessages?.length) value.policyMessages = x.policyMessages.slice(0, 10).map(m => clip(m));
  if (results.length) value.results = results;
  if (saved.stderr) value.stderr = String(saved.stderr).trim().split(/\r?\n/).filter(Boolean).slice(-10);
  return value;
}

// One job, one lane. request: {lane, job | patch+basedOn, base?, out?, producers?, captureProducers?, quiet?}; producers
// is ["Name=path"] or {Name: path}; basedOn {taskId} (an O11 delivery task) only in lane o11. deps: {root, env,
// o11Lane, workspace, runAnvil, worker, now, uuid}.
export async function runJob(request = {}, deps = {}) {
  // CX16 r3 (M3): the UI precheck runs alongside the apply path (started before prepareIntegrationJob and the apply, waited
  // for only here): its problems join the answer of the apply path, one refusal with everything (ui-precheck.mjs
  // joinPrecheck). A headless job has no step to spare, so even a complete verdict joins. CX16 r4 (M3): an answer the
  // precheck cannot change (accepted or uncertain) never waits for check-job; its journal line is written when it ends.
  const carried = { pending: null };
  const answer = await runJobOnce(request, deps, carried);
  if (!carried.pending) return answer;
  const precheck = await import('./ui-precheck.mjs');
  if (!precheck.waitsForPrecheck(answer)) { precheck.settleLater(carried.pending, answer); return answer; }
  const pre = await carried.pending;
  if (!pre?.carry) return answer;
  return precheck.joinPrecheck(answer, pre);
}

async function runJobOnce(request, deps, carried) {
  const lane = String(request.lane ?? 'o11').trim().toLowerCase();
  if (!JOB_LANES.includes(lane)) return refusal('unknown-lane', `Unknown lane ${request.lane}; lanes: ${JOB_LANES.join(', ')}`);
  const root = deps.root ?? anvilRoot; const env = deps.env ?? process.env; const now = deps.now ?? Date.now;
  const o11 = o11LaneOf(deps.o11Lane ?? o11Lane.lane, { root, env, ...(deps.workspace ? { workspace: deps.workspace } : {}) });
  const captures = (request.captureProducers ?? []).map(String);
  if (captures.length && lane === 'odc') return refusal('capture-o11-only', 'captureProducers reads O11 producer signatures; it exists only in lane o11.', { lane });
  // Hosted, the ODC jobs and journal are the customer's (<ws>/odc/.local); the CLI stays the server's.
  const odcLocal = usesWorkspace(root, anvilRoot) ? workspacePath('odc', '.local') : path.join(root, '.local', 'lane-odc');
  const odcCli = path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
  if (lane === 'odc' && !fs.existsSync(odcCli)) return refusal('odc-cli-missing', 'The ODC lane CLI is not built: ' + odcCli, { lane, docs: 'docs/lanes.md',
    continuation: { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'reports which lane CLI is built' } });

  const abs = p => path.resolve(root, String(p));
  const laneLocal = lane === 'odc' ? odcLocal : o11.local;
  let job; let partial; let basedOnFile = null;
  // The op shapes of one meaning taken as meant (ssam-code.mjs normalizeCodeOps), listed on the answer (normalizations).
  let jobNotes = [];
  if (request.patch != null || request.basedOn != null) {
    const patched = resolvePatchedJob({ job: request.job, patch: request.patch, basedOn: request.basedOn }, { root, inlineDir: path.join(laneLocal, 'jobs', 'inline'),
      work: lane === 'o11' ? o11.work : null, journalDir: path.join(laneLocal, 'journal'), tool: lane === 'odc' ? 'ssam_job' : 'o11_job', uuid: deps.uuid ?? randomUUID });
    if (!patched.ok) return { ...patched, lane };
    job = patched.path; partial = patched.partial; jobNotes = patched.normalizations ?? [];
    // the job it corrects: the kernel's preflight refuses CSS the correction dropped (CSS_RULES_DROPPED)
    basedOnFile = typeof patched.basedOn?.job === 'string' ? patched.basedOn.job : null;
  } else if (typeof request.job === 'string' && request.job.trim()) job = abs(request.job);
  else if (request.job && typeof request.job === 'object') {
    const folder = path.join(lane === 'odc' ? odcLocal : o11.local, 'jobs', 'inline');
    fs.mkdirSync(folder, { recursive: true });
    job = path.join(folder, (deps.uuid ?? randomUUID)() + '.json');
    const shaped = normalizeCodeOps(request.job); jobNotes = shaped.normalizations;
    fs.writeFileSync(job, JSON.stringify(shaped.job, null, 2), 'utf8');
  } else return refusal('job-required', 'job is required: a path (absolute or relative to the kernel root) or the job itself (object, or array of ops)', { lane });
  if (!fs.existsSync(job)) return refusal('job-not-found', 'Job file not found: ' + job, { lane, job });
  // A job file with op shapes of one meaning (the ssam_code aliases, set props{}, ...) runs as a new inline file in the kernel form.
  { let aliased = null; try { aliased = normalizeCodeOps(JSON.parse(fs.readFileSync(job, 'utf8').replace(/^\uFEFF/, ''))); } catch { /* the kernel reports it */ }
    if (aliased?.changed) { jobNotes = [...jobNotes, ...aliased.normalizations]; const folder = path.join(laneLocal, 'jobs', 'inline'); fs.mkdirSync(folder, { recursive: true }); job = path.join(folder, (deps.uuid ?? randomUUID)() + '.json'); fs.writeFileSync(job, JSON.stringify(aliased.job, null, 2), 'utf8'); } }
  // WIRED (text-routes.mjs): a text form whose way back is not wired is refused here too, before the kernel runs.
  {
    let document = null;
    try { document = JSON.parse(fs.readFileSync(job, 'utf8').replace(/^\uFEFF/, '')); } catch { /* the kernel reports an unreadable job */ }
    const unwired = textFormRefusal(document, undefined, { readPart: partReader(job, fs, path) });
    if (unwired) return { ...unwired, lane, job };
  }
  // CX16 (ui-precheck.mjs): a job of screens or blocks is judged on the module index of its base, alongside the apply (r3).
  { const pre = await (await import('./ui-precheck.mjs')).startUiPrecheck({ lane, job, mode: 'job', base: request.base != null && String(request.base) !== '' ? abs(request.base) : null }, { ...deps, root, env, laneLocal, odcCli, o11Lane: o11.name });
    if (pre?.stop) return withNormalizationsOf({ ...pre.stop, lane, job }, jobNotes);
    if (pre?.pending) carried.pending = pre.pending; }
  // Integration ops (rest, rest-expose, soap): the documents they name are pinned once (integration-documents.mjs, I6).
  // A headless job writes nothing to a Studio, so the destructive-words rule of the deliveries does not apply here.
  const prepare = deps.prepareIntegrationJob ?? (await import('./integration-documents.mjs')).prepareIntegrationJob;
  const prepared = await prepare(job, { lane, localRoot: laneLocal, destructive: false, ...(deps.fetch ? { fetchImpl: deps.fetch } : {}) });
  if (prepared?.ok === false) return { ...prepared, lane, job, stage: 'documents' };
  if (prepared?.changed) job = prepared.job;
  const stem = path.parse(job).name;
  const producers = producerList(request.producers).map(p => producerArg(p, abs));
  const foundProducers = lane === 'odc' ? odcCapturesForJob(job, producers, { odcRoot: deps.odcRoot ?? jobOdcRoot(), base: request.base != null && String(request.base) !== '' ? abs(request.base) : null }) : [];
  for (const found of foundProducers) producers.push(found.name + '=' + found.path);
  const withFound = v => (foundProducers.length && v && typeof v === 'object' ? { ...v, boundProducers: foundProducers } : v);
  const base = request.base != null && String(request.base) !== '' ? abs(request.base) : null;
  const boundInputs = lane === 'odc' && base && fs.existsSync(base) ? captureJobArtifacts(base,job) : null;
  const runAnvil = deps.runAnvil ?? createAnvilRunner({ lane: o11.name, root, env });
  // Hosted, an O11 job goes to the customer's own worker (anvil-worker.mjs hostedWorkerClient; deps.hostedWorkers in tests),
  // never to the lane's worker (off: workerDisabled).
  const worker = lane === 'o11' && hostedContext() ? hostedWorkerClient({ root, env, o11: o11.name, pool: deps.hostedWorkers })
    : workerDisabled(lane, env) ? null : deps.worker ?? createWorkerClient(lane, { root, env, o11: o11.name, ...(deps.workspace ? { workspace: deps.workspace } : {}) }, deps);

  // Read-only captures through the lane's logged-in Studio, before the job (run_job.py capture_producers), on the bridge
  // port of the connection record (the selected Studio), else the lane table's.
  const capturePort = () => { try { const r = readConnection(root, o11.name); if (Number.isInteger(r?.port)) return r.port; } catch { /* lane table */ } return o11.bridge; };
  const receipts = [];
  if (captures.length) {
    const folder = path.join(o11.jobs, 'captured', stem);
    fs.mkdirSync(folder, { recursive: true });
    for (const entry of captures) {
      const at = entry.indexOf('=');
      // fix/system-reference: the binding by its key ((System) -> System), the producer as the Studio lists it (System -> (System)).
      const written = at < 0 ? entry : entry.slice(0, at);
      // Round 2 (H1): the capture file is named by the key (letters, digits, underscore), never by the name as written.
      const binding = at < 0 ? slotKeyOf(written) : bindingKeyOf(written) && slotKeyOf(written);
      if (binding == null) return refusal('invalid-capture', 'Invalid captureProducers entry: ' + entry + ' (a producer name as the Studio lists it; a name with / or \\ is never bound)', { lane, job });
      const producer = at >= 0 && entry.slice(at + 1) ? entry.slice(at + 1) : studioNameOf(written) ?? written;
      const target = path.join(folder, binding + '.avsig');
      const r = await runAnvil(['signature', '--producer', producer, '--job', job, '--binding', binding, '--out', target, '--bridge-port', String(capturePort())], { cwd: root });
      // Round 2 (M4): a producer the referenceable catalog does not list by that name is ONE refusal with every name it lists
      // and the same call with that capture bound to a listed name, as on ODC (producer-names.mjs o11UnknownProducer).
      const unknown = r.envelope && /^PRODUCER_(UNKNOWN|AMBIGUOUS)$/.test(String(r.envelope.code ?? ''))
        ? o11UnknownProducer(r.envelope.problems, { captures, call: { tool: lane === 'odc' ? 'ssam_job' : 'o11_job', arguments: { lane, job,
            ...(request.base != null && String(request.base) !== '' ? { base: request.base } : {}), ...(Object.keys(request.producers ?? {}).length ? { producers: request.producers } : {}),
            captureProducers: captures } } }) : null;
      if (unknown) return refusal(unknown.code, r.envelope.error, { lane, job, stage: 'capture-producer', ...unknown });
      if (r.envelope?.ok !== true) return refusal('capture-failed', r.envelope?.error ?? 'the CLI printed no JSON', { lane, job, stage: 'capture-producer', producer,
        ...(r.envelope ? {} : { stdout: tail(r.stdout, 2000) }) });
      receipts.push(r.envelope.data);
      producers.push(`${binding}=${target}`);
    }
  }

  // The prototype op (docs/PROTOTIPO-NATIVO.md 1.1): captured before anything runs; its refusal comes back ONCE with every
  // problem, the patch over /ops/<i>/data and the corrected call (naming the job as it was given), and nothing is applied.
  let proto = null;
  {
    const expand = deps.expandPrototype ?? (file => expandJobFile(file, { inlineDir: path.join(laneLocal, 'jobs', 'inline'),
      work: path.join(laneLocal, 'prototype', (deps.uuid ?? randomUUID)()), capture: deps.capturePrototype ?? capturePrototype }));
    const expanded = await expand(job);
    if (expanded?.refusal) return { ...expanded.refusal, lane, job };
    if (expanded?.path) { proto = { ...expanded.expansion, original: job, measure: deps.measureFidelity ?? null }; job = expanded.path; }
  }

  // A prototype op builds ~2,000 widgets through Model API code that a cold process would run at tier-0 JIT: its process
  // compiles fully optimized from the first call (measured on FarmaVirtual: the apply 17.5 s -> 10.7 s cold).
  const applyRunner = proto && !deps.runAnvil ? createAnvilRunner({ lane: o11.name, root, env: { ...env, DOTNET_TC_QuickJit: '0' } }) : runAnvil;
  // wallMs covers the apply only (worker attempt included), as anvil_cli.run and run_job.py odc_lane measure it.
  // One apply of a job file: {saved, out, note}, or {answer} when the CLI gave no result to save.
  const outFor = file => (request.out ? abs(request.out) : path.join(lane === 'odc' ? path.join(odcLocal, 'jobs') : o11.jobs, path.parse(proto?.original ?? file).name + '.oml'));
  const applyOnce = async file => {
    let note; const started = now();
    const out = outFor(file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (lane === 'odc') {
      const argv = ['apply', '--job', file, '--out', out, ...(base ? ['--base', base] : []), ...producers.flatMap(p => ['--producer', p]), ...(request.autoPatch === false ? ['--auto-patch', 'off'] : []), ...(basedOnFile ? ['--based-on', basedOnFile] : []),
        '--work', request.work ?? path.join(odcLocal, 'jobs', 'work')];
      let envelope = null; let via = 'worker odc';
      if (worker) {
        const w = await worker.run(argv);
        if (w.used && w.unknown) return { answer: refusal('worker-outcome-unknown', w.error, { lane, job: file, via, ...(w.detail ? { detail: w.detail } : {}) }) };
        if (w.used && !notExecuted(w.envelope)) envelope = w.envelope; else note = w.used ? coldNote(w.envelope) : w.note;
        if (w.warning) note = w.warning;
      }
      if (!envelope) {
        via = 'cold process odc';
        const r = await applyRunner(argv, { cli: odcCli, cwd: root });
        if (!r.envelope) return { answer: refusal('no-json', 'the CLI printed no JSON', { lane, job: file, via, exitCode: r.exitCode, stdout: tail(r.stdout, 2000), stderr: r.stderr ?? [] }) };
        envelope = r.envelope;
      }
      const wallMs = now() - started;
      // An error envelope carries error/stack, no data: run_job.py printed it and wrote no result file.
      if (envelope.data == null) {
        return { answer: { ok: false, lane, job: file, via, command: envelope.command, elapsedMs: envelope.elapsedMs, wallMs, ...(envelope.code ? { code: envelope.code } : {}),
          error: clip(envelope.error ?? 'the CLI returned no data', 2000), ...refusalOf(envelope.problems, envelope, file), ...(note ? { worker: note } : {}) }, envelope };
      }
      return { saved: { ok: Boolean(envelope.ok), data: envelope.data, via, wallMs }, out, note };
    }
    const argv = ['apply', '--job', file, '--out', out, '--work', request.work ?? o11.work, ...(base ? ['--base', base] : []), ...producers.flatMap(p => ['--producer', p]),
      ...(request.autoPatch === false ? ['--auto-patch', 'off'] : []), ...(basedOnFile ? ['--based-on', basedOnFile] : [])];
    let envelope = null;
    if (worker) {
      const w = await worker.run(argv);
      if (w.used && w.unknown) return { answer: refusal('worker-outcome-unknown', w.error, { lane, job: file, via: 'worker', ...(w.detail ? { detail: w.detail } : {}) }) };
      if (w.used && !notExecuted(w.envelope)) envelope = { ...w.envelope, via: 'worker' }; else note = w.used ? coldNote(w.envelope) : w.note;
      if (w.warning) note = w.warning;
    }
    if (!envelope) {
      const r = await applyRunner(argv, { cwd: root, timeoutMs: 900000 });
      // anvil_cli.run: a non-JSON answer becomes an error envelope with the end of stdout and stderr.
      envelope = { ...(r.envelope ?? { ok: false, command: 'apply', error: (tail(r.stdout, 800) + '\n' + tail(r.stderr, 800)).trim() }),
        via: 'process', stderr: tail(r.stderr, 4000) };
    }
    return { saved: { ...envelope, wallMs: now() - started }, out, note };
  };
  let applied;
  let degraded = []; let buildMs = null;
  if (proto) {
    // 1.4.1: a build problem on a generated item rebuilds ONCE without it; a second failure is an SSAM defect with the
    // mapping.ignore patch.
    const begin = now();
    const accepted = r => !r.answer && Boolean(r.saved?.ok && r.saved?.data?.accepted) && r.saved.data.isValid !== false;
    const b = await buildWithDegradation({ jobFile: job, attempt: applyOnce, ok: accepted, problemsOf: r => buildProblems(r.saved ?? r.envelope ?? r.answer),
      inlineDir: path.join(laneLocal, 'jobs', 'inline'), journal: journalTo(path.join(laneLocal, 'journal'), { lane }), uuid: deps.uuid ?? randomUUID });
    buildMs = now() - begin; degraded = b.degraded; applied = b.result;
    if (b.rebuilt) job = b.jobFile;
    if (b.refusal) return { ...b.refusal, lane, job: proto.original };
  } else applied = await applyOnce(job);
  const noted = v => withNormalizationsOf(v, jobNotes);
  if (applied.answer) return withFound(noted(applied.answer));
  const { saved, out, note } = applied;
  if (receipts.length) saved.capturedProducers = receipts;
  if (boundInputs) {
    try { const proof = bindJobArtifacts(boundInputs,out,saved); if (proof) saved.artifacts = proof; }
    catch (error) {
      saved.ok = false; saved.code = 'JOB_ARTIFACT_BINDING_FAILED';
      saved.error = error.message; saved.data.accepted = false;
    }
  }
  const resultFile = withSuffix(out, '.result.json');
  fs.writeFileSync(resultFile, JSON.stringify(saved, null, 2), 'utf8');
  let value = withFound(noted(summarize({ lane, job, out, resultFile, saved, note, quiet: request.quiet === true })));
  if (value.ok && value.patchedJob) { const corrected = appliedJobIdentity(value.patchedJob, { path: job, sha256: jobIdentity(job).jobSha256 }, { journalDir: path.join(laneLocal, 'journal'), tool: lane === 'odc' ? 'ssam_job' : 'o11_job' }); job = corrected.path; value.job = job; }
  // What the proven job creates or changes (job-summary.mjs), outside the 1 KB budget of a success, as highWarnings: the
  // same summary a delivery of it answers with.
  if (value.ok && !proto) { try { const summary = jobSummary(JSON.parse(fs.readFileSync(job, 'utf8').replace(/^﻿/, ''))); if (summary) value.summary = summary; } catch { /* a summary never changes the run */ } }
  // The receipt of a prototype import (report.prototype, outside the 1 KB budget of a success): the kernel's report, the
  // fidelity measured on the module read back (prototype-dom.json), the degraded items and the timings; no merge,
  // publication or seed here (a headless run delivers nothing).
  if (proto) {
    const data = saved.data ?? {};
    const report = kernelPrototypeReport(data);
    const measured = await measurePrototypeFidelity({ captures: proto.captures, measure: proto.measure,
      nativeDom: findNativeDom({ report, captures: proto.captures, dirs: [path.dirname(out), withSuffix(out, ''), lane === 'odc' ? path.join(odcLocal, 'jobs', 'work') : o11.work] }) });
    const receipt = prototypeReceipt(report, { fidelity: measured.fidelity, degraded, captures: proto.captures, warnings: proto.warnings ?? [], verify: data.validation?.new ?? null,
      phases: { captureMs: proto.timings?.captureMs, buildMs: buildMs ?? saved.wallMs, fidelityMs: measured.fidelityMs } });
    if (receipt.timings.expandMs == null && proto.timings?.expandMs != null) receipt.timings.expandMs = proto.timings.expandMs;
    value = { ...value, prototype: receipt, prototypeJob: proto.original };
    // data.bind (2.12): the proposals of PROTOTYPE_BINDING_REQUIRED as one strict patch and the corrected call
    if (value.code === 'PROTOTYPE_BINDING_REQUIRED') Object.assign(value, bindingCorrection(saved.problems ?? saved.data?.problems ?? value.problems, readJobDocument(proto.original)));
    // a kernel refusal of the import (PROTOTYPE_NAME_COLLISION) never offers a patch that leaves the call as it was
    if (value.ok === false) value = withoutIdentityPatches(value, readJobDocument(proto.original));
    // a build the Verify refused on what no item of the capture names (nothing to degrade): never an untyped answer
    if (value.ok === false && !value.code) value = untypedBuildRefusal(value);
  }
  // A partial job: what it replaced and added in the earlier job (the whole job is `job`).
  return partial ? { ...value, partial } : value;
}

// The MCP inputs of o11_job / ssam_job, checked as ssam.mjs producerArgs checks them: binding names, absolute
// producer paths, no name both bound and captured; captures exist only in lane o11.
export function jobToolRequest(input = {}) {
  const allowed = ['job', 'patch', 'basedOn', 'lane', 'base', 'out', 'producers', 'captureProducers', 'quiet', 'autoPatch'];
  const unknown = Object.keys(input).filter(k => !allowed.includes(k));
  if (unknown.length) return refusal('unknown-argument', 'Unknown argument(s) ' + unknown.join(', '));
  if (input.autoPatch != null && typeof input.autoPatch !== 'boolean') return refusal('invalid-auto-patch', 'autoPatch must be boolean');
  const lane = input.lane ?? 'o11';
  if (!JOB_LANES.includes(lane)) return refusal('unknown-lane', `Unknown lane ${lane}; lanes: ${JOB_LANES.join(', ')}`);
  // patch + basedOn stand for job; job + basedOn is a partial job (only the changed or new elements), with a patch applied
  // after it when given (job-patch.mjs checks the patch, the partial job and the base).
  const patching = input.patch != null || input.basedOn != null;
  if (input.patch != null && input.basedOn == null)
    return refusal('PATCH_INVALID', 'patch needs basedOn: {job, sha256} as an answer returned them (nextBasedOn), or {taskId} of an O11 delivery');
  if (input.basedOn != null && input.patch == null && input.job == null)
    return refusal('PATCH_INVALID', 'basedOn goes with patch, or with job: a partial job with only the changed or new elements');
  const producers = input.producers ?? {};
  if (typeof producers !== 'object' || Array.isArray(producers)) return refusal('invalid-producers', 'producers is {Name: absolute path of a frozen producer .oml or .avsig}');
  for (const [name, file] of Object.entries(producers)) {
    if (listedKeyOf(name) == null) return refusal('invalid-producers', 'Invalid producer binding name: ' + name);
    if (typeof file !== 'string' || !path.isAbsolute(file)) return refusal('invalid-producers', 'Producer ' + name + ' needs an absolute path');
  }
  const captures = input.captureProducers ?? [];
  if (!Array.isArray(captures)) return refusal('invalid-capture', 'captureProducers is ["Name" | "Name=Producer"]');
  if (lane !== 'o11' && captures.length) return refusal('capture-o11-only', 'captureProducers reads O11 producer signatures; it exists only in lane o11.', { lane });
  for (const entry of captures) {
    const [name, producer] = String(entry).split(/=(.*)/s);
    if ((producer === undefined ? listedKeyOf(name) : bindingKeyOf(name)) == null || producer === '') return refusal('invalid-capture', 'Invalid captureProducers entry: ' + entry);
    if (Object.hasOwn(producers, name)) return refusal('invalid-capture', 'Producer ' + name + ' is both bound and captured');
  }
  return { ok: true, request: { lane, job: input.job, ...(typeof input.autoPatch === 'boolean' ? { autoPatch: input.autoPatch } : {}), base: input.base, out: input.out, producers, captureProducers: captures, ...(input.quiet ? { quiet: true } : {}),
    ...(patching ? { patch: input.patch, basedOn: input.basedOn } : {}) } };
}

// The job file that ran, with its sha256 and nextBasedOn {job, sha256} (the next call patches or completes it with that
// basedOn; jobShape 'array' when its patch paths are /<i>/...) and, on a failure, the op the kernel refused when its own
// error names it (job-patch.mjs failedOpOf) and each patch of the problems also by name (patchByName).
export function withJobIdentity(result) {
  if (!result || typeof result !== 'object' || typeof result.job !== 'string') return result;
  const { jobSha256, jobShape, nextBasedOn } = jobIdentity(result.job);
  const failedOp = result.ok ? null : failedOpOf(result.error, result.job);
  const named = { ...result, ...(jobSha256 ? { jobSha256 } : {}), ...(jobShape ? { jobShape } : {}), ...(nextBasedOn ? { nextBasedOn } : {}), ...(failedOp != null ? { failedOp } : {}) };
  return result.ok ? named : withNamedPatches(named, result.job);
}

// o11_job / ssam_job: the checked request, the run, and on failure the catalog guidance (job-guidance.mjs) for the
// job file that ran. A refused patch (PATCH_*, BASE_*) ran nothing and gets no guidance. Never throws: an exception
// becomes {ok:false, error}.
export async function jobTool(input = {}, deps = {}) {
  try {
    const checked = jobToolRequest(input);
    if (!checked.ok) return checked;
    const result = await runJob(checked.request, deps);
    if (/^(PATCH|BASE)_/.test(result.code ?? '')) return result; // a changed base is never handed back with its new sha256
    // A refusal of the prototype op (or the SSAM defect of its rebuild) carries its own patch and corrected call.
    if (/^PROTOTYPE_/.test(result.code ?? '') || result.ssamDefect === true) return withJobIdentity(result);
    if (result.ok) return withJobIdentity(result);
    const guide = deps.guidance ?? (await import('./job-guidance.mjs')).withJobGuidance;
    return withJobIdentity(await guide(checked.request.lane, result.job ?? (typeof input.job === 'string' ? input.job : null), result));
  } catch (error) { return { ok: false, ...seamFields(error), error: error.message }; }
}

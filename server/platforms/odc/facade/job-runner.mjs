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
// to <lane local>/journal/job-patch.jsonl). jobTool answers the job it ran with its sha256, for the next patch.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { readConnection } from './studio-session.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { createWorkerClient, workerDisabled } from './anvil-worker.mjs';
import { resolvePatchedJob, jobIdentity, failedOpOf } from './job-patch.mjs';
import { seamFields, usesWorkspace, workspacePath } from './executor.mjs';
import { highWarningsOf } from './delivery-warnings.mjs';

export const JOB_LANES = ['o11', 'odc'];
const clip = (text, max = 400) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };
const tail = (lines, max) => (Array.isArray(lines) ? lines.join('\n') : String(lines ?? '')).slice(-max);
// pathlib.Path.with_suffix: the last suffix replaced (or added).
const withSuffix = (file, suffix) => { const p = path.parse(file); return path.join(p.dir, p.name + suffix); };
const bindingName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const refusal = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// "Name=path" with the path made absolute against the kernel root (run_job.py ran there); anything else as it came.
function producerArg(entry, abs) {
  const text = String(entry); const at = text.indexOf('=');
  return at >= 0 && text.slice(at + 1) ? text.slice(0, at) + '=' + abs(text.slice(at + 1)) : text;
}
const producerList = value => (!value ? [] : Array.isArray(value) ? value.map(String) : Object.entries(value).map(([name, file]) => name + '=' + file));
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

// Preflight problems (I2: {op, pointer, code, severity, message, fix, patch}) as the answer keeps them: all of them, each
// text cut at 300 characters; a mechanical patch stays only while it is small (the job file keeps nothing else).
export function problemsOf(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map(p => {
    if (!p || typeof p !== 'object') return clip(typeof p === 'string' ? p : JSON.stringify(p), 300);
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === 'string') out[k] = clip(v, 300);
      else if (k === 'patch' && v != null) { const text = JSON.stringify(v); if (text.length <= 300) out[k] = v; else out.patchOmitted = true; }
      else if (v === null || typeof v !== 'object') out[k] = v;
      else out[k] = fitted(v, 300);
    }
    return out;
  });
}
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
  if (saved.capturedProducers) value.capturedProducers = saved.capturedProducers.map(r => ({ producer: r?.producer, kind: r?.kind,
    versionIdBefore: r?.versionIdBefore, signatureHash: r?.signatureHash, avsigPath: r?.avsigPath, avsigSha256: r?.avsigSha256 }));
  if (note) value.worker = note;
  // The HIGH warnings of the data-access rules (QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE): always in the answer,
  // success or refusal, outside the 1 KB budget of a success (never blocking, never hidden).
  const high = highWarningsOf(x.highWarnings);
  if (high.length) value.highWarnings = high.slice(0, 10);
  const results = !quiet && x.results?.length ? resultsOf(x.results) : [];
  if (value.ok) {
    if (Array.isArray(x.messages)) value.messages = x.messages.length; else if (x.messages !== undefined) value.messages = x.messages;
    if (x.details?.length) value.detailsTotal = x.details.length;
    const warnings = x.preflight?.warnings;
    if (Array.isArray(warnings) && warnings.length) value.preflightWarnings = warnings.length;
    // jobTool adds jobSha256 and jobShape (about 100 bytes) after this.
    return successOf(value, results, SUCCESS_BYTES - 120, x.results?.length ?? 0);
  }
  // A refusal of the job (I2): every problem, from the CLI's error envelope or from the apply's own preflight.
  const problems = problemsOf(saved.problems ?? x.preflight?.problems);
  if (problems?.length) value.problems = problems;
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
  let job;
  if (request.patch != null || request.basedOn != null) {
    const patched = resolvePatchedJob({ job: request.job, patch: request.patch, basedOn: request.basedOn }, { root, inlineDir: path.join(laneLocal, 'jobs', 'inline'),
      work: lane === 'o11' ? o11.work : null, journalDir: path.join(laneLocal, 'journal'), tool: lane === 'odc' ? 'ssam_job' : 'o11_job', uuid: deps.uuid ?? randomUUID });
    if (!patched.ok) return { ...patched, lane };
    job = patched.path;
  } else if (typeof request.job === 'string' && request.job.trim()) job = abs(request.job);
  else if (request.job && typeof request.job === 'object') {
    const folder = path.join(lane === 'odc' ? odcLocal : o11.local, 'jobs', 'inline');
    fs.mkdirSync(folder, { recursive: true });
    job = path.join(folder, (deps.uuid ?? randomUUID)() + '.json');
    fs.writeFileSync(job, JSON.stringify(request.job, null, 2), 'utf8');
  } else return refusal('job-required', 'job is required: a path (absolute or relative to the kernel root) or the job itself (object, or array of ops)', { lane });
  if (!fs.existsSync(job)) return refusal('job-not-found', 'Job file not found: ' + job, { lane, job });
  // Integration ops (rest, rest-expose, soap): the documents they name are pinned once (integration-documents.mjs, I6).
  // A headless job writes nothing to a Studio, so the destructive-words rule of the deliveries does not apply here.
  const prepare = deps.prepareIntegrationJob ?? (await import('./integration-documents.mjs')).prepareIntegrationJob;
  const prepared = await prepare(job, { lane, localRoot: laneLocal, destructive: false, ...(deps.fetch ? { fetchImpl: deps.fetch } : {}) });
  if (prepared?.ok === false) return { ...prepared, lane, job, stage: 'documents' };
  if (prepared?.changed) job = prepared.job;
  const stem = path.parse(job).name;
  const producers = producerList(request.producers).map(p => producerArg(p, abs));
  const base = request.base != null && String(request.base) !== '' ? abs(request.base) : null;
  const runAnvil = deps.runAnvil ?? createAnvilRunner({ lane: o11.name, root, env });
  const worker = workerDisabled(lane, env) ? null : deps.worker ?? createWorkerClient(lane, { root, env, o11: o11.name, ...(deps.workspace ? { workspace: deps.workspace } : {}) }, deps);

  // Read-only captures through the lane's logged-in Studio, before the job (run_job.py capture_producers), on the bridge
  // port of the connection record (the selected Studio), else the lane table's.
  const capturePort = () => { try { const r = readConnection(root, o11.name); if (Number.isInteger(r?.port)) return r.port; } catch { /* lane table */ } return o11.bridge; };
  const receipts = [];
  if (captures.length) {
    const folder = path.join(o11.jobs, 'captured', stem);
    fs.mkdirSync(folder, { recursive: true });
    for (const entry of captures) {
      const at = entry.indexOf('=');
      const binding = at < 0 ? entry : entry.slice(0, at);
      const producer = at >= 0 && entry.slice(at + 1) ? entry.slice(at + 1) : binding;
      const target = path.join(folder, binding + '.avsig');
      const r = await runAnvil(['signature', '--producer', producer, '--job', job, '--binding', binding, '--out', target, '--bridge-port', String(capturePort())], { cwd: root });
      if (r.envelope?.ok !== true) return refusal('capture-failed', r.envelope?.error ?? 'the CLI printed no JSON', { lane, job, stage: 'capture-producer', producer,
        ...(r.envelope ? {} : { stdout: tail(r.stdout, 2000) }) });
      receipts.push(r.envelope.data);
      producers.push(`${binding}=${target}`);
    }
  }

  // wallMs covers the apply only (worker attempt included), as anvil_cli.run and run_job.py odc_lane measure it.
  let saved; let out; let note; const started = now();
  if (lane === 'odc') {
    out = request.out ? abs(request.out) : path.join(odcLocal, 'jobs', stem + '.oml');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const argv = ['apply', '--job', job, '--out', out, ...(base ? ['--base', base] : []), ...producers.flatMap(p => ['--producer', p]),
      '--work', path.join(odcLocal, 'jobs', 'work')];
    let envelope = null; let via = 'worker odc';
    if (worker) {
      const w = await worker.run(argv);
      if (w.used && w.unknown) return refusal('worker-outcome-unknown', w.error, { lane, job, via, ...(w.detail ? { detail: w.detail } : {}) });
      if (w.used && !notExecuted(w.envelope)) envelope = w.envelope; else note = w.used ? coldNote(w.envelope) : w.note;
      if (w.warning) note = w.warning;
    }
    if (!envelope) {
      via = 'processo frio odc';
      const r = await runAnvil(argv, { cli: odcCli, cwd: root });
      if (!r.envelope) return refusal('no-json', 'the CLI printed no JSON', { lane, job, via, exitCode: r.exitCode, stdout: tail(r.stdout, 2000), stderr: r.stderr ?? [] });
      envelope = r.envelope;
    }
    const wallMs = now() - started;
    // An error envelope carries error/stack, no data: run_job.py printed it and wrote no result file.
    if (envelope.data == null) {
      const problems = problemsOf(envelope.problems);
      return { ok: false, lane, job, via, command: envelope.command, elapsedMs: envelope.elapsedMs, wallMs, ...(envelope.code ? { code: envelope.code } : {}),
        error: clip(envelope.error ?? 'the CLI returned no data', 2000), ...(problems?.length ? { problems } : {}), ...(note ? { worker: note } : {}) };
    }
    saved = { ok: Boolean(envelope.ok), data: envelope.data, via, wallMs };
  } else {
    out = request.out ? abs(request.out) : path.join(o11.jobs, stem + '.oml');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const argv = ['apply', '--job', job, '--out', out, '--work', o11.work, ...(base ? ['--base', base] : []), ...producers.flatMap(p => ['--producer', p])];
    let envelope = null;
    if (worker) {
      const w = await worker.run(argv);
      if (w.used && w.unknown) return refusal('worker-outcome-unknown', w.error, { lane, job, via: 'worker', ...(w.detail ? { detail: w.detail } : {}) });
      if (w.used && !notExecuted(w.envelope)) envelope = { ...w.envelope, via: 'worker' }; else note = w.used ? coldNote(w.envelope) : w.note;
      if (w.warning) note = w.warning;
    }
    if (!envelope) {
      const r = await runAnvil(argv, { cwd: root, timeoutMs: 900000 });
      // anvil_cli.run: a non-JSON answer becomes an error envelope with the end of stdout and stderr.
      envelope = { ...(r.envelope ?? { ok: false, command: 'apply', error: (tail(r.stdout, 800) + '\n' + tail(r.stderr, 800)).trim() }),
        via: 'process', stderr: tail(r.stderr, 4000) };
    }
    saved = { ...envelope, wallMs: now() - started };
  }
  if (receipts.length) saved.capturedProducers = receipts;
  const resultFile = withSuffix(out, '.result.json');
  fs.writeFileSync(resultFile, JSON.stringify(saved, null, 2), 'utf8');
  return summarize({ lane, job, out, resultFile, saved, note, quiet: request.quiet === true });
}

// The MCP inputs of o11_job / ssam_job, checked as ssam.mjs producerArgs checks them: binding names, absolute
// producer paths, no name both bound and captured; captures exist only in lane o11.
export function jobToolRequest(input = {}) {
  const allowed = ['job', 'patch', 'basedOn', 'lane', 'base', 'out', 'producers', 'captureProducers', 'quiet'];
  const unknown = Object.keys(input).filter(k => !allowed.includes(k));
  if (unknown.length) return refusal('unknown-argument', 'Unknown argument(s) ' + unknown.join(', '));
  const lane = input.lane ?? 'o11';
  if (!JOB_LANES.includes(lane)) return refusal('unknown-lane', `Unknown lane ${lane}; lanes: ${JOB_LANES.join(', ')}`);
  // patch + basedOn stand for job (job-patch.mjs checks the patch and the base).
  const patching = input.patch != null || input.basedOn != null;
  if (patching && input.job != null) return refusal('PATCH_INVALID', 'patch replaces job: send the whole job without patch, or patch with basedOn and no job');
  if (patching && (input.patch == null || input.basedOn == null))
    return refusal('PATCH_INVALID', input.patch == null ? 'basedOn goes with patch' : 'patch needs basedOn: {job, sha256} as an answer returned them (job, jobSha256), or {taskId} of an O11 delivery');
  const producers = input.producers ?? {};
  if (typeof producers !== 'object' || Array.isArray(producers)) return refusal('invalid-producers', 'producers is {Name: absolute path of a frozen producer .oml or .avsig}');
  for (const [name, file] of Object.entries(producers)) {
    if (!bindingName.test(name)) return refusal('invalid-producers', 'Invalid producer binding name: ' + name);
    if (typeof file !== 'string' || !path.isAbsolute(file)) return refusal('invalid-producers', 'Producer ' + name + ' needs an absolute path');
  }
  const captures = input.captureProducers ?? [];
  if (!Array.isArray(captures)) return refusal('invalid-capture', 'captureProducers is ["Name" | "Name=Producer"]');
  if (lane !== 'o11' && captures.length) return refusal('capture-o11-only', 'captureProducers reads O11 producer signatures; it exists only in lane o11.', { lane });
  for (const entry of captures) {
    const [name, producer] = String(entry).split(/=(.*)/s);
    if (!bindingName.test(name) || producer === '') return refusal('invalid-capture', 'Invalid captureProducers entry: ' + entry);
    if (Object.hasOwn(producers, name)) return refusal('invalid-capture', 'Producer ' + name + ' is both bound and captured');
  }
  return { ok: true, request: { lane, job: input.job, base: input.base, out: input.out, producers, captureProducers: captures, ...(input.quiet ? { quiet: true } : {}),
    ...(patching ? { patch: input.patch, basedOn: input.basedOn } : {}) } };
}

// The job file that ran, with its sha256 (the next call patches it with basedOn {job, sha256}; jobShape 'array' when its
// patch paths are /<i>/...) and, on a failure, the op the kernel refused when its own error names it (job-patch.mjs
// failedOpOf).
function withJobIdentity(result) {
  if (!result || typeof result !== 'object' || typeof result.job !== 'string') return result;
  const { jobSha256, jobShape } = jobIdentity(result.job);
  const failedOp = result.ok ? null : failedOpOf(result.error, result.job);
  return { ...result, ...(jobSha256 ? { jobSha256 } : {}), ...(jobShape ? { jobShape } : {}), ...(failedOp != null ? { failedOp } : {}) };
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
    if (result.ok) return withJobIdentity(result);
    const guide = deps.guidance ?? (await import('./job-guidance.mjs')).withJobGuidance;
    return withJobIdentity(await guide(checked.request.lane, result.job ?? (typeof input.job === 'string' ? input.job : null), result));
  } catch (error) { return { ok: false, ...seamFields(error), error: error.message }; }
}

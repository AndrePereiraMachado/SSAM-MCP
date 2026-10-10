// The O11 cycle over MCP, so the model reads and delivers without the shell (`ssam inspect|deliver --lane o11` cost ~17 s
// a call and a quarter of those invocations failed before running):
//   o11_inspect  the resident O11 reader (kernel-reading.mjs: `read-serve` of the lane CLI) over a capture .oml;
//   o11_deliver  the Anvil CLI `deliver` (headless validation, one native merge, TrueChange check), or with until=apply a
//                snapshot through the bridge plus `apply` (validation only, nothing merged); close / closePrevious run
//                `deliver --close` on a refused task that still holds the module (never on an uncertain one); patch +
//                basedOn correct a refused job with a JSON Patch into a new job file (job-patch.mjs), and every refusal
//                names the job it used (job, jobSha256) so the next call patches it;
//   ssam_task    the long tasks (ssam-task.mjs).
// Policy stays in the kernel: the CLI validates, merges once and keeps the task (work/deliver/<taskId>/task.json). This
// file builds the argv, keeps the user's words as a sha256 in the lane journal and reads the outcome: delivered ->
// "entregue"; validation errors -> the errors, nothing delivered; an unconfirmed write -> uncertain, never repeated
// (resume reconciles the same task through merge_status). No Python, no shell, no sleep: each call waits for its process.
//
// Session package of 2026-10-05 (lane D1, docs/PACOTE-SESSOES-NOVO.md):
// - publish:true (C08): after a clean merge the o11_publish flow runs on the same module with the same words, or with a
//   standing grant (standing-grants.mjs) when authorize is absent; the answer carries publish (section 3.2). A merge that
//   is not clean skips it (publish.outcome "skipped"); a failed or uncertain publication answers ok:false, result
//   "entregue", PUBLISH_FAILED|PUBLISH_UNCERTAIN and only the o11_publish continuation: the delivery is never repeated.
// - authorize may be absent when a standing grant covers the module for deliver; the answer names authorization.
// - every producer a `reference` op of the job names is captured read-only (captureProducers), as the ODC lane does (C27).
// - a job made only of `set StyleSheet` on blocks or themes gets one deterministic touch of a block widget (C32): the
//   published block CSS is regenerated only when a widget of the block changes. The answer says touch {target, op}.
// - a refused job answers PREFLIGHT_REFUSED with every problem of every phase over the live module (primeira-certa A3:
//   the build applies the job to the capture; refusal-problems.mjs keeps phase, pointer, fix, patch, element, key,
//   verifyRan and phases, grouped only to fit the answer); the kernel's own codes (VERIFY_UNAVAILABLE,
//   MERGE_ROLLED_BACK, SIGNATURE_PREVIEW_REFUSED, ...) pass through; a delivery answers leftovers, screenRoles and
//   lastPublication when there is something to say.
// - ssam_task {id, close} closes a refused task, or an uncertain one with the kernel's hash proof (C15).
//
// Atritos 2 package of 2026-10-06 (lane F1, docs/PACOTE-ATRITOS-2.md):
// - A03: only Verify errors block; the warnings that block nothing come back as warnings (at most 20, plus warningsTotal),
//   in "entregue" and in a refusal with errors (delivery-warnings.mjs, contract I9).
// - A12: a merge kept only because the data proof differs answers DATA_PROOF_DIFFERS with dataProof.differences (at most 20,
//   plus differencesTotal) and the ssam_evidence continuation on the task's result.json.
// - A28: a module held by a task of another SSAM root (MODULE_RESERVED_FOREIGN), or by a task this root does not have,
//   continues with ssam_doctor {lane:"o11"}, never with resume or ssam_task.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { o11Bridge, bridgeTarget } from './o11-bridge.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { kernelReading } from './kernel-reading.mjs';
import { assertSelectedO11 } from './studio-connect.mjs';
import { readConnection } from './studio-session.mjs';
import { trackTask, registerSsamTask, tasksDir } from './ssam-task.mjs';
import { seamFields } from './executor.mjs';
import { o11Studio, lastPublicationOf, readInventory } from './o11-studio.mjs';
import { resolvePatchedJob, failedOpOf, jobShapeOf, PATCH_MAX_OPS } from './job-patch.mjs';
import { resolveOpenModule } from './studio-module.mjs';
import * as standingGrants from './standing-grants.mjs';
import { prepareIntegrationJob } from './integration-documents.mjs';
import { taskWarnings, warningFields } from './delivery-warnings.mjs';
// Lane wp (atritos 3): the build phase of a phased delivery, outside the Studio lock (o11-build-phase.mjs).
import { phaseGuards, buildBeforeApply, afterApply } from './o11-build-phase.mjs';
import { refusalFields, diagnosisOf } from './refusal-problems.mjs';
import { PHASES_META } from './studio-write-lock.mjs';

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const reply = (value, text = JSON.stringify(value)) => ({ content: [{ type: 'text', text }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const DELIVERED = Object.freeze({ ok: true, result: 'entregue' });
const CLOSED = Object.freeze({ ok: true, result: 'fechada' });
// Stands for the user's words in a continuation; never accepted as words.
export const WORDS_MARKER = '<palavras do usuário>';
const SUPERSEDED = 'superseded by a corrected job';

class Refusal extends Error { constructor(code, message, continuation, extra = {}) { super(message); this.code = code; this.continuation = continuation; this.extra = extra; } }
const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, ...(continuation ? { continuation } : {}) });
const doctor = why => ({ tool: 'ssam_doctor', arguments: { lane: 'o11' }, why });
const connect = why => ({ tool: 'ssam_connect', arguments: { lane: 'o11' }, why });
const resumeWith = taskId => ({ tool: 'o11_deliver', arguments: { resume: taskId },
  why: 'Resumes the same kernel task: it reconciles through merge_status and never repeats the merge. Pass the user\'s words in authorize.' });

// Kernel and bridge texts may carry a shell hint (ssam connect ..., dotnet build ...). The model gets continuations,
// never commands, so those sentences are dropped and the rest is kept short.
const SHELL = /\b(?:dotnet\s+(?:build|run|test)\b|python\b|run_job\.py|build(?:_odc)?\.py|anvil_worker\.py|(?:ssam|odc)(?:\.cmd)?\s+(?:connect|inspect|deliver|doctor|job|map|discover|attach|studio|download|inventory|access|data|publish|mcp)\b)|\.ps1\b/i;
export function clean(text, limit = 400) {
  const kept = String(text ?? '').split(/(?<=[.;])\s+/).filter(s => !SHELL.test(s)).join(' ').trim();
  return kept.length > limit ? kept.slice(0, limit - 1) + '…' : kept;
}

// ---- o11_inspect
const inspectSchema = z.object({
  oml: z.string().min(1).optional().describe('Capture .oml to read (absolute path). Give oml or module'),
  module: z.string().min(1).optional().describe('A module open in the selected Service Studio, captured first, then read'),
  path: z.string().min(1).optional().describe('Kind:Name/Kind:Name or @key from the same capture'),
  select: z.array(z.string().min(1)).min(1).max(32).optional().describe('Read several paths relative to path in one verified load'),
  kind: z.string().min(1).optional(), name: z.string().min(1).optional().describe('Exact name or label, case-insensitive'),
  text: z.string().min(1).optional().describe('Search full text before clipping'), offset: z.number().int().min(0).default(0),
  properties: z.string().min(1).optional().describe('Comma-separated property projection'),
  usages: z.boolean().default(false).describe('Incoming native references to the target and its children'),
  scope: z.enum(['direct', 'subtree']).optional().describe('Usage scope, default subtree'),
  includeInternal: z.boolean().default(false).describe('Include usages inside the selected target subtree'),
  depth: z.number().int().min(0).max(12).default(3), max: z.number().int().min(1).max(500).default(60),
  all: z.boolean().default(false).describe('Include audit properties'), full: z.boolean().default(false).describe('Do not clip property text or collections'),
  cold: z.boolean().default(false).describe('Reload the source instead of reusing the resident capture'),
  budget: z.number().int().min(2000).max(200000).default(60000).describe('Character budget of the inline answer; above it the full JSON goes to out'),
  expectedSourceSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe('Refuse if the capture bytes differ from this hash'),
}).strict();

// The argv kernel-reading.mjs parses (the same reading as `ssam inspect --lane o11`), always with the Studio folder the
// reader binds, so the resident reader and the availability check agree on it.
export function inspectArguments(input, file, studioDir) {
  const args = ['--oml', file];
  if (input.path) args.push('--path', input.path);
  for (const selector of input.select ?? []) args.push('--select', selector);
  for (const key of ['kind', 'name', 'text', 'properties', 'scope']) if (input[key] != null) args.push('--' + key, String(input[key]));
  for (const key of ['depth', 'max', 'offset', 'budget']) if (input[key] != null) args.push('--' + key, String(input[key]));
  for (const [key, flag] of [['usages', '--usages'], ['includeInternal', '--include-internal'], ['all', '--all'], ['full', '--full'], ['cold', '--cold']])
    if (input[key] === true) args.push(flag);
  if (input.expectedSourceSha256) args.push('--expectedSourceSha256', input.expectedSourceSha256);
  if (studioDir) args.push('--ss-dir', studioDir);
  return args;
}

// What reader-client.mjs readSnapshot will need: the lane CLI, the Studio folder and the controller key (it reads the key
// from ANVIL_AUTHORITY_DIR, else %LOCALAPPDATA%\Anvil\authority, as here).
export function readerMissing({ cli, studioDir, env = process.env }) {
  const authority = env.ANVIL_AUTHORITY_DIR ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Anvil', 'authority') : null);
  return [[!isFile(cli), 'cli'], [!fs.existsSync(studioDir ?? ''), 'studio'], [!authority || !isFile(path.join(authority, 'bridge.key')), 'key']]
    .filter(([missing]) => missing).map(([, name]) => name);
}
const readerDown = error => error?.code === 'ENOENT' || /Read process (failed to start|startup timed out)/.test(error?.message ?? '');
const unavailable = missing => refusal('O11_READER_UNAVAILABLE', 'The O11 reader cannot start here' + (missing?.length ? ' (missing: ' + missing.join(', ') + ')' : '') + '.',
  doctor('Reports the lane CLI, the Studio installation and the bridge connection of O11.'), missing?.length ? { missing } : {});

async function inspect(input, ctx) {
  if (!input.oml === !input.module) return refusal('BAD_ARGS', 'Give exactly one of oml (a capture .oml) or module (a module open in the selected Service Studio)');
  if (input.module) {
    // The live module: one capture through the bridge (an open tab by its key, or opened under the write lock), then the
    // same read on that file. The capture is named in the answer so the next reads reuse it with expectedSourceSha256
    // instead of capturing again.
    const shot = await (ctx.captureRead ?? ctx.capture)(input.module);
    if (shot?.ok !== true || typeof shot.path !== 'string') return shot?.ok === false ? shot : refusal('CAPTURE_FAILED', 'The Studio capture of ' + input.module + ' returned no file');
    const { module: _module, ...rest } = input;
    const value = await inspect({ ...rest, oml: shot.path, expectedSourceSha256: input.expectedSourceSha256 ?? shot.sha256 }, ctx);
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value, capture: { oml: shot.path, sha256: shot.sha256, module: input.module } } : value;
  }
  const file = path.resolve(input.oml);
  if (!/\.oml$/i.test(file) || !isFile(file)) return refusal('CAPTURE_NOT_FOUND', 'No capture .oml at ' + file, doctor('Shows the O11 lane state; a capture comes from a delivery snapshot or a download.'));
  const lane = ctx.lane();
  const studioDir = ctx.connection()?.studioDir ?? lane.studioDir;
  const missing = ctx.readerCheck ? ctx.readerCheck({ cli: lane.cli, studioDir, env: ctx.env }) : [];
  if (missing.length) return unavailable(missing);
  try {
    const result = await ctx.read({ name: 'o11', root: ctx.root, lane: lane.name, cli: lane.cli }, inspectArguments(input, file, studioDir));
    return result?.data ?? result;
  } catch (error) {
    return readerDown(error) ? unavailable() : { ok: false, file, error: clean(error.message) };
  }
}

// ---- o11_deliver
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ops = z.array(z.record(z.string(), z.unknown())).min(1);
const TASK_ID = /^[0-9a-fA-F]{32}$/;
const SHA = /^[a-fA-F0-9]{64}$/;
// JSON Patch (job-patch.mjs): the same shape as its patchJsonSchema / basedOnJsonSchema.
const patchSchema = z.array(z.object({ op: z.enum(['add', 'remove', 'replace', 'test']), path: z.string().min(1), value: z.unknown().optional() }).strict())
  .min(1).max(PATCH_MAX_OPS);
const basedOnSchema = z.union([z.object({ job: z.string().min(1), sha256: z.string().regex(SHA) }).strict(),
  z.object({ taskId: z.string().regex(TASK_ID), sha256: z.string().regex(SHA).optional() }).strict()]);
const deliverSchema = z.object({
  module: z.string().min(1).optional().describe('Module open (or to open) in the selected Service Studio; a label with spaces ("GameStore CS") reaches the open module with the same letters and digits. Required unless resume or close (with basedOn.taskId it defaults to that task\'s module)'),
  job: z.union([z.string().min(1), ops, z.record(z.string(), z.unknown())]).optional()
    .describe('Absolute path of the job JSON, or the job itself (array of ops, or {ops} / {jobs}). Required unless resume, close or patch'),
  patch: patchSchema.optional().describe('Instead of job: JSON Patch (add, remove, replace, test; at most 50) over the job of basedOn, '
    + 'paths /ops/<i>/... (/<i>/... for an array job); the patched job is a new file'),
  basedOn: basedOnSchema.optional().describe('With patch: {job, sha256} as a refusal returned them (job, jobSha256), or {taskId} of a refused delivery'),
  checks: z.array(z.string().min(1).regex(/^[^,]+$/)).max(64).optional().describe('Element names that must exist after the merge'),
  until: z.enum(['apply', 'merge']).default('merge').describe('apply: validate on a fresh snapshot without merging, only when the person asks for it'),
  producers: z.union([z.literal('published'), z.record(z.string(), z.string().min(1))]).optional()
    .describe('Producer bindings {Name: absolute path of a frozen producer .oml or .avsig, or "published" (captured from the environment)}; "published" alone: every producer the job references'),
  captureProducers: z.array(z.string().min(1)).max(32).optional().describe('Producers captured read-only before the job: "Name" or "Name=Producer" (e.g. "System=(System)")'),
  expectedEnvironment: z.string().min(1).optional().describe('Bare host the selected Studio must be connected to'),
  resume: z.string().regex(TASK_ID).optional().describe('taskId of an earlier delivery to resume; job, module, checks and producers stay those of the task'),
  close: z.object({ taskId: z.string().regex(TASK_ID), reason: z.string().min(1).max(500) }).strict().optional()
    .describe('Alone: close a refused delivery task so the module takes a corrected job'),
  closePrevious: z.string().regex(TASK_ID).optional()
    .describe('With a new delivery: first close this refused task, then deliver'),
  publish: z.boolean().optional().describe('true: publish the same module after a clean merge'),
  authorize: z.string().optional().describe('The user\'s own words, verbatim (only their sha256 is kept); absent: a standing grant of the module, else nothing runs'),
}).strict();

// K1-d (atritos 3): a binding "published" is the producer's published signature, captured read-only by the kernel
// (--capture-producer; System is the environment's "(System)"), with the owners of its foreign types (Delivery
// CaptureOwners). producers:"published" (the text, not a map) binds nothing by hand: every producer the job references is
// captured (autoCaptures).
export const PUBLISHED = 'published';
const captureOf = name => (name.toLowerCase() === 'system' ? name + '=(System)' : name);
export function producerArgs(producers = {}, captures = []) {
  const args = [];
  const bound = producers === PUBLISHED ? {} : producers ?? {};
  for (const [name, file] of Object.entries(bound)) {
    if (!BINDING.test(name)) throw new Refusal('PRODUCER_INVALID', 'Invalid producer binding name: ' + name);
    if (file === PUBLISHED) { args.push('--capture-producer', captureOf(name)); continue; }
    if (!path.isAbsolute(file)) throw new Refusal('PRODUCER_INVALID', 'Producer ' + name + ' needs an absolute path or "published"');
    args.push('--producer', name + '=' + file);
  }
  for (const entry of captures ?? []) {
    const [name, producer] = String(entry).split(/=(.*)/s);
    if (!BINDING.test(name) || producer === '') throw new Refusal('PRODUCER_INVALID', 'Invalid captureProducers entry: ' + entry);
    if (Object.hasOwn(bound, name)) throw new Refusal('PRODUCER_INVALID', 'Producer ' + name + ' is both bound and captured');
    args.push('--capture-producer', String(entry));
  }
  return args;
}

// `deliver --module M --job J [--checks a,b] [--producer N=path]* [--capture-producer N[=P]]* [--expected-environment h]
// --work W --port P` (kernel DeliverArguments.ForJob); resume: `deliver --resume <taskId> --work W --port P`.
// K1-g: without a publication in the same call the kernel closes the tab the delivery opened (--close-opened-tab); with
// publish:true the tab stays for the publication and is closed after it (closeOpenedTab).
export function deliverArguments(input, { work, port }) {
  const close = input.publish === true ? [] : ['--close-opened-tab'];
  if (input.resume) return ['deliver', '--resume', input.resume, '--work', work, '--port', String(port),
    ...(input.expectedEnvironment ? ['--expected-environment', input.expectedEnvironment] : []), ...close];
  return ['deliver', '--module', input.module, '--job', input.job, ...(input.checks?.length ? ['--checks', input.checks.join(',')] : []),
    ...producerArgs(input.producers, input.captureProducers), ...(input.expectedEnvironment ? ['--expected-environment', input.expectedEnvironment] : []),
    '--work', work, '--port', String(port), ...close];
}
// `deliver --close <taskId> --reason <text> --work W --port P` (kernel DeliveryTask.CloseKnownFailure).
export const closeArguments = (taskId, reason, { work, port }) => ['deliver', '--close', taskId, '--reason', reason, '--work', work, '--port', String(port)];

// The job file this delivery runs, with its sha256 (job-patch.mjs): a path as given (absolute), an inline job written once
// under <lane.local>/jobs/inline/<uuid>.json, or patch + basedOn applied into a new file there (the base never changes).
function resolveJob(input, lane) {
  const resolved = resolvePatchedJob({ job: input.job, patch: input.patch, basedOn: input.basedOn },
    { inlineDir: path.join(lane.local, 'jobs', 'inline'), work: lane.work });
  if (resolved.ok) return resolved;
  // A changed base is not patched blind: the file as it is now, or the whole corrected job, in the same call otherwise
  // (until=apply stays a validation, closePrevious still closes the refused task); the words only as the marker.
  const next = resolved.code === 'BASE_CHANGED' && resolved.job ? { tool: 'o11_deliver', arguments: { module: input.module, job: resolved.job,
    ...(input.checks?.length ? { checks: input.checks } : {}), ...(input.producers ? { producers: input.producers } : {}),
    ...(input.captureProducers?.length ? { captureProducers: input.captureProducers } : {}),
    ...(input.expectedEnvironment ? { expectedEnvironment: input.expectedEnvironment } : {}),
    ...(input.until === 'apply' ? { until: 'apply' } : {}), ...(input.closePrevious ? { closePrevious: input.closePrevious } : {}), authorize: WORDS_MARKER },
    why: 'The job file changed after that refusal: send it as it is now, or the whole corrected job; a patch applies only to the content the refusal named. authorize: as palavras do usuário no lugar do marcador.' } : undefined;
  throw new Refusal(resolved.code, resolved.error, next, resolved.at != null ? { at: resolved.at } : {});
}
// Every refusal of a delivery that ran a job names that job, so the next call patches it (jobShape 'array': its patch
// paths are /<i>/...); an uncertain one never does (it is resumed, never corrected).
function withJob(value, resolved) {
  if (value?.ok !== false || value.outcome === 'uncertain' || !resolved?.path || value.job != null) return value;
  const shape = jobShapeOf(resolved.path);
  return { ...value, job: resolved.path, jobSha256: resolved.sha256, ...(shape ? { jobShape: shape } : {}) };
}

// patch + basedOn instead of job. A base task with an unconfirmed write is resumed, never patched; the module defaults to
// the base task's. Returns the input to deliver, or a refusal ({ok:false}).
function patchInput(input, lane) {
  if (input.job != null) throw new Refusal('PATCH_INVALID', 'patch replaces job: send the whole job without patch, or patch with basedOn and no job.');
  if (input.patch == null) throw new Refusal('PATCH_INVALID', 'basedOn goes with patch.');
  if (input.basedOn == null) throw new Refusal('PATCH_INVALID', 'patch needs basedOn: {job, sha256} as a refusal returned them, or {taskId} of the refused delivery.');
  const id = input.basedOn.taskId;
  if (!id) return input;
  const state = findKernelTask(lane.work, { taskId: id });
  if (!state) return refusal('BASE_NOT_FOUND', 'No delivery task ' + id + ' in the lane work folder.', { tool: 'ssam_task', arguments: {}, why: 'Lists the recent deliveries and their kernel taskId.' }, { taskId: id });
  if (deliveryOutcome(state) === 'uncertain') return { ok: false, outcome: 'uncertain', code: 'BASE_UNCERTAIN', stage: state.stage ?? null, taskId: id, writeState: state.writeState,
    error: 'Task ' + id + ' has an unconfirmed write; it is never patched. Resume it first.', continuation: resumeWith(id) };
  return !input.module && state.module ? { ...input, module: state.module } : input;
}

// The kernel's own checkpoint (DurableJson envelope {format, sha256, payload}); null when absent or unreadable.
function readKernelTask(work, id) {
  try {
    const document = JSON.parse(fs.readFileSync(path.join(work, 'deliver', id, 'task.json'), 'utf8').replace(/^\uFEFF/, ''));
    return typeof document.payload === 'string' ? JSON.parse(document.payload) : document;
  } catch { return null; }
}
// task.json is registered before any bridge call, so without an envelope the newest task of this job since the call began
// is the only evidence of what was sent; none means nothing was.
export function findKernelTask(work, { taskId, job, since = 0 }) {
  if (taskId) return readKernelTask(work, taskId);
  let ids; try { ids = fs.readdirSync(path.join(work, 'deliver')); } catch { return null; }
  const same = p => typeof p === 'string' && typeof job === 'string' && path.resolve(p).toLowerCase() === path.resolve(job).toLowerCase();
  return ids.filter(id => /^[0-9a-f]{32}$/i.test(id)).map(id => readKernelTask(work, id))
    .filter(s => s && same(s.request?.JobPath ?? s.request?.jobPath) && (Date.parse(s.updatedAt ?? '') || 0) >= since - 1000)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
}

// delivered | uncertain (intent/unknown, or a merge applied without a validation result) | refused.
export function deliveryOutcome(state) {
  if (state?.delivered === true) return 'delivered';
  if (['intent', 'unknown'].includes(state?.writeState)) return 'uncertain';
  if (['applied', 'unchanged'].includes(state?.writeState) && state?.validation?.newErrors == null) return 'uncertain';
  return 'refused';
}

// What may be done with an earlier kernel task. Closed only as a final refusal the kernel itself closes
// (DeliveryTask.CloseKnownFailure: not delivered, a recorded error, writeState applied|unchanged|not-sent|not-applied), and
// never with an uncertain write. unsettled: no recorded failure (a stopped process): only resume settles it.
export function closeState(state) {
  if (!state) return 'missing';
  if (state.closed === true) return 'closed';
  if (state.delivered === true) return 'delivered';
  if (deliveryOutcome(state) === 'uncertain') return 'uncertain';
  return state.error != null && ['applied', 'unchanged', 'not-sent', 'not-applied'].includes(state.writeState) ? 'refused' : 'unsettled';
}
// The refusal for an earlier task that cannot be closed (null when it is refused or already closed).
function notClosable(id, state, input) {
  switch (closeState(state)) {
    case 'missing': return refusal('CLOSE_TASK_NOT_FOUND', 'No delivery task ' + id + ' in the lane work folder.', { tool: 'ssam_task', arguments: {}, why: 'Lists the recent deliveries and their kernel taskId.' }, { taskId: id });
    case 'delivered': return refusal('PREVIOUS_NOT_REFUSED', 'Task ' + id + ' was delivered; there is nothing to close.',
      { tool: 'o11_deliver', arguments: input.module ? { module: input.module } : {}, why: 'Deliver without closePrevious or close.' }, { taskId: id });
    case 'uncertain': return { ok: false, outcome: 'uncertain', code: 'PREVIOUS_UNCERTAIN', stage: state.stage ?? null, taskId: id, writeState: state.writeState,
      error: 'Task ' + id + ' has an unconfirmed write; it is never closed. Resume it first.', continuation: resumeWith(id) };
    case 'unsettled': return refusal('PREVIOUS_NOT_CLOSABLE', 'Task ' + id + ' has no recorded failure; the kernel closes only known failures.', resumeWith(id), { taskId: id });
    default: return null;
  }
}
// The corrected job after a refused task that still holds the module: close it and deliver, in one call. The marker
// stands for the user's words, which are never repeated in an answer.
const closeAndDeliver = (input, job, holder) => ({ tool: 'o11_deliver', arguments: { module: input.module, job,
  ...(input.checks?.length ? { checks: input.checks } : {}), ...(input.producers ? { producers: input.producers } : {}),
  ...(input.captureProducers?.length ? { captureProducers: input.captureProducers } : {}),
  ...(input.expectedEnvironment ? { expectedEnvironment: input.expectedEnvironment } : {}), closePrevious: holder, authorize: WORDS_MARKER },
  why: 'A tarefa anterior foi recusada; feche e entregue o job corrigido (ele vale sobre o módulo como está agora no Studio). authorize: as palavras do usuário no lugar do marcador.' });

export function closeOutcome(run, id, work) {
  const state = run?.envelope?.data && typeof run.envelope.data === 'object' ? run.envelope.data : readKernelTask(work, id);
  if (state?.closed === true) return CLOSED;
  const detail = run?.envelope?.error ?? [...(run?.stderr ?? []), ...(run?.stdout ?? [])].slice(-3).join(' ');
  return refusal('CLOSE_REFUSED', clean(detail) || 'The task was not closed.', doctor('Shows the O11 Studio and its dialogs; the close opens the task\'s own module by its key (a task never sent closes without the Studio).'),
    { stage: 'close', taskId: id });
}
// A17: a task whose write never reached the module (not-sent) or was proven not applied closes in the kernel without any
// Studio call, so the facade does not require the selected Studio for it either.
const closesWithoutStudio = state => ['not-sent', 'not-applied'].includes(state?.writeState);

const messageText = m => clean(typeof m === 'string' ? m : [m?.type, m?.id ? m.id + ':' : null, m?.detail, m?.path ? '@ ' + m.path : null].filter(Boolean).join(' '), 300);
// New validation messages, short: the headless candidate (apply) and, after a merge, the Studio's TrueChange delta.
export function validationMessages(state, limit = 20) {
  const all = [...new Set([...(state?.apply?.validation?.new ?? []), ...(state?.apply?.policyMessages ?? []), ...(state?.validation?.new ?? [])].map(messageText).filter(Boolean))];
  return { messages: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

// Problems of a refused preflight (contract I2), each one line: op, pointer, code, severity, message, fix (and patch when
// the correction is mechanical). All of them, never a first-error-only answer.
// primeira-certa A3: with the phase of each (preflight, base, apply, verify), and the element and key of a Verify problem.
export function preflightProblems(problems, limit = 300) {
  return (Array.isArray(problems) ? problems : []).filter(p => p && typeof p === 'object').map(p => ({
    ...(typeof p.phase === 'string' ? { phase: p.phase } : {}),
    op: Number.isInteger(p.op) ? p.op : null, pointer: typeof p.pointer === 'string' ? p.pointer : null, code: String(p.code ?? 'PREFLIGHT_ERROR'),
    severity: p.severity === 'warning' ? 'warning' : 'error', message: clean(p.message, limit), fix: p.fix == null ? null : clean(p.fix, limit),
    ...(Array.isArray(p.patch) && p.patch.length ? { patch: p.patch } : {}),
    ...(typeof p.element === 'string' && p.element ? { element: clean(p.element, limit) } : {}), ...(typeof p.key === 'string' && p.key ? { key: p.key } : {}) }));
}
// The refusal names the job it ran (withJob adds job and jobSha256), so every problem is fixed with one patch + basedOn.
// primeira-certa A3: the kernel's single refusal over the live module (every phase, verifyRan, phases), grouped only to
// fit the answer; a refusal of the apply alone keeps its own code (A7: DELETE_HAS_CONSUMERS) with the same fields.
const preflightRefusal = (source, base, code = 'PREFLIGHT_REFUSED') => ({ ok: false, outcome: 'refused', code, ...base,
  ...(code === 'PREFLIGHT_REFUSED' ? { stage: 'preflight', failed: 'preflight' } : { stage: base.stage ?? 'apply' }),
  error: clean(source.error ?? 'The job was refused by the preflight; nothing was sent to the Studio.', 400),
  ...refusalFields(preflightProblems(source.problems), source) });

// Section 3.2 fields of a delivered answer from the kernel's apply (contract I3/I4): leftovers (expectations met and
// allowlisted Unused* warnings, at most 20 plus leftoversTotal) and screenRoles (html page screens, at most 20 plus
// screenRolesTotal). Absent when there is nothing to say.
export function deliveryFields(state) {
  const validation = state?.apply?.validation ?? {};
  const leftovers = [
    ...(Array.isArray(validation.matched) ? validation.matched : []).filter(m => m && typeof m === 'object')
      .map(m => ({ id: String(m.id ?? ''), element: m.element ?? null, why: m.why ?? null, source: 'expectedMessages' })),
    ...(Array.isArray(validation.verdicts) ? validation.verdicts : []).filter(v => v?.verdict === 'allowlisted' && /^Unused/i.test(String(v.id ?? '')))
      .map(v => ({ id: String(v.id), element: v.path ?? v.key ?? null, why: v.reason ?? null, source: 'allowlist' })),
  ];
  const screenRoles = (Array.isArray(state?.apply?.results) ? state.apply.results : [])
    .filter(r => r?.op === 'html' && Array.isArray(r.result?.roles))
    .map(r => ({ screen: r.result.screen, mode: r.result.mode, roles: r.result.roles, anonymous: r.result.anonymous === true }));
  // The integration reports of the job (contract I7): what each rest/rest-expose/soap op imported, skipped, updated,
  // removed and broke, with the document and the SOAP port; at most 10 plus integrationTotal.
  const integration = Array.isArray(state?.integration) ? state.integration : Array.isArray(state?.apply?.integration) ? state.apply.integration : [];
  return { ...(leftovers.length ? { leftovers: leftovers.slice(0, 20), ...(leftovers.length > 20 ? { leftoversTotal: leftovers.length } : {}) } : {}),
    ...(screenRoles.length ? { screenRoles: screenRoles.slice(0, 20), ...(screenRoles.length > 20 ? { screenRolesTotal: screenRoles.length } : {}) } : {}),
    ...(integration.length ? { integration: integration.slice(0, 10), ...(integration.length > 10 ? { integrationTotal: integration.length } : {}) } : {}),
    // A03 (I9): the new warnings that blocked nothing, each with its path and the suggested fix.
    ...warningFields(taskWarnings(state)),
    // MB2: the dependencies dialogs the delivery answered (Cancel) and the Refresh References of every producer after each.
    ...referencesRefreshedOf(state) };
}
// MB2 (Delivery.cs, DeliveryDependenciesDialog.cs): the receipt's referencesRefreshed, short; absent when none.
export function referencesRefreshedOf(state) {
  const list = (Array.isArray(state?.referencesRefreshed) ? state.referencesRefreshed : []).filter(r => r && typeof r === 'object');
  if (!list.length) return {};
  return { referencesRefreshed: list.slice(0, 10).map(r => ({ stage: r.stage ?? null, module: r.module ?? null, changed: r.changed === true,
    refreshed: Array.isArray(r.refreshed) ? r.refreshed : [], ...(Array.isArray(r.upToDate) && r.upToDate.length ? { upToDate: r.upToDate } : {}),
    dialog: (Array.isArray(r.dialog) ? r.dialog : []).map(d => ({ kind: d?.kind ?? 'DependenciesDialog', ...(d?.title ? { title: d.title } : {}), answer: d?.answer ?? 'Cancel' })) })) };
}

// A12: the differences of a failed data proof, short: {element, property, expected, actual}, at most 20 plus
// differencesTotal; null when the proof did not fail or names none.
export function dataProofOf(state, max = 20) {
  const proof = state?.dataProof;
  if (!proof || typeof proof !== 'object' || proof.accepted !== false) return null;
  const differences = (Array.isArray(proof.differences) ? proof.differences : []).filter(d => d && typeof d === 'object')
    .map(d => ({ element: d.element ?? null, property: d.property ?? null, expected: d.expected ?? null, actual: d.actual ?? null }));
  if (!differences.length) return null;
  return { differences: differences.slice(0, max), ...(differences.length > max ? { differencesTotal: differences.length } : {}) };
}
// The task's own receipt (DeliveryTask.Save writes <task folder>/result.json): where every difference stays.
const resultFileOf = (state, work) => path.join(typeof state?.work === 'string' && state.work ? state.work : path.join(work ?? '.', 'deliver', String(state?.taskId ?? '')), 'result.json');
export const dataProofContinuation = (state, work) => ({ tool: 'ssam_evidence', arguments: { file: resultFileOf(state, work), pointer: '/dataProof/differences' },
  why: 'O merge ficou no Studio para revisão (Ctrl+Z desfaz) e nada foi publicado: todas as diferenças entre os dados entregues e a tarefa estão neste recibo; corrija o job e entregue com closePrevious.' });

export function deliverOutcome(run, { trackId, work, job, taskId, since, input = {} }) {
  let state = run?.envelope?.data;
  // The CLI's own refusal of the job (Program.ErrorEnvelope with code and problems): nothing reached the Studio. The single
  // refusal (PREFLIGHT_REFUSED) or one of the apply alone with its own code and problems (primeira-certa A7).
  if ((!state || typeof state !== 'object') && (run?.envelope?.code === 'PREFLIGHT_REFUSED' || (Array.isArray(run?.envelope?.problems) && run.envelope.problems.length)))
    return preflightRefusal(run.envelope, { taskId: taskId ?? null }, /^[A-Z][A-Z0-9_]{2,}$/.test(String(run.envelope.code ?? '')) ? run.envelope.code : 'PREFLIGHT_REFUSED');
  if (!state || typeof state !== 'object') {
    const found = findKernelTask(work, { taskId, job, since });
    const error = run?.envelope?.error ?? (run?.timedOut ? 'deliver timed out' : 'deliver ended without an answer');
    if (found) state = { ...found, error: found.error ?? error };
    else if (run?.timedOut) return { ok: false, outcome: 'uncertain', code: 'DELIVERY_UNCERTAIN', stage: null, taskId: null, error: clean(error + '; the outcome is unknown and nothing was repeated'),
      continuation: { tool: 'ssam_task', arguments: { id: trackId }, why: 'Reads what this delivery left recorded; never repeat it.' } };
    else {
      const detail = run?.envelope?.error ?? [...(run?.stderr ?? []), ...(run?.stdout ?? [])].slice(-3).join(' ');
      const failedOp = failedOpOf(run?.envelope?.error, job);
      return { ok: false, outcome: 'refused', code: 'DELIVERY_FAILED', stage: 'start', taskId: taskId ?? null, error: clean(detail) || clean(error),
        ...(failedOp != null ? { failedOp } : {}) };
    }
  }
  const outcome = deliveryOutcome(state);
  // K1-g (I8): what the kernel did with the tab this delivery opened (--close-opened-tab): true, or {closed:false, reason}.
  const tab = state.closedTab !== undefined && state.closedTab !== null ? { closedTab: state.closedTab } : {};
  if (outcome === 'delivered') { const fields = { ...deliveryFields(state), ...tab }; return Object.keys(fields).length ? { ...DELIVERED, ...fields } : DELIVERED; }
  const base = { stage: state.stage ?? null, taskId: state.taskId ?? taskId ?? null };
  if (state.code === 'PREFLIGHT_REFUSED') return preflightRefusal(state, base);
  if (outcome === 'uncertain') return { ok: false, outcome: 'uncertain', code: 'DELIVERY_UNCERTAIN', ...base, writeState: state.writeState,
    error: clean(state.error ?? 'The merge outcome is not confirmed') + ' Nothing was repeated.',
    continuation: base.taskId ? resumeWith(base.taskId) : { tool: 'ssam_task', arguments: { id: trackId }, why: 'Reads what this delivery left recorded; never repeat it.' } };
  const { messages, omitted } = validationMessages(state);
  const failures = (state.failures ?? []).map(f => ({ stage: f?.stage ?? null, error: clean(f?.error, 300) }));
  const invalid = (state.apply && (state.apply.isValid !== true || state.apply.accepted !== true)) || (state.validation?.newErrors ?? 0) > 0 || state.contract?.accepted === false;
  // The kernel names the task that still holds the module ("resume task <id> before starting another"). A refused one is
  // closed together with this corrected job; an uncertain or unsettled one of this root is resumed. A28: a reservation of
  // another SSAM root (MODULE_RESERVED_FOREIGN, I8), or of a task this root does not have, is the doctor's to show and to
  // release with the user's words: never resume nor ssam_task, which would answer TASK_NOT_FOUND.
  const holder = /resume task ([0-9a-f]{32})/i.exec(String(state.error ?? ''))?.[1];
  const holderState = holder ? findKernelTask(work, { taskId: holder }) : null;
  const foreign = state.code === 'MODULE_RESERVED_FOREIGN' || (holder && !holderState);
  const next = foreign ? doctor('O módulo está reservado por uma entrega de outra raiz do SSAM, ou por uma tarefa que esta raiz não tem: o doctor mostra a reserva e a libera com as palavras do usuário.')
    : holder && (closeState(holderState) === 'refused' && input.module && job ? closeAndDeliver(input, job, holder) : resumeWith(holder));
  // After a merge the first failure carries the kernel's own sentence: the merge stays for review in the Studio. A merge
  // order delivery is two native merges, so two undo steps (the bridge's receipt counts them).
  const merged = state.writeState === 'applied';
  const undo = state.merge?.undoSteps === 2 ? 'Ctrl+Z twice undoes it' : 'Ctrl+Z undoes it';
  let error = clean(merged ? state.failures?.[0]?.error ?? state.error : state.error ?? 'Not delivered', 300);
  if (merged && !/merge kept for review/i.test(error)) error = clean('Merge kept for review in the Studio (' + undo + '); nothing was published. ' + error, 300);
  // The op the kernel refused, only when its own error names it (job-patch.mjs failedOpOf); the job of a resumed task is its own.
  const failedOp = merged ? null : failedOpOf(state.error, job ?? state.request?.JobPath ?? state.request?.jobPath);
  // A refusal before the merge is the fix itself: when the kernel gives one line per change (database upgrade rules, SQL,
  // unresolved types), every line stays whole and none is dropped, so the exact change at the end of a long line (a hub
  // entity reached by many cascade paths) always reaches the model.
  const lines = merged ? [] : String(state.error ?? '').split(/\r?\n/).map(l => clean(l, Infinity)).filter(Boolean);
  // After a merge, the known losses of the merge order (MergeOrder) come with their repair job: each element exists now,
  // so a delivery of the repair keeps what the first merge dropped. The refused task still holds the module, so the
  // repair closes it first (closePrevious): the engine's own fix never needs a second, failing call.
  const order = merged ? mergeOrderOf(state.mergeOrder) : null;
  const holds = closeState(state) === 'refused' && TASK_ID.test(String(base.taskId ?? ''));
  const repair = order?.repair && input.module ? { tool: 'o11_deliver', arguments: { module: input.module, job: order.repair,
    ...(input.expectedEnvironment ? { expectedEnvironment: input.expectedEnvironment } : {}), ...(holds ? { closePrevious: base.taskId } : {}), authorize: WORDS_MARKER },
    why: 'Delivers the repair job the kernel computed (set DefaultValue on each element by key) over the module as it is now'
      + (holds ? ', after closing this refused task' : '') + '. authorize: as palavras do usuário no lugar do marcador.' } : null;
  // The Studio runs a bridge older than the merge order this delivery needs: nothing was merged; the current bridge loads
  // with the next Service Studio opened, and the same task then resumes.
  if (state.code === 'BRIDGE_OUTDATED' && !merged) return { ok: false, outcome: 'refused', code: 'BRIDGE_OUTDATED', ...base, error,
    continuation: doctor('Shows the O11 bridge version; the current bridge loads with the next Service Studio opened. Then resume this task'
      + (base.taskId ? ' (o11_deliver {resume:"' + base.taskId + '"})' : '') + '; nothing was merged.') };
  // A merge the Studio rolled back (C15, proven by the bridge or by the kernel's hash proof): nothing applied, the task is
  // closed and the module is free, so the corrected job is simply delivered again.
  if (state.code === 'MERGE_ROLLED_BACK') return { ok: false, outcome: 'refused', code: 'MERGE_ROLLED_BACK', ...base, failed: 'merge', error,
    closed: true, ...(input.module && job ? { continuation: { tool: 'o11_deliver', arguments: { module: input.module, job, authorize: WORDS_MARKER },
      why: 'Nada foi aplicado e o módulo está livre: entregue o job corrigido como uma nova entrega. authorize: as palavras do usuário no lugar do marcador.' } } : {}) };
  // The kernel's own code (VERIFY_UNAVAILABLE, SIGNATURE_PREVIEW_REFUSED, ...) names the refusal; otherwise the class of it.
  const kernelCode = /^[A-Z][A-Z0-9_]{2,}$/.test(String(state.code ?? '')) ? state.code : null;
  // A12: the differences of a failed data proof come in the answer; when they are the only failure (DATA_PROOF_DIFFERS) the
  // continuation reads all of them from the task's receipt.
  const dataProof = dataProofOf(state);
  const evidence = state.code === 'DATA_PROOF_DIFFERS' ? dataProofContinuation(state, work) : null;
  // MB2: the refresh after the dependencies dialog failed: the kernel names the module and the next call.
  const refreshNext = state.code === 'REFERENCES_REFRESH_FAILED' && state.referencesRefreshFailed?.next?.tool ? state.referencesRefreshFailed.next : null;
  const continuation = next ?? evidence ?? refreshNext ?? repair;
  return { ok: false, outcome: 'refused', code: kernelCode ?? (invalid ? 'VALIDATION_REFUSED' : 'DELIVERY_FAILED'), ...base, error,
    // primeira-certa A3/A7: a refusal of the apply alone (DELETE_HAS_CONSUMERS, ...) with its problems, verifyRan and phases.
    // A candidate only the Verify refused: its errors with op, pointer, element, key and fix (apply.problems).
    ...(!merged && Array.isArray(state.problems) && state.problems.length ? refusalFields(preflightProblems(state.problems), state)
      : !merged && Array.isArray(state.apply?.problems) && state.apply.problems.length ? refusalFields(preflightProblems(state.apply.problems), state.apply)
      : merged ? {} : diagnosisOf(state)),
    ...(failedOp != null ? { failedOp } : {}), ...(lines.length > 1 ? { refusalLines: lines } : {}),
    ...(messages.length ? { messages } : {}), ...(omitted ? { messagesOmitted: omitted } : {}), ...(failures.length ? { failures } : {}),
    ...(merged ? { merged: true } : {}), ...(order ? { mergeOrder: order } : {}), ...(dataProof ? { dataProof } : {}),
    // A03 (I9): a refusal with errors still names the warnings that block nothing, so one correction covers both.
    ...warningFields(taskWarnings(state)), ...tab, ...(continuation ? { continuation } : {}) };
}

// The kernel's mergeOrder receipt (Delivery.cs), short: the lost elements as "Element = value", the repair job, the
// delete rules the Studio forced to Ignore with the declaration for the job. Null when it names nothing.
function mergeOrderOf(order) {
  if (!order || typeof order !== 'object') return null;
  const missing = (Array.isArray(order.missing) ? order.missing : []).map(m => m?.element + ' = ' + m?.value);
  const forced = (Array.isArray(order.forcedDeleteRules) ? order.forcedDeleteRules : []).map(f => f?.element + ' (requested ' + f?.requested + ', kept Ignore)');
  if (!missing.length && !forced.length) return null;
  return { ...(missing.length ? { missing, repair: order.repair } : {}), ...(forced.length ? { forcedDeleteRules: forced, declare: order.declare } : {}) };
}

const safeName = name => String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
const stamp = date => date.toISOString().replace(/[-:.]/g, '');

// until=apply: the module's current state captured through the bridge, then `apply` on that capture. Nothing is merged.
async function applyOnly(input, job, ctx, task) {
  const lane = ctx.lane();
  const bridge = ctx.bridge();
  try {
    const opened = await bridge.ok('open_module', { name: input.module, ...(input.expectedEnvironment ? { environment: input.expectedEnvironment } : {}) });
    if (opened?.opened !== true && opened?.alreadyOpen !== true)
      return refusal('OPEN_BLOCKED', clean('open_module is blocked: ' + (opened?.hint ?? JSON.stringify(opened?.blockedBy ?? null))), doctor('Shows which Studio and dialogs hold the lane.'));
    const active = await bridge.ok('get_active_module');
    if (String(active?.name ?? '').toLowerCase() !== input.module.toLowerCase())
      return refusal('ACTIVE_MODULE_CHANGED', 'The active module is ' + (active?.name ?? 'none') + ', not ' + input.module + '; nothing was captured.', doctor('Shows the module open in the selected Studio.'));
    if (input.expectedEnvironment && String(active?.environment ?? '').toLowerCase() !== input.expectedEnvironment.trim().toLowerCase())
      return refusal('ENVIRONMENT_MISMATCH', 'The selected Studio is connected to ' + (active?.environment ?? 'no environment') + ', not ' + input.expectedEnvironment + '.', doctor('Shows the environment of the selected Studio.'));
    const snapshot = path.join(lane.local, 'snapshots', safeName(input.module) + '-' + stamp(ctx.now()) + '.oml');
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const captured = await bridge.ok('snapshot_module', { path: snapshot, ...(active?.key ? { module_key: active.key } : {}) });
    if (captured?.key && active?.key && captured.key !== active.key) return refusal('ACTIVE_MODULE_CHANGED', 'The active module changed during the snapshot; nothing was applied.', doctor('Shows the module open in the selected Studio.'));
    const folder = path.join(lane.work, 'apply', task.id);
    const run = await ctx.runAnvil(['apply', '--job', job, '--base', snapshot, '--out', path.join(folder, 'candidate.oml'), '--work', path.join(folder, 'model'),
      ...producerArgs(input.producers)], { timeoutMs: ctx.applyTimeoutMs });
    const data = run?.envelope?.data;
    if (run?.envelope?.ok === true && data?.isValid === true && data?.accepted === true) return { ok: true, valid: true };
    if (data && typeof data === 'object' && 'isValid' in data) {
      const { messages, omitted } = validationMessages({ apply: data });
      return { ok: false, valid: false, code: 'VALIDATION_REFUSED', stage: 'apply', error: 'Job rejected by the validation contract; nothing was merged.',
        ...(messages.length ? { messages } : {}), ...(omitted ? { messagesOmitted: omitted } : {}) };
    }
    const failedOp = failedOpOf(run?.envelope?.error, job);
    return refusal('APPLY_FAILED', clean(run?.envelope?.error ?? [...(run?.stderr ?? [])].slice(-3).join(' ')) || 'apply failed',
      doctor('Reports the O11 lane CLI and Studio; nothing was merged.'), { stage: 'apply', ...(failedOp != null ? { failedOp } : {}) });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const code = error?.code && /^BRIDGE_/.test(error.code) ? error.code : 'BRIDGE_ERROR';
    return refusal(code, clean(error.message), code === 'BRIDGE_NOT_LISTENING' ? connect('Attaches the open Service Studio of the O11 lane.') : doctor('Shows the O11 bridge and Studio state.'));
  }
}

// The module a delivery names, as the person sees it: a label with a space ("GameStore CS") reaches the module open in
// the selected Service Studio (GameStore_CS) when exactly one open module has the same letters and digits
// (studio-module.mjs); several are refused with the open modules. A name without a space is a module name and is passed
// on unread (o11_deliver opens a module of the environment by name), as is any name when the open modules cannot be read:
// the kernel's open_module then answers for it.
async function openModuleNamed(module, ctx) {
  if (!/\s/.test(module)) return { ok: true, module };
  let listed;
  try { listed = await ctx.bridge().ok('list_open_modules'); } catch { return { ok: true, module }; }
  const resolved = resolveOpenModule(module, { open: Array.isArray(listed?.modules) ? listed.modules : [], lane: 'o11' });
  if (resolved.ok) return resolved;
  return refusal(resolved.code, resolved.error, { tool: 'o11_deliver', arguments: { module: '<one of candidates>' },
    why: 'Repeat with the exact module name and the user\'s words in authorize.' }, { openModules: resolved.openModules, candidates: resolved.candidates });
}

// One tracked task with its journal lines: `start` (with the sha256 of the words) before anything runs, `end` after.
function tracked(ctx, lane, summary, words, fn) {
  const journal = entry => ctx.journal(lane.local, { tool: 'o11_deliver', ...entry });
  return trackTask({ tool: 'o11_deliver', summary, dir: ctx.tasks, now: ctx.now }, async task => {
    journal({ event: 'start', task: task.id, ...summary, wordsSha256: sha256(words) });
    const value = await fn(task);
    // A failed end line never changes what happened; the task file still records the outcome.
    try {
      journal({ event: 'end', task: task.id, outcome: value === CLOSED ? 'closed' : value.ok ? (summary.until === 'apply' ? 'valid' : 'delivered') : value.outcome ?? 'refused',
        ...(value.code ? { code: value.code } : {}), ...(value.stage ? { stage: value.stage } : {}), ...(value.taskId ? { kernelTaskId: value.taskId } : {}) });
    } catch { /* see above */ }
    return value;
  });
}

async function selected(ctx) {
  try { await ctx.assertSelected(); }
  catch (error) {
    // Hosted without the customer's O11 connection (executor.mjs): its own code and continuation.
    if (error?.code === 'O11_NOT_CONNECTED') throw new Refusal(error.code, clean(error.message), error.continuation);
    throw new Refusal('STUDIO_NOT_SELECTED', clean(error.message) || 'The selected Studio is not confirmed.', connect('Selects the Service Studio open on the O11 lane again.'));
  }
}

// close alone: `deliver --close` of a refused task, so the module takes a corrected job. Never an uncertain task.
async function closeTask(input, words, ctx, lane) {
  const extra = ['module', 'job', 'patch', 'basedOn', 'checks', 'producers', 'captureProducers', 'expectedEnvironment', 'resume', 'closePrevious'].filter(k => input[k] != null);
  if (extra.length || input.until === 'apply') throw new Refusal('CLOSE_ALONE', 'close takes only {taskId, reason} and authorize; drop ' + (extra.length ? extra.join(', ') : 'until=apply') + '.',
    { tool: 'o11_deliver', arguments: { close: input.close }, why: 'Close alone, then deliver; or deliver with closePrevious.' });
  const id = input.close.taskId;
  const state = findKernelTask(lane.work, { taskId: id });
  const refused = notClosable(id, state, input);
  if (refused) return refused;
  if (closeState(state) === 'closed') return CLOSED;
  if (!closesWithoutStudio(state)) await selected(ctx);
  return tracked(ctx, lane, { module: state.module ?? null, close: id }, words, async () =>
    closeOutcome(await ctx.runAnvil(closeArguments(id, input.close.reason, { work: lane.work, port: ctx.port() }), { timeoutMs: ctx.closeTimeoutMs }), id, lane.work));
}

// ---- C27: the producers a job binds by name. Every `reference` op names its producer binding; each one not bound in
// producers nor already captured is captured read-only by the delivery (System is the environment's "(System)").
export function referencedProducers(jobFile) {
  let document;
  try { document = JSON.parse(fs.readFileSync(jobFile, 'utf8').replace(/^﻿/, '')); } catch { return []; }
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  return [...new Set(ops.filter(op => op?.op === 'reference' && BINDING.test(String(op.producer ?? ''))).map(op => op.producer))];
}
export function autoCaptures(jobFile, input = {}) {
  const bound = new Set(Object.keys(input.producers ?? {}).map(n => n.toLowerCase()));
  const captured = new Set((input.captureProducers ?? []).map(entry => String(entry).split('=')[0].trim().toLowerCase()));
  return referencedProducers(jobFile).filter(name => !bound.has(name.toLowerCase()) && !captured.has(name.toLowerCase()))
    .map(name => name.toLowerCase() === 'system' ? name + '=(System)' : name);
}

// ---- C32: the published CSS of a block is regenerated only when a widget of the block changes, so a job made only of
// `set StyleSheet` on blocks (or themes) gets one touch: the Style of one widget of the first block, rewritten so it
// renders the same (`<Style> + ""`, or the suffix removed when a previous touch left it; an empty Style becomes `""`).
const BLOCK_TARGET = /^I(?:Mobile|Web)?Block:[^/]+$/;
const THEME_TARGET = /^I(?:Mobile|Web)?Theme:[^/]+$/;
export function styleSheetOnly(document) {
  const ops = Array.isArray(document) ? document : document && typeof document === 'object' && !document.jobs && Array.isArray(document.ops) ? document.ops : null;
  if (!ops?.length) return null;
  const targets = ops.map(op => op?.op === 'set' && op.prop === 'StyleSheet' && typeof op.target === 'string' ? op.target.trim() : null);
  if (targets.some(t => t == null || !(BLOCK_TARGET.test(t) || THEME_TARGET.test(t)))) return null;
  const blocks = [...new Set(targets.filter(t => BLOCK_TARGET.test(t)))];
  return blocks.length ? { blocks } : null;
}
export const touchValue = style => {
  const text = String(style ?? '').trim();
  if (!text) return '""';
  return text.endsWith(' + ""') ? text.slice(0, -5).trimEnd() || '""' : text + ' + ""';
};
// The widget the touch rewrites, from the reader's tree of the block: a container without Style first (nothing to keep),
// then the first widget with a Style; never the block itself.
export function touchWidget(tree) {
  const nodes = [];
  const walk = (node, depth) => { if (!node || typeof node !== 'object') return; if (depth > 0 && node.key) nodes.push(node); for (const child of node.children ?? []) walk(child, depth + 1); };
  walk(tree, 0);
  const styled = node => typeof node.properties?.Style === 'string' && node.properties.Style.trim() !== '';
  return nodes.find(n => /Container/i.test(String(n.kind ?? '')) && !styled(n)) ?? nodes.find(styled) ?? null;
}
// The methods an exposed REST service has today, for the contract rule of rest-expose (REST_EXPOSE_CONTRACT_WORDS): one
// read-only capture of the module and one read of the service; null when it cannot be read (the rule is then not judged).
async function exposedMethods(service, module, ctx, lane) {
  if (ctx.exposedMethods) return ctx.exposedMethods(service, module);
  if (!module) return null;
  try {
    const shot = await ctx.capture(module);
    if (shot?.ok !== true || typeof shot.path !== 'string') return null;
    const studioDir = ctx.connection()?.studioDir ?? lane.studioDir;
    const answer = await ctx.read({ name: 'o11', root: ctx.root, lane: lane.name, cli: lane.cli },
      inspectArguments({ path: 'IRestService:' + service, properties: 'HTTPMethod,URLPath', depth: 2, max: 500, full: true, budget: 200000 }, shot.path, studioDir));
    const data = answer?.data ?? answer;
    if (data?.ok === false || !data?.tree) return [];
    return (data.tree.children ?? []).filter(c => /RestServiceAction$/.test(String(c?.kind ?? ''))).map(c => ({ name: c.name, http: c.properties?.HTTPMethod ?? 'GET', path: c.properties?.URLPath ?? '/' + c.name }));
  } catch { return null; }
}

async function styleSheetTouch(resolved, input, ctx, lane) {
  let document;
  try { document = JSON.parse(fs.readFileSync(resolved.path, 'utf8').replace(/^﻿/, '')); } catch { return null; }
  const only = styleSheetOnly(document);
  if (!only) return null;
  const block = only.blocks[0];
  try {
    const shot = await ctx.capture(input.module);
    if (shot?.ok !== true || typeof shot.path !== 'string') return null;
    const studioDir = ctx.connection()?.studioDir ?? lane.studioDir;
    const answer = await ctx.read({ name: 'o11', root: ctx.root, lane: lane.name, cli: lane.cli },
      inspectArguments({ path: block, properties: 'Style', depth: 12, max: 500, full: true, budget: 200000 }, shot.path, studioDir));
    const widget = touchWidget((answer?.data ?? answer)?.tree);
    if (!widget) return null;
    const op = { op: 'set', target: '@' + widget.key, prop: 'Style', value: touchValue(widget.properties?.Style) };
    const ops = [...(Array.isArray(document) ? document : document.ops), op];
    const touched = Array.isArray(document) ? ops : { ...document, ops };
    const file = path.join(lane.local, 'jobs', 'inline', randomUUID() + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(touched, null, 2);
    fs.writeFileSync(file, text);
    return { resolved: { ...resolved, path: file, sha256: sha256(text) },
      touch: { target: block + '/' + (widget.name || '@' + widget.key), op } };
  } catch { return null; } // no reader or no capture here: the job is delivered as written
}

// ---- C08: the publication after a clean merge (o11-publish.mjs createO11Publish; loaded on demand, it imports this file).
const publishContinuation = module => ({ tool: 'o11_publish', arguments: { module, authorize: WORDS_MARKER },
  why: 'A entrega já está no Studio; publique só o módulo (nunca repita a entrega). authorize: as palavras do usuário no lugar do marcador.' });
// Pure: the section 3.2 PublishOutcome of an o11_publish answer.
export function publishField(value) {
  const outcome = value?.ok === true ? 'published' : value?.outcome === 'uncertain' ? 'uncertain' : value?.outcome === 'failed' || value?.code === 'PUBLISH_FAILED' ? 'failed' : 'refused';
  const messages = Array.isArray(value?.messages) ? [...value.messages].sort((a, b) => (b?.type === 'Error') - (a?.type === 'Error')).slice(0, 10) : null;
  return { requested: true, outcome, ...(value?.ok === true ? {} : { code: value?.code ?? 'PUBLISH_FAILED', error: clean(value?.error ?? 'The publication did not run.', 300) }),
    ...(value?.version != null ? { version: value.version } : {}), ...(value?.lastPublication?.at ? { at: value.lastPublication.at } : {}),
    ...(messages?.length ? { messages } : {}), ...(Array.isArray(value?.dialogsSeen) && value.dialogsSeen.length ? { dialogsSeen: value.dialogsSeen } : {}),
    ...(Array.isArray(value?.consumers) ? { consumers: value.consumers } : {}) };
}
async function publishAfter(delivered, input, { words, authorization }, ctx, signal) {
  const run = await ctx.publisher();
  // The same words cover the publication; a standing grant must cover publish itself (o11-publish looks it up).
  const value = await run({ module: input.module, ...(authorization?.source === 'standing-grant' ? {} : { authorize: words }),
    ...(input.expectedEnvironment ? { expectedEnvironment: input.expectedEnvironment.trim().toLowerCase() } : {}) }, { signal });
  const publish = publishField(value);
  const base = { ...delivered, ...(value?.lastPublication ? { lastPublication: value.lastPublication } : {}) };
  if (value?.ok === true) return { ...base, ok: true, result: 'entregue e publicado', publish };
  return { ...base, ok: false, result: 'entregue', code: publish.code ?? (publish.outcome === 'uncertain' ? 'PUBLISH_UNCERTAIN' : 'PUBLISH_FAILED'), failed: 'publish',
    ...(publish.outcome === 'uncertain' ? { outcome: 'uncertain' } : {}), publish, continuation: publishContinuation(input.module) };
}

// K1-g: after a publication, the tab the delivery opened (its kernel task's open answered alreadyOpen false) is closed
// through the bridge's close_module, whose own guard keeps a tab with unsaved changes or a dialog. Undefined when the
// delivery did not open the tab.
export async function closeOpenedTab(module, state, ctx) {
  if (state?.open?.alreadyOpen !== false || !module) return undefined;
  try {
    const closed = await ctx.bridge().ok('close_module', { name: module, ...(state.moduleKey ? { module_key: state.moduleKey } : {}),
      ...(state.environment ? { environment: state.environment } : {}) });
    return closed?.closed === true ? true : { closed: false, reason: clean(closed?.error ?? closed?.hint ?? 'the Studio kept the tab', 200) };
  } catch (error) {
    // UI freeze of 2026-10-08: the tab still finishing the publication (MODULE_BUSY) or a UI thread that did not answer
    // (UI_BUSY) keeps the tab; nothing was closed and the delivery's answer stands. The tab is closed later, when idle.
    const busy = ['MODULE_BUSY', 'UI_BUSY'].includes(error?.code) ? { code: error.code,
      next: { tool: 'o11_studio', arguments: { command: 'close-module', args: { name: module } }, why: 'depois de o11_studio wait idle; a aba ainda termina o trabalho da publicação' } } : {};
    return { closed: false, reason: clean(error?.message ?? String(error), 200), ...busy };
  }
}
// K1-d: whether the job references a theme of this producer binding (a signature never imports a theme).
const THEME_ELEMENT = /^I(?:Mobile|Web)?Theme(?:Signature)?:/i;
export function themeReferenced(jobFile, binding) {
  let document;
  try { document = JSON.parse(fs.readFileSync(jobFile, 'utf8').replace(/^﻿/, '')); } catch { return false; }
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  return ops.some(op => op?.op === 'reference' && String(op.producer ?? '').toLowerCase() === String(binding).toLowerCase()
    && (Array.isArray(op.elements) ? op.elements : []).some(e => THEME_ELEMENT.test(String(e))));
}

async function deliver(input, ctx, { signal } = {}) {
  const lane = ctx.lane();
  // The words: the user's, or a standing grant that covers this module for deliver (contract I6).
  const taskModule = !input.module && (input.resume || input.close?.taskId) ? findKernelTask(lane.work, { taskId: input.resume ?? input.close.taskId })?.module ?? null : null;
  const grantModule = input.module ?? taskModule;
  const resolvedWords = standingGrants.wordsFor({ authorize: input.authorize, lane: 'o11', module: grantModule, app: grantModule ? ctx.appOf(grantModule) : null, verb: 'deliver' },
    ctx.grants, { file: ctx.grantsFile });
  const words = resolvedWords.words;
  const authorization = resolvedWords.authorization ?? null;
  // Blank words, or a placeholder such as the continuation marker, are not the user's words.
  if (!words.trim() || /^<[^>]*>$/.test(words.trim())) return refusal('WORDS_REQUIRED', 'o11_deliver needs the user\'s own words in authorize, verbatim (or a standing grant of this module for deliver).',
    { tool: 'o11_deliver', arguments: input.close ? { close: input.close } : input.resume ? { resume: input.resume } : { module: input.module }, why: 'Ask the user to authorize this delivery and pass their exact words in authorize.' });
  const answer = await deliverWith(input, { words, authorization }, ctx, lane, signal);
  return authorization && answer && typeof answer === 'object' ? { ...answer, authorization } : answer;
}

async function deliverWith(input, { words, authorization }, ctx, lane, signal) {
  const until = input.until ?? 'merge';
  let resolved = null; // the job file this call runs {path, sha256}, named by its refusals
  try {
    if (input.close) return await closeTask(input, words, ctx, lane);
    if (input.publish === true && until === 'apply')
      throw new Refusal('PUBLISH_NEEDS_MERGE', 'publish:true publishes right after a clean merge; until=apply merges nothing. Drop until (deliver and publish) or drop publish.');
    if (input.closePrevious && (input.resume || until === 'apply'))
      throw new Refusal('CLOSE_PREVIOUS_FIXED', 'closePrevious goes with a new delivery (module and job, until=merge), never with ' + (input.resume ? 'resume' : 'until=apply') + '.');
    if (input.resume) {
      const replaced = ['job', 'patch', 'basedOn', 'checks', 'producers', 'captureProducers'].filter(k => input[k] != null);
      if (replaced.length || until === 'apply') throw new Refusal('RESUME_FIXED', 'A resumed delivery keeps its own job, checks and producers and always merges; drop ' + (replaced.length ? replaced.join(', ') : 'until=apply') + '.',
        resumeWith(input.resume));
      const recorded = findKernelTask(lane.work, { taskId: input.resume });
      if (input.module && recorded?.module && recorded.module.toLowerCase() !== input.module.toLowerCase())
        throw new Refusal('RESUME_MODULE_MISMATCH', 'Task ' + input.resume + ' belongs to module ' + recorded.module + ', not ' + input.module + '.', resumeWith(input.resume));
      const own = recorded?.request?.JobPath ?? recorded?.request?.jobPath;
      if (typeof own === 'string' && isFile(own)) resolved = { path: path.resolve(own), sha256: sha256(fs.readFileSync(own)) };
    } else {
      if (input.patch != null || input.basedOn != null) {
        const checked = patchInput(input, lane);
        if (checked.ok === false) return checked;
        input = checked;
      }
      if (!input.module || (input.job == null && input.patch == null))
        throw new Refusal('MODULE_AND_JOB_REQUIRED', 'o11_deliver needs module and job, or module with patch and basedOn (or resume with the taskId of an earlier delivery).');
      // K1-d: producers "published" alone: every producer the job references is "published" (bound once the job is read).
      if (input.producers === PUBLISHED) { const { producers: _all, ...rest } = input; input = { ...rest, allPublished: true }; }
      producerArgs(input.producers, input.captureProducers);
      if (until === 'apply' && input.captureProducers?.length) throw new Refusal('CAPTURE_NEEDS_DELIVER', 'until=apply binds producer files only; capture the producer first and pass it in producers.',
        { tool: 'o11_dependencies', arguments: { action: 'capture', producer: String(input.captureProducers[0]).split('=').at(-1) }, why: 'Captures an attested .avsig of the producer for the producers binding.' });
    }
    // closePrevious: only a refused task is closed; an uncertain one stops here with resume, before the Studio is touched.
    // One already closed, or one that never reached the module (no moduleKey: nothing reserved), needs no close.
    let closing = null;
    if (input.closePrevious) {
      const previous = findKernelTask(lane.work, { taskId: input.closePrevious });
      const refused = notClosable(input.closePrevious, previous, input);
      if (refused) return refused;
      if (closeState(previous) === 'refused' && previous.moduleKey) closing = input.closePrevious;
    }
    if (!input.resume) resolved = resolveJob(input, lane);
    // K1-d: a "published" producer whose theme the job references is bound by its published OML (a signature never imports
    // a theme, cause theme), downloaded once per version (o11_environment cache, K1-c); the others are captured by the kernel.
    if (!input.resume && input.allPublished) {
      const { allPublished: _all, ...rest } = input;
      const referenced = referencedProducers(resolved.path).filter(name => !(rest.captureProducers ?? []).some(c => String(c).split('=')[0].trim().toLowerCase() === name.toLowerCase()));
      input = { ...rest, ...(referenced.length ? { producers: Object.fromEntries(referenced.map(name => [name, PUBLISHED])) } : {}) };
    }
    if (!input.resume && input.producers && typeof input.producers === 'object') {
      const producers = { ...input.producers };
      for (const [name, value] of Object.entries(producers)) {
        if (value !== PUBLISHED || !themeReferenced(resolved.path, name)) continue;
        const downloaded = await ctx.downloadPublished(name);
        if (downloaded?.ok !== true || typeof downloaded.file !== 'string')
          return withJob({ ...refusal(downloaded?.code ?? 'DOWNLOAD_FAILED', clean('The published OML of ' + name + ' (its theme is referenced) was not downloaded: ' + (downloaded?.error ?? 'no file')),
            downloaded?.continuation ?? doctor('Shows the O11 lane and its Studio.')), stage: 'producers' }, resolved);
        producers[name] = downloaded.file;
      }
      input = { ...input, producers };
      if (until === 'apply' && Object.values(producers).includes(PUBLISHED))
        throw new Refusal('CAPTURE_NEEDS_DELIVER', 'until=apply binds producer files only; a "published" producer is captured by a delivery.',
          { tool: 'o11_dependencies', arguments: { action: 'capture', producer: Object.keys(producers).find(k => producers[k] === PUBLISHED) }, why: 'Captures an attested .avsig of the producer for the producers binding.' });
    }
    // Integration ops (rest, rest-expose, soap; docs/integracoes-rest-soap.md): their documents are pinned and the
    // destructive words checked (a standing grant never covers a delete) before anything is captured or sent.
    if (!input.resume) {
      const prepared = await ctx.prepareIntegration(resolved.path, { lane: 'o11', words, grant: authorization?.source === 'standing-grant', localRoot: lane.local,
        exposed: service => exposedMethods(service, input.module, ctx, lane) });
      if (prepared?.ok === false) return withJob({ ...prepared, outcome: 'refused', stage: 'documents', failed: 'documents' }, resolved);
      if (prepared?.changed) resolved = { ...resolved, path: prepared.job, sha256: sha256(fs.readFileSync(prepared.job)) };
    }
    await selected(ctx);
    if (!input.resume && input.module) {
      const named = await openModuleNamed(input.module, ctx);
      if (named.ok === false) return withJob(named, resolved);
      input = { ...input, module: named.module };
    }
    // C27: the producers the job references by name are captured read-only, as the ODC lane does.
    const autoCaptured = !input.resume && until === 'merge' ? autoCaptures(resolved.path, input) : [];
    if (autoCaptured.length) input = { ...input, captureProducers: [...(input.captureProducers ?? []), ...autoCaptured] };
    // C32: only StyleSheet sets on blocks: one touch of a block widget, in a new job file next to the inline jobs.
    let touch = null;
    if (!input.resume && until === 'merge') {
      const touched = await styleSheetTouch(resolved, input, ctx, lane);
      if (touched) { resolved = touched.resolved; touch = touched.touch; }
    }
    const job = input.resume ? null : resolved.path;
    const jobSha256 = job ? resolved.sha256 : null;
    // The provenance of a patched job goes to the journal (and the task summary), never into the job file.
    const summary = { module: input.module ?? null, until, ...(job ? { job, jobSha256 } : {}), ...(input.resume ? { resume: input.resume } : {}),
      ...(input.closePrevious ? { closePrevious: input.closePrevious } : {}), ...(resolved?.basedOn ? { basedOn: resolved.basedOn, patchOps: input.patch.length } : {}),
      ...(autoCaptured.length ? { autoCaptured } : {}), ...(touch ? { touch: touch.target } : {}), ...(input.publish === true && until === 'merge' ? { publish: true } : {}) };
    let kernelState = null; // the kernel task of this delivery (its open answer decides the tab closed after a publication)
    let value = withJob(await tracked(ctx, lane, summary, words, async task => {
      if (until === 'apply') return applyOnly(input, job, ctx, task);
      const port = ctx.port();
      if (closing) { // the new delivery runs only once the previous task is closed
        const closed = closeOutcome(await ctx.runAnvil(closeArguments(closing, SUPERSEDED, { work: lane.work, port }), { timeoutMs: ctx.closeTimeoutMs }), closing, lane.work);
        if (closed !== CLOSED) return closed;
      }
      const since = Date.now();
      // Lane wp: the build phase (capture by key, kernel apply in the build pool) before the Studio is taken; a job the
      // kernel refuses on the live module is answered from it, an accepted candidate goes to deliver as --prebuilt.
      const built = await buildBeforeApply({ input, job, ctx, lane, task, signal });
      if (built?.answer) return built.answer;
      if (built?.refused) return deliverOutcome(built.refused, { trackId: task.id, work: lane.work, job, taskId: null, since, input });
      const run = await ctx.runAnvil([...deliverArguments({ ...input, job }, { work: lane.work, port }), ...(built?.args ?? [])], { timeoutMs: ctx.deliverTimeoutMs });
      kernelState = run?.envelope?.data && typeof run.envelope.data === 'object' ? run.envelope.data : null;
      afterApply(run, built, lane);
      return deliverOutcome(run, { trackId: task.id, work: lane.work, job, taskId: input.resume, since, input });
    }), resolved);
    if (until !== 'merge' || value === CLOSED) return value;
    const module = input.module ?? findKernelTask(lane.work, { taskId: input.resume })?.module ?? null;
    if (touch) value = { ...value, touch };
    if (input.publish === true) {
      // C08: only after a clean merge; otherwise the publication is skipped and the answer says so.
      if (value?.ok !== true) value = { ...value, publish: { requested: true, outcome: 'skipped' } };
      else {
        value = await publishAfter(value, { ...input, module }, { words, authorization }, ctx, signal);
        // K1-g: the tab this delivery opened is closed once the publication saved the module.
        if (value?.ok === true) { const closedTab = await closeOpenedTab(module, kernelState, ctx); if (closedTab !== undefined) value = { ...value, closedTab }; }
      }
    } else if (value?.ok === true && module) {
      const last = await ctx.lastPublication(module);
      if (last) value = { ...value, lastPublication: last };
    }
    return value;
  } catch (error) {
    if (error instanceof Refusal) return withJob(refusal(error.code, error.message, error.continuation
      ?? { tool: 'o11_deliver', arguments: input.module ? { module: input.module } : {}, why: 'Call again with the arguments fixed as the error says, and the user\'s words in authorize.' }, error.extra), resolved);
    throw error;
  }
}

function appendJournal(now) {
  return (local, entry) => {
    const dir = path.join(local, 'journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'o11_deliver.jsonl'), JSON.stringify({ at: now().toISOString(), ...entry }) + '\n');
  };
}

// ssam_task {id, close} (C15): `deliver --close` of the kernel task. A refused task closes as with o11_deliver {close}; an
// uncertain one only with the kernel's hash proof (DeliveryTask.CloseKnownFailure: the live module equals the task's base),
// never when the live module differs. A delivered task has nothing to close.
async function closeWithProof(id, reason, ctx) {
  const lane = ctx.lane();
  const state = findKernelTask(lane.work, { taskId: id });
  const kind = closeState(state);
  if (kind === 'missing') return refusal('CLOSE_TASK_NOT_FOUND', 'No delivery task ' + id + ' in the lane work folder.', { tool: 'ssam_task', arguments: {}, why: 'Lists the recent tasks and their kernel taskId.' }, { taskId: id });
  if (kind === 'delivered') return refusal('PREVIOUS_NOT_REFUSED', 'Task ' + id + ' was delivered; there is nothing to close.', null, { taskId: id });
  if (kind === 'closed') return { ...CLOSED, taskId: id };
  if (!closesWithoutStudio(state)) {
    try { await selected(ctx); } catch (error) { if (error instanceof Refusal) return refusal(error.code, error.message, error.continuation); throw error; }
  }
  const value = closeOutcome(await ctx.runAnvil(closeArguments(id, reason, { work: lane.work, port: ctx.port() }), { timeoutMs: ctx.closeTimeoutMs }), id, lane.work);
  if (value !== CLOSED) return kind === 'uncertain' ? { ...value, outcome: 'uncertain', code: 'CLOSE_PROOF_REFUSED',
    continuation: resumeWith(id) } : value;
  return { ...CLOSED, taskId: id, ...(kind === 'uncertain' ? { proof: 'the live module equals the task base: nothing was applied' } : {}) };
}

// deps: root, env, lane, now, read (kernelReading), readerCheck, runAnvil, bridge, assertSelected, tasksDir, deliverTimeoutMs,
// applyTimeoutMs, closeTimeoutMs, registerTask (false when ssam_task is registered elsewhere), grants (standing-grants.mjs
// API), grantsFile, inventory({host}) for the app of a module, publish (run(input, {signal}) of o11_publish, default
// createO11Publish over the same deps), lock (studio-write-lock deps of the open an o11_inspect {module} capture may need).
export function registerO11Cycle(server, deps = {}) {
  const root = deps.root ?? anvilRoot;
  const env = deps.env ?? process.env;
  const laneName = deps.lane ?? o11Lane.lane;
  const now = deps.now ?? (() => new Date());
  const connection = () => { try { return readConnection(root, laneName); } catch { return null; } };
  const ctx = {
    root, env, now, connection,
    lane: () => o11LaneOf(laneName, { root, env }),
    read: deps.read ?? kernelReading,
    readerCheck: deps.readerCheck ?? (deps.read ? null : readerMissing),
    runAnvil: deps.runAnvil ?? createAnvilRunner({ lane: laneName, root, env }),
    bridge: () => deps.bridge ?? o11Bridge(bridgeTarget({ lane: laneName, root, env })),
    assertSelected: deps.assertSelected ?? assertSelectedO11,
    // The o11_studio snapshot of a module (open/select, then snapshot_module), for the steps of a delivery, which already
    // holds the Studio write lock.
    capture: deps.capture ?? (module => o11Studio({ bridge: () => deps.bridge ?? o11Bridge(bridgeTarget({ lane: laneName, root, env })),
      assertSelected: deps.assertSelected ?? assertSelectedO11, lane: laneName, root, env })({ command: 'snapshot', args: { module } })),
    // o11_inspect {module}, a read: a module open in a tab captured by its key without the write lock; one that must be
    // opened first, under it (module-map.mjs captureO11Module, the same capture as ssam_map).
    captureRead: deps.capture ?? (async module => (await import('./module-map.mjs')).captureO11Module(module, { tool: 'o11_inspect', env, lane: laneName, root,
      bridge: () => deps.bridge ?? o11Bridge(bridgeTarget({ lane: laneName, root, env })), assertSelected: deps.assertSelected ?? assertSelectedO11,
      lockDeps: { o11Root: root, o11Lane: laneName, ...(deps.lock ?? {}) } })),
    port: () => { const record = connection(); return Number.isInteger(record?.port) ? record.port : o11LaneOf(laneName, { root, env }).bridge; },
    // K1-d: the published OML of a producer (o11_environment download, one download per version, K1-c).
    downloadPublished: deps.downloadPublished ?? (async module => (await import('./o11-environment.mjs')).downloadModule({ module }, { root, lane: laneName, env })),
    tasks: deps.tasksDir ?? tasksDir(root),
    journal: deps.journal ?? appendJournal(now),
    deliverTimeoutMs: deps.deliverTimeoutMs ?? 3600000, applyTimeoutMs: deps.applyTimeoutMs ?? 900000, closeTimeoutMs: deps.closeTimeoutMs ?? 900000,
    // Lane wp: the build pool (build-pool.mjs sharedBuildPool when absent), the runner of a slot (its resident worker),
    // and the customer whose builds share the pool fairly (else SSAM_CUSTOMER, else the lane root).
    buildPool: deps.buildPool ?? null, buildRunner: deps.buildRunner ?? null, customer: deps.customer ?? null,
    grants: deps.grants ?? standingGrants, grantsFile: deps.grantsFile,
    // Integration documents and destructive words (integration-documents.mjs, I6); exposedMethods(service, module) may
    // replace the capture-and-read of the current exposed methods.
    prepareIntegration: deps.prepareIntegrationJob ?? prepareIntegrationJob, exposedMethods: deps.exposedMethods ?? null,
    // The application of a module (for a grant given per app): the environment inventory o11_environment keeps.
    appOf: module => { try { return ctx.inventory()?.modules?.find(m => m.name && module && m.name.toLowerCase() === String(module).toLowerCase())?.app ?? null; } catch { return null; } },
    // The newest o11_environment inventory of the lane (o11-studio.mjs readInventory), cached per file there.
    inventory: deps.inventory ?? (() => readInventory({ local: o11LaneOf(laneName, { root, env }).local })),
    // o11_publish after a clean merge (publish:true): the same runner as the tool, loaded on demand.
    publisher: async () => deps.publish ?? (await import('./o11-publish.mjs')).createO11Publish({ root, env, lane: laneName, now,
      bridge: () => ctx.bridge(), assertSelected: ctx.assertSelected, tasksDir: ctx.tasks, grants: ctx.grants, grantsFile: ctx.grantsFile,
      ...(deps.inventory ? { inventory: deps.inventory } : {}) }),
    // The last publication of a delivered module (section 3.2), read once from the Studio's publish messages; omitted when unknown.
    lastPublication: deps.lastPublication ?? (async module => {
      try { return lastPublicationOf(await ctx.bridge().ok('publish_log', { module, max: 1 }, { timeoutMs: 5000 })); } catch { return null; }
    }),
  };
  // Lane wp: in a phased delivery every Studio access of this context takes the Studio first (o11-build-phase.mjs).
  phaseGuards(ctx);
  const guard = fn => async (input, extra) => {
    try { const value = await fn(input ?? {}, { signal: extra?.signal }); return value === DELIVERED || value === CLOSED ? reply(value, value.result) : reply(value); }
    catch (error) { return reply({ ok: false, ...seamFields(error), error: clean(error.message) }); }
  };

  server.registerTool('o11_inspect', {
    title: 'Read the structure of an O11 capture',
    description: 'Read-only, headless: the resident O11 reader over a capture .oml, reused while its SHA-256 is unchanged. '
      + 'module (instead of oml) captures the module open in the selected Service Studio and reads it in this call; the answer\'s '
      + 'capture {oml, sha256} serves the next reads. '
      + 'Start with ssam_map {lane:"o11", target} for every element and its @key; use this for subtrees, properties and usages by path "@<key>" with '
      + 'expectedSourceSha256. Without path: the module map. Large answers return summary/navigation and the complete JSON in out.',
    inputSchema: inspectSchema, annotations: readOnly,
  }, guard(input => inspect(input, ctx)));

  server.registerTool('o11_deliver', {
    title: 'Deliver an O11 job to the selected Service Studio',
    description: 'Delivers a job to the module open in the Service Studio selected on the O11 lane: deliver directly, with no separate proof (o11_job/ssam_job) '
      + 'or until=apply step first. It captures the module as it is now in the Studio, validates the candidate headless (TrueChange) '
      + 'before the native merge, merges once, then checks the new messages and the named checks. '
      + 'Delivered: "entregue" (plus leftovers, warnings, screenRoles and lastPublication when there is something to say; only errors and security warnings refuse). '
      + 'A refused job comes back ONCE, before any Studio write, with every problem of every phase over the live module (the job alone, the base, the apply, the Verify of '
      + 'the candidate): problems[] with phase, op, pointer, code, message, fix and the patch of each certain fix (identical ones grouped with their pointers), verifyRan, '
      + 'stage, taskId, job and jobSha256 (failedOp when the kernel names the op); nothing is delivered. Correct all of them in ONE call: patch (the patches returned plus '
      + 'your fixes) and basedOn {job, sha256} (or {taskId}) instead of the whole job. '
      + 'outcome "uncertain" is never repeated: follow continuation (resume reconciles the same task). A refused task that still holds the '
      + 'module: deliver the corrected job with closePrevious, or close {taskId, reason} alone ("fechada"); an uncertain task is never closed '
      + 'here (ssam_task {id, close} closes it only with the proof that nothing was applied). '
      + 'publish:true publishes the same module right after a clean merge (the o11_publish flow, same words or grant): "entregue e publicado"; '
      + 'a failed publication answers result "entregue" with PUBLISH_FAILED|PUBLISH_UNCERTAIN and the o11_publish continuation, never a new delivery. '
      + 'Without publish nothing is published. Without authorize a standing grant (ssam_grant) of the module for deliver is used. Producers named by '
      + 'reference ops are captured read-only by name. Blocks until the CLI ends; ssam_task reads the task meanwhile.',
    inputSchema: deliverSchema, annotations: mutating,
    // Lane wp: this handler splits its delivery in build and apply (o11-build-phase.mjs; studio-write-lock.mjs PHASES_META).
    _meta: { [PHASES_META]: true },
  }, guard((input, options) => deliver(input, ctx, options)));

  if (deps.registerTask !== false) registerSsamTask(server, { root, tasksDir: ctx.tasks, close: (id, reason) => closeWithProof(id, reason, ctx) });
}

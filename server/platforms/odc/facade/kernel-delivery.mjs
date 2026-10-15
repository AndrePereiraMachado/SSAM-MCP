import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { entityActionsOf } from './entity-actions.mjs';
import { promisify } from 'node:util';
import { anvilRoot, odcRoot } from './workspace.mjs';
import { hostedContext, hostedSpawnEnv } from './executor.mjs';
import { catalogKind } from './studio-module.mjs';
import { warningsFromVerdicts, highWarningsOf, HIGH } from './delivery-warnings.mjs';
import { diagnosisOf, refusalFields, normalizationsOf } from './refusal-problems.mjs';
import * as writeLock from './studio-write-lock.mjs';
import { jobSummary } from './job-summary.mjs';
// The prototype importer (docs/PROTOTIPO-NATIVO.md, lane surface): the capture before the Studio, the rebuild of 1.4.1,
// the receipt after the build and the seed after a clean publication.
import { hasPrototypeOps, expandJobFile, capturePrototype, buildWithDegradation, buildProblems, journalTo, kernelPrototypeReport, findNativeDom,
  measurePrototypeFidelity, prototypeReceipt, receiptWithSeed, bindingCorrection, readJobDocument } from './prototype-op.mjs';
import { seedPrototypeData, odcDataWriter } from './prototype-seed.mjs';
import { prototypeAppUrl, prototypeScreenLinks } from './next-steps.mjs';
import { kernelStart } from './quality-meter.mjs';
import { removedOf } from './ssam-code.mjs';
// F5, the family rule of producer signatures (producer-signatures.mjs): reference snapshots reused by revision.
import { reuseOdcReference, rememberOdcReference, forgetOdcReference, recordPublished, recordPublicationEnded, publicationOpen } from './producer-signatures.mjs';

const exec = promisify(execFile);
// Quality (docs/QUALIDADE.md): a cold `dotnet anvil-odc.dll` is a kernel leaf (the worker request is one in anvil-worker.mjs).
// run() resolves {exitCode, ...}; a no-op outside a hosted call.
async function coldKernel(run) {
  const end = kernelStart({ lane: 'odc', via: 'cold' });
  let ok = false;
  try { const response = await run(); ok = response?.exitCode === 0; return response; }
  finally { end({ ok }); }
}
const steps = ['snapshot', 'build', 'check-base', 'preview', 'merge'];
export const kernelCli = () => path.join(anvilRoot, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
export const requiredFlowLayoutEngine = 'anvil-d4d8ece';
export const hasCurrentFlowLayout = result => result?.data?.flowLayoutEngine === requiredFlowLayoutEngine;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The Studio steps after the build, by `until`. A delivery (until=merge) goes straight to the merge: the bridge's merge
// command proves the base itself (StartupHook.cs Run: the open module equals the capture, else base_drift) and the
// preview's conditions (no conflicts, not empty) before CompareAndMerge, so check-base and preview would only repeat it.
// They stay for a review the person asks for (until=check-base|preview).
export const studioSteps = until => until === 'merge' ? ['merge'] : until === 'preview' ? ['check-base', 'preview'] : until === 'check-base' ? ['check-base'] : [];

// A .NET stack trace never reaches an answer: the lines of its frames are cut, the exception type prefix too. The full
// text stays in the evidence (kernel-result.json, last-error.json).
export function withoutStack(text) {
  if (typeof text !== 'string') return text;
  const lines = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s+at\s+\S/.test(line) || /^\s*--- End of (inner exception )?stack trace/.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n').trimEnd().replace(/^System\.(?:[A-Za-z]+\.)*[A-Za-z]*Exception: /, '');
}
const clipLine = text => { const line = String(withoutStack(text) ?? 'no answer').split('\n')[0]; return line.length > 300 ? line.slice(0, 297) + '...' : line; };
const sanitized = value => {
  if (!isObject(value)) return value;
  const { stack, stdout, stderr, ...rest } = value;
  return { ...rest, ...(typeof rest.error === 'string' ? { error: withoutStack(rest.error) } : {}) };
};

// Section 3 fields read from the kernel result (pure). I4: an html op in page mode reports its screen's roles (K5).
export function screenRolesOf(results) {
  return (Array.isArray(results) ? results : []).filter(r => r?.op === 'html' && Array.isArray(r?.result?.roles))
    .map(r => ({ screen: r.result.screen, mode: r.result.mode, roles: r.result.roles, anonymous: r.result.anonymous === true }));
}
// K2 (expectations matched) and K1 (Unused* warnings the allowlist let pass on elements the job created).
export function leftoversOf(validation) {
  const matched = (Array.isArray(validation?.matched) ? validation.matched : [])
    .map(m => ({ id: m.id, element: m.element ?? null, why: typeof m.why === 'string' ? m.why : null, source: 'expectedMessages' }));
  const allowed = (Array.isArray(validation?.verdicts) ? validation.verdicts : []).filter(v => v?.verdict === 'allowlisted' && /^Unused/.test(String(v.id ?? '')))
    .map(v => ({ id: v.id, element: v.path ?? v.key ?? null, why: typeof v.reason === 'string' ? v.reason : null, source: 'allowlist' }));
  return [...matched, ...allowed];
}
// A03 (I9): the new warnings the kernel judged non-blocking, each {id, path, key?, detail, fix} (delivery-warnings.mjs).
export function warningsOf(validation, options = {}) {
  return warningsFromVerdicts(validation?.verdicts, options);
}
// A list of a delivery answer: at most `max` entries, plus the total when cut.
const capped = (report, field, list, max = 20) => {
  if (!list.length) return;
  report[field] = list.slice(0, max);
  if (list.length > max) report[field + 'Total'] = list.length;
};

// The kernel CLI's answer, as the delivery reads it: accepted and valid, or the refusal with its code and problems (I2).
export function interpretKernelResult(result, { output, exitCode = 0 }) {
  const candidate = path.join(output, 'kernel-candidate.oml');
  const receipt = path.join(output, 'kernel-result.json');
  // A stale CLI is not rebuilt by the session: the refusal says so and points to the tool that reports the lane.
  if (result.ok === true && !hasCurrentFlowLayout(result)) return { ok: false, code: 'COMPONENT_STALE', receipt,
    error: `ODC authoring CLI does not confirm layout ${requiredFlowLayoutEngine}: it is older than the facade; the integrator or the user rebuilds it before delivery.`,
    continuation: { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'componente não compilado: o integrador/usuário compila' } };
  // expectValid=false is useful in negative tests, but never authorizes delivery of an invalid candidate.
  // A lab that builds a consumed SOAP service by verbs (allowSoapWithoutImport, kernel CompileCheck) is never delivered either.
  const lab = (Array.isArray(result.data?.highWarnings) ? result.data.highWarnings : []).find(w => w?.code === 'COMPILE_SOAP_DEFINITION_ALLOWED');
  const ok = exitCode === 0 && result.ok === true && result.data?.accepted === true && result.data?.isValid === true && !lab;
  return { ok, candidate, receipt,
    ...(ok ? {} : { error: lab ? `The job builds a consumed SOAP service by verbs under the lab escape allowSoapWithoutImport (${lab.message ?? ''}); a lab is never delivered.`
        : withoutStack(result.error) ?? 'Kernel candidate must be accepted and valid before delivery.', diagnostics: result.data?.policyMessages,
      ...(lab ? { code: 'COMPILE_SOAP_DEFINITION' } : typeof result.code === 'string' ? { code: result.code } : {}),
      // primeira-certa A3: every problem (a candidate only the Verify refused carries them in data), whether the Verify ran
      // before the refusal, why not, and the phases of its problems.
      ...(Array.isArray(result.problems) ? { problems: result.problems } : Array.isArray(result.data?.problems) ? { problems: result.data.problems } : {}),
      ...diagnosisOf(Array.isArray(result.problems) ? result : result.data ?? result) }),
    validation: result.data?.validation, screenRoles: screenRolesOf(result.data?.results), leftovers: leftoversOf(result.data?.validation),
    // lentidao 2026-10-12: what the kernel rewrote in the job instead of refusing it (JobNormalizer), on an accepted candidate.
    ...(ok ? normalizationsOf(result.data) : {}),
    // ssam_code: what an action text or a screen edit removed, never silent.
    removed: removedOf(result.data?.results),
    // The HIGH warnings of the data-access rules (kernel highWarnings) first, then the Verify ones.
    warnings: [...highWarningsOf(result.data?.highWarnings), ...warningsOf(result.data?.validation)],
    // I7: what each integration op (rest, rest-expose, soap) imported, updated and removed.
    ...(Array.isArray(result.data?.integration) ? { integration: result.data.integration } : {}),
    // The generated standard actions of the data model (op entity-actions).
    ...(entityActionsOf(result.data?.entityActions) ? { entityActions: entityActionsOf(result.data.entityActions) } : {}) };
}

// I1 (fa): the content identity of a capture (the sha256 with the OML header's volatile fields masked), or the raw sha256
// when oml-content-sha.mjs is not there. Two captures of an unchanged module share it: the delivery cache and the worker's
// base cache key by it. The delivery still builds on the new capture; the content only identifies.
let contentModule = null;
export async function baseContentSha256(snapshot, deps = {}) {
  try {
    const content = deps.contentSha !== undefined ? deps.contentSha
      : (await (contentModule ??= import('./oml-content-sha.mjs').catch(() => null)))?.contentSha256 ?? null;
    const sha = content ? content(snapshot.path)?.sha256 : snapshot.sha256;
    return sha ? String(sha).toLowerCase() : null;
  } catch { return snapshot.sha256 ? String(snapshot.sha256).toLowerCase() : null; }
}
const runOnWorker = async (argv, options) => (await import('./anvil-worker.mjs')).runOdcOnWorker(argv, options);

// The kernel CLI's apply. B2 (C02): on the lane's resident ODC worker when it serves the request under the snapshot's own
// author (--developer-id, capability apply:developer-id) with the capture's content identity (--base-content-sha256, its
// BaseModelCache); else cold, in a private process with ANVIL_DEVELOPER_ID of THIS snapshot, as before. The worker never
// takes another identity: the author travels in each request. deps (tests): worker (null = cold), contentSha, exec, cli.
export async function applyKernel({ job, snapshot, output, producers = {} }, deps = {}) {
  const cli = deps.cli ?? kernelCli();
  if (!fs.existsSync(cli)) throw new Error('ODC kernel CLI is not built (' + cli + '): the integrator or the user builds it; ssam_doctor {lane:"odc"} reports the state.');
  if (!snapshot.developerId || !snapshot.host || !snapshot.moduleKey) throw new Error('Snapshot lacks developerId, host or moduleKey; capture a new snapshot.');
  const hash = sha256(fs.readFileSync(snapshot.path));
  if (hash.toUpperCase() !== snapshot.sha256?.toUpperCase()) throw new Error('Captured base changed on disk; capture a new snapshot.');
  const candidate = path.join(output, 'kernel-candidate.oml');
  const producerArgs = [];
  for (const [name, file] of Object.entries(producers)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid producer binding: ' + name);
    const signature = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (signature.Environment?.toLowerCase() !== snapshot.host.toLowerCase()) throw new Error('Producer signature belongs to another environment: ' + name);
    producerArgs.push('--producer', `${name}=${file}`);
  }
  // Hosted (executor.mjs): a cold apply runs in the closed environment and folder of the customer's ODC workspace, never
  // this process's. The resident ODC worker is a shared process of the server that never talks to a Studio: every path of
  // the request is absolute (job, base, out, work under the customer's workspace) and the author travels in the request.
  const hosted = hostedContext() ? hostedSpawnEnv('odc') : null;
  const content = snapshot.contentSha256 ?? await baseContentSha256(snapshot, deps);
  const argv = ['apply', '--job', job, '--base', snapshot.path, '--out', candidate, '--work', path.join(output, 'work'), ...producerArgs,
    '--developer-id', snapshot.developerId, ...(content ? ['--base-content-sha256', content] : [])];
  const onWorker = await (deps.runOnWorker ?? runOnWorker)(argv, { ...(deps.worker !== undefined ? { worker: deps.worker } : {}), needs: ['apply:developer-id'] });
  if (onWorker.used && onWorker.unknown) {
    try { fs.writeFileSync(path.join(output, 'kernel-output.txt'), 'worker: ' + (onWorker.error ?? 'no answer')); } catch { /* evidence only */ }
    return { ok: false, code: 'WORKER_OUTCOME_UNKNOWN', kernel: { via: 'worker' },
      error: 'The ODC kernel worker took the apply and gave no answer (' + (onWorker.error ?? 'no reply') + '); nothing was built or merged. The same delivery again builds from a new capture.' };
  }
  const response = onWorker.used
    ? { stdout: JSON.stringify(onWorker.envelope), stderr: '', exitCode: onWorker.envelope?.ok === true ? 0 : 1 }
    : await coldKernel(() => (deps.exec ?? exec)('dotnet', [cli, ...argv], {
      cwd: hosted ? hosted.cwd : path.dirname(cli), windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: { ...(hosted ? hosted.env : process.env), ANVIL_DEVELOPER_ID: snapshot.developerId },
    }).then(r => ({ ...r, exitCode: 0 })).catch(e => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message, exitCode: e.code ?? 1 })));
  const kernel = { via: onWorker.used ? 'worker' : 'cold', ...(onWorker.note ? { note: onWorker.note } : {}), ...(onWorker.warning ? { warning: onWorker.warning } : {}) };
  let result;
  try { result = JSON.parse(response.stdout); }
  catch {
    // The process output stays in the evidence; the answer carries its first line, never a stack trace.
    try { fs.writeFileSync(path.join(output, 'kernel-output.txt'), 'exit ' + response.exitCode + '\n--- stdout\n' + response.stdout + '\n--- stderr\n' + response.stderr); } catch { /* evidence only */ }
    const cause = withoutStack(String(response.stderr || response.stdout || '').trim()).split('\n').find(Boolean) ?? null;
    return { ok: false, code: 'KERNEL_NO_JSON', error: 'Kernel did not return JSON' + (cause ? ': ' + cause : ''), exitCode: response.exitCode, evidence: path.join(output, 'kernel-output.txt'), kernel };
  }
  fs.writeFileSync(path.join(output, 'kernel-result.json'), JSON.stringify(result, null, 2));
  return { ...interpretKernelResult(result, { output, exitCode: response.exitCode }), kernel };
}

// C31: the job's own preflight (anvil-odc check-job: no Studio, no model). primeira-certa A3: only a shortcut for when no
// base can be had (the module could not be captured); with a capture the apply over it refuses once with every phase. On
// the worker when it serves, else cold.
// -> {ok:true} | {ok:true, skipped} (the check could not say: the apply reports it) | {ok:false, code, problems, error, verifyRan:false}.
export async function checkJobKernel({ job }, deps = {}) {
  const cli = deps.cli ?? kernelCli();
  if (!fs.existsSync(cli)) return { ok: true, skipped: 'the ODC kernel CLI is not built' };
  const argv = ['check-job', '--job', job];
  const onWorker = await (deps.runOnWorker ?? runOnWorker)(argv, deps.worker !== undefined ? { worker: deps.worker } : {});
  let envelope = onWorker.used ? onWorker.envelope : null;
  if (!onWorker.used) {
    // Hosted: cold in the customer's closed environment and folder (C01: the verify ids never depend on this cwd).
    const hosted = hostedContext() ? hostedSpawnEnv('odc') : null;
    const response = await coldKernel(() => (deps.exec ?? exec)('dotnet', [cli, ...argv], { cwd: hosted ? hosted.cwd : path.dirname(cli), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      ...(hosted ? { env: hosted.env } : {}) })
      .then(r => ({ ...r, exitCode: 0 })).catch(e => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message, exitCode: e.code ?? 1 })));
    try { envelope = JSON.parse(response.stdout); } catch { envelope = null; }
  }
  if (!isObject(envelope)) return { ok: true, skipped: 'check-job gave no answer' };
  const problems = Array.isArray(envelope.data?.problems) ? envelope.data.problems : Array.isArray(envelope.problems) ? envelope.problems : [];
  const errors = problems.filter(p => p?.severity !== 'warning');
  if (envelope.ok === true || (envelope.data?.valid !== false && !errors.length)) return { ok: true };
  if (!errors.length) return { ok: true, skipped: withoutStack(envelope.error) ?? 'check-job refused without problems' };
  return { ok: false, code: errors.length === 1 && errors[0].code ? errors[0].code : 'PREFLIGHT_REFUSED', problems: errors,
    error: (Array.isArray(envelope.data?.errors) && envelope.data.errors.length ? envelope.data.errors : errors.map(p => p.message + (p.fix ? ' Fix: ' + p.fix : ''))).join('\n'),
    verifyRan: false, ...(typeof envelope.data?.verifyReason === 'string' ? { verifyReason: envelope.data.verifyReason } : {}) };
}

// The delivery's merge order, computed headless by the kernel (anvil-odc merge-order: Anvil.Core.MergePlanner over the
// ODC model). The ODC Studio drops a Default Value it marks read-only (an attribute of an identifier type, a mandatory
// input) when a merge CREATES that element; merged onto the existing element the default is kept. The bridge's own merge
// order (NativeMergeOrder.Prepare) builds its first-pass copy inside the Studio, and that transaction throws there
// (NullReferenceException in ESpaceTransactionsManager.ExecuteTransaction, ODC Studio 1.7.27, bridge v45, 2026-10-08).
// So the facade never hands the bridge a merge with a deferred default: it delivers the first-pass candidate this returns,
// then the full candidate over the module captured after it (deliverKernel). On the worker when it advertises
// merge-order, else cold. -> {ok:true, deferred:[{key, objectKey, element, property, value, baseValue}], firstPass|null,
// firstPassSha256|null} | {ok:false, error}.
export async function planMergeOrderKernel({ base, candidate, output }, deps = {}) {
  const cli = deps.cli ?? kernelCli();
  if (!fs.existsSync(cli)) return { ok: false, error: 'the ODC kernel CLI is not built (' + cli + ')' };
  const firstPass = path.join(output, 'merge-order-first-pass.oml');
  const argv = ['merge-order', '--base', base, '--candidate', candidate, '--out', firstPass, '--work', path.join(output, 'work-merge-order')];
  const onWorker = await (deps.runOnWorker ?? runOnWorker)(argv, { ...(deps.worker !== undefined ? { worker: deps.worker } : {}), needs: ['merge-order'] });
  if (onWorker.used && onWorker.unknown) return { ok: false, error: 'the ODC kernel worker took merge-order and gave no answer (' + (onWorker.error ?? 'no reply') + ')' };
  let envelope = onWorker.used ? onWorker.envelope : null;
  if (!onWorker.used) {
    const response = await coldKernel(() => (deps.exec ?? exec)('dotnet', [cli, ...argv], { cwd: path.dirname(cli), windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      .then(r => ({ ...r, exitCode: 0 })).catch(e => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message, exitCode: e.code ?? 1 })));
    try { envelope = JSON.parse(response.stdout); } catch { envelope = null; }
    if (!isObject(envelope)) return { ok: false, error: 'merge-order gave no JSON: ' + (withoutStack(String(response.stderr || response.stdout || '').trim()).split('\n').find(Boolean) ?? 'no output') };
  }
  if (envelope?.ok !== true || !isObject(envelope.data) || !Array.isArray(envelope.data.deferred)) return { ok: false, error: withoutStack(envelope?.error) ?? 'merge-order refused' };
  const data = envelope.data;
  const plan = { ok: true, deferred: data.deferred, firstPass: typeof data.firstPass === 'string' ? data.firstPass : null, firstPassSha256: data.firstPassSha256 ?? null, rule: data.rule ?? null };
  if (plan.deferred.length && (!plan.firstPass || !fs.existsSync(plan.firstPass))) return { ok: false, error: 'merge-order deferred defaults without a first-pass candidate' };
  if (plan.firstPass && plan.firstPassSha256 && sha256(fs.readFileSync(plan.firstPass)) !== String(plan.firstPassSha256).toLowerCase())
    return { ok: false, error: 'the first-pass candidate changed on disk after merge-order' };
  return plan;
}

// The repair of deferred defaults the second merge did not deliver: each element exists after the first merge, so a merge
// keeps a default set on it (Anvil.Core.MergeOrder.RepairJob, same shape).
export const mergeOrderRepairJob = deferred => ({ ops: deferred.map(d => ({ op: 'set', target: '@' + d.objectKey, prop: 'DefaultValue', value: d.value })) });

// ---- C17: the kernel apply of a delivery is cached by everything it reads. Key: sha256 of the job (its bytes and every
// file it names: composite parts, fragments, SQL...), the base capture, the developer and host of the capture, the producer
// signatures captured for it, the ODC kernel CLI (its files and the catalogs it reads) and the builder. A hit copies the
// accepted candidate and its kernel-result.json into the new evidence directory and skips the apply; a job that names a
// file this resolution cannot find is never cached. <odcRoot>/.local/deliver-cache/<key>/, the newest 20 kept.
// SSAM_ODC_DELIVER_CACHE=0 turns it off.
const contentMemo = new Map();
function contentSha(file) {
  const stat = fs.statSync(file);
  const memo = file + '|' + stat.size + '|' + stat.mtimeMs;
  if (!contentMemo.has(memo)) contentMemo.set(memo, sha256(fs.readFileSync(file)));
  return contentMemo.get(memo);
}
function filesUnder(dir) {
  const out = [];
  const walk = d => { let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(dir); return out;
}
const odcStudioDirOf = env => env.ANVIL_ODC_STUDIO_DIR ?? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'OutSystems', 'ODC Studio', 'ODC Studio');
export function kernelIdentity({ cli = kernelCli(), catalog = path.join(anvilRoot, 'catalog'), studio = odcStudioDirOf(process.env), builder = null } = {}) {
  const cliDir = path.dirname(cli);
  const parts = filesUnder(cliDir).map(f => ['cli', path.relative(cliDir, f), contentSha(f)]);
  for (const f of filesUnder(catalog)) { const s = fs.statSync(f); parts.push(['catalog', path.relative(catalog, f), s.size, s.mtimeMs]); }
  for (const name of ['OutSystems.Model.dll', 'OutSystems.Model.Implementation.dll']) {
    try { const s = fs.statSync(path.join(studio, name)); parts.push(['studio', name, s.size, s.mtimeMs]); } catch { parts.push(['studio', name, 'missing']); }
  }
  parts.push(['builder', builder && fs.existsSync(builder) ? contentSha(builder) : 'missing']);
  return sha256(JSON.stringify(parts));
}
const PATHISH = /\.(json|html?|css|sql|js|mjs|oml|avsig|txt|svg|png|jpe?g|gif|ico|xml|csv|xlsx)$/i;
const looksLikePath = s => typeof s === 'string' && s.length < 300 && PATHISH.test(s) && !/[\r\n<>{}()]|:\/\//.test(s);
const repoRootOf = dir => { for (let d = path.resolve(dir); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, 'MANIFESTO.md'))) return d; if (path.dirname(d) === d) return null; } };
// The job part a composite job names, with the kernel's rule (JobRunner.ResolveJobFile).
export function resolveJobPart(spec, jobDir, { anvil = anvilRoot } = {}) {
  if (typeof spec !== 'string' || !spec) return null;
  const candidates = [];
  if (spec.startsWith('job:')) {
    const name = spec.slice(4) + '.json';
    candidates.push(path.join(jobDir, name));
    const folder = path.basename(path.resolve(jobDir));
    if (/-negative$/i.test(folder)) candidates.push(path.join(path.dirname(path.resolve(jobDir)), folder.replace(/-negative$/i, ''), name));
    const root = repoRootOf(jobDir) ?? anvil;
    if (root) candidates.push(path.join(root, 'tests', 'jobs', name));
  } else {
    candidates.push(path.isAbsolute(spec) ? spec : path.join(jobDir, spec));
    const root = repoRootOf(jobDir) ?? anvil;
    if (root && !path.isAbsolute(spec)) candidates.push(path.join(root, spec));
  }
  return candidates.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) ?? null;
}
// sha256 of the job and of every file it names, or null when a name does not resolve (then nothing is cached). By content
// only: an inline job gets a new path at every call (C02, item 4), and each named file is reached through the name the
// parent's bytes already carry, so the paths add nothing.
export function jobDigest(jobFile, { roots = [], anvil = anvilRoot } = {}) {
  const hash = createHash('sha256'); const seen = new Set();
  const visit = file => {
    const full = path.resolve(file);
    if (seen.has(full.toLowerCase())) return true;
    seen.add(full.toLowerCase());
    const bytes = fs.readFileSync(full);
    hash.update('file\0'); hash.update(bytes); hash.update('\0');
    if (!/\.json$/i.test(full)) return true;
    let document; try { document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { return true; }
    const dir = path.dirname(full);
    const resolve = s => {
      if (s.startsWith('job:')) return resolveJobPart(s, dir, { anvil });
      for (const root of [null, dir, ...roots]) {
        const f = root == null ? (path.isAbsolute(s) ? s : null) : path.join(root, s);
        if (f) { try { if (fs.statSync(f).isFile()) return f; } catch { /* next root */ } }
      }
      return null;
    };
    const walk = (node, key) => {
      if (typeof node === 'string') {
        if (!(key === 'jobs' || node.startsWith('job:') || key === 'file' || looksLikePath(node))) return true;
        const found = resolve(node);
        return found ? visit(found) : false;
      }
      if (Array.isArray(node)) return node.every(n => walk(n, key));
      if (isObject(node)) return Object.entries(node).every(([k, v]) => walk(v, k));
      return true;
    };
    return walk(document, null);
  };
  try { return visit(jobFile) ? hash.digest('hex') : null; } catch { return null; }
}
export function deliveryCache({ root, cli = kernelCli(), builder = path.join(root, 'studio', 'builder', 'bin', 'Release', 'net10.0', 'ODC3.Builder.dll'), dir = path.join(root, '.local', 'deliver-cache'), keep = 20, identity = null } = {}) {
  const kernel = () => identity ?? kernelIdentity({ cli, builder });
  return {
    dir,
    key({ job, snapshot, producers = [] }) {
      const digest = jobDigest(job, { roots: [path.dirname(cli), repoRootOf(path.dirname(job)), anvilRoot].filter(Boolean) });
      if (!digest) return null;
      // The base by its content identity (I1) when the caller has it: two captures of an unchanged module are one entry.
      return sha256(JSON.stringify({ v: 2, job: digest, base: String(snapshot.contentSha256 ?? snapshot.sha256 ?? '').toUpperCase(), developer: snapshot.developerId ?? null, host: String(snapshot.host ?? '').toLowerCase(),
        producers: producers.map(p => [p.name, String(p.sha256 ?? '').toLowerCase()]).sort(), kernel: kernel() }));
    },
    restore(key, output) {
      const entryDir = path.join(dir, key);
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(entryDir, 'entry.json'), 'utf8'));
        const bytes = fs.readFileSync(path.join(entryDir, 'kernel-candidate.oml'));
        if (entry.key !== key || sha256(bytes).toLowerCase() !== String(entry.candidateSha256).toLowerCase()) return null;
        const result = JSON.parse(fs.readFileSync(path.join(entryDir, 'kernel-result.json'), 'utf8'));
        fs.writeFileSync(path.join(output, 'kernel-candidate.oml'), bytes);
        fs.writeFileSync(path.join(output, 'kernel-result.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(output, 'kernel-cache.json'), JSON.stringify({ hit: true, key, from: entryDir, storedAt: entry.storedAt }, null, 2));
        const applied = interpretKernelResult(result, { output });
        return applied.ok ? applied : null;
      } catch { return null; }
    },
    store(key, output) {
      const tmp = path.join(dir, key + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8));
      try {
        fs.mkdirSync(tmp, { recursive: true });
        const bytes = fs.readFileSync(path.join(output, 'kernel-candidate.oml'));
        fs.writeFileSync(path.join(tmp, 'kernel-candidate.oml'), bytes);
        fs.copyFileSync(path.join(output, 'kernel-result.json'), path.join(tmp, 'kernel-result.json'));
        fs.writeFileSync(path.join(tmp, 'entry.json'), JSON.stringify({ key, candidateSha256: sha256(bytes), storedAt: new Date().toISOString(), evidence: output }, null, 2));
        fs.renameSync(tmp, path.join(dir, key));
      } catch { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } return; }
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name))
          .map(e => ({ name: e.name, at: fs.statSync(path.join(dir, e.name)).mtimeMs })).sort((a, b) => b.at - a.at);
        for (const old of entries.slice(keep)) fs.rmSync(path.join(dir, old.name), { recursive: true, force: true });
      } catch { /* pruning never fails a delivery */ }
    },
  };
}

// ---- C16.1: a structure made public in an ODC app. The ODC Studio keeps Public False on a structure of an app (labs 31
// and 35: three structures asked Public True, the merge kept False, and a second native pass does not change it), so the
// job is refused before the build with the alternatives. A library takes it. Composite jobs are read part by part.
export function collectJobOps(document, jobDir, options = {}, active = new Set()) {
  if (Array.isArray(document)) return document.map((op, i) => ({ op, index: i, pointer: '/' + i }));
  if (!isObject(document)) return [];
  if (!Array.isArray(document.jobs)) return (Array.isArray(document.ops) ? document.ops : []).map((op, i) => ({ op, index: i, pointer: '/ops/' + i }));
  const out = [];
  for (const spec of document.jobs) {
    const file = resolveJobPart(spec, jobDir, options);
    if (!file || active.has(path.resolve(file).toLowerCase())) continue;
    let part; try { part = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const nested = collectJobOps(part, path.dirname(file), options, new Set([...active, path.resolve(file).toLowerCase()]));
    for (const entry of nested) out.push({ op: entry.op, index: out.length, pointer: null });
  }
  return out;
}
const truthy = v => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
const STRUCTURE_TYPE = /^I?Structure$/;
export function publicStructureProblems(entries, { module = 'this app' } = {}) {
  const problems = [], aliases = new Map();
  const problem = (entry, name, pointer) => problems.push({ op: entry.index, pointer, code: 'ODC_STRUCTURE_PUBLIC_IN_APP', severity: 'error',
    message: `Structure ${name ?? '(unnamed)'} is made public in ${module}, an ODC app: the ODC Studio keeps Public False on a structure of an app (the native merge drops it), so the delivered module would differ from the candidate.`,
    fix: 'Keep the structure private and return its fields as flat outputs; or expose the data through a public entity; or move the structure to a library and reference it from the app.',
    patch: null });
  for (const entry of entries) {
    const op = entry.op;
    if (!isObject(op)) continue;
    if (op.op === 'spec' && Array.isArray(op.data?.structures))
      op.data.structures.forEach((s, j) => { if (isObject(s) && truthy(s.public ?? s.Public)) problem(entry, s.name, entry.pointer == null ? null : `${entry.pointer}/data/structures/${j}/public`); });
    // DL2: the data text (spec op, ddl form): `type <Name> public` on a line of its own.
    if (op.op === 'spec' && typeof op.data?.ddl === 'string')
      op.data.ddl.split(/\r?\n/).forEach((line, at) => {
        const m = /^type (\[(?:[^\]]|\]\])*\]|[^\s=]+)[^=]*? public\b/.exec(line);
        if (m) { problem(entry, m[1], entry.pointer == null ? null : `${entry.pointer}/data/ddl`); problems.at(-1).line = at + 1; }
      });
    if (op.op === 'create' && STRUCTURE_TYPE.test(String(op.type ?? ''))) {
      const name = op.name ?? op.args?.Name ?? op.args?.name;
      if (typeof op.as === 'string') aliases.set(op.as, name);
      if (truthy(op.args?.Public ?? op.args?.public)) problem(entry, name, entry.pointer == null ? null : `${entry.pointer}/args/Public`);
    }
    if (op.op === 'set' && op.prop === 'Public' && truthy(op.value) && typeof op.target === 'string') {
      const typed = /(?:^|\/)I?Structure:([^/]+)$/.exec(op.target);
      if (typed || aliases.has(op.target)) problem(entry, typed ? typed[1] : aliases.get(op.target), entry.pointer == null ? null : `${entry.pointer}/value`);
    }
  }
  return problems;
}

// ---- C16.4: an uncertain merge names its divergences, one per element or property, from the native comparison dump
// (native-equivalence.txt), for a bridge that does not answer them itself. The same reading as
// NativeMergeVerification.Divergences.
const NODE_LINE = /^(?:((?:\|    )*)\+-- )?\((Object [^)]+|Folder)\) (.*?)(?: \[([A-Za-z]+(?:, [A-Za-z]+)*)\])?\r?$/;
const PROPERTY_LINE = /^(?:\|    )*\|\s+>> (.*?)\r?$/;
const CONNECTOR_LINE = /^[| ]*\r?$/;
const OWN_FLAGS = new Set(['ChangedInLocal', 'AddedToLocal', 'RemovedFromLocal', 'AddedToForeign', 'RemovedFromForeign', 'ChangedInForeign', 'Conflict', 'Different']);
export function divergencesOf(dump, max = 50) {
  const lines = String(dump ?? '').split('\n');
  const nodes = [], stack = [];
  const clip = s => (s == null ? s : s.length <= 200 ? s : s.slice(0, 200) + '...');
  for (let i = 0; i < lines.length; i++) {
    const property = PROPERTY_LINE.exec(lines[i]);
    if (property) {
      let text = property[1];
      while (i + 1 < lines.length && !NODE_LINE.test(lines[i + 1]) && !PROPERTY_LINE.test(lines[i + 1]) && !CONNECTOR_LINE.test(lines[i + 1])) text += '\n' + lines[++i].replace(/\r$/, '');
      stack.at(-1)?.properties.push(text.replace(/ \[[A-Za-z]+(?:, [A-Za-z]+)*\]$/, ''));
      continue;
    }
    const node = NODE_LINE.exec(lines[i]);
    if (!node) continue;
    const depth = node[1] != null ? node[1].length / 5 + 1 : 0;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const entry = { depth, kind: node[2], name: node[3], flags: node[4] ? node[4].split(', ') : [], parent: stack.at(-1) ?? null, properties: [] };
    stack.push(entry); nodes.push(entry);
  }
  const elementOf = n => { const names = []; for (let x = n; x && x.parent; x = x.parent) if (x.kind !== 'Folder') names.unshift(x.name); return names.join('/'); };
  const out = [];
  for (const n of nodes.filter(x => x.flags.some(f => OWN_FLAGS.has(f)))) {
    const kind = n.kind.startsWith('Object ') ? n.kind.slice(7) : n.kind, element = elementOf(n);
    if (!n.properties.length) {
      const local = n.flags.includes('AddedToLocal') || n.flags.includes('RemovedFromForeign') ? 'present'
        : n.flags.includes('RemovedFromLocal') || n.flags.includes('AddedToForeign') ? 'absent' : [...n.flags].sort().join(', ');
      out.push({ element, kind, property: null, local, candidate: local === 'present' ? 'absent' : local === 'absent' ? 'present' : local });
    }
    for (const body of n.properties) {
      const open = body.indexOf('[');
      const name = open > 0 ? body.slice(0, open) : body;
      const separator = '] / ' + name + '[';
      const at = open > 0 ? body.indexOf(separator, open) : -1;
      out.push(at > 0 && body.endsWith(']')
        ? { element, kind, property: name.trim(), local: clip(body.slice(open + 1, at)), candidate: clip(body.slice(at + separator.length, -1)) }
        : { element, kind, property: name.trim(), local: clip(open > 0 ? body.slice(open + 1).replace(/\]$/, '') : null), candidate: null });
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
const divergenceLine = d => d.element + ' (' + d.kind + '): ' + (d.property == null ? `element ${d.local} in the module, ${d.candidate} in the candidate` : `${d.property} local '${d.local}' / candidate '${d.candidate}'`);
function evidenceDirOf(manifest) {
  try { const m = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '')); return m.evidenceDir ?? m.EvidenceDir ?? path.join(path.dirname(manifest), 'evidence'); }
  catch { return manifest ? path.join(path.dirname(manifest), 'evidence') : null; }
}

// ---- C08 ODC: publish in the same call, after a clean merge, with the request's words or a standing grant (I6).
// The words of the request win; without them, a grant for the app (lane odc, verb publish). None: refused before anything.
export async function publishAuthorization({ authorize, module, requested }, grants) {
  if (typeof authorize === 'string' && authorize.trim()) return { words: authorize.trim(), authorization: { source: 'words' } };
  for (const app of [...new Set([module, requested].filter(n => typeof n === 'string' && n))]) {
    let grant = null;
    try { grant = await grants?.findGrant?.({ lane: 'odc', app, module, verb: 'publish' }); } catch { grant = null; }
    if (grant && typeof grant.words === 'string' && grant.words.trim()) return { words: grant.words, authorization: { source: 'standing-grant', grantId: grant.grantId } };
  }
  return null;
}
const PUBLISH_STATE = state => /^CompletedWithSuccess/i.test(String(state ?? '')) ? 'succeeded' : /CompletedWithFailure|Failed/i.test(String(state ?? '')) ? 'failed'
  : /^Running/i.test(String(state ?? '')) ? 'running' : 'unknown';
// LastPublication from the bridge's compact lastPublish (status.modules[].lastPublish) or a publish receipt.
export function lastPublicationFrom(lastPublish, { source = 'publish-log', by = 'unknown' } = {}) {
  if (!isObject(lastPublish) || lastPublish.found === false || lastPublish.error) return null;
  const status = lastPublish.running === true ? 'running' : PUBLISH_STATE(lastPublish.state);
  return { at: lastPublish.completedAt ?? lastPublish.at ?? null, status, version: lastPublish.revision ?? lastPublish.version ?? null,
    author: lastPublish.lastUploadUser ?? null, by, source };
}
const publishMessages = log => (Array.isArray(log?.messages) ? log.messages : [])
  .map(m => ({ type: m.type, text: m.text, ...(m.element?.name ? { element: m.element.name } : {}), ...(m.stage ? { stage: m.stage } : {}) }))
  .sort((a, b) => (a.type === 'Error' ? 0 : 1) - (b.type === 'Error' ? 0 : 1)).slice(0, 10);
// PublishOutcome (section 3) from the answer of studio_publish (publishWithLog).
export function publishOutcomeOf(value) {
  if (isObject(value) && value.ok === true) return { requested: true, outcome: 'published',
    ...(value.published?.revision != null ? { version: value.published.revision } : {}), ...(value.completedAt ? { at: String(value.completedAt) } : {}) };
  if (!isObject(value)) return { requested: true, outcome: 'uncertain', code: 'PUBLISH_UNCERTAIN', error: 'The publication answered nothing readable.' };
  const messages = publishMessages(value.publishLog);
  if (value.code === 'PUBLISH_RUNNING' || value.outcome === 'uncertain')
    return { requested: true, outcome: 'uncertain', code: 'PUBLISH_UNCERTAIN', error: withoutStack(value.error), ...(messages.length ? { messages } : {}) };
  if (value.code === 'PUBLISH_FAILED') return { requested: true, outcome: 'failed', code: 'PUBLISH_FAILED', error: withoutStack(value.error), ...(messages.length ? { messages } : {}) };
  return { requested: true, outcome: 'refused', code: value.code ?? (value.gate && value.gate !== 'none' ? 'PUBLISH_' + String(value.gate).toUpperCase() : 'PUBLISH_REFUSED'), error: withoutStack(value.error) };
}
async function defaultPublishWithLog(args, deps) { return (await import('./studio-publish-log.mjs')).publishWithLog(args, deps); }
// Records the words in the manifest (the bridge's authorize) and publishes with --wait: one receipt.
export async function publishDelivered({ manifest, module, words, pid, minutes = 10 }, { studio, publishWithLog = defaultPublishWithLog }) {
  let recorded;
  try { recorded = await studio(['authorize', manifest, 'publish', words], pid); }
  catch (error) { return { publish: { requested: true, outcome: 'refused', code: 'PUBLISH_AUTHORIZATION_FAILED', error: error.message } }; }
  if (recorded?.ok !== true) return { publish: { requested: true, outcome: 'refused', code: 'PUBLISH_AUTHORIZATION_FAILED', error: withoutStack(recorded?.error) ?? 'authorize refused' } };
  // I2 (C07): merged and saved; the publication is a server operation of this module only, so the Studio's write lock
  // narrows to the module (a write of another module of the same Studio runs meanwhile). Inert where the lock lacks it.
  try { writeLock.narrowStudioWrite?.({ module }); } catch { /* the publication goes on under the Studio lock */ }
  let value;
  try { value = await publishWithLog({ manifest, wait: true, minutes, pid }, { studio, moduleOf: () => module }); }
  catch (error) { return { publish: { requested: true, outcome: 'uncertain', code: 'PUBLISH_UNCERTAIN', error: 'Publication result unknown (' + error.message + '): read publish-log and publish-status; never republish blindly.' } }; }
  const publish = publishOutcomeOf(value);
  const lastPublication = publish.outcome === 'published'
    ? { at: publish.at ?? null, status: 'succeeded', version: publish.version ?? null, author: null, by: 'ssam', source: 'publish-result' }
    : lastPublicationFrom(value?.publishLog, { source: 'publish-log', by: 'ssam' });
  return { publish, ...(lastPublication ? { lastPublication } : {}) };
}

// A bridge from before the External Library reference (capability reference-snapshot:external-library) refuses such a
// producer with "not extensions or external libraries": the delivery stops before the build with the step that fixes
// it (reopen the ODC Studio, attach the newest bridge), not with the bridge's sentence.
export function withBridgeUpgrade(value, producer) {
  if (!isObject(value) || value.ok !== false || typeof value.error !== 'string' || !/not extensions or external libraries/i.test(value.error)) return value;
  return { ...value, code: 'BRIDGE_UPGRADE_REQUIRED',
    error: 'The bridge loaded in the ODC Studio cannot export the signature of ' + (producer ?? 'this producer') + ' (an External Library); nothing was built or merged.',
    continuation: { tool: 'studio_attach', arguments: {}, why: 'Close and reopen the ODC Studio, then studio_attach loads the newest bridge (reference-snapshot:external-library); then repeat the delivery.' } };
}

// The builder compares the candidate with the live capture element by element (PrepareManifest.cs CandidateChange): a
// candidate identical to it is refused before any Studio step, with the code that says there is nothing to deliver.
export function withManifestCode(prepared) {
  if (prepared?.ok !== false || typeof prepared.error !== 'string') return prepared;
  if (/Candidate equals the live module/.test(prepared.error)) return { ...prepared, code: 'NO_CHANGE' };
  if (/No change carries the snapshot author/.test(prepared.error)) return { ...prepared, code: 'CANDIDATE_AUTHOR' };
  return prepared;
}
// The merge's own refusals of the preview's conditions (StartupHook.cs Run), now that a delivery goes straight to it.
export function withMergeCode(value) {
  if (!isObject(value) || value.ok !== false || value.code || typeof value.error !== 'string') return value;
  if (/has no changes over the open module/.test(value.error)) return { ...value, code: 'NO_CHANGE' };
  if (/conflicts with the open module/.test(value.error)) return { ...value, code: 'MERGE_CONFLICT' };
  if (/differs from the captured base/.test(value.error)) return { ...value, code: 'BASE_DRIFT' };
  if (/Authenticated author mismatch/.test(value.error)) return { ...value, code: 'AUTHOR_MISMATCH' };
  return value;
}

// A delivery that stops at `build` because the kernel refused the job or its candidate did not pass Verify gets the
// same guidance as `ssam job` (job-guidance.mjs): contract, capabilities, proven refusal, next step. Only there: the
// later stages talk to the Studio, and an uncertain merge is never interpreted here.
const catalogGuidance = async args => (await import('./job-guidance.mjs')).jobGuidance(args);
// The base snapshot and the built candidate get their module index in the background (module-map.mjs).
const warmIndex = (file, lane) => import('./module-map.mjs').then(m => m.prefetchIndex(file, lane));
const readCatalogOf = root => () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'snapshots', 'modules.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const standingGrants = async () => import('./standing-grants.mjs').catch(() => null);
export async function deliverKernel(input, deps) {
  const { root, studio, prepareManifest, nextLabDir, journal, apply = applyKernel, guide = catalogGuidance, prefetch = warmIndex,
    catalog = readCatalogOf(root), publishStep = publishDelivered } = deps;
  // F5: the workspace's producer cache (producer-signatures.mjs); null turns the reuse off.
  const signatureCache = deps.signatureCache !== undefined ? deps.signatureCache : path.join(root, '.local', 'producer-cache');
  // C31: the preflight runs on the kernel the delivery applies with; a test that fakes the apply fakes (or omits) it too.
  const check = deps.check !== undefined ? deps.check : apply === applyKernel ? checkJobKernel : null;
  // The merge order (planMergeOrderKernel): the same rule as check, the kernel the delivery applies with.
  const planOrder = deps.mergeOrder !== undefined ? deps.mergeOrder : apply === applyKernel ? planMergeOrderKernel : null;
  // A warm-up never waits, fails or changes the delivery.
  const warm = file => { Promise.resolve().then(() => prefetch(file, 'odc')).catch(() => {}); };
  const { feature, owners, changes, pid, until = 'merge', publish = false, authorize } = input;
  let { module } = input;
  if (!module?.trim() || !feature?.trim() || !input.job?.trim()) throw new Error('job, module and feature are required for kernel delivery.');
  for (const [name, list] of Object.entries({ owners, changes }))
    if (!Array.isArray(list) || !list.length || list.some(s => typeof s !== 'string' || !s.trim())) throw new Error(name + ' must be a non-empty array of strings.');
  if (!steps.includes(until)) throw new Error('until must be one of ' + steps.join(', '));
  if (publish === true && until !== 'merge') throw new Error('publish requires until "merge": the publication follows a clean merge in the same call.');
  let job = path.resolve(root, input.job);
  if (!fs.statSync(job).isFile()) throw new Error('Job must be a file: ' + job);
  const readJob = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  let jobDocument = readJob(job);
  // Named producer bindings on ordinary jobs are acquired through the consumer's native session.
  // job: sources and explicit fixtures retain their existing, offline resolution.
  // a reference op's producer, and the producer data.bind of a prototype op names (docs/PROTOTIPO-NATIVO.md 2.12)
  const producersOf = document => [...new Set((Array.isArray(document) ? document : document.ops ?? [])
    .map(op => (op.op === 'reference' ? op.producer : op.op === 'prototype' ? op.data?.bind?.producer : null))
    .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? '')))];
  let requestedProducers = producersOf(jobDocument);
  let output = path.resolve(root, input.output ?? nextLabDir(feature));
  if (fs.existsSync(output)) throw new Error('Use a new output directory; evidence is never overwritten: ' + output);
  // Hosted, root is the customer's <ws>/odc (the cache folder is theirs); the builder that keys it stays a code location.
  const cache = deps.cache !== undefined ? deps.cache : process.env.SSAM_ODC_DELIVER_CACHE === '0' ? null
    : deliveryCache({ root, ...(hostedContext() ? { builder: path.join(odcRoot, 'studio', 'builder', 'bin', 'Release', 'net10.0', 'ODC3.Builder.dll') } : {}) });
  const started = Date.now();
  const report = { ok: false, source: 'kernel-job', module, feature, job, until, steps: [], merged: false, publishInvoked: false };
  let stage = 'snapshot', claimed = false;
  // proto: the expansion of a prototype op (captures, warnings, timings), its degraded items and its receipt.
  let proto = null, protoRefusal = null;
  // order: the merge order of this delivery when the candidate has deferred defaults ({deferred, firstPass}); then the
  // manifest of the build is the first pass, and the full candidate is delivered after it (see the merge step).
  let order = null;
  // The stage in flight, for studio_status while the bridge is busy (C10): the evidence of this delivery.
  const progress = step => { try { deps.onStage?.(step); } catch { /* a notification never changes the delivery */ } if (claimed) { try { fs.writeFileSync(path.join(output, 'deliver-progress.json'), JSON.stringify({ stage: step, since: new Date().toISOString(), module, pid: pid ?? null, manifest: report.manifest ?? null, facadePid: process.pid }, null, 2)); } catch { /* evidence only */ } } };
  const refuse = (step, value) => {
    report.failed = step; report.error = withoutStack(value.error) ?? step + ' refused'; report.refusal = sanitized(value);
    if (value.outcome) report.outcome = value.outcome;
    if (value.gate) report.gate = value.gate;
    // A refusal that names its next tool keeps it on the delivery answer (compactDelivery keeps these too).
    if (value.code) report.code = value.code;
    if (value.continuation) report.continuation = value.continuation;
    if (Array.isArray(value.openModules)) report.openModules = value.openModules;
    if (Array.isArray(value.candidates)) report.candidates = value.candidates;
    // primeira-certa A3: every problem of every phase (grouped only to fit the answer), verifyRan and the phases.
    // The job the refusal ran: a problem that only follows from another failed op of it is summarized (CASCADE).
    if (Array.isArray(value.problems)) Object.assign(report, refusalFields(value.problems, value, { job: jobDocument, jobFile: typeof job === 'string' ? job : null }));
    else Object.assign(report, diagnosisOf(value));
    if (Array.isArray(value.divergences)) report.divergences = value.divergences.slice(0, 50);
  };
  const call = async (step, fn, extra = {}) => {
    stage = step;
    progress(step);
    const begin = Date.now();
    let value = await fn();
    if (step === 'merge') value = withMergeCode(value);
    report.steps.push({ step, ...extra, seconds: (Date.now() - begin) / 1000, ok: value.ok === true, ...(value.cached ? { cached: true } : {}) });
    if (value.ok !== true) {
      refuse(step, value);
      // The module changed between the capture and the merge (the person edited it): nothing was merged, and the same call
      // again captures the module as it is now.
      if (step === 'merge' && value.code === 'BASE_DRIFT' && !report.continuation)
        report.continuation = { tool: 'studio_deliver', arguments: { feature, module, job, owners, changes, ...(Number.isInteger(pid) ? { pid } : {}),
          ...(publish === true ? { publish: true, ...(typeof authorize === 'string' && authorize.trim() ? { authorize } : {}) } : {}) },
          why: 'The open module changed after the capture; nothing was merged. The same delivery again builds on the module as it is now.' };
      // A merge the bridge proved equal but for known losses (merge order: defaults the Studio removed, delete rules it
      // forced to Ignore, properties it normalizes) is merged and not uncertain: the answer carries each element with its
      // repair, declaration or normalization.
      if (step === 'merge' && value.outcome === 'incomplete' && value.merged === true) {
        report.merged = true;
        report.code ??= 'MERGE_INCOMPLETE';
        for (const key of ['missing', 'repair', 'forcedDeleteRules', 'declare', 'normalized', 'afterSnapshot']) if (value[key] != null) report[key] = value[key];
        // The repair is a job of its own (each element exists now, so a merge keeps a default set on it): written next to
        // this delivery's evidence and delivered by the same tool over the module as it is now, a new capture and lab.
        if (claimed && Array.isArray(value.repair?.ops) && value.repair.ops.length) {
          report.repairJob = path.join(output, 'repair.json');
          fs.writeFileSync(report.repairJob, JSON.stringify(value.repair, null, 2));
          const lost = (Array.isArray(value.missing) ? value.missing : []).map(m => 'Default ' + m?.element + ' = ' + m?.value);
          report.continuation = { tool: 'studio_deliver', arguments: { feature, module, job: report.repairJob, owners,
            changes: lost.length ? lost : ['Repair of ' + feature], ...(Number.isInteger(pid) ? { pid } : {}) },
            why: 'The merge kept everything but the named default values; this delivers the repair job the bridge computed over the module as it is now. Never repeat the original delivery.' };
        }
      }
      return null;
    }
    return value;
  };
  // An uncertain merge names each divergence (element, property, local, candidate): the bridge's own list, or the dump.
  const nameDivergences = () => {
    if (report.outcome !== 'uncertain' || report.divergences || !report.manifest) return;
    try {
      const evidence = evidenceDirOf(report.manifest);
      const file = evidence && path.join(evidence, 'native-equivalence.txt');
      if (file && fs.existsSync(file)) { const found = divergencesOf(fs.readFileSync(file, 'utf8')); if (found.length) report.divergences = found; }
    } catch { /* the answer stays as it is */ }
    if (report.divergences?.length && !/\n.+ \(.+\): /.test(report.error ?? '')) report.error = withoutStack(report.error) + '\n' + report.divergences.slice(0, 20).map(divergenceLine).join('\n');
  };
  // C16 G-3: an uncertain merge that ran is integrated in the open module. The bridge says so (merged:true, bridges with
  // merge:normalized), or the evidence does (merge-started.json and native-return.json: CompareAndMerge returned, for the
  // v39 bridge and older). Then the answer keeps merged:true, and its continuation is a read of this delivery's evidence,
  // never the same delivery: "já integrado; não repita".
  const mergedHonestly = () => {
    let ran = report.refusal?.merged === true || report.merge?.merged === true || report.merged === true;
    if (!ran && report.manifest) {
      try { const evidence = evidenceDirOf(report.manifest); ran = !!evidence && fs.existsSync(path.join(evidence, 'merge-started.json')) && fs.existsSync(path.join(evidence, 'native-return.json')); }
      catch { ran = false; }
    }
    if (!ran) return;
    report.merged = true; report.equivalence = 'uncertain';
    if (!/already integrated/.test(report.error ?? '')) report.error = 'The merge ran and is already integrated in the open module (merged:true); do not repeat this delivery. '
      + 'Some differences from the candidate remain unexplained: read them before any new change.\n' + withoutStack(report.error ?? '');
    report.continuation = { tool: 'ssam_evidence', arguments: { file: path.join(output, 'deliver-result.json'), pointer: '/divergences' },
      why: 'Já integrado; não repita a entrega. Leia as diferenças que restaram (elemento, propriedade, local, candidato) antes de qualquer nova mudança.' };
  };
  // Merge order, pass 2 failed after pass 1 merged: the module has every element of the candidate, without the deferred
  // defaults. The answer names the pass, keeps merged:true, and (unless pass 2 itself ran uncertain or the bridge gave its
  // own repair) continues with the repair job: each element exists now, so a merge keeps a default set on it.
  let order2Failed = false;
  const secondPassFailed = () => {
    if (order2Failed || !report.mergeOrder?.firstPass) return;
    order2Failed = true;
    report.mergeOrder.failedPass = 2;
    report.merged = true;
    report.ok = false;
    report.code ??= 'MERGE_ORDER_INCOMPLETE';
    const deferred = order?.deferred ?? [];
    report.error = 'Merge order pass 2 of 2 (the deferred defaults onto the elements pass 1 created): ' + withoutStack(report.error ?? 'refused')
      + '\nPass 1 is merged: the module has every element of the candidate, without the default value(s) '
      + deferred.map(d => d.element + ' = ' + d.value).join(', ') + '. Never repeat the original delivery.';
    if (report.equivalence === 'uncertain' || report.repairJob || !claimed || !deferred.length) return;
    report.repair = mergeOrderRepairJob(deferred);
    report.repairJob = path.join(output, 'repair.json');
    try { fs.writeFileSync(report.repairJob, JSON.stringify(report.repair, null, 2)); } catch { /* the answer carries it */ }
    report.continuation = { tool: 'studio_deliver', arguments: { feature, module, job: report.repairJob, owners,
      changes: deferred.map(d => 'Default ' + d.element + ' = ' + d.value), ...(Number.isInteger(pid) ? { pid } : {}) },
      why: 'Pass 1 of the merge order is merged; this delivers the deferred default values onto the elements it created, over the module as it is now. Never repeat the original delivery.' };
  };
  try {
    // I6: the documents an integration op names (WSDL, OpenAPI, samples) are pinned and its destructive words checked
    // before anything is captured (integration-documents.mjs); a refusal stops here, nothing captured or sent.
    const prepare = deps.prepareIntegrationJob ?? (await import('./integration-documents.mjs').catch(() => null))?.prepareIntegrationJob;
    if (prepare) {
      stage = 'documents';
      const prepared = await prepare(job, { lane: 'odc', words: authorize ?? '', localRoot: path.join(root, '.local') });
      if (prepared?.ok !== true) { refuse('documents', prepared ?? { error: 'The integration documents of the job could not be prepared.' }); return report; }
      if (typeof prepared.job === 'string' && prepared.job && path.resolve(prepared.job) !== job) {
        job = path.resolve(prepared.job); report.job = job; jobDocument = readJob(job); requestedProducers = producersOf(jobDocument);
      }
      if (Array.isArray(prepared.documents) && prepared.documents.length) report.documents = prepared.documents.slice(0, 32);
    }
    // The prototype op (docs/PROTOTIPO-NATIVO.md 1.1): captured before the Studio is touched (data.capture,
    // data.captureSha256); a refusal of the prototype is the answer, ONCE, with every problem, the patch over
    // /ops/<i>/data and the corrected call.
    if (hasPrototypeOps(jobDocument)) {
      stage = 'prototype';
      const expand = deps.expandPrototype ?? (file => expandJobFile(file, { inlineDir: path.join(root, '.local', 'jobs', 'inline'),
        work: path.join(root, '.local', 'prototype', randomUUID()), capture: deps.capturePrototype ?? capturePrototype }));
      const expanded = await expand(job);
      if (expanded?.refusal) {
        const { ok: _ok, failed: _failed, ...fields } = expanded.refusal;
        Object.assign(report, fields, { failed: 'prototype' });
        if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
        return report;
      }
      if (expanded?.path) {
        proto = { ...expanded.expansion, original: job, measure: deps.measureFidelity ?? null };
        job = path.resolve(expanded.path); report.job = job; jobDocument = readJob(job); requestedProducers = producersOf(jobDocument);
      }
    }
    // The base is ALWAYS the module as it is now in the Studio: a fresh capture of the open model at every delivery
    // (bridge snapshot = SaveToMemoryStream of the live ESpace, hash-named), never a cached candidate or the manifest of an
    // earlier delivery. An edit the person made in the Studio, or an earlier uncertain merge, is in this capture; the merge
    // proves natively that the open module still equals it before CompareAndMerge.
    // primeira-certa A3: no preflight of the job alone before it. The capture is a read; the apply over it (the build)
    // refuses once with every problem of every phase (preflight, base, apply, Verify), before the merge, the only write.
    const snapshot = await call('snapshot', () => studio(['snapshot', module], pid));
    if (!snapshot) {
      // C31, now only a shortcut: no base could be had, so the job alone (anvil-odc check-job) is read and its problems
      // answer, with verifyRan false and the reason; the failure of the capture stays in refusal and continuation.
      if (check) {
        let checked = null;
        try { checked = await check({ job }); } catch (error) { checked = { ok: true, skipped: withoutStack(error.message) }; }
        if (checked?.ok === false) {
          const capture = report.error;
          report.failed = 'preflight'; report.code = checked.code ?? 'PREFLIGHT_REFUSED';
          Object.assign(report, refusalFields(Array.isArray(checked.problems) ? checked.problems : [], { verifyRan: false,
            verifyReason: 'the module could not be captured (' + clipLine(capture) + '): only the job was read, so the base check, the apply and the Verify did not run' }, { job: jobDocument }));
          report.error = withoutStack(checked.error) ?? 'The job preflight refused the job.';
          if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
        }
      }
      return report;
    }
    // The open module the capture names: the request may carry the app name the person sees ("QuizLive Web").
    if (typeof snapshot.module === 'string' && snapshot.module && snapshot.module !== module) {
      report.requestedModule = module; report.module = module = snapshot.module;
    }
    report.snapshot = { path: snapshot.path, sha256: snapshot.sha256, host: snapshot.host, ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}) };
    if (snapshot.appLinks) report.appLinks = snapshot.appLinks;
    warm(snapshot.path);
    if (until === 'snapshot') { report.ok = true; return report; }
    // Refusals before any build, all at once: what the Studio itself would not keep, and a publication without words.
    stage = 'preflight';
    const kind = typeof snapshot.kind === 'string' ? snapshot.kind : catalogKind(catalog(), snapshot.moduleKey);
    const problems = kind === 'app' ? publicStructureProblems(collectJobOps(jobDocument, path.dirname(job)), { module }) : [];
    let authorization = null;
    if (publish === true) {
      authorization = await publishAuthorization({ authorize, module, requested: report.requestedModule }, deps.grants !== undefined ? deps.grants : await standingGrants());
      if (!authorization) problems.push({ op: null, pointer: null, code: 'PUBLISH_AUTHORIZATION_REQUIRED', severity: 'error',
        message: 'publish:true needs the user\'s own words in authorize, or a standing grant for ' + module + '; nothing was built or merged.',
        fix: 'Repeat with authorize: the user\'s words that name ' + module + ' (quoted, not a paraphrase), or ask for a standing grant (ssam_grant).', patch: null });
    }
    if (problems.length) {
      report.failed = 'preflight'; report.code = problems.length === 1 ? problems[0].code : 'PREFLIGHT_REFUSED'; report.problems = problems;
      report.error = problems.map(p => p.message + ' Fix: ' + p.fix).join('\n');
      if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
      return report;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    // Atomic claim. Two deliveries of one customer at once (lane wp: builds in parallel) may have computed the same next lab
    // folder: the one that loses takes the next free one; an output the caller named is never replaced.
    for (let attempt = 0; ; attempt++) {
      try { fs.mkdirSync(output); break; }
      catch (error) { if (error?.code !== 'EEXIST' || input.output || attempt >= 50) throw error; output = path.resolve(root, nextLabDir(feature)); }
    }
    claimed = true; report.evidence = output;
    const producers = {};
    // F5 (producer-signatures.mjs, the family rule of producer signatures): the reference snapshot of a producer this
    // workspace acquired lately in this environment, with no publication of it recorded since, is reused for the build
    // (no acquisition); it is acquired again right before the merge, the only write, and must have the same bytes. Only
    // a delivery that merges in this call reuses: one that stops at build, check-base or preview hands its manifest to a
    // later studio_merge that acquires nothing, so its build acquires the producer now (as before F5).
    const reusedProducers = [];
    for (const producer of requestedProducers) {
      const destination = path.join(output, producer + '.avsig');
      const reused = signatureCache && until === 'merge' ? reuseOdcReference(signatureCache, { environment: snapshot.host, producer, target: destination }) : null;
      if (reused) {
        producers[producer] = destination;
        reusedProducers.push({ name: producer, path: destination, sha256: reused.sha256 });
        (report.producers ??= []).push({ name: producer, path: destination, sha256: reused.sha256, producerKey: reused.producerKey, revision: reused.revision,
          reused: true, observed: 'ledger', observedAtUtc: reused.observedAtUtc });
        continue;
      }
      const captured = await call('reference-snapshot', async () => withBridgeUpgrade(await studio(['reference-snapshot', JSON.stringify({ module, producer, output: destination })], pid), producer));
      if (!captured) return report;
      if (captured.environment?.toLowerCase() !== snapshot.host?.toLowerCase() || captured.consumerUnchanged !== true)
        throw new Error('Producer acquisition did not prove the expected environment and unchanged consumer');
      const bytes = fs.readFileSync(destination);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== captured.sha256?.toLowerCase()) throw new Error('Captured producer signature hash differs: ' + producer);
      producers[producer] = destination;
      (report.producers ??= []).push({ name: producer, path: destination, sha256: digest, producerKey: captured.producerKey, revision: captured.revision });
      if (signatureCache) rememberOdcReference(signatureCache, { environment: snapshot.host, producer, file: destination, sha256: digest, producerKey: captured.producerKey ?? null, revision: captured.revision ?? null });
    }
    let kernelRefused = null, candidate = null;
    const built = await call('build', async () => {
      // I1: the capture's content identity keys the delivery cache and the worker's base cache; the base stays this capture.
      const based = { ...snapshot, contentSha256: await baseContentSha256(snapshot, deps) };
      const key = cache ? (() => { try { return cache.key({ job, snapshot: based, producers: report.producers ?? [] }); } catch { return null; } })() : null;
      let applied = key ? cache.restore(key, output) : null;
      if (applied) report.cache = { hit: true, key };
      else if (proto) {
        // 1.4.1: a build problem on a generated item rebuilds ONCE without it; a second failure is an SSAM defect.
        const begin = Date.now();
        const b = await buildWithDegradation({ jobFile: job, attempt: file => apply({ job: file, snapshot: based, output, producers }), ok: a => a?.ok === true,
          problemsOf: buildProblems, inlineDir: path.join(root, '.local', 'jobs', 'inline'), journal: journalTo(path.join(root, '.local', 'journal'), { lane: 'odc' }) });
        applied = b.result; proto.degraded = b.degraded; proto.buildMs = Date.now() - begin;
        if (b.refusal) { protoRefusal = b.refusal; applied = { ...applied, ok: false, code: 'VALIDATION_REFUSED', error: b.refusal.error, problems: b.refusal.problems }; }
        else if (b.rebuilt) { job = path.resolve(b.jobFile); report.job = job; }
        if (key) report.cache = { hit: false, key };
        if (applied.ok && key) cache.store(key, output);
      } else {
        applied = await apply({ job, snapshot: based, output, producers });
        if (key) report.cache = { hit: false, key };
        if (applied.ok && key) cache.store(key, output);
      }
      if (applied.kernel) report.kernel = applied.kernel;
      // A03 (I9): the warnings that block nothing come back in the answer, in a refusal with errors too.
      capped(report, 'warnings', applied.warnings ?? []);
      const high = (applied.warnings ?? []).filter(w => w?.severity === HIGH);
      if (high.length) report.highWarnings = high.slice(0, 20);
      if (!applied.ok) {
        kernelRefused = applied;
        // data.bind (2.12): the proposals of PROTOTYPE_BINDING_REQUIRED as one strict patch and the corrected call
        if (proto && applied.code === 'PROTOTYPE_BINDING_REQUIRED') return { ...applied, ...bindingCorrection(applied.problems, readJobDocument(proto.original)) };
        return { ...applied, code: applied.code ?? 'KERNEL_REFUSED' };
      }
      report.kernelReceipt = applied.receipt; candidate = applied.candidate;
      capped(report, 'leftovers', applied.leftovers ?? []);
      if (applied.normalizations) report.normalizations = applied.normalizations;
      capped(report, 'screenRoles', applied.screenRoles ?? []);
      capped(report, 'removed', applied.removed ?? []);
      capped(report, 'integration', Array.isArray(applied.integration) ? applied.integration : [], 10);
      if (applied.entityActions) report.entityActions = applied.entityActions;
      // The merge order (planMergeOrderKernel): a candidate with defaults the Studio drops when the merge creates their
      // elements goes in two merges of this call; the bridge never receives a merge whose own plan is not empty. A plan
      // that cannot be computed keeps the single merge of before, and says so.
      let deliverable = applied.candidate, manifestDir = path.join(output, 'delivery');
      if (planOrder && until === 'merge') {
        let plan;
        try { plan = await planOrder({ base: snapshot.path, candidate: applied.candidate, output }); }
        catch (error) { plan = { ok: false, error: withoutStack(error.message) }; }
        if (plan?.ok === true && Array.isArray(plan.deferred) && plan.deferred.length && plan.firstPass) {
          order = { deferred: plan.deferred, firstPass: plan.firstPass };
          report.mergeOrder = { passes: 2, deferred: plan.deferred.map(d => d.element) };
          try { fs.writeFileSync(path.join(output, 'merge-order.json'), JSON.stringify(plan, null, 2)); } catch { /* evidence only */ }
          deliverable = plan.firstPass; manifestDir = path.join(output, 'delivery-first-pass');
        } else if (plan?.ok !== true) report.mergeOrder = { passes: 1, skipped: plan?.error ?? 'merge-order gave no plan' };
      }
      const prepared = withManifestCode(await prepareManifest({ base: snapshot.path, candidate: deliverable, output: manifestDir, feature, owners, changes }));
      return prepared?.ok === false ? { ...prepared, code: prepared.code ?? 'CANDIDATE_REFUSED', ...(report.cache?.hit ? { cached: true } : {}) } : { ...prepared, ...(report.cache?.hit ? { cached: true } : {}) };
    });
    if (!built) {
      if (kernelRefused?.code === 'PREFLIGHT_REFUSED') report.failed = 'preflight';
      // The second failure of a prototype build: an SSAM defect with the mapping.ignore patch over the model's own job.
      if (protoRefusal) {
        for (const key of ['ssamDefect', 'patch', 'correctedJob', 'degraded']) if (protoRefusal[key] != null) report[key] = protoRefusal[key];
        report.problems = protoRefusal.problems; report.code = 'VALIDATION_REFUSED'; report.error = protoRefusal.error;
        if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
        return report;
      }
      if (kernelRefused && guide) {
        try { const g = await guide({ lane: 'odc', job, run: { ok: false, result: { error: kernelRefused.error }, resultFile: kernelRefused.receipt ?? null } }); if (g) report.discovery = g; }
        catch { /* guidance never changes the delivery answer */ }
      }
      if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
      return report;
    }
    warm(candidate);
    report.manifest = built.manifest;
    if (!report.manifest) throw new Error('Build succeeded without a manifest; delivery stopped.');
    // The receipt of a prototype import: the kernel's report.prototype and the fidelity measured on the module read back
    // after the Verify (prototype-dom.json), before the merge; merge, publish and seed timings are added after them.
    if (proto) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(path.join(output, 'kernel-result.json'), 'utf8')).data ?? null; } catch { data = null; }
      const kernelReport = kernelPrototypeReport(data);
      const measured = await measurePrototypeFidelity({ captures: proto.captures, measure: proto.measure,
        nativeDom: findNativeDom({ report: kernelReport, captures: proto.captures, dirs: [output, path.join(output, 'work')] }) });
      // The link of each screen, from the app URL the capture of the module named (appLinks).
      const links = prototypeScreenLinks(kernelReport, prototypeAppUrl({ lane: 'odc', appLinks: report.appLinks }));
      proto.receipt = prototypeReceipt(kernelReport, { fidelity: measured.fidelity, degraded: proto.degraded ?? [], captures: proto.captures, warnings: proto.warnings ?? [],
        verify: data?.validation?.new ?? null, links, phases: { captureMs: proto.timings?.captureMs, buildMs: proto.buildMs ?? data?.applyMs, fidelityMs: measured.fidelityMs } });
      if (proto.receipt.timings.expandMs == null && proto.timings?.expandMs != null) proto.receipt.timings.expandMs = proto.timings.expandMs;
      report.prototype = proto.receipt;
    }
    if (until === 'build') { report.ok = true; return report; }
    // F5: each reference snapshot the build reused is acquired again before the merge; another revision (the producer was
    // published since) stops here with PRODUCER_CHANGED, nothing merged, its observation dropped, and the same delivery again.
    // (A build reuses only when this call merges, so every reused snapshot is acquired again here.)
    if (until === 'merge' && reusedProducers.length) {
      for (const reused of reusedProducers) {
        const fresh = path.join(output, reused.name + '.recheck.avsig');
        const captured = await call('reference-snapshot', async () => withBridgeUpgrade(await studio(['reference-snapshot', JSON.stringify({ module, producer: reused.name, output: fresh })], pid), reused.name), { beforeMerge: true });
        if (!captured) { if (publish === true) report.publish = { requested: true, outcome: 'skipped' }; return report; }
        if (captured.environment?.toLowerCase() !== snapshot.host?.toLowerCase() || captured.consumerUnchanged !== true)
          throw new Error('Producer acquisition did not prove the expected environment and unchanged consumer');
        const digest = sha256(fs.readFileSync(fresh));
        if (digest !== captured.sha256?.toLowerCase()) throw new Error('Captured producer signature hash differs: ' + reused.name);
        if (digest !== reused.sha256) {
          forgetOdcReference(signatureCache, { environment: snapshot.host, producer: reused.name });
          report.failed = 'reference-snapshot'; report.code = 'PRODUCER_CHANGED';
          report.error = 'The producer ' + reused.name + ' was published again after the reference snapshot the build reused (revision ' + (captured.revision ?? 'unknown') + ' now). Nothing was merged.';
          report.continuation = { tool: 'studio_deliver', arguments: { feature, module, job: input.job, owners, changes, ...(Number.isInteger(pid) ? { pid } : {}),
            ...(publish === true ? { publish: true, ...(typeof authorize === 'string' && authorize.trim() ? { authorize } : {}) } : {}) },
            why: 'A mesma entrega de novo adquire a versão nova do produtor e constrói sobre ela; nada foi gravado.' };
          if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
          return report;
        }
        rememberOdcReference(signatureCache, { environment: snapshot.host, producer: reused.name, file: fresh, sha256: digest, producerKey: captured.producerKey ?? null, revision: captured.revision ?? null });
        const entry = report.producers.find(p => p.name === reused.name && p.reused === true);
        if (entry) entry.beforeMerge = 'acquired';
      }
    }
    if (order) {
      // Merge order, pass 1: the candidate without its deferred defaults creates the elements (the bridge's own plan finds
      // no default on an element it creates, so it runs one plain merge).
      const first = await call('merge', () => studio(['merge', report.manifest], pid), { pass: 1 });
      const proven = first && first.merged === true && (first.strictlyEqual === true || first.equivalence === 'normalized');
      if (!proven) {
        report.mergeOrder.failedPass = 1;
        if (first) {
          report.merge = first; report.failed = 'merge'; report.outcome = 'uncertain'; report.code = 'MERGE_UNCERTAIN';
          report.error = 'Merge did not confirm merged and strictlyEqual; read receipts and journal before any new attempt.';
        }
        if (report.outcome === 'uncertain') { report.code ??= 'MERGE_UNCERTAIN'; mergedHonestly(); }
        nameDivergences();
        report.error = 'Merge order pass 1 of 2 (the candidate without its deferred defaults): ' + (report.error ?? 'merge refused');
        if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
        return report;
      }
      report.merged = true;
      report.mergeOrder.firstPass = { manifest: report.manifest, equivalence: first.equivalence ?? (first.strictlyEqual ? 'strict' : null),
        ...(Array.isArray(first.normalized) ? { normalized: first.normalized.slice(0, 20) } : {}) };
      // Pass 2: the full candidate over the module as pass 1 left it, a new capture; the elements exist now, so the bridge's
      // plan is empty again and the defaults are merged onto them.
      const again = await call('snapshot', () => studio(['snapshot', module], pid), { pass: 2 });
      if (!again) { secondPassFailed(); return report; }
      const rebuilt = await call('build', async () => {
        const prepared = withManifestCode(await prepareManifest({ base: again.path, candidate, output: path.join(output, 'delivery'), feature, owners, changes }));
        return prepared?.ok === false ? { ...prepared, code: prepared.code ?? 'CANDIDATE_REFUSED' } : prepared;
      }, { pass: 2 });
      if (!rebuilt) {
        if (report.code === 'NO_CHANGE') {
          // The module already equals the full candidate after pass 1: delivered by it.
          for (const key of ['failed', 'error', 'refusal', 'code']) delete report[key];
          report.mergeOrder.secondPass = 'no change: the module equals the candidate after pass 1';
          report.merge = first; report.strictlyEqual = first.strictlyEqual === true; report.equivalence = report.mergeOrder.firstPass.equivalence ?? 'strict';
          report.result = 'entregue'; report.ok = true;
        } else { secondPassFailed(); return report; }
      } else report.manifest = rebuilt.manifest;
    }
    for (const step of (report.ok && order ? [] : studioSteps(until))) {
      const value = await call(step, () => studio([step, report.manifest], pid), order && step === 'merge' ? { pass: 2 } : {});
      if (!value) {
        if (step === 'merge') {
          if (report.outcome === 'uncertain') { report.code ??= 'MERGE_UNCERTAIN'; mergedHonestly(); }
          nameDivergences();
          if (order) secondPassFailed();
        }
        if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
        return report;
      }
      report[step === 'check-base' ? 'checkBase' : step] = value;
      if (step === 'preview' && (value.conflicts || value.noDifferences)) {
        report.failed = step; report.error = value.conflicts ? 'Preview has conflicts; merge stopped.' : 'Candidate has no changes; merge stopped.';
        report.code = value.conflicts ? 'MERGE_CONFLICT' : 'NO_CHANGE';
        return report;
      }
      if (step === 'merge') {
        report.merged = value.merged === true; report.strictlyEqual = value.strictlyEqual === true;
        // C16 G-1 (I8): the bridge proved the module equal to the candidate but for rewrites the ODC Studio makes on every
        // merge (a block instance's derived name, Max. Records of a Data Action refresh, a FontAwesome icon converted to
        // Phosphor, a delete rule forced to Ignore): delivered, with one note per element.
        if (report.merged && value.equivalence === 'normalized' && Array.isArray(value.normalized)) {
          report.equivalence = 'normalized';
          capped(report, 'normalized', value.normalized);
          if (Number.isInteger(value.normalizedTotal) && value.normalizedTotal > (report.normalized?.length ?? 0)) report.normalizedTotal = value.normalizedTotal;
        } else if (report.merged && report.strictlyEqual) report.equivalence = 'strict';
        if (!report.merged || (!report.strictlyEqual && report.equivalence !== 'normalized')) {
          report.failed = step; report.outcome = 'uncertain'; report.code = 'MERGE_UNCERTAIN';
          report.error = 'Merge did not confirm merged and strictlyEqual; read receipts and journal before any new attempt.';
          mergedHonestly();
          if (order) secondPassFailed();
          if (publish === true) report.publish = { requested: true, outcome: 'skipped' };
          return report;
        }
        report.result = 'entregue';
      }
      if (until === step) report.ok = true;
    }
    if (report.ok && report.result === 'entregue') {
      // What the job created or changed (job-summary.mjs), so no map of the module follows the delivery.
      try { const summary = jobSummary(jobDocument); if (summary) report.summary = summary; } catch { /* a summary never changes the delivery */ }
      if (publish === true) {
        // The same call publishes the merged module: the words go into the manifest, the publication is followed to its end.
        stage = 'publish'; progress('publish');
        report.authorization = authorization.authorization;
        const begin = Date.now();
        // F5: the module may be a producer of other modules; no reference snapshot of it acquired before the end of this
        // publication is reused (an uncertain one stays running for the ledger).
        const publication = signatureCache ? recordPublished(signatureCache, { environment: snapshot.host, module, source: 'studio_deliver' }) : false;
        const published = await publishStep({ manifest: report.manifest, module, words: authorization.words, pid }, { studio });
        if (publication && !publicationOpen(published?.publish)) recordPublicationEnded(publication);
        report.steps.push({ step: 'publish', seconds: (Date.now() - begin) / 1000, ok: published.publish?.outcome === 'published' });
        report.publish = published.publish;
        if (published.lastPublication) report.lastPublication = published.lastPublication;
        if (report.publish.outcome === 'published') { report.result = 'entregue e publicado'; report.publishInvoked = true; }
        else {
          // Delivered; the publication did not end well. Never repeat the delivery: the continuation is the publication only.
          report.ok = false; report.failed = 'publish'; report.publishInvoked = report.publish.outcome !== 'refused';
          report.code = report.publish.outcome === 'uncertain' ? 'PUBLISH_UNCERTAIN' : 'PUBLISH_FAILED';
          if (report.publish.outcome === 'uncertain') report.outcome = 'uncertain';
          report.error = report.publish.error ?? 'The publication did not succeed.';
          report.continuation = { tool: 'studio_publish', arguments: { manifest: report.manifest, ...(Number.isInteger(pid) ? { pid } : {}) },
            why: report.publish.outcome === 'uncertain' ? 'Merged; the publication result is unknown: read publish-log first and publish again only if it did not run. Never repeat the delivery.'
              : 'Merged; fix what the publication names, then publish this manifest again. Never repeat the delivery.' };
        }
        // The demo data of a prototype import (3.4): after a clean publication, into the empty regular entities the import
        // marked, through the Studio's data service (studio_data_insert), with the words of this call only.
        if (proto?.receipt) {
          proto.receipt.timings.publishMs = Date.now() - begin;
          const mergeStep = report.steps.filter(s => s.step === 'merge').reduce((n, s) => n + (s.seconds ?? 0), 0);
          if (mergeStep) proto.receipt.timings.mergeMs = Math.round(mergeStep * 1000);
          const previous = stage; stage = 'seed'; progress('seed');
          let seed;
          try {
            seed = await seedPrototypeData({ lane: 'odc', module, receipt: proto.receipt, bundle: proto.captures?.[0]?.capture,
              write: deps.prototypeWriter ?? odcDataWriter({ studio, pid, dir: output }),
              authorize: authorization?.authorization?.source === 'standing-grant' ? '' : authorization?.words, published: report.publish.outcome === 'published',
              seed: (d => (Array.isArray(d) ? d : d?.ops ?? []))(readJob(proto.original)).find(op => op?.op === 'prototype')?.data?.seed !== false });
          } catch (error) { seed = { ran: false, reason: 'the seed failed: ' + withoutStack(error.message), entities: 0, rows: 0, skippedNotEmpty: [] }; }
          proto.receipt = receiptWithSeed(proto.receipt, seed);
          report.prototype = proto.receipt;
          stage = previous;
        }
      } else {
        // The last publication of the module, whoever started it (the bridge's publish log), from one status read.
        try {
          const status = await studio(['status', 'modules'], pid);
          const entry = (Array.isArray(status?.value) ? status.value : []).find(m => m?.name === module);
          const last = lastPublicationFrom(entry?.lastPublish);
          if (last) report.lastPublication = last;
        } catch { /* informative only */ }
      }
    }
    return report;
  } catch (error) {
    report.failed = stage; report.error = withoutStack(error.message);
    if (stage === 'merge') { report.outcome = 'uncertain'; report.code = 'MERGE_UNCERTAIN'; mergedHonestly(); }
    if (order && stage !== 'publish' && report.mergeOrder?.firstPass) secondPassFailed();
    else if (order && stage === 'merge') { report.mergeOrder.failedPass = 1; report.error = 'Merge order pass 1 of 2 (the candidate without its deferred defaults): ' + report.error; }
    if (stage === 'publish') { report.outcome = 'uncertain'; report.code = 'PUBLISH_UNCERTAIN'; report.ok = false; }
    return report;
  } finally {
    report.totalSeconds = (Date.now() - started) / 1000;
    if (claimed) {
      try { fs.writeFileSync(path.join(output, 'deliver-result.json'), JSON.stringify(report, null, 2)); }
      catch (error) { report.receiptError = error.message; }
    }
    journal({ start: new Date(started).toISOString(), tool: 'facade', command: 'deliver-job', module, feature,
      outcome: report.ok ? 'ok' : report.outcome ?? 'gate_refused', ...(report.gate ? { gate: report.gate } : {}), ...(report.failed ? { failed: report.failed } : {}),
      ...(report.evidence ? { evidence: report.evidence } : {}), note: report.error ?? report.manifest ?? 'snapshot only' });
  }
}

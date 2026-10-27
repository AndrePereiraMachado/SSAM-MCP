// The build phase of o11_deliver (lane wp of the atritos 3 package; studio-write-lock.mjs "Build and apply phases").
// In a phased call (the ssam server passes phased:true), before the Studio is taken:
//   1. the module open in the selected Service Studio is captured by its key, without selecting its tab
//      (list_open_modules, then snapshot_module {module_key}: bridge C41), so another delivery's apply of another module
//      of the same Studio runs meanwhile; when the tab's model fingerprint equals a capture the server already holds
//      (o11-capture-store.mjs, speed lane vel-entrega), that capture is copied instead: nothing is captured or uploaded;
//   2. the kernel applies the job to that capture headless (`anvil apply`), in a slot of the build pool (build-pool.mjs:
//      SSAM_BUILD_WORKERS slots, each with its resident worker on base + i * poolStep and its own TEMP);
//   3. the accepted candidate becomes a prebuilt manifest (ssam-prebuilt/1) next to it.
// Then the delivery runs as always (`anvil deliver`, under the Studio lock: open, snapshot, merge, verify) with
// --prebuilt: the kernel reuses the candidate only when its own snapshot has the same model as the build's capture, the
// job and producer files are unchanged and the same kernel built it (Anvil.Core.Delivery.PrebuiltCandidate); otherwise it
// rebuilds on the fresh snapshot in the same call (phases.rebased {reason}). A job the kernel refuses (preflight, or
// validation on the live module) is answered from the build: the Studio is never taken for it.
// R3 (módulo quente, plano 2026-10-24): the capture, the copy the build applies to and the kernel's hot module are one
// identity, the model hash of o11-capture-store.mjs (the kernel's BaseModelCache.ModelSha256, the rule of PrebuiltCandidate).
// Each build copies a known capture to a new file; the kernel's worker keeps a spare of that model (loaded while idle) and
// the reference inventories of the base and the candidate, and its result says so (hot {reused, reason, savedMs,
// modelSha256}). The manifest records the identity the build used (baseModelSha256) and the kernel's hot; a kernel that
// keyed its hot module by another identity is named there (hot.identity.same:false), never hidden.
// S9 (rascunho com candidato): a draft's write (code-draft.mjs) delivers inside withCheckedCandidate(offer): the candidate
// its joint check built on a local capture. When that capture has the model of the capture this build takes, the job the
// delivery runs is the job the check applied (the same JSON), the producer files are the same and the kernel accepted it,
// the manifest is written from that candidate and no `anvil apply` runs here; anything else builds as always and the offer
// says why it was not used (offer.outcome {reused:false, reason}). The kernel (PrebuiltCandidate) stays the last word: its own
// snapshot, the job's sources, the producers and the kernel that built it, else it rebuilds (phases.rebased).
// Affinity (build-pool.mjs): a build prefers the slot whose worker last held its model (a check on the lane's worker, slot 0,
// or an earlier build), and records the slot it ran on.
// The build phase is skipped (the delivery runs as before, wholly under the lock) outside a phased call, once the call
// holds the Studio, for resume, closePrevious and captureProducers (the kernel captures producers through the Studio),
// for integration ops (rest, rest-expose, soap: the Studio's own importer), and whenever the capture by key cannot be
// made (a module not open, still opening, two tabs with its name, an older bridge): never a refusal of its own.
//
// phaseGuards(ctx) wraps the Studio access of the cycle's context once: in a phased call, a bridge method that is not a
// read of the build (BUILD_BRIDGE_READS, snapshot_module with module_key) and any CLI verb but apply/check-job take the
// Studio first (enterApplyPhase), so nothing writes to the Studio without its lock.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { phaseOfCall, notePhase, phaseGuard } from './studio-write-lock.mjs';
import { pooledBuild, sharedBuildPool, BuildQueueRefused, slotWorkerPort, preferredSlots, rememberSlotModel } from './build-pool.mjs';
import { workspaceRoot } from './workspace.mjs';
import { hostedContext } from './executor.mjs';
import { findCapture, isModelSha, modelSha256, rememberCapture, rememberDelivery } from './o11-capture-store.mjs';

export const PREBUILT_SCHEMA = 'ssam-prebuilt/1';
// Bridge methods a build may call without the Studio lock: reads that never select a tab nor change a model.
export const BUILD_BRIDGE_READS = new Set(['list_open_modules', 'get_active_module', 'publish_log', 'ping', 'capabilities', 'version']);
export const isBuildBridgeCall = (method, params) => BUILD_BRIDGE_READS.has(method)
  || (method === 'snapshot_module' && typeof params?.module_key === 'string' && params.module_key.length > 0);
// CLI verbs that never reach the Studio.
export const BUILD_VERBS = new Set(['apply', 'check-job']);
const INTEGRATION_OPS = new Set(['rest', 'rest-expose', 'soap']);
const sha256Of = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const stampOf = date => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);

function guardClient(client) {
  if (!client || typeof client !== 'object') return client;
  return new Proxy(client, { get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    return (prop === 'ok' || prop === 'call') && typeof value === 'function' ? phaseGuard(value.bind(target), isBuildBridgeCall) : value;
  } });
}
// The cycle context with its Studio access guarded (see the header). Idempotent.
export function phaseGuards(ctx) {
  if (ctx.phaseGuarded) return ctx;
  const { runAnvil, bridge, capture } = ctx;
  return Object.assign(ctx, {
    phaseGuarded: true,
    runAnvil: phaseGuard(runAnvil, args => BUILD_VERBS.has(String(args?.[0] ?? ''))),
    bridge: () => guardClient(bridge()),
    // The o11_studio snapshot {module} opens and selects the module's tab: a Studio write.
    capture: capture ? phaseGuard(capture) : capture,
  });
}

// A job with an op that runs the Studio's own importer (or that cannot be read here) is built inside the delivery.
export function jobNeedsStudio(jobFile) {
  let document;
  try { document = JSON.parse(fs.readFileSync(jobFile, 'utf8').replace(/^﻿/, '')); } catch { return true; }
  if (document && !Array.isArray(document) && Array.isArray(document.jobs)) return true; // composite: its parts are read by the kernel
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  return ops.some(op => INTEGRATION_OPS.has(String(op?.op ?? '')));
}

// The module open in a tab, captured by its key without selecting it; null when that cannot be done here.
// Speed lane vel-entrega (o11-capture-store.mjs): the list asks for the tab's model fingerprint (model_sha256_of; a bridge
// without list_open_modules:model_sha256 ignores it). When a capture the server already holds has that model (the delivered
// snapshot of the previous delivery, the capture of a refused call, an o11_studio snapshot), it is copied to the build's
// file and nothing is captured or uploaded: {..., reused: {from, modelSha256}}. Any other case captures as before, and the
// new capture is recorded for the next call.
export async function captureByKey(module, { bridge, local, now = () => new Date(), signal }) {
  const client = bridge();
  const listed = await client.ok('list_open_modules', { model_sha256_of: String(module) }, { timeoutMs: 10000, ...(signal ? { signal } : {}) });
  const wanted = String(module).toLowerCase();
  const tabs = (Array.isArray(listed?.modules) ? listed.modules : []).filter(m => typeof m?.name === 'string' && m.name.toLowerCase() === wanted && m.hasESpace !== false);
  if (tabs.length !== 1) return null;
  const tab = tabs[0];
  if (typeof tab.key !== 'string' || !tab.key || tab.serverSilentMode === true || tab.hasOpenedActiveESpace === false) return null;
  const file = path.join(local, 'snapshots', 'build-' + tab.name.replace(/[^\w.-]/g, '_') + '-' + stampOf(now()) + '-' + randomUUID().slice(0, 8) + '.oml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fingerprint = isModelSha(tab.modelSha256) ? tab.modelSha256 : null;
  const known = fingerprint ? findCapture(local, { moduleKey: tab.key, model: fingerprint }) : null;
  if (known) {
    try {
      fs.copyFileSync(known.path, file);
      if (modelSha256(file) === fingerprint) {
        rememberCapture(local, { moduleKey: tab.key, module: tab.name, file, model: fingerprint, source: 'build-reused', now: now() });
        return { path: file, key: tab.key, module: tab.name, modelSha256: fingerprint, reused: { from: known.path, modelSha256: fingerprint } };
      }
    } catch { /* captured below */ }
    try { fs.rmSync(file, { force: true }); } catch { /* the capture below writes it again */ }
  }
  const data = await client.ok('snapshot_module', { path: file, module_key: tab.key }, signal ? { signal } : undefined);
  if (data?.key && data.key !== tab.key) return null;
  const captured = typeof data?.path === 'string' && data.path ? data.path : file;
  if (!isFile(captured)) return null;
  const model = rememberCapture(local, { moduleKey: tab.key, module: tab.name, file: captured, source: 'build', now: now() });
  return { path: captured, key: tab.key, module: tab.name, modelSha256: isModelSha(model) ? model : modelSha256(captured) };
}

// R3: the kernel's hot module of a build (JobRunner hot), with the identity check against the capture's model hash.
export function hotOfBuild(data, modelSha) {
  const hot = data && typeof data === 'object' && data.hot && typeof data.hot === 'object' ? data.hot : null;
  if (!hot) return null;
  const kernel = typeof hot.modelSha256 === 'string' ? hot.modelSha256 : null;
  return { reused: hot.reused === true, reason: hot.reason ?? null, savedMs: Number.isFinite(hot.savedMs) ? hot.savedMs : 0,
    ...(kernel || modelSha ? { identity: { capture: modelSha ?? null, kernel, same: !!kernel && kernel === modelSha } } : {}) };
}

// The runner of a slot: its resident worker (slot 0 is the lane's own worker; ANVIL_WORKER=0 runs cold) with the slot's
// TEMP and TMP.
export function slotRunner(slot, { root, env, lane, workspace }) {
  return async (args, options) => {
    const { createWorkerFirstRunner } = await import('./anvil-worker.mjs');
    const port = await slotPort(slot.index, { root, env, lane, workspace });
    return createWorkerFirstRunner({ root, env: { ...env, ...slot.env, ANVIL_WORKER_PORT: String(port) }, o11: lane })(args, options);
  };
}
// The worker port of a slot (null: the lane's own worker, as slot 0).
export async function slotPort(index, { root, env, lane, workspace }) {
  const { o11LaneOf } = await import('./o11-lane.mjs');
  const row = o11LaneOf(lane, { root, env });
  return index == null ? row.worker : slotWorkerPort(row.worker, index, { workspace: workspace ?? workspaceRoot });
}

// S9: the offer of a draft's write (code-draft.mjs), seen by the build of the delivery it makes.
const checkedCandidates = new AsyncLocalStorage();
export const withCheckedCandidate = (offer, fn) => checkedCandidates.run(offer, fn);
export const checkedCandidateOffer = () => checkedCandidates.getStore() ?? null;

const readJsonFile = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const sameFile = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
// The prebuilt manifest from a checked candidate, or {reason} when it cannot serve this build (see the header).
function fromCheckedCandidate(offer, { input, job, shot, folder, producers }) {
  const c = offer?.candidate;
  const no = (reason, extra = {}) => ({ outcome: { reused: false, reason, ...extra } });
  if (!c || typeof c !== 'object') return no('no-candidate');
  if (String(offer.module ?? '').toLowerCase() !== String(input.module ?? '').toLowerCase()) return no('other-module');
  const model = isModelSha(shot.modelSha256) ? shot.modelSha256 : modelSha256(shot.path);
  if (!isModelSha(c.baseModelSha256) || c.baseModelSha256 !== model)
    return no('capture-changed', { checkedModelSha256: c.baseModelSha256 ?? null, captureModelSha256: model });
  if (Object.getOwnPropertySymbols(input).some(s => s.description === 'basedOnJob')) return no('patched-delivery');
  if (!isFile(c.base) || modelSha256(c.base) !== model) return no('check-capture-missing');
  if (!isFile(c.path) || sha256Of(c.path) !== c.sha256) return no('candidate-changed');
  const checked = readJsonFile(c.result);
  if (checked?.isValid !== true || checked?.accepted !== true) return no('check-not-accepted');
  // The job the delivery runs is the JSON the check applied (the kernel reads JSON; a key order or a value that differs is
  // another job), and it reads no other file (its sources are the job alone).
  const document = readJsonFile(job), applied = readJsonFile(c.job);
  if (!document || !applied || JSON.stringify(document) !== JSON.stringify(applied)) return no('job-differs');
  const sources = Array.isArray(checked.sources) ? checked.sources : null;
  if (!sources || sources.length !== 1 || !sameFile(sources[0]?.path ?? '', c.job)) return no('job-reads-files');
  // The producers the check bound are the delivery's own (the kernel compares the manifest with the delivery's bindings).
  const bound = Object.entries(c.producers ?? {});
  if (bound.length !== producers.length || !producers.every(([name, file]) => bound.some(([n, f]) => n.toLowerCase() === String(name).toLowerCase() && sameFile(f, file))))
    return no('producers-differ');
  fs.mkdirSync(folder, { recursive: true });
  const candidate = path.join(folder, 'candidate.oml');
  fs.copyFileSync(c.path, candidate);
  const result = path.join(folder, 'candidate.result.json');
  // The kernel compares sources with the delivery's job file: the job file the check applied is replaced by that one, whose
  // JSON was just found equal.
  fs.writeFileSync(result, JSON.stringify({ ...checked, sources: [{ path: path.resolve(job), sha256: sha256Of(job) }] }, null, 2));
  const manifest = path.join(folder, 'prebuilt.json');
  const hot = hotOfBuild(checked, model);
  fs.writeFileSync(manifest, JSON.stringify({ schema: PREBUILT_SCHEMA, module: shot.module, moduleKey: shot.key, job, base: c.base, baseSha256: sha256Of(c.base),
    baseModelSha256: model, ...(hot ? { hot } : {}), candidate, candidateSha256: sha256Of(candidate), result,
    producers: Object.fromEntries(producers.map(([name, file]) => [name, { path: file, sha256: isFile(file) ? sha256Of(file) : null }])),
    builtAt: new Date().toISOString(), buildMs: 0,
    // what built it: the joint check of the draft, on a local capture of the same model (no apply ran here)
    checked: { candidate: c.path, result: c.result, job: c.job, base: c.base, via: c.via ?? null, ...(offer.jobSha256 ? { jobSha256: offer.jobSha256 } : {}) },
    ...(shot.reused ? { captureReused: shot.reused } : {}) }, null, 2));
  return { manifest, hot, outcome: { reused: true, from: 'check', manifest, via: c.via ?? null } };
}

// The customer whose builds share the pool fairly: the one named, the hosted call's token (servidor/fase4: every customer of
// the hosted server builds in one pool, a customer with ten builds queued never holds back another's single build),
// SSAM_CUSTOMER, else the lane root.
export const buildCustomer = ctx => ctx?.customer ?? hostedContext()?.tokenId ?? ctx?.env?.SSAM_CUSTOMER ?? ctx?.root;
// The validation contract of a candidate the kernel did not accept (JobRunner: isValid against expectedValid, the message
// expectations of the job, the data contract), as a refusal names it: which part said no, with its counts (VisitaCerta
// 2026-10-12: two refusals said only "job rejected by validation contract" and their records kept no problem). Null without
// the kernel's apply data.
// The Verify's errors the module already had before the job (validation.preexisting), when the job added none of its own:
// the only reason the candidate is invalid (re-check of 2026-10-12, probe K1: the refusal said "0 errors" and named nothing).
const errorsOf = list => (Array.isArray(list) ? list : []).filter(m => m && String(m.type ?? '').toLowerCase() === 'error');
const countsOf = list => { const byCode = {}; for (const p of list) { const code = String(p.code ?? p.id ?? 'unknown'); byCode[code] = (byCode[code] ?? 0) + 1; } return byCode; };
const countsText = byCode => Object.entries(byCode).map(([code, n]) => code + ' ' + n).join(', ');
function preexistingOnly(apply, errors) {
  const expectedValid = apply.expectedValid !== false;
  return expectedValid && apply.isValid === false && errors.length === 0 ? errorsOf(apply.validation?.preexisting) : [];
}

export function validationContract(apply) {
  if (!apply || typeof apply !== 'object') return null;
  const expectedValid = apply.expectedValid !== false;
  const verify = (Array.isArray(apply.problems) ? apply.problems : []).filter(p => p && p.phase === 'verify' && p.severity !== 'warning');
  const fresh = errorsOf(apply.validation?.new);
  const errors = verify.length ? verify : fresh;
  const byCode = countsOf(errors);
  const had = preexistingOnly(apply, errors);
  const unexpected = Array.isArray(apply.validation?.unexpected) ? apply.validation.unexpected.length : 0;
  const dataRefused = apply.dataContract?.accepted === false;
  const refactorRefused = apply.refactorProof?.accepted === false;
  const parts = [];
  if (apply.isValid !== undefined && apply.isValid !== expectedValid)
    parts.push(!expectedValid ? 'the Verify found the module valid and the job expects it invalid'
      : had.length ? 'the module already had ' + had.length + ' error' + (had.length === 1 ? '' : 's') + ' (' + countsText(countsOf(had)) + '), the job added none'
      : 'the Verify of the candidate: ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + (errors.length ? ' (' + countsText(byCode) + ')' : ''));
  if (unexpected) parts.push(unexpected + ' message' + (unexpected === 1 ? '' : 's') + ' no expectedMessages entry covers');
  if (dataRefused) parts.push('the data contract');
  // JobRunner: the references a refactor of the job relies on, compared after the save and a reload (Delivery.cs ValidationVerdict).
  if (refactorRefused) parts.push('the refactor proof (reference sets changed after save/reload)');
  return { name: 'validation', valid: apply.isValid ?? null, expectedValid, accepted: apply.accepted ?? null, verifyRan: apply.verifyRan ?? null,
    verifyErrors: errors.length, ...(errors.length ? { byCode } : {}), ...(had.length ? { preexistingErrors: had.length } : {}),
    unexpectedMessages: unexpected, ...(dataRefused ? { dataContract: 'refused' } : {}),
    ...(refactorRefused ? { refactorProof: 'refused' } : {}), summary: parts.join('; ') || 'the candidate was not accepted' };
}

// The kernel's policy messages that are no message of the Verify (JobRunner): each part of the contract with its own code
// and the fix that resolves it; anything else is a Verify message no expectation covers.
const POLICY = [
  [/^Data property mismatch: /, 'DATA_CONTRACT', 'the data the candidate holds differs from the job\'s dataContract (the expected and actual values are in the message): correct the data the job writes, or the dataContract entry when it is the contract that is wrong'],
  [/^Refactor reference sets changed after save\/reload/, 'REFACTOR_PROOF', 'the elements that reference what the job renames or moves are not the same after save and reload (the differences are in the message): deliver the rename or move in a job of its own, then the rest'],
  [/^expectValid=False, but Verify isValid=True/i, 'VALIDITY_EXPECTATION', 'the job says expectValid:false and the Verify found the module valid: remove expectValid:false, or make the change the job expects the Verify to refuse'],
];

// The problems of a refused candidate when the kernel gave none of its own (an older kernel, a refusal of the expectations
// alone): one per new error of the Verify, per difference of the data contract and of the refactor proof, and per message no
// expectation covers, never an empty list. A candidate the Verify refuses only for errors the module already had (the job
// added none): one per such error, with its element and key.
export function contractProblems(apply) {
  if (!apply || typeof apply !== 'object') return [];
  const out = [];
  const problem = (m, fix) => ({ phase: 'verify', op: null, pointer: null, code: String(m.id ?? 'VerifyError'), severity: 'error',
    message: String(m.detail ?? m.id ?? '') + (m.path ? ' @ ' + m.path : ''), fix,
    ...(m.path ? { element: String(m.path) } : {}), ...(m.ownerKey ? { key: String(m.ownerKey) } : {}) });
  const fresh = errorsOf(apply.validation?.new);
  for (const m of fresh)
    out.push(problem(m, 'fix the element as the Verify says (`anvil verify-message --name ' + String(m.id ?? '') + '` explains the message)'));
  const verifyProblems = (Array.isArray(apply.problems) ? apply.problems : []).filter(p => p && p.phase === 'verify' && p.severity !== 'warning');
  for (const m of preexistingOnly(apply, verifyProblems.length ? verifyProblems : fresh))
    out.push(problem(m, 'the module already had this error before the job (the job did not add it): fix it in the job or in the Studio, then validate again'
      + ' (`anvil verify-message --name ' + String(m.id ?? '') + '` explains the message)'));
  const verify = out.length > 0;
  for (const text of Array.isArray(apply.policyMessages) ? apply.policyMessages : []) {
    const [, code, fix] = POLICY.find(([pattern]) => pattern.test(String(text))) ?? [];
    // A message of the Verify (an uncovered one, `expectValid=True, but ...`) is already one of the errors above.
    if (!code && (verify || /^expectValid=/i.test(String(text)))) continue;
    out.push({ phase: 'verify', op: null, pointer: null, code: code ?? 'UNEXPECTED_MESSAGE', severity: 'error',
      message: String(text), fix: fix ?? 'correct the element, or declare the message in expectedMessages with why' });
  }
  return out;
}

// The build of one delivery (see the header): null (no build phase: deliver as before), {answer} (the kernel refused the
// job on the live module, or the pool's turn did not come: nothing reached the Studio), or {args, manifest} (append args
// to `deliver`).
export async function buildBeforeApply({ input, job, ctx, lane, task, signal }) {
  const phase = phaseOfCall();
  if (!phase || phase.promoted || !job || !input?.module) return null;
  if (input.resume || input.closePrevious || input.captureProducers?.length || jobNeedsStudio(job)) return null;
  // Producer files only (a binding the kernel captures through the Studio, "published", is built inside the delivery).
  if (input.producers != null && (typeof input.producers !== 'object' || Object.values(input.producers).some(file => typeof file !== 'string' || !path.isAbsolute(file)))) return null;
  let shot = null;
  try { shot = await captureByKey(input.module, { bridge: ctx.bridge, local: lane.local, now: ctx.now, signal }); } catch { shot = null; }
  if (!shot) return null;
  const folder = path.join(lane.work, 'build', task.id);
  fs.mkdirSync(folder, { recursive: true });
  const candidate = path.join(folder, 'candidate.oml');
  const pool = ctx.buildPool ?? sharedBuildPool({ root: ctx.root, env: ctx.env });
  const producers = Object.entries(input.producers ?? {});
  const offer = checkedCandidateOffer();
  if (offer) {
    let checked;
    try { checked = fromCheckedCandidate(offer, { input, job, shot, folder, producers }); }
    catch (error) { checked = { outcome: { reused: false, reason: 'unreadable: ' + String(error?.message ?? error).slice(0, 160) } }; }
    offer.outcome = checked.outcome;
    if (checked.manifest) { notePhase({ built: true }); return { args: ['--prebuilt', checked.manifest], manifest: checked.manifest, checked: true, ...(checked.hot ? { hot: checked.hot } : {}) }; }
  }
  const lanePorts = { root: ctx.root, env: ctx.env, lane: lane.name, workspace: ctx.workspace };
  const baseModel = isModelSha(shot.modelSha256) ? shot.modelSha256 : null;
  let prefer = [];
  if (baseModel) { try { const ports = await Promise.all(Array.from({ length: pool.size ?? 1 }, (_, i) => slotPort(i, lanePorts))); prefer = preferredSlots(baseModel, ports.length, i => ports[i]); } catch { prefer = []; } }
  let ranOn = null;
  const argv = ['apply', '--job', job, '--base', shot.path, '--out', candidate, '--work', path.join(folder, 'model'),
    ...(input.autoPatch === false ? ['--auto-patch', 'off'] : []),
    ...producers.flatMap(([name, file]) => ['--producer', name + '=' + file]),
    // the job a patched delivery corrects (o11-cycle.mjs BASED_ON): the preflight refuses CSS the correction dropped
    ...Object.getOwnPropertySymbols(input).filter(s => s.description === 'basedOnJob').map(s => input[s]).filter(f => typeof f === 'string').flatMap(f => ['--based-on', f])];
  let run;
  try {
    run = await pooledBuild({ pool, customer: buildCustomer(ctx), signal, privateDir: folder, prefer }, slot => {
      ranOn = slot;
      return (ctx.buildRunner ? ctx.buildRunner(slot) : slotRunner(slot, lanePorts))(argv, { timeoutMs: ctx.applyTimeoutMs });
    });
  } catch (error) {
    if (error instanceof BuildQueueRefused) { notePhase({ built: true }); return { answer: error.refusal }; }
    throw error;
  }
  const data = run?.envelope?.data;
  // The worker of the slot now holds the model's spare: the next build of it prefers that slot.
  if (baseModel && run?.via === 'worker' && ranOn) { try { rememberSlotModel(baseModel, { port: await slotPort(ranOn.index, lanePorts) }); } catch { /* affinity is a preference */ } }
  // The kernel's verdict on the live module: the single refusal (every problem of every phase, PREFLIGHT_REFUSED), a
  // refusal of the apply alone with its own code and its problems (primeira-certa A7: DELETE_HAS_CONSUMERS, ...), or a
  // validation verdict. Nothing of it reaches the Studio.
  if (run?.envelope?.ok === false && (!data || typeof data !== 'object')
    && (run.envelope.code === 'PREFLIGHT_REFUSED' || (Array.isArray(run.envelope.problems) && run.envelope.problems.length))) { notePhase({ built: true }); return { refused: run }; }
  if (data && typeof data === 'object' && (data.isValid === false || data.accepted === false)) {
    notePhase({ built: true });
    // The error names the part of the contract that refused and its counts: the task record and the journal keep it.
    const contract = validationContract(data);
    return { refused: { ...run, envelope: { ...run.envelope, data: { stage: 'apply', apply: data, writeState: 'not-sent',
      error: 'job rejected by validation contract (' + contract.summary + '); merge was not attempted' } } } };
  }
  const result = candidate.replace(/\.oml$/i, '.result.json');
  // Anything else (no candidate, an exception, a timeout): the delivery builds inside the Studio lock, as before.
  if (!(run?.envelope?.ok === true && data?.isValid === true && data?.accepted === true && isFile(candidate) && isFile(result))) return null;
  const manifest = path.join(folder, 'prebuilt.json');
  const baseModelSha256 = isModelSha(shot.modelSha256) ? shot.modelSha256 : modelSha256(shot.path);
  const hot = hotOfBuild(data, baseModelSha256);
  fs.writeFileSync(manifest, JSON.stringify({ schema: PREBUILT_SCHEMA, module: shot.module, moduleKey: shot.key, job, base: shot.path, baseSha256: sha256Of(shot.path),
    // R3: the model the build applied to, the identity of the capture store and of the kernel's hot module
    baseModelSha256, ...(hot ? { hot } : {}),
    candidate, candidateSha256: sha256Of(candidate), result,
    producers: Object.fromEntries(producers.map(([name, file]) => [name, { path: file, sha256: isFile(file) ? sha256Of(file) : null }])),
    builtAt: new Date().toISOString(), buildMs: run.wallMs ?? null,
    // vel-entrega: the base is a copy of a capture the server held with the same model (nothing was captured or uploaded)
    ...(shot.reused ? { captureReused: shot.reused } : {}),
    // S9: a draft's checked candidate that could not serve this build, and why
    ...(offer?.outcome ? { checkedCandidate: offer.outcome } : {}) }, null, 2));
  notePhase({ built: true });
  return { args: ['--prebuilt', manifest], manifest, ...(hot ? { hot } : {}) };
}

// After the apply phase: a candidate the kernel did not reuse (the module changed after the build) is a rebase; the
// task folder's phases.json gets the phases of the call.
// vel-entrega: the delivery's own snapshot and its delivered snapshot are recorded as known captures of the module
// (o11-capture-store.mjs), with or without a build phase: the next build of the same model copies one of them.
// L3b (spare pós-merge): the delivered capture is the module now. The kernel that delivered in the lane's worker already
// wants its spare (result nextSpare, BaseModelCache.AfterMerge); the next build of that model prefers the worker that
// prepares it (rememberSlotModel). A delivery that did not leave that want (it ran cold, or an older kernel) asks the
// lane's worker for it (warmSpares), in the background: the answer never waits for it. Returns that request, or null.
export function afterApply(run, built, { work, local, name }, deps = {}) {
  const state = run?.envelope?.data;
  const recorded = local && state && typeof state === 'object' ? rememberDelivery(local, state) : null;
  const spare = state?.delivered === true && recorded?.delivered ? spareAfterMerge(run, recorded, name, deps) : null;
  if (!built?.manifest) return spare;
  const prebuilt = state?.apply?.prebuilt;
  if (prebuilt && prebuilt.reused === false) notePhase({ rebased: { reason: String(prebuilt.reason ?? 'base-changed') } });
  const taskId = typeof state?.taskId === 'string' ? state.taskId : null;
  const folder = typeof state?.work === 'string' && state.work ? state.work : taskId ? path.join(work, 'deliver', taskId) : null;
  notePhase({ receipt: folder ? path.join(folder, 'phases.json') : path.join(path.dirname(built.manifest), 'phases.json') });
  return spare;
}

// The spare of the delivered capture (see afterApply), as a promise that never rejects: {by:'kernel', port} when the kernel
// that delivered in the worker already wants it, else the answer of warmSpares {by:'facade', used, ...}. deps.worker (tests):
// {workerTarget, warmSpares}.
function spareAfterMerge(run, recorded, laneName, deps) {
  const delivered = recorded.delivered;
  const options = laneName ? { o11: laneName } : {};
  return (async () => {
    const { workerTarget, warmSpares } = deps.worker ?? await import('./anvil-worker.mjs');
    const kernel = run?.envelope?.data?.nextSpare;
    if (run?.via === 'worker' && kernel?.wanted === true) {
      let port = null;
      try { port = workerTarget('o11', options).port; } catch { port = null; }
      if (port) rememberSlotModel(isModelSha(kernel.modelSha256) ? kernel.modelSha256 : delivered.model, { port });
      return { by: 'kernel', port, modelSha256: kernel.modelSha256 ?? delivered.model };
    }
    const r = await warmSpares('o11', { captures: [{ path: delivered.path, ...(recorded.base ? { supersedes: recorded.base.path } : {}) }] }, options);
    if (r.used && r.port) rememberSlotModel(delivered.model, { port: r.port });
    return { by: 'facade', ...r };
  })().catch(error => ({ by: 'facade', used: false, note: String(error?.message ?? error) }));
}

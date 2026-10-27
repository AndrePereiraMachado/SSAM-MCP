// The build phase of studio_deliver (lane wp of the atritos 3 package; studio-write-lock.mjs "Build and apply phases").
// lib.mjs deliver and kernel-delivery.mjs deliverKernel stay as they are; the ODC server hands them these dependencies:
// - studio: the ODC bridge commands of a phased call. A read of the build (snapshot, reference-snapshot) runs in a Studio
//   moment: the ODC bridge serves one command at a time, so the read waits its turn behind a running merge of another
//   module of the same Studio (the write queue), runs in seconds and gives the Studio back. A bridge still busy after the
//   moment (a publication the lock narrowed to its module, C07) is asked again, nothing sent, until the queue limit.
//   Any other command (merge, check-base, preview, authorize, publish, status) is the first Studio write: the call takes
//   the Studio and keeps it to its end.
// - apply and prepareManifest: the kernel apply and the builder run in the build pool (build-pool.mjs), never under the
//   Studio lock; the kernel apply of a slot gets the slot's TEMP and TMP (deps.exec) and its resident ODC worker
//   (deps.worker: slot 0 is the lane's worker, slot i listens on base + i * poolStep).
// - check: the job preflight of the kernel delivery (C31 of lane mb) when kernel-delivery.mjs has it.
// phasedDeliver: the delivery, rebuilt once in the same call when the merge proves the open module changed after the
// capture (BASE_DRIFT, nothing merged): the second build captures the module as it is now (phases.rebased).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as kernelDelivery from './kernel-delivery.mjs';
import { phaseOfCall, phaseGuard, studioMoment, notePhase, StudioTurnRefused, queueWaitMs } from './studio-write-lock.mjs';
import { pooledBuild, sharedBuildPool, BuildQueueRefused, slotWorkerPort } from './build-pool.mjs';
import { workspaceRoot } from './workspace.mjs';
import { hostedContext } from './executor.mjs';

// reference-producers (fix/system-reference): the listing a delivery reads once when the session offers no producer of the job's name.
export const BUILD_STUDIO_READS = new Set(['snapshot', 'reference-snapshot', 'reference-producers']);
const busy = error => error?.code === 'BRIDGE_BUSY' && error?.sent !== true;
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The studio(args, pid) of a phased call (see the header). A refused turn answers its refusal as the step's value.
export function phasedStudio(studio, { env = process.env, now = Date.now } = {}) {
  const guarded = phaseGuard(studio);
  return async (args, pid, options) => {
    const phase = phaseOfCall();
    if (phase && !phase.promoted && BUILD_STUDIO_READS.has(String(args?.[0] ?? ''))) {
      const deadline = now() + queueWaitMs(env);
      for (let wait = 250; ; wait = Math.min(wait * 2, 4000)) {
        try { return await studioMoment(() => studio(args, pid, options)); }
        catch (error) { if (!busy(error) || now() + wait > deadline) throw error; await sleep(wait); }
      }
    }
    try { return await guarded(args, pid, options); }
    catch (error) { if (error instanceof StudioTurnRefused) return error.refusal; throw error; }
  };
}

const run = promisify(execFile);
// The kernel delivery's exec with the slot's TEMP and TMP. Hosted (servidor/fase4) the temporary folder stays the customer's:
// <ws>/odc/tmp/slot-<i> under the closed environment's TEMP, so two customers never share one, nor two builds of a customer.
export const slotTemp = (slot, env) => (hostedContext() && env?.TEMP ? path.join(env.TEMP, 'slot-' + (slot.index ?? 'apply')) : slot.env.TEMP);
export const slotExec = (slot, runner = run) => (file, args, options = {}) => {
  const temp = slotTemp(slot, options.env);
  try { fs.mkdirSync(temp, { recursive: true }); } catch { /* the build creates it or fails visibly */ }
  return runner(file, args, { ...options, env: { ...(options.env ?? process.env), TEMP: temp, TMP: temp } });
};
async function slotWorker(slot, env) {
  if (slot.index == null) return undefined; // the lane's own worker (the kernel delivery's default)
  const { workerDisabled, createWorkerClient } = await import('./anvil-worker.mjs');
  if (workerDisabled('odc', env)) return null;
  const base = createWorkerClient('odc', { env }).target.port;
  return createWorkerClient('odc', { env: { ...env, ...slot.env, ANVIL_ODC_PORT: String(slotWorkerPort(base, slot.index, { workspace: workspaceRoot })) } });
}

// The dependencies of lib.mjs deliver for a phased call: {studio, kernel: {apply, prepareManifest, check?, mergeOrder?}}.
// prototype (docs/PROTOTIPO-NATIVO.md, lane surface): {capturePrototype?, measureFidelity?, prototypeWriter?} for the
// prototype op of the delivery. Its capture runs in this process before the first Studio command, outside the Studio lock
// (no bridge call); its rebuild of 1.4.1 runs through the same pooled apply.
export function phasedDeliveryDeps({ root, studio, prepareManifest, env = process.env, pool, kernel = kernelDelivery, customer, prototype = null } = {}) {
  const buildPool = pool ?? sharedBuildPool({ root, env });
  // The customer whose builds share the pool fairly: the one named, the hosted call's token (every customer of the hosted
  // server builds in this one pool), SSAM_CUSTOMER, else the lane root.
  const who = customer ?? hostedContext()?.tokenId ?? env.SSAM_CUSTOMER ?? root;
  const pooled = fn => async args => {
    try { return await pooledBuild({ pool: buildPool, customer: who }, slot => fn(args, slot)); }
    catch (error) { if (error instanceof BuildQueueRefused) return error.refusal; throw error; }
  };
  return {
    studio: phasedStudio(studio, { env }),
    kernel: {
      apply: pooled(async (args, slot) => kernel.applyKernel(args, { exec: slotExec(slot), worker: await slotWorker(slot, env) })),
      prepareManifest: pooled(args => prepareManifest(args)),
      // The merge order (kernel-delivery.mjs planMergeOrderKernel) on the slot's kernel, like the apply.
      ...(typeof kernel.planMergeOrderKernel === 'function'
        ? { mergeOrder: pooled(async (args, slot) => kernel.planMergeOrderKernel(args, { exec: slotExec(slot), worker: await slotWorker(slot, env) })) } : {}),
      ...(typeof kernel.checkJobKernel === 'function' ? { check: kernel.checkJobKernel } : {}),
      ...Object.fromEntries(['capturePrototype', 'measureFidelity', 'prototypeWriter', 'expandPrototype'].filter(k => typeof prototype?.[k] === 'function').map(k => [k, prototype[k]])),
    },
  };
}

// L3b (spare pós-merge, the ODC side of o11-build-phase.mjs afterApply): the ODC delivery does not run through the kernel's
// Delivery.cs; its merge is the bridge's, whose receipt carries the module after the merge (afterSnapshot: SaveToMemoryStream
// of the live module, what the bridge's snapshot writes, with its sha256 and developerId). It is recorded as a known capture
// of the module, next to the delivery's own snapshot, under the bridge's name <module>-<sha256>.oml with the same sidecar
// (source "after-merge"), and the lane's ODC worker is asked to prepare its spare for that author (anvil-worker.mjs
// warmSpares, the worker's `warm`), with the capture's content identity, the one the next apply keys the spare by. Nothing
// merged, no afterSnapshot or a delivery capture that is not a file: nothing. Never throws; deps (tests): warmSpares,
// contentOf, now. -> {known, sha256, contentSha256, warm} | null.
export async function afterOdcMerge({ merge, snapshot, module } = {}, deps = {}) {
  try {
    const after = typeof merge?.afterSnapshot === 'string' ? merge.afterSnapshot : null;
    const name = String(merge?.module ?? module ?? '');
    if (merge?.merged !== true || !after || !isFile(after) || typeof snapshot?.path !== 'string' || !path.isAbsolute(snapshot.path)) return null;
    if (!name || /[\\/]|\.\./.test(name)) return null;
    const sha256 = /^[0-9a-f]{64}$/i.test(String(merge.sha256 ?? '')) ? String(merge.sha256) : createHash('sha256').update(fs.readFileSync(after)).digest('hex').toUpperCase();
    const known = path.join(path.dirname(snapshot.path), name + '-' + sha256 + '.oml');
    const developerId = typeof merge.developerId === 'string' && merge.developerId ? merge.developerId : snapshot.developerId ?? null;
    if (!isFile(known)) fs.copyFileSync(after, known);   // the same name is the same bytes (a capture of the bridge, kept as it is)
    const contentSha256 = await (deps.contentOf ?? kernelDelivery.baseContentSha256)({ path: known, sha256 });
    if (!isFile(known + '.json')) fs.writeFileSync(known + '.json', JSON.stringify({ ok: true, module: name, moduleKey: snapshot.moduleKey ?? null, sha256, path: known,
      capturedAt: (deps.now?.() ?? new Date()).toISOString(), developerId, host: snapshot.host ?? null, ...(snapshot.kind ? { kind: snapshot.kind } : {}),
      ...(contentSha256 ? { contentSha256 } : {}), source: 'after-merge' }, null, 2));
    const warmSpares = deps.warmSpares ?? (await import('./anvil-worker.mjs')).warmSpares;
    const warm = await warmSpares('odc', { captures: [{ path: known, ...(contentSha256 ? { contentSha256 } : {}), supersedes: path.resolve(snapshot.path) }], developerId }, deps.options ?? {});
    return { known, sha256, contentSha256, warm };
  } catch { return null; }
}

// The delivery of one call (lib.mjs deliver), rebuilt once on BASE_DRIFT (see the header); the build and the receipt go
// to the call's phases.
export async function phasedDeliver(args, deps, { deliver }) {
  const settle = value => {
    if (Array.isArray(value?.steps) && value.steps.some(s => s?.step === 'build')) notePhase({ built: true });
    if (typeof value?.evidence === 'string' && value.evidence) notePhase({ receipt: path.join(value.evidence, 'deliver-result.json') });
    return value;
  };
  const first = settle(await deliver(args, deps));
  if (!(first && first.ok === false && first.code === 'BASE_DRIFT' && first.failed === 'merge' && first.merged !== true)) return first;
  notePhase({ rebased: { reason: 'BASE_DRIFT', ...(first.evidence ? { from: first.evidence } : {}) } });
  const { output: _used, ...again } = args;
  return settle(await deliver(again, deps));
}

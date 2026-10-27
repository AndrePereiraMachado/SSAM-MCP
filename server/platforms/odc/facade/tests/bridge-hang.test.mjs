// The bridge-hang family (2026-10-22): a merge queued in the ODC Studio did not run for 30 minutes (the tab never became
// idle), the facade gave up at 10 min while the bridge waited 15, the bridge's late answer hit a closed pipe and its
// command server ended; every later studio_attach answered attached:true (the startup hook ran, the DLL was already
// loaded) while every pipe command answered BRIDGE_NOT_ATTACHED. The rules proven here, offline (fake client, fake
// Studios, a temporary lab; no process, no pipe, no bridge):
//   1. attach answers attached:true only after a status round trip on the pipe; otherwise a refusal naming the cause
//      (pipe absent / busy / silent) and the next call.
//   2. ssam_connect never counts a Studio as attached on the hook's word or on a probe that got no answer.
//   3. the client waits for a merge longer than the bridge's own deadline, so the bridge's answer is read, never lost.
//   4. a merge whose answer did not come ends MERGE_TIMEOUT with whether it started, its evidence and the next call.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attach } from '../lib.mjs';
import { connectAll } from '../studio-connect.mjs';
import * as pipe from '../odc-pipe.mjs';
import { deliverKernel } from '../kernel-delivery.mjs';

const DLL = { path: 'C:\\fake\\ODC3.Bridge.v32.dll', version: 'v32' };
const pipeError = (message, code, sent) => Object.assign(new Error(message), { code, sent });
const absent = () => pipeError('The ODC bridge v32 is not attached to ODC Studio 77 (no pipe for 10 s); call studio_attach', 'BRIDGE_NOT_ATTACHED', false);

async function attachWith(statusAnswer, hook = { ok: true, attached: true }) {
  let clock = 0; const calls = [];
  const call = async (pid, args) => {
    calls.push(args[0]);
    if (args[0] === 'attach') return hook;
    const next = typeof statusAnswer === 'function' ? statusAnswer() : statusAnswer;
    if (next instanceof Error) throw next;
    return next;
  };
  const result = await attach(77, { call, findPid: async pid => pid, dll: DLL, sleep: async ms => { clock += ms; }, now: () => clock });
  return { result, calls, clock };
}

test('attach: the hook ran but the pipe never answers status -> attached:false, BRIDGE_SILENT, cause pipe-absent, next call', async () => {
  const { result } = await attachWith(absent);
  assert.equal(result.ok, false);
  assert.equal(result.attached, false, 'never attached:true without a round trip');
  assert.equal(result.hookApplied, true);
  assert.equal(result.code, 'BRIDGE_SILENT');
  assert.equal(result.cause, 'pipe-absent');
  assert.match(result.error, /already loaded/);
  assert.match(result.error, /reopen the ODC Studio/);
  assert.equal(result.continuation?.tool, 'studio_status');
  assert.equal(result.continuation?.arguments?.pid, 77);
});

test('attach: a pipe that accepts but never answers is a hung bridge (cause bridge-hung); a busy pipe names the command in flight', async () => {
  let r = await attachWith(() => pipeError('ODC bridge status did not answer within 10000 ms; the native operation may still run', 'PIPE_REPLY_TIMEOUT', true));
  assert.deepEqual([r.result.ok, r.result.attached, r.result.code, r.result.cause], [false, false, 'BRIDGE_SILENT', 'bridge-hung']);
  r = await attachWith(() => pipeError('The ODC bridge v32 of ODC Studio 77 stayed busy for 10 s; a command is still running there', 'BRIDGE_BUSY', false));
  assert.deepEqual([r.result.ok, r.result.attached, r.result.code, r.result.cause], [false, false, 'BRIDGE_SILENT', 'pipe-busy']);
  assert.match(r.result.error, /never repeat a write/i);
});

test('attach: a status that answers is the only attached:true; a refused hook stays refused', async () => {
  let r = await attachWith({ ok: true, bridge: 'v32' });
  assert.deepEqual([r.result.ok, r.result.attached, r.result.status.ok], [true, true, true]);
  assert.deepEqual(r.calls, ['attach', 'status']);
  r = await attachWith({ ok: true }, { ok: false, error: 'hook refused' });
  assert.deepEqual([r.result.ok, r.result.attached], [false, false]);
});

function odcOnly(odc) {
  return { served: ['odc'], odc: { processes: async () => [{ pid: 200 }], ...odc } };
}

test('ssam_connect: a Studio counts as attached only on a status round trip, never on the hook word alone', async () => {
  // The old attach shape: the hook said attached:true, the status carried only an error.
  const value = await connectAll({ lane: 'odc' }, odcOnly({
    probe: async () => ({ attached: false, reply: null }),
    attach: async () => ({ ok: true, attached: true, status: { error: 'The ODC bridge v32 is not attached to ODC Studio 200 (no pipe for 10 s); call studio_attach' } }),
  }));
  const entry = value.studios.find(s => s.pid === 200);
  assert.equal(entry.attached, false, JSON.stringify(entry));
  assert.equal(value.ok, false);
  assert.match(entry.error, /not attached|did not answer/);
});

test('ssam_connect: a probe that connected but got no answer is a silent bridge, not an attached one', async () => {
  let attached = 0;
  const value = await connectAll({ lane: 'odc' }, odcOnly({
    probe: async () => ({ attached: true, busy: false, reply: null, error: 'ODC bridge auth-status did not answer within 8000 ms' }),
    attach: async () => { attached += 1; return { ok: true, attached: true, status: { ok: true } }; },
  }));
  const entry = value.studios.find(s => s.pid === 200);
  assert.equal(entry.attached, false, JSON.stringify(entry));
  assert.equal(entry.code, 'BRIDGE_SILENT');
  assert.equal(attached, 0, 'a loaded, silent bridge is never attached again (a loaded DLL is never replaced)');
  assert.equal(value.ok, false);
});

test('the client waits for a merge longer than the bridge itself does, so the bridge answer is always read', () => {
  const { replyTimeoutMs } = pipe;
  // The bridge's own merge deadline (StartupHook.cs Serve: 15 min); exported by odc-pipe.mjs so both sides read one number.
  const BRIDGE_COMMAND_TIMEOUT_MS = pipe.BRIDGE_COMMAND_TIMEOUT_MS ?? { merge: 15 * 60 * 1000 };
  assert.ok(replyTimeoutMs(['merge', 'manifest.json']) > BRIDGE_COMMAND_TIMEOUT_MS.merge, 'client deadline after the bridge deadline');
  assert.ok(replyTimeoutMs(['reconcile-merge', 'manifest.json']) > BRIDGE_COMMAND_TIMEOUT_MS.merge);
  assert.equal(replyTimeoutMs(['status']), 10 * 60 * 1000, 'other commands keep the 10 min of the .NET client');
});

function deliveryWithMergeTimeout(t, { started = false, returned = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hang-deliver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [];
  const manifestDir = path.join(root, 'attempt', 'delivery');
  const evidence = path.join(manifestDir, 'evidence');
  const studio = async ([step]) => {
    calls.push(step);
    if (step === 'snapshot') return { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test', moduleKey: 'K' };
    if (step === 'merge') {
      fs.mkdirSync(evidence, { recursive: true });
      if (started) fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: 'now', pid: 5150 }));
      if (returned) fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'Merged', publishInvoked: false }));
      throw pipeError('ODC bridge merge did not answer within 960000 ms; the native operation may still run: read its evidence before any retry', 'PIPE_REPLY_TIMEOUT', true);
    }
    return { ok: true };
  };
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {}, studio,
    apply: async () => ({ ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }),
    prepareManifest: async () => {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(path.join(manifestDir, 'candidate.oml'), 'candidate');
      const manifest = path.join(manifestDir, 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', moduleKey: 'K', candidatePath: path.join(manifestDir, 'candidate.oml'), candidateSha256: 'C', evidenceDir: evidence }));
      return { ok: true, manifest };
    } };
  return { calls, deps, evidence, input: { module: 'Fixture', feature: 'bridge-hang', job: 'job.json', owners: ['Options'], changes: ['Change'] } };
}

test('studio_deliver: a merge that never answered and never started ends MERGE_TIMEOUT with started:false and studio_status next', async t => {
  const f = deliveryWithMergeTimeout(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.timeout?.mergeStarted, false);
  assert.equal(result.timeout?.nativeReturned, false);
  assert.equal(result.timeout?.evidence, f.evidence);
  assert.match(result.error, /had not started/);
  assert.equal(result.continuation?.tool, 'studio_status');
  assert.match(result.continuation.why, /never repeat/i);
  assert.equal(f.calls.filter(c => c === 'merge').length, 1, 'never merged twice');
});

test('studio_deliver: a merge that started but never answered ends MERGE_TIMEOUT with started:true, still uncertain', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.timeout?.mergeStarted, true);
  assert.equal(result.timeout?.nativeReturned, false);
  assert.match(result.error, /started the native merge at/);
  assert.equal(result.continuation?.tool, 'studio_status');
});

test('studio_deliver: a bridge that abandoned a merge its tab never ran ends MERGE_NOT_STARTED, nothing merged, studio_status next', async t => {
  const f = deliveryWithMergeTimeout(t);
  const refusal = { ok: false, outcome: 'gate_refused', gate: 'studio_busy', error: 'MERGE_NOT_STARTED: the Studio did not run the merge of Fixture within 120 s: its tab did not become idle (a queued job waits for an idle top level). It was abandoned and will never run; nothing was executed and the module is unchanged.' };
  const studio = f.deps.studio;
  f.deps.studio = async args => (args[0] === 'merge' ? (f.calls.push('merge'), refusal) : studio(args));
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MERGE_NOT_STARTED');
  assert.notEqual(result.merged, true);
  assert.notEqual(result.outcome, 'uncertain');
  assert.equal(result.continuation?.tool, 'studio_status');
});

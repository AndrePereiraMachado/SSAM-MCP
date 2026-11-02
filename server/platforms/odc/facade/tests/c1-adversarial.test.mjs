// C1 adversarial co-editing, facade layer (PLANO-11H; owner 2026-11-02: "o mais importante de todos é nao deixar o ssam
// travar por que o usuario estava programando junto.. isso é imperdoavel"). The kernel suite
// (kernel/tests/Shared/C1AdversarialCoEditTests.cs) drives Delivery.Run; this one drives what the facade does with the
// answers of the Studio when the person edits at the same time:
// - ODC studio_deliver (odc-build-phase.mjs phasedDeliver over kernel-delivery.mjs): the ODC bridge refuses a merge when the
//   open module differs from the capture (BASE_DRIFT, StartupHook.cs Run) and when the candidate conflicts with the open
//   module (MERGE_CONFLICT). The person who keeps working makes either answer repeat.
// - O11 o11_deliver / ssam_task / ssam_doctor (o11-cycle.mjs closeState, ssam.mjs classifyReservation): a kernel process killed
//   mid-run leaves a task with no recorded failure; the next delivery and the reservation must not need a manual step.
// Contract asserted: the delivery goes on by itself (no manual step, no refusal while the person only edits), and nothing
// stays reserved. Fakes only; no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withStudioWriteLock } from '../studio-write-lock.mjs';
import { phasedDeliver } from '../odc-build-phase.mjs';
import { closeState, findKernelTask } from '../o11-cycle.mjs';
import { classifyReservation } from '../ssam.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'c1-adv-'));
const phased = (deps, module, fn) => withStudioWriteLock({ tool: 'studio_deliver', args: { module, feature: 'f', pid: 7 }, lane: 'odc', deps, phased: true }, fn);
const depsFor = root => ({ o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' });
const matrix = path.join(process.env.C1_MATRIX_DIR ?? os.tmpdir(), 'c1-facade-matrix.jsonl');
const record = (scenario, green, detail) => { try { fs.appendFileSync(matrix, JSON.stringify({ lane: 'facade', scenario, green, detail }) + '\n'); } catch {} };

// The ODC Studio of a person who keeps working: each merge answers what the bridge answers for the module as it is.
function personKeepsEditing(answers) {
  const asked = [];
  const deliver = async args => {
    asked.push(args);
    const next = answers[Math.min(asked.length - 1, answers.length - 1)];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-ev-'));
    fs.writeFileSync(path.join(dir, 'deliver-result.json'), '{}');
    return { ...next, evidence: dir, steps: [{ step: 'build' }, { step: 'merge' }] };
  };
  return { asked, deliver };
}
const drift = { ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false, error: 'Open App differs from the captured base; capture a new snapshot and rebuild the candidate.' };
const conflict = { ok: false, code: 'MERGE_CONFLICT', failed: 'merge', merged: false, error: 'Automatic merge requires clean, non-empty changes: the candidate conflicts with the open module (MERGE_CONFLICT; match-tree.txt names each conflict); nothing was merged.' };
const delivered = { ok: true, result: 'delivered', merged: true, strictlyEqual: true };

for (const [scenario, answers] of [
  ['odc: the person edits once between the capture and the merge (BASE_DRIFT once)', [drift, delivered]],
  ['odc: the person keeps editing while SSAM rebuilds (BASE_DRIFT twice)', [drift, drift, delivered]],
  ['odc: the person edits the same element the delivery writes (MERGE_CONFLICT)', [conflict, delivered]],
  ['odc: the person edits during the rebuild, then the same element (BASE_DRIFT, MERGE_CONFLICT)', [drift, conflict, delivered]],
]) {
  test('C1 ' + scenario + ': the delivery lands without a manual step', async () => {
    const root = tmp(); const deps = depsFor(root);
    const studio = personKeepsEditing(answers);
    const value = await phased(deps, 'App', () => phasedDeliver({ module: 'App', feature: 'f', job: 'j.json' }, {}, { deliver: studio.deliver }));
    const green = value?.ok === true && value?.merged === true;
    record(scenario, green, { code: value?.code ?? null, attempts: studio.asked.length });
    assert.equal(green, true, `stopped after ${studio.asked.length} attempt(s) with ${value?.code}: ${value?.error ?? ''}`);
  });
}

// ---- O11: a kernel process killed mid-run --------------------------------------------------------------------------------

const durable = value => { const payload = JSON.stringify(value); return JSON.stringify({ format: 1, sha256: createHash('sha256').update(payload).digest('hex'), payload }); };

for (const [scenario, state] of [
  ['o11: killed during the capture (not-sent, no error; production task c150… 2026-11-02)', { writeState: 'not-sent', delivered: false, stage: 'snapshot' }],
  ['o11: killed during the job apply (not-sent, no error)', { writeState: 'not-sent', delivered: false, stage: 'apply' }],
]) {
  test('C1 ' + scenario + ': the task closes and its reservation frees without the person', () => {
    const root = tmp(), kernel = path.join(root, 'kernel'), work = path.join(kernel, '.local', 'work'), authority = path.join(root, 'authority');
    const id = 'c'.repeat(32);
    // The task as the kernel writes it (DeliveryTask: its own folder in work, no process holding its run lease).
    fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
    fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), durable({ taskId: id, ...state, work: path.join(work, 'deliver', id), moduleKey: 'm', environment: 'dev' }));
    const closing = closeState(findKernelTask(work, { taskId: id }));
    const file = path.join(authority, 'reservations', 'r.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { owner: id, environment: 'dev', moduleKey: 'm', root: kernel, pid: 999999, since: new Date().toISOString() };
    fs.writeFileSync(file, durable(payload));
    const classified = classifyReservation(payload, file, { root: kernel, works: [work], authority, alive: () => false,
      findTask: findKernelTask });
    const green = closing !== 'unsettled' && classified.state !== 'active';
    record(scenario, green, { closeState: closing, reservation: classified.state, next: classified.next?.tool ?? null });
    assert.equal(closing === 'unsettled', false, 'closeState is unsettled: ssam_task close answers CLOSE_REFUSED and closePrevious PREVIOUS_NOT_CLOSABLE (only resume, which repeats the write)');
    assert.notEqual(classified.state, 'active', 'ssam_doctor classifies the reservation active: release answers RESERVATION_HAS_TASK');
  });
}

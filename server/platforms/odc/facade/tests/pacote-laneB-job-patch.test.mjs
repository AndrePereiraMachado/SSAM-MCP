// Lane B (C06, C20): /expectedMessages of an {ops} job is patchable (the declaration a refusal asks for is a patch, not the
// whole job again), base and expectValid stay closed, an array job has no expectedMessages, and the failed op of a preflight
// refusal in the I2 text form (`op #N (<verb>) [CODE]: ...`) is still found. Pure: no process, temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyJobPatch, failedOpOf, PatchError } from '../job-patch.mjs';

const JOB = { base: 'tests/fixtures/blank-service.oml', expectValid: true, ops: [
  { op: 'logic', data: { actions: [{ name: 'Probe', steps: [] }] } }] };
const thrown = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected a PatchError'); };

test('expectedMessages is added to, created and replaced by a patch', () => {
  const declaration = { id: 'UnusedUserAction', element: 'Headless_CS (ESpace) / Probe (ServerAction)', why: 'kept for the next job' };
  const created = applyJobPatch(JOB, [{ op: 'add', path: '/expectedMessages', value: [declaration] }]);
  assert.deepEqual(created.expectedMessages, [declaration]);
  const appended = applyJobPatch(created, [{ op: 'add', path: '/expectedMessages/-', value: { ...declaration, count: 2 } }]);
  assert.equal(appended.expectedMessages.length, 2);
  const replaced = applyJobPatch(appended, [{ op: 'replace', path: '/expectedMessages/0/why', value: 'reason' }, { op: 'remove', path: '/expectedMessages/1' }]);
  assert.deepEqual(replaced.expectedMessages, [{ ...declaration, why: 'reason' }]);
  assert.deepEqual(replaced.ops, JOB.ops);
});

test('base and expectValid stay closed; an array job has no expectedMessages', () => {
  for (const where of ['/base', '/expectValid'])
    assert.equal(thrown(() => applyJobPatch(JOB, [{ op: 'replace', path: where, value: 'x' }])).code, 'PATCH_PATH_FORBIDDEN', where);
  const array = thrown(() => applyJobPatch(JOB.ops, [{ op: 'add', path: '/expectedMessages', value: [] }]));
  assert.ok(array instanceof PatchError);
  // /expectedMessages of an array is not an index of its ops: read as the name of an op (patch-por-nome), which none has
  assert.equal(array.code, 'PATCH_NAME_NOT_FOUND');
});

test('the failed op of a preflight refusal in the I2 text form is found', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-laneB-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(JOB));
  assert.equal(failedOpOf('JobPreflightException: op #0 (logic) [LOGIC_INVALID]: logic: action Probe: unknown key Fix: use one of: name, steps', file), 0);
  assert.equal(failedOpOf('op #0 (logic ): the old form still reads', file), 0);
  assert.equal(failedOpOf('op #0 (spec) [SPEC_INVALID]: not the verb of op 0', file), null);
});

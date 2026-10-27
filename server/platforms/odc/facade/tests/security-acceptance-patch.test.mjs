// T12 correction round (finding 2): the acceptance of a security warning is one call even on a job without expectedMessages.
// The kernel (SecurityAcceptance.ListPatch) answers "add /expectedMessages" with the whole list when the job has none, and
// "add /expectedMessages/-" when it lists some; job-patch applies both as they are (its semantics unchanged for everyone).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchJob } from '../job-patch.mjs';

const entry = { id: 'CustomObjectWarning', element: 'SelectProducts (SQLNode) / Argument', why: 'the user said: keep it, the column is checked' };
const job = { ops: [{ op: 'set', target: 'IMobileScreen:Detail', prop: 'Roles', value: ['IRole:Registered'] }] };

test('the list patch of a job without expectedMessages applies in one call', () => {
  const listed = patchJob(structuredClone(job), [{ op: 'add', path: '/expectedMessages', value: [entry] }]);
  assert.deepEqual(listed.job.expectedMessages, [entry]);
  assert.deepEqual(listed.job.ops, job.ops);
  // Applying the same list patch twice (two problems of one refusal carry it) gives the same list.
  const twice = patchJob(structuredClone(job), [{ op: 'add', path: '/expectedMessages', value: [entry] }, { op: 'add', path: '/expectedMessages', value: [entry] }]);
  assert.deepEqual(twice.job.expectedMessages, [entry]);
});

test('the append patch is the one for a job that already lists expectedMessages, and has no parent without the list', () => {
  const appended = patchJob({ ...structuredClone(job), expectedMessages: [] }, [{ op: 'add', path: '/expectedMessages/-', value: entry }]);
  assert.deepEqual(appended.job.expectedMessages, [entry]);
  assert.throws(() => patchJob(structuredClone(job), [{ op: 'add', path: '/expectedMessages/-', value: entry }]));
});

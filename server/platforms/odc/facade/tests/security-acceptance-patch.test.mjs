// T12 correction round (finding 2): the acceptance of a security warning is one call even on a job without expectedMessages.
// The kernel (SecurityAcceptance.ListPatch) answers "add /expectedMessages" with the whole list when the job has none, and
// "add /expectedMessages/-" when it lists some; job-patch applies both (an append on a job without the list creates it, C-11).
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

test('the append patch is the one for a job that already lists expectedMessages; without the list it creates it and says so (C-11)', () => {
  const appended = patchJob({ ...structuredClone(job), expectedMessages: [] }, [{ op: 'add', path: '/expectedMessages/-', value: entry }]);
  assert.deepEqual(appended.job.expectedMessages, [entry]);
  // R4 integration: B1's C-11 (e1f513a4, reviewed) made the append create the list in a job without one, so the patches of
  // one refusal apply in any order; before, the append had no parent there. The note says the list was created.
  const created = patchJob(structuredClone(job), [{ op: 'add', path: '/expectedMessages/-', value: entry }]);
  assert.deepEqual(created.job.expectedMessages, [entry]);
  assert.deepEqual(created.job.ops, job.ops);
  assert.ok(JSON.stringify(created).includes('expected-messages-list'), JSON.stringify(created).slice(0, 400));
});

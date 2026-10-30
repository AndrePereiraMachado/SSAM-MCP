// R2-B (one round, MINERACAO F2/F18): the refusal names, for what can only be judged once another problem is fixed, the
// problem it waits for (the kernel's dependsOn), and never says that what it skipped needs no change.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitProblems, problemOf } from '../refusal-problems.mjs';

const ROOT = { phase: 'apply', op: 2, pointer: '/ops/2/data/ddl', code: 'DDL_SYNTAX', severity: 'error', message: 'line 1: unknown statement', fix: 'write the statement' };
const skipped = op => ({ phase: 'apply', op, pointer: `/ops/${op}`, code: 'APPLY_SKIPPED', severity: 'warning',
  message: 'skipped: it uses Alpha, which failed op #2 would have created', fix: 'fix op #2; this op runs with it', dependsOn: 'DDL_SYNTAX at /ops/2/data/ddl' });

test('a problem that waits for another names it (dependsOn), alone and in the summary of the skipped ops', () => {
  assert.equal(problemOf(skipped(5)).dependsOn, 'DDL_SYNTAX at /ops/2/data/ddl');
  const { problems } = fitProblems([ROOT, skipped(5), skipped(6)]);
  const summary = problems.find(p => p.code === 'APPLY_SKIPPED');
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.because.map(b => [b.op, b.dependsOn]), [[2, 'DDL_SYNTAX at /ops/2/data/ddl']]);
  assert.doesNotMatch(summary.fix, /unchanged|need no change/);
  assert.match(summary.fix, /judged/);
});

test('a problem without dependsOn gains none', () => {
  assert.equal(problemOf(ROOT).dependsOn, undefined);
});

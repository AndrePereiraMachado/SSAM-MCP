import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const runner = await import('../../../../scripts/test-hosted.mjs').catch(() => ({}));

test('the hosted runner provides named and unnamed modes and rejects invalid backends', () => {
  assert.equal(runner.parseArguments([]).only, null);
  assert.equal(runner.parseArguments(['--only', 'backend', '--backend', 'studio-pair']).backend, 'studio-pair');
  assert.throws(() => runner.parseArguments(['--backend', '../outside']), /backend name/);
  assert.throws(() => runner.parseArguments(['--only', 'missing']), /plain or backend/);
});
test('the hosted runner compares failures by full test name without counting failed parents twice', () => {
  const result = runner.failuresOf('# Subtest: family\n    # Subtest: case\n    not ok 1 - case\nnot ok 1 - family\nok 2 - pass\nok 3 - absent # SKIP\n');
  assert.deepEqual(result, { passed: 1, skipped: 1, failures: ['family > case'] });
});

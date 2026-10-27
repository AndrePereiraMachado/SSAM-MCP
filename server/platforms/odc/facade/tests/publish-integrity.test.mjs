import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishOutcome } from '../o11-publish.mjs';

test('publication cannot succeed on a failed or running native state despite a contradictory boolean', () => {
  for (const state of ['CompletedWithFailure', 'Running', 'Unknown']) {
    const result = publishOutcome({ data: { module: 'Orders', published: true, state } }, { name: 'Orders' }, 'audit-operation');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, state === 'CompletedWithFailure' ? 'failed' : 'uncertain');
    assert.equal(result.operationId, 'audit-operation');
    assert.notEqual(result.continuation.tool, 'o11_publish');
  }
  assert.equal(publishOutcome({ data: { published: true, state: 'CompletedWithSuccessNotOpenedInBrowser' } }).ok, true);
});

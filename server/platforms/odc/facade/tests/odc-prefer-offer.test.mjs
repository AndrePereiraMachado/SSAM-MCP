import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRuns } from '../bridge-store.mjs';

test('ODC v108 and v109 offers still require reconciliation; older offers keep their gate', () => {
  for (const version of ['v108', 'v109']) {
    assert.equal(agentRuns({ agent: { odcCommands: ['merge:prefer-foreign'] } }, 'odc', version), false);
    assert.equal(agentRuns({ agent: { odcCommands: ['reconcile-merge'] } }, 'odc', version), true);
  }
  assert.equal(agentRuns({ agent: { odcCommands: [] } }, 'odc', 'v97'), true);
  assert.equal(agentRuns({ agent: { odcCommands: [] } }, 'odc', 'v107'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { odcDeclared, ODC_COMMANDS } from '../lib/kinds.mjs';

test('the Node hello offers ODC prefer only with a new bridge pack, never as a dispatch command', () => {
  for (const version of ['v97', 'v107', 'v108', 'v109', null, 'broken']) {
    const declared = odcDeclared({ odcBridge: version });
    assert.equal(declared.includes('merge:prefer-foreign'), ['v108', 'v109'].includes(version));
    assert.ok(declared.includes('reconcile-merge'));
  }
  assert.equal(ODC_COMMANDS.includes('merge:prefer-foreign'), false);
});

// Feature-path delivery (studio_deliver without a job): a Studio step that throws has an unknown result. During the
// merge that is `uncertain` with the instruction to reconcile by receipt (request C-009, front C); before it, a plain
// failure with nothing merged. Pure: no Studio, no bridge.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardDeliveryStep } from '../lib.mjs';

test('an exception during the merge is uncertain and says to reconcile; earlier steps are plain failures', async () => {
  const merge = await guardDeliveryStep('merge', async () => { throw new Error('pipe disconnected'); });
  assert.equal(merge.ok, false); assert.equal(merge.outcome, 'uncertain');
  assert.match(merge.error, /pipe disconnected/); assert.match(merge.error, /never retry an uncertain merge/);
  for (const step of ['check-base', 'preview']) {
    const r = await guardDeliveryStep(step, async () => { throw new Error('bridge gone'); });
    assert.equal(r.ok, false); assert.equal(r.outcome, undefined); assert.match(r.error, /nothing was merged/);
  }
  const answer = { ok: true, merged: true };
  assert.equal(await guardDeliveryStep('merge', async () => answer), answer, 'a normal answer passes unchanged');
});

import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { producerSignaturesOf } from '../producer-signatures.mjs';
import { taskWarnings, warningFields } from '../delivery-warnings.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
for (const reused of [false, true]) test(`producer hash warning reaches every delivery answer (reused=${reused})`, () => {
  const state = { capturedProducers: { Example: { producer: 'Example', path: 'C:/capture.avsig', reusedFromCache: reused,
    hashUnverified: ['element-key'], elements: [{ originalKey: 'element-key', name: 'Export' }] } } };
  const signature = producerSignaturesOf(state);
  assert.deepEqual(signature.producers[0].hashUnverified, ['element-key']);
  const expected = 'the producer signature uses an older element order; 1 element hashes could not be re-derived and were accepted unverified';
  const check = result => {
    const warning = result.highWarnings.find(w => w.id === 'PRODUCER_HASH_UNVERIFIED');
    assert.ok(warning);
    assert.equal(warning.detail, expected);
    assert.equal(warning.elements[0].key, 'element-key');
    assert.equal(warning.elements[0].name, 'Export');
  };
  check(warningFields(taskWarnings(state)));
  for (const stage of ['delivered', 'failed', 'blocked']) {
    const answer = deliverOutcome({ envelope: { data: { ...state, stage, delivered: stage === 'delivered', code: stage === 'blocked' ? 'STUDIO_DIALOG_PENDING' : undefined, error: 'Stopped' } } }, {});
    check(answer);
  }
});
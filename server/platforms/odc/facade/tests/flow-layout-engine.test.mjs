import './fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCurrentFlowLayout, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';

test('delivery refuses successful receipts from an old or unidentified layout engine', () => {
  assert.equal(hasCurrentFlowLayout({ ok: true, data: { accepted: true, isValid: true } }), false);
  assert.equal(hasCurrentFlowLayout({ ok: true, data: { flowLayoutEngine: 'old' } }), false);
  assert.equal(hasCurrentFlowLayout({ ok: true, data: { flowLayoutEngine: requiredFlowLayoutEngine } }), true);
});

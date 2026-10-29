import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { assertBridgeTrust } from '../../scripts/bridge-trust-gate.mjs';

const key = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
test('release gate refuses absent bridge trust anchors', () => {
  assert.throws(() => assertBridgeTrust({ publicKey: '', nativeKey: '', thumbprint: '', nativeThumbprint: '' }), /anchors/);
});
test('release gate refuses differing public keys or Authenticode pins', () => {
  const publicKey = key(); const thumbprint = 'A'.repeat(40);
  assert.throws(() => assertBridgeTrust({ publicKey, nativeKey: key(), thumbprint, nativeThumbprint: thumbprint }), /differ/);
  assert.throws(() => assertBridgeTrust({ publicKey, nativeKey: publicKey, thumbprint, nativeThumbprint: 'B'.repeat(40) }), /differ/);
});
test('release gate accepts matching Ed25519 keys and normalized pins', () => {
  const publicKey = key();
  assert.doesNotThrow(() => assertBridgeTrust({ publicKey, nativeKey: publicKey, thumbprint: 'a'.repeat(40), nativeThumbprint: 'A'.repeat(40) }));
});

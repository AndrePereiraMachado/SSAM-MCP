import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
test('release gate refuses a missing or different Microsoft root set', () => {
  const publicKey = key(); const options = { publicKey, nativeKey: publicKey, thumbprint: 'A'.repeat(40), nativeThumbprint: 'A'.repeat(40) };
  assert.throws(() => assertBridgeTrust({ ...options, microsoftRoots: [] }), /root anchors/);
  assert.throws(() => assertBridgeTrust({ ...options, nativeRoots: ['B'.repeat(64)] }), /root anchors/);
});
test('release gate checks compiled anchors and the optional watcher public key', t => {
  const publicKey = key(); const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'public-key.pem'); fs.writeFileSync(file, publicKey);
  const roots = ['A'.repeat(64)]; const thumbprint = 'B'.repeat(40);
  const options = { publicKey, nativeKey: publicKey, thumbprint, nativeThumbprint: thumbprint, microsoftRoots: roots, nativeRoots: roots, publicKeyFile: file, nativeExecutable: 'test-only.exe' };
  const result = { spkiSha256: createHash('sha256').update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex'), thumbprint, microsoftRoots: roots };
  assert.doesNotThrow(() => assertBridgeTrust({ ...options, run: () => JSON.stringify(result) }));
  assert.throws(() => assertBridgeTrust({ ...options, run: () => JSON.stringify({ ...result, thumbprint: 'C'.repeat(40) }) }), /executable trust anchors differ/);
  fs.writeFileSync(file, key());
  assert.throws(() => assertBridgeTrust({ ...options, run: () => JSON.stringify(result) }), /Watcher public key differs/);
});

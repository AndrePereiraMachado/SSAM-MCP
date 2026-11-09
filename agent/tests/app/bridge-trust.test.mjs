import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBridgeTrust, readTrustPublicKey, spkiBase64 } from '../../scripts/bridge-trust-gate.mjs';

// App 0.2.8: the only owner anchor is the Ed25519 key given to the build; there is no Authenticode pin any more.
const key = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
const digest = publicKey => createHash('sha256').update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
test('release gate refuses an absent trust key (empty anchor = feature off, never a release)', () => {
  assert.throws(() => assertBridgeTrust({ publicKey: '' }), /anchors must be configured/);
  assert.throws(() => assertBridgeTrust({}), /anchors must be configured/);
});
test('release gate refuses a key that is not Ed25519, and a JavaScript anchor that differs from the build input', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => assertBridgeTrust({ publicKey: ec }), /Ed25519/);
  assert.throws(() => assertBridgeTrust({ publicKey: key(), jsKey: key() }), /differ/);
});
test('release gate accepts one Ed25519 key, as PEM or as the base64 SPKI the native core is built with', () => {
  const publicKey = key();
  assert.equal(assertBridgeTrust({ publicKey, jsKey: '' }), digest(publicKey).toUpperCase());
  assert.equal(assertBridgeTrust({ publicKey: spkiBase64(publicKey), jsKey: publicKey }), digest(publicKey).toUpperCase());
});
test('release gate refuses a missing or different Microsoft root set', () => {
  const options = { publicKey: key(), jsKey: '' };
  assert.throws(() => assertBridgeTrust({ ...options, microsoftRoots: [] }), /root anchors/);
  assert.throws(() => assertBridgeTrust({ ...options, nativeRoots: ['B'.repeat(64)] }), /root anchors/);
});
test('release gate compares the native executable with the build input file, and refuses a private key as input', t => {
  const publicKey = key(); const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'public-key.pem'); fs.writeFileSync(file, publicKey);
  const roots = ['A'.repeat(64)];
  const options = { microsoftRoots: roots, nativeRoots: roots, publicKeyFile: file, nativeExecutable: 'test-only.exe', jsKey: '' };
  const result = { spkiSha256: digest(publicKey), microsoftRoots: roots };
  assert.doesNotThrow(() => assertBridgeTrust({ ...options, run: () => JSON.stringify(result) }));
  assert.throws(() => assertBridgeTrust({ ...options, run: () => JSON.stringify({ ...result, spkiSha256: '' }) }), /executable trust anchors differ/, 'a core built without the key');
  assert.throws(() => assertBridgeTrust({ ...options, run: () => JSON.stringify({ ...result, spkiSha256: digest(key()) }) }), /executable trust anchors differ/);
  assert.throws(() => assertBridgeTrust({ ...options, run: () => JSON.stringify({ ...result, microsoftRoots: ['C'.repeat(64)] }) }), /executable trust anchors differ/);
  fs.writeFileSync(file, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => readTrustPublicKey(file), /private key is never given/);
});

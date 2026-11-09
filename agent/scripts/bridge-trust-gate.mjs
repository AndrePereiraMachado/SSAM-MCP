// The release gate of the trust anchor (app 0.2.8, agent 0.3.17 / 0.4.14-native). The only owner anchor is an Ed25519 public
// key (the vigia vault's manifest key, printed once by server/deploy/vigia/set-secrets.ps1), given to the build as an explicit
// input (--trust-public-key <pem>): never read from the server or the environment. There is no Authenticode anchor any more:
// the Windows build is never Authenticode-signed, so an owner bridge is trusted by its signed manifest and the sha256 of its
// files, and an app update by the signed update statement (src/main/core/update-signature.mjs). Microsoft-signed dependencies
// keep their pinned roots, which must be the same in the Node agent and in the native core.
import fs from 'node:fs';
import { createPublicKey, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BRIDGE_MANIFEST_PUBLIC_KEY, BRIDGE_MICROSOFT_ROOTS } from '../agent/lib/bridge-trust.mjs';

// The key of a PEM, or of the base64 of an SPKI DER, when it is one Ed25519 public key; throws otherwise.
export function ed25519Key(text) {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('Bridge trust anchors must be configured before building the application (--trust-public-key <the owner Ed25519 public key PEM>)');
  let key;
  try { key = value.includes('-----BEGIN') ? createPublicKey(value) : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw new Error('The trust public key is not a readable public key'); }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('Bridge trust anchors must be Ed25519 keys');
  return key;
}
// The base64 of the SPKI DER (what the native core is compiled with: -p:SsamTrustPublicKey=...).
export const spkiBase64 = text => ed25519Key(text).export({ type: 'spki', format: 'der' }).toString('base64');
export const spkiSha256 = text => createHash('sha256').update(ed25519Key(text).export({ type: 'spki', format: 'der' })).digest('hex').toUpperCase();
// The PEM of the build input file (the public key only: a private key is refused, so it can never be shipped by mistake).
export function readTrustPublicKey(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/PRIVATE KEY/.test(text)) throw new Error('The trust input must be the public key; a private key is never given to the build');
  return ed25519Key(text).export({ type: 'spki', format: 'pem' });
}

function nativeRootsOf(source) {
  return [...(source.match(/MicrosoftRoots\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([A-Fa-f0-9]+)"/g)].map(m => m[1]);
}
// options: publicKey (PEM or base64 SPKI) or publicKeyFile (the build input), nativeExecutable (its trust-anchors must report
// the same key and roots), microsoftRoots/nativeRoots/nativeSource/jsKey (tests). Returns the SHA-256 of the pinned SPKI.
export function assertBridgeTrust(options = {}) {
  const source = options.nativeSource ?? fs.readFileSync(new URL('../native/Ssam.Agent/BridgeTrust.cs', import.meta.url), 'utf8');
  const roots = options.microsoftRoots ?? BRIDGE_MICROSOFT_ROOTS;
  const nativeRoots = options.nativeRoots ?? nativeRootsOf(source);
  const normalizedRoots = values => values.map(v => v.toUpperCase()).sort();
  if (!roots.length || roots.some(r => !/^[a-fA-F0-9]{64}$/.test(r)) || JSON.stringify(normalizedRoots(roots)) !== JSON.stringify(normalizedRoots(nativeRoots))) throw new Error('Microsoft root anchors are missing or differ');
  const input = options.publicKey ?? (options.publicKeyFile ? readTrustPublicKey(options.publicKeyFile) : '');
  const digest = spkiSha256(input);
  // The Node agent's own constant, when the owner set it, must be the same key (it is empty in the source by default).
  const jsKey = options.jsKey ?? BRIDGE_MANIFEST_PUBLIC_KEY;
  if (jsKey && spkiSha256(jsKey) !== digest) throw new Error('JavaScript and native bridge trust anchors differ');
  if (options.nativeExecutable) {
    const result = JSON.parse((options.run ?? execFileSync)(options.nativeExecutable, ['trust-anchors'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    if (String(result.spkiSha256 ?? '').toUpperCase() !== digest || JSON.stringify(normalizedRoots(result.microsoftRoots ?? [])) !== JSON.stringify(normalizedRoots(roots)))
      throw new Error('Native executable trust anchors differ from the build input (build it with: node scripts/build-native.mjs --trust-public-key <the same pem>)');
  }
  return digest;
}

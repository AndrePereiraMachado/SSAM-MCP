import fs from 'node:fs';
import { createPublicKey, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BRIDGE_MANIFEST_PUBLIC_KEY, BRIDGE_AUTHENTICODE_THUMBPRINT, BRIDGE_MICROSOFT_ROOTS } from '../agent/lib/bridge-trust.mjs';

function nativeConstant(source, name) {
  const match = new RegExp('const string ' + name + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*;').exec(source);
  if (!match) throw new Error('The native bridge trust anchors are missing');
  return JSON.parse(match[1]);
}
export function assertBridgeTrust(options = {}) {
  const source = options.nativeSource ?? fs.readFileSync(new URL('../native/Ssam.Agent/BridgeTrust.cs', import.meta.url), 'utf8');
  const publicKey = options.publicKey ?? BRIDGE_MANIFEST_PUBLIC_KEY;
  const thumbprint = options.thumbprint ?? BRIDGE_AUTHENTICODE_THUMBPRINT;
  const nativeKey = options.nativeKey ?? nativeConstant(source, 'ManifestPublicKey');
  const nativeThumbprint = options.nativeThumbprint ?? nativeConstant(source, 'AuthenticodeThumbprint');
  const roots = options.microsoftRoots ?? BRIDGE_MICROSOFT_ROOTS;
  const nativeRoots = options.nativeRoots ?? [...(source.match(/MicrosoftRoots\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([A-Fa-f0-9]+)"/g)].map(m => m[1]);
  const normalizedRoots = values => values.map(v => v.toUpperCase()).sort();
  if (!roots.length || roots.some(r => !/^[a-fA-F0-9]{64}$/.test(r)) || JSON.stringify(normalizedRoots(roots)) !== JSON.stringify(normalizedRoots(nativeRoots))) throw new Error('Microsoft root anchors are missing or differ');
  if (!publicKey || !nativeKey || !/^[a-fA-F0-9]{40}$/.test(thumbprint) || !/^[a-fA-F0-9]{40}$/.test(nativeThumbprint))
    throw new Error('Bridge trust anchors must be configured before building the application');
  const key = createPublicKey(publicKey), native = createPublicKey(nativeKey);
  if (key.asymmetricKeyType !== 'ed25519' || native.asymmetricKeyType !== 'ed25519') throw new Error('Bridge trust anchors must be Ed25519 keys');
  if (!key.export({ type: 'spki', format: 'der' }).equals(native.export({ type: 'spki', format: 'der' })) || thumbprint.toUpperCase() !== nativeThumbprint.toUpperCase())
    throw new Error('JavaScript and native bridge trust anchors differ');
  const digest = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').toUpperCase();
  if (options.publicKeyFile && !key.export({ type: 'spki', format: 'der' }).equals(createPublicKey(fs.readFileSync(options.publicKeyFile)).export({ type: 'spki', format: 'der' }))) throw new Error('Watcher public key differs from the build anchor');
  if (options.nativeExecutable) {
    const result = JSON.parse((options.run ?? execFileSync)(options.nativeExecutable, ['trust-anchors'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    if (result.spkiSha256?.toUpperCase() !== digest || result.thumbprint?.toUpperCase() !== thumbprint.toUpperCase() || JSON.stringify(normalizedRoots(result.microsoftRoots ?? [])) !== JSON.stringify(normalizedRoots(roots))) throw new Error('Native executable trust anchors differ from JavaScript');
  }
}

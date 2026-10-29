import fs from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { BRIDGE_MANIFEST_PUBLIC_KEY, BRIDGE_AUTHENTICODE_THUMBPRINT } from '../agent/lib/bridge-trust.mjs';

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
  if (!publicKey || !nativeKey || !/^[a-fA-F0-9]{40}$/.test(thumbprint) || !/^[a-fA-F0-9]{40}$/.test(nativeThumbprint))
    throw new Error('Bridge trust anchors must be configured before building the application');
  const key = createPublicKey(publicKey), native = createPublicKey(nativeKey);
  if (key.asymmetricKeyType !== 'ed25519' || native.asymmetricKeyType !== 'ed25519') throw new Error('Bridge trust anchors must be Ed25519 keys');
  if (!key.export({ type: 'spki', format: 'der' }).equals(native.export({ type: 'spki', format: 'der' })) || thumbprint.toUpperCase() !== nativeThumbprint.toUpperCase())
    throw new Error('JavaScript and native bridge trust anchors differ');
}

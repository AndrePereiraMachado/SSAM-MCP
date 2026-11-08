// Build-time trust anchor of the Node agent: the owner's Ed25519 public key (the vigia vault's manifest key, printed once by
// server/deploy/vigia/set-secrets.ps1), as a PEM or as the base64 of its SPKI DER. An empty anchor deliberately disables remote
// bridge installation (the hello says bridgeOffer false). Never read it from the server or the environment.
// Since agent 0.3.17 there is no Authenticode anchor: a bridge the owner built is trusted by its Ed25519-signed manifest and
// the sha256/size of every file; only Microsoft-signed dependencies keep their Authenticode check (BRIDGE_MICROSOFT_ROOTS).
// The Windows app runs the native core, whose anchor comes from the build input (native/Ssam.Agent: SsamTrustPublicKey).
export const BRIDGE_MANIFEST_PUBLIC_KEY = '';
// SHA-256 of the provider-chain root observed on the shipped Microsoft client dependencies.
export const BRIDGE_MICROSOFT_ROOTS = ['847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61'];
// A signed/notarized macOS distribution must bundle this verifier and its CA store.
export const BRIDGE_MAC_VERIFIER = 'tools/osslsigncode';

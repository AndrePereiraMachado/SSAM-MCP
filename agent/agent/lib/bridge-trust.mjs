// Build-time trust anchors. The owner replaces these with the watcher key script.
// Empty anchors deliberately disable remote bridge installation. Never read them from the server or environment.
export const BRIDGE_MANIFEST_PUBLIC_KEY = '';
export const BRIDGE_AUTHENTICODE_THUMBPRINT = '';
// SHA-256 of the provider-chain root observed on the shipped Microsoft client dependencies.
export const BRIDGE_MICROSOFT_ROOTS = ['847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61'];
// A signed/notarized macOS distribution must bundle this verifier and its CA store.
export const BRIDGE_MAC_VERIFIER = 'tools/osslsigncode';

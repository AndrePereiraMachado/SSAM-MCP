// Build-time trust anchors. The owner replaces these with the watcher key script.
// Empty anchors deliberately disable remote bridge installation. Never read them from the server or environment.
export const BRIDGE_MANIFEST_PUBLIC_KEY = '';
export const BRIDGE_AUTHENTICODE_THUMBPRINT = '';
// A signed/notarized macOS distribution must bundle this verifier and its CA store.
export const BRIDGE_MAC_VERIFIER = 'tools/osslsigncode';

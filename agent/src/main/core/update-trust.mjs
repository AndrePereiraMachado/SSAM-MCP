// The update trust anchor of the Windows app (app 0.2.8): the base64 SPKI DER of the owner's Ed25519 public key (the vigia
// vault's manifest key), written into the main bundle by the build from its explicit input (scripts/build.mjs
// --trust-public-key <pem>, electron.vite.config.mjs define). Empty (a checkout, a test app, a build without the input): the
// Windows app never installs an update by itself. Never read from the server or the environment at runtime.
/* global __SSAM_UPDATE_PUBLIC_KEY__ */
// eslint-disable-next-line no-undef
export const UPDATE_PUBLIC_KEY = typeof __SSAM_UPDATE_PUBLIC_KEY__ === 'string' ? __SSAM_UPDATE_PUBLIC_KEY__ : '';

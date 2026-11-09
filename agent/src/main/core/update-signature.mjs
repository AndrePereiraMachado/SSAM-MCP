// The signed update statement of a Windows build (app 0.2.8). The Windows app is never Authenticode-signed, so
// electron-updater's publisher check cannot say who made an installer, and the sha512 of latest.yml only proves that the
// download matches the feed. The owner signs, with his Ed25519 key (the vigia vault's manifest key), a statement that binds
// the app, the platform, the version, the installer's file name, size and sha512; the app pins the public key at build time
// (update-trust.mjs) and installs a downloaded update only when the statement verifies and names exactly the bytes it
// downloaded, and a version newer than its own. Pure: the electron side (updates.mjs) gives it the texts and the hashes.
//
// What the publisher puts next to the installer in the feed (scripts/sign-windows-update.mjs writes it):
//   <installer file name>.ed25519.json   {"schema":1,"payload":"<base64 of the statement JSON bytes>","signature":"<base64>"}
// The signature is Ed25519 over UPDATE_STATEMENT_DOMAIN + the payload bytes: the domain keeps a bridge manifest signed by the
// same key from ever being read as an update statement (and the reverse).
import { createPublicKey, sign, verify } from 'node:crypto';

export const UPDATE_STATEMENT_DOMAIN = 'SSAM-AGENT-UPDATE-STATEMENT/1\n';
export const STATEMENT_SUFFIX = '.ed25519.json';
export const STATEMENT_MAX_BYTES = 16 * 1024;
export const STATEMENT_KIND = 'ssam-agent-app-update';
export const APP_IDENTITY = Object.freeze({ appId: 'com.ssam.agent', productName: 'SSAM Agent' });
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const INSTALLER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.exe$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;

// The refusal codes of an update (the panel shows the message; the log keeps the code).
export const UPDATE_CODES = Object.freeze({
  KEY_MISSING: 'UPDATE_KEY_MISSING', SIGNATURE_MISSING: 'UPDATE_SIGNATURE_MISSING', SIGNATURE_INVALID: 'UPDATE_SIGNATURE_INVALID',
  STATEMENT_MISMATCH: 'UPDATE_STATEMENT_MISMATCH', DOWNGRADE: 'UPDATE_DOWNGRADE', INSTALLER_MISMATCH: 'UPDATE_INSTALLER_MISMATCH',
});
const refusal = (code, message) => ({ code, message: code + ': ' + message });

export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? ''));
  return match ? match.slice(1).map(Number) : null;
}
export function compareVersions(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

// The pinned key, as a PEM or as the base64 of its SPKI DER; null when it is empty or not one Ed25519 public key.
export function updateKey(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  try {
    const key = value.includes('-----BEGIN') ? createPublicKey(value) : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

// The installer's own file name in the feed: the basename of the url latest.yml gives (relative, or absolute on the same feed).
export function installerName(url) {
  let name = String(url ?? '');
  try { if (/^[a-z][a-z0-9+.-]*:/i.test(name)) name = new URL(name).pathname; } catch { return null; }
  try { name = decodeURIComponent(name.split('/').pop() ?? ''); } catch { return null; }
  return INSTALLER.test(name) ? name : null;
}
export const statementName = installer => installer + STATEMENT_SUFFIX;
// The url of the statement of an installer on a feed (always on the feed, whatever host latest.yml names for the installer).
export const statementUrl = (feed, installer) => String(feed).replace(/\/+$/, '') + '/' + encodeURIComponent(installer) + STATEMENT_SUFFIX;

// The statement the owner signs (scripts/sign-windows-update.mjs).
export function statementFor({ version, file, size, sha512, createdAt = new Date().toISOString(), platform = 'win32', arch = 'x64', channel = 'latest' }) {
  const statement = { schema: 1, kind: STATEMENT_KIND, ...APP_IDENTITY, platform, arch, channel, version, file, size, sha512, createdAt };
  const problem = shapeProblem(statement);
  if (problem) throw new Error('Invalid update statement: ' + problem);
  return statement;
}
function shapeProblem(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (s.schema !== 1 || s.kind !== STATEMENT_KIND) return 'unknown schema or kind';
  if (s.appId !== APP_IDENTITY.appId || s.productName !== APP_IDENTITY.productName) return 'another application';
  if (s.platform !== 'win32' || s.arch !== 'x64' || s.channel !== 'latest') return 'another platform, architecture or channel';
  if (!parseVersion(s.version)) return 'version is not x.y.z';
  if (!INSTALLER.test(String(s.file ?? ''))) return 'file is not an installer name';
  if (!Number.isSafeInteger(s.size) || s.size < 1) return 'size is not a positive integer';
  if (!SHA512.test(String(s.sha512 ?? ''))) return 'sha512 is not the base64 of 64 bytes';
  if (!Number.isFinite(Date.parse(s.createdAt))) return 'createdAt is not a date';
  return null;
}
export function signStatement(statement, privateKey) {
  const payload = Buffer.from(JSON.stringify(statement));
  const signature = sign(null, Buffer.concat([Buffer.from(UPDATE_STATEMENT_DOMAIN), payload]), privateKey);
  return JSON.stringify({ schema: 1, payload: payload.toString('base64'), signature: signature.toString('base64') }) + '\n';
}

// The verified statement of an envelope text: { statement } or { problem: {code, message} }.
export function readStatement(text, publicKey) {
  const key = typeof publicKey === 'object' && publicKey?.asymmetricKeyType ? publicKey : updateKey(publicKey);
  if (!key) return { problem: refusal(UPDATE_CODES.KEY_MISSING, 'this build has no pinned update key, so no update can be verified') };
  if (typeof text !== 'string' || !text.trim()) return { problem: refusal(UPDATE_CODES.SIGNATURE_MISSING, 'the update server has no signed statement for this installer') };
  if (Buffer.byteLength(text) > STATEMENT_MAX_BYTES) return { problem: refusal(UPDATE_CODES.SIGNATURE_INVALID, 'the signed statement is too large') };
  let envelope, payload, signature;
  try {
    envelope = JSON.parse(text);
    if (envelope?.schema !== 1 || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error();
    payload = Buffer.from(envelope.payload, 'base64'); signature = Buffer.from(envelope.signature, 'base64');
    if (payload.toString('base64') !== envelope.payload || signature.length !== 64) throw new Error();
  } catch { return { problem: refusal(UPDATE_CODES.SIGNATURE_INVALID, 'the signed statement is malformed') }; }
  if (!verify(null, Buffer.concat([Buffer.from(UPDATE_STATEMENT_DOMAIN), payload]), key, signature))
    return { problem: refusal(UPDATE_CODES.SIGNATURE_INVALID, 'the statement is not signed by the pinned update key') };
  let statement;
  try { statement = JSON.parse(payload.toString('utf8')); } catch { statement = null; }
  const shape = shapeProblem(statement);
  if (shape) return { problem: refusal(UPDATE_CODES.SIGNATURE_INVALID, 'the signed statement is not a Windows SSAM Agent update (' + shape + ')') };
  return { statement };
}

// Whether a downloaded update may be installed: null, or {code, message}. info is what electron-updater announced (latest.yml:
// version, files[{url, sha512, size}]); downloaded is what was measured on the file itself ({sha512, size}).
export function updateStatementProblem({ text, publicKey, info, downloaded, current }) {
  const { statement, problem } = readStatement(text, publicKey);
  if (problem) return problem;
  const installers = (info?.files ?? []).filter(f => installerName(f?.url));
  if (installers.length !== 1) return refusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the update server announced no single installer');
  const announced = installers[0];
  if (statement.version !== String(info?.version ?? '')) return refusal(UPDATE_CODES.STATEMENT_MISMATCH, `the signed statement is for version ${statement.version}, the update server announced ${info?.version ?? 'none'}`);
  if (statement.file !== installerName(announced.url)) return refusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the signed statement names another installer');
  if (statement.sha512 !== announced.sha512 || (announced.size !== undefined && statement.size !== announced.size))
    return refusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the signed sha512 or size differs from what the update server announced');
  if (statement.sha512 !== downloaded?.sha512 || statement.size !== downloaded?.size)
    return refusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the downloaded installer is not the one the owner signed');
  const now = parseVersion(current);
  if (!now) return refusal(UPDATE_CODES.DOWNGRADE, 'this app has no readable version, so no update is known to be newer');
  if (compareVersions(parseVersion(statement.version), now) <= 0) return refusal(UPDATE_CODES.DOWNGRADE, `the signed version ${statement.version} is not newer than this app (${current})`);
  return null;
}

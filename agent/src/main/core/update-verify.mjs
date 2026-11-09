// The verification of a downloaded Windows update (app 0.2.8), without Electron: the signed statement of its installer from the
// feed (update-signature.mjs), the bytes on disk, then the installer's own version resource (readInstaller, given by
// electron/updates.mjs). Returns null (it may be installed) or {code, message}. macOS: checkMacUpdate, below.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { installerVersionProblem } from './update-model.mjs';
import { UPDATE_CODES, STATEMENT_MAX_BYTES, APP_IDENTITY, installerName, statementUrl, updateStatementProblem, parseVersion, compareVersions } from './update-signature.mjs';
import { UPDATE_PUBLIC_KEY } from './update-trust.mjs';

// The sha512 (base64, as latest.yml writes it) and the size of a downloaded file, read from the file itself.
export async function measureFile(file) {
  const hash = createHash('sha512'); let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha512: hash.digest('base64'), size };
}

// The text of a signed statement from the feed, or null when there is none (any status but 200, an empty or oversized body,
// a network failure). The signature, not the transport, decides; the size cap keeps a hostile server from filling memory.
export async function fetchStatementText(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  let response;
  try { response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
  if (response.status !== 200 || !response.body) { await response.body?.cancel?.().catch(() => {}); return null; }
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > STATEMENT_MAX_BYTES) { await response.body.cancel?.().catch(() => {}); return null; }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > STATEMENT_MAX_BYTES) { await response.body.cancel?.().catch(() => {}); return null; }
      chunks.push(Buffer.from(chunk));
    }
  } catch { return null; }
  return size ? Buffer.concat(chunks).toString('utf8') : null;
}

// Whether a downloaded Windows update may be installed: {approved: {file, sha512, size}} (the file and the bytes that matched
// the owner's signed statement, which electron/updates.mjs hashes again right before the installer runs) or {problem: {code,
// message}}: the signed statement of its installer, fetched from the feed, checked against the pinned key and the bytes on
// disk; then the installer's own version.
export async function checkWindowsUpdate({ info, feed, currentVersion, publicKey = UPDATE_PUBLIC_KEY, fetchText = fetchStatementText, measure = measureFile, readInstaller = () => ({}) }) {
  const installer = (info?.files ?? []).map(f => installerName(f?.url)).find(Boolean);
  const text = installer && String(publicKey ?? '').trim() ? await fetchText(statementUrl(feed, installer)) : null;
  let downloaded = null;
  try { downloaded = info?.downloadedFile ? await measure(info.downloadedFile) : null; } catch { downloaded = null; }
  const signed = updateStatementProblem({ text, publicKey, info, downloaded, current: currentVersion });
  if (signed) return { problem: signed };
  const problem = installerVersionProblem({ ...readInstaller(info?.downloadedFile), label: info?.version, current: currentVersion });
  if (problem) return { problem: { code: UPDATE_CODES.INSTALLER_MISMATCH, message: UPDATE_CODES.INSTALLER_MISMATCH + ': ' + problem } };
  return { approved: { file: info.downloadedFile, sha512: downloaded.sha512, size: downloaded.size } };
}

// The same answer as null (it may be installed) or {code, message}.
export async function verifyWindowsUpdate(options) {
  const answer = await checkWindowsUpdate(options);
  return answer.problem ?? null;
}

// macOS (app 0.2.8, review M1 of agent/mac-028): electron-updater checks only that the downloaded ZIP has the sha512 latest-mac.yml
// announces, and allowDowngrade compares only that file's label; Squirrel.Mac then checks only the code signature (Developer ID,
// same Team ID). So a feed could serve the genuinely signed 0.2.7 app, zipped again, under the label 0.2.9 and roll every Mac back
// (and 0.2.7 has no update feed: it would stay there). The app's own version is in the Info.plist inside the ZIP, which the code
// signature seals (Squirrel.Mac refuses the bundle if it was changed): it must be this app (CFBundleIdentifier, the bundle name),
// exactly the version the feed announced and newer than this app, as installerVersionProblem asks of a Windows installer.
const BUNDLE_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:\.\d{1,9})?$/;
const bundleParts = value => { const m = BUNDLE_VERSION.exec(String(value ?? '')); return m ? m.slice(1, 4).map(Number) : null; };
const compareParts = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const macRefusal = (code, message) => ({ code, message: code + ': ' + message });

// The string values of an XML property list's top-level dict (what electron-builder writes and codesign keeps), or null when the
// text is not one. Binary plists are converted by the caller (plutil) first.
export function plistStrings(text) {
  const body = /<plist[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>\s*$/.exec(String(text ?? ''));
  if (!body) return null;
  const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const out = {}; let depth = 0;
  // Only the keys of the top-level dict: nested dicts and arrays are skipped by depth.
  for (const m of body[1].matchAll(/<(\/?)(dict|array)\s*>|<(dict|array)\s*\/>|<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\s*\/>)?/g)) {
    if (m[2]) { depth += m[1] ? -1 : 1; continue; }
    if (m[3]) continue;
    if (depth === 0 && m[4] !== undefined && m[5] !== undefined) out[decode(m[4])] = decode(m[5]);
  }
  return out;
}

// The bundle of a downloaded Mac update, as read from its Info.plist ({identifier, name, shortVersion, bundleVersion} or
// {error}), checked against this app: null when it may be handed to Squirrel.Mac, or {code, message}.
export function macBundleProblem({ bundle, label, current, appId = APP_IDENTITY.appId, appName = APP_IDENTITY.productName }) {
  const { INSTALLER_MISMATCH, DOWNGRADE } = UPDATE_CODES;
  if (!bundle || bundle.error) return macRefusal(INSTALLER_MISMATCH, `the downloaded update has no readable ${appName}.app Info.plist${bundle?.error ? ' (' + String(bundle.error).slice(0, 200) + ')' : ''}; it is not installed`);
  if (bundle.identifier !== appId) return macRefusal(INSTALLER_MISMATCH, `the downloaded app is "${bundle.identifier ?? 'no CFBundleIdentifier'}", not ${appId}; it is not installed`);
  if (bundle.name !== appName) return macRefusal(INSTALLER_MISMATCH, `the downloaded app is "${bundle.name ?? '?'}.app", not ${appName}.app; it is not installed`);
  const got = parseVersion(bundle.shortVersion);
  if (!got) return macRefusal(INSTALLER_MISMATCH, `the downloaded app has no readable version (CFBundleShortVersionString "${bundle.shortVersion ?? ''}"); it is not installed`);
  const build = bundleParts(bundle.bundleVersion);
  if (!build || compareParts(build, got) !== 0) return macRefusal(INSTALLER_MISMATCH, `the downloaded app's CFBundleVersion "${bundle.bundleVersion ?? ''}" is not its version ${bundle.shortVersion}; it is not installed`);
  const want = parseVersion(label);
  if (!want || compareVersions(got, want) !== 0) return macRefusal(INSTALLER_MISMATCH, `the downloaded app is version ${bundle.shortVersion}, but the update server announced ${label}; it is not installed`);
  const now = parseVersion(current);
  if (!now) return macRefusal(DOWNGRADE, 'this app has no readable version, so no update is known to be newer');
  if (compareVersions(got, now) <= 0) return macRefusal(DOWNGRADE, `the downloaded app is version ${bundle.shortVersion}, not newer than this app (${current}); it is not installed`);
  return null;
}

// Whether a downloaded Mac update may be handed to Squirrel.Mac: {approved: {file, sha512, size}} or {problem: {code, message}}.
// The ZIP on disk must be one latest-mac.yml lists (electron-updater checked that while downloading; the bytes measured here are
// the ones electron/updates.mjs hashes again right before the hand-off), and its app bundle must pass macBundleProblem.
export async function checkMacUpdate({ info, currentVersion, readBundle, measure = measureFile }) {
  const file = info?.downloadedFile;
  let downloaded = null;
  try { downloaded = file ? await measure(file) : null; } catch { downloaded = null; }
  if (!downloaded) return { problem: macRefusal(UPDATE_CODES.INSTALLER_MISMATCH, 'the downloaded update cannot be read; it is not installed') };
  const listed = (info?.files ?? []).filter(f => /\.zip$/i.test(String(f?.url ?? '')));
  if (!listed.some(f => f.sha512 === downloaded.sha512 && (f.size == null || Number(f.size) === downloaded.size)))
    return { problem: macRefusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the downloaded ZIP is not the one the update server listed (sha512/size); it is not installed') };
  let bundle;
  try { bundle = typeof readBundle === 'function' ? await readBundle(file) : { error: 'no reader' }; } catch (error) { bundle = { error: String(error?.message ?? error) }; }
  const problem = macBundleProblem({ bundle, label: info?.version, current: currentVersion });
  if (problem) return { problem };
  return { approved: { file, sha512: downloaded.sha512, size: downloaded.size, bundleVersion: bundle.shortVersion } };
}

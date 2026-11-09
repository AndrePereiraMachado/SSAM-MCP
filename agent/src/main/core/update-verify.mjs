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

// Review M1-R2 of agent/mac-028: what the gate reads must be what Squirrel.Mac installs. Squirrel.Mac unpacks the whole ZIP and
// looks for the bundle of this app's identifier (as CoreFoundation reads it); a decoy next to it (a second `Old.APP`, a nested
// `x/SSAM Agent.app`) or a plist that a regex reads differently from CoreFoundation (keys in an XML comment) let a signed 0.2.7
// through. So the ZIP may hold exactly one tree, `SSAM Agent.app/` with this exact case, and nothing else; the plist is read only
// by plutil (CoreFoundation, the same reader as Squirrel's), and anything unreadable fails closed.

// The rows of `unzip -Z` (zipinfo short format): {entries: the header's "number of entries", rows: [{mode, name}]}. A row is the
// 10-character mode, 7 fields (version, os, size, flags, method, date, time) and the name after one space.
export function zipListingRows(text) {
  const lines = String(text ?? '').split('\n').map(line => line.replace(/\r$/, ''));
  const entries = Number(/^Zip file size: \d+ bytes, number of entries: (\d+)$/m.exec(lines.join('\n'))?.[1] ?? NaN);
  const rows = [];
  for (const line of lines) {
    const m = /^([-a-zA-Z?]{10})\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+ (.*)$/.exec(line);
    if (m) rows.push({ mode: m[1], name: m[2] });
  }
  return { entries, rows };
}

// The names of `unzip -Z1`, one per line (the last newline ends the list).
export const zipNames = text => { const lines = String(text ?? '').split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };

// The paths whose type the gate depends on: none may be a symlink (Squirrel and plutil would follow it elsewhere).
const gatedPaths = root => [root, root + '/Contents', root + '/Contents/Info.plist', root + '/Contents/Resources', root + '/Contents/Resources/app-update.yml'];

// Whether the ZIP's entries are one `<appName>.app/` tree and nothing else: null, or the reason it is refused. names from
// `unzip -Z1`, listing from zipListingRows(`unzip -Z`); both must name the same entries, as many as the header counts.
export function macZipProblem({ names, listing, appName = APP_IDENTITY.productName }) {
  const root = appName + '.app';
  if (!Array.isArray(names) || names.length === 0) return 'the ZIP lists no entries';
  if (!listing || listing.entries !== names.length || listing.rows.length !== names.length) return `the ZIP listing does not add up (${names.length} names, ${listing?.rows?.length ?? 0} rows, header ${listing?.entries})`;
  const seen = new Set(), folded = new Set(), modes = new Map();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (listing.rows[i].name !== name) return `the ZIP listings disagree at entry ${i + 1}`;
    if (/[\\\r\n\0]/.test(name) || name.startsWith('/')) return `the ZIP entry "${name.slice(0, 120)}" is not a plain relative path`;
    if (!name.startsWith(root + '/')) return `the ZIP entry "${name.slice(0, 120)}" is outside ${root}/ (one ${root} and nothing else)`;
    const parts = name.replace(/\/$/, '').split('/');
    if (parts.some(p => p === '' || p === '.' || p === '..')) return `the ZIP entry "${name.slice(0, 120)}" has an empty, "." or ".." part`;
    const key = name.replace(/\/$/, '');
    if (seen.has(key)) return `the ZIP has "${key.slice(0, 120)}" twice`;
    const fold = key.normalize('NFD').toLowerCase();
    if (folded.has(fold)) return `the ZIP has two entries that differ only in case or normalization ("${key.slice(0, 120)}")`;
    seen.add(key); folded.add(fold); modes.set(key, listing.rows[i].mode);
  }
  for (const gated of gatedPaths(root)) if (modes.get(gated)?.startsWith('l')) return `the ZIP entry "${gated}" is a symlink`;
  if (!modes.get(root + '/Contents/Info.plist')?.startsWith('-')) return `the ZIP has no regular file ${root}/Contents/Info.plist`;
  const yml = modes.get(root + '/Contents/Resources/app-update.yml');
  if (yml !== undefined && !yml.startsWith('-')) return `the ZIP entry ${root}/Contents/Resources/app-update.yml is not a regular file`;
  return null;
}

// The feed of an app-update.yml (its url), or null.
export function appUpdateFeed(text) {
  const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(text ?? ''));
  return match ? match[1].replace(/\/+$/, '') : null;
}

// The bundle of a downloaded Mac update, as read from its Info.plist ({identifier, name, shortVersion, bundleVersion, feed} or
// {error}), checked against this app: null when it may be handed to Squirrel.Mac, or {code, message}. feed: this app's own feed;
// the update must name the same one (review M4-R2: a staging build uploaded to the production feed would pin every Mac that
// installs it to staging), so a Mac only ever installs an update built for the feed it reads.
export function macBundleProblem({ bundle, label, current, feed = null, appId = APP_IDENTITY.appId, appName = APP_IDENTITY.productName }) {
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
  const own = feed ? String(feed).replace(/\/+$/, '') : null;
  if (own && bundle.feed !== own) return macRefusal(INSTALLER_MISMATCH, `the downloaded app updates from ${bundle.feed ?? 'no feed'}, not from this app's feed ${own}; it is not installed`);
  return null;
}

// Whether a downloaded Mac update may be handed to Squirrel.Mac: {approved: {file, sha512, size}} or {problem: {code, message}}.
// The ZIP on disk must be one latest-mac.yml lists (electron-updater checked that while downloading; the bytes measured here are
// the ones electron/updates.mjs hashes again right before the hand-off), and its app bundle must pass macBundleProblem.
// feed: this app's feed (macBundleProblem). The bytes are measured before the gate and again after it: the gate's verdict is
// kept only for the bytes it read (electron/updates.mjs hashes them a third time right before Squirrel.Mac fetches the file).
export async function checkMacUpdate({ info, currentVersion, readBundle, feed = null, measure = measureFile }) {
  const file = info?.downloadedFile;
  let downloaded = null;
  try { downloaded = file ? await measure(file) : null; } catch { downloaded = null; }
  if (!downloaded) return { problem: macRefusal(UPDATE_CODES.INSTALLER_MISMATCH, 'the downloaded update cannot be read; it is not installed') };
  const listed = (info?.files ?? []).filter(f => /\.zip$/i.test(String(f?.url ?? '')));
  if (!listed.some(f => f.sha512 === downloaded.sha512 && (f.size == null || Number(f.size) === downloaded.size)))
    return { problem: macRefusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the downloaded ZIP is not the one the update server listed (sha512/size); it is not installed') };
  let bundle;
  try { bundle = typeof readBundle === 'function' ? await readBundle(file) : { error: 'no reader' }; } catch (error) { bundle = { error: String(error?.message ?? error) }; }
  const problem = macBundleProblem({ bundle, label: info?.version, current: currentVersion, feed });
  if (problem) return { problem };
  let after = null;
  try { after = await measure(file); } catch { after = null; }
  if (!after || after.sha512 !== downloaded.sha512 || after.size !== downloaded.size)
    return { problem: macRefusal(UPDATE_CODES.STATEMENT_MISMATCH, 'the downloaded ZIP changed while it was checked; it is not installed') };
  return { approved: { file, sha512: downloaded.sha512, size: downloaded.size, bundleVersion: bundle.shortVersion } };
}

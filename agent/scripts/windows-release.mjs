// The Windows release of the app (agent app 0.2.0): Authenticode signing of the native core and of the installer, and the
// updater configuration a signed build must carry. scripts/build.mjs uses it; the owner only gives the certificate's public
// identity (never the certificate itself, which stays non-exportable in Cert:\CurrentUser\My of the account that builds):
//   --cert-sha1 <40 hex>        (SSAM_WIN_CERT_SHA1)       the thumbprint of the code signing certificate;
//   --publisher-name <CN>       (SSAM_WIN_PUBLISHER_NAME)  the CN of its subject: the only publisher the updater accepts;
//   --timestamp-url <https://>  (SSAM_WIN_TIMESTAMP_URL)   RFC 3161 timestamp server (default http://timestamp.digicert.com).
// --test-unsigned builds the owner's own test app instead: no signature, no trust anchors, no updates (no app-update.yml),
// pack.json bridgeOffer false (the agent never asks for a bridge offer). It is never published.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publisherNames } from '../src/main/core/update-model.mjs';

export const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';
const THUMBPRINT = /^[0-9A-Fa-f]{40}$/;

// The signing identity of a release build from the options and the environment, or the reason it is incomplete.
export function signingOf(options = {}, env = process.env) {
  const certSha1 = String(options.certSha1 ?? env.SSAM_WIN_CERT_SHA1 ?? '').replace(/\s/g, '');
  const publisherName = String(options.publisherName ?? env.SSAM_WIN_PUBLISHER_NAME ?? '').trim();
  const timestampUrl = String(options.timestampUrl ?? env.SSAM_WIN_TIMESTAMP_URL ?? DEFAULT_TIMESTAMP_URL).trim();
  const problems = [];
  if (!THUMBPRINT.test(certSha1)) problems.push('--cert-sha1 <the 40-hex thumbprint of the code signing certificate> (or SSAM_WIN_CERT_SHA1)');
  if (!publisherName || /[\r\n,]/.test(publisherName)) problems.push('--publisher-name <the CN of the certificate subject> (or SSAM_WIN_PUBLISHER_NAME)');
  if (!/^https?:\/\/[^\s]+$/.test(timestampUrl)) problems.push('--timestamp-url <an RFC 3161 server URL>');
  return problems.length ? { ok: false, problem: 'A signed Windows release needs ' + problems.join(', ') + '. For the unsigned test app use --test-unsigned.' }
    : { ok: true, certSha1: certSha1.toUpperCase(), publisherName, timestampUrl };
}

// The electron-builder configuration of a signed Windows build: signtool with the certificate of the store by thumbprint,
// the publisher name written to app-update.yml (what electron-updater checks every update against), signing forced.
// packExes: the executables of the pack. electron-builder signs every .exe it copies as an extra resource, AFTER pack.json
// recorded their sha256, so the installed app would refuse its own pack; they are signed before the hashes instead
// (signPackExecutables, signNative) and excluded here by name (signExts "!<name>": the app exe, elevate.exe and the
// installer are still signed by electron-builder).
export function signingConfig(signing, packExes = []) {
  return { forceCodeSigning: true, win: { signtoolOptions: { certificateSha1: signing.certSha1, publisherName: [signing.publisherName],
    rfc3161TimeStampServer: signing.timestampUrl, signingHashAlgorithms: ['sha256'] },
    ...(packExes.length ? { signExts: [...new Set(packExes.map(file => '!' + path.posix.basename(String(file))))] } : {}) } };
}

// The .exe files of a pack (pack.json files), relative paths.
export const packExecutables = pack => (pack?.files ?? []).map(f => String(f.path)).filter(p => /\.exe$/i.test(p));

// Signs, in place, every .exe of the staged pack that the release certificate has not signed yet, and records the new
// sha256 and size in pack.json (before the native core is staged, which recomputes every hash again).
export function signPackExecutables(packDir, signing, { run = spawnSync, signtool = null, sha256 } = {}) {
  const file = path.join(packDir, 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const signed = [];
  for (const entry of pack.files ?? []) {
    if (!/\.exe$/i.test(String(entry.path))) continue;
    const target = path.join(packDir, ...String(entry.path).split('/'));
    if (signerThumbprint(target, run) !== signing.certSha1) {
      const result = run(signtool ?? findSigntool(), ['sign', '/sha1', signing.certSha1, '/s', 'My', '/fd', 'SHA256', '/tr', signing.timestampUrl, '/td', 'SHA256', target], { encoding: 'utf8', windowsHide: true, stdio: 'inherit' });
      if (result.status !== 0 || signerThumbprint(target, run) !== signing.certSha1) throw new Error('could not sign ' + entry.path + ' of the pack with certificate ' + signing.certSha1);
    }
    const bytes = fs.readFileSync(target);
    entry.size = bytes.length; entry.sha256 = sha256(bytes);
    signed.push(entry.path);
  }
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + '\n');
  return signed;
}

// The electron-builder configuration of the unsigned test app: no publish (no app-update.yml), a name that says what it is.
export function testUnsignedConfig() {
  return { publish: null, forceCodeSigning: false, nsis: { artifactName: '${name}-${version}-test-unsigned-setup.${ext}' } };
}

// resources/app-update.yml of a built app: the feed it must name and the publisher it must require. Returns the problems.
export function updaterConfigProblems(text, { url, publisherName }) {
  if (text === null || text === undefined) return ['resources/app-update.yml is missing: the app would never update itself'];
  const problems = [];
  const provider = /^provider:\s*['"]?([^'"\s]+)/m.exec(text)?.[1];
  const feed = /^url:\s*['"]?([^'"\s]+)/m.exec(text)?.[1];
  const channel = /^channel:\s*['"]?([^'"\s]+)/m.exec(text)?.[1];
  if (provider !== 'generic') problems.push('provider is ' + (provider ?? 'missing') + ', not generic');
  if ((feed ?? '').replace(/\/+$/, '') !== String(url).replace(/\/+$/, '')) problems.push('url is ' + (feed ?? 'missing') + ', not ' + url);
  if ((channel ?? 'latest') !== 'latest') problems.push('channel is ' + channel + ', not latest');
  const names = publisherNames(text);
  if (publisherName && !names.includes(publisherName)) problems.push('publisherName is [' + names.join(', ') + '], not [' + publisherName + ']: updates would not be verified');
  return problems;
}

// signtool.exe: SSAM_SIGNTOOL, else the newest x64 one of the Windows SDK.
export function findSigntool(env = process.env) {
  if (env.SSAM_SIGNTOOL) return env.SSAM_SIGNTOOL;
  const kits = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter(n => /^\d+(\.\d+){3}$/.test(n)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })) : [];
  for (const version of versions) { const file = path.join(kits, version, 'x64', 'signtool.exe'); if (fs.existsSync(file)) return file; }
  throw new Error('signtool.exe not found: install the Windows SDK signing tools or set SSAM_SIGNTOOL');
}

// The thumbprint of the certificate that signed a file, when Windows says the signature is valid; null otherwise.
export function signerThumbprint(file, run = spawnSync) {
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:SSAM_SIGNED_FILE; if ($s.Status -eq 'Valid') { $s.SignerCertificate.Thumbprint }";
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SSAM_SIGNED_FILE: file } });
  const value = String(result.stdout ?? '').trim();
  return result.status === 0 && THUMBPRINT.test(value) ? value.toUpperCase() : null;
}

// The native core signed by the release certificate, BEFORE the pack hashes are computed (the supervisor checks the
// native file's hash at every launch). A copy is signed; the original is never changed. Already signed by the same
// certificate: used as it is.
export function signNative(executable, signing, workDir, { run = spawnSync, signtool = null } = {}) {
  if (signerThumbprint(executable, run) === signing.certSha1) return executable;
  fs.mkdirSync(workDir, { recursive: true });
  const copy = path.join(workDir, path.basename(executable));
  fs.copyFileSync(executable, copy);
  const tool = signtool ?? findSigntool();
  const signed = run(tool, ['sign', '/sha1', signing.certSha1, '/s', 'My', '/fd', 'SHA256', '/tr', signing.timestampUrl, '/td', 'SHA256', copy], { encoding: 'utf8', windowsHide: true, stdio: 'inherit' });
  if (signed.status !== 0) throw new Error('signtool could not sign the native core with certificate ' + signing.certSha1 + ' (is it in Cert:\\CurrentUser\\My of this account?)');
  if (signerThumbprint(copy, run) !== signing.certSha1) throw new Error('The signed native core does not carry a valid signature of certificate ' + signing.certSha1);
  return copy;
}

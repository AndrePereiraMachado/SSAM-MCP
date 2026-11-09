// The installers of the app: the agent pack of the platform put in pack/ (extracted from the ZIP or tar.gz
// scripts/agent-pack.ps1 made, or copied from a folder), checked against its pack.json, then electron-builder over
// electron-builder.yml with the owner's update server as the publish URL (written to resources/app-update.yml, which
// the app reads at start).
//   node scripts/build.mjs --platform win|mac --pack <ssam-agent.zip | ssam-agent-mac.tar.gz | folder>
//                          [--update-url https://...] [--no-updates] [--pack-only]
//   Without --update-url the build publishes to https://dist.ssam.pro/u/ssam-agent (the owner's update server).
//   --app-version x.y.z: the app version of the build (electron-builder extraMetadata.version), default package.json's.
//   macOS release (app 0.2.8): --notarize --bundled-bridges-only WITH updates: resources/app-update.yml names the feed (the
//   same generic provider, url and channel as Windows) and dist/latest-mac.yml lists the ZIP; the bridges stay the bundled
//   ones. electron-updater checks the ZIP's sha512 from latest-mac.yml, then Squirrel.Mac installs it only if its code
//   signature satisfies the installed app's designated requirement (Developer ID, same Team ID). The Ed25519 statement of
//   the Windows updates is Windows-only (update-model.mjs updateTrustProblem, updates.mjs acceptSigned). A Mac build that
//   updates itself must be notarized; --no-updates keeps the offline build (tests).
//   Windows release (app 0.2.8): --trust-public-key <the owner Ed25519 public key PEM> (the vigia vault's manifest key, printed
//   once by server/deploy/vigia/set-secrets.ps1): the build input of the only trust anchor. The native core must have been
//   built with the same key (scripts/build-native.mjs --trust-public-key; the gate compares them), and the app's main bundle
//   pins it for its own updates (update-trust.mjs): no Authenticode signature, an update installs only with the owner's
//   signed statement next to its installer (scripts/sign-windows-update.ps1, after this build, before publishing).
//   The legacy Authenticode release (app 0.2.0, scripts/windows-release.mjs) still exists: --cert-sha1 <thumbprint>
//   --publisher-name <subject CN> [--timestamp-url <url>] (or SSAM_WIN_CERT_SHA1, SSAM_WIN_PUBLISHER_NAME,
//   SSAM_WIN_TIMESTAMP_URL), on top of --trust-public-key. --test-unsigned: the owner's own test app (no signature, no trust
//   anchors, no updates, bridgeOffer false), never
//   published; on macOS too (ad-hoc sealed, never notarized: build/mac-022-native). --dry-run: everything up to
//   electron-builder, then prints its configuration and arguments.
//   SSAM_UPDATE_URL in the environment stands for --update-url. --pack-only stops after pack/ is ready.
// A macOS build (DMG, ZIP for the updater, signing) only runs on a Mac; a Windows build runs on Windows (or on
// Linux with wine, which this script does not set up).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZip } from './zip.mjs';
import { verifyPack } from '../src/main/core/pack-sync.mjs';
import { updateUrlProblem } from '../src/main/core/settings.mjs';
import { stageNativePack } from './native-pack.mjs';
import { assertBridgeTrust, readTrustPublicKey, spkiBase64 } from './bridge-trust-gate.mjs';
import { signingOf, signingConfig, testUnsignedConfig, updaterConfigProblems, signNative, signerThumbprint, signerSubject, publisherMatches, signPackExecutables, packExecutables } from './windows-release.mjs';
import { publisherNames } from '../src/main/core/update-model.mjs';
import { packProblems } from './pack-pins.mjs';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
// The owner's update server (the publish url of electron-builder.yml); --update-url or SSAM_UPDATE_URL replace it.
export const DEFAULT_UPDATE_URL = 'https://dist.ssam.pro/u/ssam-agent';

export function parse(argv) {
  const options = { platform: null, pack: null, updateUrl: process.env.SSAM_UPDATE_URL ?? DEFAULT_UPDATE_URL, noUpdates: false, packOnly: false, notarize: false, testUnsigned: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--no-updates') { options.noUpdates = true; continue; }
    if (name === '--pack-only') { options.packOnly = true; continue; }
    if (name === '--bundled-bridges-only') { options.bundledBridgesOnly = true; continue; }
    if (name === '--test-unsigned') { options.testUnsigned = true; continue; }
    if (name === '--dry-run') { options.dryRun = true; continue; }
    // macOS only: notarize with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (electron-builder reads them).
    if (name === '--notarize') { options.notarize = true; continue; }
    if (!['--platform', '--pack', '--update-url', '--native', '--trust-public-key', '--bridge-public-key', '--cert-sha1', '--publisher-name', '--timestamp-url', '--app-version'].includes(name)) throw new Error('unknown option: ' + name);
    if (i + 1 >= argv.length) throw new Error('missing the value of ' + name);
    const value = argv[++i];
    if (name === '--platform') options.platform = value;
    if (name === '--pack') options.pack = value;
    if (name === '--native') options.native = value;
    // --bridge-public-key is the older name of --trust-public-key (one key: the bridges and the Windows updates).
    if (name === '--bridge-public-key' || name === '--trust-public-key') options.bridgePublicKey = value;
    if (name === '--update-url') options.updateUrl = value;
    if (name === '--cert-sha1') options.certSha1 = value;
    if (name === '--publisher-name') options.publisherName = value;
    if (name === '--timestamp-url') options.timestampUrl = value;
    // The version of the app (electron-builder extraMetadata.version: the bundle, the artifact names and latest-mac.yml).
    if (name === '--app-version') options.appVersion = value;
  }
  if (!['win', 'mac'].includes(options.platform)) throw new Error('use --platform win or --platform mac');
  if (options.platform === 'win' && !options.native) throw new Error('Windows app builds require --native <qualified ssam-agent.exe>.');
  if (options.appVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(options.appVersion)) throw new Error('--app-version must be x.y.z: ' + options.appVersion);
  if (options.bundledBridgesOnly) {
    if (options.platform !== 'mac' || !options.notarize || !options.native || options.testUnsigned || options.packOnly)
      throw new Error('--bundled-bridges-only requires a notarized native Mac release');
    if (options.certSha1 || options.publisherName || options.bridgePublicKey)
      throw new Error('--bundled-bridges-only takes no Windows or remote bridge identity');
    // Mac app 0.2.8: the bridges stay the bundled ones (no remote bridge offer: the core has no trust anchor and macOS takes
    // none), but the APP may update itself from the feed (--no-updates still turns that off). Squirrel.Mac only installs an
    // update whose code signature satisfies the installed app's designated requirement (Developer ID, same Team ID).
  }
  // A Mac app that updates itself must be Developer ID-signed and notarized: Squirrel.Mac refuses an update of an ad-hoc app.
  if (options.platform === 'mac' && !options.packOnly && !options.noUpdates && !options.testUnsigned && !options.notarize)
    throw new Error('a Mac app that updates itself must be signed and notarized (--notarize); for a build that never updates itself pass --no-updates');
  if (options.testUnsigned) {
    if (options.certSha1 || options.publisherName) throw new Error('--test-unsigned takes no signing certificate');
    if (options.notarize) throw new Error('--test-unsigned is never notarized');
    options.noUpdates = true;
  } else if (options.platform === 'win' && !options.packOnly) {
    // App 0.2.8: a Windows app that reaches customers is never Authenticode-signed; it pins the owner's Ed25519 key, which
    // proves its bridges and its updates. The legacy signed release (a certificate given) keeps its publisher check on top.
    if (!options.bridgePublicKey)
      throw new Error('A Windows release needs --trust-public-key <the owner Ed25519 public key PEM> (printed by set-secrets.ps1 of the vigia). For the unsigned test app use --test-unsigned.');
    if (options.certSha1 || options.publisherName || process.env.SSAM_WIN_CERT_SHA1 || process.env.SSAM_WIN_PUBLISHER_NAME) {
      const signing = signingOf(options);
      if (!signing.ok) throw new Error(signing.problem);
      options.signing = signing;
    } else options.ed25519Release = true;
  }
  if (!options.packOnly && !options.noUpdates) {
    if (!options.updateUrl) throw new Error('give the update server with --update-url https://... (or SSAM_UPDATE_URL), or pass --no-updates for a build that never updates itself');
    const problem = updateUrlProblem(options.updateUrl);
    if (problem) throw new Error(problem);
  }
  return options;
}

function copyFolder(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name); const target = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copyFolder(source, target); }
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
  }
}

// The render worker of screen.render is this app's own executable started with --ssam-render-worker
// (src/main/render/worker.mjs). pack.json names it relative to the pack, which electron-builder puts in resources/pack:
// Windows <install>/resources/pack -> ../../SSAM Agent.exe; macOS SSAM Agent.app/Contents/Resources/pack ->
// ../../MacOS/SSAM Agent. The agent takes it only inside the installation (agent/lib/render.mjs, RenderKinds.cs).
export function rendererFor(platform, electron = electronVersion()) {
  return { kind: 'electron-worker', protocol: 1, path: platform === 'mac' ? '../../MacOS/SSAM Agent' : '../../SSAM Agent.exe', ...(electron ? { electron } : {}) };
}
export function electronVersion(appDir = app) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}
// pack.json of the staged pack with its renderer (pack.json is not one of its own files: the integrity list is unchanged).
export function withRenderer(packDir, platform, electron = electronVersion()) {
  const file = path.join(packDir, 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const next = { ...pack, renderer: rendererFor(platform, electron), privateDialog: rendererFor(platform, electron) };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// pack/ filled from the source and checked; returns the pack.json.
export async function preparePack(source, platform, packDir = path.join(app, 'pack')) {
  if (source) {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.mkdirSync(packDir, { recursive: true });
    const stat = fs.statSync(source);
    if (stat.isDirectory()) copyFolder(source, packDir);
    else if (/\.zip$/i.test(source)) extractZip(source, packDir);
    else if (/\.tar\.gz$/i.test(source)) { const { extractTarGz } = await import(pathToFileURL(path.join(here, 'tar-gz.mjs')).href); extractTarGz(source, packDir); }
    else throw new Error('the pack must be a .zip, a .tar.gz or a folder: ' + source);
  }
  const check = verifyPack(packDir);
  if (!check.ok) throw new Error('the pack is not whole: ' + check.detail);
  const packPlatform = check.pack.platform === 'darwin' ? 'mac' : 'win';
  if (packPlatform !== platform) throw new Error(`the pack is for ${packPlatform}, not ${platform}`);
  if (check.pack.lanes?.includes('odc') && !/^v(?:9[8-9]|[1-9]\d{2,})$/.test(check.pack.odcBridge ?? ''))
    throw new Error('the installed runtime requires ODC bridge v98 or newer with the agent data-root protocol');
  if (check.pack.files.some(file => /^agent\/node\//.test(String(file.path)))) throw new Error('the pack carries a Node (agent/node): build it with -NoNode, the app runs the agent on its own Node');
  return check.pack;
}

// --bundled-bridges-only is a signed Mac build with remote bridge installation and updates disabled.
// A command on PATH (with the PATHEXT extensions on Windows), as electron-builder looks it up; null when absent.
export function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) for (const ext of exts) { const file = path.join(dir, name + ext); if (fs.existsSync(file)) return file; }
  return null;
}

// pack.json of the staged pack with bridgeOffer false (the unsigned test app; pack.json is not in its own integrity list).
export function withoutOffers(packDir) {
  const file = path.join(packDir, 'pack.json');
  const next = { ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), bridgeOffer: false };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// After electron-builder: the pack the app will run, the updater configuration and the signatures. A build whose installed
// pack the app would refuse (verifyPack) or whose pins do not match their files (review M3), a release that would not verify
// its updates, an installer not signed by the release certificate, or a publisherName the updater would never match with
// the real signer (review M1: every update would then fail), stops here.
export function checkWindowsOutput(dist, options, { thumbprint = signerThumbprint, subject = signerSubject, pack = packProblems } = {}) {
  const unpacked = path.join(dist, 'win-unpacked');
  const problems = pack(path.join(unpacked, 'resources', 'pack')).map(problem => 'resources/pack: ' + problem);
  const yml = path.join(unpacked, 'resources', 'app-update.yml');
  const text = fs.existsSync(yml) ? fs.readFileSync(yml, 'utf8') : null;
  if (options.testUnsigned || options.noUpdates) {
    if (text !== null) problems.push('a build without updates must not carry resources/app-update.yml');
  } else {
    problems.push(...updaterConfigProblems(text, { url: options.updateUrl.replace(/\/+$/, ''), publisherName: options.signing?.publisherName }));
    // The unsigned Ed25519 release: a publisherName would make electron-updater refuse every (unsigned) update.
    if (!options.signing && text !== null && publisherNames(text).length) problems.push('app-update.yml names a publisherName, but this release is not Authenticode-signed: every update would be refused');
    if (!fs.existsSync(path.join(dist, 'latest.yml'))) problems.push('dist/latest.yml is missing: the feed would have nothing to announce');
    if (options.signing) {
      const installers = fs.readdirSync(dist).filter(n => /-setup\.exe$/.test(n)).map(n => path.join(dist, n));
      for (const file of [path.join(unpacked, 'SSAM Agent.exe'), ...installers])
        if (thumbprint(file) !== options.signing.certSha1) problems.push(path.basename(file) + ' is not signed by certificate ' + options.signing.certSha1);
      for (const file of installers) {
        const signer = subject(file);
        if (!publisherMatches(options.signing.publisherName, signer))
          problems.push(`publisherName "${options.signing.publisherName}" does not match the signer of ${path.basename(file)} ("${signer ?? 'unknown'}"): the updater would refuse every update`);
      }
    }
  }
  if (problems.length) throw new Error('the Windows build is not releasable: ' + problems.join('; '));
  console.log('pack: resources/pack is whole and every pin matches its file');
  if (!options.testUnsigned && !options.noUpdates)
    console.log('updater: app-update.yml names ' + options.updateUrl + (options.signing ? ' and requires publisher ' + options.signing.publisherName : '')
      + '; every update needs the signed statement next to its installer (scripts/sign-windows-update.ps1 before publishing)');
}

// The electron-builder arguments after its cli.js: the targets, never its own publishing, the feed of a build that updates
// itself (resources/app-update.yml and latest*.yml), the app version (--app-version) and notarization.
export function builderArgs(options, { nativeMac = false, arch = process.arch, config = 'electron-builder.yml' } = {}) {
  const args = [...(nativeMac ? ['--mac', 'dmg', 'zip', '--' + arch] : [options.platform === 'win' ? '--win' : '--mac']), '--publish', 'never', '--config', config];
  if (!options.noUpdates) args.push('-c.publish.provider=generic', `-c.publish.url=${options.updateUrl.replace(/\/+$/, '')}`, '-c.publish.channel=latest');
  if (options.appVersion) args.push(`-c.extraMetadata.version=${options.appVersion}`);
  if (options.notarize) args.push('-c.mac.notarize=true');
  return args;
}

// The update feed entries electron-builder wrote (latest-mac.yml / latest.yml): {version, files: [{url, sha512, size}]}.
export function feedEntries(text) {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text ?? '')?.[1] ?? null;
  const files = [];
  for (const block of String(text ?? '').split(/^\s*-\s+url:/m).slice(1)) {
    const url = /^\s*['"]?([^'"\s]+)/.exec(block)?.[1];
    const sha512 = /^\s+sha512:\s*['"]?([^'"\s]+)/m.exec(block)?.[1] ?? null;
    const size = Number(/^\s+size:\s*(\d+)/m.exec(block)?.[1] ?? NaN);
    if (url) files.push({ url, sha512, size });
  }
  return { version, files };
}

// After electron-builder on a Mac (app 0.2.8): the installed pack is whole with every pin, and the updater configuration is the
// one of the build: with updates, resources/app-update.yml names the feed (generic, latest) and dist/latest-mac.yml announces
// this version with the ZIP(s) of dist, whose sha512 and size it states (what electron-updater checks before Squirrel.Mac
// checks the code signature); without updates, neither file exists. arch: the native core's (mac-arm64 or mac).
export function checkMacOutput(dist, options, { arch = process.arch, version = options.appVersion ?? appPackageVersion(), pack = packProblems } = {}) {
  const resources = path.join(dist, arch === 'arm64' ? 'mac-arm64' : 'mac', 'SSAM Agent.app', 'Contents', 'Resources');
  const problems = pack(path.join(resources, 'pack')).map(problem => 'Resources/pack: ' + problem);
  const yml = path.join(resources, 'app-update.yml');
  const text = fs.existsSync(yml) ? fs.readFileSync(yml, 'utf8') : null;
  const latest = path.join(dist, 'latest-mac.yml');
  if (options.testUnsigned || options.noUpdates) {
    if (text !== null) problems.push('a build without updates must not carry Resources/app-update.yml');
    if (fs.existsSync(latest)) problems.push('a build without updates must not write dist/latest-mac.yml');
  } else {
    problems.push(...updaterConfigProblems(text, { url: options.updateUrl.replace(/\/+$/, '') }));
    if (text !== null && publisherNames(text).length) problems.push('app-update.yml names a publisherName: on macOS Squirrel.Mac checks the code signature, the name would only confuse');
    if (!fs.existsSync(latest)) problems.push('dist/latest-mac.yml is missing: the feed would have nothing to announce');
    else {
      const feed = feedEntries(fs.readFileSync(latest, 'utf8'));
      if (feed.version !== version) problems.push(`latest-mac.yml announces ${feed.version ?? 'no version'}, not ${version}`);
      if (!feed.files.length) problems.push('latest-mac.yml lists no file');
      for (const file of feed.files) {
        const local = path.join(dist, file.url);
        if (!/\.zip$/.test(file.url) || !fs.existsSync(local)) { problems.push('latest-mac.yml names ' + file.url + ', which is not a ZIP of dist'); continue; }
        const bytes = fs.readFileSync(local);
        if (createHash('sha512').update(bytes).digest('base64') !== file.sha512 || bytes.length !== file.size) problems.push('latest-mac.yml states another sha512 or size for ' + file.url);
      }
    }
  }
  if (problems.length) throw new Error('the Mac build is not releasable: ' + problems.join('; '));
  console.log('pack: Resources/pack is whole and every pin matches its file');
  console.log(options.noUpdates || options.testUnsigned ? 'updater: off (no app-update.yml, no latest-mac.yml)'
    : 'updater: app-update.yml names ' + options.updateUrl + '; latest-mac.yml announces ' + version + ' (Squirrel.Mac installs only a Developer ID update of the same team)');
}
export function appPackageVersion(appDir = app) { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version; }

// The update key the main bundle pins (update-trust.mjs): the build input on a Windows build that updates itself, else none.
export function updateSpkiFor(options, readKey = readTrustPublicKey) {
  return options.platform === 'win' && !options.noUpdates && !options.testUnsigned && options.bridgePublicKey ? spkiBase64(readKey(options.bridgePublicKey)) : '';
}
// The built main bundle must pin exactly that key (or none): a stale or missing define would ship an app that never updates,
// or one that trusts another key.
export function mainBundleKeyProblem(bundleText, spki) {
  const found = [...new Set(String(bundleText).match(/MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=/g) ?? [])];
  if (spki ? found.length !== 1 || found[0] !== spki : found.length !== 0) return 'out/main pins ' + (found.length ? found.length + ' other key(s)' : 'no update key') + (spki ? ', not the build input' : ', but this build takes none');
  return null;
}

async function main() {
  const options = parse(process.argv.slice(2));
  // The native core is signed first (its hash goes into pack.json), then its trust anchors are checked. The unsigned test
  // app has no anchors: its agent never takes a bridge offer (bridgeOffer false).
  if (options.signing && !options.dryRun) options.native = signNative(options.native, options.signing, path.join(app, '.local/build/native-signed-' + Date.now()));
  if (!options.testUnsigned && !options.bundledBridgesOnly) assertBridgeTrust({ nativeExecutable: options.native, publicKeyFile: options.bridgePublicKey });
  const updateSpki = updateSpkiFor(options);
  if (options.notarize) {
    if (options.platform !== 'mac' || process.platform !== 'darwin' || !options.native)
      throw new Error('Notarized releases require a native executable and a Mac build host.');
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
      if (!process.env[name]) throw new Error('Signed release credentials missing: ' + name);
    // Sign before computing the pack hashes. Signing after staging invalidates
    // the native file hash checked by the supervisor at every launch.
    const signature = spawnSync('/usr/bin/codesign', ['--verify', '--strict', options.native], { encoding: 'utf8' });
    if (signature.status !== 0) throw new Error('Sign the native executable before staging the notarized release.');
    const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', options.native], { encoding: 'utf8' });
    const signing = (details.stdout ?? '') + (details.stderr ?? '');
    if (details.status !== 0 || !signing.includes('Authority=Developer ID Application:')
      || !signing.split(/\r?\n/).includes('TeamIdentifier=' + process.env.APPLE_TEAM_ID) || !signing.includes('(runtime)'))
      throw new Error('The native executable needs hardened runtime and Developer ID signing for the configured Apple team.');
  }
  let pack = await preparePack(options.pack, options.platform);
  // A release signs the pack's executables before their hashes are final (electron-builder must not sign them later).
  if (options.signing && !options.dryRun) signPackExecutables(path.join(app, 'pack'), options.signing, { sha256: bytes => createHash('sha256').update(bytes).digest('hex') });
  if (options.native) {
    const destination = path.join(app, 'pack-native-' + Date.now());
    pack = stageNativePack(path.join(app, 'pack'), options.native, destination);
    const target = path.join(app, 'pack');
    // Both paths are fixed children of this application workspace.
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(destination, target);
  }
  if (options.platform === 'win' && !pack.nativeCore) throw new Error('Windows app builds require --native <qualified ssam-agent.exe>.');
  if (options.platform === 'mac' && !pack.nativeCore) throw new Error('Mac app builds require --native <ssam-agent> to provide the private Keychain helper. Build the native core on the target Mac first.');
  pack = withRenderer(path.join(app, 'pack'), options.platform);
  if (options.testUnsigned || options.bundledBridgesOnly) pack = withoutOffers(path.join(app, 'pack'));
  console.log(`pack ${pack.id} ready in pack/ (${pack.files.length} files, lanes ${(pack.lanes ?? []).join(',')}, ODC bridge ${pack.odcBridge ?? '-'}, Service Studio ${pack.o11BuiltFor ?? '-'})`);
  if (options.packOnly) return;
  if (options.platform === 'mac' && process.platform !== 'darwin') throw new Error('a macOS build (DMG, ZIP, signing) only runs on a Mac');
  if (options.platform === 'win' && process.platform === 'darwin') throw new Error('build the Windows installer on Windows');
  // electron-builder lists the production dependencies with `npm list --json` (package-lock.json): without npm on PATH it
  // fails later with "No JSON content found in output".
  if (!findOnPath('npm')) throw new Error('electron-builder needs npm on PATH (it lists the production dependencies with npm list); install Node.js with npm');
  // electron-vite first: src/ -> out/ (main, preload, the React panel), what electron-builder packs.
  // The update key goes to this child only, explicitly (empty when the build takes none), never from the parent environment.
  const vite = spawnSync(process.execPath, [path.join(app, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: app, stdio: 'inherit', env: { ...process.env, SSAM_BUILD_UPDATE_SPKI: updateSpki } });
  if (vite.status !== 0) throw new Error('electron-vite build failed with code ' + vite.status);
  const bundleProblem = mainBundleKeyProblem(fs.readdirSync(path.join(app, 'out', 'main')).filter(n => /\.m?js$/.test(n)).map(n => fs.readFileSync(path.join(app, 'out', 'main', n), 'utf8')).join('\n'), updateSpki);
  if (bundleProblem) throw new Error('the main bundle does not pin the update key of the build input: ' + bundleProblem);
  const cli = path.join(app, 'node_modules', 'electron-builder', 'cli.js');
  let config = 'electron-builder.yml';
  const nativeMac = options.platform === 'mac' && pack.nativeCore;
  if (nativeMac && pack.nativeCore.arch !== process.arch) throw new Error('Build the installer on the native core target architecture.');
  if (options.noUpdates || nativeMac || options.signing || options.testUnsigned || options.ed25519Release) {
    // The CLI treats -c.publish=null as the string provider "null". A JSON
    // configuration preserves a real null and produces an offline test build.
    config = path.join(app, '.local/build/installer-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ extends: path.join(app, 'electron-builder.yml'), ...(options.noUpdates ? { publish: null } : {}),
      ...(options.signing ? signingConfig(options.signing, packExecutables(pack)) : {}), ...(options.testUnsigned ? testUnsignedConfig() : {}),
      // The Ed25519 release: never Authenticode-signed (no publisherName in app-update.yml: electron-updater would refuse it).
      ...(options.ed25519Release ? { forceCodeSigning: false } : {}),
      ...(options.notarize ? { forceCodeSigning: true, dmg: { sign: true } } : {}),
      ...(nativeMac ? { mac: { target: [{ target: 'dmg', arch: [process.arch] }, { target: 'zip', arch: [process.arch] }],
        // Ad-hoc sealing needs no Apple certificate and keeps ARM64 code valid.
        // The native core is already sealed before its manifest hash is recorded.
        ...(!options.notarize ? { identity: '-', hardenedRuntime: false } : {}),
        ...(options.testUnsigned ? { artifactName: '${name}-${version}-test-unsigned-${os}-${arch}.${ext}' } : {}),
        signIgnore: ['Contents/Resources/pack/native/ssam-agent$'] } } : {}) }));
  }
  // Explicit CLI target names bypass merged YAML target arrays. Otherwise the
  // parent config can add an Intel installer containing an ARM-only core.
  if (options.notarize)
    for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) if (!process.env[name]) throw new Error(`--notarize needs ${name} in the environment`);
  const args = [cli, ...builderArgs(options, { nativeMac: Boolean(nativeMac), arch: process.arch, config })];
  console.log('electron-builder ' + args.slice(1).join(' '));
  if (options.dryRun) { console.log('dry-run config ' + fs.readFileSync(config, 'utf8')); return; }
  const result = spawnSync(process.execPath, args, { cwd: app, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' } });
  if (result.status !== 0) throw new Error('electron-builder failed with code ' + result.status);
  const dist = path.join(app, 'dist');
  const files = fs.readdirSync(dist).filter(name => /\.(exe|dmg|zip|yml|blockmap)$/.test(name));
  console.log('dist: ' + files.join(', '));
  if (options.platform === 'win') checkWindowsOutput(dist, options);
  if (options.platform === 'mac') checkMacOutput(dist, options, { arch: pack.nativeCore?.arch ?? process.arch });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error('Error: ' + error.message); process.exit(1); });

// The installers of the app: the agent pack of the platform put in pack/ (extracted from the ZIP or tar.gz
// scripts/agent-pack.ps1 made, or copied from a folder), checked against its pack.json, then electron-builder over
// electron-builder.yml with the owner's update server as the publish URL (written to resources/app-update.yml, which
// the app reads at start).
//   node scripts/build.mjs --platform win|mac --pack <ssam-agent.zip | ssam-agent-mac.tar.gz | folder>
//                          [--update-url https://...] [--no-updates] [--pack-only]
//   Without --update-url the build publishes to https://dist.ssam.pro/u/ssam-agent (the owner's update server).
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

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
// The owner's update server (the publish url of electron-builder.yml); --update-url or SSAM_UPDATE_URL replace it.
export const DEFAULT_UPDATE_URL = 'https://dist.ssam.pro/u/ssam-agent';

function parse(argv) {
  const options = { platform: null, pack: null, updateUrl: process.env.SSAM_UPDATE_URL ?? DEFAULT_UPDATE_URL, noUpdates: false, packOnly: false, notarize: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--no-updates') { options.noUpdates = true; continue; }
    if (name === '--pack-only') { options.packOnly = true; continue; }
    // macOS only: notarize with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (electron-builder reads them).
    if (name === '--notarize') { options.notarize = true; continue; }
    if (!['--platform', '--pack', '--update-url', '--native'].includes(name)) throw new Error('unknown option: ' + name);
    if (i + 1 >= argv.length) throw new Error('missing the value of ' + name);
    const value = argv[++i];
    if (name === '--platform') options.platform = value;
    if (name === '--pack') options.pack = value;
    if (name === '--native') options.native = value;
    if (name === '--update-url') options.updateUrl = value;
  }
  if (!['win', 'mac'].includes(options.platform)) throw new Error('use --platform win or --platform mac');
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

async function main() {
  const options = parse(process.argv.slice(2));
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
  if (options.native) {
    const destination = path.join(app, 'pack-native-' + Date.now());
    pack = stageNativePack(path.join(app, 'pack'), options.native, destination);
    const target = path.join(app, 'pack');
    // Both paths are fixed children of this application workspace.
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(destination, target);
  }
  if (options.platform === 'win' && !pack.nativeCore) throw new Error('Windows app builds require --native <qualified ssam-agent.exe>.');
  console.log(`pack ${pack.id} ready in pack/ (${pack.files.length} files, lanes ${(pack.lanes ?? []).join(',')}, ODC bridge ${pack.odcBridge ?? '-'}, Service Studio ${pack.o11BuiltFor ?? '-'})`);
  if (options.packOnly) return;
  if (options.platform === 'mac' && process.platform !== 'darwin') throw new Error('a macOS build (DMG, ZIP, signing) only runs on a Mac');
  if (options.platform === 'win' && process.platform === 'darwin') throw new Error('build the Windows installer on Windows');
  // electron-vite first: src/ -> out/ (main, preload, the React panel), what electron-builder packs.
  const vite = spawnSync(process.execPath, [path.join(app, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: app, stdio: 'inherit' });
  if (vite.status !== 0) throw new Error('electron-vite build failed with code ' + vite.status);
  const cli = path.join(app, 'node_modules', 'electron-builder', 'cli.js');
  let config = 'electron-builder.yml';
  const nativeMac = options.platform === 'mac' && pack.nativeCore;
  if (nativeMac && pack.nativeCore.arch !== process.arch) throw new Error('Build the installer on the native core target architecture.');
  if (options.noUpdates || nativeMac) {
    // The CLI treats -c.publish=null as the string provider "null". A JSON
    // configuration preserves a real null and produces an offline test build.
    config = path.join(app, '.local/build/installer-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ extends: path.join(app, 'electron-builder.yml'), ...(options.noUpdates ? { publish: null } : {}),
      ...(options.notarize ? { forceCodeSigning: true } : {}),
      ...(nativeMac ? { mac: { target: [{ target: 'dmg', arch: [process.arch] }, { target: 'zip', arch: [process.arch] }],
        ...(options.notarize ? { signIgnore: ['Contents/Resources/pack/native/ssam-agent$'] } : {}) } } : {}) }));
  }
  // Explicit CLI target names bypass merged YAML target arrays. Otherwise the
  // parent config can add an Intel installer containing an ARM-only core.
  const args = [cli, ...(nativeMac ? ['--mac', 'dmg', 'zip', '--' + process.arch] : [options.platform === 'win' ? '--win' : '--mac']), '--publish', 'never', '--config', config];
  if (!options.noUpdates) args.push('-c.publish.provider=generic', `-c.publish.url=${options.updateUrl.replace(/\/+$/, '')}`, '-c.publish.channel=latest');
  if (options.notarize) {
    for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) if (!process.env[name]) throw new Error(`--notarize needs ${name} in the environment`);
    args.push('-c.mac.notarize=true');
  }
  console.log('electron-builder ' + args.slice(1).join(' '));
  const result = spawnSync(process.execPath, args, { cwd: app, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' } });
  if (result.status !== 0) throw new Error('electron-builder failed with code ' + result.status);
  const dist = path.join(app, 'dist');
  const files = fs.readdirSync(dist).filter(name => /\.(exe|dmg|zip|yml|blockmap)$/.test(name));
  console.log('dist: ' + files.join(', '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error('Error: ' + error.message); process.exit(1); });

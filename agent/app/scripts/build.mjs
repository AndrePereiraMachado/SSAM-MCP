// The installers of the app: the agent pack of the platform put in app/pack (extracted from the ZIP or tar.gz
// scripts/agent-pack.ps1 made, or copied from a folder), checked against its pack.json, then electron-builder over
// electron-builder.yml with the owner's update server as the publish URL (written to resources/app-update.yml, which
// the app reads at start).
//   node scripts/build.mjs --platform win|mac --pack <ssam-agent.zip | ssam-agent-mac.tar.gz | folder>
//                          [--update-url https://...] [--no-updates] [--pack-only]
//   SSAM_UPDATE_URL in the environment stands for --update-url. --pack-only stops after app/pack is ready.
// A macOS build (DMG, ZIP for the updater, signing) only runs on a Mac; a Windows build runs on Windows (or on
// Linux with wine, which this script does not set up).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZip } from './zip.mjs';
import { verifyPack } from '../src/pack-sync.mjs';
import { updateUrlProblem } from '../src/settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const box = path.resolve(app, '..');

function parse(argv) {
  const options = { platform: null, pack: null, updateUrl: process.env.SSAM_UPDATE_URL ?? null, noUpdates: false, packOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--no-updates') { options.noUpdates = true; continue; }
    if (name === '--pack-only') { options.packOnly = true; continue; }
    if (!['--platform', '--pack', '--update-url'].includes(name)) throw new Error('unknown option: ' + name);
    if (i + 1 >= argv.length) throw new Error('missing the value of ' + name);
    const value = argv[++i];
    if (name === '--platform') options.platform = value;
    if (name === '--pack') options.pack = value;
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

// app/pack filled from the source and checked; returns the pack.json.
export async function preparePack(source, platform, packDir = path.join(app, 'pack')) {
  if (!source) {
    const check = verifyPack(packDir);
    if (!check.ok) throw new Error(`no --pack given and app/pack is not a whole pack (${check.detail})`);
    return check.pack;
  }
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(packDir, { recursive: true });
  const stat = fs.statSync(source);
  if (stat.isDirectory()) copyFolder(source, packDir);
  else if (/\.zip$/i.test(source)) extractZip(source, packDir);
  else if (/\.tar\.gz$/i.test(source)) { const { extractTarGz } = await import(pathToFileURL(path.join(box, 'scripts', 'tar-gz.mjs')).href); extractTarGz(source, packDir); }
  else throw new Error('the pack must be a .zip, a .tar.gz or a folder: ' + source);
  const check = verifyPack(packDir);
  if (!check.ok) throw new Error('the pack is not whole: ' + check.detail);
  const packPlatform = check.pack.platform === 'darwin' ? 'mac' : 'win';
  if (packPlatform !== platform) throw new Error(`the pack is for ${packPlatform}, not ${platform}`);
  if (check.pack.files.some(file => /^agent\/node\//.test(String(file.path)))) throw new Error('the pack carries a Node (agent/node): build it with -NoNode, the app runs the agent on its own Node');
  return check.pack;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const pack = await preparePack(options.pack, options.platform);
  console.log(`pack ${pack.id} ready in app/pack (${pack.files.length} files, lanes ${(pack.lanes ?? []).join(',')}, ODC bridge ${pack.odcBridge ?? '-'}, Service Studio ${pack.o11BuiltFor ?? '-'})`);
  if (options.packOnly) return;
  if (options.platform === 'mac' && process.platform !== 'darwin') throw new Error('a macOS build (DMG, ZIP, signing) only runs on a Mac');
  if (options.platform === 'win' && process.platform === 'darwin') throw new Error('build the Windows installer on Windows');
  const cli = path.join(app, 'node_modules', 'electron-builder', 'cli.js');
  const args = [cli, options.platform === 'win' ? '--win' : '--mac', '--publish', 'never', '--config', 'electron-builder.yml'];
  if (options.noUpdates) args.push('-c.publish=null');
  else args.push('-c.publish.provider=generic', `-c.publish.url=${options.updateUrl.replace(/\/+$/, '')}`, '-c.publish.channel=latest');
  console.log('electron-builder ' + args.slice(1).join(' '));
  const result = spawnSync(process.execPath, args, { cwd: app, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' } });
  if (result.status !== 0) throw new Error('electron-builder failed with code ' + result.status);
  const dist = path.join(app, 'dist');
  const files = fs.readdirSync(dist).filter(name => /\.(exe|dmg|zip|yml|blockmap)$/.test(name));
  console.log('dist: ' + files.join(', '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error('Error: ' + error.message); process.exit(1); });

// The Studios of this machine: running processes with each executable's ProductVersion (studio.processes and the
// per-pid version check, docs/FASE2-AGENTE.md 4.4/4.8), and the installed Studio of each lane for the Hello (3.1).
// Only reads: tasklist, a CIM process query, file versions and the uninstall registry keys. Never touches a Studio process.
// On macOS (platform 'darwin') the same three answers come from macos.mjs (application bundles, ps, the version resource
// of the managed entry assembly); the image names stay the protocol's names of the two lanes.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { studioProcesses, installedBundles, inspectBundle, bundleOfExe } from './macos.mjs';

const exec = promisify(execFile);

export const STUDIOS = Object.freeze({
  odc: Object.freeze({ image: 'ODCStudio.exe', marker: 'OutSystems.Model.dll', uninstall: 'OutSystems ODC Studio', folder: 'ODC Studio',
    programFiles: ['OutSystems', 'ODC Studio', 'ODC Studio'] }),
  o11: Object.freeze({ image: 'ServiceStudio.exe', marker: 'ServiceStudio.Framework.dll', uninstall: 'OutSystems Service Studio 11', folder: 'Service Studio',
    programFiles: ['OutSystems', 'Service Studio 11', 'Service Studio'] }),
});
export const IMAGES = Object.freeze(Object.values(STUDIOS).map(studio => studio.image));

const powershell = async script => (await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
  { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();

// [{pid, path, version}] of the running processes of one Studio image (C14, fase4): the pids by tasklist (tens of ms), and
// the executable path and ProductVersion only of the pids not seen before, in one PowerShell call (CIM + VersionInfo,
// 0.4 to 0.6 s). A pid that left the listing is forgotten, so a later process with the same pid is described again.
const described = new Map(); // `${image}:${pid}` -> {path, version}
export function parseTasklist(text, image) {
  return String(text ?? '').split(/\r?\n/).map(line => /^"([^"]*)","(\d+)"/.exec(line))
    .filter(match => match && match[1].toLowerCase() === image.toLowerCase()).map(match => Number(match[2]));
}
async function describePids(image, pids) {
  const filter = pids.map(pid => 'ProcessId=' + pid).join(' OR ');
  const script = "Get-CimInstance Win32_Process -Filter \"Name='" + image + "' AND (" + filter + ")\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; "
    + 'path = $_.ExecutablePath; version = $(if ($_.ExecutablePath) { (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.ProductVersion } else { $null }) } } '
    + '| ConvertTo-Json -Compress';
  const text = await powershell(script);
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: Number(p.pid), path: p.path ?? null, version: p.version ?? null }));
}
export async function listProcesses(image, { tasklist = () => exec('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }),
  describe = describePids, platform = process.platform, mac = {} } = {}) {
  if (!IMAGES.includes(image)) return [];
  if (platform === 'darwin') return macProcesses(image, mac);
  let pids;
  try { pids = parseTasklist((await tasklist()).stdout, image); } catch { return []; }
  for (const key of [...described.keys()]) if (key.startsWith(image + ':') && !pids.includes(Number(key.slice(image.length + 1)))) described.delete(key);
  const unknown = pids.filter(pid => !described.has(image + ':' + pid));
  if (unknown.length) {
    try { for (const p of await describe(image, unknown)) if (unknown.includes(p.pid)) described.set(image + ':' + p.pid, { path: p.path, version: p.version }); }
    catch { /* undescribed pids answer path and version null; the next listing tries again */ }
  }
  return pids.map(pid => ({ pid, path: described.get(image + ':' + pid)?.path ?? null, version: described.get(image + ':' + pid)?.version ?? null }));
}
// ProductVersion of an executable, or null.
export async function fileVersion(exe) {
  if (typeof exe !== 'string' || !fs.existsSync(exe)) return null;
  try { return (await powershell("(Get-Item -LiteralPath '" + exe.replace(/'/g, "''") + "').VersionInfo.ProductVersion")) || null; }
  catch { return null; }
}

async function regQuery(key, value, view) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  try {
    const { stdout } = await exec(exe, ['query', key, '/v', value, '/reg:' + view], { windowsHide: true, timeout: 30000 });
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^ {4}(.*?) {4}REG_\w+ {4}(.*)$/.exec(line);
      if (match && match[1].toLowerCase() === value.toLowerCase()) return match[2];
    }
  } catch { /* no such key or value */ }
  return null;
}

// The installed Studio folder of a lane: InstallLocation of the uninstall key (HKLM, then HKCU; 64-bit, then 32-bit
// view) plus the Studio subfolder, then the official Program Files folder. A folder counts when it has the marker DLL.
export async function locateInstalled(kind, { env = process.env, exists = fs.existsSync, query = regQuery } = {}) {
  const entry = STUDIOS[kind];
  if (!entry) return null;
  const valid = dir => (dir && exists(path.join(dir, entry.marker)) ? dir : null);
  for (const hive of ['HKLM', 'HKCU']) for (const view of [64, 32]) {
    const location = await query(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${entry.uninstall}`, 'InstallLocation', view);
    const dir = valid(location ? path.join(location, entry.folder) : null);
    if (dir) return dir;
  }
  return valid(path.join(env.ProgramFiles || 'C:\\Program Files', ...entry.programFiles));
}

// Hello.studios: { odc: { installed: {dir, version} | null }, o11: { installed: ... } }. On macOS dir is the bundle.
export async function installedStudios({ locate = locateInstalled, version = fileVersion, platform = process.platform } = {}) {
  const studios = {};
  for (const [kind, entry] of Object.entries(STUDIOS)) {
    const dir = await locate(kind).catch(() => null);
    studios[kind] = { installed: dir ? { dir, version: await version(platform === 'darwin' ? dir : path.join(dir, entry.image)).catch(() => null) } : null };
  }
  return studios;
}

// ---- macOS (macos.mjs). One inspection per bundle while its Info.plist keeps its time (a Studio that updates itself in
// place is read again).
const LANE_OF = { 'ODCStudio.exe': 'odc', 'ServiceStudio.exe': 'o11' };
const bundles = new Map(); // bundle -> {stamp, info}
async function macBundle(bundle, mac) {
  const f = mac.fs ?? fs;
  let stamp = null;
  try { stamp = f.statSync(path.posix.join(bundle, 'Contents', 'Info.plist')).mtimeMs; } catch { /* no Info.plist */ }
  const known = bundles.get(bundle);
  if (known && known.stamp === stamp) return known.info;
  const info = await inspectBundle(bundle, mac).catch(() => null);
  bundles.set(bundle, { stamp, info });
  return info;
}
async function macProcesses(image, mac) {
  const listed = await studioProcesses(LANE_OF[image], { ...mac, inspect: bundle => macBundle(bundle, mac) }).catch(() => []);
  return listed.map(p => ({ pid: p.pid, path: p.path, version: p.version ?? null }));
}
// The version of a bundle, or of the bundle an executable lives in, or null.
export async function macFileVersion(target, mac = {}) {
  const bundle = /\.app$/i.test(String(target ?? '')) ? target : bundleOfExe(target);
  return bundle ? (await macBundle(bundle, mac))?.version ?? null : null;
}
// The installed bundle of a lane (the newest version, /Applications first), or null.
export async function macLocate(kind, mac = {}) {
  return (await installedBundles(mac)).find(info => info.kind === kind)?.bundle ?? null;
}

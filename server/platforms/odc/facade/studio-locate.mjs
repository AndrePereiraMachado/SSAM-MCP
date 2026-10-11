// Studio locator (Node), the twin of kernel/src/SSAM.Runtime/StudioLocator.cs (plan lane A): finds a Service Studio
// (o11) or ODC Studio (odc) folder on any machine, never a folder of this one. Fixed order, first valid folder wins:
//   variable      ANVIL_STUDIO_DIR (o11) / ANVIL_ODC_STUDIO_DIR (odc)
//   connection    studioDir of the lane's connection record (release-layout.mjs connectionFile)
//   process       the folder of a running ServiceStudio.exe / ODCStudio.exe
//   hklm, hkcu    InstallLocation of Uninstall\"OutSystems Service Studio 11" / "OutSystems ODC Studio" (64-bit view,
//                 then 32-bit), plus the "Service Studio" / "ODC Studio" subfolder, as kernel/Directory.Build.targets
//   programfiles  %ProgramFiles%\OutSystems\Service Studio 11\Service Studio / %ProgramFiles%\OutSystems\ODC Studio\ODC Studio
// A folder is valid when it holds ServiceStudio.Framework.dll (o11) / OutSystems.Model.dll (odc).
//
// Frozen API (wave 1):
//   STUDIOS, SOURCES
//   isStudioDir(kind, dir, exists?)
//   regQuery(key, value, view)        reg.exe query <key> /v <value> /reg:<64|32>; the data, or null
//   registryInstallLocation(name)     InstallLocation of HKLM Uninstall\<name>, synchronous, cached; null in a hosted call
//                                     (servidor/fase4-23, for discovery.mjs)
//   studioProcesses(image)            [{pid, path}] of the running processes with that image name
//   locateStudio(kind, deps?) -> {kind, dir, source, tried: [{source, dir, valid}]}; dir and source are null when
//                                     nothing is found. deps (all optional, for tests): env, regQuery, processes,
//                                     connection (kind -> studioDir or null), exists, programFiles
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readConnection } from './release-layout.mjs';

const exec = promisify(execFile);

export const STUDIOS = Object.freeze({
  o11: Object.freeze({ variable: 'ANVIL_STUDIO_DIR', marker: 'ServiceStudio.Framework.dll', image: 'ServiceStudio.exe',
    uninstall: 'OutSystems Service Studio 11', folder: 'Service Studio', programFiles: ['OutSystems', 'Service Studio 11', 'Service Studio'] }),
  odc: Object.freeze({ variable: 'ANVIL_ODC_STUDIO_DIR', marker: 'OutSystems.Model.dll', image: 'ODCStudio.exe',
    uninstall: 'OutSystems ODC Studio', folder: 'ODC Studio', programFiles: ['OutSystems', 'ODC Studio', 'ODC Studio'] }),
});
export const SOURCES = Object.freeze(['variable', 'connection', 'process', 'hklm', 'hkcu', 'programfiles']);

const studio = kind => {
  const entry = STUDIOS[kind];
  if (!entry) throw new Error('Unknown Studio kind ' + kind + '; kinds: ' + Object.keys(STUDIOS).join(', '));
  return entry;
};

export function isStudioDir(kind, dir, exists = fs.existsSync) {
  return typeof dir === 'string' && dir !== '' && exists(path.join(dir, studio(kind).marker));
}

export async function regQuery(key, value, view = 64) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  try {
    const { stdout } = await exec(exe, ['query', key, '/v', value, '/reg:' + view], { windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^ {4}(.*?) {4}REG_\w+ {4}(.*)$/.exec(line);
      if (match && match[1].toLowerCase() === value.toLowerCase()) return match[2];
    }
  } catch { /* no such key or value */ }
  return null;
}

// The InstallLocation of an Uninstall key of this machine (HKLM, 64-bit view then 32-bit), read once per name by reg.exe,
// synchronously: the Service Studio of the O11 discover (discovery.mjs o11StudioDir, W3 of the 23rd release). Inside a
// hosted call it is null and nothing runs (servidor/fase4-23): this machine is the server, and a hosted O11 Studio is the
// server kernel's, named by the customer's connection record or ANVIL_STUDIO_DIR before the registry is asked.
const installs = new Map();
const hostedCall = () => globalThis[Symbol.for('ssam.facade.currentExecutor')]?.()?.hosted === true;
export function registryInstallLocation(name = STUDIOS.o11.uninstall) {
  if (hostedCall()) return null;
  if (installs.has(name)) return installs.get(name);
  let found = null;
  if (process.platform === 'win32') {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    for (const view of [64, 32]) {
      try {
        const out = execFileSync(exe, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + name, '/v', 'InstallLocation', '/reg:' + view],
          { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        const value = out.split(/\r?\n/).map(l => /^\s+InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(l)?.[1]).find(Boolean);
        if (value) { found = value; break; }
      } catch { /* no such key or value in this view */ }
    }
  }
  installs.set(name, found);
  return found;
}

// The same CIM query as lanes.mjs studioProcesses; release callers may inject another lister (deps.processes).
export async function studioProcesses(image) {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='" + image.replace(/'/g, '') + "'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
  try {
    const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const text = stdout.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: p.ProcessId, path: p.ExecutablePath }));
  } catch { return []; }
}

function connectionStudioDir(kind) {
  try { return readConnection(kind)?.studioDir ?? null; } catch { return null; }
}

export async function locateStudio(kind, deps = {}) {
  const entry = studio(kind);
  const env = deps.env ?? process.env;
  const query = deps.regQuery ?? regQuery;
  const exists = deps.exists ?? fs.existsSync;
  const tried = [];
  const attempt = (source, dir) => {
    if (!dir) return null;
    const valid = isStudioDir(kind, dir, exists);
    tried.push({ source, dir, valid });
    return valid ? { kind, dir, source, tried } : null;
  };
  const found = attempt('variable', env[entry.variable])
    ?? attempt('connection', (deps.connection ?? connectionStudioDir)(kind));
  if (found) return found;
  for (const running of await (deps.processes ?? studioProcesses)(entry.image)) {
    const hit = attempt('process', running?.path ? path.dirname(running.path) : null);
    if (hit) return hit;
  }
  for (const [source, hive] of [['hklm', 'HKLM'], ['hkcu', 'HKCU']]) {
    for (const view of [64, 32]) {
      const location = await query(hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + entry.uninstall, 'InstallLocation', view);
      const hit = attempt(source, location ? path.join(location, entry.folder) : null);
      if (hit) return hit;
    }
  }
  const programFiles = deps.programFiles ?? env.ProgramFiles ?? 'C:\\Program Files';
  return attempt('programfiles', path.join(programFiles, ...entry.programFiles)) ?? { kind, dir: null, source: null, tried };
}

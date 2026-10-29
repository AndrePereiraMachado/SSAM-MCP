// The folders the person approved for file.upload on this machine (docs/FASE2-AGENTE.md 4.4 and docs/AGENTE-CLIENTE.md):
// private/upload-roots.json = {schema: "ssam-upload-roots/1", roots: [{path, real, id, addedAt}]}, written atomically and
// read again at every upload, so a change counts without a restart. private/ is never readable nor writable by the
// server and no kind reads or writes this file; only the person changes it, with `ssam-agent roots add|remove|list` (the
// app's "Folders SSAM may read" runs the same commands). The hello never carries the list: folder names are private.
// An approval is refused for: a path that is not absolute or not an existing folder; a drive or disk root, a UNC or
// device path, a network folder; the user folder itself or a folder that holds it; Windows, Program Files*, ProgramData
// and AppData (macOS: /System, /Library, ~/Library and the other system folders); any folder that holds the agent's data
// or runtime folder, or is inside them. The same rules are native/Ssam.Agent/UploadRoots.cs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLocalPath, insidePath, samePath, networkPath, flavor } from './local-paths.mjs';

export const ROOTS_SCHEMA = 'ssam-upload-roots/1';
export const rootsFile = dataRoot => path.join(dataRoot, 'private', 'upload-roots.json');
const MAC_SYSTEM = ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/dev', '/cores', '/opt', '/Volumes', '/Network'];

// The approved roots, [] when the file is missing, unreadable or of another schema (an entry without both paths is skipped).
export function readRoots(dataRoot, { files = fs } = {}) {
  let value;
  try { value = JSON.parse(files.readFileSync(rootsFile(dataRoot), 'utf8').replace(/^\uFEFF/, '')); } catch { return []; }
  if (value?.schema !== ROOTS_SCHEMA || !Array.isArray(value.roots)) return [];
  return value.roots.filter(entry => entry && typeof entry.path === 'string' && typeof entry.real === 'string')
    .map(entry => ({ path: entry.path, real: entry.real, id: typeof entry.id === 'string' ? entry.id : null, addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null }));
}

// The identity of a file or folder, volume and file id, in the native core's spelling (VVVVVVVV:IIIIIIIIIIIIIIII).
export function fileIdentity(stat) {
  const hex = (value, width) => BigInt.asUintN(64, BigInt(value)).toString(16).toUpperCase().padStart(width, '0');
  return hex(stat.dev, 8) + ':' + hex(stat.ino, 16);
}

function writeRoots(dataRoot, roots) {
  const file = rootsFile(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ schema: ROOTS_SCHEMA, roots }, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

const homeOf = (env, platform) => (platform === 'darwin' ? (env.HOME?.startsWith('/') ? env.HOME : os.homedir()) : (env.USERPROFILE || os.homedir()));
// The folders no approval may touch, by system.
function systemProblem(folder, { env, platform }) {
  const home = homeOf(env, platform);
  if (platform === 'darwin') {
    const fold = text => text.normalize('NFC').toLowerCase().replace(/\/+$/, '');
    const inside = parent => fold(folder) === fold(parent) || fold(folder).startsWith(fold(parent) + '/');
    if ([...MAC_SYSTEM, path.posix.join(home, 'Library')].some(inside)) return 'is a folder of macOS or of the applications';
    return null;
  }
  const segments = folder.slice(3).split('\\').filter(Boolean);
  if (segments.some(segment => segment.toLowerCase() === 'appdata')) return 'is inside AppData, where Windows and the applications keep their own data';
  if (/^program files/i.test(segments[0] ?? '')) return 'is a Program Files folder';
  const system = [env.SystemRoot, env.windir, 'C:\\Windows', env.ProgramData, 'C:\\ProgramData', env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter(value => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value));
  if (system.some(parent => insidePath(folder, path.win32.normalize(parent), platform))) return 'is a folder of Windows or of the applications';
  return null;
}

// Why a folder (lexical or real) cannot be approved, or null.
function folderProblem(folder, { dataRoot, runtimeRoot, env, platform }) {
  const p = flavor(platform);
  if (networkPath(folder, platform)) return 'is a network folder';
  const segments = platform === 'darwin' ? folder.split('/').filter(Boolean) : folder.slice(3).split('\\').filter(Boolean);
  if (segments.length === 0) return 'is the root of a disk';
  const home = p.resolve(homeOf(env, platform));
  if (samePath(folder, home, platform)) return 'is your user folder itself; approve a folder inside it';
  if (insidePath(home, folder, platform)) return 'holds your user folder';
  const system = systemProblem(folder, { env, platform });
  if (system) return system;
  for (const agentFolder of [dataRoot, runtimeRoot].filter(Boolean).map(value => p.resolve(value)))
    if (insidePath(folder, agentFolder, platform) || insidePath(agentFolder, folder, platform)) return 'holds the SSAM agent folder or is inside it';
  return null;
}

// {path, real} of a folder that may be approved, or {problem}. files (tests): {statSync, realpathSync}.
export function checkApproval(folder, { dataRoot, runtimeRoot = dataRoot, env = process.env, platform = process.platform, files = fs } = {}) {
  let parsed;
  try { parsed = parseLocalPath(folder, { platform, folder: true }); } catch (error) { return { problem: error.message }; }
  const shown = JSON.stringify(parsed.normalized);
  const context = { dataRoot, runtimeRoot, env, platform };
  const lexical = folderProblem(parsed.normalized, context);
  if (lexical) return { problem: `${shown} ${lexical}` };
  let real;
  try {
    if (!files.statSync(parsed.normalized).isDirectory()) return { problem: `${shown} is not an existing folder` };
    real = (files.realpathSync.native ?? files.realpathSync)(parsed.normalized);
  } catch { return { problem: `${shown} is not an existing folder` }; }
  const resolved = folderProblem(real, context);
  if (resolved) return { problem: `${shown} leads to a folder that ${resolved}` };
  let id;
  try { id = fileIdentity(files.statSync(real, { bigint: true })); } catch { return { problem: ` is not an existing folder` }; }
  return { path: parsed.normalized, real, id };
}

// The CLI of `roots` (Node and native print the same lines): add | remove | list. -> exit code.
export function rootsCommand({ op, folder, dataRoot, runtimeRoot = dataRoot, json = false, stdout = process.stdout, stderr = process.stderr,
  env = process.env, platform = process.platform, now = () => new Date() }) {
  const say = text => stdout.write(text + '\n');
  const fail = text => { stderr.write('Error: ' + text + '\n'); return 1; };
  if (!dataRoot) return fail('--root <agent folder> is required');
  const roots = readRoots(dataRoot);
  if (op === 'list') {
    if (json) say(JSON.stringify({ schema: ROOTS_SCHEMA, roots }, null, 2));
    else if (roots.length === 0) say('No folder is approved: SSAM cannot read any file of this computer.');
    else { say(`Folders SSAM may read (${roots.length}):`); roots.forEach((entry, i) => say(`  ${i + 1}. ${entry.path}`)); }
    return 0;
  }
  if (op !== 'add' && op !== 'remove') return fail('use roots add --folder <folder> | roots remove --folder <folder> | roots list [--json]');
  if (typeof folder !== 'string' || folder === '') return fail(`roots ${op} needs --folder <folder>`);
  if (op === 'remove') {
    let normalized = folder;
    try { normalized = parseLocalPath(folder, { platform, folder: true }).normalized; } catch { /* compare as given */ }
    const kept = roots.filter(entry => !samePath(entry.path, normalized, platform) && !samePath(entry.real, normalized, platform));
    if (kept.length === roots.length) return fail(`${JSON.stringify(folder)} is not an approved folder`);
    writeRoots(dataRoot, kept);
    say(`Removed: SSAM can no longer read files in ${normalized}.`);
    return 0;
  }
  const checked = checkApproval(folder, { dataRoot, runtimeRoot, env, platform });
  if (checked.problem) return fail(checked.problem + '. Nothing was approved.');
  if (roots.some(entry => samePath(entry.path, checked.path, platform) || samePath(entry.real, checked.real, platform))) {
    say(`Already approved: ${checked.path}.`);
    return 0;
  }
  writeRoots(dataRoot, [...roots, { path: checked.path, real: checked.real, id: checked.id, addedAt: now().toISOString() }]);
  say(`Approved: SSAM may read files in ${checked.path} when a request names them (one file at a time, up to 64 MiB).`);
  return 0;
}

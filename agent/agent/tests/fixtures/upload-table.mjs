// The file.upload table, the same for the Node agent (lib/upload.mjs prepareUpload) and the native core (check-upload):
// a temporary layout with an approved folder, links and junctions that escape it, a hard link, a folder with an extension,
// a sparse file one byte above 64 MiB, credential names, the agent's own folders, a junction swapped between the checks
// and the open (beforeOpen.move), and an approved folder whose junction now leads elsewhere.
//   rows: [{label, request: {path, maxBytes, deadline?, beforeOpen?}, expected: 'send' | <error code>, size?}]
// Each fixture is used once: the swap rows move junctions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LAYOUT } from '../../lib/workspace.mjs';
import { rootsCommand } from '../../lib/upload-roots.mjs';
import { ordinalUpper } from '../../lib/local-paths.mjs';

export const MiB = 1024 * 1024;
// An approval refuses AppData (lib/upload-roots.mjs): the table needs a temporary folder outside it.
export const tempProblem = () => (os.tmpdir().split(/[\\/]/).some(part => part.toLowerCase() === 'appdata')
  ? 'TEMP is under AppData, which an upload approval refuses; set TEMP and TMP to a folder outside it' : false);
const junction = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const quiet = () => { const stream = { text: '', write(chunk) { stream.text += chunk; return true; } }; return stream; };

export function approve(dataRoot, folder, runtimeRoot = dataRoot) {
  const stdout = quiet(); const stderr = quiet();
  const code = rootsCommand({ op: 'add', folder, dataRoot, runtimeRoot, stdout, stderr });
  if (code !== 0) throw new Error('approval failed: ' + stderr.text);
}

export function uploadFixture({ prefix = 'ssam-upload-' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (/\s/.test(base)) throw new Error('The test temp folder has a space: ' + base);
  const data = path.join(base, 'data'); const runtime = path.join(base, 'runtime');
  for (const folder of LAYOUT) fs.mkdirSync(path.join(data, ...folder.split('/')), { recursive: true });
  fs.mkdirSync(runtime); fs.writeFileSync(path.join(runtime, 'pack.json'), '{}');
  const R = path.join(base, 'approved'); const outside = path.join(base, 'outside');
  for (const dir of [R, outside, path.join(R, 'sub'), path.join(R, 'folder.csv'), path.join(base, 'real1'), path.join(base, 'real2'), path.join(base, 'other')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(R, 'a.csv'), 'rows\n');
  fs.writeFileSync(path.join(R, 'A Report.CSV'), 'id,name\n1,x\n');
  fs.writeFileSync(path.join(R, 'empty.csv'), '');
  fs.writeFileSync(path.join(R, 'sub', 'b.txt'), 'inside\n');
  fs.writeFileSync(path.join(R, 'hard-source.csv'), 'twice\n');
  fs.linkSync(path.join(R, 'hard-source.csv'), path.join(R, 'hard.csv'));
  const big = path.join(R, 'big.bin');
  fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 64 * MiB + 1);
  fs.writeFileSync(path.join(outside, 'secret.csv'), 'outside\n');
  // The file the swapped junction leads to (the same name as the approved one).
  fs.writeFileSync(path.join(outside, 'b.txt'), 'outside\n');
  fs.writeFileSync(path.join(base, 'other', 'c.csv'), 'not approved\n');
  fs.writeFileSync(path.join(data, 'inbox', 'x.csv'), 'agent data\n');
  fs.writeFileSync(path.join(runtime, 'y.csv'), 'agent runtime\n');
  for (const dir of ['real1', 'real2']) fs.writeFileSync(path.join(base, dir, 'x.csv'), dir + '\n');
  junction(outside, path.join(R, 'link'));
  junction(path.join(R, 'sub'), path.join(R, 'inside-link'));
  junction(path.join(R, 'sub'), path.join(R, 'swap'));
  junction(outside, path.join(base, 'swap-evil'));
  junction(path.join(base, 'real1'), path.join(base, 'rootlink'));
  let fileLink = null;
  try { fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(R, 'filelink.csv'), 'file'); fileLink = path.join(R, 'filelink.csv'); }
  catch (error) { fileLink = { skip: 'no privilege to create a file symbolic link here (' + error.code + ')' }; }
  // Credential files the long-name rules refuse, reached through their 8.3 short names and through a junction inside R.
  fs.mkdirSync(path.join(R, '.docker')); fs.mkdirSync(path.join(R, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(R, '.env.local'), 'env canary\n');
  fs.writeFileSync(path.join(R, 'credentials.json'), '{"canary":1}\n');
  fs.writeFileSync(path.join(R, '.docker', 'config.json'), '{"auths":{}}\n');
  fs.writeFileSync(path.join(R, '.git', 'objects', 'pack.idx'), 'git canary\n');
  junction(path.join(R, '.git'), path.join(R, 'jgit'));
  const shortOf = shortNames([path.join(R, '.env.local'), path.join(R, 'credentials.json'), path.join(R, '.docker'), path.join(R, '.git')]);
  // Folders whose names differ only by a sign NTFS keeps distinct from the letter (Kelvin, Angstrom, Ohm).
  // And folders any case table folds together but NTFS keeps apart: they pass the lexical pre-selection and the exact real
  // comparison refuses them.
  const signs = [['K', '\u212A', 'UPLOAD_ROOT_NOT_APPROVED'], ['\u00E5', '\u212B', 'UPLOAD_ROOT_NOT_APPROVED'], ['\u03C9', '\u2126', 'UPLOAD_ROOT_NOT_APPROVED'],
    ['\u03A3\u039F\u03A6\u039F\u03A3', '\u03C3\u03BF\u03C6\u03BF\u03C2', 'PATH_LEAVES_ROOT'], ['\u00B5s', '\u03BCs', 'PATH_LEAVES_ROOT']];
  for (const [i, [letter, sign]] of signs.entries()) {
    const parent = path.join(base, 'signs' + i);
    fs.mkdirSync(path.join(parent, letter), { recursive: true }); fs.mkdirSync(path.join(parent, sign));
    fs.writeFileSync(path.join(parent, letter, 'x.csv'), 'approved\n'); fs.writeFileSync(path.join(parent, sign, 'secret.csv'), 'sibling\n');
  }
  approve(data, R, runtime);
  for (const [i, [letter]] of signs.entries()) approve(data, path.join(base, 'signs' + i, letter), runtime);  approve(data, path.join(base, 'rootlink'), runtime);
  // A plain approved folder later replaced by a junction to another folder, and one deleted and created again.
  for (const name of ['swapped', 'swapped-target', 'recreated']) { fs.mkdirSync(path.join(base, name)); fs.writeFileSync(path.join(base, name, 'x.csv'), name + '\n'); }
  approve(data, path.join(base, 'swapped'), runtime);
  approve(data, path.join(base, 'recreated'), runtime);
  fs.rmSync(path.join(base, 'swapped'), { recursive: true }); junction(path.join(base, 'swapped-target'), path.join(base, 'swapped'));
  fs.rmSync(path.join(base, 'recreated'), { recursive: true }); fs.mkdirSync(path.join(base, 'recreated')); fs.writeFileSync(path.join(base, 'recreated', 'x.csv'), 'recreated\n');
  // The approved junction now leads to another folder.
  fs.rmdirSync(path.join(base, 'rootlink')); junction(path.join(base, 'real2'), path.join(base, 'rootlink'));
  const at = (...parts) => path.join(R, ...parts);
  const max = 64 * MiB;
  const rows = [
    ['a file of the approved folder', { path: at('a.csv'), maxBytes: max }, 'send', 5],
    ['upper-case extension and a space', { path: at('A Report.CSV'), maxBytes: max }, 'send', 12],
    ['zero bytes', { path: at('empty.csv'), maxBytes: max }, 'send', 0],
    ['a sub-folder', { path: at('sub', 'b.txt'), maxBytes: max }, 'send', 7],
    ['a junction that stays inside', { path: at('inside-link', 'b.txt'), maxBytes: max }, 'send', 7],
    ['relative', { path: 'approved\\a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['~', { path: '~\\a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['UNC', { path: '\\\\server\\share\\a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['forward-slash UNC', { path: '//server/share/a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['\\\\?\\', { path: '\\\\?\\' + at('a.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['\\\\.\\', { path: '\\\\.\\' + at('a.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['alternate data stream', { path: at('a.csv') + ':zone', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['control character', { path: at('a\u0001.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['wildcard', { path: at('*.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['quote', { path: at('a".csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.. segment', { path: R + '\\sub\\..\\a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['. segment', { path: R + '\\.\\a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['empty segment', { path: R + '\\\\a.csv', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['segment ending in a dot', { path: R + '\\sub.\\b.txt', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['segment ending in a space', { path: R + '\\sub \\b.txt', maxBytes: max }, 'PATH_FORBIDDEN'],
    ['device name', { path: at('con.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['device folder', { path: at('nul', 'a.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['no extension', { path: at('README'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['extension too long', { path: at('a.abcdefghijklm'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['extension with a symbol', { path: at('a.c-v'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.ssh segment', { path: at('.ssh', 'config.txt'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.git segment', { path: at('.GIT', 'config.txt'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.aws segment', { path: at('.aws', 'credentials.ini'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['id_rsa', { path: at('id_rsa.pub'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['id_ed25519', { path: at('id_ed25519.bak'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.pem', { path: at('server.PEM'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.pfx', { path: at('cert.pfx'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.kdbx', { path: at('vault.kdbx'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.env.local', { path: at('.env.local'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['.npmrc', { path: at('.npmrc'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['credential*', { path: at('Credentials.json'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['the agent data folder', { path: path.join(data, 'inbox', 'x.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['the agent runtime folder', { path: path.join(runtime, 'y.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['outside the approved folders', { path: path.join(base, 'other', 'c.csv'), maxBytes: max }, 'UPLOAD_ROOT_NOT_APPROVED'],
    ['the approved folder itself', { path: R, maxBytes: max }, 'PATH_FORBIDDEN'],
    ['a junction that escapes', { path: at('link', 'secret.csv'), maxBytes: max }, 'PATH_LEAVES_ROOT'],
    ['a plain approved folder replaced by a junction', { path: path.join(base, 'swapped', 'x.csv'), maxBytes: max }, 'PATH_LEAVES_ROOT'],
    ['a plain approved folder deleted and created again', { path: path.join(base, 'recreated', 'x.csv'), maxBytes: max }, 'PATH_LEAVES_ROOT'],
    ['an approved junction that now leads elsewhere', { path: path.join(base, 'rootlink', 'x.csv'), maxBytes: max }, 'PATH_LEAVES_ROOT'],
    ['a junction swapped between the checks and the open', { path: at('swap', 'b.txt'), maxBytes: max,
      beforeOpen: { move: [[at('swap'), path.join(base, 'swap-old')], [path.join(base, 'swap-evil'), at('swap')]] } }, 'PATH_LEAVES_ROOT'],
    ['a hard link', { path: at('hard.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['the other name of a hard link', { path: at('hard-source.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['a folder', { path: at('folder.csv'), maxBytes: max }, 'PATH_FORBIDDEN'],
    ['a sparse file of 64 MiB + 1', { path: big, maxBytes: max }, 'FILE_TOO_LARGE'],
    ['above maxBytes', { path: at('a.csv'), maxBytes: 4 }, 'FILE_TOO_LARGE'],
    ['missing', { path: at('missing.csv'), maxBytes: max }, 'FILE_NOT_FOUND'],
    ['missing folder', { path: at('nowhere', 'missing.csv'), maxBytes: max }, 'FILE_NOT_FOUND'],
    ['deadline passed', { path: at('a.csv'), maxBytes: max, deadline: 1 }, 'AGENT_TIMEOUT'],
    ['maxBytes zero', { path: at('a.csv'), maxBytes: 0 }, 'PARAMS_INVALID'],
    ['maxBytes above 64 MiB', { path: at('a.csv'), maxBytes: max + 1 }, 'PARAMS_INVALID'],
    ['maxBytes not an integer', { path: at('a.csv'), maxBytes: 1.5 }, 'PARAMS_INVALID'],
    ['path not a string', { path: 7, maxBytes: max }, 'PARAMS_INVALID'],
  ].map(([label, request, expected, size]) => ({ label, request, expected, size }));
  const shortRows = [['.env.local by its 8.3 name', shortOf[0], null], ['credentials.json by its 8.3 name', shortOf[1], null],
    ['.docker by its 8.3 name', shortOf[2], 'config.json'], ['.git by its 8.3 name', shortOf[3], 'objects\\pack.idx']];
  const shortSkip = shortOf.some((short, i) => !short || path.basename(short) === path.basename([path.join(R, '.env.local'), path.join(R, 'credentials.json'), path.join(R, '.docker'), path.join(R, '.git')][i]))
    ? 'the test volume makes no 8.3 short names' : null;
  if (!shortSkip) for (const [label, short, tail] of shortRows) rows.push({ label, request: { path: tail ? path.join(short, tail) : short, maxBytes: max }, expected: 'PATH_FORBIDDEN' });
  rows.push({ label: 'a junction inside the approved folder to its .git', request: { path: at('jgit', 'objects', 'pack.idx'), maxBytes: max }, expected: 'PATH_FORBIDDEN' });
  rows.push({ label: 'the approved folder asked in another case', request: { path: path.join(base, 'signs3', '\u03C3\u03BF\u03C6\u03BF\u03C3', 'x.csv'), maxBytes: max }, expected: 'send', size: 9 });
  for (const [i, [letter, sign]] of signs.entries()) {
    rows.push({ label: `the approved ${letter} folder`, request: { path: path.join(base, 'signs' + i, letter, 'x.csv'), maxBytes: max }, expected: 'send', size: 9 });
    rows.push({ label: `the sibling ${JSON.stringify(sign)} of the approved ${letter}`, request: { path: path.join(base, 'signs' + i, sign, 'secret.csv'), maxBytes: max }, expected: signs[i][2] });
  }
  rows.push({ label: 'the approved K folder asked in lower case', request: { path: path.join(base, 'signs0', 'k', 'x.csv'), maxBytes: max }, expected: 'send', size: 9 });
  rows.push({ label: 'a lower-case drive letter', request: { path: at('a.csv').replace(/^[A-Z]:/, d => d.toLowerCase()), maxBytes: max }, expected: 'send', size: 5 });
  if (typeof fileLink === 'string') rows.push({ label: 'a file symbolic link that escapes', request: { path: fileLink, maxBytes: max }, expected: 'PATH_LEAVES_ROOT' });
  return { base, data, runtime, approved: R, rows, shortSkip, fileLinkSkip: typeof fileLink === 'string' ? null : fileLink.skip,
    remove: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

// A row's beforeOpen.move, as the native check-upload does it.
export const moveHook = request => (request.beforeOpen?.move ? () => { for (const [from, to] of request.beforeOpen.move) fs.renameSync(from, to); } : undefined);

// The 8.3 short names of files and folders (Windows Scripting.FileSystemObject), null where there is none.
function shortNames(paths) {
  if (process.platform !== 'win32') return paths.map(() => null);
  const script = paths.map(p => `$fs.${fs.statSync(p).isDirectory() ? 'GetFolder' : 'GetFile'}('${p.replace(/'/g, "''")}').ShortPath`).join(';');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$fs = New-Object -ComObject Scripting.FileSystemObject;' + script], { encoding: 'utf8', windowsHide: true });
  const lines = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean);
  // Only the last name is the short one: the folders above keep their long names, as the request spells the approved folder.
  return paths.map((p, i) => (lines[i] ? path.join(path.dirname(p), path.win32.basename(lines[i])) : null));
}
// Every pair of names the agent's case-insensitive pre-selection folds together (ordinalUpper) that NTFS keeps as two
// folders: the first one approved, a file in the second one asked. Each must be refused.
export function foldedSiblings({ prefix = 'ssam-folded-' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const data = path.join(base, 'data'); const runtime = path.join(base, 'runtime');
  for (const folder of LAYOUT) fs.mkdirSync(path.join(data, ...folder.split('/')), { recursive: true });
  fs.mkdirSync(runtime);
  const groups = new Map();
  const codes = [];
  for (let c = 0x20; c <= 0xfffd; c++) if (c < 0xd800 || c > 0xdfff) codes.push(c);
  for (const [from, to] of [[0x10400, 0x1044f], [0x104b0, 0x104fb], [0x10c80, 0x10cff], [0x118a0, 0x118df], [0x16e40, 0x16e7f], [0x1e900, 0x1e943]]) for (let c = from; c <= to; c++) codes.push(c);
  for (const c of codes) {
    const ch = String.fromCodePoint(c);
    if (/[\\/:*?"<>|. ]/.test(ch)) continue;
    const key = ordinalUpper('n' + ch);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push('n' + ch);
  }
  const roots = []; const rows = []; let pairs = 0;
  for (const names of groups.values()) {
    for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      pairs++;
      const parent = path.join(base, 'p' + rows.length + '-' + pairs);
      fs.mkdirSync(path.join(parent, names[i]), { recursive: true });
      try { fs.mkdirSync(path.join(parent, names[j])); } catch { fs.rmSync(parent, { recursive: true, force: true }); continue; }
      fs.writeFileSync(path.join(parent, names[j], 's.csv'), 'sibling\n');
      const root = path.join(parent, names[i]);
      roots.push({ path: root, real: fs.realpathSync.native(root), addedAt: null });
      rows.push({ label: [...names[i].slice(1)].map(x => x.codePointAt(0).toString(16)).join('') + ' approved, ' + [...names[j].slice(1)].map(x => x.codePointAt(0).toString(16)).join('') + ' asked',
        request: { path: path.join(parent, names[j], 's.csv'), maxBytes: 1024 } });
    }
  }
  fs.writeFileSync(path.join(data, 'private', 'upload-roots.json'), JSON.stringify({ schema: 'ssam-upload-roots/1', roots }));
  return { base, data, runtime, rows, pairs, remove: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
// The pack bundled with the app, synced into the agent root: the same result as extracting a new ssam-agent.zip (or
// the macOS tar.gz) OVER the root, as the guides say to update the agent, with nothing of the person's work touched:
//   - every file pack.json lists is copied when it is missing in the root or its sha256 differs (a temporary file is
//     written and then renamed, so a reader never sees a half file);
//   - a file the root's previous pack.json listed and the new one does not is removed (an older bridge, a script that
//     went away), never anything under the data folders (private/, inbox/, odc/snapshots, odc/journal, odc/lab, o11/),
//     which the pack never holds and the app never touches;
//   - on a POSIX system every .sh file is made executable (0755, as the tar.gz carries them);
//   - pack.json is written last, so a root with the new pack.json has every file of it.
// A file that cannot be replaced or removed (a bridge DLL still loaded in an open Studio on Windows) does not stop the
// sync: it is reported in `failed`, pack.json is still written, and the agent's doctor shows the file as changed until
// the Studio closes and the app syncs again.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DATA_FOLDERS = Object.freeze(['private', 'inbox', 'odc/snapshots', 'odc/journal', 'odc/lab', 'o11']);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relOf = text => String(text ?? '').replace(/\\/g, '/');
// A relative path pack.json may name: no drive, no root, no '..' and no empty segment.
export const safeRelative = rel => /^[^/\\]/.test(rel) && !/^[A-Za-z]:/.test(rel) && rel.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const underData = rel => DATA_FOLDERS.some(folder => rel === folder || rel.startsWith(folder + '/'));

export function readPackJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// The pack of a folder checked against its own pack.json, as the agent's doctor checks the root: {ok, detail, bad}.
export function verifyPack(dir) {
  const pack = readPackJson(dir);
  if (!pack || !Array.isArray(pack.files) || typeof pack.id !== 'string') return { ok: false, detail: 'pack.json missing or invalid', bad: [], pack: null };
  const bad = [];
  for (const file of pack.files) {
    const rel = relOf(file?.path);
    if (!safeRelative(rel)) { bad.push(rel + ' (path refused)'); continue; }
    const full = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(full)) { bad.push(rel + ' (missing)'); continue; }
    if (sha256(full) !== String(file.sha256).toLowerCase()) bad.push(rel + ' (changed)');
  }
  const detail = bad.length ? bad.slice(0, 5).join(', ') + (bad.length > 5 ? ` and ${bad.length - 5} more` : '') : `${pack.files.length} files checked (${pack.id})`;
  return { ok: bad.length === 0, detail, bad, pack };
}

// What a sync of packDir into root would do: {bundled, installed, copy, remove, upToDate}.
export function planSync(packDir, root) {
  const bundled = readPackJson(packDir);
  if (!bundled || !Array.isArray(bundled.files)) throw new Error('The bundled pack has no valid pack.json: ' + packDir);
  const installed = readPackJson(root);
  const wanted = new Map();
  for (const file of bundled.files) {
    const rel = relOf(file?.path);
    if (!safeRelative(rel) || underData(rel)) throw new Error('The bundled pack names a file the sync refuses: ' + rel);
    wanted.set(rel, String(file.sha256).toLowerCase());
  }
  const copy = [];
  for (const [rel, hash] of wanted) {
    const target = path.join(root, ...rel.split('/'));
    let same = false;
    try { same = fs.statSync(target).isFile() && sha256(target) === hash; } catch { same = false; }
    if (!same) copy.push(rel);
  }
  const remove = [];
  for (const file of Array.isArray(installed?.files) ? installed.files : []) {
    const rel = relOf(file?.path);
    if (!safeRelative(rel) || underData(rel) || wanted.has(rel)) continue;
    if (fs.existsSync(path.join(root, ...rel.split('/')))) remove.push(rel);
  }
  const sameId = installed?.id === bundled.id;
  return { bundled, installed, copy, remove, upToDate: sameId && copy.length === 0 && remove.length === 0 };
}

export function applySync(plan, packDir, root, { platform = process.platform, log = () => {} } = {}) {
  const copied = []; const removed = []; const failed = [];
  const posix = platform !== 'win32';
  for (const rel of plan.copy) {
    const source = path.join(packDir, ...rel.split('/'));
    const target = path.join(root, ...rel.split('/'));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = target + '.' + process.pid + '.sync';
      fs.copyFileSync(source, temporary);
      if (posix) fs.chmodSync(temporary, /\.sh$/.test(rel) ? 0o755 : 0o644);
      try { fs.renameSync(temporary, target); }
      catch (error) {
        // Windows: a file in use cannot be replaced by rename; try to remove it first, then give up on this one.
        try { fs.rmSync(target, { force: true }); fs.renameSync(temporary, target); }
        catch { fs.rmSync(temporary, { force: true }); throw error; }
      }
      copied.push(rel);
    } catch (error) { failed.push({ path: rel, error: error.code ?? error.message }); log('sync-failed', { path: rel, error: error.code ?? error.message }); }
  }
  for (const rel of plan.remove) {
    const target = path.join(root, ...rel.split('/'));
    try { fs.rmSync(target, { force: true }); removed.push(rel); }
    catch (error) { failed.push({ path: rel, error: error.code ?? error.message }); log('sync-remove-failed', { path: rel, error: error.code ?? error.message }); }
  }
  // Folders a removed file leaves empty go too (deepest first), never the data folders.
  const folders = new Set(removed.flatMap(rel => { const parts = rel.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')); }));
  for (const dir of [...folders].filter(dir => !underData(dir)).sort((a, b) => b.split('/').length - a.split('/').length)) {
    const full = path.join(root, ...dir.split('/'));
    try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* not empty or gone */ }
  }
  const packFile = path.join(root, 'pack.json');
  const temporary = packFile + '.' + process.pid + '.sync';
  fs.writeFileSync(temporary, fs.readFileSync(path.join(packDir, 'pack.json')));
  if (posix) fs.chmodSync(temporary, 0o644);
  fs.renameSync(temporary, packFile);
  log('sync', { pack: plan.bundled.id, copied: copied.length, removed: removed.length, failed: failed.length });
  return { pack: plan.bundled.id, copied, removed, failed };
}

// planSync + applySync when something differs; {synced: false} when the root already has this pack.
export function syncPack(packDir, root, options = {}) {
  const plan = planSync(packDir, root);
  if (plan.upToDate) return { synced: false, pack: plan.bundled.id, copied: [], removed: [], failed: [] };
  return { synced: true, ...applySync(plan, packDir, root, options) };
}

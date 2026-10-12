// The console's own state under CONSOLE_STATE_DIR (DESIGN 1.2, 2.4, 3.2-3.4): access.key, checkpoint.json, agg/, series/,
// alerts.json, workspaces.json, tokens-snapshot.json. This is the only module that writes there, and it never writes
// anywhere else: every path is relative to the state directory and is refused when it would leave it. Whole files are
// written to a unique temporary name with flush and renamed over the target, so a reader never sees half a file.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function createState(stateDir) {
  const root = path.resolve(stateDir);
  function target(rel) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw new Error('state path refused');
    const parts = rel.split(/[\\/]/);
    if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('state path refused');
    const full = path.resolve(root, ...parts);
    if (!full.startsWith(root + path.sep)) throw new Error('state path refused');
    return full;
  }
  const dirOf = rel => rel ? target(rel) : root;
  const notFound = error => error && error.code === 'ENOENT';

  function ensureDir(rel = '') { fs.mkdirSync(dirOf(rel), { recursive: true, mode: 0o700 }); }
  function writeText(rel, text, mode = 0o600) {
    const file = target(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, text, { mode, flush: true });
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* never created */ }
      throw error;
    }
  }
  function readText(rel) {
    try { return fs.readFileSync(target(rel), 'utf8'); } catch (error) { if (notFound(error)) return null; throw error; }
  }
  function readJson(rel) {
    let text;
    try { text = readText(rel); } catch { return null; }
    if (text == null) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  function appendLine(rel, line) {
    const file = target(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
  }
  function list(rel = '') {
    try { return fs.readdirSync(dirOf(rel)); } catch { return []; }
  }
  function remove(rel) {
    const file = target(rel);
    try { fs.unlinkSync(file); } catch (error) { if (!notFound(error)) throw error; }
  }
  const exists = rel => { try { fs.statSync(dirOf(rel)); return true; } catch { return false; } };

  return {
    root, ensureDir, writeText, readText, readJson, appendLine, list, remove, exists,
    writeJson: (rel, value) => writeText(rel, JSON.stringify(value)),
  };
}

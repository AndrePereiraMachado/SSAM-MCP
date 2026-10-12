// Size of each customer's workspace (DESIGN 3.4): every 10 min, for each customers/tok_<12 hex> directory, an iterative
// walk that lists directories and lstat()s entries (no symlink is followed, no file is ever opened), yielding every 1000
// entries and stopping at 500 000 entries per customer (truncated). Result in /state/workspaces.json.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const QUOTA_BYTES = 5 * 1024 ** 3;
export const WORKSPACE_EVERY_MS = 10 * 60000;
const MAX_ENTRIES = 500000;
const DIR = /^tok_[0-9a-f]{12}$/;
const breathe = () => new Promise(resolve => setImmediate(resolve));

export async function measure(root, { maxEntries = MAX_ENTRIES } = {}) {
  let bytes = 0, files = 0, entries = 0, truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (++entries > maxEntries) { truncated = true; break; }
      if (entries % 1000 === 0) await breathe();
      const full = path.join(dir, name);
      let st;
      try { st = await fsp.lstat(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else { files++; bytes += st.size; }
    }
    if (truncated) break;
  }
  return { bytes, files, truncated };
}

export function createWorkspaces({ serverDir, state, now = Date.now, maxEntries = MAX_ENTRIES }) {
  let data = state.readJson('workspaces.json');
  if (!data || typeof data.byToken !== 'object') data = { at: null, byToken: {} };
  let running = false;

  async function run() {
    if (running) return false;
    running = true;
    try {
      const base = path.join(serverDir, 'customers');
      let names = [];
      try { names = (await fsp.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory() && DIR.test(d.name)).map(d => d.name); } catch { names = []; }
      const byToken = {};
      for (const name of names) byToken[name] = await measure(path.join(base, name), { maxEntries });
      data = { at: new Date(now()).toISOString(), byToken };
      try { state.writeJson('workspaces.json', data); } catch { /* kept in memory */ }
      return true;
    } finally { running = false; }
  }
  const due = () => !data.at || now() - Date.parse(data.at) >= WORKSPACE_EVERY_MS;
  function get(token) {
    const w = data.byToken[token];
    return w ? { bytes: w.bytes, files: w.files, truncated: !!w.truncated, measuredAt: data.at, quotaBytes: QUOTA_BYTES } : null;
  }
  return { run, due, get, get all() { return data; } };
}

// What the MCP process loaded (C11 of the atritos 3 package): the identity that decides whether a running MCP server is
// stale is only the code and data it holds in memory. The kernel CLI, the XIF engine and the bridges run per call, so a
// change there never makes the server old. Pure (node builtins only): the launcher (facade/launch.mjs, the parent
// process) and the server (server-identity.mjs) both read it.
//
//   facadeSha256    every .mjs and .json of platforms/odc/facade/** (not tests/, node_modules/ or dot folders), of
//                   platforms/odc/portal/runtime/** (the facade imports it) and the .mjs of facade/ of the root
//   catalogSha256   catalog/tools.json, catalog/fragments/** and discovery-capabilities*.json of the facade
//   launcherSha256  facade/launch.mjs and facade/friction-*.mjs of the root: the parent process loads them, so only a
//                   reconnection of the MCP client loads them again
// Each sha256 is over the sorted pairs (relative path with '/', sha256 of the content); null when none of its files
// exists (a release bundle). createIdentityReader keeps a stat cache: within cacheMs it answers the last value, and after
// it it stats every file and hashes only the files whose size or mtime changed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SKIP_DIRS = new Set(['tests', 'node_modules']);
function walk(dir, accept, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full, accept, out); }
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out;
}
const code = name => /\.(?:mjs|json)$/i.test(name);

// The three file sets of a root (paths absolute).
export function identityFiles(root, { odc = 'platforms/odc' } = {}) {
  const facadeDir = path.join(root, odc, 'facade');
  const rootFacade = path.join(root, 'facade');
  const launcher = walk(rootFacade, name => name === 'launch.mjs' || /^friction-.*\.mjs$/i.test(name)).filter(f => path.dirname(f) === rootFacade);
  const catalog = [path.join(facadeDir, 'catalog', 'tools.json'), ...walk(path.join(facadeDir, 'catalog', 'fragments'), name => /\.json$/i.test(name)),
    ...walk(facadeDir, name => /^discovery-capabilities.*\.json$/i.test(name)).filter(f => path.dirname(f) === facadeDir)].filter(f => fs.existsSync(f));
  const facade = [...walk(facadeDir, code), ...walk(path.join(root, odc, 'portal', 'runtime'), code),
    ...walk(rootFacade, name => /\.mjs$/i.test(name)).filter(f => path.dirname(f) === rootFacade)];
  return { facade, catalog, launcher };
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function createIdentityReader({ root, odc, cacheMs = 2000, now = Date.now } = {}) {
  const files = new Map(); // absolute path -> {size, mtimeMs, sha}
  let checkedAt = -Infinity, last = null;
  const hashOf = file => {
    let stat;
    try { stat = fs.statSync(file); } catch { files.delete(file); return null; }
    const known = files.get(file);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha;
    let value;
    try { value = sha(fs.readFileSync(file)); } catch { return null; }
    files.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, sha: value });
    return value;
  };
  const setSha = list => {
    const pairs = list.map(file => [path.relative(root, file).split(path.sep).join('/'), hashOf(file)]).filter(([, value]) => value)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return pairs.length ? sha(pairs.map(([rel, value]) => rel + '\0' + value).join('\n')) : null;
  };
  return {
    read() {
      const t = now();
      if (last && t - checkedAt < cacheMs) return last;
      checkedAt = t;
      const sets = identityFiles(root, odc ? { odc } : {});
      last = { facadeSha256: setSha(sets.facade), catalogSha256: setSha(sets.catalog), launcherSha256: setSha(sets.launcher) };
      return last;
    },
  };
}

// The parts of the identity that differ (only those known at start are compared): ['facade' | 'catalog' | 'launcher'].
export function changedParts(started, current) {
  const parts = [];
  for (const [part, key] of [['facade', 'facadeSha256'], ['catalog', 'catalogSha256'], ['launcher', 'launcherSha256']])
    if (started?.[key] != null && started[key] !== current?.[key]) parts.push(part);
  return parts;
}

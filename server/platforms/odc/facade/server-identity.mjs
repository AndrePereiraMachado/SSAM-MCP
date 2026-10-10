// The identity of this MCP server (atritos 2, A09/A10, contract I13): which SSAM root it serves and which release of that
// root it loaded when it started. ssam_doctor answers it in `server` on every call; the central wrapper of ssam.mjs reads
// it again on every call (short cache) and answers RELEASE_CHANGED before any action once a setup replaced the release
// under the running process (2026-10-06: a process of the 10th release kept running after the 11th was installed and its
// discover answered "descriptor does not match"). Nothing here starts a process: the commit is read from the .git files.
//
//   serverIdentity({root, env})   {name:'ssam', root, release:{head, facadeSha256, catalogSha256, launcherSha256,
//                                 cli:{path, mtimeMs, size}}, startedAt, reloadedAt?, reloadedFrom?}
//                                 head: the checkout commit (HEAD, loose refs, packed-refs, the .git file of a worktree);
//                                 in a release bundle, release.json (sourceCommit, else version)
//   releaseChanged(started, now)  null | {changed: ['head' | 'facade' | 'catalog' | 'launcher'], info?: ['head' | 'cli'], from, to}
//
// C11 of the atritos 3 package: what makes a running server old is only what the MCP process loaded (facade-identity.mjs:
// the facade modules and data, the tool catalog, and the launcher the parent process runs). The kernel CLI, the XIF engine
// and the bridges run per call: a change there (or a commit that changes only them) never answers RELEASE_CHANGED; head and
// cli are only information. A release bundle has no facade sources: there its commit (head) is its code. The launcher
// (facade/launch.mjs) reloads the server by itself when the facade or the catalog change (SSAM_RELOADED_AT/FROM), so a
// session sees RELEASE_CHANGED only when the launcher itself changed (SSAM_LAUNCHER_SHA256 is what the parent loaded) or a
// reload was impossible (a request still pending).
//   sessionRoot({cwd, roots})     the folder holding .ssam-workspace.json at or above an MCP root of the client (first),
//                                 else at or above the cwd the client launched the server with; null when none
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from './workspace.mjs';
import { RELEASE, releaseManifest } from './release-layout.mjs';
import { TOOLS_FILE } from './tool-routing.mjs';
import { anvilCli } from './lanes.mjs';
import { createIdentityReader, changedParts } from './facade-identity.mjs';

export const SERVER_NAME = 'ssam';
export const WORKSPACE_MARKER = '.ssam-workspace.json';
const STARTED_AT = new Date().toISOString();
const SHA = /^[0-9a-f]{40,64}$/i;

// The commit of a checkout, from its files alone. null when the folder is not a git checkout or the ref cannot be read.
export function gitHead(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitDir, 'utf8'))?.[1];
      if (!pointer) return null;
      gitDir = path.resolve(root, pointer);
    }
    let common = gitDir;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return SHA.test(head) ? head.toLowerCase() : null;
    for (const dir of [gitDir, common]) {
      try { const value = fs.readFileSync(path.join(dir, ...ref.split('/')), 'utf8').trim(); if (SHA.test(value)) return value.toLowerCase(); } catch { /* packed */ }
    }
    for (const line of fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [sha, name] = line.split(' ');
      if (name === ref && SHA.test(sha)) return sha.toLowerCase();
    }
    return null;
  } catch { return null; }
}

const fileSha256 = file => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const fileStamp = file => { try { const s = fs.statSync(file); return { path: file, mtimeMs: Math.round(s.mtimeMs), size: s.size }; } catch { return { path: file, mtimeMs: null, size: null }; } };

// opts (tests): release (default RELEASE), catalogFile (only that file is the catalog), cliFile (default the O11 lane CLI),
// manifest (the release.json of a bundle), startedAt, files (an identity reader of facade-identity.mjs), loaded (true: the
// identity the process loaded: the launcher is the one its parent loaded, SSAM_LAUNCHER_SHA256, or none).
const readers = new Map(); // root -> identity reader (its stat cache hashes only the files that changed)
export function serverIdentity({ root = workspaceRoot, env = process.env, release = RELEASE, catalogFile, cliFile, manifest, startedAt = STARTED_AT, files, loaded = false } = {}) {
  let head = null; let version;
  if (release) {
    try { const m = manifest ?? releaseManifest({ env }); head = m?.sourceCommit ?? m?.version ?? null; version = m?.version; } catch { head = null; }
  } else head = gitHead(root);
  let cli = cliFile;
  if (cli === undefined) { try { cli = anvilCli(); } catch { cli = null; } }
  let sets = { facadeSha256: null, catalogSha256: null, launcherSha256: null };
  if (!release) {
    const reader = files ?? readers.get(root) ?? readers.set(root, createIdentityReader({ root, cacheMs: 0 })).get(root);
    try { sets = reader.read(); } catch { /* unreadable: not compared */ }
  }
  const catalogSha256 = catalogFile !== undefined ? fileSha256(catalogFile) : sets.catalogSha256 ?? fileSha256(TOOLS_FILE);
  const launcherSha256 = loaded ? (env.SSAM_LAUNCHER_SHA256 || null) : sets.launcherSha256;
  let reloadedFrom = null;
  try { reloadedFrom = env.SSAM_RELOADED_FROM ? JSON.parse(env.SSAM_RELOADED_FROM) : null; } catch { reloadedFrom = null; }
  return { name: SERVER_NAME, root, release: { head, ...(version ? { version } : {}), facadeSha256: sets.facadeSha256, catalogSha256, launcherSha256,
    cli: cli ? fileStamp(cli) : null }, startedAt, ...(loaded && env.SSAM_RELOADED_AT ? { reloadedAt: env.SSAM_RELOADED_AT, reloadedFrom } : {}) };
}

// What changed between the identity the server started with and the one on disk now; null when nothing did. A part that
// could not be read at start (null) is not compared: an unreadable file is not a new release. head and cli are only
// information (info), save in a release bundle (no facade sources), where head is the code itself.
export function releaseChanged(started, current) {
  const a = started?.release ?? {}; const b = current?.release ?? {};
  const changed = changedParts(a, b);
  const headDiffers = a.head != null && a.head !== b.head;
  if (headDiffers && a.facadeSha256 == null) changed.unshift('head');
  const info = [];
  if (headDiffers && a.facadeSha256 != null) info.push('head');
  if (a.cli?.mtimeMs != null && (a.cli.mtimeMs !== b.cli?.mtimeMs || a.cli.size !== b.cli?.size)) info.push('cli');
  if (!changed.length) return null;
  const pick = r => ({ head: r.head ?? null, facadeSha256: r.facadeSha256 ?? null, catalogSha256: r.catalogSha256 ?? null, launcherSha256: r.launcherSha256 ?? null,
    cli: r.cli ? { mtimeMs: r.cli.mtimeMs, size: r.cli.size } : null });
  return { changed, ...(info.length ? { info } : {}), from: pick(a), to: pick(b) };
}

// The SSAM root above a folder: the nearest folder holding .ssam-workspace.json.
export function workspaceAbove(folder) {
  if (typeof folder !== 'string' || !folder) return null;
  let dir;
  try { dir = path.resolve(folder.startsWith('file:') ? fileURLToPath(folder) : folder); } catch { return null; }
  for (;;) {
    if (fs.existsSync(path.join(dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The SSAM root of the session: an MCP root of the client first (uri file:///... or a path), else the cwd the client
// launched the server with (facade/launch.mjs passes it as SSAM_CLIENT_CWD, because the server itself runs in its root).
export function sessionRoot({ cwd = process.env.SSAM_CLIENT_CWD || process.cwd(), roots = [] } = {}) {
  for (const root of roots ?? []) {
    const found = workspaceAbove(typeof root === 'string' ? root : root?.uri ?? root?.path);
    if (found) return found;
  }
  return workspaceAbove(cwd);
}

export const sameFolder = (a, b) => {
  if (!a || !b) return false;
  const norm = p => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
};

// The per-call check of the central wrapper: the identity on disk at most every cacheMs, compared with the one the server
// started with. read() -> the current identity (serverIdentity by default).
export function releaseWatch({ started, read = () => serverIdentity(), cacheMs = 2000, now = Date.now } = {}) {
  let checkedAt = -Infinity; let last = null;
  return {
    started,
    check() {
      const t = now();
      if (t - checkedAt < cacheMs) return last;
      checkedAt = t;
      try { last = releaseChanged(started, read()); } catch { last = null; }
      return last;
    },
  };
}

// Content-addressed, backend-scoped server state. Never trust a mirrored manifest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { customerStateDir } from './storage.mjs';
import { insideVisible } from './mirror.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => Object.assign(new Error('The private verified artifact is unavailable or invalid.'), { code: 'PATCH_INVALID' });
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const bytesOf = v => JSON.stringify(canonical(v));
export const VERIFIED_MAX_AGE_MS = 60 * 60000;
export const VERIFIED_MAX_BYTES = 256 * 1024 * 1024;
const checks = new AsyncLocalStorage();
export const registerPrivateCheck = dir => checks.getStore()?.push(dir);
const under = (root, file) => { const r = path.relative(path.resolve(root), path.resolve(file)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
function privateFile(workspace, file) {
  try {
    const state = fs.realpathSync(customerStateDir(workspace));
    return path.isAbsolute(file) && under(customerStateDir(workspace), file) && under(fs.realpathSync(workspace), state) && !insideVisible(workspace, state) && under(state, fs.realpathSync(file));
  } catch { return false; }
}
function removePrivate(workspace, file) {
  if (!under(customerStateDir(workspace), file) || !privateFile(workspace, file)) return;
  try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* retried by the sweep */ }
}
export async function withPrivateChecks(workspace, run) {
  const dirs = [];
  try { return await checks.run(dirs, run); } finally { for (const dir of dirs) removePrivate(workspace, dir); }
}
function folder(workspace, kind) {
  if (!['patch', 'candidate'].includes(kind)) throw fail();
  const dir = path.join(customerStateDir(workspace), 'verified', kind);
  fs.mkdirSync(dir, { recursive: true });
  if (!privateFile(workspace, dir)) throw fail();
  return dir;
}
function atomicWrite(file, bytes) {
  const dir = path.dirname(file);
  const temp = path.join(dir, '.' + randomUUID() + '.tmp');
  try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch { /* renamed or not created */ } }
}
export function keepVerified(workspace, kind, value, { protect = [] } = {}) {
  const bytes = bytesOf(value), ref = hash(bytes), dir = folder(workspace, kind), file = path.join(dir, ref + '.json');
  if (Buffer.byteLength(bytes) > VERIFIED_MAX_BYTES) throw fail();
  atomicWrite(file, bytes);
  sweepVerified(workspace, { protect });
  if (!fs.existsSync(file)) throw fail();
  return ref;
}
export function readVerified(workspace, kind, ref) {
  try {
    if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) throw fail();
    const file = path.join(folder(workspace, kind), ref + '.json');
    if (fs.lstatSync(file).isSymbolicLink()) throw fail();
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== ref) throw fail();
    fs.utimesSync(file, new Date(), new Date());
    return JSON.parse(bytes);
  } catch { throw fail(); }
}
export function resolveVerifiedPatch(workspace, holder) {
  if (!holder?.patch || typeof holder.patch !== 'object' || Array.isArray(holder.patch) || !Object.hasOwn(holder.patch, 'verified')) return holder;
  if (Object.keys(holder.patch).length !== 1) throw fail();
  const saved = readVerified(workspace, 'patch', holder.patch.verified);
  if (!saved.jobSha256 || saved.jobSha256 !== holder.basedOn?.sha256) throw fail();
  return { ...holder, patch: saved.patch };
}
const replacePaths = (v, paths) => typeof v === 'string' ? paths.get(v) ?? v : Array.isArray(v) ? v.map(x => replacePaths(x, paths))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replacePaths(x, paths)])) : v;
const stableProvenance = v => Array.isArray(v) ? v.map(stableProvenance) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^(at|timestamp|createdAt|startedAt|finishedAt|elapsedMs|durationMs)$/i.test(k)).map(([k, x]) => [k, stableProvenance(x)])) : v;
const stableResult = v => Array.isArray(v) ? v.map(stableResult) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([key]) => !/(?:Ms|Timings)$/.test(key) && !/^(timings|baseCache)$/.test(key)).map(([key, value]) => [key, stableResult(value)])) : v;
export function keepCandidate(workspace, { lane, module, candidate }) {
  if (lane !== 'o11' || !candidate) return null;
  const blobs = {}, names = ['path', 'base', 'job', 'result'], aliases = new Map(names.map(k => [candidate[k], '@' + k]));
  if (candidate.sourceJob) aliases.set(candidate.sourceJob, '@job');
  for (const key of names) {
    if (!privateFile(workspace, candidate[key])) throw fail();
    blobs[key] = fs.readFileSync(candidate[key]).toString('base64');
  }
  if (hash(Buffer.from(blobs.path, 'base64')) !== candidate.sha256) throw fail();
  const checked = JSON.parse(Buffer.from(blobs.result, 'base64').toString('utf8'));
  if (checked.isValid !== true || checked.accepted !== true) throw fail();
  const { hot, ...rest } = checked;
  const stable = stableResult(rest);
  if (stable.provenance) stable.provenance = stableProvenance(stable.provenance);
  if (stable.referenceInventory?.file) {
    const file = stable.referenceInventory.file;
    if (!privateFile(workspace, file)) throw fail();
    blobs.references = fs.readFileSync(file).toString('base64');
    aliases.set(file, '@references');
  }
  blobs.result = Buffer.from(bytesOf(replacePaths(stable, aliases))).toString('base64');
  const producers = Object.fromEntries(Object.entries(candidate.producers ?? {}).map(([name, v]) => {
    const file = typeof v === 'string' ? v : v.path, sha256 = typeof v === 'object' ? v.sha256 : hash(fs.readFileSync(file));
    if (!sha256 || hash(fs.readFileSync(file)) !== sha256) throw fail();
    return [name, { path: file, sha256 }];
  }));
  const ref = keepVerified(workspace, 'candidate', { lane, module, blobs, candidate: {
    sha256: candidate.sha256, baseSha256: hash(Buffer.from(blobs.base, 'base64')), baseModelSha256: candidate.baseModelSha256, producers,
  } }, { protect: names.map(key => path.dirname(candidate[key])) });
  // Runtime hints are server-owned but not part of content identity.
  if (hot) atomicWrite(path.join(folder(workspace, 'candidate'), ref + '.hot.json'), bytesOf(hot));
  return ref;
}
export function keepPreview(workspace, module, manifest) {
  if (!privateFile(workspace, manifest)) throw fail();
  const v = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  return keepCandidate(workspace, { lane: 'o11', module, candidate: { path: v.candidate, sha256: v.candidateSha256, result: v.result,
    job: v.job, base: v.base, baseSha256: v.baseSha256, baseModelSha256: v.baseModelSha256, producers: v.producers } });
}
export function candidateOffer(workspace, ref, { lane, module }) {
  try {
    const saved = readVerified(workspace, 'candidate', ref);
    if (saved.lane !== lane || saved.module !== module) throw fail();
    const dir = path.join(folder(workspace, 'candidate'), ref); fs.mkdirSync(dir, { recursive: true });
    if (!privateFile(workspace, dir)) throw fail();
    const candidate = { ...saved.candidate }, names = { path: 'candidate.oml', base: 'base.oml', job: 'job.json', result: 'result.json',
      ...(saved.blobs.references ? { references: 'references.json' } : {}) };
    let hot;
    try {
      const hint = path.join(folder(workspace, 'candidate'), ref + '.hot.json');
      if (privateFile(workspace, hint) && !fs.lstatSync(hint).isSymbolicLink()) {
        hot = JSON.parse(fs.readFileSync(hint, 'utf8')); fs.utimesSync(hint, new Date(), new Date());
      }
    } catch { /* an optional runtime hint */ }
    for (const [key, name] of Object.entries(names)) candidate[key] = path.join(dir, name);
    for (const [key, encoded] of Object.entries(saved.blobs)) {
      let bytes = Buffer.from(encoded, 'base64');
      if (key === 'result') {
        const result = replacePaths(JSON.parse(bytes.toString('utf8')), new Map(Object.keys(names).map(k => ['@' + k, candidate[k]])));
        bytes = Buffer.from(bytesOf({ ...result, ...(hot ? { hot } : {}) }));
      }
      if (fs.existsSync(candidate[key]) && fs.lstatSync(candidate[key]).isSymbolicLink()) throw fail();
      if (!fs.existsSync(candidate[key]) || !fs.readFileSync(candidate[key]).equals(bytes)) atomicWrite(candidate[key], bytes);
    }
    fs.utimesSync(dir, new Date(), new Date());
    sweepVerified(workspace);
    if (!fs.existsSync(candidate.path)) throw fail();
    return { module, candidate };
  } catch { throw fail(); }
}
export function sweepVerified(workspace, { now = Date.now(), maxAgeMs = VERIFIED_MAX_AGE_MS, maxBytes = VERIFIED_MAX_BYTES, protect = [] } = {}) {
  let removed = 0;
  const retained = [];
  const bytesOfTree = file => { const stat = fs.lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink()
    ? fs.readdirSync(file).reduce((n, name) => n + bytesOfTree(path.join(file, name)), 0) : stat.size; };
  for (const rel of ['checks', 'builds', 'verified/candidate', 'verified/patch']) {
    const dir = path.join(customerStateDir(workspace), rel);
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if ([...protect, ...(checks.getStore() ?? [])].some(active => path.resolve(file) === path.resolve(active))) continue;
      try {
        const stat = fs.lstatSync(file);
        if (now - stat.mtimeMs > maxAgeMs) { removePrivate(workspace, file); removed++; }
        // The size cap is for retained artifacts, never a check or build another context is still using.
        else if (rel.startsWith('verified/')) retained.push({ file, time: stat.mtimeMs, size: bytesOfTree(file) });
      } catch { /* concurrent cleanup */ }
    }
  }
  let total = retained.reduce((n, item) => n + item.size, 0);
  for (const item of retained.sort((a, b) => a.time - b.time)) {
    if (total <= maxBytes) break;
    removePrivate(workspace, item.file); total -= item.size; removed++;
  }
  return removed;
}

// The Studio versions an image carries and the kernel.json it starts with (multi-version design rev. 3, O.6.1, the
// interim image: one Service Studio and one ODC Studio per image).
//   - peFileVersion: the FileVersion of a Windows PE file (VS_FIXEDFILEINFO of its RT_VERSION resource), read with node
//     only, so it works on Linux, where the image keeps no ServiceStudio.exe/ODCStudio.exe and the PowerShell reader of
//     executor.mjs has nothing to read. Both Studios carry ServiceStudio.Framework.dll, whose FileVersion is the Studio's
//     (11.55.92.65269, 1.7.28.10850).
//   - imageKernel: what the image declares (ENV SSAM_IMAGE_O11 / SSAM_IMAGE_ODC, written by its Dockerfile next to the
//     labels ssam.kernels.o11 / ssam.kernels.odc) and what its Studio folders really hold. Without the variables (the
//     owner's PC, the tests) nothing is judged and kernel.json is read as before.
//   - kernelPair: a lane whose kernel.json version is not the image's is OFF (null, the hub answers KERNEL_UNAVAILABLE
//     with cause KERNEL_VERSION_MISSING); the image's kernel never serves another Studio. The server logs one
//     `kernel-version-missing` per refused lane. The shape of the `kernel` event does not change. The hosted gate
//     (hosted/policy.mjs) refuses every tool of an off lane, the server-only ones included (ssam_job, ssam_map,
//     ssam_discover, ssam_reference...), and the server's warm-up skips it.
//   - kernelFileNotes: the interim reads kernel.json v1 only; a kernel.v2.json beside it (the multi-version image's file)
//     is ignored and named once (`kernel-v2-ignored`), and a kernel.json in the v2 shape serves no lane.
//   - resetStaleCaches: the caches of the cache volume that carry no Studio version (module index v1/<lane>, the lane
//     readers' copies, the prefetch readers') are emptied when the lane's Studio version is not the one they were built
//     with (stamp <module-index root>/kernel-studio.json), so nothing built for 11.55.91 is served to 11.55.92. A lane
//     that is off (refused at start) counts as an invalid stamp: its roots are emptied and its stamp dropped. The base
//     model cache of the O11 workers is in memory and keyed by IdeVersion (BaseModelCache.cs): nothing to do.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const IMAGE_ENV = Object.freeze({ o11: 'SSAM_IMAGE_O11', odc: 'SSAM_IMAGE_ODC' });
export const STUDIO_FILE = 'ServiceStudio.Framework.dll';
export const STAMP_FILE = 'kernel-studio.json';
const LANES = ['o11', 'odc'];
export const threePart = value => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim()); return m ? m[1] + '.' + m[2] + '.' + m[3] : null; };

// FileVersion and ProductVersion (four numbers each) of a PE image, or null. Walks the resource directory to the first
// RT_VERSION entry and reads VS_FIXEDFILEINFO (signature 0xFEEF04BD) inside that resource only.
export function peFileVersion(bytes) {
  try {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = b.readUInt32LE(0x3c);
    if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x4550) return null;
    const sections = b.readUInt16LE(pe + 6), optionalSize = b.readUInt16LE(pe + 20), optional = pe + 24;
    const magic = b.readUInt16LE(optional);
    const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
    if (!Number.isFinite(directories) || b.readUInt32LE(optional + (magic === 0x20b ? 108 : 92)) < 3) return null;
    const resourceRva = b.readUInt32LE(directories + 16);
    if (!resourceRva) return null;
    const table = optional + optionalSize;
    const offsetOf = rva => {
      for (let i = 0; i < sections; i++) {
        const s = table + i * 40, va = b.readUInt32LE(s + 12), size = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw = b.readUInt32LE(s + 20);
        if (rva >= va && rva < va + size) return rva - va + raw;
      }
      return -1;
    };
    const root = offsetOf(resourceRva);
    if (root < 0) return null;
    const entries = dir => {
      const count = b.readUInt16LE(dir + 12) + b.readUInt16LE(dir + 14), out = [];
      for (let i = 0; i < count; i++) out.push({ id: b.readUInt32LE(dir + 16 + i * 8), to: b.readUInt32LE(dir + 20 + i * 8) });
      return out;
    };
    const sub = entry => (entry && entry.to & 0x80000000 ? root + (entry.to & 0x7fffffff) : -1);
    const names = sub(entries(root).find(e => e.id === 16));
    if (names < 0) return null;
    const langs = sub(entries(names)[0]);
    if (langs < 0) return null;
    const leaf = entries(langs)[0];
    if (!leaf || leaf.to & 0x80000000) return null;
    const data = offsetOf(b.readUInt32LE(root + leaf.to)), size = b.readUInt32LE(root + leaf.to + 4);
    if (data < 0) return null;
    const at = b.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), data);
    if (at < 0 || at + 24 > Math.min(b.length, data + size)) return null;
    const four = (ms, ls) => [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
    return { file: four(b.readUInt32LE(at + 8), b.readUInt32LE(at + 12)), product: four(b.readUInt32LE(at + 16), b.readUInt32LE(at + 20)) };
  } catch { return null; }
}
export function studioFolderVersion(dir, { read = fs.readFileSync } = {}) {
  if (!dir) return null;
  try { return peFileVersion(read(path.join(dir, STUDIO_FILE)))?.file ?? null; } catch { return null; }
}

// Per lane: declared (the image's ENV, three numbers), studio (the FileVersion of the lane's Studio folder) and the
// version the image serves (declared), or null when the image declares nothing for the lane.
export function imageKernel({ env = process.env, studioDirs = {}, read } = {}) {
  return Object.fromEntries(LANES.map(lane => {
    const declared = threePart(env[IMAGE_ENV[lane]]);
    const studio = declared ? studioFolderVersion(studioDirs[lane], { read }) : null;
    return [lane, declared ? { declared, studio, studioThree: threePart(studio) } : null];
  }));
}

// The kernel the server starts with: a lane whose kernel.json version (or the image's own Studio) is not the version the
// image declares is set to null; refused names why, per lane, for the hub's answer and the log.
export function kernelPair(kernel, image) {
  const effective = { ...kernel };
  const refused = {};
  for (const lane of LANES) {
    const want = image?.[lane]?.declared;
    if (!want) continue;
    const pinned = threePart(kernel?.[lane]);
    const studio = image[lane].studioThree;
    const reason = studio && studio !== want ? 'image-inconsistent' : pinned === want ? null : pinned ? 'other-version' : 'not-pinned';
    if (!reason) continue;
    refused[lane] = { kernel: pinned, image: want, ...(image[lane].studio ? { studio: image[lane].studio } : {}), reason };
    effective[lane] = null;
  }
  return { kernel: effective, refused };
}

// kernel.json v1 only. A v2 file beside it and the v2 markers inside it are named (event names only).
const V2_KEYS = ['schema', 'default', 'served', 'legacyArtifacts', 'o11Bridges', 'odcBridges'];
export function kernelFileNotes(dir, { exists = fs.existsSync, read = fs.readFileSync } = {}) {
  const notes = [];
  if (exists(path.join(dir, 'kernel.v2.json'))) notes.push({ event: 'kernel-v2-ignored', file: 'kernel.v2.json' });
  let pinned = null;
  try { pinned = JSON.parse(String(read(path.join(dir, 'kernel.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { pinned = null; }
  const keys = pinned && typeof pinned === 'object' ? V2_KEYS.filter(k => Object.hasOwn(pinned, k)) : [];
  if (keys.length) notes.push({ event: 'kernel-json-unsupported', keys });
  return notes;
}

// The cache folders of a lane that carry no Studio version: index v1/<lane> (and its digests, rich indexes and content
// registry), and for O11 the readers' copies of the lane CLI and of the prefetch readers (readers/<platform>,
// readers-prefetch/<platform>, plus readers/<platform>-prefetch as the design names it).
export function legacyCacheRoots({ indexRoot, readerRoot, prefetchRoot, o11Platform = 'ss4' }) {
  return {
    o11: [path.join(indexRoot, 'v1', 'o11'), path.join(readerRoot, o11Platform), path.join(prefetchRoot, o11Platform), path.join(readerRoot, o11Platform + '-prefetch')],
    odc: [path.join(indexRoot, 'v1', 'odc')],
  };
}
// off: the lanes the image refused at start (kernelPair refused). An off lane is an invalid stamp: its roots are emptied
// (an index built by another Studio version is never left for ssam_map or ssam_discover) and its stamp is dropped, so the
// next start with a valid pair empties them again. A lane that is null without being off (an image that declares nothing
// for it) is left alone.
export function resetStaleCaches({ kernel, indexRoot, roots, off = [], log = () => {}, fsx = fs }) {
  const stampFile = path.join(indexRoot, STAMP_FILE);
  let stamp = {};
  try { stamp = JSON.parse(fsx.readFileSync(stampFile, 'utf8')) ?? {}; } catch { stamp = {}; }
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) stamp = {};
  const next = { ...stamp }, reset = [], failed = [];
  const empty = lane => {
    for (const root of roots[lane] ?? []) {
      try { fsx.rmSync(root, { recursive: true, force: true }); } catch (error) { failed.push({ lane, root: path.basename(root), error: error.code ?? 'EIO' }); }
    }
    reset.push(lane);
  };
  const exists = root => { try { return fsx.existsSync(root); } catch { return true; } };
  for (const lane of LANES) {
    const current = threePart(kernel?.[lane]);
    if (off.includes(lane)) {
      if (Object.hasOwn(stamp, lane) || (roots[lane] ?? []).some(exists)) empty(lane);
      delete next[lane];
      continue;
    }
    if (!current) continue;
    if (stamp[lane] !== current) empty(lane);
    next[lane] = current;
  }
  if (reset.length) log({ event: 'kernel-cache-reset', lanes: reset, from: Object.fromEntries(reset.map(l => [l, stamp[l] ?? null])),
    to: Object.fromEntries(reset.map(l => [l, next[l] ?? null])), ...(failed.length ? { failed } : {}) });
  if (reset.length || JSON.stringify(next) !== JSON.stringify(stamp)) {
    try { fsx.mkdirSync(indexRoot, { recursive: true }); fsx.writeFileSync(stampFile, JSON.stringify(next) + '\n'); }
    catch (error) { log({ event: 'kernel-cache-stamp-failed', error: error.code ?? 'EIO' }); }
  }
  return { reset, failed, stamp: next };
}

// The build check of the image (docker/ssam-server/Dockerfile; SSAM-MCP server/Dockerfile):
//   node kernel-image.mjs check-image <studio folder>=<three-part version> [...]
// exits 1 when a folder's ServiceStudio.Framework.dll is not that version (the ENV and labels would lie), 0 otherwise.
export function checkImage(pairs, { read } = {}) {
  const results = pairs.map(pair => {
    const at = pair.lastIndexOf('=');
    const dir = at > 0 ? pair.slice(0, at) : pair, want = threePart(at > 0 ? pair.slice(at + 1) : '');
    const found = studioFolderVersion(dir, { read });
    return { dir, want, found, ok: !!want && threePart(found) === want };
  });
  return { ok: results.length > 0 && results.every(r => r.ok), results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb !== 'check-image' || !rest.length) { process.stderr.write('usage: node kernel-image.mjs check-image <studio folder>=<version> [...]\n'); process.exit(2); }
  const result = checkImage(rest);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

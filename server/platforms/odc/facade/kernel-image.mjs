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
// Window 4x4 (design B, o11-kernels.mjs): a multi-O11 image declares SSAM_IMAGE_O11 as a list and carries one Studio folder
// and one CLI per version (SSAM_O11_STUDIO_ROOT/<v>, SSAM_O11_CLI_ROOT/<v>/cli). imageKernel reads every folder;
// kernelPair keeps kernel.json's o11 as the DEFAULT kernel (it must be one of the image's, as the pair rule asked) and lists
// the kernels that are on (o11Kernels: folder of the version and CLI present); a version whose folder or CLI is wrong is
// off alone (refusedKernels, logged kernel-version-missing with its version). o11ServedBuilds gives kernel.o11Builds. The
// O11 caches are per version (o11-kernel/<v> under the index root), so the stamp no longer resets them on a version change;
// the folder of a version this backend no longer serves is emptied at start.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fourPart } from './studio-identity.mjs';
import { STORE_GENERATION } from './store-generation.mjs';
import { imageO11Versions, isMultiO11Image, o11KernelPaths, O11_INDEX_FOLDER } from './o11-kernels.mjs';

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
export function imageKernel({ env = process.env, studioDirs = {}, read, exists = fs.existsSync } = {}) {
  return Object.fromEntries(LANES.map(lane => {
    if (lane === 'o11' && isMultiO11Image(env)) {
      // multi-O11: every declared version, its Studio folder's FileVersion and whether its CLI is there.
      const versions = imageO11Versions(env), studios = {}, clis = {};
      for (const v of versions) { const at = o11KernelPaths(v, env); studios[v] = studioFolderVersion(at.studioDir, { read }); clis[v] = exists(at.cli); }
      return [lane, { multi: true, versions, studios, clis }];
    }
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
  const refusedKernels = [];
  for (const lane of LANES) {
    if (image?.[lane]?.multi) {
      const im = image[lane], pinned = threePart(kernel?.[lane]), on = [];
      for (const v of im.versions) {
        const studio = im.studios?.[v] ?? null, three = threePart(studio);
        const why = three !== v ? (three ? 'image-inconsistent' : 'studio-missing') : im.clis?.[v] === false ? 'cli-missing' : null;
        if (why) refusedKernels.push({ lane, version: v, ...(studio ? { studio } : {}), reason: why }); else on.push(v);
      }
      const reason = !pinned ? 'not-pinned' : !im.versions.includes(pinned) ? 'other-version' : !on.includes(pinned) ? 'image-inconsistent' : null;
      if (reason) { refused[lane] = { kernel: pinned, image: im.versions.join(','), reason }; effective[lane] = null; effective.o11Kernels = []; }
      else effective.o11Kernels = on;
      continue;
    }
    const want = image?.[lane]?.declared;
    if (!want) continue;
    const pinned = threePart(kernel?.[lane]);
    const studio = image[lane].studioThree;
    const reason = studio && studio !== want ? 'image-inconsistent' : pinned === want ? null : pinned ? 'other-version' : 'not-pinned';
    if (!reason) continue;
    refused[lane] = { kernel: pinned, image: want, ...(image[lane].studio ? { studio: image[lane].studio } : {}), reason };
    effective[lane] = null;
  }
  return { kernel: effective, refused, ...(refusedKernels.length ? { refusedKernels } : {}) };
}

// A-M1 (C:\t\multiver\minimo\PROPOSTA.md): the four-part build each lane serves, which the hub compares with the build of
// the user's Studio (studio-identity.mjs). A lane the image declares: its Studio folder (the FileVersion of
// ServiceStudio.Framework.dll, the Studio's own build, equal to the ProductVersion of ODCStudio.exe/ServiceStudio.exe the
// agent reports); nothing else stands in for it. Otherwise (the owner's PC) the ProductVersion of this machine's Studio
// executable (exe), then a four-part version kernel.json pins. Only a build with the lane's three numbers counts; a lane
// that is off, or whose build is unknown, is null (the hub then compares three numbers, as before).
export function servedBuilds({ kernel, image, exe = {} }) {
  return Object.fromEntries(LANES.map(lane => {
    const three = threePart(kernel?.[lane]);
    if (!three) return [lane, null];
    const candidates = image?.[lane]?.multi ? [image[lane].studios?.[three]] : image?.[lane]?.declared ? [image[lane].studio] : [exe?.[lane], kernel?.[lane]];
    return [lane, candidates.map(fourPart).find(build => build && threePart(build) === three) ?? null];
  }));
}

// Window 4x4: the O11 kernels a multi-O11 backend serves, {"<x.y.z>": "<four-part build>" | null}, or null on a single-O11
// image. The kernels that are on (kernelPair o11Kernels) and, when the deployment names its O11 window (SSAM_SERVED_VERSIONS
// o11: the retirement of a version drops it there while its kernel stays in the image), only those it lists. The default
// kernel (kernel.json o11) is always served: it is the owner's pin, never retired without a new kernel.json.
export function o11ServedBuilds({ kernel, image, env = process.env }) {
  const im = image?.o11;
  if (!im?.multi || !threePart(kernel?.o11)) return null;
  let deployed = null;
  try { const listed = JSON.parse(env.SSAM_SERVED_VERSIONS ?? 'null')?.o11; if (Array.isArray(listed)) deployed = listed.map(v => threePart(v)).filter(Boolean); } catch { deployed = null; }
  const on = Array.isArray(kernel.o11Kernels) ? kernel.o11Kernels : [];
  const served = on.filter(v => v === threePart(kernel.o11) || !deployed || deployed.includes(v));
  return Object.fromEntries(served.map(v => { const b = fourPart(im.studios?.[v]); return [v, b && threePart(b) === v ? b : null]; }));
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
    // S1 (window 4x4) finding: the store's real folder is <root>/<generation>/<lane> (ModuleIndexStore.PathOf, STORE_GENERATION
    // v1-i<n>f<m>), not <root>/v1/<lane>: the reset emptied a folder no release writes and left the index of the previous
    // Studio version in place. Both are emptied now.
    o11: [path.join(indexRoot, 'v1', 'o11'), path.join(indexRoot, STORE_GENERATION, 'o11'), path.join(readerRoot, o11Platform), path.join(prefetchRoot, o11Platform), path.join(readerRoot, o11Platform + '-prefetch')],
    odc: [path.join(indexRoot, 'v1', 'odc'), path.join(indexRoot, STORE_GENERATION, 'odc')],
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
  // Window 4x4: a multi-O11 kernel stamps "multi" (its O11 stores are per version: o11-kernel/<v>); the switch from a single
  // version empties the shared O11 roots once, and the store of a version this backend no longer serves is removed.
  const multi = kernel?.o11Builds && typeof kernel.o11Builds === 'object' ? Object.keys(kernel.o11Builds) : null;
  if (multi) {
    const folder = path.join(indexRoot, O11_INDEX_FOLDER);
    let names = [];
    try { names = fsx.readdirSync(folder); } catch { names = []; }
    const gone = names.filter(name => !multi.includes(name));
    for (const name of gone) { try { fsx.rmSync(path.join(folder, name), { recursive: true, force: true }); } catch (error) { failed.push({ lane: 'o11', root: name, error: error.code ?? 'EIO' }); } }
    if (gone.length) log({ event: 'kernel-cache-retired', lane: 'o11', versions: gone });
  }
  for (const lane of LANES) {
    const current = lane === 'o11' && multi ? 'multi' : threePart(kernel?.[lane]);
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

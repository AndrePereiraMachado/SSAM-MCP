// The O11 kernels of one server image (window 4x4, design B: C:\t\r5\janela-4x4\DESENHO.md 1.4). One backend per ODC Studio
// version; each image carries EVERY Service Studio of the window (/studio/o11/<x.y.z>) and one O11 kernel CLI compiled
// against each (/app/kernel/.local/o11/<x.y.z>/cli/anvil.dll). The hub picks, per customer, the kernel of the customer's own
// Service Studio (the agent's Hello studios.o11.installed.version), so a backend serves every Service Studio of the window
// and the router chooses a backend by the ODC Studio alone (hosted/router.mjs).
//   - The image declares its kernels in ENV SSAM_IMAGE_O11 as a list ("11.55.92,11.55.93,11.55.94,11.55.95") and names the
//     two roots: SSAM_O11_STUDIO_ROOT (/studio/o11) and SSAM_O11_CLI_ROOT (/app/kernel/.local/o11). Without both roots the
//     image is the single-O11 image of the pairs (r45 and before) and nothing here changes what it does.
//   - The kernel the server starts with (ssam.mjs startupKernel) keeps `o11` (one version: the default kernel, the one
//     kernel.json pins, used for a customer whose Service Studio is not served) and adds `o11Builds`: {"<x.y.z>": "<four-part
//     build>" | null} of every kernel this backend serves (on in the image and, when the deployment names its O11 list
//     in SSAM_SERVED_VERSIONS, listed there).
//   - clientKernel: the kernel ONE customer sees (welcome.kernel, info().kernel, compatibility): `o11` and `builds.o11` are
//     those of the customer's own Service Studio when it is served here, else the default's. So the identity rule
//     (studio-identity.mjs) answers `same` for every served Service Studio, and the agent's native checks (CheckPid:
//     kernel[lane] equals the Studio's version; CheckO11Build: servedVersions.o11) pass with app 0.2.8 unchanged.
import path from 'node:path';
import { threePart, fourPart } from './studio-identity.mjs';

export const O11_ROOT_ENV = Object.freeze({ studio: 'SSAM_O11_STUDIO_ROOT', cli: 'SSAM_O11_CLI_ROOT' });
const VERSION = /^\d+\.\d+\.\d+$/;
const byVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
export const sortVersions = list => [...new Set(list.filter(v => VERSION.test(v)))].sort(byVersion);

// The O11 versions the image declares (ENV SSAM_IMAGE_O11), three numbers each, oldest first; [] when it declares none.
export function imageO11Versions(env = process.env) {
  return sortVersions(String(env.SSAM_IMAGE_O11 ?? '').split(',').map(v => threePart(v.trim())).filter(Boolean));
}
// The two roots of a multi-O11 image, or null (the single-O11 image, the owner's PC, the tests without them).
export function o11KernelRoots(env = process.env) {
  const studio = env[O11_ROOT_ENV.studio], cli = env[O11_ROOT_ENV.cli];
  if (typeof studio !== 'string' || typeof cli !== 'string' || !studio || !cli) return null;
  if (!path.isAbsolute(studio) || !path.isAbsolute(cli)) return null;
  return { studio, cli };
}
// The Studio folder and the CLI of one kernel version, or null without the roots or for a malformed version.
export function o11KernelPaths(version, env = process.env) {
  const roots = o11KernelRoots(env), v = threePart(version);
  if (!roots || !v || v !== String(version)) return null;
  return { version: v, studioDir: path.join(roots.studio, v), cli: path.join(roots.cli, v, 'cli', 'anvil.dll') };
}
// The image is multi-O11: both roots and at least one declared version.
export const isMultiO11Image = (env = process.env) => !!o11KernelRoots(env) && imageO11Versions(env).length > 0;

// The served O11 kernels of a started kernel ({"11.55.95": "11.55.95.65352", ...}), normalized: three-part keys, a value
// that is a four-part build of the same three numbers or null. null when the kernel is not multi-O11.
export function o11BuildsOf(kernel) {
  const value = kernel?.o11Builds;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const version of sortVersions(Object.keys(value))) {
    const build = fourPart(value[version]);
    out[version] = build && threePart(build) === version ? build : null;
  }
  return Object.keys(out).length ? out : null;
}
export const isMultiO11 = kernel => !!o11BuildsOf(kernel);

// The O11 kernel that serves a customer: its own Service Studio when this backend serves that version, else the default
// (kernel.o11). installed: the Hello's studios.o11.installed, its version, or null.
export function selectedO11(kernel, installed) {
  const builds = o11BuildsOf(kernel);
  if (!builds) return threePart(kernel?.o11);
  const want = threePart(typeof installed === 'string' ? installed : installed?.version);
  return want && Object.hasOwn(builds, want) ? want : threePart(kernel?.o11);
}

// The kernel one customer sees. A single-O11 kernel comes back as it is (the same object). For a multi-O11 kernel: o11 and
// builds.o11 of the selected kernel; o11PackBuiltFor (kernel.json: the pack builds the server accepts for its OWN Service
// Studio, F1 review M2) stays only on the default kernel, because its entries name builds proven for that Service Studio;
// on another served kernel it is [] (the rule stays on: only a thin bridge built for exactly that Studio, or one an
// o11ProvenBuilds proof covers for it, is accepted).
export function clientKernel(kernel, installed) {
  const builds = o11BuildsOf(kernel);
  if (!builds || !kernel) return kernel;
  const o11 = selectedO11(kernel, installed);
  const view = { ...kernel, o11, builds: { ...(kernel.builds ?? {}), o11: o11 ? builds[o11] ?? null : null } };
  if (Array.isArray(kernel.o11PackBuiltFor) && o11 !== threePart(kernel.o11)) view.o11PackBuiltFor = [];
  return view;
}

// The O11 module index store of one kernel version on a multi-O11 image: <SSAM_MODULE_INDEX_ROOT>/o11-kernel/<x.y.z>, the
// root its kernel processes and readers get as SSAM_MODULE_INDEX_ROOT (they keep their own <generation>/o11 below it) and
// the root the facade reads that version's O11 indexes from (module-map.mjs laneIndexRoot). The ODC indexes stay shared.
export const O11_INDEX_FOLDER = 'o11-kernel';
export function o11IndexRoot(root, version) {
  const v = threePart(version);
  if (!v || v !== String(version)) throw new Error('o11IndexRoot needs a three-part version');
  return path.join(root, O11_INDEX_FOLDER, v);
}

// The `o11` of a hosted context (executor.mjs createHostedContext). Single-O11 image: {studioDir, lane} as before (the
// server's one Studio). Multi-O11 image: getters read at each use, so a customer whose Service Studio changed under a live
// context (pong.versions; the hub closes the channel and the agent says Hello again) gets the kernel of its new Studio:
//   version   the kernel the hub names for this customer now (agent.kernel().o11), or null (O11 lane off, no Hello yet);
//   studioDir /studio/o11/<version>, else the fallback (the server's default Studio);
//   cli       /app/kernel/.local/o11/<version>/cli/anvil.dll, else null (the callers' own default CLI).
export function hostedO11({ agent, fallback, env = process.env }) {
  if (!isMultiO11Image(env)) return Object.freeze({ ...fallback });
  const served = () => { try { const v = threePart(agent?.kernel?.()?.o11); return v && o11KernelPaths(v, env) ? v : null; } catch { return null; } };
  return Object.freeze({
    lane: fallback?.lane,
    get version() { return served(); },
    get studioDir() { const v = served(); return v ? o11KernelPaths(v, env).studioDir : fallback?.studioDir; },
    get cli() { const v = served(); return v ? o11KernelPaths(v, env).cli : null; },
  });
}

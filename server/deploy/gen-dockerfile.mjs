// The Dockerfile of a multi-O11 image (window 4x4, design B: C:\t\r5\janela-4x4\DESENHO.md 1.4 item 1), generated from the
// production Dockerfile (../Dockerfile, the single-O11 image the pairs use, which stays as it is) and a list of Service
// Studio bundles:
//
//   node deploy/gen-dockerfile.mjs <o11-kernels.json> [<out Dockerfile>]      (default out: deploy/.generated/Dockerfile.o11k)
//
// o11-kernels.json: {"default": "11.55.95", "o11": [{"version": "11.55.92", "bundle": "o11-studio-11.55.92.65269.tar.gz",
//   "sha256": "<64 hex>", "tfm": "net8.0"?}, ...]}. Every bundle is pinned by its SHA256 in the generated file itself (the
// rule of require-pinned.sh, per version), from the `installers` build context as before; tfm only for a bundle frozen
// before 2026-10-27 (no runtimeconfig.json: the ARG comment of ../Dockerfile). The default is the kernel the server's own
// processes use (ANVIL_STUDIO_DIR, /app/kernel/.local/cli) and the one kernel.json pins (o11-kernels.mjs).
//
// What the generated file does instead of the single O11 stages (each replacement checks its anchor in ../Dockerfile: a
// changed anchor stops the generator, so the two files never drift silently):
//   - one stage studio-o11-<x-y-z> per bundle -> /studio/o11/<x.y.z>, and one kernel-o11-<x-y-z> per version, compiled against
//     it (SSDir, its own NuGet cache id) -> /app/kernel/.local/o11/<x.y.z>/cli. BuildKit caches each stage by its inputs, so a
//     rebuild for a new ODC Studio reuses every O11 kernel of an unchanged kernel tree;
//   - the runtime copies every folder, links libsqlite3 and the SkiaSharp natives into each, runs the probe on each, checks
//     each folder's FileVersion (kernel-image.mjs check-image) and each CLI's net472 references;
//   - ENV SSAM_IMAGE_O11 (ARG default and label ssam.kernels.o11) is the list; SSAM_O11_STUDIO_ROOT and SSAM_O11_CLI_ROOT name
//     the roots; ANVIL_STUDIO_DIR and /app/kernel/.local/cli (a link) are the default's, for the server's own processes;
//     label ssam.kernels.o11.default names it.
// A second Studio SOURCE, explicit per entry and never chosen silently: {"version": "11.55.93", "fromImage":
// "<name>@sha256:<64 hex>", "tfm"?, "fromPath"?} in place of bundle + sha256 copies the Studio folder of an image ALREADY BUILT
// from a pinned bundle (a production pair image of coolify/versions.json); a top-level {"odc": {"version", "fromImage",
// "tfm"?, "fromPath"?}} does the same for the ODC Studio (without "odc" the ODC Studio comes from the build args, as before).
// The reference must carry its digest: a tag alone, a digest-less name or the tag latest is refused. The stage keeps exactly
// the files of the Studio list (docker/ssam-server/studio-<lane>.txt, the rule of studio-extract.sh: every required path, an
// optional one when present, nothing unlisted), leaves out only what the production runtime stage ADDS to a Studio folder (the
// libsqlite3 link, the NuGet natives of skia-native: this build adds its own), and records the sha256 of every file
// (/app/studio-from-image/<lane>-<version>.sha256sums and .image). Every check after it is the bundle's: the kernel compiles
// against the folder, the SkiaSharp probe runs, check-image reads its FileVersion. The labels ssam.studio.<lane>.<version>.source
// name the source of every Studio (image <ref@digest>, or bundle <file> sha256:<sha>; an ODC Studio of the build args says so).
// Which images may be a source (trilha G review, D1): only a digest of the explicit, versioned trust list, never "any image
// with the right file tree". The list is the production pair images pinned in deploy/coolify/versions.json, each for its own
// lane and version (an "o11" entry for an O11 Studio, an "odc" entry for the ODC Studio, or an entry {lane, version, image,
// sha256} of its optional list "studioSources", where the pair images go when the served images change); a fromImage outside
// it stops the generator. A case outside versions.json goes to deploy/studio-image-trust.json, one entry per image with its own reason, and
// is taken only with the explicit option (--extra-trust "<why>"), which the image then carries as a label. An entry of either
// list marked "studioFrom": "image" (an image whose Studios were themselves copied from images) is never a source.
// The chain of copies (trilha G review, D2): a source must be an image built from a pinned bundle. At build time the stage
// mounts the source's /app and refuses an image that has /app/studio-from-image (it was built by this source) or no
// /app/studio-provenance.json (it is not an ssam-server image); the source's own studio-provenance.json is kept next to the
// sha256 list (/app/studio-from-image/<lane>-<version>.origin-provenance.json). Label ssam.studio.from-image lists the Studios
// copied, so an image built this way is recognizable without opening it.
// The deploy/ folder is outside the image context (.dockerignore), so the generated file never ships. deploy/build.sh builds
// it with SSAM_DOCKERFILE=<generated file>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{64}$/;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/;
const TFM = /^net\d+\.\d+$/;
// [registry/]name[:tag]@sha256:<64 hex> (Docker reference grammar, lowercase repository), the digest mandatory.
const IMAGE_REF = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;
const FROM_PATH = { o11: /^\/studio\/o11(?:\/\d+\.\d+\.\d+)?$/, odc: /^\/studio\/odc(?:\/\d+\.\d+\.\d+)?$/ };

// The image source of one entry, or null for a bundle entry: exactly one of bundle + sha256 or fromImage.
function imageSource(lane, entry, label) {
  const { version, bundle, sha256, tfm, fromImage, fromPath } = entry;
  if (fromImage === undefined) {
    if (fromPath !== undefined) throw new Error('fromPath of the ' + label + ' needs fromImage.');
    return null;
  }
  if (bundle !== undefined || sha256 !== undefined) throw new Error('The ' + label + ' names two sources (bundle and fromImage): pick one.');
  if (typeof fromImage !== 'string' || !fromImage.includes('@sha256:')) throw new Error('The image of the ' + label + ' has no digest: fromImage is <name>@sha256:<64 hex> (a tag alone is refused).');
  if (/:latest@/i.test(fromImage)) throw new Error('The image of the ' + label + ' names the tag latest: refused, name it by its digest only.');
  if (!IMAGE_REF.test(fromImage)) throw new Error('Invalid image reference of the ' + label + ': ' + JSON.stringify(fromImage) + '.');
  const from = fromPath ?? '/studio/' + lane;
  if (!FROM_PATH[lane].test(from)) throw new Error('Invalid fromPath of the ' + label + ' (a /studio/' + lane + ' folder of the image).');
  if (tfm !== undefined && !TFM.test(tfm)) throw new Error('Invalid tfm of the ' + label + '.');
  return { version, fromImage, fromPath: from, ...(tfm ? { tfm } : {}) };
}
// The reference without its tag: the digest names the content; a tag next to it is only a note.
const canonical = ref => ref.replace(/:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:/, '@sha256:');

// The trust list of image sources: the pair images of versions.json ({odc:[...], o11:[...]}, entries {version, image, sha256,
// studioFrom?}), and, only with an explicit reason (opts.extraReason), the entries of studio-image-trust.json ({entries:
// [{lane, version, image, sha256, reason, studioFrom?}]}). Returns {entries: Map("<lane> <version> <image@sha256:..>" ->
// {lane, version, ref, from, reason?}), refused: Map(same key -> why), extraReason}.
export function studioTrust(versions, { extra = null, extraReason = null } = {}) {
  const entries = new Map(), refused = new Map();
  const add = (lane, e, from) => {
    if (!e || typeof e !== 'object' || !VERSION.test(e.version ?? '') || !SHA.test(e.sha256 ?? '') || typeof e.image !== 'string')
      throw new Error('A ' + lane + ' entry of ' + from + ' has no version, image and sha256: ' + JSON.stringify(e) + '.');
    const ref = canonical(e.image + '@sha256:' + e.sha256);
    if (!IMAGE_REF.test(ref)) throw new Error('Invalid image of a ' + lane + ' entry of ' + from + ': ' + JSON.stringify(e.image) + '.');
    const key = lane + ' ' + e.version + ' ' + ref;
    if (e.studioFrom !== undefined && e.studioFrom !== 'bundle') {
      refused.set(key, from + ' marks it studioFrom ' + JSON.stringify(e.studioFrom) + ': its Studios are copies, take them from the image built from the bundle');
      return;
    }
    entries.set(key, { lane, version: e.version, ref, from, ...(e.reason ? { reason: e.reason } : {}) });
  };
  // A backend window (window 4x4, vigia/first-window.mjs: "backends", no image lists): its images are copies (studioFrom
  // "image"), never sources; only its studioSources are (window-images.mjs images carries the pair images there).
  const backendWindow = versions && Array.isArray(versions.backends);
  if (backendWindow) {
    if (!Array.isArray(versions.studioSources) || !versions.studioSources.length) throw new Error('versions.json is a backend window without studioSources: no image is a Studio source (put the pair images built from bundles in "studioSources").');
    for (const b of versions.backends) {
      const sha = String(b?.sha256 ?? '').replace(/^sha256:/, '');
      if (!b?.image || !SHA.test(sha)) continue;
      const ref = canonical(b.image + '@sha256:' + sha), why = 'versions.json backend ' + b.odc + ': the image of a backend window is a copy (studioFrom image), take its Studios from the image built from the bundle';
      refused.set('odc ' + b.odc + ' ' + ref, why);
      for (const v of b.o11Kernels ?? []) refused.set('o11 ' + v + ' ' + ref, why);
    }
  } else {
    if (!versions || !Array.isArray(versions.odc) || !Array.isArray(versions.o11)) throw new Error('The trust list needs versions.json with its lists "odc" and "o11".');
    for (const lane of ['odc', 'o11']) for (const e of versions[lane]) add(lane, e, 'versions.json');
  }
  // studioSources (optional): the images built from pinned bundles that stay Studio sources after the served images change,
  // e.g. the pair images once the window's multi-O11 images (studioFrom "image") take their place in "odc" and "o11".
  if (versions.studioSources !== undefined) {
    if (!Array.isArray(versions.studioSources)) throw new Error('studioSources of versions.json is a list.');
    for (const e of versions.studioSources) {
      if (!e || !['o11', 'odc'].includes(e.lane)) throw new Error('An entry of studioSources of versions.json has no lane o11 or odc: ' + JSON.stringify(e) + '.');
      add(e.lane, e, 'versions.json studioSources');
    }
  }
  if (extraReason !== null) {
    if (typeof extraReason !== 'string' || extraReason.trim().length < 10) throw new Error('--extra-trust needs the reason, in words (10 characters at least).');
    if (!extra || !Array.isArray(extra.entries)) throw new Error('--extra-trust needs deploy/studio-image-trust.json with a list "entries".');
    for (const e of extra.entries) {
      if (!e || !['o11', 'odc'].includes(e.lane)) throw new Error('An entry of studio-image-trust.json has no lane o11 or odc: ' + JSON.stringify(e) + '.');
      if (typeof e.reason !== 'string' || e.reason.trim().length < 10) throw new Error('The entry ' + e.lane + ' ' + e.version + ' of studio-image-trust.json has no reason.');
      add(e.lane, e, 'studio-image-trust.json');
    }
  }
  return { entries, refused, extraReason };
}

// Every image source of the checked list must be an entry of the trust list for its own lane and version; returns the entries.
export function trustedSources(list, odc, trust) {
  const sources = [...list.filter(e => e.fromImage).map(e => ['o11', e]), ...(odc ? [['odc', odc]] : [])];
  if (!sources.length) return [];
  if (!trust || !(trust.entries instanceof Map)) throw new Error('A Studio from an image needs the trust list (studioTrust of deploy/coolify/versions.json): none was given.');
  return sources.map(([lane, e]) => {
    const key = lane + ' ' + e.version + ' ' + canonical(e.fromImage);
    if (trust.refused?.has(key)) throw new Error('The image of the ' + lane + ' Studio ' + e.version + ' is refused: ' + trust.refused.get(key) + '.');
    const hit = trust.entries.get(key);
    if (!hit) {
      const other = [...trust.entries.values()].find(t => t.ref === canonical(e.fromImage));
      throw new Error('The image of the ' + lane + ' Studio ' + e.version + ' is not in the trust list' + (other ? ' for that lane and version (it is the ' + other.lane + ' ' + other.version + ' entry)' : '')
        + ': ' + e.fromImage + '. Only the pair images of deploy/coolify/versions.json are sources (or studio-image-trust.json with --extra-trust "<why>").');
    }
    return hit;
  });
}

const byVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
export const slugOf = version => version.replaceAll('.', '-');

// The checked list, oldest first, and the default; throws on anything the generated file could not pin.
export function o11KernelList(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.o11) || !spec.o11.length || spec.o11.length > 8) throw new Error('o11-kernels.json needs a list "o11" of 1 to 8 bundles.');
  const seen = new Set();
  const list = spec.o11.map(entry => {
    const known = ['version', 'bundle', 'sha256', 'tfm', 'fromImage', 'fromPath'];
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !known.includes(k))) throw new Error('An O11 bundle entry has unknown fields.');
    const { version, bundle, sha256, tfm } = entry;
    if (!VERSION.test(version ?? '')) throw new Error('Invalid O11 version ' + JSON.stringify(version) + '.');
    if (seen.has(version)) throw new Error('Duplicate O11 version ' + version + '.');
    seen.add(version);
    const image = imageSource('o11', entry, 'O11 Studio ' + version);
    if (image) return image;
    if (!BUNDLE.test(bundle ?? '') || !bundle.includes(version)) throw new Error('The bundle of ' + version + ' must be a .tar.gz whose name carries the version.');
    if (!SHA.test(sha256 ?? '')) throw new Error('The bundle of ' + version + ' has no pinned SHA256 (64 lowercase hex).');
    if (tfm !== undefined && !TFM.test(tfm)) throw new Error('Invalid tfm of ' + version + '.');
    return { version, bundle, sha256, ...(tfm ? { tfm } : {}) };
  }).sort((a, b) => byVersion(a.version, b.version));
  const def = spec.default ?? list.at(-1).version;
  if (!seen.has(def)) throw new Error('The default O11 kernel ' + def + ' is not in the list.');
  let odc = null;
  if (spec.odc !== undefined) {
    const entry = spec.odc;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !['version', 'tfm', 'fromImage', 'fromPath'].includes(k))) throw new Error('"odc" takes only version, fromImage, fromPath and tfm (an ODC bundle stays a build arg).');
    if (!VERSION.test(entry.version ?? '')) throw new Error('Invalid ODC version ' + JSON.stringify(entry.version) + '.');
    if (entry.fromImage === undefined) throw new Error('"odc" names no fromImage: leave "odc" out to take the ODC Studio from the build args.');
    odc = imageSource('odc', entry, 'ODC Studio ' + entry.version);
  }
  return { list, default: def, odc };
}

// The reader stage of the image source (studio-reader + studio-from-image.sh), only in a generated file that uses it:
//   studio-from-image.sh <lane> <copied folder> <list> <out> <version> <image ref>
const STUDIO_IMAGE_READER = String.raw`# ---- The reader of the Studio folder of a pinned image (build only; deploy/gen-dockerfile.mjs, source fromImage) ----------
FROM studio-reader AS studio-image-reader
COPY <<'EOF' /reader/studio-from-image.sh
#!/bin/sh
# The Studio folder of an image built from a pinned bundle, kept to the files of <list> as studio-extract.sh keeps them (every
# required path, an optional one when present, nothing unlisted). Left out: what the production runtime stage ADDS to a Studio
# folder (this build adds its own): the link libe_sqlite3.so and the NuGet natives libSkiaSharp.so and libHarfBuzzSharp.so.
# Any other unlisted file, or any other link, stops the build. The sha256 of every kept file goes to
# /studio-from-image/<lane>-<version>.sha256sums (copied to /app/studio-from-image/ of the runtime).
# <origin>: the source image's /app (a read-only mount). A source must be an image built from a pinned bundle: one with
# /app/studio-from-image was itself built from images (a copy of a copy) and one without /app/studio-provenance.json is no
# ssam-server image; both are refused. The source's studio-provenance.json is kept as <lane>-<version>.origin-provenance.json.
set -eu
lane=$1 from=$2 list=$3 out=$4 version=$5 ref=$6 origin=$7
man=${'$'}{STUDIO_FROM_IMAGE_DIR:-/studio-from-image}
if [ -e "$origin/studio-from-image" ]; then echo "ssam-server: $ref was itself built with Studios from images (it has /app/studio-from-image): a copy of a copy is refused; take the $lane Studio $version from the image built from its pinned bundle" >&2; exit 1; fi
[ -f "$origin/studio-provenance.json" ] || { echo "ssam-server: $ref has no /app/studio-provenance.json: not an ssam-server image built by server/Dockerfile, refused as a Studio source" >&2; exit 1; }
work=$(mktemp -d)
grep -v '^[[:space:]]*#' "$list" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' > "$work/listed"
sed -n '/^?/!p' "$work/listed" | sort > "$work/required"
sed -n 's/^?[[:space:]]*//p' "$work/listed" | sort > "$work/optional"
sort "$work/required" "$work/optional" > "$work/allowed"
printf 'libHarfBuzzSharp.so\nlibSkiaSharp.so\n' > "$work/natives"
(cd "$from" && find . -type f | sed 's|^\./||' | sort) > "$work/files"
(cd "$from" && find . -type l | sed 's|^\./||' | sort) > "$work/links"
bad=$(grep -vx 'libe_sqlite3.so' "$work/links" | head -n 5 || true)
[ -z "$bad" ] || { echo "ssam-server: the $lane Studio of $ref has links no build makes: $bad" >&2; exit 1; }
extra=$(comm -23 "$work/files" "$work/allowed" | comm -23 - "$work/natives" | head -n 5)
[ -z "$extra" ] || { echo "ssam-server: the $lane Studio of $ref has files outside $list: $extra" >&2; exit 1; }
lacking=$(comm -23 "$work/required" "$work/files" | head -n 5)
[ -z "$lacking" ] || { echo "ssam-server: the $lane Studio of $ref lacks the listed: $lacking" >&2; exit 1; }
comm -12 "$work/files" "$work/allowed" > "$work/keep"
mkdir -p "$out" "$man"
while IFS= read -r rel; do mkdir -p "$out/$(dirname "$rel")"; cp -p "$from/$rel" "$out/$rel"; done < "$work/keep"
(cd "$out" && find . -type f | sed 's|^\./||' | sort) | cmp -s - "$work/keep" || { echo "ssam-server: the $lane copy of $ref differs from its list" >&2; exit 1; }
(cd "$out" && while IFS= read -r rel; do sha256sum "$rel"; done < "$work/keep") > "$man/$lane-$version.sha256sums"
printf '%s\n' "$ref" > "$man/$lane-$version.image"
cp "$origin/studio-provenance.json" "$man/$lane-$version.origin-provenance.json"
echo "ssam-server: $lane $version: $(wc -l < "$work/keep") files ($(du -sh "$out" | cut -f1)) from the image $ref into $out; sha256 of the file list $(sha256sum "$man/$lane-$version.sha256sums" | cut -c1-64)"
rm -rf "$work" "$from"
EOF

`;

// The stage of a Studio from an image: the image by digest, its folder copied, then kept to the list.
function imageStage(lane, version, stage, e, out) {
  const source = stage.replace(/^studio-/, 'studio-image-');
  return [
    `# ---- ${lane === 'o11' ? 'Service Studio' : 'ODC Studio'} ${version} -> ${out} (from the image ${e.fromImage}, its ${e.fromPath}) ----`,
    `FROM ${e.fromImage} AS ${source}`,
    `FROM studio-image-reader AS ${stage}`,
    `COPY --from=${source} ${e.fromPath}/ /from-image/`,
    `RUN --mount=type=bind,from=${source},source=/app,target=/origin-app \\`,
    `    sh studio-from-image.sh ${lane} /from-image studio-${lane}.txt ${out} ${version} "${e.fromImage}" /origin-app`,
    ''].join('\n');
}

// The label of every Studio's source, the image by digest or the pinned bundle; only when an image is a source, so a file of
// bundles only stays byte for byte what it was.
// Without "odc" the ODC Studio is the build args' bundle (D6): its label says so, with the declared version.
function sourceLabels(list, odc, fromImages, trusted) {
  const lines = list.map(e => `      ssam.studio.o11.${e.version}.source="${e.fromImage ? 'image ' + e.fromImage : 'bundle ' + e.bundle + ' sha256:' + e.sha256}" \\\n`);
  lines.push(odc ? `      ssam.studio.odc.${odc.version}.source="image ${odc.fromImage}" \\\n`
    : '      ssam.studio.odc.source="build args: the ODC bundle of the installers context, SSAM_IMAGE_ODC=${SSAM_IMAGE_ODC}" \\\n');
  lines.push(`      ssam.studio.from-image="${fromImages.map(e => e.lane + ' ' + e.version).join(',')}" \\\n`);
  const extra = trusted.filter(t => t.from === 'studio-image-trust.json');
  if (extra.length) lines.push(`      ssam.studio.trust.extra="${extra.map(t => t.lane + ' ' + t.version).join(',')}: ${trusted.extraReason.replace(/["\\$\n]/g, ' ')}" \\\n`);
  return lines.join('');
}

// Replaces the one block from `start` (a whole line) up to (not including) the line `end`; both must exist once.
function block(text, start, end, replacement) {
  const a = text.indexOf(start);
  if (a < 0 || text.indexOf(start, a + 1) >= 0) throw new Error('Dockerfile anchor not found exactly once: ' + start.slice(0, 80));
  const b = text.indexOf(end, a);
  if (b < 0) throw new Error('Dockerfile anchor not found after the block: ' + end.slice(0, 80));
  return text.slice(0, a) + replacement + text.slice(b);
}
function once(text, from, to) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error('Dockerfile anchor found ' + n + ' times (want 1): ' + from.slice(0, 100));
  return text.replace(from, () => to);
}

// opts.trust: studioTrust(...) of deploy/coolify/versions.json; needed as soon as one Studio comes from an image.
export function generateDockerfile(base, spec, { trust = null } = {}) {
  const { list, default: def, odc } = o11KernelList(spec);
  const trusted = Object.assign(trustedSources(list, odc, trust), { extraReason: trust?.extraReason ?? null });
  const versions = list.map(e => e.version), csv = versions.join(','), words = versions.join(' ');
  const fromImages = [...list.filter(e => e.fromImage).map(e => ({ lane: 'o11', stage: `studio-o11-${slugOf(e.version)}`, ...e })),
    ...(odc ? [{ lane: 'odc', stage: 'studio-odc', ...odc }] : [])];
  let text = base.replace(/\r\n/g, '\n');
  const banner = '# GENERATED by deploy/gen-dockerfile.mjs from server/Dockerfile (window 4x4, multi-O11 image): O11 kernels ' + csv
    + ', default ' + def + (fromImages.length ? '; Studios from pinned images: ' + fromImages.map(e => e.lane + ' ' + e.version).join(', ') : '')
    + '. Do not edit; regenerate.\n';
  text = once(text, '# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e\n',
    '# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e\n' + banner);
  text = text.replace(/^ARG SSAM_IMAGE_O11=.*$/m, () => 'ARG SSAM_IMAGE_O11=' + csv);
  if (!text.includes('ARG SSAM_IMAGE_O11=' + csv + '\n')) throw new Error('Dockerfile anchor not found: ARG SSAM_IMAGE_O11=');

  // Service Studio stages, one per bundle. The installer name "-" never exists in the context: the pinned bundle is the input.
  // An entry with fromImage copies the Studio folder of that image instead (imageStage, studio-image-reader).
  const studios = (fromImages.length ? STUDIO_IMAGE_READER : '') + list.map(e => e.fromImage ? imageStage('o11', e.version, `studio-o11-${slugOf(e.version)}`, e, `/studio/o11/${e.version}`) : [
    `# ---- Service Studio ${e.version} -> /studio/o11/${e.version} (pinned bundle) ---------------------------------------------`,
    `FROM studio-reader AS studio-o11-${slugOf(e.version)}`,
    'ARG STUDIO_EXTRACTOR',
    'ARG REQUIRE_PINNED_STUDIOS',
    'RUN --mount=type=bind,from=installers,target=/installers \\',
    `    if [ "$REQUIRE_PINNED_STUDIOS" != 0 ]; then sh require-pinned.sh SERVICE_STUDIO_${slugOf(e.version).replaceAll('-', '_')} "-" "" "" "${e.bundle}" "${e.sha256}"; fi \\`,
    ` && STUDIO_EXTRACTOR="$STUDIO_EXTRACTOR" sh studio-extract.sh o11 "-" "" "" ServiceStudio.Framework.dll studio-o11.txt /studio/o11/${e.version} "${e.bundle}" "${e.sha256}"`,
    ''].join('\n')).join('\n');
  text = block(text, '# ---- Service Studio 11 -> /studio/o11 ', '# ---- ODC Studio -> /studio/odc ', studios);
  // The ODC Studio from an image: the stage keeps its name (studio-odc), so the ODC kernel, the builder and the runtime read
  // it as before; the declared ODC version is the entry's, and its tfm (a Studio without runtimeconfig.json) the ARG default.
  if (odc) {
    text = block(text, '# ---- ODC Studio -> /studio/odc ', '# ---- JavaScript dependencies ', imageStage('odc', odc.version, 'studio-odc', odc, '/studio/odc') + '\n');
    text = text.replace(/^ARG SSAM_IMAGE_ODC=.*$/m, () => 'ARG SSAM_IMAGE_ODC=' + odc.version);
    if (!text.includes('ARG SSAM_IMAGE_ODC=' + odc.version + '\n')) throw new Error('Dockerfile anchor not found: ARG SSAM_IMAGE_ODC=');
    if (odc.tfm) text = once(text, 'ARG ODC_STUDIO_TFM=\n', 'ARG ODC_STUDIO_TFM=' + odc.tfm + '\n');
  }

  // The SkiaSharp probe compiles against the default's SkiaSharp.dll (the same build in every Studio of the window, R4).
  text = once(text, '--mount=type=bind,from=studio-o11,source=/studio/o11,target=/studio/o11 \\\n    --mount=type=cache,id=ssam-nuget-skia-probe',
    `--mount=type=bind,from=studio-o11-${slugOf(def)},source=/studio/o11/${def},target=/studio/o11 \\\n    --mount=type=cache,id=ssam-nuget-skia-probe`);

  // O11 kernel stages, one per version.
  const refs = 'mscorlib.dll System.dll System.Core.dll Facades/netstandard.dll';
  const kernels = list.map(e => {
    const s = slugOf(e.version), out = `/out/kernel/.local/o11/${e.version}/cli`;
    return [
      `# ---- O11 kernel (anvil.dll) ${e.version}, against /studio/o11/${e.version} ------------------------------------------------------`,
      `FROM sdk AS kernel-o11-${s}`,
      `RUN --mount=type=bind,from=studio-o11-${s},source=/studio/o11/${e.version},target=/studio/o11/${e.version} \\`,
      `    --mount=type=cache,id=ssam-nuget-kernel-o11-${s},sharing=locked,target=/root/.nuget/packages \\`,
      '    dotnet build kernel/src/Anvil.Cli -c Release -nologo -v q -nodeReuse:false \\',
      `      -p:SSDir=/studio/o11/${e.version}${e.tfm ? ' -p:AnvilO11StudioTfm=' + e.tfm : ''} -o ${out} \\`,
      ` && for ref in ${refs}; do \\`,
      `      test -s "${out}/ref/net472/$ref" || { echo "kernel-o11-${s}: ref/net472/$ref missing next to the O11 CLI (the XIF final stage compiles against it)" >&2; exit 1; }; \\`,
      '    done',
      ''].join('\n');
  }).join('\n');
  text = block(text, '# ---- O11 kernel (anvil.dll), against /studio/o11 ', '# ---- ODC kernel (anvil-odc.dll)', kernels);

  // Runtime: every Studio folder, its natives and its probe.
  text = once(text, 'COPY --from=studio-o11 /studio/o11 /studio/o11\n',
    list.map(e => `COPY --from=studio-o11-${slugOf(e.version)} /studio/o11/${e.version} /studio/o11/${e.version}`).join('\n') + '\n');
  text = once(text, ' && ln -s "$sqlite" /studio/o11/libe_sqlite3.so && ln -s "$sqlite" /studio/odc/libe_sqlite3.so\n',
    ` && for v in ${words}; do ln -s "$sqlite" "/studio/o11/$v/libe_sqlite3.so" || exit 1; done && ln -s "$sqlite" /studio/odc/libe_sqlite3.so\n`);
  text = once(text, 'COPY --from=skia-native /native/libSkiaSharp.so /native/libHarfBuzzSharp.so /studio/o11/\n',
    list.map(e => `COPY --from=skia-native /native/libSkiaSharp.so /native/libHarfBuzzSharp.so /studio/o11/${e.version}/`).join('\n') + '\n');
  text = once(text, 'RUN dotnet /usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll /studio/o11 \\\n',
    `RUN for v in ${words}; do dotnet /usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll "/studio/o11/$v" || exit 1; done \\\n`);
  text = once(text, 'COPY --from=kernel-o11 /out/ /app/\n',
    list.map(e => `COPY --from=kernel-o11-${slugOf(e.version)} /out/ /app/`).join('\n') + '\n');

  // The image checks: every folder is its declared version, the declared list is exactly the generated one, every CLI has its refs.
  text = once(text, 'RUN node /app/platforms/odc/facade/kernel-image.mjs check-image "/studio/o11=${SSAM_IMAGE_O11}" "/studio/odc=${SSAM_IMAGE_ODC}"\n',
    `RUN test "\${SSAM_IMAGE_O11}" = "${csv}" \\\n${odc ? ` && test "\${SSAM_IMAGE_ODC}" = "${odc.version}" \\\n` : ''} && node /app/platforms/odc/facade/kernel-image.mjs check-image ${list.map(e => `"/studio/o11/${e.version}=${e.version}"`).join(' ')} "/studio/odc=\${SSAM_IMAGE_ODC}"\n`);
  text = once(text, 'RUN test -s /app/kernel/.local/cli/ref/net472/mscorlib.dll && test -s /app/kernel/.local/cli/ref/net472/Facades/netstandard.dll\n',
    `RUN for v in ${words}; do test -s "/app/kernel/.local/o11/$v/cli/anvil.dll" && test -s "/app/kernel/.local/o11/$v/cli/ref/net472/mscorlib.dll" \\\n      && test -s "/app/kernel/.local/o11/$v/cli/ref/net472/Facades/netstandard.dll" || exit 1; done\n`);
  // The default CLI where the server's own processes look for it (o11-lane.mjs, lanes.mjs anvilCli): a link, root-owned.
  text = once(text, ' && install -d -m 0755 /app/platforms/odc/studio/builder/features \\\n',
    ` && install -d -m 0755 /app/platforms/odc/studio/builder/features \\\n && ln -s o11/${def}/cli /app/kernel/.local/cli && test -s /app/kernel/.local/cli/anvil.dll \\\n`);
  text = once(text, '    ANVIL_STUDIO_DIR=/studio/o11 \\\n',
    `    ANVIL_STUDIO_DIR=/studio/o11/${def} \\\n    SSAM_O11_STUDIO_ROOT=/studio/o11 \\\n    SSAM_O11_CLI_ROOT=/app/kernel/.local/o11 \\\n`);
  text = once(text, '      ssam.kernels.o11="${SSAM_IMAGE_O11}" \\\n',
    `      ssam.kernels.o11="\${SSAM_IMAGE_O11}" \\\n      ssam.kernels.o11.default="${def}" \\\n` + (fromImages.length ? sourceLabels(list, odc, fromImages, trusted) : ''));
  // The sha256 of every file of every Studio copied from an image, next to the image's Studio provenance.
  if (fromImages.length) text = once(text, 'COPY --from=studio-provenance /provenance.json /app/studio-provenance.json\n',
    'COPY --from=studio-provenance /provenance.json /app/studio-provenance.json\n'
    + fromImages.map(e => `COPY --from=${e.stage} /studio-from-image/ /app/studio-from-image/`).join('\n') + '\n');
  // Nothing of the single-O11 stages may survive.
  for (const left of ['AS studio-o11\n', 'AS kernel-o11\n', 'from=studio-o11,', '--from=kernel-o11 ', '--from=studio-o11 '])
    if (text.includes(left)) throw new Error('The generated Dockerfile still names a single-O11 stage: ' + left.trim());
  return text;
}

// The Dockerfile of a CORRECTION image (trilha D, the X1 window: a production commit plus one correction commit, built with
// build-window-images.sh --source): the Dockerfile of that source commit as it is, the production layout of a pair image (one
// Service Studio at /studio/o11, the ODC Studio at /studio/odc, the kernel at /app/kernel/.local/cli, ANVIL_STUDIO_DIR
// /studio/o11), where only the two Studio stages change source: each Studio is copied from the production pair image by its
// digest (imageStage, the same reader, list, sha256 lists, chain check and labels as the multi-O11 file). Nothing else of the
// file moves: no /studio/o11/<version> folders, no second kernel, no new ENV, so the code of an old commit runs as it ran in
// its production image. spec: {"default"?, "o11": [one entry with fromImage, "tfm"?], "odc": {version, fromImage, "tfm"?}}.
export function generateSingleDockerfile(base, spec, { trust = null } = {}) {
  const { list, odc } = o11KernelList(spec);
  if (list.length !== 1) throw new Error('--single is one Service Studio (the pair image layout): ' + list.length + ' given.');
  const [o11] = list;
  if (!o11.fromImage || !odc) throw new Error('--single takes both Studios from images (fromImage on the O11 entry and "odc"): a correction image has no bundle.');
  const trusted = Object.assign(trustedSources(list, odc, trust), { extraReason: trust?.extraReason ?? null });
  const fromImages = [{ lane: 'o11', stage: 'studio-o11', ...o11 }, { lane: 'odc', stage: 'studio-odc', ...odc }];
  let text = base.replace(/\r\n/g, '\n');
  const syntax = text.match(/^# syntax=docker\/dockerfile:[^\n]*\n/);
  if (!syntax) throw new Error('Dockerfile anchor not found: the # syntax line.');
  text = once(text, syntax[0], syntax[0] + '# GENERATED by deploy/gen-dockerfile.mjs --single from the Dockerfile of the source commit (the pair image layout): '
    + 'Studios from pinned images: o11 ' + o11.version + ', odc ' + odc.version + '. Do not edit; regenerate.\n');
  for (const [arg, value] of [['SSAM_IMAGE_O11', o11.version], ['SSAM_IMAGE_ODC', odc.version]]) {
    text = text.replace(new RegExp('^ARG ' + arg + '=.*$', 'm'), () => 'ARG ' + arg + '=' + value);
    if (!text.includes('ARG ' + arg + '=' + value + '\n')) throw new Error('Dockerfile anchor not found: ARG ' + arg + '=');
  }
  if (o11.tfm) text = once(text, 'ARG SERVICE_STUDIO_TFM=\n', 'ARG SERVICE_STUDIO_TFM=' + o11.tfm + '\n');
  if (odc.tfm) text = once(text, 'ARG ODC_STUDIO_TFM=\n', 'ARG ODC_STUDIO_TFM=' + odc.tfm + '\n');
  text = block(text, '# ---- Service Studio 11 -> /studio/o11 ', '# ---- ODC Studio -> /studio/odc ',
    STUDIO_IMAGE_READER + imageStage('o11', o11.version, 'studio-o11', o11, '/studio/o11') + '\n');
  text = block(text, '# ---- ODC Studio -> /studio/odc ', '# ---- JavaScript dependencies ', imageStage('odc', odc.version, 'studio-odc', odc, '/studio/odc') + '\n');
  text = once(text, '      ssam.kernels.o11="${SSAM_IMAGE_O11}" \\\n', '      ssam.kernels.o11="${SSAM_IMAGE_O11}" \\\n' + sourceLabels(list, odc, fromImages, trusted));
  text = once(text, 'COPY --from=studio-provenance /provenance.json /app/studio-provenance.json\n',
    'COPY --from=studio-provenance /provenance.json /app/studio-provenance.json\n'
    + fromImages.map(e => `COPY --from=${e.stage} /studio-from-image/ /app/studio-from-image/`).join('\n') + '\n');
  // No bundle of the installers context may survive, and the layout stays the production one.
  for (const left of ['require-pinned.sh SERVICE_STUDIO', 'require-pinned.sh ODC_STUDIO', 'studio-extract.sh o11', 'studio-extract.sh odc'])
    if (text.includes(left)) throw new Error('The generated Dockerfile still reads a Studio bundle: ' + left);
  for (const kept of ['COPY --from=studio-o11 /studio/o11 /studio/o11\n', 'COPY --from=kernel-o11 /out/ /app/\n', '    ANVIL_STUDIO_DIR=/studio/o11 \\\n'])
    if (!text.includes(kept)) throw new Error('The Dockerfile of the source commit is not the pair image layout (missing: ' + kept.trim() + ').');
  return text;
}

// The trust list of this checkout: deploy/coolify/versions.json, and deploy/studio-image-trust.json with --extra-trust "<why>".
export function checkoutTrust({ extraReason = null, dir = here } = {}) {
  const read = file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
  return studioTrust(read('coolify/versions.json'), extraReason === null ? {} : { extra: read('studio-image-trust.json'), extraReason });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --single: the correction image (generateSingleDockerfile); --base <Dockerfile>: the Dockerfile to start from (the source
  // commit's, build-window-images.sh --source), default this checkout's server/Dockerfile.
  const args = process.argv.slice(2), at = args.indexOf('--extra-trust');
  const extraReason = at < 0 ? null : args.splice(at, 2)[1] ?? '';
  const si = args.indexOf('--single'), single = si >= 0; if (single) args.splice(si, 1);
  const bi = args.indexOf('--base'), baseFile = bi < 0 ? path.join(here, '..', 'Dockerfile') : args.splice(bi, 2)[1];
  const [input, output = path.join(here, '.generated', 'Dockerfile.o11k')] = args;
  if (!input || input.startsWith('--') || !baseFile) { process.stderr.write('usage: node deploy/gen-dockerfile.mjs <o11-kernels.json> [<out Dockerfile>] [--single] [--base <Dockerfile>] [--extra-trust "<why>"]\n'); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  const text = (single ? generateSingleDockerfile : generateDockerfile)(fs.readFileSync(baseFile, 'utf8'), spec, { trust: checkoutTrust({ extraReason }) });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text);
  const checked = o11KernelList(spec);
  const images = [...checked.list.filter(e => e.fromImage).map(e => ['o11 ' + e.version, e.fromImage]), ...(checked.odc ? [['odc ' + checked.odc.version, checked.odc.fromImage]] : [])];
  process.stdout.write(JSON.stringify({ ok: true, output, o11: checked.list.map(e => e.version), default: checked.default,
    ...(images.length ? { fromImage: Object.fromEntries(images) } : {}) }) + '\n');
}

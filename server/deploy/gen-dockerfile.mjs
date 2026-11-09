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
const byVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
export const slugOf = version => version.replaceAll('.', '-');

// The checked list, oldest first, and the default; throws on anything the generated file could not pin.
export function o11KernelList(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.o11) || !spec.o11.length || spec.o11.length > 8) throw new Error('o11-kernels.json needs a list "o11" of 1 to 8 bundles.');
  const seen = new Set();
  const list = spec.o11.map(entry => {
    const known = ['version', 'bundle', 'sha256', 'tfm'];
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !known.includes(k))) throw new Error('An O11 bundle entry has unknown fields.');
    const { version, bundle, sha256, tfm } = entry;
    if (!VERSION.test(version ?? '')) throw new Error('Invalid O11 version ' + JSON.stringify(version) + '.');
    if (seen.has(version)) throw new Error('Duplicate O11 version ' + version + '.');
    seen.add(version);
    if (!BUNDLE.test(bundle ?? '') || !bundle.includes(version)) throw new Error('The bundle of ' + version + ' must be a .tar.gz whose name carries the version.');
    if (!SHA.test(sha256 ?? '')) throw new Error('The bundle of ' + version + ' has no pinned SHA256 (64 lowercase hex).');
    if (tfm !== undefined && !TFM.test(tfm)) throw new Error('Invalid tfm of ' + version + '.');
    return { version, bundle, sha256, ...(tfm ? { tfm } : {}) };
  }).sort((a, b) => byVersion(a.version, b.version));
  const def = spec.default ?? list.at(-1).version;
  if (!seen.has(def)) throw new Error('The default O11 kernel ' + def + ' is not in the list.');
  return { list, default: def };
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

export function generateDockerfile(base, spec) {
  const { list, default: def } = o11KernelList(spec);
  const versions = list.map(e => e.version), csv = versions.join(','), words = versions.join(' ');
  let text = base.replace(/\r\n/g, '\n');
  const banner = '# GENERATED by deploy/gen-dockerfile.mjs from server/Dockerfile (window 4x4, multi-O11 image): O11 kernels ' + csv
    + ', default ' + def + '. Do not edit; regenerate.\n';
  text = once(text, '# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e\n',
    '# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e\n' + banner);
  text = text.replace(/^ARG SSAM_IMAGE_O11=.*$/m, () => 'ARG SSAM_IMAGE_O11=' + csv);
  if (!text.includes('ARG SSAM_IMAGE_O11=' + csv + '\n')) throw new Error('Dockerfile anchor not found: ARG SSAM_IMAGE_O11=');

  // Service Studio stages, one per bundle. The installer name "-" never exists in the context: the pinned bundle is the input.
  const studios = list.map(e => [
    `# ---- Service Studio ${e.version} -> /studio/o11/${e.version} (pinned bundle) ---------------------------------------------`,
    `FROM studio-reader AS studio-o11-${slugOf(e.version)}`,
    'ARG STUDIO_EXTRACTOR',
    'ARG REQUIRE_PINNED_STUDIOS',
    'RUN --mount=type=bind,from=installers,target=/installers \\',
    `    if [ "$REQUIRE_PINNED_STUDIOS" != 0 ]; then sh require-pinned.sh SERVICE_STUDIO_${slugOf(e.version).replaceAll('-', '_')} "-" "" "" "${e.bundle}" "${e.sha256}"; fi \\`,
    ` && STUDIO_EXTRACTOR="$STUDIO_EXTRACTOR" sh studio-extract.sh o11 "-" "" "" ServiceStudio.Framework.dll studio-o11.txt /studio/o11/${e.version} "${e.bundle}" "${e.sha256}"`,
    ''].join('\n')).join('\n');
  text = block(text, '# ---- Service Studio 11 -> /studio/o11 ', '# ---- ODC Studio -> /studio/odc ', studios);

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
    `RUN test "\${SSAM_IMAGE_O11}" = "${csv}" \\\n && node /app/platforms/odc/facade/kernel-image.mjs check-image ${list.map(e => `"/studio/o11/${e.version}=${e.version}"`).join(' ')} "/studio/odc=\${SSAM_IMAGE_ODC}"\n`);
  text = once(text, 'RUN test -s /app/kernel/.local/cli/ref/net472/mscorlib.dll && test -s /app/kernel/.local/cli/ref/net472/Facades/netstandard.dll\n',
    `RUN for v in ${words}; do test -s "/app/kernel/.local/o11/$v/cli/anvil.dll" && test -s "/app/kernel/.local/o11/$v/cli/ref/net472/mscorlib.dll" \\\n      && test -s "/app/kernel/.local/o11/$v/cli/ref/net472/Facades/netstandard.dll" || exit 1; done\n`);
  // The default CLI where the server's own processes look for it (o11-lane.mjs, lanes.mjs anvilCli): a link, root-owned.
  text = once(text, ' && install -d -m 0755 /app/platforms/odc/studio/builder/features \\\n',
    ` && install -d -m 0755 /app/platforms/odc/studio/builder/features \\\n && ln -s o11/${def}/cli /app/kernel/.local/cli && test -s /app/kernel/.local/cli/anvil.dll \\\n`);
  text = once(text, '    ANVIL_STUDIO_DIR=/studio/o11 \\\n',
    `    ANVIL_STUDIO_DIR=/studio/o11/${def} \\\n    SSAM_O11_STUDIO_ROOT=/studio/o11 \\\n    SSAM_O11_CLI_ROOT=/app/kernel/.local/o11 \\\n`);
  text = once(text, '      ssam.kernels.o11="${SSAM_IMAGE_O11}" \\\n',
    `      ssam.kernels.o11="\${SSAM_IMAGE_O11}" \\\n      ssam.kernels.o11.default="${def}" \\\n`);
  // Nothing of the single-O11 stages may survive.
  for (const left of ['AS studio-o11\n', 'AS kernel-o11\n', 'from=studio-o11,', '--from=kernel-o11 ', '--from=studio-o11 '])
    if (text.includes(left)) throw new Error('The generated Dockerfile still names a single-O11 stage: ' + left.trim());
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output = path.join(here, '.generated', 'Dockerfile.o11k')] = process.argv.slice(2);
  if (!input) { process.stderr.write('usage: node deploy/gen-dockerfile.mjs <o11-kernels.json> [<out Dockerfile>]\n'); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  const text = generateDockerfile(fs.readFileSync(path.join(here, '..', 'Dockerfile'), 'utf8'), spec);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text);
  process.stdout.write(JSON.stringify({ ok: true, output, o11: o11KernelList(spec).list.map(e => e.version), default: o11KernelList(spec).default }) + '\n');
}

// R4 families B and C (C:\t\r4\CAPTURA-FALHA.md, 02/11): on a built image (SSAM_TEST_IMAGE), every Studio folder carries the
// Linux natives of SkiaSharp and HarfBuzzSharp, the Studio's own SkiaSharp creates and FINALIZES an SKPaint, an SKTypeface
// and a HarfBuzz buffer there (the finalizer of an SKPaint aborted the hosted O11 kernel when libSkiaSharp.so was missing),
// and the server's start leaves no core file behind a process that aborts.
//   SSAM_TEST_IMAGE=<image:tag> node --test deploy/tests/skia-native-image.test.mjs
// SSAM_SKIA_PROBE_DIR=<host folder with ssam-skia-probe.dll>: runs that probe (mounted read-only) instead of the image's own,
// to prove an image built before the probe existed (the red run on prod-20261031-79a8da3-*).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.env.SSAM_TEST_IMAGE;
const docker = process.env.DOCKER_EXE ?? 'docker';
const probeDir = process.env.SSAM_SKIA_PROBE_DIR ?? null;
const STUDIOS = ['/studio/o11', '/studio/odc'];
// runtimes/linux-x64/native of SkiaSharp.NativeAssets.Linux.NoDependencies 2.88.9 and HarfBuzzSharp.NativeAssets.Linux 8.3.1.1
// (the .nupkg SHA256 values are pinned in server/Dockerfile, stage skia-native).
const NATIVE = {
  'libSkiaSharp.so': 'e987fdb330401c9e44e62a2a3000abb509481bfdbc2385d0466deecd90be1ec6',
  'libHarfBuzzSharp.so': 'c952458933ea7f1ce66ade61fa32e708df7dfb2ab8bae77ed5ec06f49223a75c',
};
const run = (args, timeout = 120000) => spawnSync(docker, ['--context', 'desktop-linux', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
  '--tmpfs', '/tmp:rw,size=64m', ...args], { encoding: 'utf8', timeout, windowsHide: true });

test('every Studio folder holds the pinned linux-x64 natives of SkiaSharp and HarfBuzzSharp next to the managed DLLs', () => {
  assert.ok(image, 'Set SSAM_TEST_IMAGE to the local image');
  const files = STUDIOS.flatMap(dir => Object.keys(NATIVE).map(name => dir + '/' + name));
  const r = run(['--entrypoint=sha256sum', image, ...files]);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const sums = new Map(r.stdout.trim().split(/\r?\n/).map(line => { const [sum, file] = line.trim().split(/\s+/); return [file, sum]; }));
  for (const file of files) assert.equal(sums.get(file), NATIVE[file.split('/').pop()], file);
});

for (const studio of STUDIOS) {
  test(`the Studio's own SkiaSharp creates and finalizes SKPaint, SKTypeface and a HarfBuzz buffer in ${studio}`, () => {
    assert.ok(image, 'Set SSAM_TEST_IMAGE to the local image');
    const mount = probeDir ? ['-v', probeDir.replace(/\\/g, '/') + ':/probe:ro'] : [];
    const probe = probeDir ? '/probe/ssam-skia-probe.dll' : '/usr/local/lib/ssam-skia-probe/ssam-skia-probe.dll';
    const r = run([...mount, '--entrypoint=dotnet', image, probe, studio]);
    assert.ifError(r.error);
    // 134: SIGABRT from the finalizer thread, the production failure; 1: a call failed.
    assert.equal(r.status, 0, `exit ${r.status}: ${(r.stdout + r.stderr).slice(0, 1500)}`);
    const said = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    assert.equal(said.ok, true, r.stdout);
    assert.deepEqual(said.errors, []);
    assert.match(said.skiaNative, /^88\./, 'the native milestone of SkiaSharp 2.88');
  });
}

test('the server start lowers the core limit to 0 for itself and the kernels it starts, and turns .NET minidumps off', () => {
  assert.ok(image, 'Set SSAM_TEST_IMAGE to the local image');
  // The real ssam-server-start up to its exec, which here prints the limits a kernel child would inherit; the container gets
  // an unlimited core limit, as the production containers do (ulimit -c: unlimited, core_pattern "core").
  const script = 'sed "s#^exec node .*#exec sh -c \'echo core=\\$(ulimit -c) minidump=\\${DOTNET_DbgEnableMiniDump:-unset}\'#" /usr/local/bin/ssam-server-start > /tmp/start && sh /tmp/start';
  const r = run(['--ulimit', 'core=-1:-1', '-e', 'ANVIL_AUTHORITY_DIR=/tmp/authority', '--entrypoint=sh', image, '-c', script]);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(r.stdout.trim(), 'core=0 minidump=0');
});

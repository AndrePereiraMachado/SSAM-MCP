// The toolchain of the Native AOT core (review M3 of agent/mac-028). GHSA-p3jp-9v83-76w9 (NU1903 on
// Microsoft.DotNet.ILCompiler 10.0.12) is an out-of-bounds write in the Brotli decoder, fixed in .NET 10.0.14. Native AOT links
// that decoder into ssam-agent statically, and document.fetch decompresses Brotli
// (DocumentFetch.cs: AutomaticDecompression = All). So the core must come from SDK 10.0.403 or newer, and the ILCompiler and
// runtime packs the restore resolved must be 10.0.14 or newer. The audit is never turned off (no NuGetAudit=false, no
// WarningsNotAsErrors=NU1903): an old toolchain must fail, not be waved through.
//   node scripts/check-native-toolchain.mjs --sdk "$(dotnet --version)"
//   node scripts/check-native-toolchain.mjs --assets native/Ssam.Agent/obj/project.assets.json --rid osx-arm64
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_SDK = '10.0.403';
export const MIN_RUNTIME = '10.0.14';

const parts = value => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '')); return m ? m.slice(1).map(Number) : null; };
const older = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
// "[10.0.14, 10.0.14]" (a downloadDependency range) or "10.0.14": the lowest version it allows.
const lowest = range => String(range ?? '').replace(/^[[(]\s*/, '').split(',')[0].trim();

export function sdkProblem(sdk, min = MIN_SDK) {
  const got = parts(sdk);
  if (!got) return `the .NET SDK version is not readable: "${sdk ?? ''}"`;
  if (older(got, parts(min))) return `the .NET SDK is ${String(sdk).trim()}, older than ${min} (GHSA-p3jp-9v83-76w9 is fixed in the 10.0.14 runtime)`;
  return null;
}

// The ILCompiler and runtime packs of a Native AOT restore (obj/project.assets.json): every one at least MIN_RUNTIME, and
// the ILCompiler, its runtime-specific pack and the NativeAOT runtime pack of rid all present.
export function assetsProblems(assets, { rid, min = MIN_RUNTIME } = {}) {
  const found = [];
  for (const key of Object.keys(assets?.libraries ?? {})) {
    const [name, version] = key.split('/');
    if (/ILCompiler/i.test(name)) found.push({ name, version });
  }
  for (const framework of Object.values(assets?.project?.frameworks ?? {}))
    for (const dep of framework?.downloadDependencies ?? [])
      if (/^Microsoft\.NETCore\.App\.Runtime\.|ILCompiler/i.test(dep?.name ?? '')) found.push({ name: dep.name, version: lowest(dep.version) });
  const problems = [];
  const required = ['Microsoft.DotNet.ILCompiler', ...(rid ? [`runtime.${rid}.Microsoft.DotNet.ILCompiler`, `Microsoft.NETCore.App.Runtime.NativeAOT.${rid}`] : [])];
  for (const name of required) if (!found.some(f => f.name.toLowerCase() === name.toLowerCase())) problems.push(`${name} is not in the restore (not a Native AOT restore for ${rid ?? 'this runtime'}?)`);
  for (const f of found) {
    const got = parts(f.version);
    if (!got || older(got, parts(min))) problems.push(`${f.name} ${f.version} is older than ${min} (GHSA-p3jp-9v83-76w9)`);
  }
  return { problems, found };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2); const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const problems = []; const report = {};
  if (args.includes('--sdk')) { report.sdk = value('--sdk'); const p = sdkProblem(report.sdk); if (p) problems.push(p); }
  if (args.includes('--assets')) {
    const { problems: list, found } = assetsProblems(JSON.parse(fs.readFileSync(value('--assets'), 'utf8')), { rid: value('--rid') });
    report.packs = found.map(f => f.name + ' ' + f.version); problems.push(...list);
  }
  if (!args.includes('--sdk') && !args.includes('--assets')) problems.push('use --sdk <version> and/or --assets <project.assets.json> [--rid <rid>]');
  console.log(JSON.stringify({ ...report, minSdk: MIN_SDK, minRuntime: MIN_RUNTIME, ok: problems.length === 0 }));
  if (problems.length) { for (const p of problems) console.error('::error::' + p); process.exit(1); }
}

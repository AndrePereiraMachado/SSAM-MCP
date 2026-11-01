import fs from 'node:fs';
import path from 'node:path';

// This is a release window, not a claim that six live Mac sessions have passed.
// Refresh the explicit list when qualifying a new Studio release; never subtract
// version numbers (vendors can skip releases).
export const STUDIO_WINDOW = Object.freeze({
  asOf: '2026-10-27',
  odc: Object.freeze(['1.7.30', '1.7.29', '1.7.28']),
  o11: Object.freeze(['11.55.94', '11.55.93', '11.55.92'])
});

export function releaseOf(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version ?? '')) throw new Error('Missing Studio build version');
  return version.split('.').slice(0, 3).join('.');
}

// The ODC bridge a Studio runtime gets from Bridge.csproj (agent/r4-v106): one source, one name per runtime, the AssemblyName whose
// Condition names that TargetFramework, else the one without a condition (the agent box: v107 for net8, v106 for net10; the line:
// v106, v107 for net8). null when the project names no bridge.
export function odcBridgeFor(projectText, targetFramework) {
  const text = String(projectText ?? '').replace(/<!--[\s\S]*?-->/g, '');
  for (const [, condition, version] of text.matchAll(/<AssemblyName(?:\s+Condition="([^"]*)")?\s*>ODC3\.Bridge\.(v\d+)<\/AssemblyName>/g))
    if (condition && new RegExp("^\\s*'\\$\\(TargetFramework\\)'\\s*==\\s*'" + targetFramework.replace('.', '\\.') + "'\\s*$").test(condition)) return version;
  return /<AssemblyName>ODC3\.Bridge\.(v\d+)<\/AssemblyName>/.exec(text)?.[1] ?? null;
}

// bridgeVersion: the name the caller expects (the source pack's odcBridge); Bridge.csproj, when it is there, decides the name of
// the Studio's own runtime and the plan says it (bridgeVersion of the plan).
export function studioBuildPlan(studio, app, bridgeVersion) {
  const { lane, version, dir } = studio;
  if (!['odc', 'o11'].includes(lane)) throw new Error('Unknown Studio lane');
  const release = releaseOf(version);
  if (!STUDIO_WINDOW[lane].includes(release))
    throw new Error('STUDIO_OUTSIDE_BUILD_WINDOW: ' + lane + ' ' + version + '. Install one of: ' + STUDIO_WINDOW[lane].join(', '));
  const entry = lane === 'odc' ? 'ODCStudio' : 'ServiceStudio';
  const config = JSON.parse(fs.readFileSync(path.join(dir, entry + '.runtimeconfig.json'), 'utf8').replace(/^\uFEFF/, ''));
  const targetFramework = config.runtimeOptions?.tfm;
  if (!['net8.0', 'net9.0', 'net10.0'].includes(targetFramework)) throw new Error('Unsupported Studio target framework: ' + targetFramework);
  if (!fs.existsSync(path.join(dir, entry + '.dll'))) throw new Error('Studio entry assembly is missing: ' + entry);
  const bridgeProject = path.join(app, 'platforms/odc/studio/bridge/Bridge.csproj');
  if (lane === 'odc' && fs.existsSync(bridgeProject)) bridgeVersion = odcBridgeFor(fs.readFileSync(bridgeProject, 'utf8'), targetFramework) ?? bridgeVersion;
  if (!/^v\d+$/.test(bridgeVersion)) throw new Error('Invalid ODC bridge version');
  const projects = lane === 'odc' ? [
    { name: 'odc', project: 'platforms/odc/studio/bridge/Bridge.csproj', properties: ['-p:OdcInstall=' + dir], assembly: 'ODC3.Bridge.' + bridgeVersion, destination: 'odc/studio/bridge/bin/Release/net8.0' }
  ] : [
    { name: 'o11', project: 'kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj', properties: ['-p:SSDir=' + dir], assembly: 'Anvil.Bridge', destination: 'bin/o11/bridge' },
    { name: 'hook', project: 'kernel/tools/Anvil.RuntimeHook/Anvil.RuntimeHook.csproj', properties: ['-p:AssemblyName=Anvil.RuntimeHook.Agent'], assembly: 'Anvil.RuntimeHook.Agent', destination: 'bin/o11/hook' }
  ];
  return { ...studio, release, targetFramework, ...(lane === 'odc' ? { bridgeVersion } : {}),
    projects: projects.map(p => ({ ...p, project: path.join(app, p.project), targetFramework, lane, version })) };
}

export function coverageMatrix() {
  return ['odc', 'o11'].flatMap(lane => STUDIO_WINDOW[lane].map(version => ({ lane, version, build: 'not-tested', live: 'not-tested' })));
}

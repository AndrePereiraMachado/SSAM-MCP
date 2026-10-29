import fs from 'node:fs';
import path from 'node:path';
import { inspectBundle } from './macos.mjs';

export const studioVersion = value => /^(\d+\.\d+\.\d+)(?:\.|$)/.exec(String(value ?? ''))?.[1] ?? null;
export function bundledBridgeSupports(pack, root, lane, version, runtime) {
  if (!runtime || !studioVersion(version)) return true;
  const build = pack.studioBuilds?.[lane];
  const builtFor = build?.version ?? pack[lane === 'odc' ? 'odcBuiltFor' : 'o11BuiltFor'];
  if (builtFor && studioVersion(builtFor) !== studioVersion(version)) return false;
  let framework = build?.tfm ?? build?.runtime ?? pack[lane + 'Runtime'];
  if (!framework) {
    const relative = lane === 'odc' ? 'odc/studio/bridge/bin/Release/net8.0' : 'bin/o11/bridge';
    try {
      const dep = JSON.parse(fs.readFileSync(path.join(root, relative, lane === 'odc' ? `ODC3.Bridge.${pack.odcBridge}.deps.json` : 'Anvil.Bridge.deps.json'), 'utf8'));
      const match = /Version=v(\d+\.\d+)/.exec(dep.runtimeTarget?.name ?? '');
      framework = match ? 'net' + match[1] : null;
    } catch { /* Legacy packages carry .NET 8 bridges in the established layout. */ }
    framework ??= 'net8.0';
  }
  return framework === runtime;
}
export function runtimeOf(config) {
  const options = config?.runtimeOptions;
  const version = options?.framework?.version ?? options?.frameworks?.find(f => f.name === 'Microsoft.NETCore.App')?.version;
  return /^net\d+\.\d+$/.test(options?.tfm ?? '') ? options.tfm : /^(\d+)\.(\d+)/.test(version ?? '') ? 'net' + version.split('.').slice(0, 2).join('.') : null;
}
export async function studioRuntime(target, lane, { platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const bundle = /^(.*?\.app)(?:\/|$)/.exec(target)?.[1];
    return bundle ? runtimeOf((await inspectBundle(bundle))?.runtimeConfig) : null;
  }
  const dir = /\.exe$/i.test(target) ? path.dirname(target) : target;
  try { return runtimeOf(JSON.parse(fs.readFileSync(path.join(dir, (lane === 'odc' ? 'ODCStudio' : 'ServiceStudio') + '.runtimeconfig.json'), 'utf8').replace(/^\uFEFF/, ''))); }
  catch { return null; }
}

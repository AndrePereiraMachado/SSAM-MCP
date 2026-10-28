import fs from 'node:fs';
import path from 'node:path';
import { inspectBundle } from './macos.mjs';

export const studioVersion = value => /^(\d+\.\d+\.\d+)(?:\.|$)/.exec(String(value ?? ''))?.[1] ?? null;
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

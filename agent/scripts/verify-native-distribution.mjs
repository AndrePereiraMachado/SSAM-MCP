import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { verifyPack } from '../src/main/core/pack-sync.mjs';
import { validateNativeImage } from './native-pack.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const folder = path.resolve(process.argv[2] ?? 'dist/win-unpacked');
const resources = path.join(folder, folder.endsWith('.app') ? 'Contents/Resources' : 'resources');
const packRoot = path.join(resources, 'pack');
const result = verifyPack(packRoot);
assert.equal(result.ok, true, result.detail);
assert.equal(result.pack.nativeCore?.runtime, 'native-aot');
if (result.pack.platform !== 'darwin') {
  assert.equal(result.pack.selfContainedHelpers, true, 'Windows releases must include the helper runtimes');
  for (const [folder, name] of [['bin/o11/connect', 'Anvil.Connect'], ['odc/studio/bridge/client/bin/Release/net10.0', 'ODC3.Bridge.Client']]) {
    for (const file of [name + '.exe', 'hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll'])
      assert.ok(fs.existsSync(path.join(packRoot, folder, file)), 'Bundled runtime missing: ' + file);
    const config = JSON.parse(fs.readFileSync(path.join(packRoot, folder, name + '.runtimeconfig.json'), 'utf8')).runtimeOptions;
    assert.ok(config.includedFrameworks?.length && !config.framework && !config.frameworks, 'Helper still needs external .NET');
  }
}
const walk = (root, relative = '') => fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
  const name = relative ? relative + '/' + entry.name : entry.name;
  assert.equal(entry.isSymbolicLink(), false, name);
  return entry.isDirectory() ? walk(root, name) : [name];
});
const files = walk(packRoot);
assert.deepEqual(files.sort(), [...result.pack.files.map(f => f.path), 'pack.json'].sort(), 'Unlisted runtime files');
for (const name of files) assert.ok(!/\.(?:mjs|cjs|js|ts|cs|csproj|ps1|sh|pdb|map|key|pfx)$/i.test(name), name);
const entries = asar.listPackage(path.join(resources, 'app.asar'));
for (const name of entries) {
  assert.ok(!/^[/\\](?:src|agent|native|kernel|platforms|tests|scripts|docs)[/\\]/.test(name), name);
  assert.ok(!/\.(?:map|pdb|cs|csproj)$/i.test(name), name);
}
const binary = fs.readFileSync(path.join(packRoot, result.pack.nativeCore.path));
validateNativeImage(binary, result.pack.platform === 'darwin' ? 'darwin' : 'win32', result.pack.nativeCore.arch);
console.log(JSON.stringify({ ok: true, pack: result.pack.id, runtimeFiles: files.length, asarEntries: entries.length,
  nativeBytes: binary.length, nativeSha256: createHash('sha256').update(binary).digest('hex'),
  sourceTreeInRuntime: false, sourceMaps: false, productionValidated: false }, null, 2));

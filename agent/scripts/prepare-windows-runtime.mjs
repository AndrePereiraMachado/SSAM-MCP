// Owner build step. Customers receive the resulting binaries in the installer.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyPack } from '../src/main/core/pack-sync.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32') throw new Error('Build the Windows runtime on Windows');
const source = path.resolve(process.argv[2] ?? path.join(app, 'pack'));
const verified = verifyPack(source);
if (!verified.ok || verified.pack.platform === 'darwin') throw new Error('A verified Windows pack is required');
const parent = path.join(app, '.local/native'); fs.mkdirSync(parent, { recursive: true });
const output = fs.mkdtempSync(path.join(parent, 'windows-runtime-'));
const helpers = [
  ['kernel/tools/Anvil.Connect/Anvil.Connect.csproj', 'bin/o11/connect'],
  ['platforms/odc/studio/bridge/client/Client.csproj', 'odc/studio/bridge/client/bin/Release/net10.0']
];
const files = [];
function add(relative, bytes) {
  const target = path.join(output, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const file of verified.pack.files) {
  if (file.path.startsWith('native/') || helpers.some(([, folder]) => file.path.startsWith(folder + '/'))) continue;
  add(file.path, fs.readFileSync(path.join(source, file.path)));
}
for (const [project, folder] of helpers) {
  const destination = path.join(output, folder);
  const result = spawnSync('dotnet', ['publish', path.join(app, project), '-restore', '-c', 'Release', '-r', 'win-x64',
    '--self-contained', 'true', '-p:DebugType=None', '-p:DebugSymbols=false', '-o', destination, '--nologo'],
  { cwd: app, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Self-contained helper build failed: ' + project);
  for (const name of fs.readdirSync(destination)) {
    if (!/\.(dll|exe|json)$/.test(name)) throw new Error('Unexpected helper build output: ' + name);
    add(folder + '/' + name, fs.readFileSync(path.join(destination, name)));
  }
}
const pack = { ...verified.pack, id: 'windows-bundled-runtime-' + Date.now(), files, selfContainedHelpers: true };
delete pack.nativeCore;
fs.writeFileSync(path.join(output, 'pack.json'), JSON.stringify(pack, null, 2));
const check = verifyPack(output); if (!check.ok) throw new Error(check.detail);
fs.writeFileSync(path.join(parent, 'windows-runtime-latest.json'), JSON.stringify({ output }, null, 2));
console.log('Self-contained runtime: ' + output);

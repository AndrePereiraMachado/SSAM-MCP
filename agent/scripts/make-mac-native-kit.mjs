// Explicitly allowlisted development kit. No repository history, server source,
// credentials, captured modules, logs or installed dependencies are copied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyPack } from '../src/main/core/pack-sync.mjs';
import { writeTarGz, verifyTarGz } from './tar-gz.mjs';
import { STUDIO_WINDOW } from './studio-build-plan.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(process.argv[2] ?? path.join(app, 'pack'));
const checked = verifyPack(source);
if (!checked.ok || checked.pack.o11Hook === 'h1') throw new Error('A verified development bridge pack is required');
const parent = path.join(app, '.local/native'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'mac-arm64-kit-'));
function put(relative, bytes) {
  const target = path.join(folder, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
}
function copy(relative) {
  const bytes = fs.readFileSync(path.join(app, relative));
  put(relative, /\.(?:sh|cs|csproj|mjs|jsx|js|css|html|json|yml)$/.test(relative) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes);
}
function tree(relative, allowed) {
  for (const entry of fs.readdirSync(path.join(app, relative), { withFileTypes: true })) {
    if (['bin', 'obj', 'node_modules', '.local'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const name = relative + '/' + entry.name;
    if (entry.isDirectory()) tree(name, allowed); else if (allowed.test(name)) copy(name);
  }
}
tree('native/Ssam.Agent', /\.(cs|csproj)$/);
tree('tests/native-protocol', /\.(cs|csproj)$/);
tree('src', /\.(mjs|jsx|js|css|html)$/);
tree('agent/lib', /\.mjs$/);
tree('agent/tests/fixtures', /\.mjs$/);
tree('assets', /\.(png|ico|icns)$/);
tree('build', /\.(png|ico|icns|plist)$/);
// Include only the projects and linked source files compiled into the local
// bridges. The server/kernel implementation and unrelated projects stay out.
for (const project of ['kernel/src/Anvil.Bridge.Thin/Anvil.Bridge.Thin.csproj', 'kernel/tools/Anvil.RuntimeHook/Anvil.RuntimeHook.csproj', 'platforms/odc/studio/bridge/Bridge.csproj']) {
  copy(project);
  const directory = path.posix.dirname(project);
  const xml = fs.readFileSync(path.join(app, project), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  if (!xml.includes('<EnableDefaultCompileItems>false</EnableDefaultCompileItems>'))
    for (const name of fs.readdirSync(path.join(app, directory))) if (name.endsWith('.cs')) copy(directory + '/' + name);
  for (const match of xml.matchAll(/<Compile\s+Include="([^"]+)"/g)) {
    const pattern = path.posix.normalize(directory + '/' + match[1].replaceAll('\\', '/'));
    if (pattern.startsWith('../') || path.posix.isAbsolute(pattern) || pattern.includes('$')) throw new Error('Unsupported bridge source path: ' + pattern);
    const matches = [...fs.globSync(pattern, { cwd: app })];
    if (!matches.length) throw new Error('Missing bridge source: ' + pattern);
    for (const name of matches) copy(name.replaceAll('\\', '/'));
  }
}
for (const name of ['kernel/Directory.Build.props', 'kernel/Directory.Build.targets', 'platforms/odc/studio/Directory.Build.targets']) copy(name);
for (const name of ['channel', 'workspace', 'studio-policy', 'app-integration', 'studio-build-plan', 'mac-bridge-build']) copy('tests/native/' + name + '.test.mjs');
for (const name of ['build-native.mjs', 'native-pack.mjs', 'build.mjs', 'zip.mjs', 'tar-gz.mjs', 'verify-native-distribution.mjs', 'mac-readiness.sh', 'mac-native-check.sh', 'mac-build-bridges.mjs', 'mac-build-bridges.sh', 'studio-build-plan.mjs']) copy('scripts/' + name);
for (const name of ['package.json', 'package-lock.json', 'electron-builder.yml', 'electron.vite.config.mjs']) copy(name);
const files = [];
for (const file of checked.pack.files) {
  const relative = file.path.replaceAll('\\', '/');
  if (!/^(odc\/studio\/bridge\/bin\/Release\/net8\.0\/|bin\/o11\/(hook|bridge)\/)/.test(relative) || !/\.(dll|json)$/.test(relative)) continue;
  const bytes = fs.readFileSync(path.join(source, relative)); put('runtime-source/' + relative, bytes);
  files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
put('runtime-source/pack.json', JSON.stringify({ id: checked.pack.id + '-mac-test', platform: 'darwin', lanes: checked.pack.lanes, odcBridge: checked.pack.odcBridge,
  o11BuiltFor: checked.pack.o11BuiltFor, o11Hook: 'dev', files }, null, 2) + '\n');
put('BUILD-MAC.txt', `SSAM Agent: Apple Silicon development candidate (not a release)

Prerequisites: Node.js 24, .NET SDK 10, Xcode Command Line Tools.
Open Service Studio and ODC Studio before the read-only report.
From the extracted folder run:
  bash scripts/mac-native-check.sh

The script compiles Native AOT, runs isolated tests and writes mac-report.json.
It does not attach to a Studio, open or publish a module, or use a real credential.
Send the report and any build error to the owner. It includes local Studio paths,
versions and process identifiers, but no session tokens or module contents.

Build window dated ${STUDIO_WINDOW.asOf}:
ODC: ${STUDIO_WINDOW.odc.join(', ')}
Service Studio: ${STUDIO_WINDOW.o11.join(', ')}
Older versions, including ODC 1.7.12, require a Studio update first.
This window lists build targets, not six validated live Mac combinations.

To compile the local bridges against the installed Studios (runtime detected automatically):
  bash scripts/mac-build-bridges.sh
This produces mac-bridge-build.json and mac-bridge-build.log and opens the report
in Finder. It does not attach a bridge or change Studio modules. A successful
report names a new runtime folder containing the matching bridge binaries.
Each lane is checked independently. A failed ODC preflight still allows O11 to be
tested. The coverage table distinguishes untested releases from passing builds.
After updating a Studio, run this script again: local bridges require the exact
Studio build they were compiled against, including the fourth version component.

The runtime-source folder is build input only. Do not package its Windows-built
bridges as a Mac release. Use only the runtime named by a successful local report
for subsequent qualification. No successful build implies live Studio validation.
The archive contains local agent development source for compilation, not server source.
Live Studio attachment, signing and notarization remain unvalidated on macOS.
`);
const archive = folder + '.tar.gz';
writeTarGz(folder, archive);
const problems = verifyTarGz(archive, folder);
if (problems.length) throw new Error(problems.join('\n'));
console.log(JSON.stringify({ folder, archive, bytes: fs.statSync(archive).size, sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') }, null, 2));

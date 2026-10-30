// Builds and qualifies a real Native AOT executable on its target host.
// This creates a qualification artifact, never a production agent package.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateNativeImage } from './native-pack.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const rid = process.argv[2] ?? ({ win32: 'win', darwin: 'osx' }[process.platform] + '-' + process.arch);
const expected = ({ win32: 'win', darwin: 'osx' }[process.platform] + '-' + process.arch);
if (!['win-x64', 'osx-x64', 'osx-arm64'].includes(rid) || rid !== expected)
  throw new Error('Build and qualify on the native target host: win-x64, osx-x64 or osx-arm64');
const project = path.join(app, 'native/Ssam.Agent/Ssam.Agent.csproj');
// Resolve the linker explicitly. This also works from hosts with a reduced PATH,
// where vcvarsall.bat cannot find even the system `where` command.
const publishArgs = ['publish', project, '-c', 'Release', '-r', rid, '--nologo'];
let buildEnv = process.env;
if (process.platform === 'win32') {
  const programFiles = process.env['ProgramFiles(x86)'];
  if (!programFiles) throw new Error('ProgramFiles(x86) is unavailable');
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe');
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
    { encoding: 'utf8', windowsHide: true });
  const visualStudio = found.stdout?.trim();
  if (found.status !== 0 || !visualStudio) throw new Error('Install the Visual Studio Desktop development with C++ workload first');
  const msvcVersion = fs.readFileSync(path.join(visualStudio, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim();
  const msvc = path.join(visualStudio, 'VC/Tools/MSVC', msvcVersion);
  const sdkLib = path.join(programFiles, 'Windows Kits/10/Lib');
  const sdkVersion = fs.readdirSync(sdkLib).filter(name => /^\d+(\.\d+){3}$/.test(name))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .find(name => fs.existsSync(path.join(sdkLib, name, 'um/x64/kernel32.lib')) && fs.existsSync(path.join(sdkLib, name, 'ucrt/x64/ucrt.lib')));
  if (!sdkVersion) throw new Error('Install the Windows SDK C++ libraries first');
  const linker = path.join(msvc, 'bin/Hostx64/x64/link.exe');
  if (!fs.existsSync(linker)) throw new Error('The x64 MSVC linker is missing');
  buildEnv = { ...process.env, LIB: [path.join(msvc, 'lib/x64'), path.join(sdkLib, sdkVersion, 'ucrt/x64'), path.join(sdkLib, sdkVersion, 'um/x64')].join(';') };
  publishArgs.push('-p:IlcUseEnvironmentalTools=true', '-p:CppLinker=' + linker, '-p:CppLibCreator=' + path.join(msvc, 'bin/Hostx64/x64/lib.exe'));
}
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: app, env, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.error?.message ?? result.status})`);
};
run('dotnet', publishArgs, buildEnv);
const filename = 'ssam-agent' + (process.platform === 'win32' ? '.exe' : '');
const executable = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0', rid, 'publish', filename);
const bytes = fs.readFileSync(executable);
validateNativeImage(bytes, process.platform);
if (process.platform === 'win32') {
  // Reject a managed PE, including an IL assembly simply renamed to .exe.
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(pe) !== 0x00004550) throw new Error('Not a PE image');
  const optional = pe + 24;
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Not a 64-bit PE');
  if (bytes.readUInt32LE(optional + 112 + 14 * 8) !== 0) throw new Error('The executable has a CLR header; not Native AOT');
}
const tests = ['tests/native/channel.test.mjs', 'tests/native/workspace.test.mjs', 'tests/native/studio-policy.test.mjs', 'tests/native/app-integration.test.mjs', 'tests/native/studio-build-plan.test.mjs', 'tests/native/mac-bridge-build.test.mjs'];
run(process.execPath, ['--test', ...tests], { ...process.env, SSAM_NATIVE_EXE: executable });
run('dotnet', ['test', path.join(app, 'tests/native-protocol/NativeProtocol.Tests.csproj'), '-c', 'Release', '--nologo']);

// Fresh staging: never copy a publish directory wholesale (it may contain PDBs or build leftovers).
const artifacts = path.join(app, '.local/native');
fs.mkdirSync(artifacts, { recursive: true });
const staging = fs.mkdtempSync(path.join(artifacts, rid + '-'));
fs.copyFileSync(executable, path.join(staging, filename));
if (process.platform !== 'win32') fs.chmodSync(path.join(staging, filename), 0o755);
const receipt = {
  schema: 'ssam-native-qualification/1', rid, runtime: 'native-aot', productionReady: false,
  testedAt: new Date().toISOString(), tests,
  files: [{ path: filename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
};
fs.writeFileSync(path.join(staging, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log('Qualified native artifact (not a production package): ' + staging);

// agent/r4-v106 (A6 of the U1 follow-ups): server/scripts/odc-runtime-signing.ps1 -Mode Prepare signs one bridge per ODC Studio
// runtime. Without -Runtime it keeps Bridge.csproj's own OdcBridgeRuntime (net10.0: the client's Version, v106, from
// bin\Release\net10.0); -Runtime net8.0 takes the client's EarlierVersion (v107) from bin\Release\net8.0. prepared.json records
// the runtime and a later mode for another runtime is refused. The script runs from a copy of the box with fake outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (file, content = path.basename(file)) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, content); };

test('A6: the vigia box signs v106 for net10 (Bridge.csproj default) and v107 for net8 (-Runtime net8.0), each recorded with its runtime', {skip: process.platform !== 'win32' && 'PowerShell'}, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const root = path.join(work, 's'); // short: Windows PowerShell 5.1 copies under MAX_PATH
  write(path.join(root, 'scripts', 'odc-runtime-signing.ps1'), fs.readFileSync(path.join(here, '..', '..', 'scripts', 'odc-runtime-signing.ps1')));
  const bridge = path.join(root, 'platforms', 'odc', 'studio', 'bridge');
  write(path.join(bridge, 'Bridge.csproj'), '<Project><PropertyGroup><OdcBridgeRuntime>net10.0</OdcBridgeRuntime><OdcBridgeRuntime Condition="\'$(TargetFramework)\' == \'net8.0\'">net8.0</OdcBridgeRuntime></PropertyGroup></Project>');
  write(path.join(bridge, 'client', 'Program.cs'), 'const string Version = "v106";\nconst string EarlierVersion = "v107";\n');
  for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll'])
    write(path.join(bridge, 'client', 'bin', 'Release', 'net10.0', name));
  write(path.join(bridge, 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v107.dll'), 'net8 v107');
  write(path.join(bridge, 'bin', 'Release', 'net10.0', 'ODC3.Bridge.v106.dll'), 'net10 v106');
  const sign = args => {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'odc-runtime-signing.ps1'), ...args], {encoding: 'utf8', windowsHide: true, timeout: 120000});
    return {code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '')};
  };
  const ids = {};
  for (const [args, version, runtime] of [[[], 'v106', 'net10.0'], [['-Runtime', 'net8.0'], 'v107', 'net8.0']]) {
    const r = sign(['-Mode', 'Prepare', ...args]);
    assert.equal(r.code, 0, r.out);
    const answer = JSON.parse(r.out);
    assert.deepEqual([answer.version, answer.runtime], [version, runtime]);
    assert.deepEqual(fs.readdirSync(path.join(answer.directory, 'bridge')), ['ODC3.Bridge.' + version + '.dll']);
    ids[runtime] = answer.bundleId;
  }
  const wrong = sign(['-Mode', 'Verify', '-BundleId', ids['net8.0'], '-Runtime', 'net10.0']);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.out, /was prepared for net8\.0, not net10\.0/);
  const own = sign(['-Mode', 'Verify', '-BundleId', ids['net8.0']]);
  assert.match(own.out, /Signature not valid/);
  assert.doesNotMatch(own.out, /identity\/protocol differs/);
});

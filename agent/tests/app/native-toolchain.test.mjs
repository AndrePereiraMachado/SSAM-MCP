// Review M3 of agent/mac-028: scripts/check-native-toolchain.mjs stops the Mac release on an SDK older than 10.0.403 or a Native
// AOT restore whose ILCompiler or runtime packs are older than 10.0.14 (GHSA-p3jp-9v83-76w9, the Brotli decoder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sdkProblem, assetsProblems, MIN_SDK, MIN_RUNTIME } from '../../scripts/check-native-toolchain.mjs';

const script = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'check-native-toolchain.mjs');
// The shape of obj/project.assets.json after dotnet publish -r osx-arm64 of a PublishAot project.
const assets = version => ({
  libraries: { [`Microsoft.DotNet.ILCompiler/${version}`]: {}, [`runtime.osx-arm64.Microsoft.DotNet.ILCompiler/${version}`]: {}, 'System.Text.Json/10.0.0': {} },
  project: { frameworks: { 'net10.0': { downloadDependencies: [
    { name: 'Microsoft.NETCore.App.Runtime.NativeAOT.osx-arm64', version: `[${version}, ${version}]` },
    { name: 'Microsoft.NETCore.App.Runtime.osx-arm64', version: `[${version}, ${version}]` },
    { name: 'Microsoft.AspNetCore.App.Runtime.osx-arm64', version: '[10.0.0, 10.0.0]' }] } } },
});

test('the SDK floor is 10.0.403 and the runtime floor 10.0.14', () => {
  assert.equal(MIN_SDK, '10.0.403'); assert.equal(MIN_RUNTIME, '10.0.14');
  assert.equal(sdkProblem('10.0.403'), null); assert.equal(sdkProblem('10.0.500'), null); assert.equal(sdkProblem('11.0.100'), null);
  assert.match(sdkProblem('10.0.401'), /older than 10\.0\.403/);
  assert.match(sdkProblem('10.0.114'), /older than 10\.0\.403/);
  assert.match(sdkProblem(''), /not readable/);
});

test('the restore of the Native AOT core: every ILCompiler and runtime pack at least 10.0.14, all present for the rid', () => {
  assert.deepEqual(assetsProblems(assets('10.0.14'), { rid: 'osx-arm64' }).problems, []);
  assert.deepEqual(assetsProblems(assets('10.0.15'), { rid: 'osx-arm64' }).problems, []);
  const old = assetsProblems(assets('10.0.12'), { rid: 'osx-arm64' }).problems;
  assert.equal(old.length, 4);
  assert.ok(old.every(p => /10\.0\.12 is older than 10\.0\.14/.test(p)));
  assert.match(assetsProblems({ libraries: {}, project: { frameworks: {} } }, { rid: 'osx-arm64' }).problems.join(';'), /Microsoft\.DotNet\.ILCompiler is not in the restore/);
  // A win-x64 restore is not the Mac one.
  const win = JSON.parse(JSON.stringify(assets('10.0.14')).replace(/osx-arm64/g, 'win-x64'));
  assert.equal(assetsProblems(win, { rid: 'osx-arm64' }).problems.length, 2);
});

test('the command line fails with ::error:: lines and passes with a patched toolchain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-toolchain-'));
  try {
    const file = path.join(dir, 'project.assets.json');
    fs.writeFileSync(file, JSON.stringify(assets('10.0.12')));
    const bad = spawnSync(process.execPath, [script, '--sdk', '10.0.401', '--assets', file, '--rid', 'osx-arm64'], { encoding: 'utf8' });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /::error::the \.NET SDK is 10\.0\.401/); assert.match(bad.stderr, /::error::Microsoft\.DotNet\.ILCompiler 10\.0\.12/);
    fs.writeFileSync(file, JSON.stringify(assets('10.0.14')));
    const good = spawnSync(process.execPath, [script, '--sdk', '10.0.403', '--assets', file, '--rid', 'osx-arm64'], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).ok, true);
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

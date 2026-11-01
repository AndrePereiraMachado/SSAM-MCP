// agent/r4-v106 (A6 of the U1 follow-ups): scripts/odc-runtime-signing.ps1 prepares one bundle per ODC Studio runtime: net8.0
// (the default of this box) takes the bridge the client names EarlierVersion (v107) from bin\Release\net8.0, net10.0 its Version
// (v106) from bin\Release\net10.0. prepared.json records the runtime, and a later mode for another runtime is refused before any
// signature is read. Prepare only copies built files and hashes them: the script runs from a copy of the box with fake outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const write = (file, content = path.basename(file)) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

function box(work) {
  const root = path.join(work, 'box');
  write(path.join(root, 'scripts', 'odc-runtime-signing.ps1'), fs.readFileSync(path.join(repo, 'scripts', 'odc-runtime-signing.ps1')));
  const bridge = path.join(root, 'platforms', 'odc', 'studio', 'bridge');
  write(path.join(bridge, 'client', 'Program.cs'), 'const string Version = "v106";\nconst string EarlierVersion = "v107";\n');
  for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll'])
    write(path.join(bridge, 'client', 'bin', 'Release', 'net10.0', name));
  write(path.join(bridge, 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v107.dll'), 'net8 v107');
  write(path.join(bridge, 'bin', 'Release', 'net10.0', 'ODC3.Bridge.v106.dll'), 'net10 v106');
  return root;
}
const sign = (root, args) => {
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'odc-runtime-signing.ps1'), ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: run.status, out: (run.stdout ?? '') + (run.stderr ?? '') };
};

test('A6: one bundle per runtime, v107 for net8 (the default) and v106 for net10; another runtime than the one prepared is refused', { skip: process.platform !== 'win32' && 'PowerShell' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-signing-runtime-'));
  try {
    const root = box(work);
    const bundles = {};
    for (const [args, version, runtime] of [[[], 'v107', 'net8.0'], [['-Runtime', 'net8.0'], 'v107', 'net8.0'], [['-Runtime', 'net10.0'], 'v106', 'net10.0']]) {
      const result = sign(root, ['-Mode', 'Prepare', ...args]);
      assert.equal(result.code, 0, result.out);
      const answer = JSON.parse(result.out);
      assert.deepEqual([answer.version, answer.runtime, answer.state], [version, runtime, 'awaiting_signature']);
      const prepared = JSON.parse(fs.readFileSync(path.join(answer.directory, 'prepared.json'), 'utf8').replace(/^﻿/, ''));
      assert.deepEqual([prepared.version, prepared.runtime], [version, runtime]);
      assert.deepEqual(fs.readdirSync(path.join(answer.directory, 'bridge')), ['ODC3.Bridge.' + version + '.dll']);
      assert.equal(fs.readFileSync(path.join(answer.directory, 'bridge', 'ODC3.Bridge.' + version + '.dll'), 'utf8'), runtime === 'net8.0' ? 'net8 v107' : 'net10 v106');
      bundles[runtime] = answer.bundleId;
    }
    // Verify of the net10 bundle as net8: refused by its identity, before any signature is read.
    const wrong = sign(root, ['-Mode', 'Verify', '-BundleId', bundles['net10.0'], '-Runtime', 'net8.0']);
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.out, /was prepared for net10\.0, not net8\.0/);
    // Verify of its own runtime passes the identity and stops at the signature (these fakes are not signed).
    const own = sign(root, ['-Mode', 'Verify', '-BundleId', bundles['net10.0']]);
    assert.notEqual(own.code, 0);
    assert.match(own.out, /Signature not valid/);
    assert.doesNotMatch(own.out, /identity\/protocol differs/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

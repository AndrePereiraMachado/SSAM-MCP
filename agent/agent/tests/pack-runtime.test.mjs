// agent/r4-v106 (A7 of the U1 follow-ups): one source, two ODC bridges, v107 for the net8 ODC Studios and v106 for the net10
// ones, and agent-pack.ps1 carries the one of the runtime it is asked for: by default net8 (EarlierVersion of the client, from
// bin\Release\net8.0), with -OdcRuntime net10.0 the client's Version from bin\Release\net10.0. pack.json says the runtime the
// bridge was built for (odcRuntime, from its .deps.json); an older build output in the same folder never goes, and a bridge whose
// .deps.json names another runtime than -OdcRuntime refuses the pack. The script runs from a copy of the box (scripts, agent
// code, the customer guide, the client source and fake build outputs): nothing of the checkout's own bin folders is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const write = (file, content = path.basename(file)) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const deps = tfm => JSON.stringify({ runtimeTarget: { name: '.NETCoreApp,Version=v' + tfm.slice(3) } });

function readZip(file) {
  const zip = fs.readFileSync(file), end = zip.length - 22, entries = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    entries.set(name, method === 8 ? zlib.inflateRawSync(zip.subarray(data, data + size)) : Buffer.from(zip.subarray(data, data + size)));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

// A copy of the box with the client of v106/v107 and the build outputs of both runtimes (and an older v102 next to v107).
function box(work) {
  const root = path.join(work, 'box');
  for (const name of ['agent-pack.ps1', 'pack-ip-scan.ps1', 'release/client-content.json']) copy(path.join(repo, 'scripts', name), path.join(root, 'scripts', name));
  for (const name of ['ssam-agent.mjs', 'ssam-agent.ps1']) copy(path.join(repo, 'agent', name), path.join(root, 'agent', name));
  for (const name of fs.readdirSync(path.join(repo, 'agent', 'lib'))) if (/\.(mjs|json|ps1)$/.test(name)) copy(path.join(repo, 'agent', 'lib', name), path.join(root, 'agent', 'lib', name));
  copy(path.join(repo, 'docs', 'AGENTE-CLIENTE.md'), path.join(root, 'docs', 'AGENTE-CLIENTE.md'));
  const bridge = path.join(root, 'platforms', 'odc', 'studio', 'bridge');
  write(path.join(bridge, 'client', 'Program.cs'), 'const string Version = "v106";\nconst string EarlierVersion = "v107";\n');
  for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll'])
    write(path.join(bridge, 'client', 'bin', 'Release', 'net10.0', name));
  write(path.join(bridge, 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v107.dll'), 'net8 v107');
  write(path.join(bridge, 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v107.deps.json'), deps('net8.0'));
  write(path.join(bridge, 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v102.dll'), 'an older build output');
  write(path.join(bridge, 'bin', 'Release', 'net10.0', 'ODC3.Bridge.v106.dll'), 'net10 v106');
  write(path.join(bridge, 'bin', 'Release', 'net10.0', 'ODC3.Bridge.v106.deps.json'), deps('net10.0'));
  return root;
}
function pack(root, args) {
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'agent-pack.ps1'), ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (run.error) throw run.error;
  return { code: run.status, out: ((run.stdout ?? '') + (run.stderr ?? '')).replace(/\r?\n/g, '') };
}
const LAYOUT = 'odc/studio/bridge/bin/Release/net8.0/';

test('A7: the pack carries the ODC bridge of the runtime it is asked for: v107 (net8) by default, v106 with -OdcRuntime net10.0', { skip: process.platform !== 'win32' && 'PowerShell pack' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-pack-runtime-'));
  try {
    const root = box(work);
    for (const [args, version, runtime, bytes] of [[[], 'v107', 'net8.0', 'net8 v107'], [['-OdcRuntime', 'net8.0'], 'v107', 'net8.0', 'net8 v107'], [['-OdcRuntime', 'net10.0'], 'v106', 'net10.0', 'net10 v106']]) {
      const zip = path.join(work, 'out-' + version + '-' + args.length, 'ssam-agent.zip');
      const result = pack(root, ['-Out', zip, '-Lanes', 'odc', '-NoNode', ...args]);
      assert.equal(result.code, 0, result.out);
      const entries = readZip(zip);
      const bridges = [...entries.keys()].filter(n => /ODC3\.Bridge\.v\d+\./.test(n)).sort();
      // The pack's layout folder stays the one every agent reads (net8.0); pack.json says what runtime the bridge is for.
      assert.deepEqual(bridges, [LAYOUT + 'ODC3.Bridge.' + version + '.deps.json', LAYOUT + 'ODC3.Bridge.' + version + '.dll'], JSON.stringify(args));
      assert.equal(entries.get(LAYOUT + 'ODC3.Bridge.' + version + '.dll').toString(), bytes);
      const manifest = JSON.parse(entries.get('pack.json').toString('utf8').replace(/^﻿/, ''));
      assert.equal(manifest.odcBridge, version);
      assert.equal(manifest.odcRuntime, runtime);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('A7: a bridge whose .deps.json names another runtime than -OdcRuntime refuses the pack (no ZIP)', { skip: process.platform !== 'win32' && 'PowerShell pack' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-pack-runtime-'));
  try {
    const prebuilt = path.join(work, 'prebuilt');
    write(path.join(prebuilt, 'odc', 'bridge', 'ODC3.Bridge.v106.dll'), 'net10 v106');
    write(path.join(prebuilt, 'odc', 'bridge', 'ODC3.Bridge.v106.deps.json'), deps('net10.0'));
    for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll'])
      write(path.join(prebuilt, 'odc', 'client', name));
    const zip = path.join(work, 'refused', 'ssam-agent.zip');
    const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'agent-pack.ps1'),
      '-Out', zip, '-Lanes', 'odc', '-NoNode', '-NoBuild', '-Prebuilt', prebuilt, '-OdcRuntime', 'net8.0'], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.notEqual(run.status, 0);
    assert.match((run.stdout + run.stderr).replace(/\r?\n/g, ''), /net10\.0, nao para -OdcRuntime net8\.0/);
    assert.equal(fs.existsSync(zip), false);
    // The same prebuilt without -OdcRuntime: the pack says net10.0, read from the bridge itself.
    const ok = path.join(work, 'ok', 'ssam-agent.zip');
    const fine = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'agent-pack.ps1'),
      '-Out', ok, '-Lanes', 'odc', '-NoNode', '-NoBuild', '-Prebuilt', prebuilt], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.equal(fine.status, 0, fine.stdout + fine.stderr);
    const manifest = JSON.parse(readZip(ok).get('pack.json').toString('utf8').replace(/^﻿/, ''));
    assert.deepEqual([manifest.odcBridge, manifest.odcRuntime], ['v106', 'net10.0']);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

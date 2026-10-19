// scripts/agent-pack.ps1 -Platform mac -NoBuild -Prebuilt <fake tree>: the exact file list of ssam-agent-mac.tar.gz (the
// same bridges and hook, no .exe, no .ps1, no .NET client, no Anvil.Connect, no source), 0755 for install.sh and
// agent/ssam-agent.sh, a pack.json without null values with platform darwin, the Node pin of scripts/node-darwin.json and
// the sha256 of every file; the archive read by the system tar; the IP scan over the tree read back from the archive;
// the refusals of the options a macOS pack does not take; every text file in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const box = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The archive as scripts/tar-gz.mjs reads it (run as a process: nothing of agent/ imports from outside it): entries
// {name, type, mode, size, data}, the data from a fresh extraction.
function readTarGz(file) {
  const tool = path.join(box, 'scripts', 'tar-gz.mjs');
  const list = spawnSync(process.execPath, [tool, 'list', file], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-mac-pack-x-'));
  fs.rmSync(dir, { recursive: true });
  const extract = spawnSync(process.execPath, [tool, 'extract', file, dir], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stdout + extract.stderr);
  try {
    return list.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).map(e => ({ ...e, mode: parseInt(e.mode, 8),
      data: e.type === 'file' ? fs.readFileSync(path.join(dir, ...e.name.split('/'))) : null }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const script = path.join(box, 'scripts', 'agent-pack.ps1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, content = path.basename(file)) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

function pack(args) {
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, SSAM_NODE: process.execPath } });
  if (run.error) throw run.error;
  return { code: run.status, out: ((run.stdout ?? '') + (run.stderr ?? '')).replace(/\r?\n/g, '') };
}
// The prebuilt layout of the Windows pack (as prep-pack.ps1 lays it out), with the .exe and the client the macOS pack
// must leave out.
function fakePrebuilt(dir, { kernelText = false } = {}) {
  for (const name of ['ODC3.Bridge.v97.dll', 'ODC3.Bridge.v97.deps.json']) write(path.join(dir, 'odc', 'bridge', name), kernelText && name.endsWith('.dll') ? 'uses Anvil.Core.Kernel' : name);
  for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.exe', 'ODC3.Bridge.Client.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll']) write(path.join(dir, 'odc', 'client', name));
  for (const name of ['Anvil.Connect.dll', 'Anvil.Connect.exe', 'Microsoft.Diagnostics.NETCore.Client.dll']) write(path.join(dir, 'o11', 'connect', name));
  for (const name of ['Anvil.RuntimeHook.Agent.dll', 'Anvil.RuntimeHook.Agent.deps.json']) write(path.join(dir, 'o11', 'hook', name));
  for (const name of ['Anvil.Bridge.dll', 'Anvil.Bridge.deps.json']) write(path.join(dir, 'o11', 'bridge', name));
  write(path.join(dir, 'o11', 'built-for.txt'), '11.55.92\r\n');
}

test('agent-pack.ps1 -Platform mac: the exact tar.gz, its modes, pack.json (no null, darwin, Node pin, sha256 of each file), read by the system tar', { skip: process.platform !== 'win32' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-mac-pack-'));
  try {
    fakePrebuilt(path.join(work, 'prebuilt'));
    const out = path.join(work, 'out', 'ssam-agent-mac.tar.gz');
    const result = pack(['-Out', out, '-Lanes', 'odc,o11', '-NoBuild', '-Prebuilt', path.join(work, 'prebuilt'), '-Platform', 'mac']);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /macOS/);
    const entries = readTarGz(out);
    const files = entries.filter(e => e.type === 'file');
    const names = files.map(e => e.name).sort();
    const lib = fs.readdirSync(path.join(box, 'agent', 'lib')).filter(n => n.endsWith('.mjs')).map(n => 'agent/lib/' + n);
    assert.deepEqual(names, [...lib, 'agent/ssam-agent.mjs', 'agent/ssam-agent.sh', 'bin/o11/bridge/Anvil.Bridge.deps.json', 'bin/o11/bridge/Anvil.Bridge.dll',
      'bin/o11/hook/Anvil.RuntimeHook.Agent.deps.json', 'bin/o11/hook/Anvil.RuntimeHook.Agent.dll', 'docs/AGENTE-CLIENTE.md', 'docs/AGENTE-MAC.md', 'install.sh', 'odc/README.md',
      'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.deps.json', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll', 'pack.json'].sort());
    assert.ok(entries.every(e => e.type === 'file' || e.type === 'dir'));
    for (const e of entries) assert.equal(e.mode, e.type === 'dir' || /\.sh$/.test(e.name) ? 0o755 : 0o644, e.name);
    for (const e of files) assert.equal(/\.(exe|ps1|cs|csproj|pdb|key)$/i.test(e.name) || /^odc\/studio\/bridge\/client\/|^bin\/o11\/connect\/|^agent\/node\//i.test(e.name), false, e.name);
    // The shipped bytes are the box's own (agent code, scripts, guides), with LF line ends (review B2).
    const lf = bytes => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    for (const rel of ['agent/ssam-agent.sh', 'agent/ssam-agent.mjs', 'docs/AGENTE-MAC.md', 'docs/AGENTE-CLIENTE.md']) assert.equal(sha(files.find(e => e.name === rel).data), sha(lf(fs.readFileSync(path.join(box, ...rel.split('/'))))), rel);
    assert.equal(sha(files.find(e => e.name === 'install.sh').data), sha(fs.readFileSync(path.join(box, 'agent', 'install.sh'))));
    const packText = files.find(e => e.name === 'pack.json').data.toString('utf8').replace(/^﻿/, '');
    assert.equal(/\bnull\b/.test(packText), false, 'no null in pack.json');
    const packJson = JSON.parse(packText);
    const pin = JSON.parse(fs.readFileSync(path.join(box, 'scripts', 'node-darwin.json'), 'utf8'));
    assert.equal(packJson.platform, 'darwin'); assert.deepEqual(packJson.lanes, ['odc', 'o11']); assert.equal(packJson.odcBridge, 'v97');
    assert.equal(packJson.o11BuiltFor, '11.55.92'); assert.equal(packJson.o11Hook, 'dev');
    assert.deepEqual(packJson.node, { version: pin.version, source: pin.source, arm64: pin.arm64, x64: pin.x64 });
    assert.equal(packJson.o11Bridge.sha256, sha(files.find(e => e.name === 'bin/o11/bridge/Anvil.Bridge.dll').data));
    assert.deepEqual(packJson.files.map(f => f.path).sort(), names.filter(n => n !== 'pack.json'));
    for (const f of packJson.files) { const e = files.find(x => x.name === f.path); assert.equal(f.sha256, sha(e.data), f.path); assert.equal(f.size, e.data.length, f.path); }
    // The tar of Windows (bsdtar, the family of the macOS tar) and the GNU tar of Git Bash read it and show the modes.
    const msys = file => file.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');
    const readers = [['C:\\Windows\\System32\\tar.exe', ['-tzvf', out]], ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', ['-c', `tar -tzvf "${msys(out)}"`]]].filter(([file]) => fs.existsSync(file));
    assert.ok(readers.length > 0, 'a tar to read the archive');
    for (const [file, args] of readers) {
      const listing = spawnSync(file, args, { encoding: 'utf8' });
      assert.equal(listing.status, 0, file + ': ' + listing.stderr);
      assert.match(listing.stdout, /-rwxr-xr-x .*install\.sh/, file);
      assert.match(listing.stdout, /-rwxr-xr-x .*agent\/ssam-agent\.sh/, file);
      assert.match(listing.stdout, /-rw-r--r-- .*pack\.json/, file);
    }
    // English: every text file the person receives.
    const found = files.filter(e => !/\.dll$/.test(e.name)).flatMap(e => { const f = portugueseIn(e.data.toString('utf8'), { allow: e.name === 'agent/lib/workspace.mjs' ? ['|com[0-9¹²³]|'] : [] }); return f.length ? [describe('ssam-agent-mac.tar.gz/' + e.name, f)] : []; });
    assert.equal(found.join('\n'), '', 'Portuguese the customer would see');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('agent-pack.ps1 -Platform mac: an IP finding in the tree read back deletes the archive; the options a macOS pack does not take are refused', { skip: process.platform !== 'win32' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-mac-pack-bad-'));
  try {
    fakePrebuilt(path.join(work, 'kernel'), { kernelText: true });
    const out = path.join(work, 'out', 'ssam-agent-mac.tar.gz');
    const found = pack(['-Out', out, '-Lanes', 'odc,o11', '-NoBuild', '-Prebuilt', path.join(work, 'kernel'), '-Platform', 'mac']);
    assert.notEqual(found.code, 0);
    assert.match(found.out, /Varredura de PI falhou: odc\/studio\/bridge\/bin\/Release\/net8\.0\/ODC3\.Bridge\.v97\.dll \(kernel-text\)/);
    assert.equal(fs.existsSync(out), false, 'no archive is left');
    fakePrebuilt(path.join(work, 'ok'));
    for (const [args, pattern] of [[['-Hook', 'h1', '-HookH1', work], /gancho dev/], [['-NodeExe', process.execPath], /nao leva node\.exe/]]) {
      const refused = pack(['-Out', out, '-Lanes', 'odc,o11', '-NoBuild', '-Prebuilt', path.join(work, 'ok'), '-Platform', 'mac', ...args]);
      assert.notEqual(refused.code, 0); assert.match(refused.out, pattern);
    }
    const zip = pack(['-Out', path.join(work, 'out', 'x.zip'), '-Lanes', 'odc', '-NoBuild', '-Prebuilt', path.join(work, 'ok'), '-Platform', 'mac']);
    assert.notEqual(zip.code, 0); assert.match(zip.out, /escreve um \.tar\.gz/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// Review B2: the guides of docs/ have no eol attribute, so a checkout with core.autocrlf gives them CRLF and the tar came
// out different from one checkout to another. The macOS pack writes every text file with LF: a CRLF copy of the box gives
// the same bytes as an LF one.
test('agent-pack.ps1 -Platform mac: text files go with LF whatever the checkout, so a CRLF checkout gives the same files', { skip: process.platform !== 'win32' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-mac-pack-eol-'));
  try {
    fakePrebuilt(path.join(work, 'prebuilt'));
    // A copy of the box as a CRLF checkout would write it: the guides and the scripts' JSON with CRLF.
    const copy = path.join(work, 'box');
    fs.cpSync(path.join(box, 'agent'), path.join(copy, 'agent'), { recursive: true, filter: source => !/[\\/]tests([\\/]|$)/.test(path.relative(box, source)) });
    fs.cpSync(path.join(box, 'scripts'), path.join(copy, 'scripts'), { recursive: true });
    for (const name of ['AGENTE-CLIENTE.md', 'AGENTE-MAC.md']) write(path.join(copy, 'docs', name), fs.readFileSync(path.join(box, 'docs', name), 'utf8').replace(/\r?\n/g, '\r\n'));
    const tars = {};
    for (const [label, script] of [['lf', path.join(box, 'scripts', 'agent-pack.ps1')], ['crlf', path.join(copy, 'scripts', 'agent-pack.ps1')]]) {
      const out = path.join(work, label, 'ssam-agent-mac.tar.gz');
      const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out, '-Lanes', 'odc,o11', '-NoBuild', '-Prebuilt', path.join(work, 'prebuilt'), '-Platform', 'mac'],
        { encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, SSAM_NODE: process.execPath } });
      assert.equal(run.status, 0, label + ': ' + run.stdout + run.stderr);
      tars[label] = readTarGz(out).filter(e => e.type === 'file');
    }
    for (const e of tars.crlf) {
      // The text of the box and pack.json; a .deps.json is a file of the prebuilt and keeps its bytes.
      if (/\.(md|mjs|sh)$/.test(e.name) || e.name === 'pack.json') assert.equal(e.data.includes(0x0d), false, e.name + ' has a CR');
      if (e.name === 'pack.json') continue;
      const twin = tars.lf.find(x => x.name === e.name);
      assert.ok(twin, e.name);
      assert.equal(sha(e.data), sha(twin.data), e.name + ': the same bytes from both checkouts');
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

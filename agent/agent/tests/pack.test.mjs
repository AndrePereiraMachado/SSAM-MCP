// scripts/agent-pack.ps1 -NoBuild -Prebuilt <fake tree>: the 6.2 layout with the thin O11 bridge only, pack.json with the
// right sha256 of every file, nothing forbidden inside (no source, no .local\server, no key, no OutSystems DLL, no agent
// tests), the intellectual property scan of scripts/pack-ip-scan.ps1 over the finished ZIP (docs/O11-BRIDGE-FINA.md 6.4)
// and node.exe only with its license (6.3). Calls that do not test Node pass -NoNode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repo, 'scripts', 'agent-pack.ps1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, content = path.basename(file)) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const utf16 = text => Buffer.from(text, 'utf16le');

// One agent-pack.ps1 run: {code, out} with stdout and stderr together (warnings and errors). Windows PowerShell wraps
// long messages at its buffer width (keeping the space where it breaks between words), so line breaks are removed.
function pack(args, env = {}) {
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, ...env } });
  if (run.error) throw run.error;
  return { code: run.status, out: ((run.stdout ?? '') + (run.stderr ?? '')).replace(/\r?\n/g, '') };
}

// The entries of a ZIP as agent-pack.ps1 writes it (stored or deflated, no zip64, no comment): Map name -> bytes.
function readZip(file) {
  const zip = fs.readFileSync(file);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'end of central directory');
  const entries = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, 'central directory entry');
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(data, data + size);
    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

function fakePrebuilt(dir) {
  for (const name of ['ODC3.Bridge.v35.dll', 'ODC3.Bridge.v35.deps.json', 'ODC3.Bridge.v35.pdb', 'StartupHook.cs']) write(path.join(dir, 'odc', 'bridge', name));
  for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll'])
    write(path.join(dir, 'odc', 'client', name));
  for (const name of ['Anvil.Connect.dll', 'Anvil.Connect.runtimeconfig.json', 'Microsoft.Diagnostics.NETCore.Client.dll', 'Anvil.Connect.csproj']) write(path.join(dir, 'o11', 'connect', name));
  write(path.join(dir, 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'));
  // The thin bridge, and what never goes into a pack (left out with a warning).
  for (const name of ['Anvil.Bridge.dll', 'Anvil.Bridge.deps.json', 'Anvil.Bridge.pdb', 'bridge.key', 'OutSystems.Model.V1.dll', 'ServiceStudio.Framework.dll', 'Program.cs'])
    write(path.join(dir, 'o11', 'bridge', name));
  write(path.join(dir, 'o11', 'bridge', '.local', 'server', 'tokens.json'), '{"tokens":[]}');
  write(path.join(dir, 'o11', 'built-for.txt'), '11.55.91\r\n');
}

const THIN = 'bin/o11/bridge/Anvil.Bridge.dll';
const CONNECT = 'bin/o11/connect/Anvil.Connect.dll';
const HOOK = 'bin/o11/hook/Anvil.RuntimeHook.Agent.dll';
const ODC_BRIDGE = 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v35.dll';
const ODC_CLIENT = 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll';
const ODC_DIAG = 'odc/studio/bridge/client/bin/Release/net10.0/Microsoft.Diagnostics.NETCore.Client.dll';
// Pack entry -> file of the fake prebuilt tree.
const source = (prebuilt, entry) => path.join(prebuilt, ...({ [THIN]: 'o11/bridge/Anvil.Bridge.dll', [CONNECT]: 'o11/connect/Anvil.Connect.dll',
  [HOOK]: 'o11/hook/Anvil.RuntimeHook.Agent.dll', [ODC_BRIDGE]: 'odc/bridge/ODC3.Bridge.v35.dll', [ODC_CLIENT]: 'odc/client/ODC3.Bridge.Client.dll',
  [ODC_DIAG]: 'odc/client/Microsoft.Diagnostics.NETCore.Client.dll' }[entry]).split('/'));

// A fake prebuilt tree changed by edit(prebuilt), packed with -NoNode unless args say otherwise: {code, out, zip, work}.
function packWith(work, edit = () => {}, args = ['-NoNode'], env = {}) {
  const prebuilt = path.join(work, 'prebuilt-' + Math.random().toString(16).slice(2));
  fakePrebuilt(prebuilt);
  edit(prebuilt);
  const zip = path.join(work, 'out-' + path.basename(prebuilt), 'ssam-agent.zip');
  return { ...pack(['-Out', zip, '-Lanes', 'odc,o11', '-NoBuild', '-Prebuilt', prebuilt, ...args], env), zip };
}

function refusedByScan(result, entries) {
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /Varredura de PI falhou: /, result.out);
  for (const [entry, rule] of entries) assert.ok(result.out.includes(`${entry} (${rule})`), `${entry} (${rule}) in: ${result.out}`);
  assert.equal(fs.existsSync(result.zip), false, 'no ZIP is left after a refusal');
}

const tempWork = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-pack-test-'));

test('agent-pack.ps1 -NoBuild -Prebuilt -NoNode builds the 6.2 layout with the thin bridge only and a correct pack.json', () => {
  const work = tempWork();
  try {
    const result = packWith(work);
    assert.equal(result.code, 0, result.out);
    const entries = readZip(result.zip);
    const files = [...entries.keys()].sort();
    assert.ok(files.every(name => !name.includes('\\')), 'zip entries use forward slashes');

    const libs = fs.readdirSync(path.join(repo, 'agent', 'lib')).filter(name => name.endsWith('.mjs')).map(name => 'agent/lib/' + name);
    const expected = ['agent/ssam-agent.mjs', 'agent/ssam-agent.ps1', ...libs,
      'bin/o11/bridge/Anvil.Bridge.deps.json', THIN,
      CONNECT, 'bin/o11/connect/Anvil.Connect.runtimeconfig.json', 'bin/o11/connect/Microsoft.Diagnostics.NETCore.Client.dll', HOOK,
      'docs/AGENTE-CLIENTE.md',
      'odc/README.md', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v35.deps.json', ODC_BRIDGE,
      ODC_DIAG, 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.deps.json',
      ODC_CLIENT, 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.runtimeconfig.json',
      'pack.json'].sort();
    assert.deepEqual(files, expected);
    for (const file of files) {
      assert.doesNotMatch(file, /\.(cs|csproj|pdb|key)$|(^|\/)\.local\/|tokens\.json|OutSystems\.|ServiceStudio\.|^agent\/tests\/|^agent\/node\//, file);
      if (file.endsWith('.mjs')) assert.match(file, /^agent\//);
    }
    // The agent code and the customer guide in the pack are the repository's, byte for byte.
    for (const file of files.filter(f => f.startsWith('agent/') || f.startsWith('docs/'))) assert.equal(sha(entries.get(file)), sha(fs.readFileSync(path.join(repo, file))), file);

    const manifest = JSON.parse(entries.get('pack.json').toString('utf8').replace(/^﻿/, ''));
    assert.match(manifest.id, /^pack-\d{8}-\d{6}$/);
    assert.deepEqual(manifest.lanes, ['odc', 'o11']);
    assert.equal(manifest.odcBridge, 'v35');
    assert.equal(manifest.o11BuiltFor, '11.55.91');
    // The development hook; the bridge the agent checks after the attach (its sha256 against bridge_manifest).
    assert.equal(manifest.o11Hook, 'dev');
    assert.deepEqual(manifest.o11Bridge, { id: null, hookAbi: null, path: THIN, sha256: sha(entries.get(THIN)) });
    assert.deepEqual(manifest.files.map(f => f.path).sort(), expected.filter(f => f !== 'pack.json'));
    for (const entry of manifest.files) {
      assert.equal(entry.sha256, sha(entries.get(entry.path)), entry.path);
      assert.equal(entry.size, entries.get(entry.path).length, entry.path);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('agent-pack.ps1 -Lanes odc leaves the O11 binaries out', () => {
  const work = tempWork();
  try {
    const prebuilt = path.join(work, 'prebuilt');
    fakePrebuilt(prebuilt);
    const zip = path.join(work, 'ssam-agent-odc.zip');
    const result = pack(['-Out', zip, '-Lanes', 'odc', '-NoNode', '-NoBuild', '-Prebuilt', prebuilt]);
    assert.equal(result.code, 0, result.out);
    const entries = readZip(zip);
    assert.equal([...entries.keys()].some(file => file.startsWith('bin/')), false);
    const manifest = JSON.parse(entries.get('pack.json').toString('utf8').replace(/^﻿/, ''));
    assert.deepEqual(manifest.lanes, ['odc']);
    assert.equal(manifest.o11BuiltFor, null);
    assert.equal(manifest.odcBridge, 'v35');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('IP scan rules 1 and 3: Anvil.Core.dll in any folder and any extra file in bin/o11/bridge refuse the pack, with no ZIP left', () => {
  const work = tempWork();
  try {
    refusedByScan(packWith(work, prebuilt => write(path.join(prebuilt, 'o11', 'bridge', 'Anvil.Core.dll'), 'x')),
      [['bin/o11/bridge/Anvil.Core.dll', 'forbidden-name'], ['bin/o11/bridge/Anvil.Core.dll', 'bridge-folder']]);
    refusedByScan(packWith(work, prebuilt => write(path.join(prebuilt, 'odc', 'client', 'Anvil.Core.dll'), 'x')),
      [['odc/studio/bridge/client/bin/Release/net10.0/Anvil.Core.dll', 'forbidden-name']]);
    refusedByScan(packWith(work, prebuilt => write(path.join(prebuilt, 'o11', 'bridge', 'Extra.dll'), 'x')),
      [['bin/o11/bridge/Extra.dll', 'bridge-folder']]);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('IP scan rule 2: kernel names in UTF-8 refuse the pack; the same text only in UTF-16 (a string literal) passes', () => {
  const work = tempWork();
  try {
    refusedByScan(packWith(work, prebuilt => write(source(prebuilt, THIN), Buffer.from('\0Anvil.Core.Delivery\0BridgeAccess\0'))), [[THIN, 'kernel-text']]);
    const literal = packWith(work, prebuilt => {
      write(source(prebuilt, CONNECT), utf16('Anvil.Core is already loaded'));
      write(source(prebuilt, HOOK), utf16('Anvil.Core without Anvil.Bridge'));
    });
    assert.equal(literal.code, 0, literal.out);
    assert.ok(readZip(literal.zip).get(CONNECT).equals(utf16('Anvil.Core is already loaded')));
    // Every other kernel name, one per entry.
    const tokens = { [CONNECT]: 'Anvil.Cli', [HOOK]: 'Anvil.Authoring', [ODC_CLIENT]: 'Anvil.CSharp', [ODC_DIAG]: 'Ssam.Runtime', [ODC_BRIDGE]: 'Ssam.Lic', [THIN]: 'Esprima' };
    refusedByScan(packWith(work, prebuilt => { for (const [entry, token] of Object.entries(tokens)) write(source(prebuilt, entry), Buffer.from('x ' + token + ' y')); }),
      Object.keys(tokens).map(entry => [entry, 'kernel-text']));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('IP scan rule 4: any client text refuses the pack; the exception table is empty since servidor/fase3', () => {
  const work = tempWork();
  try {
    // The texts that were known exceptions (ScGuard.Corporate, the Manifest defaults) are findings now, in every entry.
    const formerlyKnown = packWith(work, prebuilt => {
      write(source(prebuilt, THIN), utf16('StartsWith("wrightflood")'));
      write(source(prebuilt, ODC_BRIDGE), Buffer.concat([utf16('wrightflood'), Buffer.from([0]), utf16('andre.c.machado')]));
    });
    refusedByScan(formerlyKnown, [[THIN, 'client-content'], [ODC_BRIDGE, 'client-content']]);
    assert.doesNotMatch(formerlyKnown.out, /conhecid[oa] no pacote/, 'no warning: nothing is a known exception');

    const unknown = packWith(work, prebuilt => {
      write(source(prebuilt, ODC_CLIENT), Buffer.concat([Buffer.from([0x41]), utf16('unimed')]));
      write(source(prebuilt, CONNECT), utf16('WrightFlood'));
      write(source(prebuilt, HOOK), Buffer.from('x hmisjha y'));
    });
    refusedByScan(unknown, [[ODC_CLIENT, 'client-content'], [CONNECT, 'client-content'], [HOOK, 'client-content']]);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('IP scan rule 5: a customer tenant host or an e-mail refuses the pack; vendor hosts and reserved example domains pass', () => {
  const work = tempWork();
  try {
    const customer = packWith(work, prebuilt => {
      write(source(prebuilt, THIN), utf16('https://acme-prod.outsystemsenterprise.com/ServiceCenter'));
      write(source(prebuilt, ODC_BRIDGE), Buffer.from('\0tenant\0globex.outsystems.dev\0'));
      write(source(prebuilt, ODC_CLIENT), utf16('jane.doe@globex-corp.com'));
      write(source(prebuilt, CONNECT), Buffer.concat([Buffer.from([0x41]), utf16('ops@initech.io')]));
      write(source(prebuilt, HOOK), Buffer.from('personal-x1y2.outsystemscloud.com'));
    });
    refusedByScan(customer, [THIN, ODC_BRIDGE, ODC_CLIENT, CONNECT, HOOK].map(entry => [entry, 'customer-pattern']));

    // Generic texts every Studio binary may carry: the identity provider of the vendor, a reserved example domain.
    const neutral = packWith(work, prebuilt => {
      write(source(prebuilt, THIN), utf16('https://id.outsystems.com/ and https://www.outsystems.com/'));
      write(source(prebuilt, ODC_BRIDGE), utf16('dev@example.com anvil@ssam-hybrid.local tester@lab.test'));
      write(source(prebuilt, CONNECT), Buffer.from('<tenant>.outsystems.dev'));
    });
    assert.equal(neutral.code, 0, neutral.out);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// release.sig.jws over a staged tree, the way the publisher's release_sign writes it: ES256 over every file of the
// folder except the signature itself (here an ephemeral test key; the hook h1 checks the chain, not this script).
function signStage(stage, { version, skip = [] } = {}) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else { const rel = path.relative(stage, full).split(path.sep).join('/'); if (rel !== 'release.sig.jws' && !skip.includes(rel)) { const bytes = fs.readFileSync(full); files.push({ path: rel, size: bytes.length, sha256: sha(bytes) }); } }
  } };
  walk(stage);
  const b64u = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const release = JSON.parse(fs.readFileSync(path.join(stage, 'release.json'), 'utf8').replace(/^﻿/, ''));
  const input = b64u({ alg: 'ES256', typ: 'ssam-release/1', kid: 'test-release' }) + '.' + b64u({ typ: 'ssam-release/1', iat: 1, version: version ?? release.version, files });
  fs.writeFileSync(path.join(stage, 'release.sig.jws'), input + '.' + sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'));
}

test('-Hook h1: the release layout in two steps (stage, owner signs, -FromStage), the signed tree checked before any ZIP', () => {
  const work = tempWork();
  try {
    const prebuilt = path.join(work, 'prebuilt');
    fakePrebuilt(prebuilt);
    // The release hook as the release line builds it: it carries the manifest check and the runtime contract.
    const hookH1 = path.join(work, 'hook-h1');
    write(path.join(hookH1, 'Anvil.Hook.h1.dll'), Buffer.from('MZ\0Ssam.Lic\0Release\0Ssam.Runtime\0RuntimeContract\0'));
    write(path.join(hookH1, 'Anvil.Hook.h1.pdb'));
    const common = ['-Lanes', 'odc,o11', '-NoNode', '-NoBuild', '-Prebuilt', prebuilt, '-Hook', 'h1', '-HookH1', hookH1];

    const unsigned = pack(['-Out', path.join(work, 'direct.zip'), ...common]);
    assert.notEqual(unsigned.code, 0, unsigned.out);
    assert.match(unsigned.out, /precisa da assinatura do publicador: use -Stage <pasta>/, unsigned.out);
    assert.equal(fs.existsSync(path.join(work, 'direct.zip')), false);

    const stage = path.join(work, 'stage');
    const staged = pack(['-Stage', stage, '-ReleaseVersion', '2026.10.5-pack.1', ...common]);
    assert.equal(staged.code, 0, staged.out);
    assert.match(staged.out, /release_sign \{releaseDir:/, staged.out);
    assert.equal(fs.existsSync(path.join(stage, 'release.sig.jws')), false, 'the script never signs');
    for (const file of ['studio/o11/hook/Anvil.Hook.h1.dll', 'studio/o11/bridge/b1/Anvil.Bridge.dll', 'studio/o11/bridge/b1/Anvil.Bridge.deps.json',
      'bin/o11/connect/Anvil.Connect.dll', 'release.json', 'pack.json']) assert.ok(fs.existsSync(path.join(stage, ...file.split('/'))), file);
    for (const absent of ['bin/o11/hook', 'bin/o11/bridge', 'studio/o11/hook/Anvil.Hook.h1.pdb']) assert.equal(fs.existsSync(path.join(stage, ...absent.split('/'))), false, absent);
    const release = JSON.parse(fs.readFileSync(path.join(stage, 'release.json'), 'utf8').replace(/^﻿/, ''));
    assert.deepEqual(release, { schema: 'ssam-agent-release/1', version: '2026.10.5-pack.1', kind: 'agent-pack',
      bridges: { o11: { id: 'b1', hook: 'h1', protocolVersion: 2, flavor: 'thin' } } });
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'pack.json'), 'utf8').replace(/^﻿/, ''));
    assert.equal(manifest.o11Hook, 'h1');
    assert.deepEqual(manifest.o11Bridge, { id: 'b1', hookAbi: 'h1', path: 'studio/o11/bridge/b1/Anvil.Bridge.dll',
      sha256: sha(fs.readFileSync(path.join(stage, 'studio', 'o11', 'bridge', 'b1', 'Anvil.Bridge.dll'))) });

    const zip = path.join(work, 'signed', 'ssam-agent.zip');
    const missing = pack(['-FromStage', stage, '-Out', zip]);
    assert.notEqual(missing.code, 0, missing.out);
    assert.match(missing.out, /Falta release\.sig\.jws/, missing.out);

    signStage(stage);
    const signed = pack(['-FromStage', stage, '-Out', zip]);
    assert.equal(signed.code, 0, signed.out);
    assert.match(signed.out, /Excecao conhecida no pacote: studio\/o11\/hook\/Anvil\.Hook\.h1\.dll \(kernel-text: Ssam\.Lic/, signed.out);
    const entries = readZip(zip);
    for (const name of ['release.sig.jws', 'release.json', 'pack.json', 'studio/o11/hook/Anvil.Hook.h1.dll', 'studio/o11/bridge/b1/Anvil.Bridge.dll'])
      assert.ok(entries.has(name), name);
    assert.equal([...entries.keys()].some(name => name.startsWith('bin/o11/bridge/') || name.startsWith('bin/o11/hook/')), false);

    // A file changed or added after signing, a file the signature lists that is gone, another version: no ZIP.
    const again = (label, change, expected) => {
      const copy = path.join(work, 'stage-' + label);
      fs.cpSync(stage, copy, { recursive: true });
      change(copy);
      const out = path.join(work, label + '.zip');
      const result = pack(['-FromStage', copy, '-Out', out]);
      assert.notEqual(result.code, 0, label + ': ' + result.out);
      assert.match(result.out, expected, label);
      assert.equal(fs.existsSync(out), false, label + ': no ZIP');
    };
    again('changed', copy => fs.appendFileSync(path.join(copy, 'studio', 'o11', 'bridge', 'b1', 'Anvil.Bridge.dll'), 'x'), /alterado depois da assinatura/);
    again('added', copy => write(path.join(copy, 'studio', 'o11', 'bridge', 'b1', 'Extra.dll'), 'x'), /nao lista studio\/o11\/bridge\/b1\/Extra\.dll/);
    again('gone', copy => fs.rmSync(path.join(copy, 'odc', 'README.md')), /lista odc\/README\.md, que nao esta na arvore/);
    again('version', copy => signStage(copy, { version: '9.9.9' }), /assina a versao 9\.9\.9/);
    // Signed, but the hook carries kernel code: the scan still refuses it.
    again('kernel', copy => { write(path.join(copy, 'studio', 'o11', 'hook', 'Anvil.Hook.h1.dll'), Buffer.from('Ssam.Lic Anvil.Core')); signStage(copy); }, /Anvil\.Hook\.h1\.dll \(kernel-text\)/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('IP scan bridge-folder for the release layout: one bridge b<N>, the hook folder closed, release.json and release.sig.jws required', () => {
  const work = tempWork();
  try {
    const zipOf = (name, entries) => {
      const folder = path.join(work, name);
      for (const [entry, bytes] of Object.entries(entries)) write(path.join(folder, ...entry.split('/')), bytes);
      const zip = path.join(work, name + '.zip');
      const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open('${zip}','Create'); Get-ChildItem -LiteralPath '${folder}' -Recurse -File | ForEach-Object { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $_.FullName.Substring(${folder.length + 1}).Replace('\\','/')) }; $z.Dispose()`],
        { encoding: 'utf8', windowsHide: true });
      assert.equal(run.status, 0, run.stderr);
      const scan = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'scripts', 'pack-ip-scan.ps1'), '-Zip', zip], { encoding: 'utf8', windowsHide: true });
      return { code: scan.status, report: JSON.parse(scan.stdout) };
    };
    const good = { 'release.json': '{}', 'release.sig.jws': 'a.b.c', 'studio/o11/hook/Anvil.Hook.h1.dll': 'hook', 'studio/o11/bridge/b1/Anvil.Bridge.dll': 'thin' };
    assert.equal(zipOf('good', good).code, 0);
    const rules = result => result.report.findings.map(f => f.entry + ' ' + f.rule + ': ' + f.detail);
    const extra = zipOf('extra', { ...good, 'studio/o11/hook/Other.dll': 'x', 'studio/o11/bridge/b2/Anvil.Bridge.dll': 'thin', 'bin/o11/bridge/Anvil.Bridge.dll': 'thin' });
    assert.equal(extra.code, 1);
    assert.ok(rules(extra).some(r => r.startsWith('studio/o11/hook/Other.dll bridge-folder')), rules(extra).join('\n'));
    assert.ok(rules(extra).some(r => r.includes('one release bridge per pack')), rules(extra).join('\n'));
    assert.ok(rules(extra).some(r => r.includes('not both')), rules(extra).join('\n'));
    const unsigned = zipOf('unsigned', { 'studio/o11/hook/Anvil.Hook.h1.dll': 'hook', 'studio/o11/bridge/b1/Anvil.Bridge.dll': 'thin' });
    assert.deepEqual(unsigned.report.findings.map(f => f.entry).sort(), ['release.json', 'release.sig.jws']);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('node.exe goes by default and only with its LICENSE (beside, one folder up or -NodeLicense); third-party bytes are not scanned', () => {
  const work = tempWork();
  try {
    // Kernel and client text inside node.exe and LICENSE: exempt from rules 2 and 4.
    const nodeBytes = Buffer.from('MZ fake node Anvil.Core unimed Esprima');
    const licenseBytes = Buffer.from('Node.js is licensed for use as follows: ... Anvil.Core wrightflood');
    const beside = path.join(work, 'beside', 'node.exe');
    write(beside, nodeBytes); write(path.join(work, 'beside', 'LICENSE'), licenseBytes);
    const above = path.join(work, 'above', 'bin', 'node.exe');
    write(above, nodeBytes); write(path.join(work, 'above', 'LICENSE'), licenseBytes);
    const bare = path.join(work, 'bare', 'bin', 'node.exe');
    write(bare, nodeBytes);
    const separate = path.join(work, 'licenses', 'node-24.19.0.txt');
    write(separate, licenseBytes);

    const carries = (result, label) => {
      assert.equal(result.code, 0, label + ': ' + result.out);
      const entries = readZip(result.zip);
      assert.ok(entries.get('agent/node/node.exe')?.equals(nodeBytes), label + ': node.exe');
      assert.ok(entries.get('agent/node/LICENSE')?.equals(licenseBytes), label + ': LICENSE');
      const manifest = JSON.parse(entries.get('pack.json').toString('utf8').replace(/^﻿/, ''));
      assert.equal(manifest.files.find(f => f.path === 'agent/node/LICENSE')?.sha256, sha(licenseBytes), label + ': pack.json');
    };
    carries(packWith(work, undefined, ['-NodeExe', beside]), 'LICENSE beside');
    carries(packWith(work, undefined, ['-NodeExe', above]), 'LICENSE one folder up');
    carries(packWith(work, undefined, ['-NodeExe', bare, '-NodeLicense', separate]), '-NodeLicense');
    // No -NodeExe and no -NoNode: the node of Get-Node (SSAM_NODE first).
    carries(packWith(work, undefined, [], { SSAM_NODE: beside }), 'default node');

    const missing = packWith(work, undefined, ['-NodeExe', bare]);
    assert.notEqual(missing.code, 0, missing.out);
    assert.match(missing.out, /Falta a licen.{1,2}a do Node \(LICENSE\) para /, missing.out);
    assert.match(missing.out, /node\.exe: use -NodeLicense <arquivo> ou -NoNode/, missing.out);
    assert.equal(fs.existsSync(missing.zip), false, 'no ZIP without the license');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

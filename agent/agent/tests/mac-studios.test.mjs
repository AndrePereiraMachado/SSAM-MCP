// macOS facts (lib/macos.mjs, lib/pe-version.mjs, the darwin branch of lib/studios.mjs), on any system: application
// bundles laid out in a temporary folder, Info.plist in XML and binary (plutil faked), ps output as text, PE bytes built by
// the test, the start time text of .NET and the Mach-O header. No macOS tool runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { peVersionInfo, productVersionOf } from '../lib/pe-version.mjs';
import { findBundles, managedDirOf, kindOfNames, plistStrings, plistVersion, inspectBundle, installedBundles, officialBundle, parsePs, bundleOfExe,
  studioProcesses, platformUuid, tempFolders, startTime, dotnetStartTimeText, machOArchs, START_READERS } from '../lib/macos.mjs';
import { listProcesses, installedStudios, macFileVersion, macLocate } from '../lib/studios.mjs';
import { machineIdentity } from '../lib/agent.mjs';
import { fakePe } from './fixtures/pe.mjs';

const plist = (strings, environment = null) => '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n'
  + Object.entries(strings).map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>\n`).join('')
  + (environment ? '  <key>LSEnvironment</key>\n  <dict>' + Object.entries(environment).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('') + '</dict>\n' : '')
  + '</dict></plist>\n';

// A home with /Applications-like folders: {home, apps, userApps, bundle(name, options)}.
function machine() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-mac-'));
  const apps = path.posix.join(top.replace(/\\/g, '/'), 'Applications');
  const home = path.posix.join(top.replace(/\\/g, '/'), 'home');
  fs.mkdirSync(apps, { recursive: true }); fs.mkdirSync(path.posix.join(home, 'Applications'), { recursive: true });
  const bundle = (where, name, { kind = 'odc', executable = 'ODC Studio', entry = kind === 'odc' ? 'ODCStudio' : 'ServiceStudio', managed = 'MacOS', version = '1.7.28.10873',
    short = '1.7.28', build = '10873', hooks = undefined, environment = null, binary = false } = {}) => {
    const root = path.posix.join(where, name);
    const dir = path.posix.join(root, 'Contents', managed);
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.posix.join(root, 'Contents', 'MacOS'), { recursive: true });
    const names = kind === 'odc' ? ['OutSystems.Model.dll', 'OutSystems.Model.V1.dll', 'ServiceStudio.Framework.dll'] : ['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll'];
    for (const n of names) fs.writeFileSync(path.posix.join(dir, n), 'x');
    if (entry) {
      fs.writeFileSync(path.posix.join(dir, entry + '.dll'), fakePe({ productVersion: version, fileVersion: version }));
      fs.writeFileSync(path.posix.join(dir, entry + '.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm: 'net8.0', configProperties: hooks === undefined ? {} : { 'System.StartupHookProvider.IsSupported': hooks } } }));
    }
    const exe = Buffer.alloc(32); exe.writeUInt32LE(0xfeedfacf, 0); exe.writeUInt32LE(0x0100000c, 4);
    fs.writeFileSync(path.posix.join(root, 'Contents', 'MacOS', executable), exe);
    const xml = plist({ CFBundleExecutable: executable, CFBundleIdentifier: 'com.example.' + kind, CFBundleShortVersionString: short, CFBundleVersion: build }, environment);
    fs.writeFileSync(path.posix.join(root, 'Contents', 'Info.plist'), binary ? Buffer.concat([Buffer.from('bplist00'), Buffer.from(xml)]) : xml);
    return root;
  };
  return { top, apps, home, userApps: path.posix.join(home, 'Applications'), bundle, remove: () => fs.rmSync(top, { recursive: true, force: true }) };
}

test('PE version: the ProductVersion and FileVersion strings and the fixed numbers of a version resource; anything else is null', () => {
  const info = peVersionInfo(fakePe({ productVersion: '1.7.28.10873', fileVersion: '1.7.28.10873', fixed: '1.7.28.10873' }));
  assert.deepEqual(info, { productVersion: '1.7.28.10873', fileVersion: '1.7.28.10873', fixedFileVersion: '1.7.28.10873', fixedProductVersion: '1.7.28.10873' });
  assert.equal(peVersionInfo(fakePe({ fileVersion: '13.1440.1.060000' })).productVersion, null);
  assert.equal(peVersionInfo(fakePe({ productVersion: '13.1440.1+Branch.tags-v13.1440.1.Sha.584a' })).productVersion, '13.1440.1+Branch.tags-v13.1440.1.Sha.584a');
  for (const bytes of [Buffer.alloc(0), Buffer.from('MZ'), Buffer.from('#!/bin/sh\necho\n'), Buffer.alloc(4096)]) assert.equal(peVersionInfo(bytes), null);
  assert.equal(productVersionOf(path.join(os.tmpdir(), 'no-such-file-' + process.pid + '.dll')), null);
});

test('PE version: on Windows, the node.exe of this test reads the same ProductVersion as Windows VersionInfo', { skip: process.platform !== 'win32' }, () => {
  const windows = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${process.execPath}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim();
  assert.equal(productVersionOf(process.execPath), windows);
  assert.equal(windows, process.versions.node);
});

test('Info.plist: string values (first of each key, XML entities decoded), LSEnvironment, and the version rule', () => {
  const parsed = plistStrings(plist({ CFBundleExecutable: 'ODC &amp; Studio', CFBundleShortVersionString: '1.7.28', CFBundleVersion: '10873' }, { DOTNET_EnableDiagnostics: '0' }));
  assert.equal(parsed.strings.CFBundleExecutable, 'ODC & Studio');
  assert.deepEqual(parsed.environment, { DOTNET_EnableDiagnostics: '0' });
  assert.equal(plistVersion('1.7.28', '10873'), '1.7.28.10873');
  assert.equal(plistVersion('1.7.28', '1.7.28.10873'), '1.7.28.10873');
  assert.equal(plistVersion('1.7.28', '2.0.0.1'), '1.7.28');
  assert.equal(plistVersion('11.55.92', '11.55.92 (65269)'), '11.55.92');
  assert.equal(plistVersion(undefined, '1.7.28.4'), '1.7.28.4');
  assert.equal(plistVersion(undefined, undefined), null);
});

test('bundles: two levels of the application folders, the managed folder found under Contents (nested bundles skipped), the lane by its DLLs', async () => {
  const m = machine();
  try {
    const odc = m.bundle(m.apps, 'ODC Studio.app');
    fs.mkdirSync(path.posix.join(m.apps, 'OutSystems'), { recursive: true });
    const o11 = m.bundle(path.posix.join(m.apps, 'OutSystems'), 'Service Studio 11.app', { kind: 'o11', executable: 'ServiceStudio', managed: 'Resources/app', version: '11.55.92.65269', short: '11.55.92', build: '65269' });
    fs.mkdirSync(path.posix.join(m.apps, 'Other.app', 'Contents', 'MacOS'), { recursive: true });
    // A helper app inside a Studio bundle and a deep folder never count.
    fs.mkdirSync(path.posix.join(odc, 'Contents', 'Frameworks', 'Helper.app', 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.posix.join(m.apps, 'a', 'b', 'Deep.app'), { recursive: true });
    const found = findBundles([m.apps, m.userApps]).sort();
    assert.deepEqual(found, [path.posix.join(m.apps, 'ODC Studio.app'), path.posix.join(m.apps, 'OutSystems', 'Service Studio 11.app'), path.posix.join(m.apps, 'Other.app')].sort());
    assert.equal(managedDirOf(o11).dir, path.posix.join(o11, 'Contents', 'Resources', 'app'));
    assert.equal(managedDirOf(o11, { folders: 2 }), null, 'the folders read per bundle are bounded');
    assert.equal(managedDirOf(path.posix.join(m.apps, 'Other.app')), null);
    assert.equal(kindOfNames(new Set(['OutSystems.Model.dll', 'ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll'])), 'odc');
    assert.equal(kindOfNames(new Set(['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll'])), 'o11');
    assert.equal(kindOfNames(new Set(['ServiceStudio.Framework.dll'])), null);
    const info = await inspectBundle(odc);
    assert.equal(info.kind, 'odc'); assert.equal(info.entry, 'ODCStudio'); assert.equal(info.version, '1.7.28.10873');
    assert.equal(info.versionSource, 'ProductVersion of ODCStudio.dll'); assert.equal(info.exePath, path.posix.join(odc, 'Contents', 'MacOS', 'ODC Studio'));
    // Installed: newest version first, the first application folder first; a bundle that is no Studio is left out.
    m.bundle(m.userApps, 'ODC Studio old.app', { version: '1.7.27.100' });
    m.bundle(m.userApps, 'ODC Studio same.app', { version: '1.7.28.10873' });
    const all = await installedBundles({ home: m.home, roots: [m.apps, m.userApps] });
    assert.deepEqual(all.map(i => [path.posix.basename(i.bundle), i.kind, i.version]), [['Service Studio 11.app', 'o11', '11.55.92.65269'],
      ['ODC Studio.app', 'odc', '1.7.28.10873'], ['ODC Studio same.app', 'odc', '1.7.28.10873'], ['ODC Studio old.app', 'odc', '1.7.27.100']]);
  } finally { m.remove(); }
});

test('bundle version: the entry assembly first, else Info.plist (binary plists go through plutil); startup hooks and LSEnvironment are read', async () => {
  const m = machine();
  try {
    const plain = m.bundle(m.apps, 'A.app', { entry: null, short: '1.7.28', build: '10873', environment: { DOTNET_EnableDiagnostics: '0' } });
    const info = await inspectBundle(plain);
    assert.equal(info.entry, null); assert.equal(info.version, '1.7.28.10873'); assert.equal(info.versionSource, 'Info.plist');
    assert.equal(info.environment.DOTNET_EnableDiagnostics, '0');
    const binary = m.bundle(m.apps, 'B.app', { hooks: false, binary: true });
    const calls = [];
    const run = async (file, args) => { calls.push([file, ...args]); return fs.readFileSync(args.at(-1)).subarray(8).toString('utf8'); };
    const b = await inspectBundle(binary, { run });
    assert.deepEqual(calls, [['/usr/bin/plutil', '-convert', 'xml1', '-o', '-', path.posix.join(binary, 'Contents', 'Info.plist')]]);
    assert.equal(b.executable, 'ODC Studio');
    assert.equal(b.runtimeConfig.runtimeOptions.configProperties['System.StartupHookProvider.IsSupported'], false);
  } finally { m.remove(); }
});

test('official places: /Applications and ~/Applications, two levels; anything else is not', () => {
  assert.equal(officialBundle('/Applications/ODC Studio.app', '/Users/ana'), true);
  assert.equal(officialBundle('/Applications/OutSystems/ODC Studio.app', '/Users/ana'), true);
  assert.equal(officialBundle('/Users/ana/Applications/ODC Studio.app', '/Users/ana'), true);
  assert.equal(officialBundle('/Users/ana/Downloads/ODC Studio.app', '/Users/ana'), false);
  assert.equal(officialBundle('/Applications/a/b/ODC Studio.app', '/Users/ana'), false);
  assert.equal(officialBundle('/Volumes/ODC/ODC Studio.app', '/Users/ana'), false);
});

test('ps: pid, start (local time) and the executable with spaces; the bundle of an executable', () => {
  const text = '  123 Mon Oct 19 09:12:33 2026     /Applications/ODC Studio.app/Contents/MacOS/ODC Studio\n'
    + '45678 Tue Oct  6 17:01:02 2026 /usr/libexec/logd\n'
    + 'garbage line\n   9 Fri Jan  2 03:04:05 2026 /Applications/ODC Studio.app/Contents/Frameworks/H.app/Contents/MacOS/H\n';
  const rows = parsePs(text);
  assert.deepEqual(rows.map(r => r.pid), [123, 45678, 9]);
  assert.equal(rows[0].exe, '/Applications/ODC Studio.app/Contents/MacOS/ODC Studio');
  assert.equal(rows[0].startSeconds, Math.floor(new Date(2026, 9, 19, 9, 12, 33).getTime() / 1000));
  assert.equal(rows[1].startSeconds, Math.floor(new Date(2026, 9, 6, 17, 1, 2).getTime() / 1000));
  assert.equal(bundleOfExe(rows[0].exe), '/Applications/ODC Studio.app');
  assert.equal(bundleOfExe(rows[2].exe), '/Applications/ODC Studio.app/Contents/Frameworks/H.app');
  assert.equal(bundleOfExe('/usr/libexec/logd'), null);
  assert.equal(bundleOfExe('/Applications/X.app/Contents/MacOS/sub/tool'), null);
});

test('Studio processes: only the bundle executable of the lane counts (helpers, other apps and the other lane do not)', async () => {
  const m = machine();
  try {
    const odc = m.bundle(m.apps, 'ODC Studio.app');
    const o11 = m.bundle(m.userApps, 'Service Studio.app', { kind: 'o11', executable: 'ServiceStudio', version: '11.55.92.65269' });
    const ps = async () => [
      `  501 Mon Oct 19 09:12:33 2026 ${odc}/Contents/MacOS/ODC Studio`,
      `  502 Mon Oct 19 09:12:34 2026 ${odc}/Contents/MacOS/crashpad_handler`,
      `  503 Mon Oct 19 09:12:35 2026 ${odc}/Contents/Frameworks/ODC Studio Helper.app/Contents/MacOS/ODC Studio Helper`,
      `  601 Mon Oct 19 09:20:00 2026 ${o11}/Contents/MacOS/ServiceStudio`,
      '  700 Mon Oct 19 09:00:00 2026 /System/Applications/Calculator.app/Contents/MacOS/Calculator'].join('\n');
    const odcList = await studioProcesses('odc', { ps, home: m.home });
    assert.deepEqual(odcList.map(p => [p.pid, p.version, p.official]), [[501, '1.7.28.10873', false]]);
    const o11List = await studioProcesses('o11', { ps, home: m.home });
    assert.deepEqual(o11List.map(p => [p.pid, p.version, p.official]), [[601, '11.55.92.65269', true]]);
    // studios.mjs on darwin: the protocol image names map to the lanes; the wire shape is {pid, path, version}.
    assert.deepEqual(await listProcesses('ODCStudio.exe', { platform: 'darwin', mac: { ps, home: m.home } }), [{ pid: 501, path: `${odc}/Contents/MacOS/ODC Studio`, version: '1.7.28.10873' }]);
    assert.deepEqual(await listProcesses('other.exe', { platform: 'darwin', mac: { ps } }), []);
    assert.equal(await macFileVersion(`${o11}/Contents/MacOS/ServiceStudio`), '11.55.92.65269');
    assert.equal(await macFileVersion(o11), '11.55.92.65269');
    assert.equal(await macFileVersion('/usr/bin/true'), null);
    // installedStudios on darwin asks the version of the bundle itself.
    const studios = await installedStudios({ platform: 'darwin', locate: async kind => (kind === 'odc' ? odc : null), version: target => macFileVersion(target) });
    assert.deepEqual(studios, { odc: { installed: { dir: odc, version: '1.7.28.10873' } }, o11: { installed: null } });
    assert.equal(typeof macLocate, 'function');
  } finally { m.remove(); }
});

test('machine identity on macOS: IOPlatformUUID hashed with the name and the user, as the Windows MachineGuid', () => {
  const out = '+-o J316sAP  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "0A1B2C3D-1111-2222-3333-444455556666"\n    }\n';
  const calls = [];
  const a = machineIdentity({ platform: 'darwin', run: (file, args) => { calls.push([file, ...args]); return out; } });
  const b = machineIdentity({ platform: 'darwin', run: () => out.replace('0A1B', 'FFFF') });
  assert.deepEqual(calls, [['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']]);
  assert.match(a.id, /^[0-9a-f]{16}$/); assert.notEqual(a.id, b.id);
  assert.equal(machineIdentity({ platform: 'darwin', run: () => { throw new Error('no ioreg'); } }).id.length, 16);
});

test('temporary folders: TMPDIR, the user temporary folder of getconf and /tmp, each once with a slash', async () => {
  const run = async (file, args) => { assert.deepEqual([file, ...args], ['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR']); return '/var/folders/ab/cd/T/\n'; };
  assert.deepEqual(await tempFolders({ env: { TMPDIR: '/var/folders/ab/cd/T' }, run }), ['/var/folders/ab/cd/T/', '/tmp/']);
  assert.deepEqual(await tempFolders({ env: {}, run: async () => { throw new Error('none'); } }), ['/tmp/']);
  assert.deepEqual(await tempFolders({ env: { TMPDIR: 'relative' }, run }), ['/var/folders/ab/cd/T/', '/tmp/']);
  assert.equal(await platformUuid({ run: async () => '"IOPlatformUUID" = "X-1"' }), 'X-1');
});

test('start time with microseconds: readers checked against the kernel seconds and against each other; every reason when none works', async () => {
  const ok = value => async () => value;
  const bad = message => async () => { throw new Error(message); };
  assert.deepEqual(await startTime(7, { expectedSeconds: 100, readers: { a: ok({ sec: 100, usec: 5 }), b: bad('no perl') } }),
    { sec: 100, usec: 5, readers: ['a'], failures: ['b: no perl'] });
  await assert.rejects(startTime(7, { expectedSeconds: 100, readers: { a: ok({ sec: 99, usec: 5 }), b: bad('no osascript') } }), /a: 99 s, the kernel says 100 s; b: no osascript/);
  await assert.rejects(startTime(7, { readers: { a: ok({ sec: 100, usec: 5 }), b: ok({ sec: 100, usec: 6 }) } }), /disagree/);
  await assert.rejects(startTime(7, { readers: { a: ok({ sec: 100, usec: 1000000 }) } }), /a: not a time/);
  // The three readers parse what their tools print.
  const kinfo = Buffer.alloc(648); kinfo.writeBigInt64LE(1760872353n, 0); kinfo.writeInt32LE(123456, 8);
  const bsd = Buffer.alloc(136); bsd.writeUInt32LE(4242, 12); bsd.writeBigUInt64LE(1760872353n, 120); bsd.writeBigUInt64LE(123456n, 128);
  const run = async (file, args, options) => (file.endsWith('perl') ? '1760872353 123456\n' : file.endsWith('osascript') ? bsd.toString('base64') + '\n' : options?.encoding === 'buffer' ? kinfo : '');
  for (const [name, read] of Object.entries(START_READERS)) assert.deepEqual(await read(4242, { run }), { sec: 1760872353, usec: 123456 }, name);
  await assert.rejects(START_READERS.osascript(1, { run }), /not the process 1/);
  await assert.rejects(START_READERS.perl(1, { run: async () => 'ERR Operation not permitted' }), /perl: ERR/);
});

test('the .NET start time text: DateTime.UnixEpoch + TimeSpan.FromSeconds(sec + usec / 1e6) written with seven decimals', () => {
  assert.equal(dotnetStartTimeText(0, 0), '1970-01-01T00:00:00.0000000Z');
  assert.equal(dotnetStartTimeText(1, 500000), '1970-01-01T00:00:01.5000000Z');
  assert.match(dotnetStartTimeText(1760872353, 123456), /^2025-10-19T11:12:33\.12345\d{2}Z$/);
  // The double of a 2025 time has a step of 2 ticks: the text carries what (long)(seconds * 1e7) gives, not the exact
  // microseconds.
  const seconds = 1760872353 + 123456 / 1000000;
  assert.equal(dotnetStartTimeText(1760872353, 123456).slice(20, 27), String(BigInt(Math.trunc(seconds * 10000000)) % 10000000n).padStart(7, '0'));
  // The texts .NET 10.0.12 wrote for (DateTime.UnixEpoch + TimeSpan.FromSeconds(sec + usec / 1e6)).ToString("O") on
  // 2026-10-19 (C:\t\agent-mac\prova-ipc, the formula of Process.OSX.cs; the same code in .NET 8): 2000000000.000007 s is
  // .0000068, the double's own rounding, which the agent reproduces.
  for (const [sec, usec, text] of [[0, 0, '1970-01-01T00:00:00.0000000Z'], [1, 500000, '1970-01-01T00:00:01.5000000Z'], [1760872353, 123456, '2025-10-19T11:12:33.1234560Z'],
    [1760872353, 999999, '2025-10-19T11:12:33.9999990Z'], [1760872353, 1, '2025-10-19T11:12:33.0000010Z'], [1700000000, 654321, '2023-11-14T22:13:20.6543210Z'],
    [1767225599, 999999, '2025-12-31T23:59:59.9999990Z'], [2000000000, 7, '2033-05-18T03:33:20.0000068Z'], [1760872353, 500001, '2025-10-19T11:12:33.5000010Z'],
    [1234567890, 123457, '2009-02-13T23:31:30.1234570Z']])
    assert.equal(dotnetStartTimeText(sec, usec), text, `${sec} ${usec}`);
});

test('Mach-O architectures: thin arm64 and x86_64, universal, and not a Mach-O', () => {
  const thin = type => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(type, 4); return b; };
  assert.deepEqual(machOArchs(thin(0x0100000c)), ['arm64']);
  assert.deepEqual(machOArchs(thin(0x01000007)), ['x86_64']);
  const fat = Buffer.alloc(8 + 40); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4); fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(machOArchs(fat), ['x86_64', 'arm64']);
  assert.deepEqual(machOArchs(Buffer.from('#!/bin/sh')), []);
});

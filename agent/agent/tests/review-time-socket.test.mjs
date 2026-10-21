// The independent review's own tests (kept in the box, round 2): the start time readers (lib/macos.mjs startTime), the
// choice of the diagnostic socket (lib/dotnet-ipc.mjs unixEndpoints) and the identity checks of lib/attach-unix.mjs, with
// injected tools. Review M4 is closed one level up: startTime still takes one reader, but the Service Studio describe
// passes it only readers that passed the check on processes of the agent (mac-start-check.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as mac from '../lib/macos.mjs';
import * as ipc from '../lib/dotnet-ipc.mjs';
import { createMacAttach } from '../lib/attach-unix.mjs';

const reader = value => async () => { if (value instanceof Error) throw value; return value; };

test('startTime: one reader alone is enough; it must match the kernel seconds', async () => {
  const one = await mac.startTime(77, { expectedSeconds: 1760872353, readers: { perl: reader({ sec: 1760872353, usec: 123456 }), osascript: reader(new Error('no JXA')), sysctl: reader(new Error('unknown oid')) } });
  assert.deepEqual([one.sec, one.usec, one.readers], [1760872353, 123456, ['perl']]);
  assert.equal(one.failures.length, 2);
  await assert.rejects(mac.startTime(77, { expectedSeconds: 1760872354, readers: { perl: reader({ sec: 1760872353, usec: 123456 }) } }), /could not be read.*perl: 1760872353 s, the kernel says 1760872354 s/);
});

test('startTime: readers that disagree in the microseconds stop the attach (nothing is guessed)', async () => {
  await assert.rejects(mac.startTime(77, { expectedSeconds: 1760872353, readers: { perl: reader({ sec: 1760872353, usec: 123456 }), sysctl: reader({ sec: 1760872353, usec: 123457 }) } }), /disagree/);
  // A reader with the wrong seconds is dropped and the others still decide.
  const kept = await mac.startTime(77, { expectedSeconds: 1760872353, readers: { perl: reader({ sec: 1760872352, usec: 5 }), osascript: reader({ sec: 1760872353, usec: 9 }) } });
  assert.deepEqual([kept.usec, kept.readers], [9, ['osascript']]);
  // Out-of-range values are no value.
  await assert.rejects(mac.startTime(77, { expectedSeconds: null, readers: { perl: reader({ sec: 1760872353, usec: 1000000 }), sysctl: reader({ sec: -1, usec: 0 }) } }), /not a time/);
});

test('startTime alone still believes a single reader with wrong microseconds; the describe gives it only checked readers (M4, mac-start-check.test.mjs)', async () => {
  const wrong = await mac.startTime(77, { expectedSeconds: 1760872353, readers: { sysctl: reader({ sec: 1760872353, usec: 0 }) } });
  assert.equal(wrong.usec, 0);
});

test('the perl, osascript and sysctl readers parse what the tools print (layouts of kinfo_proc and proc_bsdinfo)', async () => {
  const perl = await mac.START_READERS.perl(77, { run: async () => '1760872353 123456\n' });
  assert.deepEqual(perl, { sec: 1760872353, usec: 123456 });
  await assert.rejects(mac.START_READERS.perl(77, { run: async () => 'ERR Operation not permitted\n' }), /perl: ERR/);
  const info = Buffer.alloc(136); info.writeUInt32LE(77, 12); info.writeBigUInt64LE(1760872353n, 120); info.writeBigUInt64LE(654321n, 128);
  assert.deepEqual(await mac.START_READERS.osascript(77, { run: async () => info.toString('base64') + '\n' }), { sec: 1760872353, usec: 654321 });
  await assert.rejects(mac.START_READERS.osascript(78, { run: async () => info.toString('base64') }), /not the process 78/);
  const kinfo = Buffer.alloc(648); kinfo.writeBigInt64LE(1760872353n, 0); kinfo.writeInt32LE(42, 8);
  assert.deepEqual(await mac.START_READERS.sysctl(77, { run: async () => kinfo }), { sec: 1760872353, usec: 42 });
});

test('the .NET text keeps seven digits, with the double rounding of FromSeconds', () => {
  assert.equal(mac.dotnetStartTimeText(1760872353, 123456), '2025-10-19T11:12:33.1234560Z');
  assert.equal(mac.dotnetStartTimeText(2000000000, 7), '2033-05-18T03:33:20.0000068Z');
  assert.match(mac.dotnetStartTimeText(0, 0), /^1970-01-01T00:00:00\.0000000Z$/);
});

test('socket choice: newest first; a stale socket of a reused pid with a newer mtime makes identify refuse (never the wrong process)', async () => {
  const listing = { '/var/folders/x/T/': ['dotnet-diagnostic-501-1760872353-socket', 'dotnet-diagnostic-501-1760000000-socket', 'dotnet-diagnostic-5012-1760872353-socket', 'other'], '/tmp/': ['dotnet-diagnostic-501-1760872353-socket'] };
  const mtimes = { '/var/folders/x/T/dotnet-diagnostic-501-1760872353-socket': 2, '/var/folders/x/T/dotnet-diagnostic-501-1760000000-socket': 1, '/tmp/dotnet-diagnostic-501-1760872353-socket': 3 };
  const found = ipc.unixEndpoints(501, ['/var/folders/x/T/', '/tmp/'], { readdir: dir => listing[dir] ?? [], stat: file => ({ mtimeMs: mtimes[file] }) });
  assert.deepEqual(found.map(e => e.path), ['/tmp/dotnet-diagnostic-501-1760872353-socket', '/var/folders/x/T/dotnet-diagnostic-501-1760872353-socket', '/var/folders/x/T/dotnet-diagnostic-501-1760000000-socket']);
  // The newest is a stale one (an older process with this pid left it in /tmp): the key does not match ps, so it refuses
  // instead of trying the matching socket.
  const reverse = ipc.unixEndpoints(501, ['/var/folders/x/T/'], { readdir: dir => listing[dir] ?? [], stat: file => ({ mtimeMs: file.endsWith('1760000000-socket') ? 9 : 1 }) });
  assert.equal(reverse[0].key, '1760000000');
});

// A minimal macOS: one ODC Studio bundle, ps output, the temp folder listing, a fake IPC.
function fakeMac({ sockets, startLocal = 'Sun Oct 19 08:12:33 2025', pidInfo = 501, clr = '8.0.31', hooksOff = false, bundle = '/Applications/ODC Studio.app' } = {}) {
  const exe = bundle + '/Contents/MacOS/ODC Studio';
  const managed = bundle + '/Contents/MonoBundle';
  const dirent = (name, dir) => ({ name, isDirectory: () => dir, isFile: () => !dir });
  const tree = { '/Applications': [dirent(path.posix.basename(bundle), true)], [bundle + '/Contents']: [dirent('MonoBundle', true), dirent('MacOS', true), dirent('Info.plist', false)],
    [managed]: [dirent('OutSystems.Model.dll', false), dirent('ODCStudio.dll', false), dirent('ODCStudio.runtimeconfig.json', false)] };
  const files = { [bundle + '/Contents/Info.plist']: Buffer.from('<plist><dict><key>CFBundleExecutable</key><string>ODC Studio</string><key>CFBundleShortVersionString</key><string>1.7.28</string><key>CFBundleVersion</key><string>10873</string></dict></plist>'),
    [managed + '/ODCStudio.runtimeconfig.json']: Buffer.from(JSON.stringify({ runtimeOptions: { configProperties: hooksOff ? { 'System.StartupHookProvider.IsSupported': false } : {} } })),
    [managed + '/ODCStudio.dll']: Buffer.from('MZ not a real PE') };
  const fsFake = { realpathSync: file => file, lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    readdirSync: (dir, opts) => { const d = dir.replace(/\/+$/, ''); if (opts?.withFileTypes) { if (!tree[d]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return tree[d]; } return sockets[dir] ?? sockets[d + '/'] ?? []; },
    readFileSync: (file, enc) => { if (!files[file]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return enc ? files[file].toString(enc) : files[file]; },
    statSync: file => ({ mtimeMs: 1, isSocket: () => true }), existsSync: () => true };
  const sent = [];
  const deps = { fs: fsFake, home: '/Users/ana', env: { TMPDIR: '/var/folders/x/T/' }, run: async (tool, args) => { if (tool === mac.TOOLS.getconf) return '/var/folders/x/T/\n'; throw new Error('no ' + tool); },
    ps: async () => `  501 ${startLocal}     ${exe}\n  777 ${startLocal}     /usr/bin/other\n`,
    ipc: { processInfo2: async () => ({ pid: pidInfo, clrVersion: clr, entrypoint: 'ODCStudio', commandLine: '"' + exe + '"' }), applyStartupHook: async (endpoint, file) => { sent.push({ endpoint, file }); return { applied: true }; } } };
  return { deps, sent, exe };
}
const localSeconds = () => Math.floor(new Date(2025, 9, 19, 8, 12, 33).getTime() / 1000);

test('attachOdc: the right socket, then one ApplyStartupHook; a wrong key, a wrong pid, .NET 7, hooks off: refused before sending', async () => {
  const key = localSeconds('Oct 19 08:12:33 2025');
  const good = fakeMac({ sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key}-socket`] } });
  const attach = createMacAttach(good.deps);
  const result = await attach.attachOdc({ pid: 501, bridge: '/Users/ana/SSAM-Agent/odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll', version: 'v97' });
  assert.equal(result.attached, true);
  assert.equal(good.sent.length, 1);
  assert.equal(good.sent[0].endpoint, `/var/folders/x/T/dotnet-diagnostic-501-${key}-socket`);
  for (const [label, options, pattern] of [
    ['stale key', { sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key - 120}-socket`] } }, /belongs to a process started at/],
    ['other pid', { sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key}-socket`] }, pidInfo: 502 }, /answers for process 502/],
    ['net 7', { sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key}-socket`] }, clr: '7.0.20' }, /\.NET 8 or later/],
    ['hooks off', { sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key}-socket`] }, hooksOff: true }, /turns startup hooks off/],
    ['no socket', { sockets: {} }, /has no \.NET diagnostic socket/],
    ['outside /Applications', { sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key}-socket`] }, bundle: '/Users/ana/Downloads/ODC Studio.app' }, /not in \/Applications/],
  ]) {
    const c = fakeMac(options);
    if (options.bundle) { c.deps.fs.readdirSync = ((orig) => (dir, opts) => (dir === '/Applications' && opts?.withFileTypes ? [] : orig(dir, opts)))(c.deps.fs.readdirSync); }
    await assert.rejects(createMacAttach(c.deps).attachOdc({ pid: 501, bridge: '/x/ODC3.Bridge.v97.dll', version: 'v97' }), error => { assert.match(error.message, pattern, label); assert.equal(error.executed, false, label); return true; }, label);
    assert.equal(c.sent.length, 0, label + ': nothing sent');
  }
  // Another DLL name is refused before anything.
  await assert.rejects(attach.attachOdc({ pid: 501, bridge: '/x/Evil.dll', version: 'v97' }), /only attaches ODC3\.Bridge\.v97/);
  await assert.rejects(attach.attachOdc({ pid: 501, bridge: '/x/ODC3.Bridge.v970.dll', version: 'v97' }), /only attaches/);
});

test('the DST tolerance: a socket key exactly one hour off the ps start is accepted as the same process', async () => {
  const key = localSeconds('Oct 19 08:12:33 2025');
  const c = fakeMac({ sockets: { '/var/folders/x/T/': [`dotnet-diagnostic-501-${key + 3600}-socket`] } });
  const result = await createMacAttach(c.deps).attachOdc({ pid: 501, bridge: '/x/ODC3.Bridge.v97.dll', version: 'v97' });
  assert.equal(result.attached, true);
});

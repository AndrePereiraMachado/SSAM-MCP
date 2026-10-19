// The attach on macOS without .NET (lib/attach-unix.mjs): the checks of the Windows client and of Anvil.Connect, made with
// the facts of macOS, before anything is sent; then ApplyStartupHook once. Bundles and diagnostic sockets are files of a
// temporary folder, ps and lsof are text, the IPC requests and the start time readers are fakes. Also: o11.connect of
// lib/o11-connect.mjs with the macOS describe/attach (the hook.json carries the exact .NET start time text), and the
// odc.attach kind on darwin (no .NET client in the pack).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMacAttach } from '../lib/attach-unix.mjs';
import { dotnetStartTimeText } from '../lib/macos.mjs';
import { connectO11 } from '../lib/o11-connect.mjs';
import { createKinds } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { readPack } from '../lib/agent.mjs';
import { fakePe } from './fixtures/pe.mjs';
import { makeRoot, removeRoot } from './fixtures/agent-root.mjs';

// A POSIX spelling of a local folder (on Windows the drive is dropped: "/Users/..." is the same folder on this drive).
const posixOf = dir => dir.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
const START = 1760872353;

// home/Applications holds the Studios; tmp is TMPDIR. ps(...) lists processes; socket(pid, key) writes a diagnostic socket.
function mac() {
  const top = posixOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-attach-')));
  const home = top + '/home'; const tmp = top + '/tmp';
  fs.mkdirSync(home + '/Applications', { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const bundle = (name, kind = 'odc', { where = home + '/Applications', hooks } = {}) => {
    const root = `${where}/${name}`; const dir = `${root}/Contents/MacOS`;
    fs.mkdirSync(dir, { recursive: true });
    const names = kind === 'odc' ? ['OutSystems.Model.dll', 'OutSystems.Model.V1.dll', 'ServiceStudio.Framework.dll'] : ['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll'];
    for (const n of names) fs.writeFileSync(`${dir}/${n}`, 'x');
    const entry = kind === 'odc' ? 'ODCStudio' : 'ServiceStudio';
    fs.writeFileSync(`${dir}/${entry}.dll`, fakePe({ productVersion: kind === 'odc' ? '1.7.28.10873' : '11.55.92.65269' }));
    fs.writeFileSync(`${dir}/${entry}.runtimeconfig.json`, JSON.stringify({ runtimeOptions: { configProperties: hooks === undefined ? {} : { 'System.StartupHookProvider.IsSupported': hooks } } }));
    const exe = kind === 'odc' ? 'ODC Studio' : 'Service Studio';
    fs.writeFileSync(`${dir}/${exe}`, 'mach-o');
    fs.writeFileSync(`${root}/Contents/Info.plist`, `<plist><dict><key>CFBundleExecutable</key><string>${exe}</string><key>CFBundleShortVersionString</key><string>1</string></dict></plist>`);
    return { root, exe: `${dir}/${exe}` };
  };
  const lstart = seconds => { const d = new Date(seconds * 1000); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getFullYear()}`; };
  const psLine = (pid, seconds, exe) => `${String(pid).padStart(5)} ${lstart(seconds)} ${exe}`;
  const socket = (pid, key, ms = Date.now()) => { const file = `${tmp}/dotnet-diagnostic-${pid}-${key}-socket`; fs.writeFileSync(file, ''); fs.utimesSync(file, ms / 1000, ms / 1000); return file; };
  return { top, home, tmp, bundle, psLine, socket, remove: () => fs.rmSync(top, { recursive: true, force: true }) };
}

// The attach of one test: every fake records its calls.
function attachFor(m, { ps, info = pid => ({ pid, clrVersion: '8.0.31+abc', arch: 'arm64', os: 'MacOS' }), apply = async () => ({ applied: true }), readers, lsof = [] } = {}) {
  const calls = { apply: [], info: 0 };
  const run = async (file, args) => {
    if (file === '/usr/bin/getconf') throw new Error('no getconf here');
    if (file === '/usr/sbin/lsof') { if (lsof instanceof Error) throw lsof; return lsof.map(f => 'n' + f).join('\n') + '\n'; }
    throw new Error('unexpected tool ' + file);
  };
  const chosen = readers ?? { fake: async () => ({ sec: START, usec: 123456 }) };
  // Every reader here passed the check on processes of the agent (mac-start-check.test.mjs covers that check).
  const attach = createMacAttach({ run, env: { TMPDIR: m.tmp }, home: m.home, ps: typeof ps === 'function' ? ps : async () => ps,
    readers: chosen, calibrate: async () => ({ trusted: Object.keys(chosen), results: Object.keys(chosen).map(name => ({ name, ok: true, offsetsMs: [0.5], error: null })) }),
    ipc: { processInfo2: async (endpoint) => { calls.info++; return info(Number(/dotnet-diagnostic-(\d+)-/.exec(endpoint)[1])); },
      applyStartupHook: async (endpoint, file) => { calls.apply.push([endpoint, file]); return apply(endpoint, file); } } });
  return { attach, calls };
}
const refused = (promise, pattern) => assert.rejects(promise, error => { assert.equal(error.code, 'ATTACH_FAILED', error.message); assert.equal(error.executed, false, error.message); assert.match(error.message, pattern); return true; });

test('ODC attach on macOS: the installed bundle executable, its own diagnostic socket, .NET 8+, the pack bridge; one ApplyStartupHook', async () => {
  const m = mac();
  try {
    const studio = m.bundle('ODC Studio.app');
    const socket = m.socket(501, START);
    const bridge = m.top + '/ODC3.Bridge.v97.dll'; fs.writeFileSync(bridge, 'bridge');
    const { attach, calls } = attachFor(m, { ps: m.psLine(501, START, studio.exe) + '\n' + m.psLine(502, START, '/usr/libexec/other') });
    const result = await attach.attachOdc({ pid: 501, bridge, version: 'v97' });
    assert.deepEqual(result, { ok: true, attached: true, note: 'Run status before any other command; a bridge stays loaded until the Studio closes.' });
    assert.deepEqual(calls.apply, [[socket, path.resolve(bridge)]]);
    assert.equal(calls.info, 2, 'the identity is read again right before the request');
    assert.deepEqual(await attach.pipeFolders(501), [m.tmp + '/', '/tmp/']);
  } finally { m.remove(); }
});

test('ODC attach on macOS: every refusal comes before anything is sent', async () => {
  const m = mac();
  try {
    const studio = m.bundle('ODC Studio.app');
    const outside = m.bundle('ODC Studio.app', 'odc', { where: m.top + '/Downloads' });
    const hooksOff = m.bundle('Hooks Off.app', 'odc', { hooks: false });
    const bridge = m.top + '/ODC3.Bridge.v97.dll'; fs.writeFileSync(bridge, 'bridge');
    const other = m.top + '/ODC3.Bridge.v96.dll'; fs.writeFileSync(other, 'old');
    m.socket(501, START); m.socket(601, START); m.socket(701, START); m.socket(801, START + 10);
    const ps = [m.psLine(501, START, studio.exe), m.psLine(601, START, outside.exe), m.psLine(701, START, hooksOff.exe), m.psLine(801, START, studio.exe), m.psLine(901, START, studio.exe)].join('\n');
    const cases = [
      [{ pid: 501, bridge: other, version: 'v97' }, {}, /only attaches ODC3\.Bridge\.v97/],
      [{ pid: 501, bridge: m.top + '/ODC3.Bridge.v97.missing.dll', version: 'v97' }, {}, /missing/],
      [{ pid: 4242, bridge, version: 'v97' }, {}, /No ODC Studio process 4242/],
      [{ pid: 601, bridge, version: 'v97' }, {}, /not in \/Applications or ~\/Applications/],
      [{ pid: 701, bridge, version: 'v97' }, {}, /turns startup hooks off/],
      [{ pid: 801, bridge, version: 'v97' }, {}, /belongs to a process started at/],
      [{ pid: 901, bridge, version: 'v97' }, {}, /no \.NET diagnostic socket/],
      [{ pid: 501, bridge, version: 'v97' }, { info: pid => ({ pid, clrVersion: '7.0.1' }) }, /requires \.NET 8 or later/],
      [{ pid: 501, bridge, version: 'v97' }, { info: () => ({ pid: 77, clrVersion: '8.0.1' }) }, /answers for process 77/],
      [{ pid: 501, bridge, version: 'v97' }, { info: () => { throw new Error('IPC_TIMEOUT'); } }, /did not answer ProcessInfo2/],
    ];
    for (const [params, options, pattern] of cases) {
      const { attach, calls } = attachFor(m, { ps, ...options });
      await refused(attach.attachOdc(params), pattern);
      assert.deepEqual(calls.apply, [], 'nothing was sent: ' + pattern);
    }
  } finally { m.remove(); }
});

test('ODC attach on macOS: a Studio that restarted while preparing is refused; a failed request is unknown unless nothing was written', async () => {
  const m = mac();
  try {
    const studio = m.bundle('ODC Studio.app');
    const bridge = m.top + '/ODC3.Bridge.v97.dll'; fs.writeFileSync(bridge, 'bridge');
    m.socket(501, START, Date.now() - 60000);
    let listings = 0;
    // The second listing sees the same pid started again (a new socket, newer).
    const ps = async () => { listings++; if (listings === 2) { m.socket(501, START + 5); return m.psLine(501, START + 5, studio.exe); } return m.psLine(501, listings > 2 ? START + 5 : START, studio.exe); };
    const changed = attachFor(m, { ps });
    await refused(changed.attach.attachOdc({ pid: 501, bridge, version: 'v97' }), /changed while preparing/);
    assert.deepEqual(changed.calls.apply, []);
    const ps2 = m.psLine(501, START + 5, studio.exe);
    const unknown = attachFor(m, { ps: ps2, apply: async () => { throw Object.assign(new Error('closed'), { sent: true }); } });
    await assert.rejects(unknown.attach.attachOdc({ pid: 501, bridge, version: 'v97' }), e => e.code === 'ATTACH_FAILED' && e.executed === null && /never repeat it before status/.test(e.message));
    const absent = attachFor(m, { ps: ps2, apply: async () => { throw Object.assign(new Error('gone'), { sent: false }); } });
    await assert.rejects(absent.attach.attachOdc({ pid: 501, bridge, version: 'v97' }), e => e.code === 'ATTACH_FAILED' && e.executed === false);
  } finally { m.remove(); }
});

test('Service Studio describe on macOS: the exact .NET start time text, the Anvil assemblies already mapped, the diagnostics state', async () => {
  const m = mac();
  try {
    const studio = m.bundle('Service Studio.app', 'o11');
    m.socket(601, START);
    const dlls = ['/Applications/Service Studio.app/Contents/MacOS/ServiceStudio.Framework.dll', '/usr/lib/libSystem.B.dylib'];
    const ps = m.psLine(601, START, studio.exe) + '\n' + m.psLine(602, START, studio.exe.replace('Service Studio', 'Other'));
    const { attach } = attachFor(m, { ps, lsof: dlls });
    const described = await attach.describeO11(601);
    assert.equal(described.startedUtc, dotnetStartTimeText(START, 123456));
    assert.match(described.startedUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/);
    assert.deepEqual([described.ok, described.pid, described.version, described.bridgePath, described.corePath, described.diagnosticsAvailable, described.runtime],
      [true, 601, '11.55.92.65269', null, null, true, '8.0.31+abc']);
    assert.equal(described.studioDir, studio.root + '/Contents/MacOS');
    const loaded = attachFor(m, { ps, lsof: [...dlls, '/Users/ana/old/Anvil.Bridge.dll'] });
    assert.equal((await loaded.attach.describeO11(601)).bridgePath, '/Users/ana/old/Anvil.Bridge.dll');
    // No diagnostic socket: described as unavailable (o11-connect refuses it), the ps start checks the readers.
    const quiet = m.bundle('Quiet.app', 'o11');
    const withoutSocket = attachFor(m, { ps: m.psLine(701, START, quiet.exe), lsof: dlls });
    assert.equal((await withoutSocket.attach.describeO11(701)).diagnosticsAvailable, false);
    // Without a reader that agrees with the kernel, or without lsof, nothing goes further.
    await refused(attachFor(m, { ps, lsof: dlls, readers: { perl: async () => { throw new Error('no perl'); }, osascript: async () => ({ sec: START - 1, usec: 1 }) } }).attach.describeO11(601), /perl: no perl; osascript: \d+ s, the kernel says/);
    await refused(attachFor(m, { ps, lsof: new Error('lsof: not permitted') }).attach.describeO11(601), /cannot be listed \(lsof/);
    await refused(attachFor(m, { ps, lsof: ['/usr/lib/libSystem.B.dylib'] }).attach.describeO11(601), /lsof lists no managed DLL/);
  } finally { m.remove(); }
});

test('Service Studio attach on macOS: the same start text, the hook file, one ApplyStartupHook; and o11.connect writes that text in hook.json', async () => {
  const m = mac();
  const root = makeRoot({ lanes: ['o11'], odcBridge: null, o11BuiltFor: '11.55.92' });
  try {
    const studio = m.bundle('Service Studio.app', 'o11');
    const socket = m.socket(601, START);
    const lsof = ['/x/ServiceStudio.Framework.dll'];
    const ps = m.psLine(601, START, studio.exe);
    const hook = m.top + '/hook.dll'; fs.writeFileSync(hook, 'hook');
    const { attach, calls } = attachFor(m, { ps, lsof });
    const text = dotnetStartTimeText(START, 123456);
    await refused(attach.attachO11(601, '2026-10-19T00:00:00.0000000Z', hook), /process changed/);
    await refused(attach.attachO11(601, text, m.top + '/missing.dll'), /Hook not found/);
    assert.deepEqual(await attach.attachO11(601, text, hook), { ok: true, hookRequested: true });
    assert.deepEqual(calls.apply, [[socket, path.resolve(hook)]]);

    // o11-connect.mjs with the macOS describe/attach: the hook copy and its .json carry the exact text.
    fs.mkdirSync(path.join(root, 'bin', 'o11', 'hook'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'o11', 'hook', 'Anvil.RuntimeHook.Agent.dll'), 'hook');
    let attached = null;
    const record = await connectO11({ root, pid: 601, port: 4999, studioVersion: '11.55.92.65269', describe: attach.describeO11,
      attach: async (pid, startedUtc, file) => { attached = { pid, startedUtc, json: JSON.parse(fs.readFileSync(file + '.json', 'utf8')) }; fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'key'); return attach.attachO11(pid, startedUtc, file); },
      probe: async () => (attached ? { connected: true, pid: 601, manifest: {} } : { connected: false, occupied: false }),
      request: async () => ({ success: true, data: { alive: true } }), sleep: async () => {}, pack: readPack(root) });
    assert.equal(attached.startedUtc, text);
    assert.equal(attached.json.startedUtc, text);
    assert.equal(attached.json.pid, 601);
    assert.equal(record.startedUtc, text);
    assert.equal(record.connected, true);
  } finally { m.remove(); removeRoot(root); }
});

test('odc.attach on darwin: the bridge of the pack only (no .NET client), with the pack version; Windows still needs the client', async () => {
  const root = makeRoot({ lanes: ['odc'], odcBridge: 'v97', o11BuiltFor: null });
  try {
    const bridge = path.join(root, 'odc', 'studio', 'bridge', 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v97.dll');
    fs.mkdirSync(path.dirname(bridge), { recursive: true }); fs.writeFileSync(bridge, 'b');
    const seen = [];
    const kindsOf = platform => createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => ({ odc: '1.7.28', odcBridge: 'v97' }), limits: () => ({}), platform,
      deps: { processes: async () => [{ pid: 501, path: '/Applications/ODC Studio.app/Contents/MacOS/ODC Studio', version: '1.7.28.10873' }], fileVersion: async () => null,
        attachOdc: async params => { seen.push(params); return { ok: true, attached: true, note: 'n' }; } } });
    assert.deepEqual(await kindsOf('darwin').execute('odc.attach', { pid: 501 }), { ok: true, attached: true, pid: 501, version: 'v97', note: 'n' });
    assert.deepEqual(seen, [{ pid: 501, bridge, version: 'v97' }]);
    await assert.rejects(kindsOf('win32').execute('odc.attach', { pid: 501 }), e => e.code === 'ATTACH_FAILED' && /ODC3\.Bridge\.Client\.dll/.test(e.message));
    await assert.rejects(kindsOf('darwin').execute('odc.attach', { pid: 9 }), e => e.code === 'STUDIO_NOT_SELECTED' && /No ODC Studio process 9/.test(e.message));
  } finally { removeRoot(root); }
});

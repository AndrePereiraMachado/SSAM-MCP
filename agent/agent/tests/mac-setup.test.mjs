// setup, the root rule and doctor on macOS (ssam-agent.mjs with platform 'darwin', lib/mac-doctor.mjs): the POSIX root
// (no space, outside the folders macOS guards, the temporary folders and /Volumes), private/ restricted BEFORE the
// credential is written (chmod 700, faked here), the credential never printed, and the doctor's macOS checks with their
// next steps, in lines and in JSON. Every text is English (fixtures/portuguese.mjs). The macOS tools are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { setup, doctor, rootProblem, posixRootProblem, runAgent } from '../ssam-agent.mjs';
import { LAYOUT } from '../lib/workspace.mjs';
import { CREDENTIAL } from './fixtures/agent-root.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';
import { fakePe } from './fixtures/pe.mjs';
import { encodeMessage } from '../lib/dotnet-ipc.mjs';

const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };
const input = text => Object.assign(Readable.from([text]), { isTTY: false });
const posixOf = dir => dir.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
const sha = text => createHash('sha256').update(text).digest('hex');
const texts = [];
const english = () => { const found = texts.flatMap(([where, text]) => { const f = portugueseIn(text); return f.length ? [describe(where, f)] : []; }); assert.equal(found.join('\n'), '', 'Portuguese the customer would see'); };

test('the macOS root: absolute, no space, outside Desktop, Documents, Downloads, iCloud and cloud folders, temporary folders and /Volumes', () => {
  const env = { HOME: '/Users/ana', TMPDIR: '/var/folders/x1/abc/T/' };
  assert.equal(posixRootProblem('/Users/ana/SSAM-Agent', env), null);
  assert.equal(rootProblem('/Users/ana/SSAM-Agent', env, 'darwin'), null);
  // A folder of macOS or of the applications is refused too (review M2, mac-root.test.mjs).
  assert.match(posixRootProblem('/opt/ssam', env), /inside \/opt, a folder of macOS or of the applications/);
  const cases = [['/Users/ana/My Agent', /has a space.*--root \/Users\/ana\/SSAM-Agent/], ['SSAM-Agent', /absolute path, such as \/Users\/ana\/SSAM-Agent/],
    ['/Users/ana/Desktop/SSAM', /inside \/Users\/ana\/Desktop, which macOS guards/], ['/Users/ana/documents/SSAM', /inside \/Users\/ana\/Documents/],
    ['/Users/ana/Downloads', /Downloads/], ['/Users/ana/Library/CloudStorage/OneDrive-X/a', /CloudStorage/], ['/tmp/agent', /temporary folder/],
    ['/private/var/folders/x1/abc/T/agent', /temporary folder/], ['/var/folders/x1/abc/T', /temporary folder/], ['/Volumes/USB/SSAM-Agent', /another volume/]];
  for (const [root, pattern] of cases) { const problem = posixRootProblem(root, env); assert.match(problem ?? '', pattern, root); texts.push(['root ' + root, problem]); }
  // Windows is unchanged.
  assert.match(rootProblem('\\\\server\\share\\SSAM-Agent', {}, 'win32'), /drive letter/);
  assert.equal(rootProblem('C:\\SSAM-Agent', {}, 'win32'), null);
});

test('setup on macOS: the layout, private/ closed BEFORE the credential, the credential never printed, the next step in agent/ssam-agent.sh', async () => {
  const top = posixOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-setup-mac-')));
  const env = { HOME: top + '/home' };
  const root = top + '/SSAM-Agent';
  try {
    const order = []; const stdout = sink(); const stderr = sink();
    const code = await setup({ root, server: 'https://mcp.ssam.pro/', stdin: input(CREDENTIAL + '\n'), stdout, stderr, env, platform: 'darwin',
      restrict: async dir => { order.push({ dir, credentialThen: fs.existsSync(path.join(root, 'private', 'credential')) }); }, icacls: async () => assert.fail('no icacls on a Mac') });
    assert.equal(code, 0, stderr.text());
    assert.deepEqual(order, [{ dir: path.join(root, 'private'), credentialThen: false }]);
    assert.equal(fs.readFileSync(path.join(root, 'private', 'credential'), 'utf8'), CREDENTIAL);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'private', 'config.json'), 'utf8')), { server: 'https://mcp.ssam.pro', o11Port: 4516 });
    for (const folder of LAYOUT) assert.ok(fs.statSync(path.join(root, ...folder.split('/'))).isDirectory(), folder);
    const out = stdout.text() + stderr.text();
    assert.match(out, /saved in private\/credential/);
    assert.match(out, new RegExp('Next step: ' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/agent/ssam-agent.sh start'));
    assert.equal(out.includes(CREDENTIAL) || out.includes(CREDENTIAL.slice(11)), false);
    texts.push(['setup ok', out]);
    // Refusals before the credential is read (the stream stays unread).
    for (const [name, options] of [['relative root', { root: 'SSAM-Agent' }], ['guarded root', { root: env.HOME + '/Desktop/SSAM' }], ['root with a space', { root: top + '/SSAM Agent' }],
      ['plain http', { server: 'http://ssam.example.com' }], ['bad port', { o11Port: '22' }], ['no server', { server: undefined }]]) {
      const stream = input(CREDENTIAL); const err = sink();
      assert.equal(await setup({ root, server: 'https://mcp.ssam.pro', stdin: stream, stdout: sink(), stderr: err, env, platform: 'darwin', restrict: async () => {}, ...options }), 1, name);
      texts.push(['setup ' + name, err.text()]);
      assert.match(err.text(), /^Error: /);
    }
    const failing = sink();
    assert.equal(await setup({ root, server: 'https://mcp.ssam.pro', stdin: input(CREDENTIAL), stdout: sink(), stderr: failing, env, platform: 'darwin',
      restrict: async () => { throw new Error('Operation not permitted'); } }), 1);
    assert.match(failing.text(), /restrict private\/ to the current user \(chmod 700\): Operation not permitted/);
    texts.push(['setup chmod fails', failing.text()]);
    const bad = sink();
    assert.equal(await setup({ root, server: 'https://mcp.ssam.pro', stdin: input('ssam_wrong'), stdout: sink(), stderr: bad, env, platform: 'darwin', restrict: async () => {} }), 1);
    texts.push(['setup bad credential', bad.text()]);
    // run names the macOS guide and launcher.
    const bare = top + '/bare'; fs.mkdirSync(bare + '/private', { recursive: true });
    const runErr = sink();
    assert.equal(await runAgent({ root: bare, stderr: runErr, platform: 'darwin' }), 1);
    assert.match(runErr.text(), /docs\/AGENTE-MAC\.md/);
    texts.push(['run without setup', runErr.text()]);
  } finally { fs.rmSync(top.replace(/^\//, path.parse(os.tmpdir()).root), { recursive: true, force: true }); }
  english();
});

// A Mac in a temporary folder: a Studio bundle of each lane in ~/Applications, a pack and a configuration.
function macHome() {
  const top = posixOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-doctor-mac-')));
  const home = top + '/home'; const tmp = top + '/tmp'; const root = home + '/SSAM-Agent';
  const bundle = (name, kind, exe, version) => {
    const dir = `${home}/Applications/${name}/Contents/MacOS`;
    fs.mkdirSync(dir, { recursive: true });
    for (const n of kind === 'odc' ? ['OutSystems.Model.dll', 'OutSystems.Model.V1.dll', 'ServiceStudio.Framework.dll'] : ['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll']) fs.writeFileSync(`${dir}/${n}`, 'x');
    const entry = kind === 'odc' ? 'ODCStudio' : 'ServiceStudio';
    fs.writeFileSync(`${dir}/${entry}.dll`, fakePe({ productVersion: version }));
    fs.writeFileSync(`${dir}/${entry}.runtimeconfig.json`, '{"runtimeOptions":{"configProperties":{}}}');
    const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4);
    fs.writeFileSync(`${dir}/${exe}`, macho);
    fs.writeFileSync(`${home}/Applications/${name}/Contents/Info.plist`, `<plist><dict><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>`);
    return `${dir}/${exe}`;
  };
  const odcExe = bundle('ODC Studio.app', 'odc', 'ODC Studio', '1.7.28.10873');
  const o11Exe = bundle('Service Studio.app', 'o11', 'ServiceStudio', '11.55.92.65269');
  fs.mkdirSync(root + '/private', { recursive: true }); fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(root + '/agent', { recursive: true });
  fs.writeFileSync(root + '/agent/ssam-agent.mjs', 'code');
  fs.writeFileSync(root + '/pack.json', JSON.stringify({ id: 'pack-mac-test', platform: 'darwin', lanes: ['odc', 'o11'], odcBridge: 'v97', o11BuiltFor: '11.55.92', files: [{ path: 'agent/ssam-agent.mjs', sha256: sha('code'), size: 4 }] }));
  fs.writeFileSync(root + '/private/config.json', JSON.stringify({ server: 'https://mcp.ssam.pro', o11Port: 4516 }));
  fs.writeFileSync(root + '/private/credential', CREDENTIAL);
  return { top, home, tmp, root, odcExe, o11Exe, remove: () => fs.rmSync(top.replace(/^\//, path.parse(os.tmpdir()).root), { recursive: true, force: true }) };
}
const START = 1760872353;
const psLine = (pid, seconds, exe) => { const d = new Date(seconds * 1000); return `${pid} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getFullYear()} ${exe}`; };

function probes() {
  const clock = [START * 1000 + 120, START * 1000 + 121, START * 1000 + 420, START * 1000 + 421];
  let tick = 0; let pid = 9001;
  return { clock: () => clock[Math.min(tick++, clock.length - 1)], sleep: async () => {}, spawnChild: () => ({ pid: pid++, kill() {} }) };
}
function macDeps(h, { readers, socket = true, sw = '15.5' } = {}) {
  if (socket) { fs.writeFileSync(`${h.tmp}/dotnet-diagnostic-501-${START}-socket`, ''); fs.writeFileSync(`${h.tmp}/dotnet-diagnostic-601-${START}-socket`, ''); }
  const run = async (file, args) => {
    if (file === '/usr/bin/sw_vers') return sw + '\n';
    if (file === '/usr/sbin/sysctl') return args[1] === 'hw.optional.arm64' ? '1\n' : '0\n';
    if (file === '/usr/bin/getconf') return h.tmp + '/\n';
    if (file === '/usr/bin/codesign') return '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';
    if (file === '/usr/sbin/lsof') return 'p601\nn/x/ServiceStudio.Framework.dll\nn/x/OutSystems.Model.V1.dll\n';
    throw new Error('unexpected ' + file);
  };
  return { platform: 'darwin', env: { HOME: h.home, TMPDIR: h.tmp }, flags: new Set(['--use-env-proxy', '--use-system-ca']), fetch: async () => ({ ok: true, status: 200 }),
    // The check of the readers runs on two processes of the agent (pids 9001 and 9002, started at START.120 and START.420).
    mac: { run, env: { HOME: h.home, TMPDIR: h.tmp }, home: h.home, ...probes(),
      readers: readers ?? { perl: async pid => ({ sec: START, usec: { 9001: 120400, 9002: 420300 }[pid] ?? 123456 }), osascript: async () => { throw new Error('ObjC bridge refused'); } },
      ps: async () => [psLine(501, START, h.odcExe), psLine(601, START, h.o11Exe), psLine(777, START, '/Applications/OutSystems Thing.app/Contents/MacOS/Thing')].join('\n'),
      ipc: { processInfo2: async endpoint => ({ pid: Number(/diagnostic-(\d+)-/.exec(endpoint)[1]), clrVersion: '8.0.31+abc', arch: 'arm64', os: 'MacOS', entrypoint: endpoint.includes('diagnostic-501-') ? 'ODCStudio' : 'ServiceStudio', commandLine: '"' + fs.realpathSync(endpoint.includes('diagnostic-501-') ? h.odcExe : h.o11Exe) + '"' }) } } };
}

test('doctor on macOS: no .NET needed, each Studio bundle and running Studio with its socket, runtime, bridge and start readers; JSON for the owner', async () => {
  const h = macHome();
  try {
    const out = sink();
    const code = await doctor({ root: h.root, stdout: out, deps: macDeps(h) });
    const text = out.text();
    texts.push(['doctor mac', text]);
    assert.equal(code, 0, text);
    assert.match(text, /\[ok\] attach: the agent speaks the \.NET diagnostic IPC itself/);
    assert.match(text, /\[ok\] macOS: 15\.5 on arm64/);
    assert.match(text, /\[ok\] ODC Studio: 1\.7\.28\.10873 in .*ODC Studio\.app \(arm64; managed DLLs in Contents\/MacOS; version from ProductVersion of ODCStudio\.dll\)/);
    assert.match(text, /\[ok\] Service Studio: 11\.55\.92\.65269/);
    assert.match(text, /\[ok\] start time with microseconds \(Service Studio hook\): perl ok \(0\.400 and 0\.300 ms after the start of processes the agent started\); osascript failed: ObjC bridge refused/);
    assert.match(text, /\[ok\] ODC Studio 501 running: \.NET 8\.0\.31\+abc \(arm64\); bridge v97 not attached yet/);
    assert.match(text, /\[ok\] Service Studio 601 running: \.NET 8\.0\.31\+abc \(arm64\)/);
    assert.match(text, /\[warn\] unrecognized Studio processes: 777 \/Applications\/OutSystems Thing\.app/);
    assert.equal(text.includes(CREDENTIAL), false);
    const json = sink();
    assert.equal(await doctor({ root: h.root, stdout: json, deps: macDeps(h), json: true }), 0);
    const report = JSON.parse(json.text());
    assert.equal(report.platform, 'darwin'); assert.equal(report.ok, true); assert.equal(report.pack.odcBridge, 'v97');
    assert.deepEqual(report.mac.running.map(r => [r.lane, r.pid, r.runtime, r.socketKey]), [['odc', 501, '8.0.31+abc', START], ['o11', 601, '8.0.31+abc', START]]);
    assert.deepEqual(report.mac.running[1].startReaders, { good: ['perl'], bad: ['osascript: did not pass the check on processes of the agent'], agree: true, usec: { perl: 123456 } });
    assert.equal(report.mac.studios.length, 2);
    assert.equal(json.text().includes(CREDENTIAL), false);
  } finally { h.remove(); }
  english();
});

test('doctor on macOS: a Studio without a diagnostic socket and no working start reader are said with the next step (the reader is required with Service Studio)', async () => {
  const h = macHome();
  try {
    const out = sink();
    const code = await doctor({ root: h.root, stdout: out, deps: macDeps(h, { socket: false, sw: '13.6', readers: { perl: async () => { throw new Error('syscall: Operation not permitted'); } } }) });
    const text = out.text();
    texts.push(['doctor mac failing', text]);
    assert.equal(code, 1, text);
    assert.match(text, /\[warn\] macOS: 13\.6 on arm64; ODC Studio needs macOS 14/);
    assert.match(text, /\[fail\] start time with microseconds \(Service Studio hook\): perl failed: syscall: Operation not permitted\. Without it the Service Studio lane cannot connect/);
    assert.match(text, /\[warn\] ODC Studio 501 running: no \.NET diagnostic socket .*DOTNET_EnableDiagnostics=0/);
  } finally { h.remove(); }
  english();
});

// The low findings of the macOS review, one test each (B4, B5, B7; B6 is in mac-node.test.mjs):
//   B4  --credential-file inside a folder macOS guards or syncs (Desktop, Documents, Downloads, iCloud Drive, cloud
//       folders) is refused before it is read; any other one is used and the person is told to delete it now;
//   B5  the doctor says "open the Studio" for a Studio that is installed and not running;
//   B7  a runtimeconfig.json the agent cannot read stops the attach before anything is sent (it cannot tell whether
//       startup hooks are on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setup } from '../ssam-agent.mjs';
import { macDoctor } from '../lib/mac-doctor.mjs';
import { createMacAttach } from '../lib/attach-unix.mjs';
import { CREDENTIAL } from './fixtures/agent-root.mjs';
import { fakePe } from './fixtures/pe.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const texts = [];
const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };
const posixOf = dir => dir.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
const realOf = posix => posix.replace(/^\//, path.parse(os.tmpdir()).root);
const english = () => { const found = texts.flatMap(([where, text]) => { const f = portugueseIn(String(text ?? '')); return f.length ? [describe(where, f)] : []; }); assert.equal(found.join('\n'), '', 'Portuguese the customer would see'); };

test('B4: a credential file in a folder macOS guards or syncs is refused before it is read; another one is used and the person is told to delete it', async () => {
  const top = posixOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-cred-')));
  const env = { HOME: top + '/home' };
  try {
    for (const where of ['Downloads', 'Desktop', 'Documents', 'Library/Mobile Documents/com~apple~CloudDocs', 'Library/CloudStorage/OneDrive-X', 'downloads']) {
      const file = `${env.HOME}/${where}/cred.txt`;
      fs.mkdirSync(realOf(path.posix.dirname(file)), { recursive: true }); fs.writeFileSync(realOf(file), CREDENTIAL + '\n');
      const err = sink();
      const code = await setup({ root: top + '/SSAM-Agent', server: 'https://mcp.ssam.pro', credentialFile: file, stdout: sink(), stderr: err, env, platform: 'darwin', restrict: async () => {} });
      texts.push(['credential in ' + where, err.text()]);
      assert.equal(code, 1, where + ': ' + err.text());
      assert.match(err.text(), /macOS guards or syncs/, where);
      assert.match(err.text(), /paste the credential when install\.sh asks/, where);
      assert.equal(fs.existsSync(realOf(top + '/SSAM-Agent/private/credential')), false, where);
      assert.equal(err.text().includes(CREDENTIAL.slice(11)), false);
    }
    const file = top + '/cred.txt';
    fs.writeFileSync(realOf(file), CREDENTIAL + '\n');
    const out = sink(); const err = sink();
    assert.equal(await setup({ root: top + '/SSAM-Agent', server: 'https://mcp.ssam.pro', credentialFile: file, stdout: out, stderr: err, env, platform: 'darwin', restrict: async () => {} }), 0, err.text());
    texts.push(['credential file used', out.text()]);
    assert.match(out.text(), new RegExp(`Delete ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} now: the credential is saved in private/credential`));
    assert.equal(fs.readFileSync(realOf(file), 'utf8'), CREDENTIAL + '\n', 'the agent does not delete a file it did not create');
  } finally { fs.rmSync(realOf(top), { recursive: true, force: true }); }
  english();
});

// A Studio bundle of a lane in <top>/home/Applications (real files), with an optional runtimeconfig.json text.
function bundle(top, kind, runtimeConfig = '{"runtimeOptions":{"configProperties":{}}}') {
  const name = kind === 'odc' ? 'ODC Studio' : 'Service Studio';
  const dir = `${top}/home/Applications/${name}.app/Contents/MacOS`;
  fs.mkdirSync(realOf(dir), { recursive: true });
  const dlls = kind === 'odc' ? ['OutSystems.Model.dll', 'OutSystems.Model.V1.dll', 'ServiceStudio.Framework.dll'] : ['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll'];
  for (const n of dlls) fs.writeFileSync(realOf(`${dir}/${n}`), 'x');
  const entry = kind === 'odc' ? 'ODCStudio' : 'ServiceStudio';
  fs.writeFileSync(realOf(`${dir}/${entry}.dll`), fakePe({ productVersion: kind === 'odc' ? '1.7.28.10873' : '11.55.92.65269' }));
  fs.writeFileSync(realOf(`${dir}/${entry}.runtimeconfig.json`), runtimeConfig);
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4);
  fs.writeFileSync(realOf(`${dir}/${name}`), macho);
  fs.writeFileSync(realOf(`${top}/home/Applications/${name}.app/Contents/Info.plist`), `<plist><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`);
  return { exe: `${dir}/${name}`, bundle: `${top}/home/Applications/${name}.app` };
}
const START = 1760872353;
const lstart = seconds => { const d = new Date(seconds * 1000); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getFullYear()}`; };

test('B5: the doctor says to open a Studio that is installed and not running, with where it is', async () => {
  const top = posixOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-closed-')));
  try {
    const odc = bundle(top, 'odc'); bundle(top, 'o11');
    const run = async (file, args) => { if (file === '/usr/bin/sw_vers') return '15.5\n'; if (file === '/usr/sbin/sysctl') return args[1] === 'hw.optional.arm64' ? '1\n' : '0\n'; throw new Error('no ' + file); };
    const { checks } = await macDoctor({ pack: { lanes: ['odc', 'o11'] }, deps: { run, env: { HOME: top + '/home', TMPDIR: top + '/tmp' }, home: top + '/home',
      ps: async () => `  501 ${lstart(START)} ${odc.exe}\n`, calibrate: async () => ({ trusted: [], results: [] }),
      ipc: { processInfo2: async () => { throw new Error('no socket here'); } } } });
    const closed = checks.find(c => /^Service Studio\b.*running$/.test(c.name) || c.name === 'Service Studio running');
    assert.ok(closed, checks.map(c => c.name).join(' | '));
    assert.equal(closed.ok, false); assert.equal(closed.required, false);
    assert.match(closed.detail, /installed but not running: open it .*Service Studio\.app.* from the Dock or Finder, sign in, then run this doctor again/);
    texts.push(['doctor closed', closed.detail]);
    assert.equal(checks.some(c => c.name === 'ODC Studio running'), false, 'a running Studio is not said to be closed');
  } finally { fs.rmSync(realOf(top), { recursive: true, force: true }); }
  english();
});

test('B7: a runtimeconfig.json the agent cannot read stops the attach before anything is sent (ODC and Service Studio)', async () => {
  const top = posixOf(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-rtconfig-')));
  try {
    const odc = bundle(top, 'odc', '{ this is not JSON');
    const o11 = bundle(top, 'o11', '');
    fs.mkdirSync(realOf(top + '/tmp'), { recursive: true });
    for (const pid of [501, 601]) fs.writeFileSync(realOf(`${top}/tmp/dotnet-diagnostic-${pid}-${START}-socket`), '');
    const bridge = top + '/ODC3.Bridge.v97.dll'; fs.writeFileSync(realOf(bridge), 'bridge');
    const sent = [];
    const attach = createMacAttach({ env: { TMPDIR: top + '/tmp' }, home: top + '/home', ps: async () => `  501 ${lstart(START)} ${odc.exe}\n  601 ${lstart(START)} ${o11.exe}\n`,
      run: async file => { if (file === '/usr/sbin/lsof') return 'n/x/ServiceStudio.Framework.dll\n'; throw new Error('no ' + file); },
      readers: { fake: async () => ({ sec: START, usec: 5 }) }, calibrate: async () => ({ trusted: ['fake'], results: [] }),
      ipc: { processInfo2: async endpoint => ({ pid: Number(/diagnostic-(\d+)-/.exec(endpoint)[1]), clrVersion: '8.0.31' }), applyStartupHook: async (...args) => { sent.push(args); return { applied: true }; } } });
    for (const [label, call] of [['ODC', () => attach.attachOdc({ pid: 501, bridge, version: 'v97' })], ['Service Studio', () => attach.describeO11(601)]]) {
      await assert.rejects(call(), error => {
        assert.equal(error.code, 'ATTACH_FAILED', label); assert.equal(error.executed, false, label);
        assert.match(error.message, /runtimeconfig\.json .*cannot be read/, label);
        assert.match(error.message, /Nothing was sent/, label);
        texts.push(['runtimeconfig ' + label, error.message]);
        return true;
      }, label);
    }
    assert.deepEqual(sent, []);
  } finally { fs.rmSync(realOf(top), { recursive: true, force: true }); }
  english();
});

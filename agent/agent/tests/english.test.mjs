// Owner rule of 2026-10-15 ("every text SSAM emits is English only"): the agent, its PowerShell script, the pack and the
// customer guide show the licensee no Portuguese (fixtures/portuguese.mjs says what counts as Portuguese).
//   - static: the whole text of every file the pack takes from this box (agent\ssam-agent.mjs, agent\ssam-agent.ps1 and
//     agent\lib\*.mjs, comments included, because the customer receives these sources) and of docs/AGENTE-CLIENTE.md;
//   - dynamic: what setup, doctor, status, run and the argument errors print; what ssam-agent.ps1 start, status and stop
//     print without a running agent (with each exit code it explains); and every text file of a pack built by
//     scripts/agent-pack.ps1 -NoBuild -Prebuilt (as pack.test.mjs builds it).
// ALLOW is the only exception list: file (relative to the box) -> [[exact text, reason]].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setup, doctor, status, runAgent, main } from '../ssam-agent.mjs';
import { CREDENTIAL, makeRoot, removeRoot } from './fixtures/agent-root.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const box = path.resolve(agentDir, '..');
const COM_DEVICES = ['|com[0-9¹²³]|', 'the Windows device names COM1..COM9 in the reserved-name rule of the agent folder (not the Portuguese "com")'];
const ALLOW = { 'agent/lib/workspace.mjs': [COM_DEVICES] };
const allowFor = rel => (ALLOW[rel] ?? []).map(([text]) => text);
const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };
const input = text => Object.assign(Readable.from([text]), { isTTY: false });
const ENV = { USERDOMAIN: 'CONTOSO', USERNAME: 'customer' };
const sha = text => createHash('sha256').update(text).digest('hex');

// Every finding of every text, one line each; empty when all is English.
function findings(texts) {
  const out = [];
  for (const [where, text, allow = []] of texts) { const found = portugueseIn(text, { allow }); if (found.length) out.push(describe(where, found)); }
  return out.join('\n');
}
const assertEnglish = texts => { const found = findings(texts); assert.equal(found, '', `Portuguese the customer would see (${found.split('\n').length} findings):\n${found}`); };

test('static: the agent sources the pack carries (comments included) and the customer guide are English only', () => {
  const shipped = ['agent/ssam-agent.mjs', 'agent/ssam-agent.ps1',
    ...fs.readdirSync(path.join(agentDir, 'lib')).filter(name => name.endsWith('.mjs')).sort().map(name => 'agent/lib/' + name), 'docs/AGENTE-CLIENTE.md'];
  assertEnglish(shipped.map(rel => [rel, fs.readFileSync(path.join(box, ...rel.split('/')), 'utf8'), allowFor(rel)]));
});

test('dynamic: what setup, doctor, status, run and the argument errors print is English only', async () => {
  const texts = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-english-'));
  const root = path.join(work, 'SSAM-Agent');
  try {
    // setup: every refusal, then a good setup.
    const setupWith = async (name, options) => {
      const stdout = sink(); const stderr = sink();
      const code = await setup({ root, server: 'https://ssam.example.com', stdin: input(CREDENTIAL), stdout, stderr, env: ENV, icacls: async () => {}, ...options });
      texts.push(['setup ' + name + ' (exit ' + code + ')', stdout.text() + stderr.text()]);
      return code;
    };
    assert.equal(await setupWith('without --server', { server: undefined }), 1);
    assert.equal(await setupWith('with an address that is not a URL', { server: 'not a url' }), 1);
    assert.equal(await setupWith('with plain http to another host', { server: 'http://ssam.example.com' }), 1);
    assert.equal(await setupWith('with a bad --o11-port', { o11Port: '80' }), 1);
    assert.equal(await setupWith('with a root that has a space', { root: path.join(work, 'SSAM Agent') }), 1);
    assert.equal(await setupWith('with a UNC root', { root: '\\\\server\\share\\SSAM-Agent' }), 1);
    assert.equal(await setupWith('with a root under LOCALAPPDATA', { env: { ...ENV, LOCALAPPDATA: work } }), 1);
    assert.equal(await setupWith('with an unreadable credential file', { credentialFile: path.join(work, 'missing.txt') }), 1);
    assert.equal(await setupWith('with a malformed credential', { stdin: input('ssam_wrong_format') }), 1);
    assert.equal(await setupWith('when icacls fails', { icacls: async () => { throw new Error('Access is denied.'); } }), 1);
    assert.equal(await setupWith('that succeeds', {}), 0);

    // run: without setup.
    const bare = makeRoot();
    try {
      const stderr = sink();
      assert.equal(await runAgent({ root: bare, stderr }), 1);
      texts.push(['run without setup', stderr.text()]);
      const out = sink();
      status({ root: bare, stdout: out });
      texts.push(['status', out.text()]);
    } finally { removeRoot(bare); }

    // doctor: every check passing, then every check failing (missing and changed pack files, more than 5 of them).
    const doctorWith = async (name, dir, deps) => { const out = sink(); const code = await doctor({ root: dir, stdout: out, deps }); texts.push(['doctor ' + name + ' (exit ' + code + ')', out.text()]); return code; };
    const good = makeRoot();
    const bad = makeRoot();
    const empty = makeRoot();
    try {
      fs.mkdirSync(path.join(good, 'agent'), { recursive: true });
      fs.writeFileSync(path.join(good, 'agent', 'ssam-agent.mjs'), 'code');
      fs.writeFileSync(path.join(good, 'pack.json'), JSON.stringify({ id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91',
        files: [{ path: 'agent/ssam-agent.mjs', sha256: sha('code'), size: 4 }] }));
      fs.writeFileSync(path.join(good, 'private', 'config.json'), JSON.stringify({ server: 'https://ssam.example.com', o11Port: 4516 }));
      fs.writeFileSync(path.join(good, 'private', 'credential'), CREDENTIAL);
      const allGood = { env: {}, flags: new Set(['--use-env-proxy', '--use-system-ca']),
        runtimes: async () => 'Microsoft.NETCore.App 8.0.11 [x]\r\nMicrosoft.NETCore.App 10.0.1 [x]\r\n',
        studios: async () => ({ odc: { installed: { dir: 'C:\\ODC', version: '1.7.28.4021' } }, o11: { installed: { dir: 'C:\\SS', version: null } } }),
        fetch: async () => ({ ok: true, status: 200 }) };
      assert.equal(await doctorWith('with every check passing', good, allGood), 0);
      assert.equal(await doctorWith('when the server does not answer', good, { ...allGood, fetch: async () => { throw new Error('connect ECONNREFUSED'); } }), 1);

      fs.mkdirSync(path.join(bad, 'agent'), { recursive: true });
      fs.writeFileSync(path.join(bad, 'agent', 'ssam-agent.mjs'), 'tampered');
      fs.writeFileSync(path.join(bad, 'pack.json'), JSON.stringify({ id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91',
        files: [{ path: 'agent/ssam-agent.mjs', sha256: sha('code'), size: 4 }, ...[1, 2, 3, 4, 5, 6].map(n => ({ path: `agent/lib/missing${n}.mjs`, sha256: sha(''), size: 0 }))] }));
      assert.equal(await doctorWith('with every check failing', bad, { env: { LOCALAPPDATA: path.dirname(bad) }, flags: new Set(), runtimes: async () => '', studios: async () => ({}) }), 1);
      fs.rmSync(path.join(empty, 'pack.json'));
      assert.equal(await doctorWith('without pack.json', empty, { env: {}, flags: new Set(), runtimes: async () => { throw new Error('no dotnet'); }, studios: async () => ({}) }), 1);
    } finally { removeRoot(good); removeRoot(bad); removeRoot(empty); }

    // The argument errors and the usage line of main (written to process.stderr).
    for (const argv of [['setup', 'stray'], ['setup', '--unknown', 'x'], ['setup', '--server'], ['help']]) {
      const original = process.stderr.write;
      let text = '';
      process.stderr.write = chunk => { text += String(chunk); return true; };
      let code;
      try { code = await main(argv); } finally { process.stderr.write = original; }
      assert.equal(code, 1, argv.join(' '));
      texts.push(['ssam-agent.mjs ' + argv.join(' '), text]);
    }
  } finally { removeRoot(work); }
  assert.ok(texts.every(([, text]) => text.trim().length > 0), 'every case printed something');
  assertEnglish(texts);
});

const runPs1 = (root, action, env) => new Promise(resolve => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'agent', 'ssam-agent.ps1'), action],
    { encoding: 'utf8', env, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, text: stdout + stderr }));
});

test('dynamic: what ssam-agent.ps1 start, status and stop print without a running agent is English only', async () => {
  const env = { ...process.env, SSAM_NODE: process.execPath, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1' };
  const roots = [];
  const rootWith = state => {
    const root = makeRoot({ lanes: ['odc'], o11BuiltFor: null });
    roots.push(root);
    fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
    fs.copyFileSync(path.join(agentDir, 'ssam-agent.ps1'), path.join(root, 'agent', 'ssam-agent.ps1'));
    if (state) fs.writeFileSync(path.join(root, 'private', 'agent.json'), JSON.stringify(state));
    return root;
  };
  try {
    const plain = rootWith(null);
    const runs = [['status without an agent', plain, 'status', 3], ['start without setup', plain, 'start', 1], ['stop without an agent', plain, 'stop', 0],
      ...[2, 3, 4, 9].map(exitCode => [`status after exit code ${exitCode}`, rootWith({ pid: 1, state: 'stopped', exitCode, at: new Date().toISOString() }), 'status', 3])];
    const results = await Promise.all(runs.map(([, root, action]) => runPs1(root, action, env)));
    runs.forEach(([name, , , code], i) => assert.equal(results[i].code, code, name + ': ' + results[i].text));
    assert.ok(results.every(r => r.text.trim().length > 0), 'every run printed something');
    assertEnglish(runs.map(([name], i) => ['ssam-agent.ps1 ' + name, results[i].text]));
  } finally { for (const root of roots) removeRoot(root); }
});

// The entries of a ZIP as agent-pack.ps1 writes it (stored or deflated, no zip64, no comment): Map name -> bytes.
function readZip(file) {
  const zip = fs.readFileSync(file);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'end of central directory');
  const entries = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
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

test('dynamic: every text file of a pack built by agent-pack.ps1 is English only', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-english-pack-'));
  try {
    const prebuilt = path.join(work, 'prebuilt');
    const put = (rel, content = path.basename(rel)) => { const file = path.join(prebuilt, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
    for (const name of ['ODC3.Bridge.v35.dll', 'ODC3.Bridge.v35.deps.json']) put('odc/bridge/' + name);
    for (const name of ['ODC3.Bridge.Client.dll', 'ODC3.Bridge.Client.deps.json', 'ODC3.Bridge.Client.runtimeconfig.json']) put('odc/client/' + name);
    for (const name of ['Anvil.Connect.dll', 'Anvil.Connect.runtimeconfig.json']) put('o11/connect/' + name);
    put('o11/hook/Anvil.RuntimeHook.Agent.dll');
    for (const name of ['Anvil.Bridge.dll', 'Anvil.Bridge.deps.json']) put('o11/bridge/' + name);
    put('o11/built-for.txt', '11.55.91\r\n');
    const zip = path.join(work, 'out', 'ssam-agent.zip');
    const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(box, 'scripts', 'agent-pack.ps1'),
      '-Out', zip, '-Lanes', 'odc,o11', '-NoBuild', '-Prebuilt', prebuilt, '-NoNode'], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.equal(run.status, 0, (run.stdout ?? '') + (run.stderr ?? ''));
    const entries = readZip(zip);
    const text = [...entries].filter(([name]) => !/\.(dll|exe)$/i.test(name));
    assert.ok(text.some(([name]) => name === 'odc/README.md') && text.some(([name]) => name === 'pack.json'), 'the pack has its text files');
    assertEnglish(text.map(([name, bytes]) => ['ssam-agent.zip/' + name, bytes.toString('utf8'), allowFor(name)]));
  } finally { removeRoot(work); }
});

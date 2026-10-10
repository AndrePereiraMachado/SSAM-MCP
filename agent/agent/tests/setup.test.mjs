// setup (root without spaces, icacls on private\ before the credential, credential never printed), doctor (the two
// Node options) and status. icacls, dotnet, the Studios and the server are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { setup, doctor, status, rootProblem, defaultRoot } from '../ssam-agent.mjs';
import { LAYOUT } from '../lib/workspace.mjs';
import { CREDENTIAL, makeRoot, removeRoot } from './fixtures/agent-root.mjs';

const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };
const input = text => Object.assign(Readable.from([text]), { isTTY: false });
const ENV = { USERDOMAIN: 'CONTOSO', USERNAME: 'cliente' };
const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-agent-setup-')), 'SSAM-Agent');

test('setup refuses a root with a space (and asks for --root) before touching anything', async () => {
  const root = path.join(os.tmpdir(), 'ssam agent ' + process.pid, 'SSAM-Agent');
  const calls = []; const stdout = sink(); const stderr = sink();
  const code = await setup({ root, server: 'https://ssam.example.com', stdin: input(CREDENTIAL), stdout, stderr, env: ENV, icacls: async args => calls.push(args) });
  assert.equal(code, 1);
  assert.match(stderr.text(), /--root/);
  assert.match(stderr.text(), /C:\\SSAM-Agent/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.dirname(root)), false);
  assert.match(rootProblem('C:\\Users\\John Smith\\SSAM-Agent', {}), /espaço/);
  assert.match(rootProblem('C:\\Users\\x\\AppData\\Local\\SSAM-Agent', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), /LOCALAPPDATA/);
  assert.equal(rootProblem('C:\\SSAM-Agent', {}), null);
  assert.equal(defaultRoot({ env: { USERPROFILE: 'C:\\Users\\cliente' }, scriptDir: path.join(os.tmpdir(), 'no-pack-here', 'agent') }), 'C:\\Users\\cliente\\SSAM-Agent');
});

test('setup writes the layout, restricts private\\ with icacls BEFORE the credential, and never prints the credential', async () => {
  const root = fresh();
  try {
    const calls = []; const stdout = sink(); const stderr = sink();
    const code = await setup({ root, server: 'https://ssam.example.com/', stdin: input(CREDENTIAL + '\r\n'), stdout, stderr, env: ENV,
      icacls: async args => { calls.push({ args, credentialThen: fs.existsSync(path.join(root, 'private', 'credential')) }); } });
    assert.equal(code, 0, stderr.text());
    assert.deepEqual(calls, [{ args: [path.join(root, 'private'), '/inheritance:r', '/grant:r', 'CONTOSO\\cliente:(OI)(CI)F'], credentialThen: false }]);
    assert.equal(fs.readFileSync(path.join(root, 'private', 'credential'), 'utf8'), CREDENTIAL);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'private', 'config.json'), 'utf8')), { server: 'https://ssam.example.com', o11Port: 4516 });
    for (const folder of LAYOUT) assert.ok(fs.statSync(path.join(root, ...folder.split('/'))).isDirectory(), folder);
    assert.equal((stdout.text() + stderr.text()).includes(CREDENTIAL), false);
    assert.equal((stdout.text() + stderr.text()).includes(CREDENTIAL.slice(11)), false);
    // A new credential later (rotation): setup again, from a file.
    const file = path.join(path.dirname(root), 'nova.txt');
    const rotated = CREDENTIAL.slice(0, -3) + 'XYZ';
    fs.writeFileSync(file, rotated + '\n');
    assert.equal(await setup({ root, server: 'https://ssam.example.com', credentialFile: file, stdout: sink(), stderr: sink(), env: ENV, icacls: async () => {} }), 0);
    assert.equal(fs.readFileSync(path.join(root, 'private', 'credential'), 'utf8'), rotated);
    // --o11-port: another loopback port for the O11 bridge (kept by a later setup without it); an invalid one is refused
    // before the credential is read.
    assert.equal(await setup({ root, server: 'https://ssam.example.com', credentialFile: file, o11Port: '4566', stdout: sink(), stderr: sink(), env: ENV, icacls: async () => {} }), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'private', 'config.json'), 'utf8')).o11Port, 4566);
    assert.equal(await setup({ root, server: 'https://ssam.example.com', credentialFile: file, stdout: sink(), stderr: sink(), env: ENV, icacls: async () => {} }), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'private', 'config.json'), 'utf8')).o11Port, 4566);
    for (const bad of ['80', '70000', 'x']) {
      const stderr = sink();
      assert.equal(await setup({ root, server: 'https://ssam.example.com', credentialFile: path.join(root, 'nope'), o11Port: bad, stdout: sink(), stderr, env: ENV, icacls: async () => {} }), 1, bad);
      assert.match(stderr.text(), /--o11-port/);
    }
  } finally { removeRoot(path.dirname(root)); }
});

test('setup refuses a plain-http remote server, a malformed credential, a root under LOCALAPPDATA, and an icacls failure', async () => {
  const root = fresh();
  try {
    const run = (options = {}) => { const stderr = sink(); return setup({ root, server: 'https://ssam.example.com', stdin: input(CREDENTIAL), stdout: sink(), stderr, env: ENV, icacls: async () => {}, ...options }).then(code => ({ code, text: stderr.text() })); };
    assert.equal((await run({ server: 'http://ssam.example.com' })).code, 1);
    assert.equal((await run({ server: 'nada' })).code, 1);
    const bad = await run({ stdin: input('ssam_mcp_token_que_nao_e_do_agente') });
    assert.equal(bad.code, 1);
    assert.equal(bad.text.includes('ssam_mcp_token_que_nao_e_do_agente'), false);
    assert.equal((await run({ env: { ...ENV, LOCALAPPDATA: path.dirname(root) } })).code, 1);
    const denied = await run({ icacls: async () => { throw new Error('Access is denied.'); } });
    assert.equal(denied.code, 1);
    assert.match(denied.text, /icacls/);
    assert.equal(fs.existsSync(path.join(root, 'private', 'credential')), false);
    assert.equal((await run({ server: 'http://127.0.0.1:7400' })).code, 0, 'loopback http is accepted');
  } finally { removeRoot(path.dirname(root)); }
});

test('doctor checks the two Node options and reports without printing the credential', async () => {
  const root = makeRoot();
  try {
    const agentFile = path.join(root, 'agent', 'ssam-agent.mjs');
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, 'code');
    const sha = createHash('sha256').update('code').digest('hex');
    fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-test', lanes: ['odc', 'o11'], odcBridge: 'v35', o11BuiltFor: '11.55.91',
      files: [{ path: 'agent/ssam-agent.mjs', sha256: sha, size: 4 }] }));
    fs.writeFileSync(path.join(root, 'private', 'config.json'), JSON.stringify({ server: 'https://ssam.example.com', o11Port: 4516 }));
    fs.writeFileSync(path.join(root, 'private', 'credential'), CREDENTIAL);
    const deps = { env: {}, runtimes: async () => 'Microsoft.NETCore.App 8.0.11 [x]\r\nMicrosoft.NETCore.App 10.0.1 [x]\r\n',
      studios: async () => ({ odc: { installed: { dir: 'C:\\ODC', version: '1.7.27.4021' } }, o11: { installed: null } }),
      fetch: async () => ({ ok: true, status: 200 }) };
    const good = sink();
    assert.equal(await doctor({ root, stdout: good, deps: { ...deps, flags: new Set(['--use-env-proxy', '--use-system-ca']) } }), 0, good.text());
    assert.match(good.text(), /\[ok\] Node --use-env-proxy/);
    assert.match(good.text(), /\[ok\] Node --use-system-ca/);
    assert.match(good.text(), /\[aviso\] Service Studio/);
    assert.equal(good.text().includes(CREDENTIAL), false);
    const old = sink();
    assert.equal(await doctor({ root, stdout: old, deps: { ...deps, flags: new Set(['--use-system-ca']) } }), 1);
    assert.match(old.text(), /\[falha\] Node --use-env-proxy/);
    // A changed pack file fails too.
    fs.writeFileSync(agentFile, 'tampered');
    const tampered = sink();
    assert.equal(await doctor({ root, stdout: tampered, deps: { ...deps, flags: new Set(['--use-env-proxy', '--use-system-ca']) } }), 1);
    assert.match(tampered.text(), /\[falha\] pacote: agent\/ssam-agent\.mjs \(alterado\)/);
  } finally { removeRoot(root); }
});

test('status reports the local state without secrets', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'private', 'config.json'), JSON.stringify({ server: 'https://ssam.example.com' }));
    fs.writeFileSync(path.join(root, 'private', 'credential'), CREDENTIAL);
    const out = sink();
    assert.equal(status({ root, stdout: out }), 3);
    const report = JSON.parse(out.text());
    assert.equal(report.server, 'https://ssam.example.com');
    assert.equal(report.credential, true);
    assert.equal(report.agent.running, false);
    assert.equal(out.text().includes(CREDENTIAL), false);
  } finally { removeRoot(root); }
});

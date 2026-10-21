// agent/ssam-agent.sh start|status|stop|uninstall (lib/launcher.mjs, the semantics of ssam-agent.ps1 and ps1.test.mjs):
// start with captured output returns connected, a second start and an agent started by hand are kept, a second agent of
// the same folder is refused, stop is clean (the hub sees DELETE), status explains the last stop; uninstall removes
// exactly the pack, the installer's Node and private/, and keeps the work. Real node processes against the fake hub; the
// .sh wrapper runs under the bash of Git for Windows when there is one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';
import { createLauncher, exitText, INSTALLER_FILES } from '../lib/launcher.mjs';
import { LAYOUT } from '../lib/workspace.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const run = (file, args, env) => new Promise(resolve => {
  const started = Date.now();
  execFile(file, args, { encoding: 'utf8', env, timeout: 60000, windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error ? (error.killed ? 'killed' : error.code) : 0, stdout, stderr, ms: Date.now() - started }));
});
const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash'].find(file => fs.existsSync(file));
const texts = [];

function packRoot() {
  const root = makeRoot({ lanes: ['odc'], o11BuiltFor: null });
  fs.mkdirSync(path.join(root, 'agent', 'lib'), { recursive: true });
  for (const name of ['ssam-agent.mjs', 'ssam-agent.sh']) fs.copyFileSync(path.join(agentDir, name), path.join(root, 'agent', name));
  for (const name of fs.readdirSync(path.join(agentDir, 'lib'))) fs.copyFileSync(path.join(agentDir, 'lib', name), path.join(root, 'agent', 'lib', name));
  return root;
}

test('launcher: start returns connected with its output captured, keeps a running agent, refuses a second one, stops cleanly', async () => {
  const root = packRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  let pid = null;
  try {
    fs.writeFileSync(path.join(root, 'private', 'config.json'), JSON.stringify({ server: hub.url, o11Port: 4516 }));
    fs.writeFileSync(path.join(root, 'private', 'credential'), CREDENTIAL);
    const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1' };
    const launcher = action => run(process.execPath, [path.join(root, 'agent', 'lib', 'launcher.mjs'), action, '--root', root], env);
    const start = await launcher('start');
    texts.push(['start', start.stdout]);
    assert.equal(start.code, 0, start.stdout + start.stderr);
    assert.ok(start.ms < 45000);
    pid = Number(/Agent connected: pid (\d+), server /.exec(start.stdout)?.[1]);
    assert.ok(pid > 0 && alive(pid), start.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'private', 'agent.json'), 'utf8')).pid, pid);
    const status = await launcher('status');
    texts.push(['status', status.stdout]);
    assert.equal(status.code, 0); assert.match(status.stdout, new RegExp('Running: pid ' + pid + ', state connected'));
    assert.match((await launcher('start')).stdout, /Already running/);
    fs.rmSync(path.join(root, 'private', 'agent.pid'));
    assert.match((await launcher('start')).stdout, /Already running/);
    const second = await run(process.execPath, [path.join(root, 'agent', 'ssam-agent.mjs'), 'run', '--root', root], env);
    assert.equal(second.code, 1); assert.match(second.stderr, /another agent already runs in this folder/);
    if (GIT_BASH) {
      // The .sh wrapper: it finds the node (SSAM_NODE here) and runs the launcher for this folder.
      const sh = await run(GIT_BASH, [path.join(root, 'agent', 'ssam-agent.sh').replace(/\\/g, '/'), 'status'], { ...env, SSAM_NODE: process.execPath });
      assert.equal(sh.code, 0, sh.stdout + sh.stderr); assert.match(sh.stdout, new RegExp('Running: pid ' + pid));
      const usage = await run(GIT_BASH, [path.join(root, 'agent', 'ssam-agent.sh').replace(/\\/g, '/'), 'restart'], { ...env, SSAM_NODE: process.execPath });
      assert.equal(usage.code, 1); assert.match(usage.stdout, /Usage: .* start\|status\|stop\|doctor \[--json\]\|uninstall/);
      texts.push(['sh usage', usage.stdout]);
    }
    const stop = await launcher('stop');
    texts.push(['stop', stop.stdout]);
    assert.equal(stop.code, 0); assert.match(stop.stdout, /Stopped: pid/);
    assert.equal(alive(pid), false);
    assert.equal(hub.deletes, 1, 'clean stop: the server was told');
    const after = await launcher('status');
    texts.push(['status after', after.stdout]);
    assert.equal(after.code, 3); assert.match(after.stdout, /^Stopped\./);
    assert.match((await launcher('stop')).stdout, /Already stopped\./);
    assert.equal(fs.readFileSync(path.join(root, 'private', 'agent.log'), 'utf8').includes(CREDENTIAL), false);
  } finally {
    if (pid && alive(pid)) process.kill(pid);
    await hub.close();
    removeRoot(root);
  }
});

test('launcher: without setup, an agent that stops at once (with its exit code) and the reasons of a last stop', async () => {
  const root = packRoot();
  try {
    const lines = [];
    const out = { write: text => { lines.push(text); return true; } };
    const plain = createLauncher({ root, out, isAgent: async () => false });
    assert.equal(await plain.start(), 1);
    assert.match(lines.at(-1), /not set up: run setup first \(docs\/AGENTE-MAC\.md\)/);
    fs.writeFileSync(path.join(root, 'private', 'config.json'), JSON.stringify({ server: 'http://127.0.0.1:9', o11Port: 4516 }));
    fs.writeFileSync(path.join(root, 'private', 'credential'), CREDENTIAL);
    // A child that exits at once after writing its stopped state (code 2).
    const fakeChild = () => { const listeners = {}; const child = { pid: 777777, on: (event, fn) => { listeners[event] = fn; }, unref() {} };
      fs.writeFileSync(path.join(root, 'private', 'agent.json'), JSON.stringify({ pid: 777777, state: 'stopped', exitCode: 2, at: new Date().toISOString() }));
      setImmediate(() => listeners.exit?.(2)); return child; };
    const stopping = createLauncher({ root, out, spawnFn: fakeChild, isAgent: async () => false, sleep: () => new Promise(resolve => setImmediate(resolve)) });
    assert.equal(await stopping.start(), 1);
    assert.match(lines.at(-1), /The agent stopped \(code 2\): credential refused, revoked, expired or replaced/);
    assert.equal(await stopping.status(), 3);
    assert.match(lines.at(-1), /^Stopped\. Last stop: credential refused/);
    for (const code of [3, 4, 9]) texts.push(['exit ' + code, exitText(code, { log: '/Users/ana/SSAM-Agent/private/agent.log', node: '/usr/local/bin/node', script: '/Users/ana/SSAM-Agent/agent/ssam-agent.mjs', root: '/Users/ana/SSAM-Agent' })]);
    assert.match(texts.at(-1)[1], /--use-env-proxy --use-system-ca .* run --root/);
    texts.push(...lines.map(line => ['launcher', line]));
  } finally { removeRoot(root); }
});

test('uninstall: exactly the pack files, pack.json, the Node of the installer and private/; the work stays and is named', async () => {
  const root = packRoot();
  try {
    const listed = ['agent/ssam-agent.mjs', 'agent/ssam-agent.sh', ...fs.readdirSync(path.join(root, 'agent', 'lib')).map(n => 'agent/lib/' + n), 'install.sh', 'docs/AGENTE-MAC.md',
      'odc/README.md', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll', 'bin/o11/bridge/Anvil.Bridge.dll', '../outside.txt', '/etc/hosts'];
    for (const rel of listed.filter(r => !r.startsWith('.') && !r.startsWith('/'))) { const file = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, rel); }
    fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-mac', platform: 'darwin', lanes: ['odc'], files: listed.map(p => ({ path: p, sha256: '0'.repeat(64), size: 1 })) }));
    for (const rel of INSTALLER_FILES) { fs.mkdirSync(path.join(root, 'agent', 'node'), { recursive: true }); fs.writeFileSync(path.join(root, ...rel.split('/')), 'node'); }
    for (const name of ['config.json', 'credential', 'agent.log', 'authority/bridge.key']) { const f = path.join(root, 'private', ...name.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
    fs.writeFileSync(path.join(root, 'inbox', 'mine.oml'), 'work');
    fs.writeFileSync(path.join(root, 'odc', 'snapshots', 'App.oml'), 'work');
    const outside = path.join(path.dirname(root), 'outside.txt'); fs.writeFileSync(outside, 'keep');
    const lines = [];
    const code = await createLauncher({ root, out: { write: t => { lines.push(t); return true; } }, isAgent: async () => false }).uninstall();
    assert.equal(code, 0);
    texts.push(['uninstall', lines.join('')]);
    const left = [];
    const walk = (dir, prefix = '') => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const rel = prefix + item.name; if (item.isDirectory()) walk(path.join(dir, item.name), rel + '/'); else left.push(rel); } };
    walk(root);
    assert.deepEqual(left.sort(), ['inbox/mine.oml', 'odc/snapshots/App.oml']);
    assert.equal(fs.existsSync(path.join(root, 'private')), false);
    assert.equal(fs.existsSync(path.join(root, 'o11')), false, 'empty layout folders go');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep', 'a path outside the folder is never removed');
    assert.match(lines.join(''), /Kept in .*inbox\/ \(1 files\), odc\/ \(1 files\)/);
    fs.rmSync(outside);
    // Nothing of the person's: the folder itself goes.
    const empty = packRoot();
    fs.writeFileSync(path.join(empty, 'pack.json'), JSON.stringify({ files: [{ path: 'agent/ssam-agent.mjs' }, { path: 'agent/ssam-agent.sh' }, ...fs.readdirSync(path.join(empty, 'agent', 'lib')).map(n => ({ path: 'agent/lib/' + n }))] }));
    for (const folder of LAYOUT) fs.mkdirSync(path.join(empty, ...folder.split('/')), { recursive: true });
    const out = [];
    await createLauncher({ root: empty, out: { write: t => { out.push(t); return true; } }, isAgent: async () => false }).uninstall();
    assert.equal(fs.existsSync(empty), false, out.join(''));
    assert.match(out.join(''), /is gone/);
    texts.push(['uninstall empty', out.join('')]);
  } finally { removeRoot(root); }
  const found = texts.flatMap(([where, text]) => { const f = portugueseIn(text); return f.length ? [describe(where, f)] : []; });
  assert.equal(found.join('\n'), '', 'Portuguese the customer would see');
});

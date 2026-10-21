// agent\ssam-agent.ps1 start|status|stop with the fixes of servidor.ps1 (docs/FASE2-AGENTE.md 9.2): start called with
// captured output returns (no inherited handles), counts as up only when the state file has the started pid and says
// connected, refuses a second agent of the same folder, and stop is clean (the hub sees DELETE /agent/v1/channel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const run = (file, args, env) => new Promise(resolve => {
  const started = Date.now();
  execFile(file, args, { encoding: 'utf8', env, timeout: 60000, windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error ? (error.killed ? 'killed' : error.code) : 0, stdout, stderr, ms: Date.now() - started }));
});

test('ssam-agent.ps1: start with captured output returns connected, status, a second start, a second agent refused, clean stop', async () => {
  const root = makeRoot({ lanes: ['odc'], o11BuiltFor: null });
  const hub = await fakeHub({ credential: CREDENTIAL });
  let pid = null;
  try {
    // The agent code at <root>\agent, as the pack lays it out.
    fs.mkdirSync(path.join(root, 'agent', 'lib'), { recursive: true });
    for (const name of ['ssam-agent.mjs', 'ssam-agent.ps1']) fs.copyFileSync(path.join(agentDir, name), path.join(root, 'agent', name));
    for (const name of fs.readdirSync(path.join(agentDir, 'lib'))) fs.copyFileSync(path.join(agentDir, 'lib', name), path.join(root, 'agent', 'lib', name));
    fs.writeFileSync(path.join(root, 'private', 'config.json'), JSON.stringify({ server: hub.url, o11Port: 4516 }));
    fs.writeFileSync(path.join(root, 'private', 'credential'), CREDENTIAL);
    const env = { ...process.env, SSAM_NODE: process.execPath, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1' };
    const ps1 = action => run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'agent', 'ssam-agent.ps1'), action], env);

    const start = await ps1('start');
    assert.equal(start.code, 0, start.stdout + start.stderr);
    assert.ok(start.ms < 45000, 'start returned with its output captured');
    pid = Number(/Agent connected: pid (\d+)/.exec(start.stdout)?.[1]);
    assert.ok(pid > 0 && alive(pid), start.stdout);
    assert.equal(hub.hellos[0].pack.id, 'pack-test');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'private', 'agent.json'), 'utf8')).pid, pid);

    const status = await ps1('status');
    assert.equal(status.code, 0);
    assert.match(status.stdout, new RegExp('Running: pid ' + pid));
    assert.match((await ps1('start')).stdout, /Already running/);
    // Without the pid file (an agent started by hand), the state file still tells.
    fs.rmSync(path.join(root, 'private', 'agent.pid'));
    assert.match((await ps1('start')).stdout, /Already running/);
    // A second agent process for the same folder refuses to start.
    const second = await run(process.execPath, [path.join(root, 'agent', 'ssam-agent.mjs'), 'run', '--root', root], env);
    assert.equal(second.code, 1);
    assert.match(second.stderr, new RegExp('another agent already runs in this folder \\(pid ' + pid + '\\)'));
    assert.equal(hub.hellos.length, 1);

    const stop = await ps1('stop');
    assert.equal(stop.code, 0, stop.stdout + stop.stderr);
    assert.match(stop.stdout, /Stopped: pid/);
    assert.equal(alive(pid), false);
    assert.equal(hub.deletes, 1, 'clean stop: the server was told');
    const after = await ps1('status');
    assert.equal(after.code, 3);
    assert.match(after.stdout, /Stopped\./);
    const log = fs.readFileSync(path.join(root, 'private', 'agent.log'), 'utf8');
    assert.match(log, /"event":"connected"/);
    assert.equal(log.includes(CREDENTIAL), false);
  } finally {
    if (pid && alive(pid)) process.kill(pid);
    await hub.close();
    removeRoot(root);
  }
});

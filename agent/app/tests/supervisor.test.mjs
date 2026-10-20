// The supervisor against the fake hub of the agent tests, with real node processes: the pack synced into a fresh root,
// setup with the credential over standard input, start until connected (one hello), a second start kept, a clean stop
// (the hub sees the DELETE), a refused credential ends for good (code 2, no restart), a killed agent is started again,
// and doctor answers the agent's own JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';
import { CREDENTIAL } from '../../agent/tests/fixtures/agent-root.mjs';
import { createSupervisor, forkWithNode, supportedFlags } from '../src/supervisor.mjs';
import { verifyPack } from '../src/pack-sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, '..', '..', 'agent');
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const fresh = name => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-app-' + name + '-'));
const remove = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// No LOCALAPPDATA: the temp root of the test lives there, and the agent's setup refuses such a root for real use.
const ENV = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1' };
delete ENV.LOCALAPPDATA;

// A pack folder with the agent code of this box, as scripts/agent-pack.ps1 lays it out, and a pack.json over it.
function makePack(id = 'pack-app-test') {
  const dir = fresh('pack');
  const files = [];
  const put = (rel, buffer) => { const full = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, buffer); files.push({ path: rel, sha256: sha(buffer), size: buffer.length }); };
  for (const name of ['ssam-agent.mjs', 'ssam-agent.ps1', 'ssam-agent.sh']) put('agent/' + name, fs.readFileSync(path.join(agentDir, name)));
  for (const name of fs.readdirSync(path.join(agentDir, 'lib'))) put('agent/lib/' + name, fs.readFileSync(path.join(agentDir, 'lib', name)));
  put('odc/README.md', Buffer.from('root marker\n'));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, lanes: ['odc'], odcBridge: 'v97', o11BuiltFor: null, o11Hook: null, o11Bridge: null, files }, null, 2));
  return dir;
}

test('supervisor: sync, setup, start to connected, second start, clean stop, refused credential, crash restart, doctor', { timeout: 120000 }, async () => {
  if (/\s/.test(os.tmpdir())) { assert.ok(true, 'temp folder with a space: the agent refuses such a root'); return; }
  const pack = makePack();
  const root = path.join(fresh('root'), 'SSAM-Agent');
  const hub = await fakeHub({ credential: CREDENTIAL });
  const changes = [];
  const logs = [];
  const supervisor = createSupervisor({ root, packDir: pack, fork: forkWithNode(process.execPath), env: ENV, log: (event, fields) => logs.push({ event, ...fields }), onChange: s => changes.push(s.view.status) });
  try {
    assert.equal(supervisor.snapshot().view.status, 'not-set-up');
    const synced = supervisor.syncPack();
    assert.equal(synced.synced, true);
    assert.equal(verifyPack(root).ok, true);
    assert.equal(supervisor.snapshot().pack.id, 'pack-app-test');
    assert.equal(supervisor.snapshot().bundledPack, 'pack-app-test');

    // setup: the agent's own, with the credential over stdin; nothing of it in the output.
    const bad = await supervisor.setup({ server: 'http://not-loopback.example.com', credential: CREDENTIAL });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /https/);
    const setup = await supervisor.setup({ server: hub.url, credential: CREDENTIAL, o11Port: '4517' });
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.output.includes(CREDENTIAL), false);
    assert.equal(fs.readFileSync(supervisor.files.credential, 'utf8').trim(), CREDENTIAL);
    assert.equal(JSON.parse(fs.readFileSync(supervisor.files.config, 'utf8')).o11Port, 4517);
    assert.equal(supervisor.snapshot().view.status, 'stopped');
    assert.equal(supervisor.snapshot().server, hub.url);

    await assert.rejects(() => supervisor.setup({ server: hub.url, credential: CREDENTIAL }).then(() => supervisor.start()).then(() => supervisor.setup({ server: hub.url, credential: CREDENTIAL })), /Stop the agent/);
    assert.equal(supervisor.running, true);
    assert.equal(hub.hellos.length, 1);
    assert.equal(supervisor.snapshot().view.status, 'connected');
    assert.equal(supervisor.snapshot().pid, supervisor.pid);
    assert.equal(fs.readFileSync(supervisor.files.pid, 'utf8'), String(supervisor.pid));
    const again = await supervisor.start();
    assert.equal(again.already, true);
    assert.equal(hub.hellos.length, 1);
    assert.ok(changes.includes('connected'));

    const stopped = await supervisor.stop();
    assert.equal(stopped.stopped, true);
    assert.equal(supervisor.running, false);
    assert.equal(hub.deletes, 1, 'a clean stop tells the hub');
    assert.equal(fs.existsSync(supervisor.files.pid), false);
    assert.equal(fs.existsSync(supervisor.files.stop), false);
    assert.equal(supervisor.snapshot().view.status, 'stopped');
    assert.equal(supervisor.snapshot().lastExit, 0);
    assert.equal(logs.some(l => l.event === 'agent-kill'), false, 'the agent left on its own');

    // The hub refuses the credential: the agent ends with 2, the view asks for the person, nothing restarts.
    hub.helloStatus.push(401);
    const refused = await supervisor.start();
    assert.equal(refused.started, false);
    assert.equal(refused.code, 2);
    assert.equal(supervisor.snapshot().view.status, 'attention');
    assert.match(supervisor.snapshot().view.detail, /credential/);
    assert.equal(logs.some(l => l.event === 'agent-restart-scheduled'), false);

    // A crash (the process killed from outside): started again after the first delay (5 s).
    const back = await supervisor.start();
    assert.equal(back.connected, true);
    const killed = supervisor.pid;
    process.kill(killed, 'SIGKILL');
    await wait(1500);
    assert.equal(supervisor.running, false);
    assert.equal(logs.some(l => l.event === 'agent-restart-scheduled' && l.delayMs === 5000), true);
    assert.equal(supervisor.snapshot().view.status, 'stopped');
    assert.match(supervisor.snapshot().view.detail, /starts it again/);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && supervisor.snapshot().view.status !== 'connected') await wait(300);
    assert.equal(supervisor.snapshot().view.status, 'connected');
    assert.notEqual(supervisor.pid, killed);
    await supervisor.stop();

    // doctor: the agent's JSON report, with the pack checked and the server reached.
    const doctor = await supervisor.doctor();
    assert.ok(doctor.report, doctor.text);
    const checks = Array.isArray(doctor.report.checks) ? doctor.report.checks : doctor.report;
    assert.ok(JSON.stringify(checks).includes('pack-app-test'));
    assert.equal(JSON.stringify(doctor.report).includes(CREDENTIAL), false);
    assert.deepEqual(supportedFlags(new Set(['--use-env-proxy'])), ['--use-env-proxy']);
  } finally {
    await supervisor.shutdown();
    hub.close();
    remove(pack); remove(path.dirname(root));
  }
});

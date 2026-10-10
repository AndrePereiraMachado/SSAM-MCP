// Lane C, C35 and the stop() of C04: one Studio selection for the scripts and the facade (the connection record first,
// then ANVIL_STUDIO_DIR, then the lane's own copy); a worker of another installation is recycled when idle; stopping a
// worker that accepted the shutdown and is still alive 10 s later terminates exactly the pid its ping named, with the
// same creation time, never another; the build never starts a worker and warms the discover index at its end.
// Fake workers on loopback ports and fake process identities: no real process is inspected, started or terminated
// (the Python harness replaces anvil_cli's ping, request, birth and terminate before calling stop()).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as m_anvil_worker from '../anvil-worker.mjs';
const { workerTarget, ensureWorker, stopWorker } = m_anvil_worker; // a namespace: at the base each test fails on its own rule, not at import
import { fakeWorker, freePort } from './fixtures/jobs-fake-worker.mjs';

const exec = promisify(execFile);
const facade = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspace = path.resolve(facade, '..', '..', '..');
const kernelScripts = path.join(workspace, 'kernel', 'scripts');
const python = process.env.SSAM_PYTHON ?? path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
// isolated-profile moved USERPROFILE: the runtime Python of the real profile is found from the path of this checkout's user.
const pythonExe = [python, path.join(workspace, '..', '..', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  path.join('C:\\Users', os.userInfo().username, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')].find(p => fs.existsSync(p));
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// A sandbox checkout: <ws>/.ssam-workspace.json and <ws>/kernel/scripts/lanes.py (a copy), so lanes.py's ROOT is the sandbox.
function checkout(t) {
  const ws = temp(t, 'pacote-c-sel-');
  const kernel = path.join(ws, 'kernel');
  fs.mkdirSync(path.join(kernel, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(kernelScripts, 'lanes.py'), path.join(kernel, 'scripts', 'lanes.py'));
  fs.writeFileSync(path.join(ws, '.ssam-workspace.json'), JSON.stringify({ schema: 'ssam-workspace/1', kernel: 'kernel', odc: 'platforms/odc', o11Lane: 'ss4',
    workers: { o11ss4: 24517, o11ss5: 24537, odc: 24547, poolStep: 100 } }));
  const profile = path.join(ws, 'profile'); fs.mkdirSync(profile);
  const record = (fields = {}) => {
    const file = path.join(kernel, '.local', 'connections', 'ss4.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', connected: true, pid: 4321, startedUtc: '2026-10-05T10:00:00Z',
      studioDir: path.join(ws, 'Selected', 'Service Studio'), authorityDir: path.join(ws, 'auth'), port: 4516, ...fields }));
  };
  return { ws, kernel, profile, record };
}
async function pythonSelection(c, env) {
  const code = 'import sys,json;sys.path.insert(0,sys.argv[1]);import lanes;l=lanes.lane("ss4");e=l.env();'
    + 'print(json.dumps({"studioDir":str(l.studio_dir),"selection":l.selection,"envStudio":e.get("ANVIL_STUDIO_DIR"),"envAuthority":e.get("ANVIL_AUTHORITY_DIR")}))';
  const { stdout } = await exec(pythonExe, ['-c', code, path.join(c.kernel, 'scripts')], { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...env }, windowsHide: true });
  return JSON.parse(stdout);
}

test('lanes.py and the facade worker select the same Studio: the connection record, then ANVIL_STUDIO_DIR, then the lane copy', { skip: !pythonExe && 'no Python runtime' }, async t => {
  const c = checkout(t);
  const base = { USERPROFILE: c.profile, LOCALAPPDATA: path.join(c.profile, 'Local'), ANVIL_LANE: 'ss4' };
  const node = env => { const target = workerTarget('o11', { root: c.kernel, workspace: c.ws, env, o11: 'ss4' }); return { studio: target.selectedStudio, authority: target.env.ANVIL_AUTHORITY_DIR }; };
  const explicit = path.join(c.ws, 'Explicit', 'Service Studio');
  // 1) No record: the explicit installation, in both.
  let py = await pythonSelection(c, { ...base, ANVIL_STUDIO_DIR: explicit });
  assert.deepEqual([py.studioDir, py.envStudio, py.selection], [explicit, explicit, 'ANVIL_STUDIO_DIR']);
  assert.equal(node({ ...base, ANVIL_STUDIO_DIR: explicit }).studio, explicit);
  // 2) The record of ssam_connect wins over ANVIL_STUDIO_DIR, with its controller authority, in both.
  c.record();
  const selected = path.join(c.ws, 'Selected', 'Service Studio');
  py = await pythonSelection(c, { ...base, ANVIL_STUDIO_DIR: explicit });
  assert.deepEqual([py.studioDir, py.envStudio, py.envAuthority, py.selection], [selected, selected, path.join(c.ws, 'auth'), 'connection']);
  assert.deepEqual(node({ ...base, ANVIL_STUDIO_DIR: explicit }), { studio: selected, authority: path.join(c.ws, 'auth') });
  // 3) A record of another lane (or malformed) is ignored by both.
  c.record({ anvilLane: 'ss5' });
  py = await pythonSelection(c, { ...base, ANVIL_STUDIO_DIR: explicit });
  assert.equal(py.studioDir, explicit); assert.equal(node({ ...base, ANVIL_STUDIO_DIR: explicit }).studio, explicit);
  // 4) Nothing selected: the lane's own copy when it exists.
  fs.rmSync(path.join(c.kernel, '.local'), { recursive: true, force: true });
  const copy = path.join(c.profile, 'OutSystems', 'Service Studio 11 - Anvil 4516', 'Service Studio');
  fs.mkdirSync(copy, { recursive: true });
  py = await pythonSelection(c, base);
  assert.deepEqual([py.studioDir, py.envStudio, py.selection], [copy, copy, 'lane']);
  assert.equal(node(base).studio, copy);
});

// A fake process behind a fake worker: identity and liveness the test controls; kill records and closes the worker.
function fakeProcess(worker, { birth = '133700000000000000', name = 'dotnet' } = {}) {
  const p = { birth, name, alive: true, killed: [] };
  return { p, deps: { identity: async pid => (p.alive ? { birth: p.birth, name: p.name } : null), alive: () => p.alive,
    kill: pid => { p.killed.push(pid); p.alive = false; worker.close(); }, waitMs: 300, exitMs: 2000 } };
}

test('stop: a worker that accepted the shutdown and is still alive is terminated by its verified pid; never another process', async t => {
  const auth = temp(t, 'pacote-c-stop-'); fs.writeFileSync(path.join(auth, 'bridge.key'), 'KEY\n');
  const target = port => ({ ...workerTarget('odc', { root: auth, env: { ANVIL_AUTHORITY_DIR: auth, ANVIL_ODC_PORT: String(port) }, pingMs: 500 }) });
  // Accepts the shutdown and keeps serving (a thread that never ends): terminated after waitMs, exit waited for.
  const hung = await fakeWorker({ key: 'KEY', status: { pid: 4100 } });
  t.after(() => hung.close());
  const one = fakeProcess(hung);
  const stopped = await stopWorker(target(hung.port), { pid: 4100 }, one.deps);
  assert.deepEqual(stopped, { stopped: true, terminated: 4100 });
  assert.deepEqual(one.p.killed, [4100]); assert.equal(hung.requests('shutdown').length, 1); assert.equal(hung.requests('shutdown')[0].authorization, 'KEY');
  // The pid now names a process created at another time: never terminated.
  const reused = await fakeWorker({ key: 'KEY', status: { pid: 4104 } });
  t.after(() => reused.close());
  const two = fakeProcess(reused);
  let reads = 0;
  const kept = await stopWorker(target(reused.port), { pid: 4104 }, { ...two.deps, identity: async () => ({ birth: ++reads === 1 ? '1' : '2', name: 'dotnet' }) });
  assert.equal(kept.stopped, false); assert.match(kept.note, /nothing was terminated/); assert.deepEqual(two.p.killed, []);
  // A process that is not a worker image is never terminated either.
  const foreign = await fakeWorker({ key: 'KEY', status: { pid: 4108 } });
  t.after(() => foreign.close());
  const three = fakeProcess(foreign, { name: 'notepad' });
  const left = await stopWorker(target(foreign.port), { pid: 4108 }, three.deps);
  assert.equal(left.stopped, false); assert.match(left.note, /not a worker image/); assert.deepEqual(three.p.killed, []);
  // A refused shutdown (another controller's key) stops nothing and terminates nothing.
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'OTHER');
  const refused = await stopWorker(target(foreign.port), { pid: 4108 }, three.deps);
  assert.equal(refused.stopped, false); assert.match(refused.note, /did not accept the shutdown/); assert.deepEqual(three.p.killed, []);
});

test('an idle worker of another installation is recycled and started again for the selected one; a busy one is left running', async t => {
  const root = temp(t, 'pacote-c-recycle-');
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth); fs.writeFileSync(path.join(auth, 'bridge.key'), 'KEY\n');
  const studio = path.join(root, 'Service Studio'); fs.mkdirSync(studio); fs.writeFileSync(path.join(studio, 'ServiceStudio.Framework.dll'), '');
  const port = await freePort();
  const target = { ...workerTarget('o11', { root, env: { USERPROFILE: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER_PORT: String(port), ANVIL_STUDIO_DIR: studio }, o11: 'ss4', pingMs: 500 }), waitMs: 4000 };
  fs.mkdirSync(path.dirname(target.cli), { recursive: true }); fs.writeFileSync(target.cli, '');
  let fresh = null;
  const old = await fakeWorker({ port, key: 'KEY', status: { instanceId: 'old', pid: 4200, studio: path.join(root, 'Other', 'Service Studio'), busy: true }, handler: request => {
    if (request.args[0] === 'shutdown') { setImmediate(() => old.close()); return { ok: true, command: 'shutdown', data: {} }; }
    return { ok: true, command: request.args[0], data: {} };
  } });
  t.after(async () => { await old.close(); await fresh?.close(); });
  const launches = [];
  const spawnFn = (file, args, options) => {
    const child = new EventEmitter(); child.unref = () => {};
    launches.push({ file, args, env: options.env });
    setTimeout(async () => { fresh = await fakeWorker({ port, key: 'KEY', status: { instanceId: 'new', pid: 4204, studio } }); }, 150);
    return child;
  };
  const deps = { spawnFn, identity: async () => ({ birth: '1', name: 'dotnet' }), alive: () => false, kill: () => { throw new Error('never terminated'); } };
  // Busy: it serves another request; nobody stops it, the call runs cold.
  const busy = await ensureWorker(target, deps);
  assert.equal(busy.status, null); assert.match(busy.note, /busy.*ran cold/); assert.equal(old.requests('shutdown').length, 0);
  // Idle: shut down, and a worker for the selected installation answers.
  old.state.busy = false;
  const recycled = await ensureWorker(target, deps);
  assert.equal(recycled.status?.instanceId, 'new', JSON.stringify(recycled)); assert.equal(recycled.started, true);
  assert.equal(old.requests('shutdown').length, 1);
  assert.equal(launches.length, 1); assert.equal(launches[0].env.ANVIL_STUDIO_DIR, studio);
});

test('kernel/scripts/anvil_worker.py stop(): terminates the verified pid that outlived its shutdown, never a changed one', { skip: !pythonExe && 'no Python runtime' }, async () => {
  const harness = (scenario) => [
    'import sys,json', 'sys.path.insert(0, sys.argv[1])', 'import anvil_worker', 'calls = []', 'state = {"birth": "111"}', 'cli = anvil_worker.anvil_cli', 'wp = cli.worker_process',
    'cli.ping = lambda port: {"pid": 4300}',
    'def request(argv, port, timeout):',
    '    calls.append(["request", argv])',
    `    if ${JSON.stringify(scenario)} == "reused": state["birth"] = "222"`,
    `    return {"ok": ${JSON.stringify(scenario)} != "refused", "error": "Worker operation requires the trusted Hybrid controller", "data": {"stopped": True}}`,
    'cli._request = request', 'wp.birth = lambda pid: state["birth"]',
    'def terminate(pid, birth):', '    calls.append(["terminate", pid, birth]); state["birth"] = None; return True', 'wp.terminate_known = terminate',
    'try:', '    rc = anvil_worker.stop(24517, wait=0.3, exit_wait=1)', 'except Exception as error:', '    rc = type(error).__name__',
    'print(json.dumps({"rc": rc, "calls": calls}))'].join('\n');
  const run = async scenario => JSON.parse((await exec(pythonExe, ['-c', harness(scenario), kernelScripts], { cwd: path.join(workspace, 'kernel'), windowsHide: true })).stdout.trim().split(/\r?\n/).at(-1));
  const hung = await run('hung');
  assert.deepEqual(hung, { rc: 0, calls: [['request', ['shutdown']], ['terminate', 4300, '111']] });
  const reused = await run('reused');
  assert.deepEqual(reused, { rc: 0, calls: [['request', ['shutdown']]] }, 'a pid with another creation time is never terminated');
  const refused = await run('refused');
  assert.deepEqual(refused, { rc: 'RuntimeError', calls: [['request', ['shutdown']]] });
});

test('scripts/build.ps1 never starts a worker and warms the discover index at its end', async () => {
  const script = fs.readFileSync(path.join(workspace, 'scripts', 'build.ps1'), 'utf8');
  assert.match(script, /\$ssamBuildOptions = @\('--no-start'\)/, 'every build passes --no-start');
  assert.doesNotMatch(script, /if \(\$NoStart\)/, 'never conditional on -NoStart');
  assert.match(script, /param\(\[switch\]\$NoStart/, '-NoStart stays accepted');
  const warm = script.split(/\r?\n/).findIndex(l => /facade\\ssam\.mjs'\) warm\s*$/.test(l));
  const lastBuild = script.split(/\r?\n/).findLastIndex(l => /dotnet build/.test(l));
  assert.ok(warm > lastBuild && lastBuild > 0, 'ssam warm runs after every build step');
  assert.match(script, /if \(\$LASTEXITCODE -ne 0\) \{ Write-Warning/, 'a warm failure never fails the build');
  if (process.platform === 'win32') {
    const file = path.join(workspace, 'scripts', 'build.ps1').replace(/'/g, "''");
    const parse = "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + file + "',[ref]$null,[ref]$e);$e.Count";
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parse], { windowsHide: true });
    assert.equal(stdout.trim(), '0', 'the script parses');
  }
});

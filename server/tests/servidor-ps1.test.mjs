// scripts/servidor.ps1 (docs/FASE2-AGENTE.md 9.2): start called with captured output returns (the node child no longer
// inherits the caller's handles), status, a second start says it is already running, a port already answered by
// another process is refused with exit 1 and no process left, and stop. Ports 7400-7499, temporary SSAM_SERVER_DIR;
// the real `ssam serve` of this checkout starts with workers off and serves no Studio here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'servidor.ps1');
const windows = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-servidor-ps1-'));
const serverDir = path.join(tmp, 'server');
const env = { ...process.env, SSAM_SERVER_DIR: serverDir, SSAM_NODE: process.execPath, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_ODC_OFFLINE: '1' };
delete env.SSAM_SERVER_PORT;

const free = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
async function freePort(skip = []) {
  const start = 7400 + Math.floor(Math.random() * 100);
  for (let i = 0; i < 100; i++) { const port = 7400 + ((start - 7400 + i) % 100); if (!skip.includes(port) && await free(port)) return port; }
  throw new Error('no free port in 7400-7499');
}
// Runs the script with stdout/stderr captured and resolves on 'close', i.e. when every holder of those pipes is gone.
function run(args, limitMs = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => reject(new Error('servidor.ps1 ' + args.join(' ') + ' did not return its output within ' + limitMs + ' ms: ' + out)), limitMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), ms: Date.now() - started }); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
}
const health = port => fetch('http://127.0.0.1:' + port + '/health').then(r => r.json()).catch(() => null);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// node processes whose command line names the temporary server folder (the --log-file path is under it).
function serverProcesses() {
  const filter = serverDir.replaceAll("'", "''");
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" + filter + "*' } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8', windowsHide: true });
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number);
}

let port, startedPid;
test.after(async () => {
  if (windows) {
    await run(['stop']).catch(() => {});
    if (startedPid && alive(startedPid)) process.kill(startedPid);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('start with captured output returns within 30 s and the server answers /health with its pid', { skip: !windows, timeout: 90000 }, async () => {
  port = await freePort();
  const result = await run(['start', '-Port', String(port)]);
  assert.equal(result.code, 0, result.out);
  assert.ok(result.ms < 30000, 'returned in ' + result.ms + ' ms');
  const match = /Servidor no ar: pid (\d+), http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(result.out);
  assert.ok(match, result.out);
  startedPid = Number(match[1]);
  assert.equal(Number(match[2]), port);
  assert.deepEqual(await health(port), { ok: true, pid: startedPid });
  assert.equal(fs.readFileSync(path.join(serverDir, 'server.pid'), 'ascii').trim(), String(startedPid));
  const events = fs.readFileSync(path.join(serverDir, 'server.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(events.some(e => e.event === 'listening' && e.pid === startedPid), 'the server writes its log file');
});

test('status reports the running server', { skip: !windows, timeout: 60000 }, async () => {
  const result = await run(['status']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, new RegExp('Rodando: pid ' + startedPid + ', http://127\\.0\\.0\\.1:' + port + '/mcp \\(responde\\)'));
});

test('a second start says it is already running and starts nothing', { skip: !windows, timeout: 60000 }, async () => {
  const result = await run(['start', '-Port', String(port)]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, new RegExp('Ja esta rodando: pid ' + startedPid));
  assert.deepEqual(serverProcesses(), [startedPid]);
});

test('a port answered by another process (another pid in /health) makes start exit 1 and leaves no process', { skip: !windows, timeout: 60000 }, async () => {
  const otherPort = await freePort([port]);
  const fake = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, pid: 999999 })); });
  await new Promise(resolve => fake.listen(otherPort, '127.0.0.1', resolve));
  const otherDir = path.join(tmp, 'other');
  const saved = env.SSAM_SERVER_DIR;
  env.SSAM_SERVER_DIR = otherDir;
  try {
    const result = await run(['start', '-Port', String(otherPort)]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, new RegExp('Porta ' + otherPort + ' ocupada por outro processo \\(pid 999999\\)'));
    assert.equal(fs.existsSync(path.join(otherDir, 'server.pid')), false);
  } finally { env.SSAM_SERVER_DIR = saved; await new Promise(resolve => fake.close(resolve)); }
  assert.deepEqual(serverProcesses(), [startedPid], 'only the server of the first test runs');
});

test('a stale pid file naming another node process: status says stopped, stop kills nothing, start starts its own server', { skip: !windows, timeout: 90000 }, async () => {
  // Another node.exe (an editor helper, an MCP server, another SSAM server) that took over the recorded pid.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const staleDir = path.join(tmp, 'stale');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'server.pid'), String(other.pid));
  fs.writeFileSync(path.join(staleDir, 'server.json'), JSON.stringify({ pid: other.pid, port: 7499 }));
  const saved = env.SSAM_SERVER_DIR;
  env.SSAM_SERVER_DIR = staleDir;
  let ownPid = null;
  try {
    const status = await run(['status']);
    assert.equal(status.code, 3, status.out); assert.equal(status.out, 'Parado.');
    assert.equal(fs.existsSync(path.join(staleDir, 'server.pid')), false, 'the stale pid file is removed');
    fs.writeFileSync(path.join(staleDir, 'server.pid'), String(other.pid));
    const stopped = await run(['stop']);
    assert.equal(stopped.code, 0, stopped.out); assert.equal(stopped.out, 'Ja estava parado.');
    assert.equal(alive(other.pid), true, 'the other node process is not killed');
    fs.writeFileSync(path.join(staleDir, 'server.pid'), String(other.pid));
    const stalePort = await freePort([port]);
    const started = await run(['start', '-Port', String(stalePort)]);
    assert.equal(started.code, 0, started.out);
    const match = /Servidor no ar: pid (\d+)/.exec(started.out);
    assert.ok(match, 'not a false "already running": ' + started.out);
    ownPid = Number(match[1]);
    assert.notEqual(ownPid, other.pid);
    assert.deepEqual(await health(stalePort), { ok: true, pid: ownPid });
    const end = await run(['stop']);
    assert.match(end.out, new RegExp('Parado: pid ' + ownPid));
    assert.equal(alive(other.pid), true);
  } finally {
    env.SSAM_SERVER_DIR = saved;
    if (ownPid && alive(ownPid)) process.kill(ownPid);
    other.kill();
  }
});

test('stop ends the server; status then says it is stopped', { skip: !windows, timeout: 60000 }, async () => {
  const result = await run(['stop']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, new RegExp('Parado: pid ' + startedPid));
  const end = Date.now() + 5000;
  while (alive(startedPid) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(startedPid), false);
  assert.equal(await health(port), null);
  assert.equal(fs.existsSync(path.join(serverDir, 'server.pid')), false);
  const status = await run(['status']);
  assert.equal(status.code, 3); assert.equal(status.out, 'Parado.');
  assert.deepEqual(serverProcesses(), []);
});

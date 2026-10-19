// start | stop | status | uninstall of agent/ssam-agent.sh (macOS, docs/AGENTE-MAC.md), with the semantics of
// agent\ssam-agent.ps1 (docs/FASE2-AGENTE.md 9.2), written in Node so the same code runs and is tested on any system:
//   start   a node process in the background (no launchd job, no administrator: as on Windows, nothing starts by itself),
//           detached from the terminal and with no inherited output; it counts as up only when the state file has the
//           started pid and says connected (30 s); an agent already running for this folder is kept.
//   status  "Running: pid ..." (0) or "Stopped." with the reason of the last stop (3).
//   stop    clean stop through private/agent.stop (the server is told), then ended by force after 5 s.
//   uninstall  stop, then remove exactly what the pack and the installer put here: the files pack.json lists,
//           pack.json, the Node of the installer (agent/node/node and agent/node/LICENSE), private/ (configuration,
//           credential, key, state and log) and the folders left empty. Folders that still hold work are kept and named.
// A pid reused by another program never counts as the agent (its executable must be node).
//   node agent/lib/launcher.mjs start|stop|status|uninstall --root <folder>
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYOUT } from './workspace.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const INSTALLER_FILES = Object.freeze(['agent/node/node', 'agent/node/LICENSE']);

export function filesOf(root) {
  const dir = path.join(root, 'private');
  return { private: dir, pid: path.join(dir, 'agent.pid'), state: path.join(dir, 'agent.json'), stop: path.join(dir, 'agent.stop'), log: path.join(dir, 'agent.log'),
    credential: path.join(dir, 'credential'), config: path.join(dir, 'config.json') };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// Is this pid a node process (the agent), not a pid reused by another program?
export async function isNodeProcess(pid, { platform = process.platform, run = exec } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return false;
  try {
    if (platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 });
      return /^"node\.exe","\d+"/im.test(String(stdout).trim());
    }
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 15000 });
    return path.posix.basename(String(stdout).trim()) === 'node';
  } catch { return false; }
}

export function exitText(code, { log, node, script, root }) {
  if (code === 2) return 'credential refused, revoked, expired or replaced by the server owner: ask for a new one and run setup again';
  if (code === 3) return 'another agent with the same credential took over this account';
  if (code === 4) return 'the server does not accept this agent version: ask the server owner for the current pack';
  return `see the log ${log}; to see the error on screen: "${node}" --use-env-proxy --use-system-ca "${script}" run --root "${root}"`;
}

// options: root, node (the node to start), script (ssam-agent.mjs), out (a stream), platform, spawn, isAgent, waitMs,
// stopMs, sleep (tests).
export function createLauncher({ root, node = process.execPath, script = path.join(here, '..', 'ssam-agent.mjs'), out = process.stdout, platform = process.platform,
  spawnFn = spawn, isAgent = pid => isNodeProcess(pid, { platform }), waitMs = 30000, stopMs = 5000, sleep = delay } = {}) {
  const f = filesOf(root);
  const say = text => out.write(text + '\n');
  const text = code => exitText(code, { log: f.log, node, script, root });

  // The agent of this folder: the pid this launcher started, else the pid of the state file (an agent started by hand).
  async function running() {
    const fromFile = Number.parseInt(String((() => { try { return fs.readFileSync(f.pid, 'utf8'); } catch { return ''; } })()).trim(), 10);
    if (await isAgent(fromFile)) return fromFile;
    const state = readJson(f.state);
    if (state && state.state !== 'stopped' && Number.isSafeInteger(state.pid) && await isAgent(state.pid)) return state.pid;
    return null;
  }

  async function start() {
    const current = await running();
    if (current) { say(`Already running: pid ${current}. Log: ${f.log}`); return 0; }
    if (!fs.existsSync(f.credential) || !fs.existsSync(f.config)) { say('The agent is not set up: run setup first (docs/AGENTE-MAC.md).'); return 1; }
    fs.rmSync(f.stop, { force: true });
    // Detached (its own session: closing the terminal does not end it), nothing inherited: the agent writes its own log.
    const child = spawnFn(node, ['--use-env-proxy', '--use-system-ca', script, 'run', '--root', root, '--log-file', f.log],
      { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
    let exited = false;
    child.on('exit', () => { exited = true; });
    child.on('error', () => { exited = true; });
    child.unref();
    fs.writeFileSync(f.pid, String(child.pid ?? ''));
    const deadline = Date.now() + waitMs;
    let state = null;
    while (Date.now() < deadline) {
      state = readJson(f.state);
      if (state && state.pid === child.pid && state.state === 'connected') { say(`Agent connected: pid ${child.pid}, server ${state.server}. Log: ${f.log}`); return 0; }
      if (exited) break;
      await sleep(300);
    }
    if (exited || !(await isAgent(child.pid))) {
      const code = state && state.pid === child.pid && Number.isInteger(state.exitCode) ? state.exitCode : 1;
      fs.rmSync(f.pid, { force: true });
      say(`The agent stopped (code ${code}): ${text(code)}`);
      return 1;
    }
    say(`Agent started (pid ${child.pid}), not connected to the server yet; it keeps trying. See status and the log ${f.log}`);
    return 0;
  }

  async function status() {
    const current = await running();
    const state = readJson(f.state);
    if (!current) {
      const last = state && Number.isInteger(state.exitCode) && state.exitCode !== 0 ? ' Last stop: ' + text(state.exitCode) + '.' : '';
      say(`Stopped.${last}`);
      return 3;
    }
    say(`Running: pid ${current}, state ${state?.state ?? '?'} (since ${state?.at ?? '?'}). Log: ${f.log}`);
    return 0;
  }

  async function stop() {
    const current = await running();
    if (!current) { say('Already stopped.'); fs.rmSync(f.pid, { force: true }); fs.rmSync(f.stop, { force: true }); return 0; }
    // Clean stop: the agent sees private/agent.stop, tells the server and exits; after the wait it is ended by force.
    fs.writeFileSync(f.stop, 'stop');
    const deadline = Date.now() + stopMs;
    while (Date.now() < deadline && alive(current)) await sleep(100);
    if (alive(current)) { try { process.kill(current, 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(f.pid, { force: true }); fs.rmSync(f.stop, { force: true });
    say(`Stopped: pid ${current}`);
    return 0;
  }

  async function uninstall() {
    await stop();
    const pack = readJson(path.join(root, 'pack.json'));
    const listed = Array.isArray(pack?.files) ? pack.files.map(entry => String(entry?.path ?? '')) : [];
    const safe = rel => rel && !rel.startsWith('/') && !rel.includes('\\') && !rel.split('/').some(part => part === '' || part === '.' || part === '..');
    let removed = 0;
    const dirs = new Set();
    for (const rel of [...listed, 'pack.json', ...INSTALLER_FILES]) {
      if (!safe(rel)) continue;
      const file = path.join(root, ...rel.split('/'));
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat || stat.isDirectory()) continue;
      fs.rmSync(file, { force: true });
      removed++;
      for (let dir = path.dirname(rel); dir && dir !== '.'; dir = path.posix.dirname(dir)) dirs.add(dir);
    }
    fs.rmSync(f.private, { recursive: true, force: true });
    for (const folder of LAYOUT) for (let dir = folder; dir && dir !== '.'; dir = path.posix.dirname(dir)) dirs.add(dir);
    // Deepest first: a folder goes only when nothing is left in it.
    for (const dir of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1))) {
      const full = path.join(root, ...dir.split('/'));
      try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* missing or not empty */ }
    }
    const kept = [];
    const count = dir => { let n = 0; const walk = d => { for (const item of fs.readdirSync(d, { withFileTypes: true })) { if (item.isDirectory()) walk(path.join(d, item.name)); else n++; } }; try { walk(dir); } catch { /* gone */ } return n; };
    for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const full = path.join(root, name);
      kept.push(fs.statSync(full).isDirectory() ? `${name}/ (${count(full)} files)` : name);
    }
    let rootGone = false;
    try { if (fs.readdirSync(root).length === 0) { fs.rmdirSync(root); rootGone = true; } } catch { /* kept */ }
    say(`Removed ${removed} files of the pack and of the installer, and private/ (configuration, credential, key, state and log).`);
    if (rootGone) say(`The folder ${root} is gone.`);
    else say(`Kept in ${root}, because it holds your work: ${kept.join(', ')}. Delete it yourself if you no longer need it: rm -rf "${root}"`);
    say('A bridge already loaded stays in an open Studio until that Studio closes.');
    return 0;
  }

  return { start, stop, status, uninstall, running };
}

export async function main(argv = process.argv.slice(2)) {
  const [action, flag, value, ...rest] = argv;
  const actions = ['start', 'stop', 'status', 'uninstall'];
  if (!actions.includes(action) || flag !== '--root' || !value || rest.length) {
    process.stdout.write('Usage: launcher.mjs start|stop|status|uninstall --root <folder>\n');
    return 1;
  }
  return createLauncher({ root: path.resolve(value) })[action]();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { process.stdout.write('Error: ' + error.message + '\n'); process.exitCode = 1; });
}

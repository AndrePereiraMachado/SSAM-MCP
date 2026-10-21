// start | stop | status | uninstall of agent/ssam-agent.sh (macOS, docs/AGENTE-MAC.md), with the semantics of
// agent\ssam-agent.ps1 (docs/FASE2-AGENTE.md 9.2), written in Node so the same code runs and is tested on any system:
//   start   a node process in the background (no launchd job, no administrator: as on Windows, nothing starts by itself),
//           detached from the terminal and with no inherited output; it counts as up only when the state file has the
//           started pid and says connected (30 s); an agent already running for this folder is kept.
//   status  "Running: pid ..." (0) or "Stopped." with the reason of the last stop (3).
//   stop    clean stop through private/agent.stop (the server is told), then ended by force after 5 s.
//   uninstall  stop, then remove exactly what the pack and the installer put here: the files pack.json lists,
//           pack.json, the Node of the installer (agent/node/node and agent/node/LICENSE), the files of private/ that the
//           setup record lists (private/installed.json: configuration, credential, Node path, state, pid, log, O11
//           connection, bridge key, the record itself) and, only when they are left empty, the folders of those files
//           and the folders the setup created. Never through a link: each path is checked component by component with
//           lstat from the real root, and a link anywhere in it (or a root whose real folder changed) keeps that item,
//           named with the reason. Anything else (work folders, a file the person had in private/) is kept and named.
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
// The record the setup writes on macOS (review M2): the exact files this installation writes in private/ (the two of the
// setup, the record, the Node path of install.sh, the files of the agent and the key of its O11 bridge) and the folders
// the setup created (those that were not there before). uninstall removes from private/ only these files.
export const INSTALL_RECORD = 'private/installed.json';
export const PRIVATE_FILES = Object.freeze(['private/config.json', 'private/credential', INSTALL_RECORD, 'private/node', 'private/agent.pid',
  'private/agent.json', 'private/agent.stop', 'private/agent.log', 'private/o11-connection.json', 'private/authority/bridge.key']);
// A relative path of the pack or of the record: '/' separators, no empty, '.' or '..' segment, never absolute.
const safeRelative = rel => typeof rel === 'string' && rel !== '' && !rel.startsWith('/') && !rel.includes('\\') && !rel.split('/').some(part => part === '' || part === '.' || part === '..');
// The folders above each relative path ('a/b/c' -> 'a/b', 'a').
const parentsOf = rel => { const out = []; for (let dir = path.posix.dirname(rel); dir && dir !== '.'; dir = path.posix.dirname(dir)) out.push(dir); return out; };

// Without a record (a folder set up by an older pack): the names the setup and the agent always write in private/ and the
// layout folders (removed only when empty).
const withoutRecord = () => ({ files: [...PRIVATE_FILES], folders: [...new Set([...LAYOUT, ...LAYOUT.flatMap(parentsOf)])], recorded: false });
// {files, folders, recorded} of the setup record of a folder.
export function readInstallRecord(root, { files = fs } = {}) {
  let record = null;
  try { record = JSON.parse(files.readFileSync(path.join(root, ...INSTALL_RECORD.split('/')), 'utf8').replace(/^﻿/, '')); } catch { record = null; }
  if (!record || !Array.isArray(record.files) || !Array.isArray(record.folders)) return withoutRecord();
  return { files: record.files.filter(rel => safeRelative(rel) && rel.startsWith('private/')), folders: record.folders.filter(safeRelative), recorded: true };
}

// setup (macOS): the record of what it created. created: the folders it made now; a previous record keeps its folders.
export function writeInstallRecord(root, created, { files = fs, mode = 0o600 } = {}) {
  const previous = readInstallRecord(root, { files });
  const folders = new Set([...(previous.recorded ? previous.folders : []), ...created]);
  const file = path.join(root, ...INSTALL_RECORD.split('/'));
  const temporary = file + '.' + process.pid + '.tmp';
  files.writeFileSync(temporary, JSON.stringify({ by: 'ssam-agent setup', files: [...PRIVATE_FILES], folders: [...folders].sort() }, null, 2), { mode });
  files.renameSync(temporary, file);
}

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
// stopMs, sleep, files (the file system of uninstall: lstatSync, realpathSync, readdirSync, readFileSync, unlinkSync,
// rmdirSync) (tests).
export function createLauncher({ root, node = process.execPath, script = path.join(here, '..', 'ssam-agent.mjs'), out = process.stdout, platform = process.platform,
  spawnFn = spawn, isAgent = pid => isNodeProcess(pid, { platform }), waitMs = 30000, stopMs = 5000, sleep = delay, files = fs } = {}) {
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
    const realOf = target => (files.realpathSync.native ? files.realpathSync.native(target) : files.realpathSync(target));
    let realRoot;
    try { realRoot = realOf(root); } catch (error) { say(`Nothing was removed: the folder ${root} cannot be read (${error.code ?? error.message}).`); return 1; }
    const full = rel => path.join(realRoot, ...rel.split('/'));
    const lstat = target => { try { return files.lstatSync(target); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; } };
    const MISSING = 'missing';
    const CHANGED = new Error('the real folder of the agent changed');
    // Why rel (a file, or a folder when folder is true) is not removed, MISSING when it is not there, or null. Every
    // component from the real root is read with lstat (never followed); the real root is read again for each item.
    const problem = (rel, folder = false) => {
      let now = null;
      try { now = realOf(root); } catch { /* gone */ }
      if (now !== realRoot) throw CHANGED;
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const sub = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        let stat;
        try { stat = lstat(full(sub)); } catch (error) { return `${sub} cannot be checked (${error.code ?? error.message})`; }
        if (!stat) return MISSING;
        if (stat.isSymbolicLink()) return last ? 'it is a link' : `${sub} is a link`;
        if (!last && !stat.isDirectory()) return `${sub} is not a folder`;
        if (last && folder !== stat.isDirectory()) return folder ? 'it is not a folder' : 'it is a folder';
        if (last && !folder && !stat.isFile()) return 'it is not a regular file';
      }
      return null;
    };
    const skipped = [];
    let removed = 0;
    let record = null;
    const folders = new Set(['agent/node']);
    const removeFile = rel => {
      const why = problem(rel);
      if (why === MISSING) return false;
      if (why) { skipped.push(`${rel} (${why})`); return false; }
      try { files.unlinkSync(full(rel)); removed++; return true; } catch (error) { skipped.push(`${rel} (${error.code ?? error.message})`); return false; }
    };
    try {
      // pack.json and the record are read only when no link leads to them.
      let pack = null;
      if (problem('pack.json') === null) { try { pack = JSON.parse(files.readFileSync(full('pack.json'), 'utf8').replace(/^﻿/, '')); } catch { pack = null; } }
      record = problem(INSTALL_RECORD) === null ? readInstallRecord(realRoot, { files }) : withoutRecord();
      const listed = Array.isArray(pack?.files) ? pack.files.map(entry => String(entry?.path ?? '')) : [];
      // The pack and the installer: their folders go when left empty.
      for (const rel of [...listed, 'pack.json', ...INSTALLER_FILES]) if (safeRelative(rel) && removeFile(rel)) for (const dir of parentsOf(rel)) folders.add(dir);
      // private/: only the recorded files; its folders only when the setup created them.
      for (const rel of record.files) removeFile(rel);
      for (const dir of record.folders) folders.add(dir);
      // Deepest first: a folder goes only when nothing is left in it (and never through a link).
      for (const dir of [...folders].filter(safeRelative).sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1))) {
        if (problem(dir, true) !== null) continue;
        try { if (files.readdirSync(full(dir)).length === 0) files.rmdirSync(full(dir)); } catch { /* not empty */ }
      }
    } catch (error) {
      if (error !== CHANGED) throw error;
      say(`Stopped: the real folder of ${root} changed while removing (it was ${realRoot}); nothing more was removed (${removed} files were). Run uninstall again from a Terminal once the folder is back where it was.`);
      return 1;
    }
    const kept = [];
    const count = dir => { let n = 0; const walk = d => { for (const item of files.readdirSync(d, { withFileTypes: true })) { if (item.isDirectory()) walk(path.join(d, item.name)); else n++; } }; try { walk(dir); } catch { /* gone */ } return n; };
    let names = [];
    try { names = files.readdirSync(realRoot); } catch { /* gone */ }
    for (const name of names) {
      const stat = lstat(full(name));
      kept.push(stat?.isSymbolicLink() ? `${name} (a link)` : stat?.isDirectory() ? `${name}/ (${count(full(name))} files)` : name);
    }
    let rootGone = false;
    if (names.length === 0) { try { if (realOf(root) === realRoot && !lstat(root)?.isSymbolicLink()) { files.rmdirSync(root); rootGone = true; } } catch { /* kept */ } }
    say(`Removed ${removed} files of the pack, of the installer and of the setup` + (record?.recorded ? '.' : ' (this folder has no setup record: from private/ only the names the setup and the agent write there).'));
    if (skipped.length) say(`Not removed: ${skipped.join(', ')}. The agent never deletes through a link; remove these yourself if you want them gone.`);
    if (rootGone) say(`The folder ${root} is gone.`);
    else say(`Kept in ${root} (your work and anything the installation did not put there): ${kept.join(', ') || 'nothing but the folder itself'}. Delete it yourself if you no longer need it: rm -rf "${root}"`);
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

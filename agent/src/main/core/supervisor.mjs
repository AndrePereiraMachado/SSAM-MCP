// The agent, supervised by the app: installedPack uses the bundled runtime in place; legacy callers may sync it.
// The agent is started as a child process with the
// same command line ssam-agent.ps1 and ssam-agent.sh use (`ssam-agent.mjs run --root <root> --log-file <log>`, Node
// with --use-env-proxy and --use-system-ca when the runtime has them), watched through the state file the agent
// writes, stopped cleanly through private/agent.stop (the server is told) and ended by force after 5 s, restarted
// after a crash with a growing delay and never after an exit the agent decided for good (codes 2, 3, 4). setup, doctor
// and status run in this process, from the selected runtime module (the same functions its command line calls).
// Everything that touches the system is injectable (fork, importAgent, sleep, now), so tests run it under plain Node
// against the fake hub of the agent tests.
//   fork(script, args, {cwd, env, execArgv, stdio}) -> {ready: Promise<pid>, on('exit', code), on('error', error), kill()}
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { rootFiles } from './paths.mjs';
import { syncPack, verifyPack, readPackJson } from './pack-sync.mjs';
import { readState, isSetUp, exitPolicy, restartDelayMs, summarize, STALE_MS } from './agent-state.mjs';
import { spawnNative, nativeCommand } from './native-process.mjs';

export const NODE_FLAGS = Object.freeze(['--use-env-proxy', '--use-system-ca']);
export const CONNECT_WAIT_MS = 30000;
export const STOP_WAIT_MS = 5000;
export const POLL_MS = 500;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };

// The Node flags of NODE_FLAGS this runtime knows (the child is the same binary as this process).
export const supportedFlags = (flags = process.allowedNodeEnvironmentFlags) => NODE_FLAGS.filter(flag => flags.has(flag));

export function createSupervisor({ root, packDir, installedPack = false, fork, importAgent = defaultImport, execArgv = supportedFlags(), env = process.env, platform = process.platform,
  log = () => {}, onChange = () => {}, sleep = delay, now = Date.now } = {}) {
  const runtimeRoot = installedPack ? packDir : root;
  if (installedPack) {
    const data = path.resolve(root); const code = path.resolve(packDir);
    const overlaps = (a, b) => { const rel = path.relative(a, b); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
    if (overlaps(data, code) || overlaps(code, data)) throw new Error('The installation and data directories must be separate.');
  }
  const files = rootFiles(root, runtimeRoot);
  const nativeExecutable = () => {
    const core = readPackJson(runtimeRoot)?.nativeCore;
    if (!core) return null;
    const expected = platform === 'win32' ? 'native/ssam-agent.exe' : platform === 'darwin' ? 'native/ssam-agent' : null;
    if (core.runtime !== 'native-aot' || !expected || core.path !== expected) throw new Error('Unsupported native agent runtime.');
    return path.join(runtimeRoot, core.path);
  };
  let child = null; let childPid = null; let lastExit = null; let stopping = false; let crashes = 0;
  let restartTimer = null; let watchTimer = null; let packProblem = null; let lastSync = null;
  let busy = false;

  const notify = () => { try { onChange(snapshot()); } catch { /* a listener failed */ } };

  // Import from the selected runtime, never from an old copy when installedPack is enabled.
  async function agentModule() {
    const pack = readPackJson(runtimeRoot);
    return importAgent(files.script, pack?.id ?? 'none');
  }

  function externalAgent() {
    const state = readState(files.state);
    if (!state || state.state === 'stopped' || !state.pid || state.pid === childPid || state.pid === process.pid) return null;
    return alive(state.pid) && state.at && now() - Date.parse(state.at) < STALE_MS ? state : null;
  }

  function snapshot() {
    const state = readState(files.state);
    const external = !child && externalAgent();
    const setUp = isSetUp(files);
    const view = summarize({ setUp, running: Boolean(child), state: child ? (state?.pid === childPid ? state : null) : state, external: Boolean(external), lastExit, packProblem });
    const pack = readPackJson(runtimeRoot);
    const config = (() => { try { return JSON.parse(fs.readFileSync(files.config, 'utf8')); } catch { return null; } })();
    return { view, root, setUp, server: config?.server ?? null, o11Port: config?.o11Port ?? null, pid: child ? childPid : external ? external.pid : null,
      state: state ?? null, lastExit, pack: pack ? { id: pack.id ?? null, lanes: pack.lanes ?? [], odcBridge: pack.odcBridge ?? null, o11BuiltFor: pack.o11BuiltFor ?? null, platform: pack.platform ?? 'windows' } : null,
      bundledPack: readPackJson(packDir)?.id ?? null, lastSync, busy, log: files.log, inbox: files.inbox };
  }

  // The bundled pack checked, then synced into the root (never while the agent runs). {synced, copied, removed, failed}.
  function syncPackNow() {
    if (child) throw new Error('The agent is running: stop it before syncing the pack.');
    const check = verifyPack(packDir);
    if (!check.ok) { packProblem = `The pack bundled with this app is damaged (${check.detail}); install the app again.`; notify(); throw new Error(packProblem); }
    if (installedPack && check.pack.lanes?.includes('odc') && !/^v(?:9[8-9]|[1-9]\d{2,})$/.test(check.pack.odcBridge ?? '')) {
      packProblem = 'This installed runtime needs ODC bridge v98 or newer with the data-root protocol. Rebuild the agent pack.';
      notify(); throw new Error(packProblem);
    }
    packProblem = null;
    fs.mkdirSync(root, { recursive: true });
    // Installed packs stay beside the app. Existing legacy copies are left untouched;
    // only data is reused, and no code is imported from the user's old data root.
    lastSync = installedPack
      ? { synced: false, installed: true, pack: check.pack.id, copied: [], removed: [], failed: [] }
      : syncPack(packDir, root, { platform, log });
    notify();
    return lastSync;
  }

  function startWatch() {
    stopWatch();
    let last = null;
    watchTimer = setInterval(() => {
      let text = null;
      try { text = fs.readFileSync(files.state, 'utf8'); } catch { text = null; }
      if (text !== last) { last = text; notify(); }
    }, POLL_MS);
    if (watchTimer.unref) watchTimer.unref();
  }
  function stopWatch() { if (watchTimer) clearInterval(watchTimer); watchTimer = null; }

  // The agent started; resolves {started, connected, code} once it says connected, ends, or CONNECT_WAIT_MS pass.
  async function start() {
    if (child) return { started: true, connected: readState(files.state)?.state === 'connected', already: true };
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (!isSetUp(files)) throw new Error('The agent is not set up: enter the server address and the credential first.');
    const external = externalAgent();
    if (external) throw new Error(`Another agent already runs in this folder (pid ${external.pid}). Stop it first.`);
    if (installedPack || !readPackJson(runtimeRoot) || !fs.existsSync(files.script)) syncPackNow();
    stopping = false;
    fs.rmSync(files.stop, { force: true });
    const executable = nativeExecutable();
    const started = (executable ? spawnNative : fork)(executable ?? files.script, ['run', '--root', root, '--runtime-root', runtimeRoot, '--log-file', files.log], { cwd: root, env, execArgv, stdio: 'ignore' });
    child = started;
    let exited = null;
    started.on('error', error => { log('agent-error', { error: error.message }); });
    started.on('exit', code => { exited = Number.isInteger(code) ? code : 1; onExit(started, exited); });
    // The pid once the process exists (a utility process of Electron has none until its spawn event).
    try { childPid = await Promise.race([started.ready, sleep(10000).then(() => { throw new Error('the agent process did not start in 10 s'); })]); }
    catch (error) { if (child === started) { child = null; try { started.kill(); } catch { /* never started */ } } throw error; }
    if (child !== started) return { started: false, connected: false, code: exited };
    try { fs.writeFileSync(files.pid, String(childPid ?? '')); } catch { /* private/ missing: the agent will say so */ }
    log('agent-start', { pid: childPid, execArgv });
    startWatch();
    notify();
    const deadline = now() + CONNECT_WAIT_MS;
    while (now() < deadline && exited === null) {
      const state = readState(files.state);
      if (state && state.pid === childPid && state.state === 'connected') { notify(); return { started: true, connected: true, code: null }; }
      await sleep(300);
    }
    notify();
    return { started: exited === null, connected: false, code: exited };
  }

  function onExit(which, code) {
    if (child !== which) return;
    child = null;
    stopWatch();
    lastExit = stopping ? 0 : code;
    fs.rmSync(files.pid, { force: true });
    const policy = stopping ? 'stopped' : exitPolicy(code);
    log('agent-exit', { pid: childPid, code, policy });
    if (policy === 'restart') {
      const wait = restartDelayMs(crashes++);
      restartTimer = setTimeout(() => { restartTimer = null; start().catch(error => log('agent-restart-failed', { error: error.message })); }, wait);
      if (restartTimer.unref) restartTimer.unref();
      log('agent-restart-scheduled', { delayMs: wait });
    } else crashes = 0;
    stopping = false;
    notify();
  }

  // A clean stop: private/agent.stop, up to STOP_WAIT_MS, then kill.
  async function stop() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (!child) { fs.rmSync(files.stop, { force: true }); return { stopped: false }; }
    stopping = true;
    const which = child;
    const pid = childPid;
    let exited = false;
    which.on('exit', () => { exited = true; });
    try { fs.writeFileSync(files.stop, 'stop'); } catch { /* private/ gone: kill below */ }
    const deadline = now() + STOP_WAIT_MS;
    while (now() < deadline && child === which && !exited) await sleep(100);
    if (child === which && !exited) { log('agent-kill', { pid }); try { which.kill(); } catch { /* already gone */ } }
    const end = now() + 3000;
    while (child === which && now() < end) await sleep(50);
    fs.rmSync(files.stop, { force: true });
    return { stopped: true, pid };
  }

  // The agent's own setup with the credential handed over as its standard input (never an argument, never a file).
  async function setup({ server, credential, o11Port = null }) {
    if (child) throw new Error('Stop the agent before changing its setup.');
    if (installedPack || !readPackJson(runtimeRoot) || !fs.existsSync(files.script)) syncPackNow();
    const executable = nativeExecutable();
    if (executable) {
      busy = true; notify();
      try {
        const result = await nativeCommand(executable, ['setup', '--root', root, '--runtime-root', runtimeRoot, '--server', server,
          ...(o11Port === null || o11Port === '' ? [] : ['--o11-port', String(o11Port)])], { cwd: root, env, input: String(credential ?? '').trim() + '\n' });
        lastExit = null;
        return { ok: result.code === 0, ...result };
      } finally { busy = false; notify(); }
    }
    const agent = await agentModule();
    const stdout = sink(); const stderr = sink();
    const stdin = Object.assign(Readable.from([String(credential ?? '').trim() + '\n']), { isTTY: false });
    busy = true; notify();
    let code;
    try { code = await agent.setup({ root, server, o11Port: o11Port === null || o11Port === '' ? undefined : o11Port, stdin, stdout, stderr, env, platform }); }
    finally { busy = false; }
    lastExit = null;
    notify();
    return { ok: code === 0, code, output: stdout.text(), error: stderr.text().replace(/^Error: /, '').trim() };
  }

  async function doctor() {
    const executable = nativeExecutable();
    if (executable) {
      busy = true; notify();
      try {
        const result = await nativeCommand(executable, ['doctor', '--root', root, '--runtime-root', runtimeRoot, '--json'], { cwd: root, env });
        let report = null; try { report = JSON.parse(result.output); } catch { }
        return { ok: result.code === 0, code: result.code, report, text: result.output || result.error };
      } finally { busy = false; notify(); }
    }
    const agent = await agentModule();
    const stdout = sink();
    busy = true; notify();
    let code;
    try { code = await agent.doctor({ root, runtimeRoot, stdout, json: true }); }
    finally { busy = false; notify(); }
    let report = null;
    try { report = JSON.parse(stdout.text()); } catch { report = null; }
    return { ok: code === 0, code, report, text: stdout.text() };
  }

  async function shutdown() { await stop(); stopWatch(); }

  return { files, start, stop, setup, doctor, syncPack: syncPackNow, snapshot, shutdown, get running() { return Boolean(child); }, get pid() { return childPid; } };
}

// The agent's module from the root; `tag` (the pack id) busts the module cache after a pack sync.
export const defaultImport = (script, tag) => import(pathToFileURL(script).href + '?pack=' + encodeURIComponent(tag));

// A fork over a Node executable (the tests; a checkout run with SSAM_AGENT_NODE): the shape utilityProcess.fork gives.
export const forkWithNode = (node = process.execPath) => (script, args, { cwd, env, execArgv = [], stdio = 'ignore' } = {}) => {
  const proc = spawn(node, [...execArgv, script, ...args], { cwd, env, stdio, windowsHide: true });
  const ready = new Promise((resolve, reject) => { proc.once('error', reject); if (proc.pid) resolve(proc.pid); else proc.once('spawn', () => resolve(proc.pid)); });
  ready.catch(() => {});
  return { pid: proc.pid, ready, on: (event, fn) => { if (event === 'exit') proc.on('exit', (code, signal) => fn(code === null ? (signal ? 1 : 0) : code)); else proc.on(event, fn); },
    kill: () => proc.kill('SIGKILL'), stdout: proc.stdout, stderr: proc.stderr };
};

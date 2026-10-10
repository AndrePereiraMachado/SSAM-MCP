import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { observeCli, observeInlineCli, observeMcp, lineChannel } from './friction-boundary.mjs';
import { connectionEnvironment } from '../platforms/odc/facade/studio-session.mjs';
// The identity of what the MCP child loads (C11); a layout without it (a copied launcher) never reloads.
const identityModule = await import('../platforms/odc/facade/facade-identity.mjs').catch(() => null);
const createIdentityReader = identityModule?.createIdentityReader ?? (() => ({ read: () => ({ facadeSha256: null, catalogSha256: null, launcherSha256: null }) }));

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const layout = JSON.parse(fs.readFileSync(path.join(root, '.ssam-workspace.json'), 'utf8'));
export function environment(source = process.env) {
  const lane = source.ANVIL_LANE ?? layout.o11Lane;
  const odc = path.join(root, layout.odc);
  return { ...source, ...connectionEnvironment(path.join(root, layout.kernel), lane), SSAM_WORKSPACE_ROOT: root, ANVIL_ROOT: path.join(root, layout.kernel),
    SSAM_HYBRID_ODC_ROOT: odc, ANVIL_ODC_ROOT: odc, ODC3_ROOT: odc, ANVIL_LANE: lane,
    ANVIL_WORKER_PORT: String(lane === 'ss4' ? layout.workers.o11ss4 : layout.workers.o11ss5),
    ANVIL_ODC_PORT: String(layout.workers.odc),
    // The folder the client launched this entry from: the server runs in the root, so ssam_doctor reads the session's SSAM
    // root from it (WRONG_SERVER when it is another root; platforms/odc/facade/server-identity.mjs).
    SSAM_CLIENT_CWD: source.SSAM_CLIENT_CWD || process.cwd(),
    // Optional "mcpLanes" in .ssam-workspace.json narrows the MCP server of this checkout to the listed lanes; unset serves both.
    ...(layout.mcpLanes ? { SSAM_MCP_LANES: layout.mcpLanes.join(',') } : {}) };
}
export function launch(entry, args = process.argv.slice(2)) {
  if (args[0] === 'friction') {
    return import('./friction-cli.mjs').then(({main})=>main(args.slice(1),{root}))
      .then(result=>{process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.ok)process.exitCode=1;})
      .catch(()=>{process.stderr.write('{"ok":false,"error":"Invalid friction command; use ssam friction help"}\n');process.exitCode=1;});
  }
  // The dedicated root package CLI needs no second Node process. Keep the same
  // platform entry as dispatcher, including its argument validation and errors.
  const dedicated = process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'facade', 'ssam.mjs');
  if (entry === 'ssam' && dedicated && args[0] === 'package' && args[1] === 'run'
      && !args.some(arg => ['--help', '-h'].includes(arg))
      && fs.existsSync(path.join(root, '.local', 'releases', 'active-readonly.json'))) {
    const forwarded = normalizePaths(args);
    const childEnvironment = environment();
    const target = path.join(root, layout.odc, 'facade', 'ssam.mjs');
    observeInlineCli({root,entry,args:forwarded});
    try {
      process.chdir(root);
      Object.assign(process.env, childEnvironment);
      process.argv = [process.execPath, target, ...forwarded];
      return import(pathToFileURL(target).href).catch(error => {
        process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
        process.exitCode = 1;
      });
    } catch (error) {
      process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
      process.exitCode = 1;
      return;
    }
  }

  // The served MCP and its token admin run in THIS process (one pid for scripts\servidor.ps1 to stop), with the same
  // environment the lane child would get and no friction observer buffering a long-lived or secret output
  // (docs/SERVIDOR-LOCAL.md).
  if (entry === 'ssam' && ['serve', 'server-token'].includes(args[0])) {
    const target = path.join(root, layout.odc, 'facade', 'ssam.mjs');
    process.chdir(root);
    Object.assign(process.env, environment());
    process.argv = [process.execPath, target, ...args];
    return import(pathToFileURL(target).href).catch(error => {
      process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
      process.exitCode = 1;
    });
  }
  const mcp = args[0] === 'mcp' || (args[0] === 'package' && args[1] === 'mcp');
  const forwarded = normalizePaths(args);
  const entryFile = path.join(root, layout.odc, 'facade', entry + '.mjs');
  if (mcp) {
    // C11 (atritos 3): the MCP server child is reloaded in place when the facade or the catalog it loaded change
    // (createMcpRelay below); the parent process (this file and facade/friction-*.mjs) is what still needs a reconnection.
    const identity = createIdentityReader({ root, odc: layout.odc });
    const loaded = identity.read();
    let serverInputBlocked=false,clientOutputBlocked=false,relay;
    const requestFlow=()=>{if(serverInputBlocked||clientOutputBlocked)process.stdin.pause();else process.stdin.resume();};
    const observer = observeMcp({root,entry,args:forwarded,
      toServer:chunk=>relay.toServer(chunk),
      toClient:chunk=>{if(!process.stdout.write(chunk)){clientOutputBlocked=true;relay.pauseOutput();requestFlow();}}});
    relay = createMcpRelay({
      spawnChild: extra => spawn(process.execPath, [entryFile, ...forwarded], { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'],
        env: { ...environment(), ...(loaded.launcherSha256 ? { SSAM_LAUNCHER_SHA256: loaded.launcherSha256 } : {}), ...extra } }),
      identity: () => identity.read(), loaded,
      toObserver: chunk => observer.response.write(chunk),
      onInputBlocked: blocked => { serverInputBlocked = blocked; requestFlow(); },
      stderr: process.stderr,
      onExit: code => { observer.close(); process.stdin.removeListener('data',observer.request.write); process.stdin.pause(); process.exitCode = code ?? 1; },
    });
    relay.start();
    process.stdin.on('data',observer.request.write);
    process.stdin.on('end',()=>{observer.request.end();relay.endInput();});
    process.stdout.on('drain',()=>{clientOutputBlocked=false;relay.resumeOutput();requestFlow();});
    process.on('SIGINT', () => relay.kill('SIGINT'));
    process.on('SIGTERM', () => relay.kill('SIGTERM'));
    return;
  }
  const child = spawn(process.execPath, [entryFile, ...forwarded], {
    cwd: root, env: environment(), stdio: ['inherit','pipe','pipe'], windowsHide: true,
  });
  const observer = observeCli({root,entry,args:forwarded});
  child.stdout.on('data',observer.stdout);child.stderr.on('data',observer.stderr);
  child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});
  let transportError=false;
  child.on('error', error => { transportError=true;process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('close', (code,signal) => { observer.finish(code,!!signal,transportError); process.exitCode = code ?? 1; });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// ---- The MCP relay of the launcher (C11 of the atritos 3 package). A long-lived MCP process used to keep the facade it
// started with, and a session had to reconnect after every release (RELEASE_CHANGED). The relay sits between the client
// (through the friction observer) and the server child:
// - it keeps the client's `initialize` request and notes its `notifications/initialized`;
// - it tracks what is pending in both directions (client requests without an answer, server requests such as an
//   elicitation without the client's answer, and a tools/call answered input_required whose continuation is still due);
// - before it passes a tools/call with nothing pending, it compares the identity of the facade and the catalog
//   (facade-identity.mjs, a cache of 2 s) with the one the child loaded. When they differ it starts a new child, sends it
//   the client's initialize under an internal id and swallows that answer, sends initialized, ends the old child and only
//   then passes the call (and every line that arrived meanwhile, in order). A catalog change also tells the client
//   notifications/tools/list_changed. The new child gets SSAM_RELOADED_AT and SSAM_RELOADED_FROM (ssam_doctor server.*).
// - A new child that does not answer its initialize within initTimeoutMs is ended and the old one keeps serving (it then
//   answers RELEASE_CHANGED itself); the same identity is not tried again.
// Nothing is reloaded with anything pending: the old child answers the call and, its facade being old, says
// RELEASE_CHANGED. A change of this file or of facade/friction-*.mjs (the parent process) is reloaded too, but only a
// reconnection loads it here; the child says so (SSAM_LAUNCHER_SHA256).
const RELOAD_ID = 'ssam-launcher-reload-';
export function createMcpRelay({ spawnChild, identity, loaded = identity(), toObserver, onInputBlocked = () => {}, onExit = () => {}, stderr = null,
  initTimeoutMs = 60000, now = () => new Date() } = {}) {
  const key = id => JSON.stringify(id);
  let child = null, current = loaded, failedFor = null, reloads = 0;
  let initialize = null, initialized = false, openInput = false, reloading = false, outputPaused = false, inputEnded = false;
  const clientPending = new Map(), serverPending = new Set(), held = [];
  const write = (proc, line) => { if (proc && !proc.stdin.destroyed && !proc.stdin.write(line)) onInputBlocked(true); };
  // The lines a child writes: tracked, and passed on only while it is the current child.
  function attach(proc, { onLine } = {}) {
    const channel = lineChannel({ onRaw: line => { if (proc === child) toObserver(line); },
      onMessage: message => (onLine?.(message) === true) || (proc === child ? track(message) : false) });
    proc.stdout.on('data', chunk => channel.write(chunk));
    proc.stdout.on('end', () => channel.end());
    if (stderr) proc.stderr?.pipe?.(stderr, { end: false });
    proc.stdin.on('drain', () => { if (proc === child) onInputBlocked(false); });
    proc.stdin.on('error', () => {}); // a child ending: recorded by its close; nothing is replayed
    proc.on('error', error => { if (proc === child) { stderr?.write?.(error.message + '\n'); } });
    proc.on('close', (code, signal) => { if (proc === child) onExit(code, signal); });
    if (outputPaused) proc.stdout.pause();
  }
  // What a server line tells: a request of the server is pending until the client answers; an answer settles a client
  // request (and an input_required answer keeps the call open).
  function track(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.id === undefined) return false;
    if (message.method) { serverPending.add(key(message.id)); return false; }
    const method = clientPending.get(key(message.id));
    clientPending.delete(key(message.id));
    if (method === 'tools/call') openInput = message.result?.resultType === 'input_required';
    return false;
  }
  const changed = next => {
    const parts = [];
    for (const [part, field] of [['facade', 'facadeSha256'], ['catalog', 'catalogSha256']]) if (current?.[field] != null && current[field] !== next?.[field]) parts.push(part);
    return parts;
  };
  function due() {
    if (!initialize || !initialized || clientPending.size || serverPending.size || openInput) return null;
    let next; try { next = identity(); } catch { return null; }
    const parts = changed(next);
    if (!parts.length || (failedFor && failedFor.facadeSha256 === next.facadeSha256 && failedFor.catalogSha256 === next.catalogSha256)) return null;
    return { next, parts };
  }
  function start() { child = spawnChild({}); attach(child); }
  function reload({ next, parts }) {
    reloading = true;
    const id = RELOAD_ID + (++reloads);
    const from = { facadeSha256: current?.facadeSha256 ?? null, catalogSha256: current?.catalogSha256 ?? null };
    let proc, settled = false, timer = null;
    const early = [];
    const finish = ok => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (ok) {
        const old = child;
        child = proc; current = next; failedFor = null;
        for (const line of early) toObserver(line);
        try { old?.stdin.end(); } catch { /* gone */ }
        try { old?.kill(); } catch { /* gone */ }
        if (parts.includes('catalog')) toObserver(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
      } else {
        failedFor = next;
        try { proc?.kill(); } catch { /* gone */ }
      }
      reloading = false;
      for (const line of held.splice(0)) toServer(line);
      if (inputEnded) { try { child?.stdin.end(); } catch { /* gone */ } }
    };
    try { proc = spawnChild({ SSAM_RELOADED_AT: now().toISOString(), SSAM_RELOADED_FROM: JSON.stringify(from) }); }
    catch { finish(false); return; }
    attach(proc, { onLine: message => {
      if (message?.id === id) {
        if (message.result) { write(proc, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); finish(true); }
        else finish(false);
        return true;
      }
      if (!settled && proc !== child) { early.push(JSON.stringify(message) + '\n'); return true; }
      return false;
    } });
    proc.on('close', () => { if (!settled) finish(false); });
    timer = setTimeout(() => finish(false), initTimeoutMs);
    timer.unref?.();
    write(proc, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: initialize.params ?? {} }) + '\n');
  }
  // A client line on its way to the server child.
  function toServer(line) {
    if (reloading) { held.push(line); return; }
    let message = null;
    try { message = JSON.parse(line); } catch { message = null; }
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      if (message.method === 'initialize' && message.id !== undefined) initialize = message;
      if (message.method === 'notifications/initialized') initialized = true;
      if (message.method === 'notifications/cancelled') clientPending.delete(key(message.params?.requestId));
      if (message.method === 'tools/call' && message.id !== undefined) {
        const reloadNow = due();
        if (reloadNow) { held.push(line); reload(reloadNow); return; }
      }
      if (message.method && message.id !== undefined) clientPending.set(key(message.id), message.method);
      else if (!message.method && message.id !== undefined) serverPending.delete(key(message.id));
    }
    write(child, line);
  }
  return {
    start, toServer,
    endInput() { inputEnded = true; if (!reloading) { try { child?.stdin.end(); } catch { /* gone */ } } },
    pauseOutput() { outputPaused = true; child?.stdout.pause(); },
    resumeOutput() { outputPaused = false; child?.stdout.resume(); },
    kill(signal) { try { child?.kill(signal); } catch { /* gone */ } },
    get state() { return { reloads, current, pending: clientPending.size + serverPending.size, openInput, reloading, child }; },
  };
}

// Root CLI paths follow the caller's directory, before the lane changes its working directory.
export function normalizePaths(args, cwd = process.cwd()) {
  const result = [...args];
  const pathOptions = new Set(['--job', '--base', '--out', '--output', '--candidate', '--manifest', '--evidence',
    '--work', '--oml', '--result', '--spec', '--catalog', '--credentials', '--foreign', '--request', '--value-file']);
  // `discover --app <capture.oml>` is a path only when it names a file; a module name stays as typed.
  if (result[0] === 'discover') for (let i = 1; i < result.length; i++) if (result[i] === '--app' && result[i + 1] && /\.oml$/i.test(result[i + 1])) result[i + 1] = path.resolve(cwd, result[i + 1]);
  if (result[0] === 'package') for (const name of ['--package', '--selection', '--session', '--file']) pathOptions.add(name);
  for (let i = 1; i < result.length; i++) {
    if (pathOptions.has(result[i]) && result[i + 1] && !result[i + 1].startsWith('--')) { i++; result[i] = path.resolve(cwd, result[i]); }
    else if (result[i] === '--producer' && result[i + 1]?.includes('=')) {
      i++;
      const split = result[i].indexOf('=');
      result[i] = result[i].slice(0, split + 1) + path.resolve(cwd, result[i].slice(split + 1));
    }
  }
  // inspect and map take a capture .oml or a module name; only the .oml is a path.
  if (['job', 'inspect', 'map', 'publish'].includes(result[0])) {
    for (let i = 1; i < result.length; i++) {
      if (result[i].startsWith('--')) { if (!['--quiet', '--full', '--all', '--usages', '--include-internal', '--cold', ...(result[0] === 'map' ? ['--detail'] : [])].includes(result[i])) i++; continue; }
      if (!['inspect', 'map'].includes(result[0]) || result[i].toLowerCase().endsWith('.oml')) result[i] = path.resolve(cwd, result[i]);
      break;
    }
  }
  if (result[0] === 'studio' && ['check-base', 'preview', 'merge', 'authorize', 'publish', 'create'].includes(result[1]) && result[2]) result[2] = path.resolve(cwd, result[2]);
  return result;
}

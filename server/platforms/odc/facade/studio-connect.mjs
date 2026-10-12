import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LANES, anvilLaneFacts, studioProcesses } from './lanes.mjs';
import { connectionFile, readConnection } from './studio-session.mjs';
import { LocalExecutor, currentExecutor, o11NotConnected, workspacePath } from './executor.mjs';

const exec = promisify(execFile);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A state that has no event to wait on is polled with backoff (250 ms, doubling, capped at 2 s) up to a deadline. The
// first check runs at once, and the loop returns as soon as `check` answers truthy (that value), or null at the deadline.
export async function pollWithBackoff(check, { deadlineMs = 30000, initialMs = 250, maxMs = 2000, sleep = delay, now = Date.now } = {}) {
  const deadline = now() + deadlineMs;
  for (let wait = initialMs; ; wait = Math.min(maxMs, wait * 2)) {
    const value = await check();
    if (value) return value;
    const left = deadline - now();
    if (left <= 0) return null;
    await sleep(Math.min(wait, left));
  }
}

// Only connection health is inspected. A module can be unsaved, invalid or unpublished.
export function bridgeCall(port, method, authorization, params = {}, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout, () => finish(new Error('Bridge handshake timed out.')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ method, params, ...(authorization ? { authorization } : {}) }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 65536) return finish(new Error('Bridge handshake exceeded its size limit.'));
      if (data.includes('\n')) {
        try { finish(null, JSON.parse(data.split('\n')[0])); } catch { finish(new Error('Unexpected service on the bridge port.')); }
      }
    });
    socket.on('end', () => finish(new Error('Bridge closed the handshake without a reply.')));
  });
}

// The handshake round trips (ping, bridge_manifest, ui_alive) go through the executor seam: locally bridgeCall on the
// port, as before; otherwise its o11.bridge call (hosted: the customer's agent, with no port and no key from here).
async function handshake(port, method, authorization, params = {}, timeout = 2500) {
  const executor = currentExecutor();
  if (executor instanceof LocalExecutor) return bridgeCall(port, method, authorization, params, timeout);
  return (await executor.call('o11.bridge', { method, params, timeoutMs: timeout })).reply;
}

export async function probeO11(port) {
  try {
    const reply = await handshake(port, 'ping');
    if (reply.success !== true || reply.data?.bridge !== 'anvil' || !Number.isInteger(reply.data.pid))
      return { connected: false, occupied: true, error: 'The port belongs to another service.' };
    const manifest = await handshake(port, 'bridge_manifest');
    if (manifest.success !== true || manifest.data?.protocolVersion !== 2 || manifest.data?.authentication !== true)
      return { connected: false, occupied: true, error: 'The loaded bridge has an unsupported protocol.' };
    return { connected: true, pid: reply.data.pid, version: reply.data.version, port };
  } catch (error) {
    return { connected: false, occupied: !['ECONNREFUSED', 'BRIDGE_NOT_LISTENING'].includes(error.code), error: error.message, port };
  }
}

// D5 (atritos 3): a Service Studio process without a main window (the user closed it; the hidden Service Center window of
// an older bridge kept the process running) is never the lane's Studio. lanes.studioProcesses says so (window:false, read
// from the system only); SSAM never closes or ends a Studio.
export const STUDIO_WINDOWLESS = 'STUDIO_WINDOWLESS';
export const WINDOWLESS_FIX = 'o SSAM ignora este processo; o Studio com janela é o da lane. Sem a janela principal ele termina sozinho quando a janela do Service Center fecha (bridge novo); um bridge antigo o mantém vivo e segurando a porta da lane: encerre-o pelo Gerenciador de Tarefas. O SSAM nunca fecha nem encerra um Studio.';
export const isWindowless = process => process?.window === false;
// Pattern 5 of the UI freeze (2026-10-08, 4-5 Studio restarts): after a restart a ServiceStudio.exe without a window stayed.
// Precisely: a windowless process younger than STARTING_MS is a Studio still opening (its main window comes later): state
// "starting", wait and connect again. An older one is an orphan: state "orphan", and next names it exactly (pid, start
// time, whether it holds the lane port) so the person ends it in the Task Manager. SSAM never starts a Service Studio (it
// only attaches to the ones the person opened), so no windowless process is ever SSAM's own to end: SSAM never closes or
// kills a Studio, and no test touches a process.
export const STUDIO_STARTING = 'STUDIO_STARTING';
export const STARTING_MS = 120000;
const clockTime = iso => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 16) + 'Z' : null; };
export function windowlessFacts(p, { now = Date.now(), heldPid = null } = {}) {
  const started = Date.parse(p?.startedAt ?? '');
  const ageSeconds = Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 1000)) : null;
  const starting = ageSeconds != null && ageSeconds * 1000 < STARTING_MS;
  const holds = heldPid != null && heldPid === p.pid;
  const at = clockTime(p?.startedAt);
  return { pid: p.pid, code: starting ? STUDIO_STARTING : STUDIO_WINDOWLESS, state: starting ? 'starting' : 'orphan',
    ...(p?.startedAt ? { startedAt: p.startedAt } : {}), ...(ageSeconds != null ? { ageSeconds } : {}), ...(holds ? { holdsLanePort: true } : {}),
    fix: WINDOWLESS_FIX,
    next: starting
      ? 'O Service Studio ' + p.pid + ' ainda está abrindo (sem janela há ' + ageSeconds + ' s): espere a janela aparecer e conecte de novo (ssam_connect {lane:"o11"}).'
      : 'Encerre o processo ServiceStudio.exe de PID ' + p.pid + (at ? ' (aberto às ' + at + ')' : '') + ' no Gerenciador de Tarefas > Detalhes: ele não tem janela'
        + (holds ? ' e segura a porta da faixa O11' : '') + '. Depois conecte de novo (ssam_connect {lane:"o11"}). O SSAM nunca encerra um Studio.' };
}
export const windowlessOf = (processes, options) => (processes ?? []).filter(isWindowless).map(p => windowlessFacts(p, options));
const windowlessError = (pid, process) => {
  const facts = windowlessFacts(process ?? { pid });
  return Object.assign(new Error('Service Studio ' + pid + ' has no main window (' + facts.code + '): ' + facts.next + ' ' + WINDOWLESS_FIX), { code: facts.code, pid });
};

export function chooseStudio(processes, requestedPid) {
  if (requestedPid !== undefined && (!Number.isSafeInteger(Number(requestedPid)) || Number(requestedPid) < 1))
    throw new Error('pid must be a positive integer.');
  const asked = requestedPid === undefined ? null : processes.find(p => p.pid === Number(requestedPid) && isWindowless(p));
  if (asked) throw windowlessError(Number(requestedPid), asked);
  const windowed = processes.filter(p => !isWindowless(p));
  const candidates = requestedPid === undefined ? windowed : windowed.filter(p => p.pid === Number(requestedPid));
  if (!candidates.length) {
    const ghosts = windowlessOf(processes);
    // Only Studios still opening: say so (wait, then connect), not "open it".
    if (requestedPid === undefined && ghosts.length && ghosts.every(g => g.state === 'starting'))
      throw Object.assign(new Error('No Studio window yet (' + STUDIO_STARTING + ': ' + ghosts.map(g => g.pid).join(', ') + ' still opening). ' + ghosts[0].next), { code: STUDIO_STARTING, pid: ghosts[0].pid });
    throw new Error('No matching Studio is open' + (ghosts.length ? ' with a window (' + STUDIO_WINDOWLESS + ': ' + ghosts.map(g => g.pid).join(', ') + ' ignored)' : '') + '. Open it normally, then connect.'
      + (ghosts.some(g => g.state === 'orphan') ? ' ' + ghosts.find(g => g.state === 'orphan').next : ''));
  }
  if (candidates.length !== 1) throw new Error('Several Studios are open (' + candidates.map(p => p.pid).join(', ') + '); select one with pid.');
  return candidates[0];
}

export function classifyO11(processes, probe) {
  const windowless = windowlessOf(processes, { heldPid: probe?.connected === true ? probe.pid : null });
  const connected = probe.connected === true && processes.some(p => p.pid === probe.pid && !isWindowless(p));
  return { image: 'ServiceStudio.exe', open: processes.length > 0, connected,
    pids: processes.map(p => p.pid), processes,
    ...(windowless.length ? { windowless } : {}),
    ...(probe.connected === true && windowless.some(w => w.pid === probe.pid) ? { laneHeldBy: { pid: probe.pid, code: STUDIO_WINDOWLESS } } : {}),
    ...(connected ? { pid: probe.pid, installation: processes.find(p => p.pid === probe.pid).path ? path.dirname(processes.find(p => p.pid === probe.pid).path) : null, bridge: probe } : { bridge: probe }) };
}

async function build(project, out, extra = []) {
  const log = path.join(path.dirname(out), path.basename(out) + '-build.log');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    const result = await exec('dotnet', ['build', project, '-c', 'Release', '--nologo', '-v', 'minimal',
      '--artifacts-path', out + '-artifacts', '-o', out, ...extra], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
    fs.writeFileSync(log, result.stdout + result.stderr);
  } catch (error) {
    fs.writeFileSync(log, (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message);
    throw new Error('Connector build failed; Studio unchanged. See ' + log);
  }
}

async function connectorTool(root) {
  const project = path.join(root, 'tools', 'Anvil.Connect');
  const hash = createHash('sha256').update(fs.readFileSync(path.join(project, 'Program.cs')))
    .update(fs.readFileSync(path.join(project, 'Anvil.Connect.csproj'))).digest('hex').slice(0, 20);
  const out = path.join(root, '.local', 'runtime-connect', 'client-' + hash);
  const dll = path.join(out, 'Anvil.Connect.dll');
  if (!fs.existsSync(path.join(out, 'ready.json'))) {
    await build(path.join(project, 'Anvil.Connect.csproj'), out);
    fs.writeFileSync(path.join(out, 'ready.json'), JSON.stringify({ hash }));
  }
  return async args => {
    const { stdout } = await exec('dotnet', [dll, ...args.map(String)], { windowsHide: true, timeout: 30000 })
      .catch(error => { throw new Error(error.stdout?.trim() || 'Studio connection failed: ' + error.message); });
    const result = JSON.parse(stdout.trim());
    if (!result.ok) throw new Error(result.error);
    return result;
  };
}

async function authenticate(port, preferred) {
  if (!(currentExecutor() instanceof LocalExecutor)) {
    // The agent puts its own key; no authority folder of this machine is read.
    const response = await handshake(port, 'ui_alive', undefined, { timeout_ms: 1000 });
    if (response?.success) return { authorityDir: workspacePath('state', 'relay-authority'), uiResponsive: response.data?.alive === true };
    throw new Error('Bridge found, but the agent could not authenticate to it. No Studio restart or login is required.');
  }
  const candidates = [...new Set([preferred, process.env.ANVIL_AUTHORITY_DIR,
    path.join(os.homedir(), '.anvil', 'authority'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Anvil', 'authority')].filter(Boolean))];
  for (const directory of candidates) {
    const keyFile = path.join(directory, 'bridge.key');
    if (!fs.existsSync(keyFile)) continue;
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    const response = await bridgeCall(port, 'ui_alive', key, { timeout_ms: 1000 });
    if (response.success) return { authorityDir: directory, uiResponsive: response.data?.alive === true };
  }
  throw new Error('Bridge found, but the local controller authority could not be authenticated. No Studio restart or login is required.');
}

// The bridge's own identity, one cheap local round trip: { connected, pid, version }.
export async function pingO11(port) {
  try {
    const reply = await handshake(port, 'ping', undefined, {}, 1500);
    return reply.success === true && reply.data?.bridge === 'anvil' && Number.isInteger(reply.data.pid)
      ? { connected: true, pid: reply.data.pid, version: reply.data.version ?? null } : { connected: false };
  } catch { return { connected: false }; }
}

// Every O11 call checks that the selected Studio is still the one connected. The full check starts a .NET process
// (`Anvil.Connect.dll describe`, which may even build the connector first): seconds per call. Once a selection
// (pid, startedUtc, port) passed it, this process remembers the bridge that answered (pid, version); the next calls
// only ping the bridge and skip describe while the record and the ping still match. A restarted Studio has another
// pid (or no bridge at all), so the ping differs, the memo is dropped and the full check runs and refuses as before;
// a new connection writes another record (another startedUtc), which is checked in full once.
const verifiedO11 = new Map(); // `${pid}|${startedUtc}|${port}` -> { pid, version }
export function forgetVerifiedO11() { verifiedO11.clear(); }
// Hosted, the check is the agent's (o11.selected against its own record): no record or connected:false is
// O11_NOT_CONNECTED, and nothing of this process (environment, memo, connector build) is touched.
export async function assertSelectedO11(options = {}) {
  const executor = currentExecutor();
  if (executor instanceof LocalExecutor) return assertSelectedO11Local(options);
  if (!executor.hosted) return void await executor.call('o11.selected', {});
  const { entry = LANES.o11, read = readConnection } = options;
  if (!read(entry.root, entry.lane)) throw o11NotConnected();
  const selected = await executor.call('o11.selected', {});
  if (selected?.connected !== true) throw o11NotConnected();
}
// The o11.selected kind of the local executor: the same check, answered as a record.
export async function selectedO11Local(options = {}) {
  const { entry = LANES.o11, read = readConnection } = options;
  const record = read(entry.root, entry.lane);
  if (!record) return { connected: false };
  await assertSelectedO11Local(options);
  return { connected: true, pid: record.pid, startedUtc: record.startedUtc, version: record.studioVersion ?? null };
}
async function assertSelectedO11Local({ entry = LANES.o11, read = readConnection, probe = probeO11, ping = pingO11,
  describe = null, env = process.env } = {}) {
  const record = read(entry.root, entry.lane);
  if (!record) return;
  const selected = { ANVIL_STUDIO_DIR: record.studioDir, ANVIL_AUTHORITY_DIR: record.authorityDir }; // connectionEnvironment
  const key = record.pid + '|' + record.startedUtc + '|' + record.port;
  const known = verifiedO11.get(key);
  if (known) {
    const now = await ping(record.port);
    if (now.connected && now.pid === known.pid && now.version === known.version) { Object.assign(env, selected); return; }
    verifiedO11.delete(key);
  }
  const probed = await probe(record.port);
  if (!probed.connected || probed.pid !== record.pid) throw new Error('The selected Studio session is no longer connected. Call ssam_connect {lane:"o11"} to select the current Studio.');
  const run = describe ?? await connectorTool(entry.root);
  const actual = await run(['describe', record.pid]);
  if (actual.startedUtc !== record.startedUtc) throw new Error('The selected Studio was restarted. Call ssam_connect {lane:"o11"} again before continuing.');
  verifiedO11.set(key, { pid: probed.pid, version: probed.version ?? null });
  Object.assign(env, selected);
}

// A machine-wide lock prevents two checkouts from attaching simultaneously to the same lane.
async function withConnectionLock(port, action) {
  const folder = path.join(os.homedir(), '.anvil', 'runtime-connect');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'port-' + port + '.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch { throw new Error('Another connection attempt holds ' + file + '. Wait for its result; do not restart the Studio.'); }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return await action(folder); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}

// The o11.connect call of the executor seam: locally connectO11Local below; hosted the agent attaches the bridge of its
// own package and keeps the record (no connection file is written and no variable of this process changes).
export async function connectO11({ pid } = {}) {
  return currentExecutor().call('o11.connect', pid === undefined ? {} : { pid });
}

export async function connectO11Local({ pid } = {}) {
  const entry = LANES.o11;
  const facts = await anvilLaneFacts(entry.lane, entry.root);
  return withConnectionLock(facts.bridge, async lockRoot => {
    const selected = chooseStudio(await studioProcesses(entry.studioProcess), pid);
    const invoke = await connectorTool(entry.root);
    const target = await invoke(['describe', selected.pid]);
    const port = facts.bridge;
    let probe = await probeO11(port);
    const reused = probe.connected && probe.pid === target.pid;
    if ((probe.connected && !reused) || (!probe.connected && probe.occupied))
      throw new Error('Bridge port ' + port + ' is already occupied' + (probe.pid ? ' by Studio ' + probe.pid : '') + '. The selected Studio was not changed. Use a free SS4/SS5 lane.');
    let evidence;
    const authorityDir = process.env.ANVIL_AUTHORITY_DIR ?? path.join(os.homedir(), '.anvil', 'authority');
    if (!reused) {
      if (!target.diagnosticsAvailable) throw new Error('The Studio diagnostics endpoint is unavailable. Check process permissions/diagnostics; the Studio remains open.');
      if (target.bridgePath || target.corePath)
        throw new Error('Anvil is already loaded in this Studio but its bridge did not respond on this lane. Reconnecting another DLL is refused; inspect the existing bridge log.');
      const attemptKey = createHash('sha256').update(target.pid + ':' + target.startedUtc + ':' + port).digest('hex');
      const pending = path.join(lockRoot, attemptKey + '.json');
      if (fs.existsSync(pending)) throw new Error('A previous attach may already have executed. Inspect ' + readJson(pending).evidence + '; it will not be repeated.');
      const id = randomUUID().replaceAll('-', '');
      evidence = path.join(entry.root, '.local', 'runtime-connect', id);
      const bridgeOut = path.join(evidence, 'bridge');
      await build(path.join(entry.root, 'src', 'Anvil.Bridge', 'Anvil.Bridge.csproj'), bridgeOut,
        ['-p:SSDir=' + target.studioDir, '-p:CopyLocalLockFileAssemblies=true']);
      const hookName = 'Anvil.RuntimeHook.' + id;
      const hookOut = path.join(evidence, 'hook');
      await build(path.join(entry.root, 'tools', 'Anvil.RuntimeHook', 'Anvil.RuntimeHook.csproj'), hookOut, ['-p:AssemblyName=' + hookName]);
      const hook = path.join(hookOut, hookName + '.dll');
      fs.writeFileSync(hook + '.json', JSON.stringify({ pid: target.pid, startedUtc: target.startedUtc, port,
        bridgePath: path.join(bridgeOut, 'Anvil.Bridge.dll'), authorityDir }));
      // Recheck identity and port after building, before the single attach request.
      const current = await invoke(['describe', target.pid]);
      if (current.startedUtc !== target.startedUtc || current.bridgePath || current.corePath)
        throw new Error('The Studio changed while preparing the connector. No hook was sent.');
      probe = await probeO11(port);
      if (probe.connected || probe.occupied) throw new Error('The bridge port became occupied while preparing the connector. No hook was sent.');
      fs.writeFileSync(pending, JSON.stringify({ evidence, hook, pid: target.pid, startedUtc: target.startedUtc }));
      let attachError;
      try { await invoke(['attach', target.pid, target.startedUtc, hook]); } catch (error) { attachError = error.message; }
      // No event tells when the hook's bridge starts listening: the port is polled with backoff (250 ms -> 2 s, 30 s
      // at most) and the loop ends at once when the bridge answers or the hook's receipt reports a failure.
      await pollWithBackoff(async () => {
        probe = await probeO11(port);
        return probe.connected || (fs.existsSync(hook + '.receipt.json') && !readJson(hook + '.receipt.json').ok);
      }, { deadlineMs: 30000 });
      if (!probe.connected || probe.pid !== target.pid) throw new Error('Attach not confirmed; do not repeat it. ' + (attachError ?? '') + ' Evidence: ' + evidence);
    }
    const authenticated = await authenticate(port, authorityDir);
    const confirmed = await invoke(['describe', target.pid]);
    if (confirmed.startedUtc !== target.startedUtc) throw new Error('Studio changed before connection confirmation.');
    const result = { ok: true, lane: 'o11', anvilLane: entry.lane, connected: true, reused, pid: target.pid,
      startedUtc: target.startedUtc, studioDir: target.studioDir, studioVersion: target.version, port,
      ...authenticated, ...(evidence ? { evidence } : {}), connectedAt: new Date().toISOString() };
    const file = connectionFile(entry.root, entry.lane);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2));
    fs.renameSync(temporary, file);
    // Just proven (describe + bridge): the first O11 call after connecting needs only the ping.
    if (probe.connected && probe.pid === target.pid) verifiedO11.set(target.pid + '|' + target.startedUtc + '|' + port, { pid: probe.pid, version: probe.version ?? null });
    process.env.ANVIL_AUTHORITY_DIR = result.authorityDir;
    process.env.ANVIL_STUDIO_DIR = result.studioDir;
    return result;
  });
}

// ---- ssam_connect: every open Studio in one call (C22). Each served lane lists its Studios and asks each bridge at once
// (O11: the lane port's ping; ODC: pipeProbe, a short connect instead of the 10 s retry). A Studio whose bridge already
// answers is reused as it is (alreadyAttached); one without a bridge is attached: O11 by connectO11 (one Studio per lane
// port, so only the target), ODC by lib.mjs attach (every ODC Studio has its own pipe). `ok` speaks only for the target:
// the pid asked for, else the only Studio of each lane asked for (or the one the O11 lane port already serves); another
// Studio that fails is reported in its own entry and never fails the call (without any target, ok means at least one
// Studio is attached). reconnectNeeded is true only when this call
// had to attach a bridge. Each entry: {lane, pid, target, attached, alreadyAttached, tenant, account}, plus error/note.
// deps.o11/deps.odc replace the Studio side (tests: fake Studios, no process, no pipe, no bridge).
export const servedLanes = (env = process.env) => {
  const only = String(env.SSAM_MCP_LANES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return only.length ? ['o11', 'odc'].filter(l => only.includes(l)) : ['o11', 'odc'];
};
const message = error => String(error?.message ?? error);

// Every machine round trip of both sides goes through the executor seam (FASE2-AGENTE.md 4.1), as the other connection
// helpers here: locally the same calls as before (the lane port, the controller key, the pipe of this process); hosted the
// customer's agent (no port, key or lane facts of this machine); a served process without a hosted context fails closed.
const localSeam = () => currentExecutor() instanceof LocalExecutor;
function defaultO11Side() {
  const entry = LANES.o11;
  let facts = null;
  const port = async () => (localSeam() ? (facts ??= await anvilLaneFacts(entry.lane, entry.root)).bridge : null);
  return {
    processes: () => studioProcesses(entry.studioProcess),
    probe: async () => probeO11(await port()),
    record: () => { try { return readConnection(entry.root, entry.lane); } catch { return null; } },
    connect: pid => connectO11({ pid }),
    // The environment the Studio is signed into (list_open_modules.environments) and its user (sc_session), with the
    // controller key of the connection; a read the bridge answers at once. Unknown stays null.
    // Hosted: the agent puts its own key, so no key file of this machine is read.
    session: async record => {
      let key;
      if (localSeam()) {
        const keyFile = record?.authorityDir ? path.join(record.authorityDir, 'bridge.key') : null;
        if (!keyFile || !fs.existsSync(keyFile)) return { tenant: null, account: null };
        key = fs.readFileSync(keyFile, 'utf8').trim();
      } else if (!record) return { tenant: null, account: null };
      const at = await port();
      const listed = await handshake(at, 'list_open_modules', key, {}, 3000).catch(() => null);
      const hosts = Array.isArray(listed?.data?.environments) ? listed.data.environments.filter(h => typeof h === 'string') : [];
      if (hosts.length !== 1) return { tenant: hosts.length ? hosts.join(', ') : null, account: null };
      const session = await handshake(at, 'sc_session', key, { host: hosts[0] }, 3000).catch(() => null);
      return { tenant: hosts[0], account: session?.data?.studio?.user ?? null };
    },
  };
}
async function defaultOdcSide() {
  const lib = await import('./lib.mjs');
  const { pipeProbe } = await import('./odc-pipe.mjs');
  // Hosted, the bridge version the agent's package carries (the same one lib.mjs client sends).
  const version = () => (localSeam() ? lib.newestBridgeDll()?.version : lib.bridgeVersion()) ?? null;
  // The probe's command through the executor (odc.pipe with the short connect window) when not local.
  const viaExecutor = async (pid, v, args, { connectMs } = {}) =>
    (await currentExecutor().call('odc.pipe', { pid, version: v, args, ...(connectMs ? { connectMs } : {}) })).line;
  return {
    processes: async () => (await lib.studioPids()).map(pid => ({ pid })),
    // servidor/fase4-24: a server without a built ODC bridge (the Linux image) still probes the customer's pipe: the
    // AgentExecutor asks for the kernel's odcBridge when the version is null (hosted/agent-executor.mjs bridgeVersionFor).
    probe: async pid => { const v = version(); return v || !localSeam() ? pipeProbe(pid, v, localSeam() ? {} : { call: viaExecutor }) : { attached: false, error: 'the ODC bridge is not built' }; },
    attach: pid => lib.attach(pid),
  };
}
// The signed-in session an ODC bridge reports (auth-status): the first logged-in tenant and its user.
function odcSession(reply) {
  const sessions = Array.isArray(reply?.sessions) ? reply.sessions.filter(s => s && s.loggedIn !== false) : [];
  return { tenant: sessions[0]?.host ?? null, account: sessions[0]?.user ?? null, ...(sessions.length > 1 ? { tenants: sessions.map(s => s.host) } : {}) };
}

async function connectO11Studios(o11, { pid, onlyLane }) {
  const all = await o11.processes();
  if (!all.length) return [];
  // D5: a windowless Studio is listed as such and never selected; the record that names it is stale.
  const processes = all.filter(p => !isWindowless(p));
  const probe = await o11.probe().catch(error => ({ connected: false, error: message(error) }));
  const heldByWindowless = probe.connected === true && all.some(p => p.pid === probe.pid && isWindowless(p)) ? probe.pid : null;
  const served = probe.connected === true && processes.some(p => p.pid === probe.pid) ? probe.pid : null;
  // The target of the lane: the pid asked for, else the only Studio, else the one the lane port already serves.
  const target = pid !== undefined ? (processes.some(p => p.pid === pid) ? pid : null)
    : processes.length === 1 ? processes[0].pid : served;
  const entries = all.filter(isWindowless).map(p => {
    const facts = windowlessFacts(p, { heldPid: heldByWindowless });
    return { lane: 'o11', pid: p.pid, target: pid === p.pid, attached: false, alreadyAttached: false,
      tenant: null, account: null, windowless: true, code: facts.code, state: facts.state, ...(facts.startedAt ? { startedAt: facts.startedAt } : {}),
      ...(facts.holdsLanePort ? { holdsLanePort: true } : {}), note: WINDOWLESS_FIX, next: facts.next,
      ...(pid === p.pid ? { error: 'Service Studio ' + p.pid + ' has no main window (' + facts.code + ').' } : {}) };
  });
  for (const p of processes) {
    const entry = { lane: 'o11', pid: p.pid, target: p.pid === target, attached: false, alreadyAttached: false, tenant: null, account: null };
    entries.push(entry);
    if (heldByWindowless != null && entry.target) {
      entry.code = STUDIO_WINDOWLESS;
      entry.error = 'The O11 lane port is held by the bridge of Service Studio ' + heldByWindowless + ', which has no main window; nothing was attached. '
        + windowlessFacts(all.find(x => x.pid === heldByWindowless) ?? { pid: heldByWindowless }, { heldPid: heldByWindowless }).next + ' ' + WINDOWLESS_FIX;
      continue;
    }
    if (served === p.pid) {
      entry.alreadyAttached = true; entry.attached = true;
      // The bridge is there but the selection record names another Studio (or none): connectO11 reuses the bridge
      // (no hook) and writes the record, so the O11 tools reach this Studio.
      if (o11.record()?.pid !== p.pid && entry.target) {
        try { await o11.connect(p.pid); entry.recordWritten = true; }
        catch (error) { entry.attached = false; entry.error = message(error); }
      }
    } else if (served != null) entry.note = 'the O11 lane bridge port already serves Studio ' + served + '; one Studio per lane';
    else if (!entry.target) entry.note = pid === undefined && processes.length > 1
      ? 'several Service Studios are open (' + processes.map(x => x.pid).join(', ') + '); select one with pid' : 'not the Studio asked for';
    else {
      try { await o11.connect(p.pid); entry.attached = true; }
      catch (error) { entry.error = message(error); }
    }
    if (entry.attached) Object.assign(entry, await o11.session(o11.record()).catch(() => ({ tenant: null, account: null })));
  }
  if (onlyLane && pid !== undefined && target == null && !all.some(p => p.pid === pid)) entries.unshift({ lane: 'o11', pid, target: true, attached: false, alreadyAttached: false, tenant: null, account: null, error: 'No Service Studio with pid ' + pid + ' is open.' });
  return entries;
}

async function connectOdcStudios(odc, { pid, onlyLane }) {
  const processes = await odc.processes();
  const target = pid !== undefined ? (processes.some(p => p.pid === pid) ? pid : null) : processes.length === 1 ? processes[0].pid : null;
  const entries = await Promise.all(processes.map(async p => {
    const entry = { lane: 'odc', pid: p.pid, target: p.pid === target, attached: false, alreadyAttached: false, tenant: null, account: null };
    let probe = await odc.probe(p.pid).catch(error => ({ attached: false, error: message(error) }));
    if (probe.attached) { entry.alreadyAttached = true; entry.attached = true; if (probe.busy) entry.busy = true; }
    else {
      // Every ODC Studio has its own pipe: each one not attached yet is attached, the target or not.
      try {
        const result = await odc.attach(p.pid);
        entry.attached = result?.ok === true && result?.status?.ok !== false;
        if (!entry.attached) entry.error = String(result?.error ?? result?.status?.error ?? 'attach not confirmed').slice(0, 400);
        if (result?.version) entry.bridge = result.version;
      } catch (error) { entry.error = message(error); }
      if (entry.attached) probe = await odc.probe(p.pid).catch(() => ({ attached: true, reply: null }));
    }
    if (!entry.target && pid === undefined && processes.length > 1) entry.note = 'several ODC Studios are open; pass pid to make one the target';
    return Object.assign(entry, entry.attached ? odcSession(probe.reply) : {});
  }));
  if (onlyLane && pid !== undefined && target == null) entries.unshift({ lane: 'odc', pid, target: true, attached: false, alreadyAttached: false, tenant: null, account: null, error: 'No ODC Studio with pid ' + pid + ' is open.' });
  return entries;
}

export async function connectAll({ lane, pid } = {}, deps = {}) {
  if (pid !== undefined && (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1)) throw new Error('pid must be a positive integer.');
  const requestedPid = pid === undefined ? undefined : Number(pid);
  const served = deps.served ?? servedLanes();
  if (lane != null && !['o11', 'odc'].includes(lane)) throw new Error('lane is o11 or odc (or none: every open Studio).');
  if (lane != null && !served.includes(lane)) {
    return { ok: false, code: 'LANE_NOT_SERVED', lane, error: lane === 'odc'
      ? 'This checkout does not serve the ODC lane ("mcpLanes" in .ssam-workspace.json). For the open ODC Studio, use studio_attach from a checkout that serves ODC.'
      : 'This checkout does not serve the O11 lane ("mcpLanes" in .ssam-workspace.json).', studios: [], reconnectNeeded: false };
  }
  const lanes = lane != null ? [lane] : served;
  const o11 = lanes.includes('o11') ? { ...defaultO11Side(), ...(deps.o11 ?? {}) } : null;
  const odc = lanes.includes('odc') ? { ...(deps.odc && deps.odc.processes && deps.odc.probe && deps.odc.attach ? {} : await defaultOdcSide()), ...(deps.odc ?? {}) } : null;
  const [o11Entries, odcEntries] = await Promise.all([
    o11 ? connectO11Studios(o11, { pid: requestedPid, onlyLane: lane === 'o11' }).catch(error => [{ lane: 'o11', error: message(error), target: lane === 'o11', attached: false, alreadyAttached: false }]) : [],
    odc ? connectOdcStudios(odc, { pid: requestedPid, onlyLane: lane === 'odc' }).catch(error => [{ lane: 'odc', error: message(error), target: lane === 'odc', attached: false, alreadyAttached: false }]) : [],
  ]);
  const studios = [...o11Entries, ...odcEntries];
  // C04: the tenants the attached ODC Studios are signed in to get their Development stage in the customer's tenants.json
  // (hosted only; lib.mjs recordConnectedTenants), so the links of the next answers exist.
  const signedIn = odcEntries.filter(s => s.attached).flatMap(s => s.tenants ?? (s.tenant ? [s.tenant] : []));
  if (signedIn.length) {
    try {
      const record = deps.recordTenants ?? (await import('./lib.mjs')).recordConnectedTenants;
      const recorded = await record(signedIn);
      if (recorded?.written?.length) for (const s of odcEntries) if ((s.tenants ?? [s.tenant]).some(h => recorded.written.includes(String(h).toLowerCase()))) s.stages = 'derived';
    } catch { /* the links only; the connection stands */ }
  }
  const targets = studios.filter(s => s.target);
  const reconnectNeeded = studios.some(s => s.attached && !s.alreadyAttached);
  // No single target (several Studios of a lane, no pid): every one that could be attached was; the call is ok when at
  // least one Studio is attached, and the entries say which needs a pid (O11: one Studio per lane port).
  const ok = targets.length ? targets.every(s => s.attached) : requestedPid === undefined && studios.some(s => s.attached);
  const value = { ok, studios, reconnectNeeded };
  if (!studios.length) value.error = 'No Studio is open' + (lane ? ' on the ' + lane + ' lane' : '') + '. Open it normally (and sign in), then call ssam_connect again.';
  else if (!targets.length && !ok) value.error = requestedPid !== undefined ? 'No open Studio has pid ' + requestedPid + '.' : 'Several Studios of one lane are open: select one with pid.';
  else if (!ok) value.error = targets.filter(s => !s.attached).map(s => s.lane + ' ' + (s.pid ?? '') + ': ' + (s.error ?? 'not attached')).join('; ');
  return value;
}

export async function connectStudio({ lane, pid } = {}) {
  if (lane === 'o11') return connectO11({ pid });
  if (lane === 'odc') {
    const served = (process.env.SSAM_MCP_LANES ?? '').split(',').filter(Boolean);
    if (served.length && !served.includes('odc')) throw new Error('This checkout does not serve the ODC lane ("mcpLanes" in .ssam-workspace.json). For the open ODC Studio, use studio_attach from a checkout that serves ODC.');
    const { attach } = await import('./lib.mjs');
    const result = await attach(pid);
    return { ...result, ok: result.ok === true && result.status?.ok === true };
  }
  throw new Error('Select lane o11 or odc explicitly.');
}

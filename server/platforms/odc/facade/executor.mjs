// The executor seam of the facade (docs/FASE2-AGENTE.md 4.1): every call that touches a machine (Studio processes, the
// ODC bridge pipe, attaching the ODC bridge, the O11 bridge, connecting or checking the selected Service Studio) goes
// through currentExecutor().call(kind, params). LocalExecutor is today's code and the default in stdio, the CLI and the
// tests. A served process without --local-studios makes DenyExecutor its default, so code that lost its hosted context
// fails closed (HOSTED_CONTEXT_LOST) and never reaches the owner's Studio. Inside a hosted call the context's
// AgentExecutor (hosted/agent-executor.mjs) forwards each call to the customer's agent.
//
// The same context decides where data goes (the root rule of 4.1 and the table of 6.1): a data root that is missing or
// the default one becomes the customer's workspace (.local/server/customers/<tokenId>/...), a root passed on purpose
// (tests, the bench) stays, and code locations (CLI, builder, bridge client, studio/, kernel catalogs) never move.
// Hosted child processes get a closed environment (hostedSpawnEnv, 4.7), never this process's own.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pipeCall } from './odc-pipe.mjs';
import { signedRuntime, bridgeClientError } from './signed-runtime.mjs';

// The closed list of 4.4: the six kinds that touch a machine, and the file kinds that exist only between the server and
// the agent (the local executor refuses them).
export const CALL_KINDS = Object.freeze(['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected',
  'file.put', 'file.get', 'file.list', 'file.sync']);
export const MACHINE_KINDS = Object.freeze(CALL_KINDS.slice(0, 6));

// Codes that only the seam, the hub, the AgentExecutor or the agent produce. Tool answers that flatten an error to its
// message keep these codes (seamFields), so a refusal stays recognizable; local errors never carry them.
export const SEAM_CODES = new Set(['HOSTED_CONTEXT_LOST', 'SEAM_LOCAL_IN_HOSTED', 'KIND_NOT_ALLOWED', 'O11_NOT_CONNECTED',
  'HOSTED_STUDIO_SESSION_ONLY', 'HOSTED_PROMPT_UNAVAILABLE', 'HOSTED_UNAVAILABLE', 'COMPONENT_STALE',
  'AGENT_NOT_CONNECTED', 'AGENT_RECONNECTING', 'AGENT_BUSY', 'AGENT_DISCONNECTED', 'AGENT_TIMEOUT', 'AGENT_REVOKED', 'AGENT_PROTOCOL_VIOLATION',
  'COMMAND_NOT_ALLOWED', 'METHOD_NOT_ALLOWED', 'PATH_FORBIDDEN', 'PATH_NOT_AGENT', 'PATH_OUTSIDE_WORKSPACE', 'PATH_NOT_STAGEABLE',
  'HOSTED_PATH_PARAM_REFUSED', 'WORKSPACE_FULL', 'BRIDGE_VERSION_MISMATCH', 'STUDIO_VERSION_MISMATCH', 'LANE_DISABLED', 'ATTACH_FAILED']);

const odcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = (file, args, options) => promisify(execFile)(file, args, options);

export function seamError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, executed: false, ...extra });
}
// The fields a tool answer keeps from a seam error: its code and continuation. Nothing for any other error.
export const seamFields = error => (SEAM_CODES.has(error?.code)
  ? { code: error.code, ...(Number.isFinite(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.continuation ? { continuation: error.continuation } : {}) } : {});

export function contextLost(what = 'a machine call') {
  return seamError('HOSTED_CONTEXT_LOST', 'Internal error of the SSAM server: ' + what + ' ran without its hosted context, so nothing ran on any machine.',
    { continuation: { tool: 'ssam_doctor', arguments: {}, why: 'report this to the server owner; do not retry in a loop' } });
}
export function o11NotConnected() {
  return seamError('O11_NOT_CONNECTED', 'No Service Studio of this account is connected to SSAM, so nothing ran on the O11 lane. The server never falls back to another Studio.',
    { continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' },
      why: 'Ask the user to open Service Studio (the version ssam_doctor shows), then connect it and call this tool again.' } });
}

// ---- the local executor: today's code, moved behind the seam ------------------------------------------------------
const notBuilt = (what, file) => what + ' is not built (' + file + '): the integrator or the user builds it; ssam_doctor {lane:"odc"} reports the state.';
// The .NET client of the ODC bridge (attach, and every command when SSAM_ODC_PIPE=0 or no bridge is built).
export const bridgeClientPath = () => path.join(odcRoot, 'studio', 'bridge', 'client', 'bin', 'Release', 'net10.0', 'ODC3.Bridge.Client.dll');
async function dotnetClient(pid, args) {
  const file = signedRuntime(odcRoot)?.client ?? bridgeClientPath();
  if (!fs.existsSync(file)) throw new Error(notBuilt('The bridge client', file));
  const { stdout } = await exec('dotnet', [file, String(pid), ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    .catch(error => { throw bridgeClientError(error); });
  return stdout;
}
const parsed = text => { const trimmed = String(text ?? '').trim(); try { return JSON.parse(trimmed); } catch { return { raw: trimmed }; } };

// The processes of one Studio image. paths:false (lib.mjs studioPids, service-center studioRunning: only the pids) is
// tasklist, as those callers ran it before the seam: faster than CIM, 15 s timeout, an error is thrown. Otherwise the
// CIM query of lanes.mjs (pid and executable path; a failed listing lists nothing). Nothing else is inspected.
async function localProcesses({ image, paths = true }) {
  if (paths === false) {
    const name = String(image).replace(/["']/g, '');
    const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 });
    const pids = String(stdout ?? '').split(/\r?\n/).map(line => /^"([^"]*)","(\d+)"/.exec(line)).filter(m => m && m[1].toLowerCase() === name.toLowerCase());
    return { processes: pids.map(m => ({ pid: Number(m[2]), path: null, version: null })) };
  }
  // D5 (atritos 3): the listing also says whether each process still has a main window (read from the system only; the
  // process is never touched).
  const encoded = Buffer.from(studioProcessScript(String(image)), 'utf16le').toString('base64');
  const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 60000 })
    .catch(() => ({ stdout: '' }));
  return { processes: parseStudioProcesses(stdout).map(p => ({ ...p, version: null })) };
}

// D5 of the atritos 3 package: each process says whether it still has a main window: window true | false | null
// (unknown). Read from the system only (Get-Process MainWindowHandle/MainWindowTitle; the process is never touched). A process
// whose only window is an SSAM window (title "... (SSAM)": the hidden Service Center window of an older bridge, which kept a
// Studio running after its main window was closed) has its visible top-level windows listed (EnumWindows) to decide: SSAM
// windows only is windowless.
export const SSAM_WINDOW_TITLE = /\(SSAM\)\s*$/;
export function windowState({ MainWindowHandle, MainWindowTitle, Titles } = {}) {
  if (Array.isArray(Titles)) return Titles.some(t => typeof t === 'string' && !SSAM_WINDOW_TITLE.test(t));
  const handle = Number(MainWindowHandle);
  if (!Number.isFinite(handle)) return null;
  if (handle === 0) return false;
  return SSAM_WINDOW_TITLE.test(String(MainWindowTitle ?? '')) ? null : true;
}
const WINDOWS_TYPE = `using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class SsamStudioWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] Titles(uint pid) {
    var list = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) { var s = new StringBuilder(512); GetWindowText(h, s, 512); list.Add(s.ToString()); }
      return true; }, IntPtr.Zero);
    return list.ToArray();
  }
}`;
export function studioProcessScript(imageName) {
  return "$ErrorActionPreference='SilentlyContinue'\n"
    + "$list = @(Get-CimInstance Win32_Process -Filter \"Name='" + imageName.replace(/'/g, '') + "'\" | Select-Object ProcessId,ExecutablePath,CreationDate)\n"
    + "$out = @(foreach ($p in $list) { $g = Get-Process -Id $p.ProcessId; $h = [int64]0; $t = ''; if ($g) { $h = [int64]$g.MainWindowHandle; $t = [string]$g.MainWindowTitle }\n"
    + "  $s = $null; if ($p.CreationDate) { $s = ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }\n"
    + "  [pscustomobject]@{ ProcessId = $p.ProcessId; ExecutablePath = $p.ExecutablePath; MainWindowHandle = $h; MainWindowTitle = $t; Titles = $null; StartedAt = $s } })\n"
    + "$ambiguous = @($out | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match '\\(SSAM\\)\\s*$' })\n"
    + "if ($ambiguous.Count) { Add-Type -TypeDefinition @'\n" + WINDOWS_TYPE + "\n'@\n"
    + "  foreach ($o in $ambiguous) { $o.Titles = @([SsamStudioWindows]::Titles([uint32]$o.ProcessId)) } }\n"
    + "ConvertTo-Json -InputObject $out -Compress -Depth 3\n";
}
export function parseStudioProcesses(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(p => p && Number.isSafeInteger(p.ProcessId))
      // startedAt (pattern 5, 2026-10-08): the process creation time, so a windowless Studio still opening is told apart
      // from an orphan left by a restart (studio-connect.mjs windowlessFacts).
      .map(p => ({ pid: p.ProcessId, path: p.ExecutablePath ?? null, window: windowState(p),
        ...(typeof p.StartedAt === 'string' && Number.isFinite(Date.parse(p.StartedAt)) ? { startedAt: p.StartedAt } : {}) }));
  } catch { return []; }
}
export const LOCAL_CALLS = Object.freeze({
  'studio.processes': localProcesses,
  // version null: the .NET client instead of the pipe (SSAM_ODC_PIPE=0, or no bridge built), as lib.mjs client() did.
  'odc.pipe': async ({ pid, version, args, connectMs }) => ({ line: version ? await pipeCall(pid, version, args, connectMs ? { connectMs } : {}) : await dotnetClient(pid, args) }),
  // dll: the newest built bridge of this checkout (lib.mjs attach); the client loads it through the startup hook.
  'odc.attach': async ({ pid, dll }) => parsed(await dotnetClient(pid, ['attach', dll])),
  'o11.bridge': async ({ method, params, timeoutMs, signal, port, host, authorization, maxBytes, flight }) => {
    const { bridgeRequest } = await import('./o11-bridge.mjs');
    return { reply: await bridgeRequest({ port, host, authorization, maxBytes, flight }, method, params, { ...(timeoutMs ? { timeoutMs } : {}), ...(signal ? { signal } : {}) }) };
  },
  'o11.connect': async ({ pid } = {}) => (await import('./studio-connect.mjs')).connectO11Local(pid === undefined ? {} : { pid }),
  'o11.selected': async () => (await import('./studio-connect.mjs')).selectedO11Local(),
});

export class LocalExecutor {
  // calls: low-level functions by kind (tests inject fakes); the rest are today's.
  constructor(calls = {}) { this.calls = { ...LOCAL_CALLS, ...calls }; }
  get id() { return 'local'; }
  get hosted() { return false; }
  async call(kind, params = {}, options = {}) {
    // A direct import of the local executor inside a hosted call would reach the owner's machine.
    if (hostedContext()) throw seamError('SEAM_LOCAL_IN_HOSTED', 'The local executor was called inside a hosted call (' + kind + '); nothing ran.');
    if (!MACHINE_KINDS.includes(kind)) throw seamError('KIND_NOT_ALLOWED', 'The local executor runs only ' + MACHINE_KINDS.join(', ') + '; not ' + kind + '.');
    return this.calls[kind](params ?? {}, options ?? {});
  }
  o11Connection() { return undefined; } // undefined: callers read the connection file as before
  async close() {}
}

// The default of a served process: every machine call fails closed.
export class DenyExecutor {
  get id() { return 'deny'; }
  get hosted() { return false; }
  async call(kind) { throw contextLost(String(kind)); }
  o11Connection() { return null; }
  async close() {}
}

// ---- the context ---------------------------------------------------------------------------------------------------
const storage = new AsyncLocalStorage();
let processExecutor = null;
const processDefault = () => (processExecutor ??= new LocalExecutor());

// Process-wide; returns the previous one (tests restore it).
export function setDefaultExecutor(executor) {
  if (!executor || typeof executor.call !== 'function') throw new TypeError('An executor with call(kind, params) is required.');
  const previous = processDefault();
  processExecutor = executor;
  return previous;
}
// context: a HostedContext, or {executor} for a non-hosted one; fn and everything it awaits or schedules see it.
export function runWithExecutor(context, fn) {
  if (!context || typeof context.executor?.call !== 'function') throw new TypeError('runWithExecutor needs a context with an executor.');
  return storage.run(context, fn);
}
export const currentExecutor = () => storage.getStore()?.executor ?? processDefault();
// studio-session.mjs is also loaded by the root launcher (facade/launch.mjs), which must stay on node:fs/node:path: it
// reads the executor through this registry key instead of importing this module. Without this module loaded no hosted
// context or DenyExecutor can exist, so the launcher keeps reading the connection files as before.
globalThis[Symbol.for('ssam.facade.currentExecutor')] = currentExecutor;
export function hostedContext() { const store = storage.getStore(); return store?.hosted === true ? store : null; }
export const servedWithoutContext = () => !hostedContext() && currentExecutor() instanceof DenyExecutor;
export function workspacePath(...segments) {
  const context = hostedContext();
  if (!context) throw servedWithoutContext() ? contextLost('a workspace path') : new Error('workspacePath is only valid inside a hosted call.');
  return path.join(context.workspace, ...segments);
}

// The root rule: true when this call is hosted and `root` is missing or one of the default data roots, so the caller uses
// the workspace instead; false for a root passed on purpose, or outside a hosted call. A served process without a
// context fails closed instead of answering with the owner's folders.
const samePath = (a, b) => { const n = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)); return n(a) === n(b); };
export function usesWorkspace(root, ...defaults) {
  if (root != null && !defaults.some(d => d != null && samePath(root, d))) return false;
  if (hostedContext()) return true;
  if (servedWithoutContext()) throw contextLost('a data folder');
  return false;
}

// ---- hosted child processes (4.7) ----------------------------------------------------------------------------------
// From this process only the runtime and the server's code locations; everything else is set here.
export const SPAWN_ALLOWED = Object.freeze(['SystemRoot', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'DOTNET_ROOT', 'ANVIL_ODC_STUDIO_DIR', 'ANVIL_ODC_FEATURES_DIR']);
// O11: the bridge port is the relay of the customer's record. Without a record it is still this customer's relay, so a
// run that never calls the bridge (apply without captures, reference, access plan, environment references) works, and
// a bridge call there ends at this customer's relay and agent, which refuse it (O11_NOT_CONNECTED, AGENT_NOT_CONNECTED):
// never another Studio. The verbs that need the Studio refuse before the spawn (assertSelectedO11, the lane's bridge
// getter, the gate). Only an executor without a relay (none in a real hosted context) is refused here.
export function hostedSpawnEnv(lane) {
  const context = hostedContext();
  if (!context) throw contextLost('a hosted child process');
  if (!['o11', 'odc'].includes(lane)) throw new Error('hostedSpawnEnv takes lane o11 or odc, not ' + lane);
  const record = lane === 'o11' ? context.executor.o11Connection() : null;
  const bridgePort = lane !== 'o11' ? null : Number.isInteger(record?.port) ? record.port : context.executor.relayPort?.() ?? null;
  if (lane === 'o11' && !Number.isInteger(bridgePort)) throw o11NotConnected();
  const env = {};
  for (const name of SPAWN_ALLOWED) if (process.env[name] !== undefined) env[name] = process.env[name];
  const cwd = path.join(context.workspace, lane);
  const tmp = path.join(cwd, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  // TMPDIR is the temp folder of .NET on Linux (Path.GetTempPath; TEMP/TMP only on Windows). Without it the kernel of the
  // Linux image (server/Dockerfile) wrote to /tmp, shared by every customer and outside the workspace: the thin O11
  // bridge's snapshot_module path (ThinBridge.cs, <temp>/thin-bridge/<guid>.oml) was refused PATH_OUTSIDE_WORKSPACE.
  env.TEMP = tmp; env.TMP = tmp; env.TMPDIR = tmp;
  // Also for ODC: without the variable the kernel's BridgeAccess would read the owner's HKCU value.
  env.ANVIL_AUTHORITY_DIR = path.join(context.workspace, 'state', 'relay-authority');
  if (lane === 'o11') {
    env.ANVIL_BRIDGE_PORT = String(bridgePort);
    const studioDir = context.o11?.studioDir ?? record?.studioDir, anvilLane = context.o11?.lane ?? record?.anvilLane;
    if (studioDir) env.ANVIL_STUDIO_DIR = studioDir;
    if (anvilLane) env.ANVIL_LANE = anvilLane;
    // The customer's Studio runs the thin bridge (docs/O11-BRIDGE-FINA.md 4): the kernel's BridgeClient computes the
    // producer signature plan and find_element here, and waits at least 600 s because the relay's file mirror counts
    // inside its timeout.
    env.ANVIL_BRIDGE_FLAVOR = 'thin';
    env.ANVIL_BRIDGE_TIMEOUT_SECONDS = '600';
  } else env.SSAM_HYBRID_ODC_ROOT = path.join(context.workspace, 'odc');
  return { env, cwd };
}

// ProductVersion of a Windows executable (the Studio of a kernel), or null.
export async function fileVersion(exePath) {
  if (typeof exePath !== 'string' || !exePath || !fs.existsSync(exePath)) return null;
  const script = "(Get-Item -LiteralPath '" + exePath.replace(/'/g, "''") + "').VersionInfo.ProductVersion";
  try {
    const { stdout } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 });
    return String(stdout ?? '').trim() || null;
  } catch { return null; }
}

// ---- the hosted context of one customer (6.1) ----------------------------------------------------------------------
export const WORKSPACE_FOLDERS = Object.freeze([
  'odc/snapshots', 'odc/journal/staging', 'odc/journal/data', 'odc/journal/portal', 'odc/journal/inspect', 'odc/lab', 'odc/.local/jobs/inline', 'odc/tmp',
  'o11/snapshots', 'o11/jobs', 'o11/work', 'o11/journal/staging', 'o11/environment', 'o11/data', 'o11/access', 'o11/tasks', 'o11/downloads',
  'o11/service-center/receipts', 'o11/tmp',
  'inbox', 'state/relay-authority', 'state/transfers', 'state/locks', 'state/service-center', '.local/friction']);

// The workspace layout, <ws>/odc/tenants.json when missing (no default tenant: every tenant write is confirmed) and a NEW
// relay key; returns the relay authority folder. The server's controller key never enters it.
export function prepareWorkspace(workspace) {
  for (const folder of WORKSPACE_FOLDERS) fs.mkdirSync(path.join(workspace, ...folder.split('/')), { recursive: true });
  const tenants = path.join(workspace, 'odc', 'tenants.json');
  if (!fs.existsSync(tenants)) fs.writeFileSync(tenants, JSON.stringify({ default: null, tenants: {} }, null, 2));
  const relayAuthorityDir = path.join(workspace, 'state', 'relay-authority');
  fs.writeFileSync(path.join(relayAuthorityDir, 'bridge.key'), randomBytes(32).toString('base64url'), { mode: 0o600 });
  return relayAuthorityDir;
}

// deps.loadExecutor (tests): resolves to {AgentExecutor}; by default hosted/agent-executor.mjs, imported only here.
export async function createHostedContext({ tokenId, customer, lanes = [], agent, workspace }, { loadExecutor } = {}) {
  if (typeof tokenId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tokenId)) throw new Error('createHostedContext needs the tokenId of the session.');
  if (typeof workspace !== 'string' || !workspace) throw new Error('createHostedContext needs the workspace folder.');
  const root = path.resolve(workspace);
  const relayAuthorityDir = prepareWorkspace(root);
  // The Studio of the server's O11 kernel, computed outside any context (it is a code location of this machine).
  const [{ kernelStudioDir }, { o11Lane }] = await Promise.all([import('./o11-lane.mjs'), import('./workspace.mjs')]);
  const o11 = { studioDir: kernelStudioDir(o11Lane.lane), lane: o11Lane.lane };
  const { AgentExecutor } = loadExecutor ? await loadExecutor() : await import('./hosted/agent-executor.mjs');
  const executor = new AgentExecutor({ link: agent, workspace: root, relayAuthorityDir, o11 });
  await executor.start();
  let closed = null;
  return Object.freeze({ id: randomUUID(), hosted: true, tokenId, customer, lanes: Object.freeze([...lanes]), workspace: root, agent, executor, o11,
    close: () => (closed ??= Promise.resolve().then(() => executor.close())) });
}

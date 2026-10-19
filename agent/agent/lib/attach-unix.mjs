// The attach on macOS without any .NET on the machine (docs/AGENTE-MAC.md): the agent speaks the .NET diagnostic IPC
// itself (dotnet-ipc.mjs) in place of the pack's ODC3.Bridge.Client.dll attach and Anvil.Connect describe/attach, which
// stay the Windows path. The checks are the same ones, made with the facts of macOS:
//   - the process is the Studio of an installed bundle: its executable is <bundle>/Contents/MacOS/<CFBundleExecutable> of a
//     bundle in /Applications or ~/Applications whose managed folder is the lane's (macos.mjs), never any path;
//   - the DLL is the pack's own (ODC3.Bridge.<version>, the O11 runtime hook copied by o11-connect.mjs);
//   - the process start did not change between describe and attach (the key of its diagnostic socket, the kernel's
//     seconds, and the ps start);
//   - the runtime is .NET 8 or later (ProcessInfo2) and the endpoint answers for that very pid;
//   - O11 only: no Anvil bridge or core assembly mapped in the process yet (lsof), and startedUtc is the exact text
//     the runtime hook compares (macos.mjs dotnetStartTimeText).
// Every refusal comes before the startup hook is sent (executed:false); a failure after it was sent is unknown (null).
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.mjs';
import { applyStartupHook, processInfo2, unixEndpoints, runtimeMajor } from './dotnet-ipc.mjs';
import { studioProcesses, tempFolders, startTime, dotnetStartTimeText, openFiles, MAC_STUDIOS, runTool } from './macos.mjs';

const fail = (message, executed = false) => new AgentError('ATTACH_FAILED', message, { executed });
const ODC_NOTE = 'Run status before any other command; a bridge stays loaded until the Studio closes.';

// deps: {run, fs, env, home, ps, readers, ipc: {processInfo2, applyStartupHook}, now}
export function createMacAttach(deps = {}) {
  const f = deps.fs ?? fs;
  const run = deps.run ?? runTool;
  const ipc = { processInfo2, applyStartupHook, ...(deps.ipc ?? {}) };
  const startCache = new Map(); // `${pid}:${seconds}` -> {sec, usec, readers}

  async function processOf(lane, pid) {
    const number = Number(pid);
    const list = await studioProcesses(lane, { ...deps, run, fs: f });
    const found = list.find(p => p.pid === number);
    if (!found) throw fail(`No ${MAC_STUDIOS[lane].name} process ${number} runs from an application bundle on this Mac; open the Studio normally and list the processes again.`);
    return found;
  }

  // The diagnostic socket of a pid, newest first: {path, dir, key} or null.
  async function endpointOf(pid) {
    const dirs = await tempFolders({ env: deps.env ?? process.env, run });
    return unixEndpoints(pid, dirs, { readdir: f.readdirSync, stat: f.statSync })[0] ?? null;
  }

  // What both lanes check before anything is sent.
  async function identify(lane, pid, { requireEndpoint }) {
    const p = await processOf(lane, pid);
    const name = MAC_STUDIOS[lane].name;
    if (!p.official) throw fail(`${name} ${p.pid} runs from ${p.bundle}, which is not in /Applications or ~/Applications; the agent attaches only an installed Studio.`);
    const hooks = p.info.runtimeConfig?.runtimeOptions?.configProperties?.['System.StartupHookProvider.IsSupported'];
    if (hooks === false || hooks === 'false')
      throw fail(`${name} turns startup hooks off (System.StartupHookProvider.IsSupported=false in ${p.info.entry}.runtimeconfig.json): no bridge can be attached to it. Nothing was sent.`);
    const endpoint = await endpointOf(p.pid);
    if (!endpoint) {
      if (requireEndpoint) throw fail(`${name} ${p.pid} has no .NET diagnostic socket (dotnet-diagnostic-${p.pid}-*-socket in $TMPDIR, the user temporary folder or /tmp): `
        + 'the Studio was started with DOTNET_EnableDiagnostics=0, or with another temporary folder. Nothing was sent; agent/ssam-agent.sh doctor shows the details.');
      return { p, endpoint: null, startSeconds: p.startSeconds, runtime: null };
    }
    const keySeconds = Number(endpoint.key);
    // ps prints the local start time; across a daylight saving change it may read one hour off the kernel's seconds.
    if (![0, 3600, -3600].includes(keySeconds - p.startSeconds))
      throw fail(`The diagnostic socket of ${name} ${p.pid} belongs to a process started at ${keySeconds}, but this one started at ${p.startSeconds}. Nothing was sent.`);
    let info;
    try { info = await ipc.processInfo2(endpoint.path, { timeoutMs: 10000 }); }
    catch (error) { throw fail(`The .NET diagnostic socket of ${name} ${p.pid} did not answer ProcessInfo2 (${error.message}). Nothing was sent.`); }
    if (Number(info.pid) !== p.pid) throw fail(`The diagnostic socket of ${name} ${p.pid} answers for process ${info.pid}. Nothing was sent.`);
    const major = runtimeMajor(info.clrVersion);
    if (major === null || major < 8) throw fail('Runtime connection requires .NET 8 or later. The Studio has not been changed.');
    return { p, endpoint, startSeconds: keySeconds, runtime: info.clrVersion };
  }

  // The exact Process.StartTime text of .NET for this process (cached per pid and start second).
  async function exactStart(pid, seconds) {
    const key = pid + ':' + seconds;
    if (!startCache.has(key)) startCache.set(key, await startTime(pid, { expectedSeconds: seconds, readers: deps.readers, run }));
    const value = startCache.get(key);
    return { text: dotnetStartTimeText(value.sec, value.usec), readers: value.readers };
  }

  // Anvil.Connect describe, on macOS: {ok, pid, path, studioDir, bundle, startedUtc, version, bridgePath, corePath,
  // diagnosticsAvailable, runtime}.
  async function describeO11(pid) {
    const { p, endpoint, startSeconds, runtime } = await identify('o11', pid, { requireEndpoint: false });
    let start;
    try { start = await exactStart(p.pid, startSeconds); }
    catch (error) { throw fail(`Service Studio ${p.pid}: ${error.message}. The O11 runtime hook compares this time, so nothing is sent without it; agent/ssam-agent.sh doctor shows which reader failed.`); }
    let files;
    try { files = await openFiles(p.pid, { run }); }
    catch (error) { throw fail(`The files of Service Studio ${p.pid} cannot be listed (lsof: ${String(error.message).split('\n')[0]}), so the agent cannot tell whether another Anvil bridge is loaded. Nothing was sent.`); }
    if (!files.some(file => /\.dll$/i.test(file))) throw fail(`lsof lists no managed DLL of Service Studio ${p.pid}, so the agent cannot tell whether another Anvil bridge is loaded. Nothing was sent.`);
    // The two assemblies Anvil.Connect looks for among the Studio's modules (the bridge and the kernel core).
    const loaded = pattern => files.find(file => pattern.test(file)) ?? null;
    return { ok: true, pid: p.pid, path: p.path, studioDir: p.info.managedDir, bundle: p.bundle, startedUtc: start.text, version: p.version,
      bridgePath: loaded(/\/Anvil\.Bridge\.dll$/i), corePath: loaded(/\/Anvil\.Core\.dll$/i), diagnosticsAvailable: Boolean(endpoint), runtime, startReaders: start.readers };
  }

  // Anvil.Connect attach, on macOS: the same process (same startedUtc), then ApplyStartupHook with the copied hook.
  async function attachO11(pid, startedUtc, hook) {
    const current = await describeO11(pid);
    if (current.startedUtc !== startedUtc) throw fail('The Studio process changed. Discover it again before connecting.');
    const file = path.resolve(hook);
    if (!f.existsSync(file)) throw fail('Hook not found: ' + file);
    const endpoint = await endpointOf(current.pid);
    if (!endpoint) throw fail('The Studio diagnostics endpoint is unavailable. Nothing was sent.');
    try { await ipc.applyStartupHook(endpoint.path, file, { timeoutMs: 20000 }); }
    catch (error) { throw fail('ApplyStartupHook: ' + error.message, error.sent === false ? false : null); }
    return { ok: true, hookRequested: true };
  }

  // ODC3.Bridge.Client attach, on macOS: {ok, attached, note}.
  async function attachOdc({ pid, bridge, version }) {
    if (!/^v\d+$/.test(String(version ?? '')) || !path.basename(String(bridge ?? '')).startsWith('ODC3.Bridge.' + version + '.'))
      throw fail('This agent only attaches ODC3.Bridge.' + (version ?? '(no version)') + '.');
    const file = path.resolve(bridge);
    if (!f.existsSync(file)) throw fail('The agent pack is missing ' + file);
    const first = await identify('odc', pid, { requireEndpoint: true });
    // Identity again right before the single request.
    const again = await identify('odc', first.p.pid, { requireEndpoint: true });
    if (again.startSeconds !== first.startSeconds || again.endpoint.path !== first.endpoint.path) throw fail('The ODC Studio process changed while preparing the attach. Nothing was sent.');
    try { await ipc.applyStartupHook(again.endpoint.path, file, { timeoutMs: 20000 }); }
    catch (error) { throw fail('ApplyStartupHook: ' + error.message + (error.sent === false ? '' : '. The attach is not confirmed; never repeat it before status.'), error.sent === false ? false : null); }
    return { ok: true, attached: true, note: ODC_NOTE };
  }

  // The folders where the bridge of a pid may listen: the folder of its diagnostic socket first (the Studio's
  // Path.GetTempPath()), then the other temporary folders.
  async function pipeFolders(pid) {
    const endpoint = await endpointOf(pid);
    const all = await tempFolders({ env: deps.env ?? process.env, run });
    return endpoint ? [endpoint.dir, ...all.filter(dir => dir !== endpoint.dir)] : all;
  }

  return { describeO11, attachO11, attachOdc, pipeFolders, endpointOf, identify, processOf };
}

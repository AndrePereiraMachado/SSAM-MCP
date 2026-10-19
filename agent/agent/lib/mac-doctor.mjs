// The macOS part of `doctor` (docs/AGENTE-MAC.md): every fact the attach depends on, read only, each with the next step
// when it is missing. Nothing is installed, changed or attached here; the one request to a Studio is ProcessInfo2 over its
// .NET diagnostic socket (read only: the pid, the runtime and the architecture). The read-only checks of the Mac study
// (application bundles, Info.plist, Mach-O architectures, runtimeconfig.json, entitlements, the diagnostic socket) are
// here so the person runs nothing by hand. deps: {run, fs, env, home, readers, ipc, arch, calibrate, spawnChild, clock,
// sleep} (the last four: the check of the start time readers on processes of the agent, macos.mjs calibrateReaders).
import fs from 'node:fs';
import path from 'node:path';
import { installedBundles, studioProcesses, tempFolders, START_READERS, machOArchs, runTool, TOOLS, homeOf, officialBundle, MAC_STUDIOS,
  parsePs, psText, openFiles, bundleOfExe, calibrateReaders } from './macos.mjs';
import { unixEndpoints, processInfo2 } from './dotnet-ipc.mjs';
import { unixPipeName, UNIX_PATH_MAX } from './odc-pipe-unix.mjs';

const posix = path.posix;
const firstLine = error => String(error?.message ?? error).split('\n')[0].slice(0, 200);
const numbers = value => (/^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value ?? '')) ?? []).slice(1).map(v => Number(v ?? 0));
const atLeast = (version, wanted) => { const a = numbers(version); const b = numbers(wanted); for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return a.length > 0; };

export async function macDoctor({ pack = {}, deps = {} } = {}) {
  const run = deps.run ?? runTool;
  const f = deps.fs ?? fs;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homeOf(env);
  const readers = deps.readers ?? START_READERS;
  const ipc = { processInfo2, ...(deps.ipc ?? {}) };
  const lanes = Array.isArray(pack.lanes) ? pack.lanes : [];
  const checks = []; const facts = {};
  const add = (ok, name, detail, required = false) => checks.push({ ok: Boolean(ok), name, detail, required });

  // ---- the system
  const tool = async (file, args) => { try { return String(await run(file, args)).trim(); } catch { return null; } };
  const macos = await tool(TOOLS.swVers, ['-productVersion']);
  const translated = (await tool(TOOLS.sysctl, ['-n', 'sysctl.proc_translated'])) === '1';
  const arm = (await tool(TOOLS.sysctl, ['-n', 'hw.optional.arm64'])) === '1';
  facts.system = { macos, cpu: arm ? 'arm64' : 'x86_64', nodeArch: deps.arch ?? process.arch, nodeUnderRosetta: translated };
  add(macos !== null && atLeast(macos, '14'), 'macOS', macos === null ? 'sw_vers did not answer' : `${macos} on ${facts.system.cpu}` + (atLeast(macos, '14') ? '' : '; ODC Studio needs macOS 14 (Sonoma) or newer'));
  if (translated) add(false, 'Node architecture', 'this Node runs under Rosetta (x64 on an Apple silicon Mac): run install.sh again from a Terminal that is not set to open with Rosetta');

  // ---- temporary folders: where the Studios put their diagnostic socket and the ODC bridge its pipe
  const userTemp = await tool(TOOLS.getconf, ['DARWIN_USER_TEMP_DIR']);
  const dirs = await tempFolders({ env, run });
  facts.tempFolders = { TMPDIR: env.TMPDIR ?? null, userTemp, searched: dirs };
  const same = userTemp && env.TMPDIR && userTemp.replace(/\/+$/, '') === String(env.TMPDIR).replace(/\/+$/, '');
  add(Boolean(same) || !env.TMPDIR, 'temporary folder', same ? `${env.TMPDIR} (the one macOS gives the apps)` : `TMPDIR is ${env.TMPDIR ?? '(unset)'}, the user temporary folder is ${userTemp ?? '(unknown)'}; the agent looks in both and in /tmp`);

  // ---- the start time with microseconds (the O11 runtime hook compares it): each reader checked on processes the agent
  // starts itself, the same check the Service Studio connection makes (macos.mjs calibrateReaders, review M4).
  const calibration = await (deps.calibrate ?? (() => calibrateReaders({ readers, run, ...(deps.spawnChild ? { spawnChild: deps.spawnChild } : {}),
    ...(deps.clock ? { now: deps.clock } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) })))()
    .catch(error => ({ trusted: [], results: Object.keys(readers).map(name => ({ name, ok: false, offsetsMs: [], error: firstLine(error) })) }));
  facts.startTimeReaders = calibration.results;
  const working = calibration.trusted;

  // ---- installed Studios
  let bundles = [];
  try { bundles = await installedBundles({ run, fs: f, env, home }); } catch (error) { add(false, 'Studios', 'the application folders could not be read: ' + firstLine(error)); }
  facts.studios = [];
  for (const info of bundles) {
    const name = MAC_STUDIOS[info.kind].name;
    let archs = [];
    try { const fd = f.openSync(info.exePath, 'r'); const head = Buffer.alloc(4096); f.readSync(fd, head, 0, 4096, 0); f.closeSync(fd); archs = machOArchs(head); } catch { /* no executable */ }
    const hooks = info.runtimeConfig?.runtimeOptions?.configProperties?.['System.StartupHookProvider.IsSupported'];
    const diagnostics = info.environment?.DOTNET_EnableDiagnostics ?? info.environment?.COMPlus_EnableDiagnostics ?? null;
    const entitlements = await tool(TOOLS.codesign, ['-d', '--entitlements', ':-', info.bundle]);
    const sandboxed = entitlements !== null && /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\s*\/>/.test(entitlements);
    const official = officialBundle(info.bundle, home);
    const fact = { lane: info.kind, bundle: info.bundle, official, executable: info.executable, archs, managedDir: info.managedDir, entry: info.entry,
      productVersion: info.productVersion, shortVersion: info.shortVersion, bundleVersion: info.bundleVersion, version: info.version, versionSource: info.versionSource,
      startupHooks: hooks === false || hooks === 'false' ? 'off' : 'on', diagnosticsEnvironment: diagnostics, sandboxed, entitlementsRead: entitlements !== null };
    facts.studios.push(fact);
    const problems = [];
    if (!official) problems.push('it is not in /Applications or ~/Applications: move it there (the agent attaches only an installed Studio)');
    if (fact.startupHooks === 'off') problems.push('this build turns startup hooks off (System.StartupHookProvider.IsSupported=false): no bridge can be attached; tell the server owner');
    if (diagnostics === '0') problems.push('its Info.plist sets DOTNET_EnableDiagnostics=0: the attach is off; tell the server owner');
    if (sandboxed) problems.push('it runs in the App Sandbox: its sockets live in its container; tell the server owner');
    if (!info.exePath || archs.length === 0) problems.push('its executable (CFBundleExecutable) was not found or is not a Mach-O file');
    add(problems.length === 0, name, `${info.version ?? 'unknown version'} in ${info.bundle} (${archs.join('+') || '?'}; managed DLLs in ${posix.relative(info.bundle, info.managedDir)}; version from ${info.versionSource ?? 'nowhere'})`
      + (problems.length ? '. ' + problems.join('; ') : ''));
  }
  for (const lane of lanes) if (!bundles.some(b => b.kind === lane))
    add(false, MAC_STUDIOS[lane].name, `not found in /Applications or ~/Applications (an application bundle whose Contents hold ${MAC_STUDIOS[lane].requires.join(' and ')})`);
  const o11Installed = bundles.some(b => b.kind === 'o11');
  add(working.length > 0, 'start time with microseconds (Service Studio hook)', calibration.results.map(r => (r.ok
    ? `${r.name} ok (${r.offsetsMs.map(ms => ms.toFixed(3)).join(' and ')} ms after the start of processes the agent started)` : `${r.name} failed: ${r.error}`)).join('; ')
    + (working.length ? '' : '. Without it the Service Studio lane cannot connect; send this doctor --json to the server owner'), lanes.includes('o11') && o11Installed);

  // ---- running Studios
  let psOut = '';
  try { psOut = await (deps.ps ?? (() => psText({ run, env })))(); } catch (error) { add(false, 'processes', 'ps did not answer: ' + firstLine(error)); }
  facts.running = [];
  const matched = new Set();
  for (const lane of ['odc', 'o11']) {
    let list = [];
    try { list = await studioProcesses(lane, { run, fs: f, env, home, ps: async () => psOut }); } catch { list = []; }
    for (const p of list) {
      matched.add(p.pid);
      const name = MAC_STUDIOS[lane].name;
      const endpoint = unixEndpoints(p.pid, dirs, { readdir: f.readdirSync, stat: f.statSync })[0] ?? null;
      const fact = { lane, pid: p.pid, path: p.path, version: p.version, startSeconds: p.startSeconds, official: p.official, socket: endpoint?.path ?? null, socketKey: endpoint ? Number(endpoint.key) : null };
      const notes = [];
      let ok = Boolean(endpoint);
      if (endpoint) {
        try { const info = await ipc.processInfo2(endpoint.path, { timeoutMs: 5000 }); fact.runtime = info.clrVersion; fact.arch = info.arch; fact.os = info.os; fact.ipcPid = info.pid;
          if (info.pid !== p.pid) { ok = false; notes.push(`the socket answers for pid ${info.pid}`); } else notes.push(`.NET ${info.clrVersion} (${info.arch})`); }
        catch (error) { ok = false; fact.ipcError = firstLine(error); notes.push('ProcessInfo2 failed: ' + fact.ipcError); }
        if (lane === 'odc' && pack.odcBridge) {
          const socket = posix.join(endpoint.dir, unixPipeName(pack.odcBridge, p.pid));
          fact.bridgeSocket = socket; fact.bridgeAttached = (() => { try { return f.statSync(socket).isSocket(); } catch { return false; } })();
          if (Buffer.byteLength(socket) > UNIX_PATH_MAX) { ok = false; notes.push(`the bridge socket path has more than ${UNIX_PATH_MAX} bytes`); }
          notes.push(fact.bridgeAttached ? `bridge ${pack.odcBridge} attached` : `bridge ${pack.odcBridge} not attached yet`);
        }
        if (lane === 'o11') {
          // Only the readers that passed the check count; those must match the kernel seconds and agree to the microsecond.
          const good = []; const bad = []; const usec = {};
          for (const [readerName, read] of Object.entries(readers)) {
            if (!working.includes(readerName)) { bad.push(readerName + ': did not pass the check on processes of the agent'); continue; }
            try { const v = await read(p.pid, { run }); if (v.sec === fact.socketKey) { good.push(readerName); usec[readerName] = v.usec; } else bad.push(`${readerName} (${v.sec} s)`); }
            catch (error) { bad.push(readerName + ': ' + firstLine(error)); }
          }
          const agree = new Set(Object.values(usec)).size <= 1;
          fact.startReaders = { good, bad, agree, usec };
          if (!good.length) { ok = false; notes.push('no checked start time reader matches the kernel: ' + bad.join('; ')); }
          else if (!agree) { ok = false; notes.push('the start time readers disagree in the microseconds (' + Object.entries(usec).map(([n, u]) => `${n} ${u}`).join(', ') + '): the Service Studio connection refuses; send this doctor --json to the server owner'); }
          try { const files = await openFiles(p.pid, { run }); fact.mappedDlls = files.filter(x => /\.dll$/i.test(x)).length; fact.anvilLoaded = files.filter(x => /\/Anvil\.(Bridge|Core)\.dll$/i.test(x));
            if (!fact.mappedDlls) { ok = false; notes.push('lsof lists no managed DLL of it'); } }
          catch (error) { ok = false; notes.push('lsof failed: ' + firstLine(error)); }
        }
      } else notes.push(`no .NET diagnostic socket (dotnet-diagnostic-${p.pid}-*-socket in ${dirs.join(', ')}): the attach needs it. Quit the Studio and open it again from the Dock or Finder; if it stays missing, it was started with DOTNET_EnableDiagnostics=0`);
      if (!p.official) { ok = false; notes.push('it runs from outside /Applications and ~/Applications'); }
      facts.running.push(fact);
      add(ok, `${name} ${p.pid} running`, notes.join('; '));
    }
  }
  // Processes that look like a Studio but were not recognized (diagnosis for the owner).
  const others = parsePs(psOut).filter(p => !matched.has(p.pid) && /outsystems|odc ?studio|service ?studio/i.test(p.exe) && !/helper/i.test(p.exe)).slice(0, 10);
  facts.otherProcesses = others.map(p => ({ pid: p.pid, exe: p.exe, bundle: bundleOfExe(p.exe) }));
  if (others.length) add(false, 'unrecognized Studio processes', others.map(p => `${p.pid} ${p.exe}`).join('; ') + '; send this doctor --json to the server owner');
  return { checks, facts };
}

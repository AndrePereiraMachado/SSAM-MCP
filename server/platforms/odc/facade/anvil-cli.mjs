// One way for the facade to run the O11 Anvil CLI (`dotnet <anvil.dll> <verb> ...`) and read its one JSON envelope
// ({ok, command, elapsedMs, data} or {ok:false, error, stack}), with the lane environment (ANVIL_LANE, and the
// selected Studio and authority folder from the connection record). No Python and no shell: JSON, spaces and shell
// metacharacters travel as separate arguments. Tools receive a runner (createAnvilRunner) so tests inject a fake.
// Hosted (executor.mjs, docs/FASE2-AGENTE.md 4.7), with the default root, every run gets the closed environment and the
// folder of the customer's workspace (the ODC one when the assembly is anvil-odc.dll), never this process's variables.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { connectionEnvironment, readConnection } from './studio-session.mjs';
import { hostedSpawnEnv, usesWorkspace } from './executor.mjs';
import { kernelStart } from './quality-meter.mjs';
import { withTraceArgs } from './correlation.mjs';

const tail = (text, lines = 10) => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-lines);

// The selected Studio of the connection record also names its bridge port: verbs that take the port from
// ANVIL_BRIDGE_PORT (inventory, download, create-app, ...) reach that Studio, not the lane table default.
export function laneEnvironment({ lane = o11Lane.lane, root = anvilRoot, env = process.env } = {}) {
  if (usesWorkspace(root, anvilRoot)) return hostedSpawnEnv('o11').env;
  let record = {}; let port = null;
  try { record = connectionEnvironment(root, lane); port = readConnection(root, lane)?.port ?? null; } catch { /* an invalid record is reported by the tools that need it */ }
  return o11LaneOf(lane, { root, env }).env({ ...env, ...record, ...(Number.isInteger(port) && !env.ANVIL_BRIDGE_PORT ? { ANVIL_BRIDGE_PORT: String(port) } : {}) });
}

// run(args, {input, timeoutMs, cwd, cli}) -> {ok, exitCode, envelope|null, stderr[], wallMs, line}
export function createAnvilRunner({ lane = o11Lane.lane, root = anvilRoot, env = process.env, environment = laneEnvironment, execFileFn = execFile, dotnet = 'dotnet' } = {}) {
  return function runAnvil(args, { input, timeoutMs = 900000, cwd = root, cli } = {}) {
    const assembly = cli ?? o11LaneOf(lane, { root, env }).cli;
    // F7: a kernel delivery records the session and the call it runs for (task.json trace).
    args = withTraceArgs(args);
    const argv = [assembly, ...args.map(String)];
    // Hosted: the closed environment, with the customer's relay as the bridge port (executor.mjs hostedSpawnEnv).
    const odcCli = /anvil-odc\.dll$/i.test(assembly);
    const hosted = usesWorkspace(root, anvilRoot) ? hostedSpawnEnv(odcCli ? 'odc' : 'o11') : null;
    const started = Date.now();
    // Quality (docs/QUALIDADE.md): this cold process is a kernel leaf; a no-op outside a hosted call.
    const end = kernelStart({ lane: odcCli ? 'odc' : 'o11', via: 'cold' });
    return new Promise(resolve => {
      let child;
      try {
        child = execFileFn(dotnet, argv, { cwd: hosted ? hosted.cwd : cwd, env: hosted ? hosted.env : environment({ lane, root, env }), windowsHide: true,
          maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
          const text = String(stdout ?? '').trim();
          let envelope = null;
          try { envelope = text ? JSON.parse(text) : null; } catch { envelope = null; }
          const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          end({ ok: exitCode === 0 });
          resolve({ ok: exitCode === 0 && envelope?.ok === true, exitCode, envelope,
            ...(envelope ? {} : { stdout: tail(text, 40) }), stderr: tail(stderr), wallMs: Date.now() - started,
            ...(error?.killed ? { timedOut: true } : {}), line: ['dotnet', path.basename(assembly), ...args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ') });
        });
      } catch (error) { end({ ok: false }); throw error; }
      if (input !== undefined) { child.stdin?.end(typeof input === 'string' ? input : JSON.stringify(input)); }
    });
  };
}

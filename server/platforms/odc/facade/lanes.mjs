// The lane table: one row per platform, and a `run` that only turns a verb into that lane's own command line
// and spawns it. No delivery logic lives here: O11 is the Anvil CLI, ODC is `odc.cmd`, and each keeps its own
// gates, journal and authorizations. `command()` builds the line without executing anything (that is what the
// test asserts); `run()` is `command()` plus a spawn.
//
// Two rows differ from the plan's draft table, both proved against the code on 2026-09-16 and recorded in
// docs\lanes.md of the Anvil:
//   - the O11 CLI is `dotnet <.local[/lane-ss5]/cli/anvil.dll>` (AGENTS.md section 1; the same resolution order as
//     scripts/lanes.py), not `python scripts/anvil_cli.py`: that file is a library, it has no entry point;
//   - `doctor` is answered here; O11 `data` delegates to native headless Edit Data, while `publish` stays separate.
// `job` runs in this process for both lanes (job-runner.mjs, the port of scripts/run_job.py): the lane's resident
// worker or a cold `dotnet` of its CLI, and a JSON answer instead of text lines. `service-center` runs in this process too
// (service-center/index.mjs, the port of scripts/o11_service_center.py). No lane verb spawns Python.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { isModelReading, kernelReading } from './kernel-reading.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { runJob } from './job-runner.mjs';
import { currentExecutor, hostedContext, hostedSpawnEnv, o11NotConnected, seamFields, usesWorkspace, workspacePath } from './executor.mjs';

const exec = promisify(execFile);
const odcRoot = process.env.SSAM_HYBRID_ODC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One rule for the O11 lane (workspace.mjs): explicit ANVIL_LANE, else the workspace's o11Lane; never a local default.
const anvilLane = o11Lane.lane;

const first = (...candidates) => candidates.find(c => fs.existsSync(c)) ?? candidates[candidates.length - 1];
// The Python of this machine for the developer's own scripts (kernel/scripts, scripts/build.ps1), resolved as
// scripts/setup-dev.ps1 records it: SSAM_PYTHON, then the Python bundled with the Codex runtime under the user's
// profile (USERPROFILE; the original machine's as fallback), then python on PATH. No lane verb and no MCP tool calls it.
const CODEX_PYTHON = path.join(process.env.USERPROFILE ?? 'C:\\Users\\andre', '.cache', 'codex-runtimes', 'codex-primary-runtime',
  'dependencies', 'python', 'python.exe');
export const python = () => process.env.SSAM_PYTHON ?? (fs.existsSync(CODEX_PYTHON) ? CODEX_PYTHON : 'python');
// The lane's CLI assembly, in the order scripts/lanes.py uses: the lane build, the ss4 build, the source build.
export function anvilCli(root = anvilRoot, laneName = anvilLane) {
  const local = path.join(root, laneName === 'ss5' ? path.join('.local', 'lane-ss5') : '.local');
  return first(path.join(local, 'cli', 'anvil.dll'), path.join(root, '.local', 'cli', 'anvil.dll'),
    path.join(root, 'src', 'Anvil.Cli', 'bin', 'Release', 'net8.0', 'anvil.dll'));
}
// Cold data commands can be rebuilt independently of a loaded model-reading worker.
export function anvilDataCli(root = anvilRoot, laneName = anvilLane) {
  const local = path.join(root, laneName === 'ss5' ? path.join('.local', 'lane-ss5') : '.local');
  const regular = anvilCli(root, laneName);
  return [path.join(local, 'data-cli', 'anvil.dll'), regular].filter(p => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? regular;
}

// The catalogs are data: hosted they are the customer's (<ws>/o11/inventory.json, <ws>/odc/snapshots/modules.json).
export const LANES = {
  o11: { name: 'o11', platform: 'OutSystems 11 (Service Studio)', root: anvilRoot, lane: anvilLane, laneSource: o11Lane.source,
    exe: 'dotnet', cli: anvilCli(),
    get catalog() { return usesWorkspace(anvilRoot, anvilRoot) ? workspacePath('o11', 'inventory.json') : path.join(anvilRoot, anvilLane === 'ss5' ? path.join('.local', 'lane-ss5') : '.local', 'inventory.json'); },
    catalogHint: 'dotnet <cli> inventory --out <.local dir> writes inventory.json with the modules of the connected environment',
    studioProcess: 'ServiceStudio.exe', studioDir: null },
  odc: { name: 'odc', platform: 'OutSystems Developer Cloud (ODC Studio)', root: odcRoot, lane: null,
    exe: path.join(odcRoot, 'odc.cmd'), cli: path.join(odcRoot, 'odc.cmd'),
    get catalog() { return usesWorkspace(odcRoot, odcRoot) ? workspacePath('odc', 'snapshots', 'modules.json') : path.join(odcRoot, 'snapshots', 'modules.json'); },
    catalogHint: 'odc studio assets rewrites snapshots\\modules.json from the native listing',
    studioProcess: 'ODCStudio.exe', studioDir: null },
};
export const laneNames = Object.keys(LANES);
export function lane(name) {
  const entry = LANES[String(name ?? '').trim().toLowerCase()];
  if (!entry) throw new Error('Unknown lane ' + name + '; lanes: ' + laneNames.join(', '));
  return entry;
}

// Verb -> the arguments that lane's CLI already takes. FACADE: ssam answers it for both lanes at once (doctor).
// RUNNER: the job runner of this process (job-runner.mjs). false: that lane's CLI has no such verb, and the facade
// refuses instead of inventing one.
const FACADE = Symbol('answered by ssam itself');
const RUNNER = Symbol('job-runner.mjs');
const SERVICE_CENTER = Symbol('service-center/index.mjs');
// A verb a lane's CLI does not have says where that work goes in that lane instead; never just "not available".
const ELSEWHERE = {
  o11: {
    publish: 'The Anvil CLI has no publish verb: in O11 publish with the MCP tool o11_publish {module, authorize} (the '
      + 'module open in the selected Service Studio and the user\'s own words; TrueChange errors come back and nothing '
      + 'is published).',
  },
  odc: {
    'create-app': 'ODC apps and libraries are created through the ODC Studio as its Create app does (MCP studio_create_app {kind, name, authorize}).',
    'add-modules': 'An ODC app is one module: a new app or library is MCP studio_create_app {kind, name, authorize}.',
    inventory: 'The ODC asset listing is `odc studio assets` (snapshots\\modules.json).',
    download: 'ODC models are read from the open ODC Studio or its captures (ssam inspect --lane odc).',
    access: 'ssam access manages O11 end-user roles (persistent roles of O11 modules, by versioned manifest). ODC end users '
      + 'and roles are managed in the ODC Portal; the ODC lane has no counterpart yet.',
  },
};
const VERBS = {
  doctor: { o11: FACADE, odc: FACADE },
  inspect: { o11: ['inspect'], odc: ['inspect'] },
  // The module index of a capture, both lanes (module-map.mjs): `ssam map [--lane l] <capture.oml|Module> ...`.
  map: { o11: FACADE, odc: FACADE },
  deliver: { o11: ['deliver'], odc: ['deliver'] },
  data: { o11: ['data'], odc: ['studio', 'data'] },
  publish: { o11: false, odc: ['studio', 'publish'] },
  // One job runner for both lanes (job-runner.mjs, the port of the Anvil's scripts/run_job.py): O11 over its CLI,
  // ODC over the anvil-odc CLI (the same kernel compiled against the ODC Studio, since WS1). It applies a job to a
  // fixture; delivering to the open Studio stays with the verb `deliver`, in both lanes.
  job: { o11: RUNNER, odc: RUNNER },
  // Environment operations of the O11 CLI. Without --credentials they run through the Service Studio already logged
  // in on the lane (SSO included): the bridge executes each server call with the Studio's own session and no secret
  // leaves the Studio (kernel AGENTS.md "Criacao inicial de aplicacao e modulos").
  'create-app': { o11: ['create-app'], odc: false },
  'add-modules': { o11: ['add-modules'], odc: false },
  inventory: { o11: ['inventory'], odc: false },
  download: { o11: ['download'], odc: false },
  dependencies: { o11: ['dependencies'], odc: false },
  signature: { o11: ['signature'], odc: false },
  referenceable: { o11: ['referenceable'], odc: false },
  // Service Center (service-center/index.mjs, in this process): through the Studio connected on the lane (bridge
  // sc_api/sc_web, SSO included), else the Windows vault, else a private prompt window; never a credential in the arguments.
  'service-center': { o11: SERVICE_CENTER, odc: false },
  // End-user roles by versioned manifest (kernel\src\Anvil.Core\Access): `ssam access plan|apply|verify --lane o11
  // --manifest <abs>.json [--words "..."]`. plan is offline; apply needs the user's words and never publishes.
  access: { o11: ['access'], odc: false },
};
export const verbs = Object.keys(VERBS);
const quote = a => (/[\s"]/.test(a) ? JSON.stringify(a) : a);

// The `ssam job` arguments (those of run_job.py) as one job-runner request: <job> [--base b] [--out o]
// [--producer N=path]* [--capture-producer N[=P]]* [--lane o11|odc] [--quiet]; `--opt=value` is accepted too. A
// --lane among the arguments wins over the row's lane, as run_job.py's own --lane did. Throws on anything else.
export function jobRequest(laneName, args = []) {
  const request = { lane: lane(laneName).name, producers: [], captureProducers: [] };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      const v = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (v === undefined) throw new Error(flag + ' needs a value');
      return String(v);
    };
    if (flag === '--base') request.base = value();
    else if (flag === '--out') request.out = value();
    else if (flag === '--producer') request.producers.push(value());
    else if (flag === '--capture-producer') request.captureProducers.push(value());
    else if (flag === '--lane') request.lane = lane(value()).name;
    else if (flag === '--quiet') request.quiet = true;
    else if (arg.startsWith('-')) throw new Error('Unknown job argument ' + arg);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error('ssam job takes one job: <job.json> [--base <oml>] [--out <oml>] [--producer Name=<oml>]* '
    + '[--capture-producer Name[=Producer]]* [--quiet]');
  request.job = positional[0];
  return request;
}

// The command line for one verb in one lane, built and never executed.
export function command(laneName, verb, args = []) {
  const entry = lane(laneName);
  const mapped = VERBS[verb]?.[entry.name];
  if (mapped === undefined) throw new Error('Unknown verb ' + verb + '; verbs: ' + verbs.join(', '));
  if (mapped === FACADE) return { lane: entry.name, verb, available: false, facade: true, root: entry.root,
    reason: 'ssam answers ' + verb + ' itself, lane by lane; it is not delegated to a CLI.' };
  if (mapped === SERVICE_CENTER) return { lane: entry.name, verb, available: true, facade: false, runner: 'service-center/index.mjs', root: anvilRoot,
    line: ['service-center', ...args.map(String)].map(quote).join(' ') };
  // The job runner of this process: the request it will run, never a child command line of its own.
  if (mapped === RUNNER) {
    const built = { lane: entry.name, verb, available: true, facade: false, runner: 'job-runner.mjs', root: anvilRoot,
      line: ['job-runner', entry.name, ...args.map(String)].map(quote).join(' ') };
    try { return { ...built, request: jobRequest(entry.name, args) }; }
    catch (error) { return { ...built, error: error.message }; }
  }
  if (mapped === false) return { lane: entry.name, verb, available: false, facade: false, root: entry.root,
    reason: ELSEWHERE[entry.name]?.[verb] ?? ('The ' + entry.name + ' CLI has no ' + verb + ' verb.'),
    checkedIn: entry.name === 'o11' ? 'src\\Anvil.Cli\\Program.cs' : 'facade\\odc.mjs' };
  const root = entry.root;
  // execFile cannot execute .cmd on Windows (EINVAL). Invoke the same facade with Node directly,
  // keeping JSON, spaces and shell metacharacters as individual arguments without a command shell.
  const [exe, argv] = entry.name === 'odc'
      ? [process.execPath, [path.join(root, 'facade', 'odc.mjs'), ...mapped, ...args]]
      : [entry.exe, [verb === 'data' ? anvilDataCli() : entry.cli, ...mapped, ...args]];
  // The user's authorization words go to the lane as they are, but the printed line never repeats them.
  const shown = argv.map((a, i) => (argv[i - 1] === '--words' ? '<words>' : a.startsWith('--words=') ? '--words=<words>' : a));
  return { lane: entry.name, verb, available: true, facade: false, root, exe, argv,
    line: [exe, ...shown].map(quote).join(' ') };
}

// Spawn the line `command()` built, in the lane's own root, and return its output as it came. A refusal is
// returned, never thrown: the caller prints the same JSON shape either way. `job` runs in this process
// (job-runner.mjs) and answers its JSON summary; jobDeps reaches runJob (tests inject a fake CLI and worker). dataDeps
// reaches the gate of O11 data deletes (data-delete-gate.mjs: tests inject send, cwd, now, root, uuid).
export async function run(laneName, verb, args = [], { maxBuffer = 64 * 1024 * 1024, jobDeps = {}, dataDeps = {}, dataGate = true } = {}) {
  // Hosted, `dependencies inspect` (an offline OML read) and `help` touch no Studio: they run without the customer's
  // O11 record, as the hosted gate classifies them (hosted/tools.json o11_dependencies).
  const offline = verb === 'dependencies' && ['inspect', 'help'].includes(String(args[0] ?? 'help')) && hostedContext() !== null;
  if (laneName === 'o11' && !offline && ['deliver', 'inventory', 'download', 'create-app', 'add-modules', 'signature', 'referenceable', 'dependencies'].includes(verb)) {
    try { await (await import('./studio-connect.mjs')).assertSelectedO11(); }
    catch (error) { return { ok: false, lane: laneName, verb, ...seamFields(error), error: error.message }; }
  }
  const built = command(laneName, verb, args);
  if (!built.available) return { ok: false, ...built };
  if (built.runner === 'service-center/index.mjs') {
    const { serviceCenterTool } = await import('./service-center/index.mjs');
    try { return await serviceCenterTool(args); }
    catch (error) { return { ok: false, lane: built.lane, verb, error: error.message }; }
  }
  if (built.runner) {
    if (built.error) return { ok: false, lane: built.lane, verb, line: built.line, code: 'invalid-arguments', error: built.error };
    try { return { ...(await runJob(built.request, jobDeps)), lane: built.request.lane, verb, line: built.line }; }
    catch (error) { return { ok: false, lane: built.request.lane, verb, line: built.line, error: error.message }; }
  }
  if (built.lane === 'o11' && verb === 'inspect' && isModelReading(args)) {
    try {
      const result = await kernelReading(lane(laneName),args);
      return {ok:result.ok,lane:built.lane,verb,line:built.line,exitCode:0,result};
    } catch (error) { return {ok:false,lane:built.lane,verb,line:built.line,exitCode:1,error:error.message}; }
  }
  // `data --studio` reaches the Studio connected on the lane by the lane's bridge port. Hosted, every O11 verb gets the
  // closed environment of the customer's workspace (the relay port of its record, never this process's variables), and
  // an ODC verb is refused: its child process would run without the hosted context.
  // CX15 (local only): a data request with a delete previews first, as o11_data does (data-delete-gate.mjs); its reads and
  // the delete run through this same line (dataGate:false), with another request file. Hosted, deleting is refused at the
  // gate (hosted/destructive.mjs) and no hosted tool reaches this verb; the gate would write its requests in built.root,
  // the server's root, so it never runs there.
  let spawn, local = false;
  try {
    if (usesWorkspace(built.root, built.lane === 'o11' ? anvilRoot : odcRoot)) {
      if (built.lane !== 'o11') return { ok: false, lane: built.lane, verb, line: built.line, code: 'HOSTED_UNAVAILABLE',
        error: 'The ODC lane verbs run in a child process of their own, which has no hosted context; use the ODC tools of this server.' };
      // data reads and writes the customer's Studio (data --studio): refused here without the record, before the spawn.
      if (verb === 'data' && !currentExecutor().o11Connection()) throw o11NotConnected();
      const hosted = hostedSpawnEnv('o11');
      spawn = { cwd: hosted.cwd, env: hosted.env };
    } else {
      local = true;
      spawn = { cwd: built.root, ...(built.lane === 'o11' && verb === 'data' ? { env: { ...process.env, ANVIL_LANE: anvilLane } } : {}) };
    }
  } catch (error) { return { ok: false, lane: built.lane, verb, line: built.line, ...seamFields(error), error: error.message }; }
  if (local && dataGate && built.lane === 'o11' && verb === 'data') { const gated = await (await import('./data-delete-gate.mjs')).cliDataDelete(args, { send: argv => run(laneName, verb, argv, { maxBuffer, jobDeps, dataGate: false }), cwd: built.root, ...dataDeps }); if (gated) return gated; }
  const result = await exec(built.exe, built.argv, { ...spawn, windowsHide: true, maxBuffer })
    .then(r => ({ ...r, exitCode: 0 }))
    .catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? error.message ?? '', exitCode: error.code ?? 1 }));
  const text = (result.stdout ?? '').trim();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not every lane verb prints JSON */ }
  const reply = { ok: result.exitCode === 0 && (json?.ok ?? true), lane: built.lane, verb, line: built.line,
    exitCode: result.exitCode, ...(json ? { result: json } : { output: text.split(/\r?\n/).filter(Boolean) }),
    ...(result.stderr?.trim() ? { stderr: result.stderr.trim().split(/\r?\n/).slice(-10) } : {}) };
  if (reply.ok && built.lane === 'o11') { const capture = o11Capture(verb, json?.data); if (capture) warmIndex(capture); }
  return reply;
}

// The capture an O11 verb produced: the downloaded module, or the delivered snapshot (else the merged candidate).
export function o11Capture(verb, data) {
  if (verb === 'download') return data?.Status === 'ok' && typeof data.FilePath === 'string' ? data.FilePath : null;
  if (verb === 'deliver') return (Array.isArray(data?.artifacts) ? data.artifacts : []).map(a => a?.path).filter(p => typeof p === 'string' && /\.oml$/i.test(p)).at(-1) ?? null;
  return null;
}
// Its module index is built in the background (module-map.mjs); the verb's answer never waits for it or changes.
const warmIndex = file => import('./module-map.mjs').then(m => m.prefetchIndex(file, 'o11')).catch(() => {});

// What each lane's catalog lists, as a cache of its last listing and never as a claim about the environment.
export function catalog(laneName) {
  const entry = lane(laneName);
  if (!fs.existsSync(entry.catalog)) return { lane: entry.name, file: entry.catalog, listed: false, modules: [], hint: entry.catalogHint };
  try {
    const data = JSON.parse(fs.readFileSync(entry.catalog, 'utf8').replace(/^﻿/, '')); // the catalogs are written with a BOM
    const rows = data.modules ?? [];
    return { lane: entry.name, file: entry.catalog, listed: true, listedAt: data.modulesListedAt ?? data.capturedAtUtc ?? null,
      tenant: data.tenant ?? data.host ?? null, modules: rows.map(m => m.name ?? m.Name).filter(Boolean) };
  } catch (error) { return { lane: entry.name, file: entry.catalog, listed: false, modules: [], error: error.message, hint: entry.catalogHint }; }
}

// The lane of a module, by the catalogs alone. Present in both lanes, or in none, is a refusal asking for --lane.
export function laneOfModule(module) {
  const catalogs = laneNames.map(catalog);
  const found = catalogs.filter(c => c.modules.some(m => m.toLowerCase() === String(module).toLowerCase()));
  if (found.length === 1) return { ok: true, lane: found[0].lane, module, from: found[0].file };
  const unlisted = catalogs.filter(c => !c.listed).map(c => c.lane);
  if (found.length > 1) return { ok: false, module, lanes: found.map(c => c.lane),
    error: 'Module ' + module + ' exists in both lanes (' + found.map(c => c.lane).join(', ') + '); pass --lane.' };
  return { ok: false, module, error: 'Module ' + module + ' is in no lane catalog; pass --lane.'
    + (unlisted.length ? ' Not listed yet: ' + unlisted.map(l => l + ' (' + LANES[l].catalogHint + ')').join('; ') + '.' : ''),
    catalogs: catalogs.map(c => ({ lane: c.lane, listed: c.listed, modules: c.modules.length })) };
}

// Which Studio of each lane is open: the ODC Studio process, or the Service Studio process whose executable is
// under the lane's own installation (scripts/lanes.py puts each O11 lane in its own copy of the Studio).
// Each process says whether it still has a main window (D5 of the atritos 3 package): window true | false | null
// (unknown), and when it started (startedAt, Win32_Process CreationDate). It is read from the system only (Get-Process
// MainWindowHandle/MainWindowTitle; the process is never touched).
// A process whose only window is an SSAM window (title "... (SSAM)": the hidden Service Center window of an older bridge,
// which kept a Studio running after its main window was closed) has its visible top-level windows listed (EnumWindows) to
// decide: SSAM windows only is windowless.
// The windowed listing (D5) is the local executor's (executor.mjs, the seam): re-exported here for its callers.
export { SSAM_WINDOW_TITLE, windowState, studioProcessScript, parseStudioProcesses } from './executor.mjs';
// The listing is the studio.processes call of the executor seam (hosted: the customer's machine, with each executable's
// version; the local executor runs studioProcessScript and answers each process's window). An agent that does not say
// whether a process has a window answers window null (unknown): such a process is never treated as windowless.
// startedAt (pattern 5, 2026-10-08): the process creation time when the listing has it, so a windowless Studio still opening
// is told apart from an orphan left by a restart (studio-connect.mjs windowlessFacts).
export async function studioProcesses(imageName) {
  const { processes } = await currentExecutor().call('studio.processes', { image: imageName });
  return (processes ?? []).map(p => ({ pid: p.pid, path: p.path, ...(p.version ? { version: p.version } : {}),
    window: typeof p.window === 'boolean' ? p.window : null,
    ...(typeof p.startedAt === 'string' && Number.isFinite(Date.parse(p.startedAt)) ? { startedAt: p.startedAt } : {}) }));
}

// The O11 lane's own facts (o11-lane.mjs, the lanes.py table in this process): no Python runs to answer them.
export async function anvilLaneFacts(laneName = anvilLane, root = anvilRoot) {
  return o11LaneOf(laneName, { root }).asDict();
}

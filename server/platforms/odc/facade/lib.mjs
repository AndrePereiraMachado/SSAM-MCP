// SSAM Hybrid-ODC facade library: everything the CLI (odc.mjs) and the MCP server (mcp.mjs) share.
// Studio lane = bridge client + builder (C#, spawned per call). Portal lane = official ODC public REST APIs.
// Every Studio call goes through the executor seam (executor.mjs): locally today's pipe and .NET client, hosted the
// customer's agent. Hosted, the data of this module (tenants.json, snapshots, journal, lab, requests and receipts) is the
// customer's <ws>/odc; the code locations (bridge client, builder, studio/, portal/runtime) stay where they are.
import { execFile } from 'node:child_process';
import { createCredentialPrompt } from '../portal/runtime/credential-prompt.mjs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writePortalRequest } from './portal-request-file.mjs';
import { CredentialProfiles } from './credential-profiles.mjs';
import { readSnapshot, presentReading } from './reader-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deliverKernel, publishAuthorization, publishDelivered, studioSteps, withMergeCode, withoutStack } from './kernel-delivery.mjs';
import { resolveApplicationUrls, withAppLinks, appUrlCapability, derivedStageOrigin } from './app-urls.mjs';
import { signedRuntime } from './signed-runtime.mjs';
import { readLocalSettings, withLocalTenant } from './local-settings.mjs';
import { LocalExecutor, bridgeClientPath, contextLost, currentExecutor, hostedContext, hostedSpawnEnv, servedWithoutContext, usesWorkspace,
  workspacePath } from './executor.mjs';
import { resolveOpenModule } from './studio-module.mjs';
import { kernelStart } from './quality-meter.mjs';
import { bridgeArgsWithoutWords, hashedWords, withoutWords } from './destructive-operations.mjs';
import { RESULT } from './result-values.mjs';
export { headlessDebug } from './debug-runtime.mjs';

const run = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The ODC data root: this folder, or hosted the customer's <ws>/odc. a7 (review M1/B2): exported for the handlers of mcp.mjs
// that take a data root (studio_reference_snapshot, studio_publish), read at call time inside the call's context.
export const dataPath = (...segments) => (usesWorkspace(root, root) ? workspacePath('odc', ...segments) : path.join(root, ...segments));
export const paths = {
  client: bridgeClientPath(),
  builder: path.join(root, 'studio', 'builder', 'bin', 'Release', 'net10.0', 'ODC3.Builder.dll'),
  bridgeBin: path.join(root, 'studio', 'bridge', 'bin', 'Release', 'net8.0'),
  get tenants() { return dataPath('tenants.json'); },
  get catalog() { return dataPath('snapshots', 'modules.json'); },
  get journal() { return dataPath('journal', 'operations.jsonl'); },
  portalRuntime: path.join(root, 'portal', 'runtime'),
};

// PowerShell's Set-Content writes UTF-8 with a BOM; JSON.parse rejects it (found by WS3 on snapshots\modules.json).
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
// A missing build is never something the session runs: the answer names the component and the tool that reports it.
const notBuilt = (what, file) => what + ' is not built (' + file + '): the integrator or the user builds it; ssam_doctor {lane:"odc"} reports the state.';
// The API Client is stored through the private Windows prompt that the odc_* tools open themselves.
const apiClientPrompt = host => 'odc_read {tenant:"' + host + '", auth:"api-client"} opens the private Windows prompt to store it (the user types there, never in chat), then repeat';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// The same backoff as studio-connect.mjs pollWithBackoff (kept local: this module must not load the O11 lane table).
// First check at once; then 250 ms doubling to 2 s, until `check` is truthy or the deadline passes.
export async function pollWithBackoff(check, { deadlineMs = 15000, initialMs = 250, maxMs = 2000, sleep = delay, now = Date.now } = {}) {
  const deadline = now() + deadlineMs;
  for (let wait = initialMs; ; wait = Math.min(maxMs, wait * 2)) {
    const value = await check();
    if (value) return value;
    const left = deadline - now();
    if (left <= 0) return null;
    await sleep(Math.min(wait, left));
  }
}
function urlConfig() { try { return tenants(); } catch { return { tenants: {} }; } }

// ---- journal, same JSONL shape the bridge and builder write
export function journal(entry) {
  const end = new Date().toISOString();
  // Reads name the capture they read (file, sourceSha256); a line without its own start keeps the end as start.
  const line = { ts_start: entry.start ?? end, ts_end: end, session: (entry.session ?? 'facade') + '-' + process.pid, tool: entry.tool, command: entry.command,
    module: entry.module ?? null, module_key: null, base_sha256: null, candidate_sha256: null, studio_pid: null, attempt: null,
    outcome: entry.outcome, gate: entry.gate ?? 'none', evidence_dir: entry.evidence ?? null, note: entry.note ?? null, source: 'live', feature: entry.feature ?? null,
    ...(entry.file ? { file: entry.file } : {}), ...(entry.sourceSha256 ? { source_sha256: entry.sourceSha256 } : {}), ...(entry.failed ? { failed: entry.failed } : {}) };
  try { fs.mkdirSync(path.dirname(paths.journal), { recursive: true }); fs.appendFileSync(paths.journal, JSON.stringify(line) + '\n'); } catch { /* the journal never blocks a command */ }
}

// SSAM_ODC_OFFLINE=1: no Studio process, vault entry or prompt is ever touched (tests and dry runs while the user's
// own Studio is open).
export const offline = (env = process.env) => env.SSAM_ODC_OFFLINE === '1';

// ---- Studio lane
// The ODC Studio processes, listed by the executor (studio.processes) and kept for 30 s: a delivery's steps and a
// status brief reuse one listing. A pipe that no longer exists drops the listing (studio() asks again once). One
// listing per executor: a customer's processes never answer for the owner's machine or another customer's.
const PID_TTL_MS = 30000;
const pidListings = new WeakMap(); // executor -> { at, pids }
export const forgetStudioPids = () => { pidListings.delete(currentExecutor()); };
export async function studioPids({ now = Date.now } = {}) {
  const executor = currentExecutor();
  // SSAM_ODC_OFFLINE keeps the local machine untouched; a hosted call goes to the agent, and a lost context fails.
  if (executor instanceof LocalExecutor && offline()) return [];
  const listing = pidListings.get(executor);
  if (listing && now() - listing.at < PID_TTL_MS) return listing.pids;
  // Locally only the pids are needed: the pid-only listing (paths:false), as before the seam.
  const { processes } = await executor.call('studio.processes', executor instanceof LocalExecutor ? { image: 'ODCStudio.exe', paths: false } : { image: 'ODCStudio.exe' });
  const pids = (processes ?? []).map(p => Number(p.pid));
  pidListings.set(executor, { at: now(), pids });
  return pids;
}
export async function studioPid(explicit) {
  if (explicit) return Number(explicit);
  const pids = await studioPids();
  if (pids.length === 0) throw new Error('ODC Studio is not running.');
  if (pids.length > 1) throw new Error('Several ODC Studio processes are running (' + pids.join(', ') + '); pass the pid.');
  return pids[0];
}
export function newestBridgeDll() {
  const signed = signedRuntime(root);
  if (signed) return { path: signed.bridge, version: signed.version };
  if (!fs.existsSync(paths.bridgeBin)) return null;
  // Match the declared client protocol. Old/experimental loaded DLLs remain evidence, never a fallback.
  const source = fs.readFileSync(path.join(root, 'studio', 'bridge', 'client', 'Program.cs'), 'utf8');
  const version = source.match(/const string Version = "(v\d+)"/)?.[1];
  if (!version) return null;
  const file = path.join(paths.bridgeBin, 'ODC3.Bridge.' + version + '.dll');
  return fs.existsSync(file) ? { path: file, version } : null;
}
// One bridge command. The bridge itself journals every command; the client only relays JSON. Every command but
// attach is the odc.pipe call of the executor: locally straight to the bridge pipe from this process (odc-pipe.mjs),
// or the .NET client when SSAM_ODC_PIPE=0 or no bridge is built (version null); hosted, the agent's pipe with the
// server's bridge version (the package must carry the same). attach is odc.attach. call: a fake pipe (tests).
// pipe {connectMs} (studio_status, C10): a short connect window; it travels as the connectMs of odc.pipe.
// query-test always takes the versioned pipe: its test values can be private, so they never go on a child-process command
// line (the .NET client); without a versioned bridge nothing is sent.
// CX15 r5 (N-2): the one point every bridge command crosses: the owner's words of a line (the authorize command's text,
// --authorize <words>) go as one sha256:<hex> token (the bridge only requires a nonempty value: StartupHook.cs Authorize,
// :402, :1410; AppCreationCommands.cs:121; DataCommands.cs:79). version: the bridge protocol (tests; else the runtime's).
export const bridgeVersion = () => signedRuntime(root)?.version ?? newestBridgeDll()?.version ?? null;
export async function client(pid, args, { env = process.env, call, pipe, version: pinned } = {}) {
  args = bridgeArgsWithoutWords(args);
  const executor = currentExecutor();
  if (args[0] === 'attach') return executor.call('odc.attach', executor.hosted ? { pid } : { pid, dll: args[1] });
  const version = executor.hosted || env.SSAM_ODC_PIPE !== '0' || args[0] === 'query-test' ? (pinned ?? bridgeVersion()) : null;
  if (args[0] === 'query-test' && !version) throw Object.assign(new Error('Query testing requires the versioned ODC bridge pipe; no command was sent.'), { code: 'QUERY_TEST_NATIVE_UNAVAILABLE', sent: false });
  const connectMs = Number.isInteger(pipe?.connectMs) && pipe.connectMs > 0 ? pipe.connectMs : null;
  const text = String(call && version ? await (pipe ? call(pid, version, args, pipe) : call(pid, version, args))
    : (await executor.call('odc.pipe', { pid, version, args, ...(connectMs ? { connectMs } : {}) })).line).trim();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
// A new capture gets its module index in the background (module-map.mjs); the answer never waits for it or changes.
const warmIndex = file => import('./module-map.mjs').then(m => m.prefetchIndex(file, 'odc')).catch(() => {});
// Commands whose first argument is a module open in the Studio (reference-snapshot carries it in its JSON). The name a
// person sees ("QuizLive Web", the app) is resolved to the open module before anything is sent (studio-module.mjs); a
// name that is no open module, or several, is refused with the open modules and nothing reaches the bridge. One status
// read per command: the open modules are the Studio's own answer, never a cache.
const OPEN_MODULE_COMMANDS = new Set(['snapshot', 'reference-producers', 'close', 'refresh-references', 'data', 'data-insert', 'data-update', 'data-delete', 'module-info']);
const readCatalogFile = () => { try { return readJson(paths.catalog); } catch { return null; } };
export async function resolveModuleArgs(pid, args, { call = client, catalog = readCatalogFile } = {}) {
  const json = args[0] === 'reference-snapshot';
  if (!(json || OPEN_MODULE_COMMANDS.has(args[0])) || typeof args[1] !== 'string') return { args };
  let request = null;
  if (json) { try { request = JSON.parse(args[1]); } catch { return { args }; } if (typeof request?.module !== 'string') return { args }; }
  const requested = json ? request.module : args[1];
  const status = await call(pid, ['status', 'modules']);
  // A bridge that does not answer the field keeps the old path: the bridge itself refuses an unknown module.
  if (!Array.isArray(status?.value)) return { args };
  const resolved = resolveOpenModule(requested, { open: status.value.map(m => ({ name: m?.name, key: m?.key })), catalog: catalog() });
  // Closing a module that is not open is the bridge's own answer (nothing to close), never "open it first".
  if (!resolved.ok && resolved.code === 'MODULE_NOT_OPEN' && args[0] === 'close') return { args };
  if (!resolved.ok) return { refusal: resolved };
  if (resolved.via === 'exact') return { args };
  return { args: json ? [args[0], JSON.stringify({ ...request, module: resolved.module })] : [args[0], resolved.module, ...args.slice(2)], requested };
}
// The bridge command each Studio is running for this process, while it runs (C10): studio_status answers from it and from
// the evidence of that delivery when the bridge pipe is busy, instead of waiting for the pipe. Hosted, one registry per
// executor (a cache of machine facts, docs/FASE2-AGENTE.md 4.1): two customers' Studios may have the same pid, and one
// customer never sees the command or the manifest of another.
export const inFlight = new Map();
const hostedFlights = new WeakMap();
export function flightRegistry(executor = currentExecutor()) {
  if (!executor?.hosted) return inFlight;
  let registry = hostedFlights.get(executor);
  if (!registry) hostedFlights.set(executor, registry = new Map());
  return registry;
}
const UNTRACKED = new Set(['status', 'publish-log', 'auth-status', 'dismiss-dialog']);
export async function studio(args, pid, { prefetch = true, connectMs } = {}) {
  // CX15 r5 (N-2): hashed before anything keeps the line (inFlight, which studio_status shows while the bridge is busy).
  args = bridgeArgsWithoutWords(args);
  let targetPid = await studioPid(pid);
  let value, refused = null, requested = null;
  const flights = flightRegistry();
  const send = async target => {
    const resolved = await resolveModuleArgs(target, args);
    if (resolved.refusal) return (refused = resolved.refusal);
    requested = resolved.requested ?? null;
    const token = UNTRACKED.has(args[0]) || flights.has(target) ? null : { command: args[0], since: new Date().toISOString(), args: resolved.args.map(String) };
    if (token) flights.set(target, token);
    try { return await client(target, resolved.args, connectMs ? { pipe: { connectMs } } : {}); }
    finally { if (token && flights.get(target) === token) flights.delete(target); }
  };
  try { value = await send(targetPid); }
  catch (error) {
    // A listed Studio whose bridge pipe is gone (closed, restarted): list again once; nothing was sent to it. The same
    // pid again means that Studio has no bridge: the refusal stands, without a second wait.
    if (pid || error?.code !== 'BRIDGE_NOT_ATTACHED' || error?.sent !== false) throw error;
    forgetStudioPids();
    const fresh = await studioPid();
    if (fresh === targetPid) throw error;
    targetPid = fresh;
    value = await send(targetPid);
  }
  if (refused) return refused;
  // The answer says which open module the name reached.
  if (requested && value && typeof value === 'object' && !Array.isArray(value)) value = { ...value, requestedModule: requested };
  if (prefetch && ['snapshot', 'latest'].includes(args[0]) && value?.ok === true && typeof value.path === 'string') warmIndex(value.path);
  // C04 (hosted): the tenant a capture names gets its Development stage before the links of this answer are built.
  if (['snapshot', 'latest', 'auth-status'].includes(args[0]) && value?.ok !== false && hostedContext()) {
    const hosts = args[0] === 'auth-status' ? (Array.isArray(value?.sessions) ? value.sessions.filter(s => s?.loggedIn !== false).map(s => s.host) : []) : [value?.host];
    try { recordConnectedTenants(hosts); } catch { /* the links only */ }
  }
  let context = { app: value?.module, host: value?.host ?? value?.tenant };
  if (['check-base', 'preview', 'merge', 'publish', 'publish-status', 'create'].includes(args[0])) {
    try { const manifest = readJson(path.resolve(dataPath(), args[1])); context = { app: manifest.module, host: manifest.tenant }; } catch { /* URL metadata cannot change the delivery outcome. */ }
  }
  const config = urlConfig();
  if (args[0] === 'status' && (!args[1] || args[1] === 'brief')) {
    // Full status carries each module's own host. Brief status intentionally omits it.
    const full = args[1] === 'brief' ? await client(targetPid, ['status']).catch(() => null) : value;
    const modules = (full?.modules ?? []).map(m => ({ module: m.name,
      ...withAppLinks({}, { app: m.name, host: m.loggedIn === true ? m.host : null }, config) }));
    return { ...value, applicationUrls: { ...appUrlCapability, modules } };
  }
  return withAppLinks(value, context, config);
}
// studio_status (C10). The bridge serves one command at a time, so while a merge or a publication runs its pipe is busy and
// a status would wait for it. The status tries the pipe for a moment only; busy, it answers at once from the command this
// process sent (inFlight) and from the evidence of the delivery in flight: its stage (deliver-progress.json), the merge
// start (merge-started.json) and the result when it is there (deliver-result.json). Nothing is repeated or waited for.
export const STATUS_CONNECT_MS = 2000;
export async function studioStatus({ view = 'brief', pid } = {}, { call = studio, evidence = busyEvidence } = {}) {
  try { return await call(view === 'full' ? ['status'] : ['status', view], pid, { connectMs: STATUS_CONNECT_MS }); }
  catch (error) {
    if (error?.code !== 'BRIDGE_BUSY') throw error;
    return evidence({ pid, error });
  }
}
const readJsonOrNull = file => { try { return readJson(file); } catch { return null; } };
// Hosted, the registry and the lab folder are the customer's (flightRegistry, <ws>/odc/lab).
export function busyEvidence({ pid, error, registry = flightRegistry(), lab = dataPath('lab') } = {}) {
  const entries = [...registry.entries()];
  const own = pid ? entries.find(([target]) => target === Number(pid)) : entries.length === 1 ? entries[0] : null;
  const sent = own?.[1] ?? null;
  // The delivery in flight: the manifest the command names, else the newest lab directory with a stage and no result yet.
  let labDir = null;
  const manifest = sent?.args?.find(a => /manifest\.json$/i.test(a)) ?? null;
  if (manifest) labDir = path.dirname(path.dirname(path.resolve(manifest)));
  if (!labDir) {
    try {
      labDir = fs.readdirSync(lab, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(lab, e.name))
        .filter(d => fs.existsSync(path.join(d, 'deliver-progress.json')) && !fs.existsSync(path.join(d, 'deliver-result.json')))
        .map(d => ({ d, at: fs.statSync(path.join(d, 'deliver-progress.json')).mtimeMs })).sort((a, b) => b.at - a.at)[0]?.d ?? null;
    } catch { labDir = null; }
  }
  const progress = labDir ? readJsonOrNull(path.join(labDir, 'deliver-progress.json')) : null;
  const manifestFile = manifest ?? progress?.manifest ?? (labDir ? path.join(labDir, 'delivery', 'manifest.json') : null);
  const evidenceDir = manifestFile ? (readJsonOrNull(manifestFile)?.evidenceDir ?? path.join(path.dirname(manifestFile), 'evidence')) : null;
  const mergeStarted = evidenceDir ? readJsonOrNull(path.join(evidenceDir, 'merge-started.json')) : null;
  const result = labDir ? readJsonOrNull(path.join(labDir, 'deliver-result.json')) : null;
  const command = sent?.command ?? progress?.stage ?? null;
  const since = sent?.since ?? progress?.since ?? null;
  return { ok: true, fromEvidence: true, busy: { command, since }, ...(pid ? { pid: Number(pid) } : {}),
    ...(labDir ? { delivery: { evidence: labDir, stage: progress?.stage ?? null, ...(mergeStarted ? { mergeStarted } : {}),
      ...(result ? { result: { ok: result.ok, merged: result.merged, failed: result.failed ?? null, outcome: result.outcome ?? null, code: result.code ?? null } } : {}) } } : {}),
    note: 'The ODC bridge is running ' + (command ?? 'a command') + (since ? ' since ' + since : '') + ': this status comes from its evidence, without waiting for the pipe. The call that started it answers when it ends; never repeat a write meanwhile.',
    ...(error?.message ? { pipe: withoutStackText(error.message) } : {}) };
}
const withoutStackText = text => String(text).split(/\r?\n/)[0];
// Data lane through the bridge: the Studio's own data service (View data / Edit data) on the development
// database. Records travel in a file under journal\data\requests so JSON never crosses the pipe as words.
export function recordsFile(records) {
  const dir = dataPath('journal', 'data', 'requests'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.json');
  fs.writeFileSync(file, JSON.stringify(records, null, 2)); return file;
}
// CX15 r4 (W-2): a write (insert, update, delete) sends the bridge 'sha256:<hex>' of the owner's words, never the words
// (the bridge only requires a nonempty --authorize, DataCommands.cs, and keeps it in journal\data and in its report), and
// the answer drops what the bridge repeats (authorization). deps.studio: the bridge call (tests pass a fake pipe).
export async function studioData({ op, module, entity, records, ids, fields, limit, offset, out, authorize, pid }, { studio: call = studio } = {}) {
  const args = [op === 'read' ? 'data' : 'data-' + op, module, entity];
  if (op === 'read') {
    if (limit != null) args.push('--limit', String(limit)); if (offset != null) args.push('--offset', String(offset));
    if (fields?.length) args.push('--fields', fields.join(',')); if (out) args.push('--out', out);
    return call(args, pid);
  }
  if (op === 'delete') { if (!ids?.length) throw new Error('ids are required.'); args.push('--ids', ids.map(String).join(',')); }
  else { if (!Array.isArray(records) || records.length === 0) throw new Error('records must be a non-empty array of objects.'); args.push('--records-file', recordsFile(records)); }
  if (!authorize) throw new Error("authorize is required: the user's own words.");
  args.push('--authorize', hashedWords(authorize));
  return withoutWords(await call(args, pid));
}
// After the startup hook, readiness is the bridge's own answer, not a fixed 1.5 s sleep: the client waits for the
// bridge pipe itself (NamedPipeClientStream.ConnectAsync, 10 s), so the first `status brief` normally answers as soon
// as the pipe exists. A status that is not ok yet is asked again with backoff (250 ms -> 2 s, 15 s at most); a refused
// attach gets one status, without waiting. deps: tests pass fakes of the client (never a Studio). Hosted, the agent
// attaches the bridge of its own package: no DLL of this server is named or sent.
export async function attach(pid, { call = client, findPid = studioPid, dll: found, sleep = delay, now = Date.now } = {}) {
  const target = await findPid(pid);
  const hosted = currentExecutor().hosted;
  const dll = hosted ? null : found === undefined ? newestBridgeDll() : found;
  if (!hosted && !dll) throw new Error(notBuilt('The bridge DLL', paths.bridgeBin));
  const result = await call(target, hosted ? ['attach'] : ['attach', dll.path]);
  let status = null;
  await pollWithBackoff(async () => {
    status = await call(target, ['status', 'brief']).catch(error => ({ error: error.message }));
    return status?.ok === true || result?.ok !== true;
  }, { deadlineMs: 15000, sleep, now });
  return { ...result, pid: target, ...(dll ? { dll: dll.path, version: dll.version } : {}), status };
}
// O DLL do builder e compilado a mao e chamado daqui. Quando alguem muda studio\**\*.cs e nao recompila, este
// processo corre o codigo VELHO e nada o denuncia -- na sessao de 17/09 isso aparece como 190 minutos, com o
// agravante de o ultimo comando da sessao, tres horas DEPOIS de o problema estar diagnosticado, ainda correr a
// DLL velha porque `dotnet build ; dotnet run` encadeados nao garantem nada quando o build falha.
// Compara-se o .cs mais novo com o DLL e recompila-se; melhor perder cinco segundos do que devolver uma resposta
// de uma versao que ja nao existe.
let avisadoDeCompilacao = false;
export function builderNeedsBuild({ file = paths.builder, sourceRoot, linkedSources,
  project = path.join(root,'studio','builder','Builder.csproj') } = {}) {
  try {
    if (!fs.existsSync(file)) return true;
    const dll = fs.statSync(file).mtimeMs;
    let maisNova = 0;
    const andar = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'bin' || e.name === 'obj' || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) andar(p);
        else if (/\.(cs|csproj)$/i.test(e.name)) maisNova = Math.max(maisNova, fs.statSync(p).mtimeMs);
      }
    };
    // Only actual Compile inputs matter. An unrelated bridge edit used to trigger a
    // no-op builder build on EVERY read because the builder DLL correctly stayed unchanged.
    let sources = linkedSources ?? [];
    if (sourceRoot) andar(sourceRoot);
    else {
      sources = [project, ...[...fs.readFileSync(project,'utf8').matchAll(/<Compile\s+Include="([^"]+)"/g)].flatMap(([,include]) => {
        const source = path.resolve(path.dirname(project),include.replaceAll('\\',path.sep));
        if (!source.includes('*')) return [source];
        if (path.basename(source) !== '*.cs') throw new Error('Unsupported source glob: '+include);
        return fs.readdirSync(path.dirname(source)).filter(n=>n.endsWith('.cs')).map(n=>path.join(path.dirname(source),n));
      }), ...sources];
    }
    for (const source of sources) {
      if (!fs.existsSync(source)) return true;
      maisNova = Math.max(maisNova, fs.statSync(source).mtimeMs);
    }
    return maisNova > dll;
  } catch { return true; } // Do not silently run an old binary when source freshness cannot be checked.
}
// needsBuild: the freshness check (tests pass a stale one).
export async function ensureBuilder({ needsBuild = builderNeedsBuild } = {}) {
  // Hosted (executor.mjs) nothing is ever compiled: a stale builder is the server owner's to rebuild.
  if (hostedContext() && needsBuild()) return { ok: false, output: [], code: 'COMPONENT_STALE',
    error: 'The headless builder of this SSAM server is older than its sources (or not built); the server owner rebuilds it. Nothing ran.',
    continuation: { tool: 'ssam_doctor', arguments: {}, why: 'report this to the server owner; do not retry in a loop' } };
  if (needsBuild()) {
    const build = await run('dotnet', ['build', path.join(root, 'studio', 'builder', 'Builder.csproj'), '-c', 'Release', '-v', 'q', '--nologo'],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).then(() => ({ ok: true })).catch(e => ({ ok: false, saida: (e.stdout ?? '') + (e.stderr ?? e.message) }));
    if (!build.ok) return { ok: false, output: [], error: 'the builder is out of date and its rebuild FAILED -- fix it before going on, because running like this would use old code:\n' + String(build.saida).split(/\r?\n/).filter(l => /error/i.test(l)).slice(0, 8).join('\n') };
    if (!avisadoDeCompilacao) { avisadoDeCompilacao = true; process.stderr.write('[ssam] the sources of the builder or of the shared reader need a rebuild: build run before running.\n'); }
  }
  if (!fs.existsSync(paths.builder)) throw new Error(notBuilt('The builder', paths.builder));
  return {ok:true};
}
// The ODC Studio runtime the builder and its resident reader load, with the rule of the kernel (StudioAssembliesOdc)
// and of ODC3.Builder (Program.StudioDirectory): ANVIL_ODC_STUDIO_DIR when set, refused here as there when it is not an
// absolute ODC Studio folder, never replaced by the installation; unset, the installed ODC Studio, as before.
export function odcStudioDir(env = process.env) {
  const configured = env.ANVIL_ODC_STUDIO_DIR;
  if (configured == null) return path.join(env.ProgramFiles ?? 'C:\\Program Files', 'OutSystems', 'ODC Studio', 'ODC Studio');
  if (!configured.trim() || !path.isAbsolute(configured)
    || !['OutSystems.ModelAPILoader.dll', 'OutSystems.Model.dll'].every(name => fs.existsSync(path.join(configured, name))))
    throw new Error('not an ODC Studio directory: ' + configured + ' (ANVIL_ODC_STUDIO_DIR)');
  return configured;
}
export async function builder(args) {
  const ready = await ensureBuilder(); if (!ready.ok) return ready;
  // Hosted: the closed environment of the customer's workspace; SSAM_HYBRID_ODC_ROOT=<ws>/odc points the builder at the
  // customer's catalog, tenants.json and journal (studio/builder/Program.cs).
  const hosted = hostedContext() ? hostedSpawnEnv('odc') : null;
  const result = await run('dotnet', [paths.builder, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(hosted ? { env: hosted.env, cwd: hosted.cwd } : {}) })
    .then(r => ({ ...r, exitCode: 0 })).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? error.message, exitCode: error.code ?? 1 }));
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const manifest = lines.find(l => /manifest\.json$/i.test(l));
  const ok = result.exitCode === 0;
  if (ok) return { ok, ...(manifest ? { manifest } : {}), output: lines };
  // A primeira linha do stderr e a causa (Program.cs escreve-a la de proposito); a segunda, quando existe, e a
  // frame dentro de studio\. O `stack` cortado vem junto porque a alternativa medida foi o agente reexecutar o
  // DLL a mao so para o ver -- tres chamadas extra, duas vezes na mesma sessao.
  const linhasErro = result.stderr.trim().split(/\r?\n/).filter(Boolean);
  return { ok, output: lines, error: linhasErro[0] ?? 'builder failed',
    ...(linhasErro.length > 1 ? { frame: linhasErro[1] } : {}),
    stack: linhasErro.slice(0, 40).join('\n') };
}
// One command for the delivery cycle: snapshot, build, check-base, preview, merge, with one receipt and a timing per
// step. A refusal stops the chain and comes back as is; `until` stops earlier (snapshot, build, check-base, preview).
// The evidence directory is the next free lab\NN-<feature>; nothing is ever overwritten. Publish stays separate.
const DELIVER_STEPS = ['snapshot', 'build', 'check-base', 'preview', 'merge'];
export function nextLabDir(feature) {
  const lab = dataPath('lab'); fs.mkdirSync(lab, { recursive: true });
  const numbers = fs.readdirSync(lab).map(n => /^(\d+)-/.exec(n)).filter(Boolean).map(m => Number(m[1]));
  const next = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(2, '0');
  return path.join(lab, next + '-' + feature.replace(/[^A-Za-z0-9-]+/g, '-'));
}
async function featureModule(feature) {
  const list = await builder(['list']);
  const line = (list.output ?? []).find(l => l.trim().startsWith(feature + ' ') || l.trim().startsWith(feature + '\t'));
  if (!line) throw new Error('Unknown feature ' + feature + ': not in the builder feature list (studio/builder/features).');
  return line.trim().split(/\s{2,}|\t/)[1];
}
// C02 item 2: the manifest is prepared by the resident builder (builder-resident.mjs: one process per generation of the
// builder binaries, the Model API configured once, the JIT warm) when it can serve; else by a cold builder process, as
// before. ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER keeps it cold (tests, isolated builds). deps (tests): resident, builder.
const residentBuilder = async (args, env = process.env) => {
  const { workerDisabled } = await import('./anvil-worker.mjs');
  if (workerDisabled('odc', env)) return { used: false, note: 'resident builder disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
  const ready = await ensureBuilder(); if (!ready.ok) return { used: true, value: ready };
  const { readerConfig } = await import('./module-map.mjs');
  const { residentManifest } = await import('./builder-resident.mjs');
  return residentManifest(args, { ...readerConfig('odc', { env }), root: dataPath() });
};
// The warm-up of the ODC delivery processes (servidor/fase4): the resident builder of this generation and the lane's
// resident ODC worker (kernel apply, check-job, create-app), each only when it can serve (built, not disabled). Never
// throws; -> {builder, worker}, each {ok, note?}.
export async function warmDeliveryProcesses({ env = process.env } = {}) {
  const out = {};
  try {
    const { workerDisabled, createWorkerClient } = await import('./anvil-worker.mjs');
    if (workerDisabled('odc', env)) out.worker = out.builder = { ok: false, note: 'disabled (ANVIL_WORKER=0 or ANVIL_ODC_NO_WORKER)' };
    else {
      // A warm-up never compiles: a stale builder is the owner's to rebuild (scripts\servidor.ps1 builds before the start).
      if (builderNeedsBuild()) out.builder = { ok: false, note: 'the ODC builder is not built or older than its sources' };
      else {
        const { readerConfig } = await import('./module-map.mjs');
        const { warmResidentBuilder } = await import('./builder-resident.mjs');
        out.builder = await warmResidentBuilder(readerConfig('odc', { env }));
      }
      const state = await createWorkerClient('odc', { env }).ensure().catch(error => ({ note: error.message }));
      out.worker = state?.status ? { ok: true } : { ok: false, note: state?.note ?? 'no ODC worker' };
    }
  } catch (error) { out.error = String(error?.message ?? error).split(/\r?\n/)[0]; }
  return out;
}
// After a hosted delivery or app creation (servidor/fase4): the delivery processes are warmed again in the background (a
// resident builder idle for 15 minutes exits), at most once a minute. Never awaited, never changes an answer; locally the
// owner's own warm-up (ssam warm) applies.
let lastWarm = 0;
export function warmSoon({ now = Date.now, warm = warmDeliveryProcesses, env = process.env } = {}) {
  if (!hostedContext() || env.SSAM_NO_WARM === '1' || now() - lastWarm < 60000) return false;
  lastWarm = now();
  setImmediate(() => { Promise.resolve().then(() => warm({ env })).catch(() => {}); });
  return true;
}
export async function prepareManifest({ base, candidate, output, feature, owners, changes }, deps = {}) {
  for (const [name, value] of Object.entries({ base, candidate, output, feature }))
    if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required.');
  for (const [name, list] of Object.entries({ owners, changes }))
    if (!Array.isArray(list) || !list.length || list.some(s => typeof s !== 'string' || !s.trim())) throw new Error(name + ' must be a non-empty array of strings.');
  // Hosted, the paths and the builder root (its journal) are the customer's <ws>/odc (dataPath); the resident builder takes
  // the root with each request (ManifestServer.cs), so one resident process serves every customer without sharing a folder.
  const data = dataPath();
  const args = ['--base', path.resolve(data, base), '--candidate', path.resolve(data, candidate),
    '--output', path.resolve(data, output), '--feature', feature, '--owners', JSON.stringify(owners), '--changes', JSON.stringify(changes)];
  const resident = deps.resident !== undefined ? deps.resident : residentBuilder;
  // Quality (docs/QUALIDADE.md): the manifest builder is a kernel leaf, resident or cold (a miss of the resident one and its
  // cold run are one span); a no-op outside a hosted call.
  const end = kernelStart({ lane: 'odc', via: 'cold' });
  let via = 'cold', ok = false;
  try {
    if (resident) {
      let served = null;
      try { served = await resident(args); } catch { served = null; }
      if (served?.used) { via = 'resident'; ok = served.value?.ok !== false; return served.value; }
    }
    const built = await (deps.builder ?? builder)(['manifest', ...args]);
    ok = built?.ok === true;
    return built;
  } finally { end({ via, ok }); }
}
// C04: a delivery whose job has html ops gets preview.html in its evidence: the same markup the kernel turned into widgets,
// with the job's own CSS (preview/fragment.mjs), to open in a browser; hosted, the page also goes to the agent's copy of
// the evidence folder and the answer names the file on the user's machine. Never changes the delivery: a failure here
// only leaves the field out.
export async function withFragmentPreview(report) {
  try {
    if (!report || typeof report !== 'object' || typeof report.evidence !== 'string' || typeof report.job !== 'string') return report;
    const { renderFragmentPreview } = await import('./preview/fragment.mjs');
    const rendered = await renderFragmentPreview({ job: report.job, root });
    if (!rendered.ok) return report;
    const file = path.join(report.evidence, 'preview.html');
    fs.writeFileSync(file, rendered.html);
    const preview = { file, fragments: rendered.fragments.length, structural: true };
    const executor = currentExecutor();
    if (executor.hosted && executor.mirror) {
      const where = executor.mirror.classify(file);
      if (where.writable) {
        await executor.mirror.put(file, executor.mirror.agentOf(where.rel));
        let agentRoot = null;
        try { agentRoot = executor.link?.info?.()?.agentRoot ?? null; } catch { agentRoot = null; }
        if (agentRoot) preview.onUserMachine = path.win32.join(agentRoot, ...where.rel.split('/'));
      }
    }
    return { ...report, preview };
  } catch { return report; }
}// A Studio step that throws (the pipe dropped, the bridge died) has an unknown result. Before the merge nothing was
// changed, so it is a plain failure; during the merge it may have been applied, so it is `uncertain` and the answer
// says to reconcile by receipt and journal instead of retrying (the job path already did this: kernel-delivery.mjs).
export async function guardDeliveryStep(step, fn) {
  try { return await fn(); }
  catch (error) {
    return step === 'merge'
      ? { ok: false, outcome: 'uncertain', error: 'Merge result unknown (' + error.message + '): read the receipts and the journal before any new attempt; never retry an uncertain merge.' }
      : { ok: false, error: step + ' did not complete (' + error.message + '); nothing was merged.' };
  }
}
// publish (C08): after a clean merge (merged and strictlyEqual) the same call records the words (authorize, or a standing
// grant of the app when absent) and publishes with --wait; any other merge outcome skips it. deps: tests pass fakes.
export async function deliver({ feature, module, until = 'merge', pid, producer, producers, tenant, job, owners, changes, output: jobOutput, publish = false, authorize }, deps = {}) {
  const { studio: studioCall = studio, builder: builderCall = builder, grants, onStage } = deps;
  if (job) {
    if (producer || tenant) throw new Error('Kernel delivery takes identity from the snapshot; producer/tenant overrides are not supported.');
    // Hosted, the kernel delivery's data root is the customer's <ws>/odc (dataPath), never the code root.
    // fix/unpublished-library round 2 (A2): the ODC Studio processes, so a producer open in another Studio than the one the
    // call names (pid) is found there (its publication goes to that pid); only read when the call names a pid. Hosted,
    // studioPids asks the customer's agent (the executor), never the processes of this server.
    const report = await deliverKernel({ feature, module, until, pid, job, owners, changes, output: jobOutput, publish, authorize, ...(producers !== undefined ? { producers } : {}) },
      { root: dataPath(), studio: studioCall, prepareManifest, nextLabDir, journal, otherPids: () => studioPids(), ...(grants !== undefined ? { grants } : {}), ...(onStage ? { onStage } : {}), ...(deps.kernel ?? {}) });
    warmSoon();
    return (deps.fragmentPreview ?? withFragmentPreview)(report);
  }
  if (jobOutput || owners || changes || producers) throw new Error('output, owners, changes and producers require a job; C# features declare their own metadata.');
  if (!feature) throw new Error('feature is required.');
  if (!DELIVER_STEPS.includes(until)) throw new Error('until must be one of ' + DELIVER_STEPS.join(', '));
  if (publish === true && until !== 'merge') throw new Error('publish requires until "merge": the publication follows a clean merge in the same call.');
  const startedAt = Date.now(); const steps = [];
  const timed = async (step, fn) => {
    try { onStage?.(step); } catch { /* a notification never changes the delivery */ }
    const t = Date.now(); const r = await fn();
    steps.push({ step, seconds: Math.round((Date.now() - t) / 100) / 10, ok: r.ok !== false, ...(r.gate ? { gate: r.gate } : {}), ...(r.outcome ? { outcome: r.outcome } : {}) });
    return r;
  };
  let urlHost;
  const done = (ok, extra) => withAppLinks({ ok, feature, module, until, steps, totalSeconds: Math.round((Date.now() - startedAt) / 100) / 10, ...extra }, { app: module, host: urlHost }, urlConfig());
  if (!module) module = await featureModule(feature);
  // Always a fresh capture of the open module (the base of the build is the module as it is now in the Studio).
  const snapshot = await timed('snapshot', () => studioCall(['snapshot', module], pid));
  urlHost = snapshot.host;
  if (!snapshot.ok) return done(false, { failed: 'snapshot', error: snapshot.error ?? JSON.stringify(snapshot),
    ...(snapshot.code ? { code: snapshot.code } : {}), ...(snapshot.openModules ? { openModules: snapshot.openModules } : {}),
    ...(snapshot.candidates ? { candidates: snapshot.candidates } : {}), ...(snapshot.continuation ? { continuation: snapshot.continuation } : {}) });
  const requestedModule = typeof snapshot.module === 'string' && snapshot.module && snapshot.module !== module ? module : null;
  if (requestedModule) module = snapshot.module;
  if (until === 'snapshot') return done(true, { snapshot: snapshot.path, sha256: snapshot.sha256 });
  // The words of the publication, before anything is built: the request's, else a standing grant of the app.
  let authorization = null;
  if (publish === true) {
    authorization = await publishAuthorization({ authorize, module, requested: requestedModule }, grants !== undefined ? grants : await import('./standing-grants.mjs').catch(() => null));
    if (authorization?.refused) return done(false, { failed: 'preflight', ...authorization.refused, publish: { requested: true, outcome: 'skipped' } }); // CX15 r6 (M-1)
    if (!authorization) return done(false, { failed: 'preflight', code: 'PUBLISH_AUTHORIZATION_REQUIRED', publish: { requested: true, outcome: 'skipped' },
      error: 'publish:true needs the user\'s own words in authorize, or a standing grant for ' + module + '; nothing was built or merged.' });
  }
  const output = nextLabDir(feature);
  const built = await timed('build', () => builderCall([feature, snapshot.path, snapshot.sha256, output, ...(producer ? ['--producer', producer] : []), ...(tenant ? ['--tenant', tenant] : [])]));
  if (!built.ok) return done(false, { failed: 'build', code: 'BUILD_REFUSED', error: withoutStack(built.error), output: built.output, ...(built.frame ? { frame: built.frame } : {}), evidence: output,
    ...(publish === true ? { publish: { requested: true, outcome: 'skipped' } } : {}) });
  const manifest = path.join(output, 'manifest.json');
  let checks = null, receipt = null;
  try { checks = readJson(path.join(output, 'feature-checks.json')); } catch { /* informative only */ }
  try { const r = readJson(path.join(output, 'builder-receipt.json')); receipt = { addedErrors: r.addedErrors ?? [], addedWarnings: r.addedWarnings ?? [], elapsedMs: r.elapsedMs }; } catch { /* informative only */ }
  if (until === 'build') return done(true, { manifest, checks, receipt });
  // until=merge goes straight to the merge, which proves the base and the preview's conditions itself (C17).
  for (const step of studioSteps(until)) {
    const r = withMergeCode(await timed(step, () => guardDeliveryStep(step, () => studioCall([step, manifest], pid))));
    if (!r.ok) return done(false, { failed: step, manifest, checks, receipt, gate: r.gate, outcome: r.outcome, error: withoutStack(r.error), dialogsClosed: r.dialogsClosed, evidence: output,
      ...(r.code ? { code: r.code } : step === 'merge' && r.outcome === 'uncertain' ? { code: 'MERGE_UNCERTAIN' } : {}), ...(Array.isArray(r.divergences) ? { divergences: r.divergences } : {}),
      ...(publish === true ? { publish: { requested: true, outcome: 'skipped' } } : {}) });
    if (step !== 'merge') { if (step === until) return done(true, { manifest, checks, receipt, evidence: output, [step.replace('-', '')]: r }); continue; }
    const answer = { manifest, checks, receipt, evidence: output, merge: r };
    const clean = r.merged === true && r.strictlyEqual === true;
    if (clean) answer.result = RESULT.delivered;
    if (publish !== true) return done(true, answer);
    if (!clean) return done(true, { ...answer, publish: { requested: true, outcome: 'skipped' } });
    const published = await publishDelivered({ manifest, module, words: authorization.words, pid }, { studio: studioCall });
    Object.assign(answer, { authorization: authorization.authorization, ...published });
    if (published.publish.outcome === 'published') return done(true, { ...answer, result: RESULT.deliveredAndPublished });
    return done(false, { ...answer, failed: 'publish', code: published.publish.outcome === 'uncertain' ? 'PUBLISH_UNCERTAIN' : 'PUBLISH_FAILED',
      ...(published.publish.outcome === 'uncertain' ? { outcome: 'uncertain' } : {}), error: published.publish.error ?? 'The publication did not succeed.',
      continuation: { tool: 'studio_publish', arguments: { manifest, ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'Merged; publish this manifest again after the fix the publication names. Never repeat the delivery.' } });
  }
}
// Read-only inspection: a .oml path is inspected as is; a module name is snapshotted from the open Studio first.
export async function inspect({ target, path: modelPath, depth, max, all, full, budget, pid, kind, name, text, offset, properties, usages, scope, includeInternal, select, cold = false, expectedSourceSha256 }) {
  const started = performance.now();
  let file = target;
  let snapshot = null;
  if (!/\.oml$/i.test(target)) {
    // The reader loads this capture right away; a background index build would load it a second time.
    snapshot = await studio(['snapshot', target], pid, { prefetch: false });
    if (!snapshot.ok) return snapshot;
    file = snapshot.path;
  }
  const snapshotMs = performance.now() - started;
  const out = inspectOutPath(file, modelPath, { depth, max, all, full });
  try {
    const ready = await ensureBuilder(); if (!ready.ok) return ready;
    const options = {kind,name,text,properties,usages,scope,includeInternal,all,full};
    for (const [key,value] of Object.entries({depth,max,offset})) if (value != null) {
      if (!/^-?\d+$/.test(String(value))) throw new Error('--' + key + ' must be an integer');
      options[key] = Number(value);
    }
    if (budget != null && (!/^\d+$/.test(String(budget)) || Number(budget) < 0)) throw new Error('budget must be a non-negative integer');
    const { readerConfig } = await import('./module-map.mjs');
    const response = await readSnapshot({...readerConfig('odc'),
      request:{file:path.resolve(file),path:modelPath,select,options,cold,expectedSourceSha256}});
    const result = presentReading(response,{file,out,budget:budget == null ? 60000 : Number(budget)});
    result.timings = {...result.timings,snapshotMs,totalMs:performance.now()-started};
    if (snapshot) result.snapshotSha256 = snapshot.sha256;
    journal({tool:'reader',command:'inspect',outcome:'ok',file,sourceSha256:result.sourceSha256,cache:result.cache,timings:result.timings});
    let metadata = snapshot;
    if (!metadata) {
      try { const saved = readJson(path.resolve(file) + '.json'); if (saved.sha256?.toLowerCase() === response.sourceSha256?.toLowerCase()) metadata = saved; } catch { /* standalone captures need an explicit environment */ }
    }
    return withAppLinks(result, { app: metadata?.module, host: metadata?.host }, urlConfig(), response.data);
  } catch (error) {
    journal({tool:'reader',command:'inspect',outcome:'error',file,error:error.message});
    return {ok:false,file,error:error.message};
  }
}

// O nome do ficheiro leva os PARAMETROS da consulta, nao so o alvo: com nome so de caminho, um --depth 12
// sobrescreve o --depth 2 de ha um minuto e quem relesse o ficheiro lia outra arvore sem dar por isso.
function inspectOutPath(file, modelPath, { depth, max, all, full }) {
  const limpo = s => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const nome = [limpo(path.basename(file, '.oml')), limpo(modelPath) || 'map',
    'd' + (depth ?? 3), 'm' + (max ?? 60), all ? 'all' : '', full ? 'full' : ''].filter(Boolean).join('.');
  const pasta = dataPath('journal', 'inspect');
  fs.mkdirSync(pasta, { recursive: true });
  return path.join(pasta, nome + '.' + randomUUID() + '.json');
}

// Builder arguments from named inputs (used by the MCP tool; the CLI passes raw arguments).
export function builderArgs({ feature, base, sha, output, module, producer, newModule = false, smoke = false }) {
  if (!feature || !output) throw new Error('feature and output are required.');
  const args = newModule ? ['new', feature, output] : [feature, base, sha, output];
  if (!newModule && (!base || !sha)) throw new Error('base and sha are required unless newModule is true.');
  if (module) args.push('--module', module);
  if (producer) args.push('--producer', producer);
  if (smoke) args.push('--smoke');
  return args;
}

// ---- Portal lane
let portalModules;
export async function portal() {
  if (portalModules) return portalModules;
  const load = name => import(pathToFileURL(path.join(paths.portalRuntime, name)).href);
  const [bridge, config, credential, catalog, capabilities, server, effects] = await Promise.all([
    load('bridge.mjs'), load('config.mjs'), load('api-client-credential.mjs'), load('catalog.mjs'), load('portal-capabilities.mjs'), load('server.mjs'), load('effects.mjs')]);
  return portalModules = { ...bridge, ...config, ...credential, ...catalog, ...capabilities, ...server, ...effects };
}
// tenants.json, with the tenant of this machine (.ssam-local.json, untracked) as default when that file names one.
export function tenants() { return withLocalTenant(readJson(paths.tenants), readLocalSettings()); }
// C04 (hosted): the tenants the customer's ODC Studio is signed in to (ssam_connect, auth-status) are written to the
// customer's own <ws>/odc/tenants.json, each with the Development stage the platform gives <name>.outsystems.dev
// (source "derived"), so every answer's appLinks has a link. A stage already there is never replaced, the default tenant
// stays unset (a tenant write is always confirmed), and outside a hosted call nothing is written (the owner's file is the
// owner's). -> {written: [host], kept: [host]}.
export function recordConnectedTenants(hosts) {
  if (!hostedContext()) return { written: [], kept: [] };
  let config;
  try { config = readJson(paths.tenants); } catch { config = { default: null, tenants: {} }; }
  if (!config || typeof config !== 'object') config = { default: null, tenants: {} };
  config.tenants ??= {};
  const written = [], kept = [];
  for (const host of [...new Set((hosts ?? []).filter(h => typeof h === 'string' && h).map(h => h.toLowerCase()))]) {
    const entry = config.tenants[host] ?? {};
    const stages = entry.stages ?? {};
    const origin = derivedStageOrigin(host);
    if (!origin || Object.keys(stages).some(k => k.toLowerCase() === 'development')) { kept.push(host); continue; }
    config.tenants[host] = { ...entry, stages: { ...stages, Development: { domain: new URL(origin).host, source: 'derived' } } };
    written.push(host);
  }
  if (written.length) {
    fs.mkdirSync(path.dirname(paths.tenants), { recursive: true });
    const temp = paths.tenants + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(config, null, 2));
    fs.renameSync(temp, paths.tenants);
  }
  return { written, kept };
}
// Local construction with an explicit origin/tenant, otherwise the target's live Studio context.
export function appUrl(input) {
  return resolveApplicationUrls(input, { config: tenants(), status: async pid => client(await studioPid(pid), ['status']) });
}
export function tenantOf(host) {
  const all = tenants();
  const key = host ?? all.default;
  const tenant = all.tenants[key];
  if (!tenant) throw new Error('Unknown tenant ' + key + '; known: ' + Object.keys(all.tenants).join(', '));
  return { host: key, tenant };
}
// Hosted (executor.mjs) the vault, the API Client and the prompt of this machine belong to the server's owner: never
// read or opened for a customer, whose tenant calls run only through the session of their own ODC Studio.
const hostedVaultRefusal = () => Object.assign(new Error('In hosted mode the vault and the API Client of the server are never used: the call runs only '
  + 'through the session of the user\'s own ODC Studio (auth "studio"/"auto").'), { code: 'HOSTED_STUDIO_SESSION_ONLY', executed: false });
const hostedPromptRefusal = () => Object.assign(new Error('In hosted mode no credential prompt opens: only what the user\'s own ODC Studio session '
  + '(and its vault, read by its bridge) already holds is used.'), { code: 'HOSTED_PROMPT_UNAVAILABLE', executed: false });
// A served process without a context fails closed here too: nothing of the owner's vault is read for a lost call.
const ownerSecrets = refusal => { if (hostedContext()) throw refusal(); if (servedWithoutContext()) throw contextLost('the vault of the server'); };
export async function credentialStatus(tenant) {
  if (offline() || hostedContext() || servedWithoutContext()) return false;
  const m = await portal();
  try { return (await m.windowsApiClientCredential('status', tenant.portalOrigin))?.available === true; } catch { return false; }
}
// An OdcBridge for one tenant. Credentials are read from Windows Credential Manager only when present and
// only into this process; with requireCredential the absence is an error, otherwise reads fail as AUTH_NOT_CONFIGURED.
// writable: every catalog mutation passes the bridge's own allowlist, because odc_write already applied the user's
// words, the receipt and the tenant guard (portal\runtime\access.mjs); a tenant policy file still narrows it there.
export async function portalBridge(host, tenant, { requireCredential = true, writable = false } = {}) {
  ownerSecrets(hostedVaultRefusal);
  const m = await portal();
  const credential = mode => m.windowsApiClientCredential(mode, tenant.portalOrigin);
  const available = await credentialStatus(tenant);
  const env = { ...process.env, ODC_PORTAL_ORIGIN: tenant.portalOrigin, ...(tenant.policyFile ? { ODC_POLICY_FILE: path.resolve(root, tenant.policyFile) } : {}) };
  delete env.ODC_CLIENT_ID; delete env.ODC_CLIENT_SECRET;
  if (!available && requireCredential) {
    throw new Error('No API Client credential for ' + host + '. ' + apiClientPrompt(host) + '.');
  }
  const resolved = available ? await m.resolvePublicApiEnvironment(env, credential) : env;
  let config = m.readConfig(resolved);
  if (writable) {
    const catalog = new m.Catalog();
    config = { ...config, allowedWriteOperations: new Set([...catalog.operations.values()].filter(o => !m.readable(o)).map(o => o.id)) };
    return { bridge: new m.OdcBridge({ catalog, config }), credentialAvailable: available };
  }
  return { bridge: new m.OdcBridge({ config }), credentialAvailable: available };
}

// ---- tenant-aware access (odc_read/odc_write/odc_portal_*/typed helpers): the live collaborators of OdcAccess.
// Studio = the attached bridge (v32 commands auth-status, portal-call, portal-session); vault = Credential Manager
// status and the existing OdcBridge/Odc3PortalBroker; prompt = the private helpers in a window of their own.
// Locally the request goes under the loaded bridge's own root (portal-request-file.mjs). Hosted it is a file of the
// customer's <ws>/odc and the mirror takes it to the agent: the bridge root of this server is never the customer's.
export async function requestFile(json) {
  if (usesWorkspace(root, root)) {
    const dir = dataPath('journal', 'portal', 'requests'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + randomUUID().slice(0, 8) + '.json');
    fs.writeFileSync(file, JSON.stringify(json)); return file;
  }
  const pid = await studioPid();
  return writePortalRequest(json, args => client(pid, args));
}
// The private prompt in a window of its own (windows-api-client-credential.ps1 or windows-portal-credential.ps1
// -Mode bootstrap): the user types there and the value goes straight to the Windows Credential Manager; nothing
// typed there passes through this process, its arguments or the chat.
export function tenantEntry(host) { return tenants().tenants?.[host] ?? { portalOrigin: 'https://' + host, policyFile: null }; }
// One OdcAccess per process, and hosted one per context: its tenants, journal, receipts and requests are the customer's.
let access;
const hostedAccess = new WeakMap(); // hosted context -> OdcAccess
export async function createAccess({ env = process.env } = {}) {
  const context = hostedContext();
  if (context ? hostedAccess.has(context) : access) return context ? hostedAccess.get(context) : access;
  const m = await portal();
  const load = name => import(pathToFileURL(path.join(paths.portalRuntime, name)).href);
  const { OdcAccess } = await load('access.mjs');
  const { WriteJournal } = await load('write-journal.mjs');
  const shared = { catalog: new m.Catalog(), tenants: urlConfig(),
    studio: { running: async () => (await studioPids()).length > 0, call: async args => client(await studioPid(), args) },
    policyOf: host => {
      const file = tenants().tenants?.[host]?.policyFile;
      if (!file) return null;
      const target = path.resolve(dataPath(), file);
      // Hosted, the policy is a file of the customer's own <ws>/odc, never another file of this server.
      const rel = path.relative(dataPath(), target);
      if (context && (!rel || rel.startsWith('..') || path.isAbsolute(rel)))
        throw Object.assign(new Error('The policyFile of ' + host + ' must be a file under ws:odc/.'), { code: 'PATH_OUTSIDE_WORKSPACE' });
      return new Set(readJson(target).allowedWriteOperations ?? []);
    },
    journal, receipts: new WriteJournal(dataPath('journal', 'portal', 'receipts')), requestFile };
  if (context) {
    // No owner default tenant, and every vault, API Client, Portal account and prompt path refuses.
    const { OdcError } = await load('errors.mjs');
    const refuse = make => async () => { const error = make(); throw new OdcError(error.code, error.message); };
    const value = new OdcAccess({ ...shared, hosted: true, profiles: null,
      vault: { apiClient: refuse(hostedVaultRefusal), portal: refuse(hostedVaultRefusal), bridge: refuse(hostedVaultRefusal) },
      prompt: { apiClient: refuse(hostedPromptRefusal), portal: refuse(hostedPromptRefusal) },
      portalBroker: () => { const error = hostedVaultRefusal(); throw new OdcError(error.code, error.message); } });
    hostedAccess.set(context, value);
    return value;
  }
  const odc3 = await load('odc3-context.mjs');
  const bridges = new Map(), brokers = new Map();
  // The private credential window (credential-prompt.mjs) exists only here: hosted, every prompt refuses above, and a served
  // process that lost its hosted context never opens one (ownerSecrets).
  const credentialPrompt = createCredentialPrompt({ env });
  return access = new OdcAccess({ ...shared, defaultTenant: env.SSAM_HYBRID_ODC_TENANT,
    profiles: offline() ? null : new CredentialProfiles(),
    vault: {
      apiClient: async host => ({ available: await credentialStatus(tenantEntry(host)) }),
      portal: async (host, database, setting) => offline() ? { available: false } : odc3.portalVault('status', 'https://' + host, database, setting),
      bridge: async host => {
        if (!bridges.has(host)) bridges.set(host, (await portalBridge(host, tenantEntry(host), { requireCredential: true, writable: true })).bridge);
        return bridges.get(host);
      },
    },
    prompt: {
      apiClient: async (host, action) => { ownerSecrets(hostedPromptRefusal); return credentialPrompt('api-client', host, '', action); },
      portal: async (host, database, setting, action) => { ownerSecrets(hostedPromptRefusal);
        return credentialPrompt(setting ? 'setting' : database ? 'database' : 'portal', host, setting || database || '', action); },
      status: async host => { ownerSecrets(hostedPromptRefusal); return credentialPrompt('portal', host, '', 'status'); },
    },
    portalBroker: (host, profile = null) => {
      const key = host + ':' + (profile?.target ?? 'legacy') + ':' + (profile?.principal ?? '');
      if (!brokers.has(key)) brokers.set(key, new odc3.Odc3PortalBroker({ origin: 'https://' + host,
        ...(profile ? { identityTarget: profile.target } : {}),
        ...(offline() ? { credentialProvider: async () => ({ available: false }) }
          : profile ? { credentialProvider: mode => odc3.portalVault(mode, 'https://' + host, null, null, profile.target, profile.principal) } : {}) }));
      return brokers.get(key);
    },
  });
}

// ---- doctor
// ok says whether the ODC lane is usable: dotnet, the bridge, its client and the builder built, one ODC Studio open with
// the bridge attached, the asset catalog readable. What is optional never zeroes it (atritos 2, A19; 15 of 15 doctors of
// 2026-10-05 answered ok:false for a tenant without an API Client): a tenant without a stored API Client credential and a
// module without a runtime origin for its links go to warnings [{check, message, continuation}], each with the MCP call
// that settles it. deps (tests): dotnetVersion, newestBridgeDll, exists, studioPids, studioBrief(pid), readCatalog, tenants,
// portalBridge, readJournal.
export async function doctor({ live = false, deps = {} } = {}) {
  const context = hostedContext();
  if (context) return hostedDoctor(context);
  const d = { dotnetVersion: async () => (await run('dotnet', ['--version'], { windowsHide: true })).stdout.trim(), newestBridgeDll, exists: fs.existsSync,
    studioPids: () => studioPids(), studioBrief: pid => studio(['status', 'brief'], pid), readCatalog: () => readJson(paths.catalog), tenants, portalBridge,
    readJournal: () => fs.readFileSync(paths.journal, 'utf8'), ...deps };
  const report = { ok: true, root, node: process.version, applicationUrls: appUrlCapability, checks: [], warnings: [] };
  const check = (name, ok, detail) => { report.checks.push({ name, ok, ...detail }); if (ok === false) report.ok = false; };
  const warn = (name, message, continuation) => report.warnings.push({ check: name, message, ...(continuation ? { continuation } : {}) });
  try { check('dotnet', true, { version: await d.dotnetVersion() }); } catch { check('dotnet', false, { hint: 'dotnet SDK 10 required for the Studio lane' }); }
  const dll = d.newestBridgeDll();
  check('bridge built', Boolean(dll), dll ? { version: dll.version, path: dll.path } : { hint: 'not built: the integrator or the user builds it' });
  const clientDll = bridgeClientPath();
  check('bridge client built', d.exists(clientDll), { path: clientDll });
  check('builder built', d.exists(paths.builder), { path: paths.builder });
  const pids = await Promise.resolve().then(() => d.studioPids()).catch(() => []);
  check('ODC Studio running', pids.length === 1, { pids, hint: pids.length === 0 ? 'ask the user to open ODC Studio and sign in, then studio_attach' : pids.length > 1 ? 'pass the pid' : undefined });
  if (pids.length === 1 && d.exists(clientDll)) {
    const brief = await Promise.resolve().then(() => d.studioBrief(pids[0])).catch(error => ({ error: error.message }));
    const attached = brief && brief.ok === true;
    check('bridge attached', attached, attached ? { bridge: brief.bridge, expected: dll?.version, upToDate: brief.bridge === dll?.version, busy: brief.busy, modules: brief.modules, dialogsWithChoices: brief.dialogsWithChoices, modalWindows: brief.modalWindows, catalog: brief.catalog, applicationUrls: brief.applicationUrls } : { hint: 'studio_attach', error: brief?.error });
    // A module whose links cannot be built (no runtime origin for its tenant and stage) is a warning: the lane works.
    for (const m of attached && Array.isArray(brief.applicationUrls?.modules) ? brief.applicationUrls.modules : []) {
      const links = m?.appLinks;
      if (!m?.module || !links || (links.available !== false && links.ok !== false)) continue;
      warn('runtime origin', String(links.error ?? 'No runtime origin for ' + m.module + ': its app and screen links are not built.').slice(0, 300),
        { tool: 'ssam_app_url', arguments: { app: m.module, environment: '<runtime origin, https://...>' }, why: 'the links of this app need its runtime origin (or the exact stage domain in the tenant configuration); the lane works without it' });
    }
  }
  catalogCheck(check, d.readCatalog);
  const all = d.tenants();
  for (const [host, tenant] of Object.entries(all.tenants)) {
    const entry = { origin: tenant.portalOrigin, isDefault: host === all.default };
    try {
      const { bridge, credentialAvailable } = await d.portalBridge(host, tenant, { requireCredential: false });
      entry.credentialAvailable = credentialAvailable;
      entry.catalog = { apis: bridge.catalog.apis.size, operations: bridge.catalog.operations.size };
      if (live && credentialAvailable) {
        const probe = await bridge.execute('portfolio-api-v2:get:/environments', {}, 'read').catch(error => ({ ok: false, error: { message: error.message } }));
        const rows = Array.isArray(probe.data) ? probe.data : Array.isArray(probe.data?.results) ? probe.data.results : undefined;
        entry.live = { ok: probe.ok, status: probe.status, environments: rows?.map(r => r.name), error: probe.error?.code ?? probe.error?.message };
      }
      // The API Client credential is optional: Portal and public API calls use the ODC Studio session first.
      check('portal ' + host, true, entry);
      if (!credentialAvailable) warn('portal ' + host, 'No API Client credential stored for ' + host + ': its Portal and public API calls use the ODC Studio session, and only without one ask for it.',
        { tool: 'odc_read', arguments: { tenant: host, auth: 'api-client' }, why: 'uses an existing privately provisioned API Client for this tenant; missing credentials are refused without opening a prompt' });
    } catch (error) { check('portal ' + host, false, { ...entry, error: error.message }); }
  }
  journalCheck(check, d.readJournal);
  return report;
}
// The catalog and journal checks of both doctors (hosted: the customer's <ws>/odc, through paths).
function catalogCheck(check, readCatalog = () => readJson(paths.catalog)) {
  try { const catalog = readCatalog(); check('asset catalog', true, { tenant: catalog.tenant, modules: (catalog.modules ?? []).length, listedAt: catalog.modulesListedAt ?? null, hint: catalog.modulesListedAt ? undefined : 'studio_assets' }); }
  catch { check('asset catalog', false, { hint: 'studio_assets after studio_attach' }); }
}
function journalCheck(check, readJournal = () => fs.readFileSync(paths.journal, 'utf8')) {
  try {
    const lines = readJournal().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    check('journal', true, { lines: lines.length, last: { ts: last.ts_end, tool: last.tool, command: last.command, outcome: last.outcome } });
  } catch { check('journal', true, { lines: 0 }); }
}
// Hosted: the customer's side only, from the agent (AgentLink.info(): connection, versions) and the customer's ODC Studio
// through it, plus the mirrored catalog and the journal of the workspace. No dotnet, build or vault check of this server.
async function hostedDoctor(context) {
  const report = { ok: true, hosted: true, node: process.version, applicationUrls: appUrlCapability, checks: [], warnings: [] };
  const check = (name, ok, detail) => { report.checks.push({ name, ok, ...detail }); if (ok === false) report.ok = false; };
  let info = null;
  try { info = context.agent?.info?.() ?? null; } catch { info = null; }
  const connected = info?.connected === true;
  check('agent', connected, { agentVersion: info?.agentVersion ?? null, connectedAt: info?.connectedAt ?? null, credential: info?.credential ?? null,
    ...(connected ? {} : { hint: 'ask the user to start the SSAM agent on their machine (agent\\ssam-agent.ps1 start, docs/AGENTE-CLIENTE.md)' }) });
  const compatible = info?.compatible?.odc ?? null;
  check('versions', compatible?.ok === true, { kernel: info?.kernel?.odc ?? null, bridge: info?.kernel?.odcBridge ?? null,
    studio: info?.studios?.odc?.installed?.version ?? null, ...(compatible && compatible.ok !== true ? { code: compatible.code, hint: compatible.message } : {}) });
  if (connected) {
    let pids = [], error;
    try { pids = await studioPids(); } catch (failure) { error = failure.message; }
    check('ODC Studio running', pids.length === 1, { pids, ...(error ? { error } : {}),
      hint: pids.length === 0 ? 'ask the user to open ODC Studio and sign in, then studio_attach' : pids.length > 1 ? 'pass the pid' : undefined });
    if (pids.length === 1) {
      const brief = await studio(['status', 'brief'], pids[0]).catch(failure => ({ error: failure.message }));
      const attached = brief && brief.ok === true;
      check('bridge attached', attached, attached ? { bridge: brief.bridge, busy: brief.busy, modules: brief.modules, dialogsWithChoices: brief.dialogsWithChoices,
        modalWindows: brief.modalWindows, catalog: brief.catalog, applicationUrls: brief.applicationUrls } : { hint: 'studio_attach', error: brief?.error });
    }
  }
  catalogCheck(check);
  journalCheck(check);
  return report;
}

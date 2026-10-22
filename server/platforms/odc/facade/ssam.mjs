import {ensureRuntime} from './hosted/storage.mjs';
import { installToolListing, listedTool } from './tool-listing.mjs';
import { serverProfile, profileServes, parseMcpProfile } from './server-profiles.mjs';
import { bindingKeyOf, listedKeyOf, slotKeyOf, sameProducer, separatorKeyProblems } from './producer-names.mjs';
import { serverInstructions } from './server-instructions.mjs';
import { exposureOf, exposedResult, exposureOrigin, presentedDocument, exposedToolDefinition, handleTest, LICENSEE_INSTRUCTION } from './exposure.mjs';
import { ssamPathRoots } from './evidence-roots.mjs';
// SSAM Hybrid: one command and one MCP server for the two lanes. `ssam <verbo> --lane o11|odc ...` delegates to
// that lane's own CLI (facade\lanes.mjs builds the line); nothing about how either platform works is reimplemented
// here. Without `--lane`, the module named in the arguments decides, by the lane catalogs alone, and a module that
// exists in both lanes is a refusal, not a guess.
//   ssam doctor [--lane o11|odc]        both lanes side by side: CLI, catalog, and which Studio is open in each
//   ssam inspect|deliver|data|publish|job [--lane l] <args...>   passthrough to the lane's CLI
//   ssam map [--lane o11|odc] <capture.oml|Module> [...]   every element of a capture from its module index (module-map.mjs)
//   ssam map [--lane o11|odc] <capture.oml|Module> --digest [--page n]   the whole module as text, in pages (module-digest.mjs)
//   ssam access plan|apply|verify --lane o11 --manifest <abs>.json [--words "..." [--execute]]   O11 end-user roles by manifest
//   ssam connect [--lane o11|odc] [--pid p]   attach every open Studio (or one lane / one pid), as MCP ssam_connect
//   ssam warm [--lane o11|odc]          build (or find cached) the discover index of each lane (end of scripts/build.ps1)
//   ssam debug locks [--lane o11|odc]   read-only debugger lock inventory (ssam_debug_run op locks)
//   ssam mcp                            one MCP server with the tools of both lanes (warms the discover indexes in the background)
//   ssam serve [--port 7300] [--host 127.0.0.1] [--local-studios]   the same MCP over Streamable HTTP at /mcp, bearer tokens
//                                       (SERVIDOR-LOCAL.md); hosted by default (FASE2-AGENTE.md), the owner's Studios with
//                                       --local-studios; no background warm-up (`ssam warm` builds the shared index first)
//   ssam server-token issue --customer <name> [--days N] | revoke --id <id> | list   local admin of the served tokens
//   ssam db migrate | status                                                         the Postgres of SSAM_DATABASE_URL (tokens)
import { DESTRUCTIVE_SUFFIX, callWordsProblems, resultWithoutWordEchoes, taskStepOfCall, wordsRequired, wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import {workspaceRoot, anvilRoot} from './workspace.mjs';
import path from 'node:path';
import { agentJoin } from './agent-paths.mjs';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { runDataLoad, o11DataChannel } from './data-load.mjs';
import { withInlineDataReservation } from './data-load-lock.mjs';
import { waitForDataLoadEnd } from './data-load-lock.mjs';
import { parseAppArguments } from './app-urls.mjs';
import { anvilLaneFacts, catalog, command, lane, laneNames, laneOfModule, LANES, run, studioProcesses, studioProcessScript, parseStudioProcesses, verbs } from './lanes.mjs';
import { registerO11Operations } from './o11-operations.mjs';
import { connectAll, probeO11, classifyO11, assertSelectedO11, WINDOWLESS_FIX } from './studio-connect.mjs';
import { readConnection, staleConnection } from './studio-session.mjs';
import { authorityDir, userEnvironmentValue, o11LaneOf } from './o11-lane.mjs';
import { registerO11AppSession, runHook } from './o11-app-session.mjs';
import { registerO11Cycle, findKernelTask, closeState } from './o11-cycle.mjs';
import { configureRelayFacade, relayWork } from './relay-lifecycle.mjs';
import { createCallDeadline, continuationSchema, isLiveTask, folderKey, CONTINUATION_REFUSED, markRunsToEnd } from './call-deadline.mjs';
import { REPLAY_WINDOW_MS, createReplay, resolveRelativePaths } from './replay-store.mjs';
import { kernelWorkFolders, registerSsamTask, closeFacadeTask, readTask, findKernelFacadeTasks, sanitizeAnswer, tasksDir } from './ssam-task.mjs';
import { isMutation, nestsDelivery, runsToEnd } from './tool-classification.mjs';
import { serverIdentity, releaseChanged, releaseWatch, sessionRoot, sameFolder } from './server-identity.mjs';
import { registerO11Studio } from './o11-studio.mjs';
import { registerO11Environment } from './o11-environment.mjs';
import { registerPreviewTools } from './preview/mcp.mjs';
import { registerSsamReference, LICENSEE_REFERENCE } from './ssam-reference.mjs';
import { servedBytesStore, nextDay, meterRead, ALERT_BYTES, callerId } from './served-bytes.mjs';
import { referenceFolders, answerFolders, fileOrigin, isKeptAnswer } from './reference-files.mjs';
import { registerSsamEvidence } from './ssam-evidence.mjs';
import { pagedShape, missingCall } from './paged-answer.mjs';
import { jobTool } from './job-runner.mjs';
import { prototypeDeliveryDefaults, readJobDocument, PROTOTYPE_DELIVER_TEXT } from './prototype-op.mjs';
import { textFormRefusal, partReader } from './text-routes.mjs';
import { CODE_JOB_TEXT, normalizeCodeOps } from './ssam-code.mjs';
import { mergeNormalizations } from './normalizations.mjs';
import { resolvePatchedJob, jobIdentity, failedOpOf, patchJsonSchema, basedOnJsonSchema, withNamedPatches, appliedJobIdentity } from './job-patch.mjs';
import { createWorkerFirstRunner, createWorkerClient, workerDisabled } from './anvil-worker.mjs';
import { shapeToolResult } from './responses.mjs';
import { keepAnswer, fitResult } from './answer-size.mjs';
import { MAX_ANSWER_BYTES, maxAnswerBytes, budgetCeiling } from './context-budget.mjs';
export { MAX_ANSWER_BYTES, maxAnswerBytes, budgetCeiling } from './context-budget.mjs';
import { boundedRead, readOptions, readCheckpoint } from './read-budget.mjs';
import { withStudioWriteLock, busyToolResult, isWrite, isPhased, declaresPhases, PHASES_META, processAlive } from './studio-write-lock.mjs';
import { registerO11Access } from './o11-access.mjs';
import { registerO11Publish } from './o11-publish.mjs';
import { registerO11Extension } from './o11-extension.mjs';
import { readLocalSettings } from './local-settings.mjs';
import { withCall, noteAnswer } from './quality-meter.mjs';
import { registerQueryTestTools } from './query-test.mjs';
import { codeServedHosted } from './hosted/served.mjs';

const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const fail = message => { process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n'); process.exitCode = 1; };
export function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return { value: undefined, rest: args };
  return { value: args[index + 1], rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}
// The module a verb is about: --module when it is given, otherwise the first positional argument.
export const moduleOf = args => option(args, '--module').value ?? args.find(a => !a.startsWith('-'));

// The lane to use: --lane, or the one whose catalog lists the module. Never a default: an unknown module refuses.
export function chooseLane(explicit, args) {
  if (explicit) return { ok: true, lane: lane(explicit).name, from: '--lane' };
  const module = moduleOf(args);
  if (!module) return { ok: false, error: 'No --lane and no module in the arguments; pass --lane ' + laneNames.join('|') + '.' };
  return laneOfModule(module);
}

// ---- Module reservations of the O11 deliveries (I8 of the atritos 2 package; format owned by the kernel,
// Delivery/ModuleReservation.cs): <authority>/reservations/<sha>.json, a DurableJson envelope {format:1, sha256, payload}
// whose payload is {owner: taskId | null, environment, moduleKey, root?, pid?, since?, releasedBy?, wordsSha256?}; active
// while owner is set. The authority folder resolves as BridgeAccess does: ANVIL_AUTHORITY_DIR of this process, else the
// user's (HKCU\Environment), else %LOCALAPPDATA%\Anvil\authority. A packaged (MSIX) process sees a private %LOCALAPPDATA%:
// the real copies under %LOCALAPPDATA%\Packages\<family>\LocalCache\Local are listed too, so the reservation that blocks a
// module is found by its real path, never searched by hand.
// The authority is shared by every SSAM root of the machine (2026-10-05: a reservation of 29/09 from another root sent a
// session to ssam_task, which answered TASK_NOT_FOUND, and the agent stopped). Each active reservation is classified:
//   active   a task of this root still running or with a write to settle (uncertain, unsettled): ssam_task {id}
//   stale    a task of this root that ended with a recorded failure: ssam_task {id, close:{reason}} (A17 closes a
//            not-sent/not-applied one without the Studio); one already closed or delivered left it behind: release
//   foreign  reserved by another SSAM root (payload.root): ssam_doctor {lane:"o11", release}, never ssam_task
//   orphan   no task of this root (a reservation written before I8, a task folder removed): ssam_doctor release
const MAX_LISTED_RESERVATIONS = 20;
const KERNEL_TASK = /^[0-9a-f]{32}$/i;
const RESERVATION_FILE = /^[0-9a-f]{64}\.json$/i;
// The delivery work folders of this root, one per O11 lane (ss4 .local/work, ss5 .local/lane-ss5/work).
// The same list ssam_task reads a kernel task from (C37): one definition.
export function deliveryWorkFolders(root = anvilRoot) {
  return kernelWorkFolders(root);
}
export function readReservationFile(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const payload = doc && doc.format === 1 && typeof doc.payload === 'string' ? JSON.parse(doc.payload) : doc;
  return { doc, payload };
}
const releaseCall = file => ({ tool: 'ssam_doctor', arguments: { lane: 'o11', release: { reservation: file, authorize: "<the user's own words>" } } });
// A task of the controlled app session (AppSessions.cs: <authority>/app-sessions.json, ReservationOwner = the app task id)
// holds a reservation across turns; only that session settles it, so it is never offered for release.
function appSessionTask(authority, owner) {
  if (!authority) return null;
  try { return readReservationFile(path.join(authority, 'app-sessions.json')).payload?.tasks?.[owner] ?? null; } catch { return null; }
}
// ctx: root (this root's kernel folder), works (its delivery work folders), authority (the folder of the reservations, for
// the app sessions), alive(pid), findTask(work, {taskId}).
export function classifyReservation(payload, file, { root = anvilRoot, works = deliveryWorkFolders(root), authority = path.dirname(path.dirname(file)), alive = processAlive, findTask = findKernelTask } = {}) {
  const owner = String(payload.owner);
  const pid = Number.isSafeInteger(payload.pid) ? payload.pid : null;
  const facts = { ...(payload.root ? { root: payload.root } : {}), ...(pid != null ? { pid, processAlive: alive(pid) } : {}), ...(payload.since ? { since: payload.since } : {}) };
  if (appSessionTask(authority, owner)) return { state: 'active', ...facts, appSession: true,
    reason: 'held by the controlled app session task ' + owner + ' (app-sessions.json of this authority): that session settles it',
    next: { tool: 'status', arguments: { task_id: owner }, why: 'the app session tools of the controlled profile read and settle it; it is never released here' } };
  if (payload.root && !sameFolder(payload.root, root)) return { state: 'foreign', ...facts,
    reason: 'reserved by a task of another SSAM root (' + payload.root + '); its tasks are not in this root',
    next: { ...releaseCall(file), why: 'frees the module of another root\'s task with the user\'s words; never ssam_task (the task is not here). A delivery running now keeps it.' } };
  const task = KERNEL_TASK.test(owner) ? works.map(work => { try { return findTask(work, { taskId: owner.toLowerCase() }); } catch { return null; } }).find(Boolean) ?? null : null;
  if (!task) return { state: 'orphan', ...facts,
    reason: 'no delivery task ' + owner + ' in this root (a reservation written before its root was recorded, or a task folder removed)',
    next: { ...releaseCall(file), why: 'frees the module with the user\'s words; never ssam_task (it answers TASK_NOT_FOUND here). A delivery running now keeps it.' } };
  const closing = closeState(task);
  if (closing === 'refused') return { state: 'stale', ...facts, task: { writeState: task.writeState ?? null, stage: task.stage ?? null },
    reason: 'task ' + owner + ' of this root ended with a recorded failure and no merge to settle',
    next: { tool: 'ssam_task', arguments: { id: owner, close: { reason: '<reason>' } }, why: 'closes the failed delivery in the kernel and frees its module (not-sent or not-applied: without the Studio)' } };
  if (closing === 'closed' || closing === 'delivered') return { state: 'stale', ...facts, task: { writeState: task.writeState ?? null, stage: task.stage ?? null },
    reason: 'task ' + owner + ' of this root is already ' + closing + ' and left its reservation behind',
    next: { ...releaseCall(file), why: 'the task already ended, so closing it frees nothing: release the reservation with the user\'s words' } };
  return { state: 'active', ...facts, task: { writeState: task.writeState ?? null, stage: task.stage ?? null },
    reason: closing === 'uncertain' ? 'task ' + owner + ' of this root has a write to settle' : 'task ' + owner + ' of this root is running or stopped before its end',
    next: { tool: 'ssam_task', arguments: { id: owner }, why: 'the delivery that holds this module: read it to resume or close it' } };
}
function readReservations(directory, ctx) {
  const active = []; let total = 0;
  let names = [];
  try { names = fs.readdirSync(directory).filter(n => /\.json$/i.test(n)); } catch { return { exists: false, active, total }; }
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const { payload } = readReservationFile(file);
      if (payload?.owner == null) continue;
      total++;
      if (active.length < MAX_LISTED_RESERVATIONS) {
        const { next, ...classified } = classifyReservation(payload, file, ctx);
        active.push({ file, owner: String(payload.owner), moduleKey: payload.moduleKey ?? null, environment: payload.environment ?? null,
          ...(payload.taskDirectory ? { taskDirectory: payload.taskDirectory } : {}), ...classified, next });
      }
    } catch { /* a file being written or damaged: the kernel reports it on its own reservation */ }
  }
  return { exists: true, active, total };
}
// ctx (tests): root (this root's kernel folder, default anvilRoot), works, alive(pid), findTask(work, {taskId}).
export function moduleReservations({ env = process.env, readUserEnvironment = userEnvironmentValue, ...ctx } = {}) {
  const source = env.ANVIL_AUTHORITY_DIR ? 'ANVIL_AUTHORITY_DIR (process)' : readUserEnvironment('ANVIL_AUTHORITY_DIR') ? 'ANVIL_AUTHORITY_DIR (HKCU\\Environment)' : '%LOCALAPPDATA%\\Anvil\\authority';
  const authority = authorityDir({ env, readUserEnvironment });
  const directory = path.join(authority, 'reservations');
  const listed = readReservations(directory, ctx);
  const report = { authority, source, directory, active: listed.active, activeTotal: listed.total };
  const localAppData = env.LOCALAPPDATA;
  const relative = localAppData ? path.relative(localAppData, directory) : '';
  if (localAppData && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    const packages = path.join(localAppData, 'Packages');
    let families = [];
    try { families = fs.readdirSync(packages, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { /* not Windows, or no packages */ }
    const copies = families.map(family => path.join(packages, family, 'LocalCache', 'Local', relative)).filter(dir => fs.existsSync(dir))
      .map(dir => { const r = readReservations(dir, ctx); return { directory: dir, active: r.active, activeTotal: r.total }; });
    report.virtualization = 'A packaged (MSIX) process sees a private %LOCALAPPDATA%: the same path may hold different files inside and outside the package.'
      + (copies.length ? ' Real copies are listed in packagedCopies.' : '');
    if (copies.length) report.packagedCopies = copies;
  }
  return report;
}

// ssam_doctor {lane:"o11", release:{reservation, authorize}}: frees one foreign or orphan reservation (or one a finished task
// left behind) with the user's words, as the kernel's own Release does: owner null, plus releasedBy "doctor" and the sha256
// of the words (never the words). Not a Studio write: no queue. It holds the reservation's lease (<file>.lock, exclusive,
// the kernel's DurableJson.Lease) while it writes, so a delivery running now keeps its module (RESERVATION_IN_USE), and a
// reservation of a task of this root that can be resumed or closed is answered with that task (RESERVATION_HAS_TASK):
// releasing it could allow a second uncertain write.
const EXCLUSIVE = process.platform === 'win32' ? 0x10000000 : 0; // libuv UV_FS_O_EXLOCK: share mode 0, as FileShare.None
const placeholderWords = words => !wordsGiven(words); // CX15 r7 (L-7): one predicate
export function releaseReservation({ reservation, authorize } = {}, { env = process.env, readUserEnvironment = userEnvironmentValue, now = () => new Date(), ...ctx } = {}) {
  const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, ...(continuation ? { continuation } : {}) });
  const listed = moduleReservations({ env, readUserEnvironment, ...ctx });
  const directories = [listed.directory, ...(listed.packagedCopies ?? []).map(c => c.directory)];
  const lookAgain = { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'lists the module reservations with their real path and state' };
  const name = typeof reservation === 'string' ? path.basename(reservation) : '';
  const file = typeof reservation === 'string' && path.isAbsolute(reservation) ? path.resolve(reservation)
    : directories.map(d => path.join(d, name)).find(f => fs.existsSync(f)) ?? null;
  if (!RESERVATION_FILE.test(name) || !file || !directories.some(d => sameFolder(path.dirname(file), d)) || !fs.existsSync(file))
    return refusal('RESERVATION_NOT_FOUND', 'Not a reservation file of this authority: ' + String(reservation ?? '').slice(0, 300), lookAgain, { directories });
  if (placeholderWords(authorize)) return refusal('WORDS_REQUIRED', 'Releasing a module reservation needs the user\'s own words in release.authorize, verbatim; nothing was changed.',
    { tool: 'ssam_doctor', arguments: { lane: 'o11', release: { reservation: file, authorize: "<the user's own words>" } }, why: 'the same call with the user\'s words' }, { reservation: file });
  let fd;
  try { fd = fs.openSync(file + '.lock', fs.constants.O_RDWR | fs.constants.O_CREAT | EXCLUSIVE); }
  catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) return refusal('RESERVATION_IN_USE', 'A delivery is running on this module now (its reservation lease is held); it answers by itself and nothing was changed.', lookAgain, { reservation: file });
    throw error;
  }
  try {
    let read;
    try { read = readReservationFile(file); } catch (error) { return refusal('RESERVATION_UNREADABLE', 'The reservation cannot be read (' + String(error.message).slice(0, 200) + '); nothing was changed.', lookAgain, { reservation: file }); }
    const { doc, payload } = read;
    if (!doc || doc.format !== 1 || typeof doc.payload !== 'string' || doc.sha256 !== createHash('sha256').update(doc.payload, 'utf8').digest('hex'))
      return refusal('RESERVATION_UNREADABLE', 'The reservation envelope does not check (format or sha256); nothing was changed.', lookAgain, { reservation: file });
    if (payload.owner == null) return { ok: true, released: false, reservation: file, note: 'already free: no task holds this module' };
    const classified = classifyReservation(payload, file, ctx);
    if (classified.state === 'active' || (classified.state === 'stale' && classified.next.tool !== 'ssam_doctor'))
      return refusal('RESERVATION_HAS_TASK', 'Task ' + payload.owner + ' of this root holds this module (' + classified.state + '): ' + classified.reason + '; nothing was changed.',
        classified.next, { reservation: file, state: classified.state });
    const released = { ...payload, owner: null, releasedBy: 'doctor', wordsSha256: createHash('sha256').update(String(authorize), 'utf8').digest('hex'),
      previousOwner: String(payload.owner), releasedAt: now().toISOString() };
    const text = JSON.stringify(released);
    const envelope = JSON.stringify({ format: 1, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), payload: text });
    const temporary = file + '.' + randomUUID().replace(/-/g, '') + '.tmp';
    fs.writeFileSync(temporary, envelope, 'utf8');
    try { fs.renameSync(temporary, file); } finally { try { fs.unlinkSync(temporary); } catch { /* moved */ } }
    return { ok: true, released: true, reservation: file, state: classified.state, owner: String(payload.owner), moduleKey: payload.moduleKey ?? null, environment: payload.environment ?? null,
      releasedBy: 'doctor', next: 'the module is free: deliver to it again' };
  } finally { fs.closeSync(fd); }
}

// ---- doctor: the one verb ssam answers itself, because only it sees both lanes at once. The Anvil CLI has no
// doctor of its own (src\Anvil.Cli\Program.cs), so the O11 half is built from the lane's own facts
// (scripts/lanes.py --json) plus the Service Studio processes running from that lane's installation.
// deps (tests): processes() (lanes.studioProcesses), facts(), probe(port), record() (the connection record), cliBuilt.
export async function doctorO11({ factsCache = defaultDoctorFacts, reservations: reservationDeps = {}, processes: listProcesses, facts: readFacts, probe: probeBridge, record: readRecord, cliBuilt } = {}) {
  const entry = LANES.o11;
  const processFacts = listProcesses ? { value: await listProcesses(), ageMs: 0 } : await factsCache.processes('o11').catch(() => ({ value: [], ageMs: 0 }));
  const processes = processFacts.value;
  const facts = await (readFacts ?? (() => anvilLaneFacts(entry.lane, entry.root)))().catch(error => ({ error: error.message }));
  const cli = { path: entry.cli, built: cliBuilt ?? fs.existsSync(entry.cli) };
  const probe = facts.bridge ? await (probeBridge ?? probeO11)(facts.bridge) : { connected: false, error: facts.error };
  const studio = { ...classifyO11(processes, probe), lane: entry.lane };
  // D5 (atritos 3): a Studio without a main window is listed with the fix and never counts; the record naming it is stale.
  let record = null;
  try { record = readRecord ? readRecord() : readConnection(entry.root, entry.lane); } catch { record = null; }
  const stale = staleConnection(record, processes);
  let reservations;
  try { reservations = moduleReservations(reservationDeps); } catch (error) { reservations = { error: error.message }; }
  const report = { factsAgeMs: processFacts.ageMs, lane: 'o11', platform: entry.platform, root: entry.root, anvilLane: facts, cli, studio, reservations,
    catalog: catalog('o11'), ok: cli.built && studio.connected && stale?.reason !== 'windowless',
    ...(studio.windowless ? { windowless: studio.windowless } : {}), ...(stale ? { connectionStale: stale } : {}) };
  // Next steps are MCP calls, never a shell command: the CLI build belongs to the integrator, not to the session.
  if (!cli.built) report.hint = { why: 'The O11 CLI of this checkout is not built; the integrator builds it. Nothing to run from the session.', path: entry.cli };
  else if (!report.ok) report.continuation = { tool: 'ssam_connect', arguments: { lane: 'o11' },
    why: studio.laneHeldBy ? 'The lane port is held by Service Studio ' + studio.laneHeldBy.pid + ', which has no main window (STUDIO_WINDOWLESS): '
        + (studio.windowless?.find(w => w.pid === studio.laneHeldBy.pid)?.next ?? '') + ' ' + WINDOWLESS_FIX
      : stale?.reason === 'windowless' ? 'The connected Studio ' + stale.pid + ' has no main window any more (STUDIO_WINDOWLESS): connect the Studio with a window. '
        + (studio.windowless?.find(w => w.pid === stale.pid)?.next ?? '')
        : 'Open Service Studio normally first; connecting needs no save, publish or restart.' };
  return report;
}
// The ODC lane already has a doctor of its own, and it is the authority on that lane; ssam only relays it. Its ok is the
// lane's (lib.mjs doctor: optional credentials and runtime origins are warnings there); a lane that is not usable names
// what makes it usable: a component to build (hint, the integrator) or the Studio to open and attach (ssam_connect).
const ODC_BUILT = ['dotnet', 'bridge built', 'bridge client built', 'builder built'];
async function doctorOdc({ factsCache = defaultDoctorFacts } = {}) {
  const entry = LANES.odc;
  const [odcFacts, processFacts] = await Promise.all([factsCache.odc().catch(error => ({ value: { ok: false, error: error.message }, ageMs: 0 })), factsCache.processes('odc').catch(() => ({ value: [], ageMs: 0 }))]);
  const delegated = odcFacts.value;
  const processes = processFacts.value;
  const report = { factsAgeMs: Math.max(odcFacts.ageMs, processFacts.ageMs), lane: 'odc', platform: entry.platform, root: entry.root, cli: { path: entry.exe, built: fs.existsSync(entry.exe) },
    catalog: catalog('odc'), studio: { image: entry.studioProcess, open: processes.length > 0, pids: processes.map(p => p.pid) },
    ok: delegated.ok === true, doctor: delegated };
  if (Array.isArray(delegated.warnings) && delegated.warnings.length) report.warnings = delegated.warnings;
  if (!report.ok) {
    const failed = (delegated.checks ?? []).filter(c => c.ok === false).map(c => c.name);
    if (failed.some(n => ODC_BUILT.includes(n))) report.hint = { why: 'A component of the ODC lane is not built (' + failed.filter(n => ODC_BUILT.includes(n)).join(', ') + '); the integrator builds it. Nothing to run from the session.' };
    else report.continuation = { tool: 'ssam_connect', arguments: { lane: 'odc' },
      why: 'Open ODC Studio normally and sign in first; connecting attaches it without closing, saving or publishing' + (failed.length ? ' (failed: ' + failed.join(', ') + ')' : '') + '.' };
  }
  return report;
}

// The doctor's verdict (atritos 2, A19): with `lane`, ok is that lane's; without it, ok is true when some lane is usable,
// and each lane keeps its own ok. A lane that is not usable answers DOCTOR_LANE_UNUSABLE with that lane's continuation
// (ssam_connect) or the component hint. Optional things (a tenant without an API Client, a runtime origin) are warnings.
// With the identity of the MCP server (the tool passes it; the CLI does not): `server` always, and the refusals that say
// this server is not the one the session needs (A09/A10), in this order: WRONG_SERVER (the session's SSAM root is another
// folder), TOOL_CATALOG_STALE (catalog/tools.json changed since the server started), RELEASE_CHANGED (the commit or the CLI
// changed). All of them keep every lane in the answer.
export const RESTART_NEXT = 'restart this MCP server (Claude Code: /mcp and reconnect; Codex: restart the session)';
// Hosted, only the server owner restarts the server (scripts\servidor.ps1); the customer cannot.
export const HOSTED_RESTART_NEXT = 'the hosted SSAM server changed its release and needs a restart by the server owner; tell the owner and repeat the call afterwards';
const releaseWait = tasks => tasks.length ? { tasks,
  next: 'The launcher reloads this server automatically when all detached tasks finish. Continue their existing operations.',
  continuation: tasks[0].continuation } : null;
export async function doctor(laneName, { lanes: laneDoctors = {}, reservations, identity = null, o11 = {}, activeTasks = [] } = {}) {
  const wanted = laneName ? [lane(laneName).name] : laneNames;
  const lanes = Object.fromEntries(wanted.map(name => [name, null]));
  await Promise.all(wanted.map(async name => { lanes[name] = name === 'odc' ? await (laneDoctors.odc ?? doctorOdc)() : await (laneDoctors.o11 ?? doctorO11)({ reservations, ...o11 }); }));
  // The tenant and host of this machine (.ssam-local.json, untracked), only when that file exists.
  let local = null;
  try { local = readLocalSettings(); } catch (error) { local = { error: error.message }; }
  const ok = laneName ? lanes[wanted[0]]?.ok === true : Object.values(lanes).some(l => l.ok === true);
  const report = { ok, lanes, studiosOpen: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.studio?.open === true])), ...(local ? { local } : {}) };
  const warnings = Object.entries(lanes).flatMap(([name, l]) => (Array.isArray(l.warnings) ? l.warnings : []).map(w => ({ lane: name, ...w })));
  if (warnings.length) report.warnings = warnings;
  // D5 (atritos 3): the Service Studios without a main window, with the fix (SSAM ignores them; never closes a Studio).
  if (Array.isArray(lanes.o11?.windowless) && lanes.o11.windowless.length) report.windowless = lanes.o11.windowless;
  if (!ok) {
    const unusable = wanted.filter(n => lanes[n]?.ok !== true);
    const only = unusable.length === 1 ? lanes[unusable[0]] : null;
    report.code = 'DOCTOR_LANE_UNUSABLE';
    report.unusable = unusable;
    report.error = (laneName ? 'The ' + laneName + ' lane is not usable' : 'No lane is usable') + ': ' + unusable.map(n => n + ' (' + (lanes[n]?.hint?.why ?? lanes[n]?.continuation?.why ?? lanes[n]?.error ?? 'see lanes.' + n) + ')').join('; ');
    if (only?.continuation) report.continuation = only.continuation;
    else if (only?.hint) report.hint = only.hint;
    else if (unusable.every(n => lanes[n]?.hint)) report.hint = { why: unusable.map(n => n + ': ' + lanes[n].hint.why).join(' ') };
    else report.continuation = { tool: 'ssam_connect', arguments: {}, why: 'attaches every Studio already open; open the Studios normally first (no save, publish or restart)' };
  }
  if (identity?.server) {
    const { server, current, session } = identity;
    report.server = { name: server.name, root: server.root, release: server.release, startedAt: server.startedAt,
      // C11: the launcher reloaded this server in place (a facade or catalog change): when, and from which identity.
      ...(server.reloadedAt ? { reloadedAt: server.reloadedAt, reloadedFrom: server.reloadedFrom ?? null } : {}) };
    if (session?.root) report.session = session;
    const changed = current ? releaseChanged(server, current) : null;
    const again = why => ({ tool: 'ssam_doctor', arguments: {}, why });
    const verdict = (code, error, extra) => { Object.assign(report, { ok: false, code, error, ...extra }); delete report.hint; delete report.unusable; };
    if (session?.root && !sameFolder(session.root, server.root))
      verdict('WRONG_SERVER', 'This MCP server serves the SSAM root ' + server.root + ', but this session works in ' + session.root + ' (' + session.from + ').',
        { next: 'use the SSAM MCP server of ' + session.root + ' (the one its .mcp.json registers); in Claude Code /mcp lists the servers, in Codex the config names them',
          continuation: again('confirms the root of the server after the switch') });
    else if (changed && activeTasks.length)
      verdict(changed.changed.includes('catalog') ? 'TOOL_CATALOG_STALE' : 'RELEASE_CHANGED',
        'The SSAM release under this server changed since it started (' + changed.changed.join(', ') + '). Detached operations are still running; continue them until they finish.',
        { release: changed, ...releaseWait(activeTasks) });
    else if (changed?.changed.includes('catalog'))
      verdict('TOOL_CATALOG_STALE', 'The tool catalog on disk (catalog/tools.json) changed since this server started: its tools and routes are older than the installed release.',
        { release: changed, next: RESTART_NEXT, continuation: again('confirms the new release after the restart') });
    else if (changed)
      verdict('RELEASE_CHANGED', 'The SSAM release under this server changed since it started (' + changed.changed.join(', ') + '): every tool but ssam_doctor, ssam_evidence and the ssam_task read answers RELEASE_CHANGED until it restarts.',
        { release: changed, next: RESTART_NEXT, continuation: again('confirms the new release after the restart') });
  }
  if (activeTasks.length && !report.tasks) Object.assign(report, { tasks: activeTasks,
    continuation: activeTasks[0].continuation,
    next: 'Continue the detached operations. If the release changed, the launcher reloads automatically when all detached tasks finish.' });
  return report;
}

// The doctor of a hosted session (docs/FASE2-AGENTE.md 7, 8): the agent from link.info() (never a secret), and per lane
// the server kernel, the user's installed Studio, the compatibility, the Studio processes and the O11 connection,
// read through the customer's executor. Nothing of the server's own Studios or vault.
// fase4-24 (2.10): network:true adds the network check (hosted/network-check.mjs: the agent's uploads on new connections,
// per exit of the user's internet, in plain words; about 5 s); without it, slow upload parts the hub saw lately add
// agent.uploads and the hint to run it. Neither changes ok: the doctor's ok stays about the lanes.
export async function hostedDoctor(laneName, { context, session }, { network = false } = {}) {
  const link = session?.agent ?? context.agent;
  const { agentNotConnected } = await import('./hosted/policy.mjs');
  let info = {}, connected = false;
  try { info = link?.info?.() ?? {}; connected = link?.connected?.() === true; } catch { connected = false; }
  const agent = { connected, credential: info.credential !== false, instance: info.instance ?? null, agentVersion: info.agentVersion ?? null,
    connectedAt: info.connectedAt ?? null, lastSeenAt: info.lastSeenAt ?? null, pack: info.pack ?? null, studios: info.studios ?? null,
    kernel: info.kernel ?? null, compatible: info.compatible ?? null,
    // C26: the agent's folder and its inbox, where the user's own files go (an OML, an image), passed as agent:inbox/<name>;
    // jobs go inline (HOSTED_RULES, fase4-24).
    ...(typeof info.agentRoot === 'string' && info.agentRoot ? { root: info.agentRoot, inbox: agentJoin(info.agentRoot, 'inbox') } : {}) };
  const lanes = {};
  for (const name of laneName ? [lane(laneName).name] : laneNames) {
    const enabled = (context.lanes ?? []).includes(name);
    let processes = null;
    if (connected && enabled) {
      try { processes = (await context.executor.call('studio.processes', { image: LANES[name].studioProcess }))?.processes ?? []; }
      catch (error) { processes = { error: error.code ?? error.message }; }
    }
    const entry = { lane: name, enabled, serverKernel: info.kernel?.[name] ?? null, agentStudio: info.studios?.[name]?.installed?.version ?? null,
      compatible: info.compatible?.[name] ?? null, studio: { image: LANES[name].studioProcess, open: Array.isArray(processes) && processes.length > 0, processes },
      catalog: catalog(name) };
    if (name === 'o11') {
      const record = context.executor.o11Connection();
      entry.connection = record ? { pid: record.pid, startedUtc: record.startedUtc, studioVersion: record.studioVersion, connectedAt: record.connectedAt,
        ...(record.warning ? { warning: record.warning } : {}) } : null;
      if (!record && connected && enabled) entry.continuation = { tool: 'ssam_connect', arguments: { lane: 'o11' },
        why: 'Ask the user to open Service Studio normally, then connect it; connecting needs no save, publish or restart.' };
      if (enabled) entry.reservations = hostedReservations(context);
    }
    // C32: a lane this account does not have is information (ok:null), never a failure of the doctor.
    entry.ok = !enabled ? null : connected && entry.compatible?.ok === true && entry.studio.open && (name !== 'o11' || entry.connection !== null);
    if (enabled && entry.ok === false && connected && !entry.continuation) entry.continuation = laneContinuation(name, entry);
    lanes[name] = entry;
  }
  const enabledLanes = Object.values(lanes).filter(l => l.enabled);
  const report = { ok: connected && enabledLanes.length > 0 && enabledLanes.every(l => l.ok === true), hosted: true, customer: context.customer ?? null, agent, lanes,
    studiosOpen: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.studio.open])) };
  const { networkCheck, uploadsHint } = await import('./hosted/network-check.mjs');
  const slow = uploadsHint(link);
  if (slow) agent.uploads = slow.uploads;
  if (network === true) report.network = await networkCheck(link);
  else if (slow) report.network = { ran: false, code: slow.code, message: slow.message, continuation: slow.continuation };
  if (!report.ok) {
    // The continuation follows the real state: the agent first, then the first enabled lane that is not usable.
    const refused = !connected ? agentNotConnected(info) : null;
    report.code = refused?.code === 'AGENT_RECONNECTING' ? 'AGENT_RECONNECTING' : 'DOCTOR_LANE_UNUSABLE';
    report.continuation = refused?.continuation ?? enabledLanes.find(l => l.ok !== true)?.continuation
      ?? { tool: 'ssam_doctor', arguments: {}, why: 'This account has no lane enabled on this server; ask the server owner.' };
  }
  return report;
}

// The next call for an enabled lane that is not usable (C32), from its state: the Studio closed, then the versions.
function laneContinuation(name, entry) {
  const studio = name === 'odc' ? 'ODC Studio' : 'Service Studio';
  if (entry.compatible && entry.compatible.ok === false) return { tool: 'ssam_doctor', arguments: { lane: name },
    why: (entry.compatible.message ?? entry.compatible.code ?? 'different versions') + ' The doctor shows the versions of both sides.' };
  if (!entry.studio?.open) return { tool: 'ssam_connect', arguments: { lane: name }, why: 'Open ' + studio + ' normally (and sign in), then call ssam_connect; nothing is saved, published or restarted.' };
  return { tool: 'ssam_connect', arguments: { lane: name }, why: studio + ' is open: connect it; nothing is saved, published or restarted.' };
}

// The module reservations of a hosted customer (16th release, I8/A28): the kernel deliveries of this customer run with
// ANVIL_AUTHORITY_DIR = <ws>/state/relay-authority (executor.mjs hostedSpawnEnv), so its reservations live there; the
// owner's authority is never listed or released. A reservation is named by its file name only (its folder is the
// server's and is never shown); release looks that name up in the customer's folder alone.
const hostedAuthorityEnv = context => ({ ANVIL_AUTHORITY_DIR: path.join(context.workspace, 'state', 'relay-authority') });
const byFileName = value => JSON.parse(JSON.stringify(value, (key, v) => ((key === 'file' || key === 'reservation') && typeof v === 'string' ? path.basename(v) : v)));
export function hostedReservations(context) {
  try {
    const listed = moduleReservations({ env: hostedAuthorityEnv(context), readUserEnvironment: () => null });
    return byFileName({ active: listed.active, activeTotal: listed.activeTotal });
  } catch (error) { return { error: error.message }; }
}
export function hostedRelease(freeing, { context }) {
  const reservation = typeof freeing?.reservation === 'string' ? path.basename(freeing.reservation.replace(/^ws:/, '')) : freeing?.reservation;
  return byFileName(releaseReservation({ ...freeing, reservation }, { env: hostedAuthorityEnv(context), readUserEnvironment: () => null }));
}

// The paragraph a hosted session adds to the instructions (docs/FASE2-AGENTE.md 10.7). a8 review (M1): its ssam_code
// sentence follows the one switch (hosted/served.mjs, the class of ssam_code in hosted/tools.json); off, the paragraph and
// the rules are the ones of the line before ssam_code was served hosted, word for word (HOSTED_*_CODE_OFF).
const hostedParagraph = code => 'This SSAM server is hosted: it runs on the SSAM owner\'s machine and drives the user\'s own '
  + 'Studios through the SSAM agent on the user\'s machine. ssam_debug, ssam_debug_run, ssam_debug_invoke, context, propose, '
  + 'continue and status are unavailable here (HOSTED_UNAVAILABLE). Files are named ws:<path> (the workspace of this account on '
  + 'the server: ODC files under ws:odc/, O11 files under ws:o11/, files the user delivered under ws:inbox/); pass them back '
  + 'exactly as returned. A file from the user\'s machine reaches SSAM when the user puts it in the agent inbox folder and you '
  + 'pass agent:inbox/<file>. Before any O11 tool, connect the Service Studio with ssam_connect {lane:"o11"}. When the agent is '
  + 'not connected, tools that need the user\'s Studio answer AGENT_NOT_CONNECTED; ssam_doctor shows the agent and the Studio '
  + 'versions of both sides. ' + code + ' The generator ops not offered here yet (entity-actions, '
  + 'rest-consume, screen with data.generate) are refused (GENERATOR_PENDING). No credential window opens here: odc_portal_login '
  + 'prompt and focus answer HOSTED_PROMPT_UNAVAILABLE.';
export const HOSTED_INSTRUCTIONS = hostedParagraph('ssam_code reads and writes the module as code here too, its texts inline (text, also); the files '
  + 'subagents write for it go in the agent inbox folder (an ssam_code plan names each one there and brings its prompts to the '
  + 'agent folder).');
export const HOSTED_INSTRUCTIONS_CODE_OFF = hostedParagraph('ssam_code is unavailable here too: read a module as text with ssam_map (views ddl, flow, html) and deliver '
  + 'the change as ONE job of o11_deliver or studio_deliver.');
// The working rules a hosted session adds (servidor/fase4: C26, C03 and the model behaviour of the first client session).
// fase4-24 (production test of 2026-10-11): a job goes INLINE, the job itself as compact JSON in the job argument. The MCP
// request goes straight to this server (up to 16 MiB), while a job file in the agent inbox costs one more upload from the
// user's machine through the agent (26.9 s for a 60 KB job on a lossy exit) and, written indented, 57% of its bytes were
// spaces. agent:inbox stays for the user's real files (OML, images, assets).
// servidor/fase4-24 (product speed package, integracao/velocidade): ONE job per module with every change of the request,
// and the kernel's normalizations (JobNormalizer: what it rewrote instead of refusing) come listed in the answer, never silent.
const hostedRules = inbox => 'Jobs: ONE job per module, with every change of the request for that module (separate jobs only for different modules, '
  + 'never one action or one step per call), sent inline in the job argument as compact JSON (no indentation), whatever its size: '
  + 'the call goes straight to this server (up to 16 MiB), so a large job is still one call, with no upload through the agent. '
  + 'Never write a job to a file for this server, never with a shell heredoc or a script; a correction is patch + basedOn (nextBasedOn of the answer). '
  + 'An answer lists normalizations {total, byRule, items} when the kernel rewrote a shape of the job instead of refusing it (a sort, a null, an '
  + 'entity segment): they are applied already; read them, never resend the job to undo or repeat them. '
  + inbox + '; an absolute path under '
  + 'the agent folder is taken as the same agent: path, any other path is refused with the exact folder. '
  + 'AGENT_RECONNECTING means the agent is reconnecting by itself: repeat the same call after retryAfterSeconds; ask the user to '
  + 'start the agent only when an answer says AGENT_NOT_CONNECTED. '
  + 'An approved prototype is ported 1:1 (html op plus its <style> in the theme), never replaced by OutSystems UI patterns; '
  + 'nothing is done until the app link (appLinks of the answer, or ssam_app_url) is given to the user. '
  + 'A subagent prompt loads the SSAM tools with ToolSearch before its first SSAM call.';
export const HOSTED_RULES = hostedRules('agent:inbox/<file> is only for the user\'s own files in the agent inbox folder (an OML, an image, an asset) and the code files of '
  + 'ssam_code subagents');
export const HOSTED_RULES_CODE_OFF = hostedRules('agent:inbox/<file> is only for the user\'s own files in the agent inbox folder (an OML, an image, an asset)');
// The instructions of one hosted session: the paragraph, the rules and, when the agent reported its folder (Hello), the inbox.
// a8 review (M1): served or not by the catalog the session's gate reads (hosted.tools in a test, else hosted/tools.json).
export function hostedInstructions(hosted) {
  let root = null;
  try { root = (hosted?.session?.agent ?? hosted?.context?.agent)?.info?.()?.agentRoot ?? null; } catch { root = null; }
  const inbox = typeof root === 'string' && root ? ' The agent inbox folder of this account is ' + agentJoin(root, 'inbox') + '.' : ' ssam_doctor shows the agent inbox folder (agent.inbox).';
  return codeServedHosted(hosted?.tools ?? null)
    ? HOSTED_INSTRUCTIONS + ' ' + HOSTED_RULES + inbox
    : HOSTED_INSTRUCTIONS_CODE_OFF + ' ' + HOSTED_RULES_CODE_OFF + inbox;
}

// The gate of each tool of a hosted session (hosted/policy.mjs), set by createSsamServer and used by registerServedTool.
// servidor/fase4-24 (R1): options.argsOf is the input layer's (relaxTool): the gate confines and hands the handler the
// arguments the tool runs, never only the ones sent ({targt} runs as target, so it is confined as target).
const servedGates = new WeakMap();
// kernelRefused (startupKernel): the lanes this server image refused at start; the gate refuses every tool of such a
// lane, the server-only ones included (KERNEL_UNAVAILABLE, cause KERNEL_VERSION_MISSING).
// tools: the hosted classification (default hosted/tools.json); tests pass another one.
// presentation (a7 phase 4, tests): the presenter's view of the server layout ({workspace, serverRoots, pathApi}: the Linux
// image's paths with path.posix on another machine); without it, this server's own roots and path flavor.
async function hostedGate({ context, session, run, kernelRefused = null, tools, presentation = null }) {
  const { wrapHostedTool } = await import('./hosted/policy.mjs');
  const runner = run ?? (await import('./executor.mjs')).runWithExecutor;
  const link = session?.agent ?? context.agent;
  const lanes = session?.lanes ?? context.lanes ?? [];
  return (name, config, handler, { argsOf = null } = {}) => wrapHostedTool(name, config, handler, { context, link, lanes, run: runner, argsOf, kernelRefused,
    ...(tools ? { tools } : {}), ...(presentation ? { presentation } : {}) });
}
// The lanes the hosted server warms at start: the served lanes, without a lane its image refused (its kernel never runs).
export const hostedWarmLanes = (lanes = {}, refused = null) => ['odc', 'o11'].filter(l => lanes[l] !== false && !refused?.[l]);
// A tool the served mode adds outside the SSAM shaper (ssam_friction): through the hosted gate when the server has one.
export function registerServedTool(server, name, config, handler) {
  const gate = servedGates.get(server);
  // a7: the licensee's exposure rule first (a licensee's server; the owner's returns the handler), then the gate.
  const exposed = typeof server.ssamExposeHandler === 'function' ? server.ssamExposeHandler(name, handler) : handler;
  return Object.getPrototypeOf(server).registerTool.call(server, name, config, gate ? gate(name, config, exposed) : exposed);
}

// ---- Manage Dependencies inputs of the job tools. A binding name is what a job's `reference` op names as producer;
// paths must be absolute (run_job.py resolves them against its own cwd otherwise). A capture is a live READ through
// the lane's logged-in Studio (read-only lease, no credential file); it never writes to the environment.
// fix/system-reference: a binding name is also the Studio's form of a system producer, (System) (producer-names.mjs).
export const producerSchema = {
  producers: { type: 'object', additionalProperties: { type: 'string' },
    description: 'Producer bindings {Name: absolute path of a frozen producer .oml or .avsig}, as --producer Name=path.' },
  captureProducers: { type: 'array', items: { type: 'string' },
    description: 'Producers to capture read-only before the job (anvil signature): "Name" or "Name=Producer" (e.g. "System=(System)").' },
};
// names (fix/a5-lows, B10): the job's producer names; a binding name with / or \ that no op writes exactly is refused (every
// such name without names; names: null only where the caller checks them against its job).
export function producerArgs(producers = {}, captureProducers = [], { names } = {}) {
  const args = [];
  const separated = names === null ? [] : separatorKeyProblems(Object.keys(producers ?? {}), names);
  if (separated.length) throw new Error(separated.map(p => p.error).join(' '));
  for (const [name, file] of Object.entries(producers ?? {})) {
    const key = slotKeyOf(name);
    if (key == null) throw new Error('Invalid producer binding name: ' + name);
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Producer ' + name + ' needs an absolute path');
    args.push('--producer', key + '=' + file);
  }
  for (const entry of captureProducers ?? []) {
    const [name, producer] = String(entry).split(/=(.*)/s);
    if ((producer === undefined ? listedKeyOf(name) : bindingKeyOf(name)) == null || producer === '') throw new Error('Invalid captureProducers entry: ' + entry);
    if (Object.keys(producers ?? {}).some(k => sameProducer(k, name))) throw new Error('Producer ' + name + ' is both bound and captured');
    args.push('--capture-producer', String(entry));
  }
  return args;
}

// o11_data: --studio runs it through the connected Studio's own session (kernel DataCommand.RunThroughStudio, SSO included);
// --host then only checks that Studio's environment. Never the vault path of the same verb.
export const o11DataArguments = ({ host, module, oml }, request, work) =>
  ['--studio', '--host', host, '--module', module, '--oml', path.resolve(oml), '--request', request, '--work', work];

// The o11_data request (I12): one op, or {authorization?, batch:[op]} with a step name per op; an attribute value or an
// id may be {"$ref": "<step>"} (the record an earlier insert of exactly one record created) or "<step>#<i>" (its i-th
// record, base 0). The kernel (DataCommand) resolves the references and stops the batch before an op whose reference is
// unknown or still ahead (DATA_REF_UNRESOLVED); this schema only lets the shape through.
const dataRef = { type: 'object', required: ['$ref'], properties: { $ref: { type: 'string', minLength: 1 } }, additionalProperties: false,
  description: 'The record id an earlier insert of the same batch created: "<step>" (an insert of one record) or "<step>#<i>" (base 0).' };
// The operation of a batch op is checked by pattern, the same five values as the enum of a single request: the verb of an
// o11_data call is routed by request.operation (catalog/tools.json), and a second enum would be a second verb selector.
const DATA_OPERATIONS = ['read', 'read-all', 'insert', 'update', 'delete'];
// The read limits of the kernel (EnvironmentData.ReadLimits): default rows and cap of one read-all call.
const DATA_DEFAULT_ROWS = 2000; const DATA_ROW_CAP = 10000;
const dataOp = (batch) => ({ type: 'object', required: ['operation', 'entity'], properties: {
  operation: batch ? { type: 'string', pattern: '^(' + DATA_OPERATIONS.join('|') + ')$', description: DATA_OPERATIONS.join(' | ') } : { type: 'string', enum: DATA_OPERATIONS },
  entity: { type: 'string' },
  operationId: { type: 'string' }, authorization: { type: 'string' }, records: { type: 'array', items: { type: 'object' } },
  confirmationToken: { type: 'string', minLength: 1, description: 'delete: the token of its preview (the execution, without ids; the owner\'s reply names the entity and states the number of records). ' + DESTRUCTIVE_SUFFIX }, ownerRequest: { type: 'string', minLength: 1, description: "delete preview: the owner's request, verbatim (kept only as a sha256)" },
  ids: { type: 'array', items: batch ? { anyOf: [{ type: 'string' }, dataRef] } : { type: 'string' } }, offset: { type: 'integer', minimum: 0 }, tenantId: { type: 'integer' },
  // P3 (2026-10-08): a read-all answers at most limit rows per call within deadlineMs; an incomplete answer carries the
  // offset to continue from (continuation). Every page has its own hard timeout in the kernel.
  limit: { type: 'integer', minimum: 1, maximum: DATA_ROW_CAP, description: `read-all: at most this many rows in one call (default ${DATA_DEFAULT_ROWS}); continue from the answer's continuation.offset.` },
  deadlineMs: { type: 'integer', minimum: 1000, maximum: 120000, description: 'read/read-all: the call stops reading at this many ms (default 60000) and says where to continue.' },
  ...(batch ? { step: { type: 'string', minLength: 1, description: 'The name later ops of the batch use in {"$ref": "<step>"}.' } } : {}),
  ...(batch ? {} : {
    // CX13 review 6 (listing budget): the load validates its options itself (one refusal with everything, before any write; delimiter,
    // files, columns and references only after the schema and the files are read),
    // so they are listed with their cheapest schema.
    close: {}, // {preview:true}, then {previewSha256, authorize}: stated in the tool text
    confirmUpdates: {type:'object',properties:{previewSha256:{type:'string'},authorize:{type:'string'}},
      description:"Overwrites of existing rows: the updatePreview sha256 and the owner's next message after that preview, verbatim, stating its number of rows."},
    files: { type: 'array', items: { type: 'string' } }, columns: {}, references: {}, // objects; the load refuses any other value
    keys: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    insertMissing: { type: 'boolean' }, batchSize: { type: 'integer' }, delimiter: { type: 'string' }, dryRun: { type: 'boolean' },
  }),
}, additionalProperties: false });
export const o11DataRequestSchema = { anyOf: [dataOp(false), { type: 'object', required: ['batch'], properties: {
  authorization: { type: 'string', description: "The user's own words for every write of the batch." },
  batch: { type: 'array', minItems: 1, items: dataOp(true) },
}, additionalProperties: false }] };
const dataWrites = request => (Array.isArray(request?.batch) ? request.batch : [request]).some(op => !op?.dryRun && ['insert', 'update', 'delete'].includes(op?.operation));
// The answer of one o11_data call, from the runner's result (worker or cold): the CLI envelope as `result`, with its
// code and problems lifted to the top for the refusal. A request written to the worker with no reply is an unknown
// outcome: never repeated here; the same request with the same operationId reconciles it from its receipt.
// A read that stopped early (row limit, deadline, page timeout: EnvironmentData.ReadPaged) answers complete:false and the
// exact next call: the same read from the offset the kernel gave (call = {host, module, oml} of this call).
function dataContinuation(envelope, request, call) {
  const results = (envelope?.data && typeof envelope.data === 'object' ? envelope.data : envelope)?.results;
  if (!Array.isArray(results)) return null;
  const index = results.findIndex(x => x && typeof x === 'object' && Number.isInteger(x.continuation?.offset));
  if (index < 0) return null;
  const op = (Array.isArray(request?.batch) ? request.batch : [request])[index];
  if (!op || !['read', 'read-all'].includes(op.operation)) return null;
  const { step, ...read } = op;
  return { complete: false, continuation: { tool: 'o11_data', arguments: { ...(call ?? {}), request: { ...read, offset: results[index].continuation.offset } },
    why: String(results[index].next ?? results[index].error ?? 'the read stopped early; the same read from this offset goes on').slice(0, 600) } };
}

export function o11DataAnswer(r, request = {}, call = null) {
  if (r?.unknown || (r?.timedOut && !r?.envelope)) return { ok: false, lane: 'o11', verb: 'data', code: r.code ?? 'DATA_OUTCOME_UNKNOWN', stage: 'data',
    ...(dataWrites(request) ? { outcome: 'uncertain' } : {}), error: String((r.stderr ?? []).join(' ') || 'the data command got no answer').slice(0, 600),
    next: 'repeat the same request with the same operationId: its receipt reconciles the write; never a new operationId' };
  const envelope = r?.envelope ?? null;
  const value = { ok: r?.ok === true, lane: 'o11', verb: 'data', via: r?.via ?? 'process', ...(Number.isFinite(r?.wallMs) ? { wallMs: r.wallMs } : {}),
    ...(r?.workerNote ? { worker: r.workerNote } : {}) };
  if (!envelope) return { ...value, exitCode: r?.exitCode ?? 1, ...(r?.stdout ? { stdout: r.stdout } : {}), ...(r?.stderr?.length ? { stderr: r.stderr.slice(-10) } : {}) };
  if (!value.ok) {
    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
    for (const k of ['code', 'problems', 'differences']) { const v = envelope[k] ?? data[k]; if (v !== undefined) value[k] = v; }
    // The error as the CLI wrote it: a text (cut at 2000 characters) or an object {code, message} whose code is lifted.
    const error = envelope.error ?? data.error;
    if (typeof error === 'string' && error) value.error = error.slice(0, 2000);
    else if (error && typeof error === 'object') { value.error = error; if (value.code === undefined && typeof error.code === 'string') value.code = error.code; }
  }
  return { ...value, ...(dataContinuation(envelope, request, call) ?? {}), result: envelope };
}

// A job given inline (object or array of ops) becomes a file under <root>/.local/jobs/inline, the path a lane
// tool expects; the model never has to write the file itself.
export function writeInlineJob(root, job) {
  const directory = path.join(root, '.local', 'jobs', 'inline');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, randomUUID() + '.json');
  // The ssam_code op aliases (op "ddl", logic data.text) in their kernel form (ssam-code.mjs normalizeCodeOps).
  fs.writeFileSync(file, JSON.stringify(normalizeCodeOps(job).job, null, 2));
  return file;
}
const inlineJobSchema = { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
  description: 'Path of the job JSON (absolute or relative to the Anvil root), or the job itself ({ops:[...]} or an array of ops).' };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok ? {} : { isError: true }) });

// ---- The relay to the ODC lane server (C10). A Studio command may run for minutes (merge, publish --wait, studio_wait):
// the SDK's default of 60 s cut answers that were coming, and the relay then hid the verdict. The relay waits up to 30
// min, every progress notification of the lane server restarts that wait and reaches the outer client (when its
// request carries a progressToken), and the outer client's cancellation reaches the lane server. A relay that still
// ends without an answer says so with its own code (TIMEOUT | CANCELLED, "uncertain" for a write) and the status read of
// the Studio as the next call. Only the outer deadline layer returns a same-tool continuation, which waits for the answer.
export const RELAY_TIMEOUT_MS = 1_800_000;
export function relayOptions(ctx, { timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  const outer = ctx?.mcpReq;
  const token = outer?._meta?.progressToken;
  return { timeout: timeoutMs, resetTimeoutOnProgress: true,
    onprogress: progress => {
      if (token === undefined || typeof outer?.notify !== 'function') return;
      outer.notify({ method: 'notifications/progress', params: { ...progress, progressToken: token } }).catch(() => {});
    },
    ...(outer?.signal ? { signal: outer.signal } : {}) };
}
export function relayFailure(error, { tool, args = {}, signal, timeoutMs = RELAY_TIMEOUT_MS, statusTool = 'studio_status' } = {}) {
  const cancelled = signal?.aborted === true;
  const timedOut = !cancelled && (error?.code === 'REQUEST_TIMEOUT' || /timed out/i.test(String(error?.message ?? '')));
  const write = isMutation(tool, args);
  const pid = Number.isSafeInteger(args?.pid) ? { pid: args.pid } : {};
  const continuation = statusTool === 'studio_status'
    ? { tool: 'studio_status', arguments: pid, why: 'the Studio may still be running it: read its state before anything else; never repeat a write' }
    : { tool: statusTool, arguments: { lane: 'odc' }, why: 'the Studio may still be running it: read the lane state before anything else; never repeat a write' };
  // CX15 r2 (C2/T5): a destructive execution (it carries a confirmationToken) is read by the record of its operation.
  const task = write ? taskStepOfCall(args) : null;
  const code = cancelled ? 'CANCELLED' : timedOut ? 'TIMEOUT' : 'RELAY_FAILED';
  const what = cancelled ? 'was cancelled by the client before the ODC lane answered'
    : timedOut ? 'got no answer from the ODC lane within ' + Math.round(timeoutMs / 60000) + ' min'
      : 'lost the ODC lane before its answer (' + String(error?.message ?? error).slice(0, 300) + ')';
  return { ok: false, code, stage: 'relay', tool, ...(write ? { outcome: 'uncertain' } : {}),
    // Junction (M6 adjustment 5): the stop route of an execution still running on the server is named, never promised.
    error: tool + ' ' + what + (task ? `; the execution stops before its next send once the cancellation reaches it; if it still runs on the server (kept past its 25 s wait), ssam_task {id:"${task.arguments.id}", stop:true} stops it. Its record says what was sent: read ssam_task {id:"${task.arguments.id}"} before telling the owner anything, never repeat it.` : write ? '; the write may have completed in the Studio: its outcome is read, never repeated.' : '.'),
    ...(task ? { stop: { tool: 'ssam_task', arguments: { id: task.arguments.id, stop: true }, why: 'stops the execution if it still runs on the server (kept past its 25 s wait); then read its record' } } : {}),
    continuation: task ?? continuation };
}

// ---- The answer ceiling (C19, I8). An answer above SSAM_MAX_ANSWER_BYTES (context-budget.mjs) never reaches the client whole: it
// is kept in <anvilRoot>/.local/answers/<sha256>.json (a root ssam_evidence reads) and the client gets the top-level
// scalars, paged {bytes, file, sha256} and the ssam_evidence call that reads the file. A tool with its own byte budget
// gets the budget held under the ceiling before the call instead, so its answer fits and is not paged. ssam_evidence is
// the reader of those files and also observes the shared ceiling. Hosted, the file is the customer's
// <ws>/o11/answers/<sha256>.json (the visible area: ws:o11/answers/..., read back only by that customer's ssam_evidence).
// The ceiling and its margin come from context-budget.mjs.
// budgetBytes (ssam_discover, ssam_map, studio_*) and budget (o11_inspect, characters of the inline answer) alike.
export function clampBudget(args, maxBytes) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const ceiling = budgetCeiling(maxBytes);
  let clamped = args;
  for (const key of ['budgetBytes', 'budget']) if (typeof clamped[key] === 'number' && clamped[key] > ceiling) clamped = { ...clamped, [key]: ceiling };
  return clamped;
}
const answerBytes = result => {
  const text = (result.content ?? []).filter(c => c?.type === 'text').reduce((n, c) => n + Buffer.byteLength(String(c.text ?? ''), 'utf8'), 0);
  const structured = result.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent) ?? '', 'utf8');
  return Math.max(text, structured);
};
// directory: where the file goes (default <root>/.local/answers; a hosted session passes the customer's <ws>/o11/answers).
// origin {tool, kind?}: whose answer is kept (a licensee's server), so ssam_evidence reads the page back as that answer.
export function pageAnswer(result, { root = anvilRoot, directory = path.join(root, '.local', 'answers'), maxBytes = maxAnswerBytes(), origin = null } = {}) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  const bytes = answerBytes(result);
  if (bytes <= maxBytes) return result;
  let full = result.structuredContent;
  if (full === undefined) {
    const texts = result.content.filter(c => c?.type === 'text');
    if (texts.length === 1) { try { full = JSON.parse(texts[0].text); } catch { full = { text: texts[0].text }; } }
    else full = { content: result.content };
  }
  const { file, sha256 } = keepAnswer(full, root, origin, { directory });
  // What stays inline (paged-answer.mjs pagedShape): the top-level scalars (texts cut at 500 characters) and the small
  // parts, in their order, within PAGED_INLINE_BYTES (the answer's own continuation moves to answerContinuation); every
  // large array as a table in paged.tables, whole or without its opaque columns, in the room under the ceiling; the parts
  // that are not inline whole in paged.outline; and ONE ssam_evidence call that returns what is still missing (the
  // owner's re-test of 2026-10-12: the 85 KB producer listing took five ssam_evidence calls).
  const shape = pagedShape(full, { roomBytes: maxBytes - 1600 - Buffer.byteLength(file, 'utf8') * 4, inlineBytes: PAGED_INLINE_BYTES });
  let { tables, outline, missing } = shape;
  const build = () => {
    const call = missingCall(file, missing);
    return { ...shape.top, paged: { bytes, file, sha256, ...(outline.length ? { outline } : {}), ...(tables.length ? { tables } : {}), complete: !call },
      ...(call ? { continuation: { ...call, why: 'the whole answer (' + bytes + ' bytes, above the ' + maxBytes + '-byte ceiling) is in this file; ' + call.why } } : {}) };
  };
  let value = build();
  // Never above the ceiling: the tables go first (their rows become the call), then the outline.
  const size = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (size(value) > maxBytes && tables.length) {
    missing = [...tables.map(t => ({ at: t.at, rows: t.rows.length })), ...missing.filter(m => !tables.some(t => t.at === m.at))]; tables = []; value = build();
  }
  if (size(value) > maxBytes && outline.length) { outline = []; value = build(); }
  // Very wide objects can make the recovery-call list itself exceed the ceiling.
  // Keep one exact root reference instead; the evidence reader owns its pagination.
  if (size(value) > maxBytes) {
    shape.top = { ...(typeof full?.ok === 'boolean' ? { ok: full.ok } : {}), ...(typeof full?.code === 'string' ? { code: full.code.slice(0, 500) } : {}) };
    tables = []; outline = []; missing = [{ at: '' }]; value = build();
  }
  if (value.ok === undefined) value.ok = result.isError !== true;
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(result.isError || value.ok === false ? { isError: true } : {}) };
}
const PAGED_INLINE_BYTES = 6144;

// ---- The discover index of each lane, built in the background when the MCP server starts (C38), so the first
// ssam_discover does not build it (39-46 s in the sessions). Never awaited by a call and never on createSsamServer (tests);
// SSAM_NO_WARM=1 turns it off. A lane that cannot build is logged and recorded as friction; the call that needs the
// index later reports the same error itself. `ssam warm` runs the same build in the foreground (scripts/build.ps1).
export async function warmIndexes({ lanes = ['odc', 'o11'], build, log = text => process.stderr.write(text + '\n'), friction } = {}) {
  const buildIndex = build ?? (await import('./discovery.mjs')).buildIndex;
  const results = {};
  for (const name of lanes) {
    const started = Date.now();
    try {
      const built = await buildIndex(name);
      results[name] = { ok: true, cache: built?.cache?.hit === true ? 'hit' : 'built', ms: Date.now() - started };
    } catch (error) {
      results[name] = { ok: false, error: String(error?.message ?? error).split(/\r?\n/)[0].slice(0, 400), ms: Date.now() - started };
      log(JSON.stringify({ ssam: 'warm', lane: name, ok: false, error: results[name].error }));
      try {
        const store = friction ?? await import(pathToFileURL(path.join(workspaceRoot, 'facade', 'friction-store.mjs')).href).catch(() => null);
        await store?.recordEvent?.({ operation: 'warm', lane: name, code: 'WARM_INDEX_FAILED', step: 'build', outcome: 'failed' });
      } catch { /* friction never changes the warm-up */ }
    }
  }
  return { ok: Object.values(results).every(r => r.ok), lanes: results };
}

// ---- MCP: the tools of both lanes on one stdio server (brief T2a).
const proxyName = (name, lane) => name; // names do not collide today; a collision adds the `lane` argument below.
// fix/no-internals round 4: the exposure decision of each call that detached, by task folder and id (exposeHandler).
const detachedDecisions = new Map();
// fix/no-internals round 5 (D12): the day's reservation of each limited call that detached, by task folder, id and caller,
// held until the continuation that delivers the final answer to that caller has recorded its bytes (exposeHandler).
const heldReservations = new Map();
// fix/no-internals round 5: a decision expires a day after it was made (a call never continued).
const DECISION_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// hosted = {context, session, run?}: a session of the hosted server (docs/FASE2-AGENTE.md 10.7). Every tool then passes
// the hosted gate (hosted/policy.mjs) and its data stays in the customer's workspace. Without it, nothing changes.
// profile (CX11, server-profiles.mjs): the tools this server serves. Hosted (servidor/fase4-26 a7, D6 of the a6 plan) the
// server serves the profile all whatever is asked, so the hosted tools/list keeps every tool of hosted/tools.json.
export async function createSsamServer({ o11 = true, odc = true, profile = 'app', deps = {}, hosted = null } = {}) {
  if (hosted) profile = 'all';
  const { McpServer } = await import('@modelcontextprotocol/server');
  const { InMemoryTransport, fromJsonSchema } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const gate = hosted ? await hostedGate(hosted) : null;
  // T2 (CX15 review): the hosted listing says first which part of a tool is off (deleting); a local server lists as before.
  const listing = hosted ? (await import('./hosted/destructive.mjs')).hostedListing : null;
  // servidor/fase4-26 (C): the call deadline runs in the customer's real context (executor.mjs runWithExecutor), whatever
  // runner the gate is given (tests pass hosted.run, which the gate keeps for the handler alone).
  const inContext = hosted ? (await import('./executor.mjs')).runWithExecutor : null;
  const workspaceOf = (...segments) => path.join(hosted.context.workspace, ...segments);

  // The instructions are paid on every turn of every session (docs/CONTEXTO-FIXO.md): only what routes the session.
  // What a tool's own description or ssam_discover already says (arguments, verbs, answer shapes) is not repeated here.
  const selectedProfile = serverProfile(profile);
  // fix/no-internals: the exposure of this server (exposure.mjs): owner (today's answers) or licensee (no internals).
  // deps.exposure {profile?, handleRoots?}; else SSAM_EXPOSURE, owner when unset (a hosted server passes licensee).
  // servidor/fase4-26 a7 (no-internals list item 6): a hosted session is a licensee's, whatever the environment says.
  const exposure = hosted ? 'licensee' : deps.exposure?.profile ?? exposureOf(process.env);
  // servidor/fase4-25: while ssam_code is unavailable hosted (D1 a), a hosted session is never told to use it (the rules of
  // server-instructions.mjs without it); a8: served hosted, the same rules as a local session (hosted/served.mjs). The hosted
  // paragraph and rules (hostedInstructions) follow.
  const serverOptions = { instructions: serverInstructions({ profile, hosted: hosted ? { tools: hosted.tools ?? null } : false }) + (exposure === 'licensee' ? ' ' + LICENSEE_INSTRUCTION : '')
    + (hosted ? ' ' + hostedInstructions(hosted) : '') };
  const server = deps.server ?? new McpServer({ name: selectedProfile.name, version: '0.2.0' }, serverOptions);
  server.ssamInstructions = serverOptions.instructions;
  if (gate) servedGates.set(server, gate);
  // Every answer of this server, whichever module registered the tool (ODC proxies included), leaves through one
  // shaper (responses.mjs): shell hints become the MCP call that does the same, and a delivery that merged exactly
  // answers only "entregue". An elicitation round (input_required) passes untouched.
  // Inside the shaper, the Studio write lock (studio-write-lock.mjs): two writes on the same Studio never overlap, the
  // second waits its turn in the machine-wide queue and answers with `queue` (STUDIO_WRITE_QUEUE_TIMEOUT, shaped like any
  // refusal, only after the bounded wait SSAM_WRITE_QUEUE_MS), reads never wait.
  // deps.lock: o11Root, odcRoot, o11Lane, connection, now, staleMs, alive, queueMs (tests and the bench keep the locks in a
  // sandbox). The timeout refusal names the status read of that Studio; a server that does not serve it (one lane only) names
  // ssam_doctor of that lane instead, which every server serves.
  // Then the answer ceiling (pageAnswer): a budgeted tool gets its budget held under the ceiling before the call; any
  // answer still above it is kept in a file and paged. The request context's signal reaches the lock (I7).
  // Before all of it, two layers of the atritos 2 package. The input layer (I1, tool-input.mjs of lane F7a, loaded when it
  // exists; deps.toolInput in tests): relaxTool relaxes the limits the SDK would refuse and normalizes the arguments in the
  // handler (inputAdjusted), so a budget or a list above its limit is adjusted instead of refused. And the release check
  // (A10): the identity of the release under this server (server-identity.mjs) is read again on every call (short cache);
  // once it differs from the one the server started with, every tool answers RELEASE_CHANGED before any action, with the
  // restart as next step, except ssam_doctor, ssam_evidence and the ssam_task read, which still answer.
  const register = deps.registerTool ?? server.registerTool.bind(server);
  const served = new Set();
  const maxBytes = deps.maxAnswerBytes ?? maxAnswerBytes();
  // Paged answers: <anvilRoot>/.local/answers; hosted, the customer's <ws>/o11/answers (the visible area, read back by
  // ssam_evidence of the same customer only), whatever deps say.
  const answersRoot = deps.answersRoot ?? anvilRoot;
  const answersDirectory = () => (hosted ? workspaceOf('o11', 'answers') : path.join(deps.answersRoot ?? anvilRoot, '.local', 'answers'));
  // CX12 call deadline. Its task records follow the workspace (tasksDir: <ws>/o11/tasks hosted, this server is created in
  // the customer's context). Hosted (servidor/fase4-26, B): the answer of a detached task is kept with the paged answers of
  // the same customer (ws:o11/answers), never in <anvilRoot>/.local/answers, which every customer of the server shares.
  // fix/no-internals round 4: the argsOf of each tool (the input layer), so whatever keeps an answer names whose answer it is
  // on the arguments the tool ran (keptOrigin below); a licensee's server only.
  const argsOfTool = new Map();
  // The replay of an unconfirmed final answer (replay-store.mjs createReplay; Integradora, 2026-10-18, review round 3), one
  // helper for the served handler here and on the hosted server: the deadlines join live calls by the inputs of a run-to-end
  // call (its print on the arguments the tool runs: argsOf, the defaults of its listed schema filled, and the files it reads;
  // null when one cannot be read for sure); the served handler replays on the arguments it runs.
  const inputSchemas = new Map();
  // Round 3c (M1): the paths a tool reads relative to a root it declares are read as the tool reads them: studio_deliver's
  // job (and a patch's basedOn.job) relative to the ODC lane root (the proxy below and kernel-delivery.mjs resolve it so).
  const relativeToOdcRoot = Object.freeze({ studio_deliver: ['job', 'basedOn.job'] });
  // servidor/fase4-26 a8: hosted, the replays live in the customer's task folder (tasksDir: ws:o11/tasks, this server is created
  // in the customer's context), never in <anvilRoot>/.local/tasks; and the gate is the one resolver: the served handler gets the
  // gate's arguments, and the deadline's inputs are read by the gate's own rules (hosted/policy.mjs replayInputs, below), never
  // relative to this server's ODC lane root (a file of the server would decide a customer's call).
  // a8 phase 7 (review vps-a8, M1): hosted, the prints read only the customer's own files (the visible area of the workspace,
  // the gate's own rule): never a file of the server or of another customer, and asynchronously, with ceilings
  // (replay-store.mjs replayPrintInside). A file the call names outside it gives no print: no join and no replay by content.
  const hostedMirror = hosted ? await import('./hosted/mirror.mjs') : null;
  const replays = createReplay({ folder: deps.tasksDir ?? tasksDir(answersRoot), windowMs: deps.replayWindowMs ?? REPLAY_WINDOW_MS,
    schemaOf: name => inputSchemas.get(name),
    ...(hosted ? { inside: file => hostedMirror.insideVisible(hosted.context.workspace, file), limits: deps.replayLimits ?? {} } : {}),
    resolve: hosted ? null : (name, args) => (relativeToOdcRoot[name] ? resolveRelativePaths(args, deps.odcRoot ?? LANES.odc.root, relativeToOdcRoot[name]) : args) });
  // servidor/fase4-26 a8 (rounds 3c, 3d): hosted, the deadline wraps the gate and sees the arguments as sent (ws:, agent:,
  // relative, a path of the agent's machine). For a run-to-end call it reads them as the gate does, without bringing or writing
  // anything (agent: by the sha256 the agent lists), so the same content joins the live call and other content is one
  // DELIVERY_STILL_RUNNING "changed". A call the gate refuses before the agent (a tool unavailable hosted; deleting,
  // o11_access apply; the prototype op, also in ssam_code...) is outside the family here: an identical call joins that refusal
  // (CX12). The gate and this read judge it by one function (hosted/policy.mjs refusalBeforeAgent, a8 phase 6).
  const hostedPolicy = hosted ? await import('./hosted/policy.mjs') : null;
  const agentRootOf = () => { try { return (hosted.session?.agent ?? hosted.context.agent)?.info?.()?.agentRoot ?? null; } catch { return null; } };
  const inputsOf = hosted
    ? async (name, raw) => {
      const args = runArgs(argsOfTool.get(name), raw ?? {});
      if (!runsToEnd(name, args) && !nestsDelivery(name, args)) return undefined;
      const tools = hosted.tools ?? hostedPolicy.hostedTools();
      const gate = { tools, raw: raw ?? {}, lanes: hosted.session?.lanes ?? hosted.context.lanes ?? [], kernelRefused: hosted.kernelRefused ?? null };
      // A call the gate refuses before the agent and any path (unavailable, deleting, the prototype op...) is outside the
      // family here: an identical call joins that refusal, never "a delivery is still running"; nothing is asked of the agent.
      if (hostedPolicy.refusedBeforePaths(name, args, gate)) return undefined;
      return replays.inputsOf(name, await hostedPolicy.replayInputs(name, args, hosted.context, { ...gate, agentRoot: agentRootOf() }));
    }
    : (name, raw) => replays.inputsOf(name, runArgs(argsOfTool.get(name), raw ?? {}));
  server.ssamInputsOf = inputsOf;
  const deadline = createCallDeadline({ root: answersRoot, ...(deps.tasksDir ? { dir: deps.tasksDir } : {}), timeoutMs: deps.callDeadlineMs, hasTool: name => served.has(name), defaultLane: o11 ? 'o11' : 'odc',
    // a7: hosted, the final answer of a detached call is kept in ws:o11/answers with the origin the exposure rule names.
    ...(hosted ? { saveAnswer: (full, root, origin) => keepAnswer(full, answersRoot, origin, { directory: answersDirectory() }) } : {}),
    notify: notification => server.server.notification(notification), inputsOf,
    ...(exposure === 'owner' ? {} : { answerOrigin: (name, args) => keptOrigin(name, runArgs(argsOfTool.get(name), args ?? {})) }) });
  // A cached surface waits through the bootstrap deadline; cold calls use this server's deadline.
  const activeTasks = () => [...new Map([...deadline.runningTasks(), ...(deps.activeDeadline?.()?.runningTasks() ?? [])].map(task => [task.id, task])).values()];
  const writeLock = deps.writeLock ?? withStudioWriteLock; // tests observe what reaches the lock (I7)
  const onBusy = lane => refusal => busyToolResult(served.has(refusal.continuation?.tool) ? refusal
    : { ...refusal, continuation: { ...refusal.continuation, tool: 'ssam_doctor', arguments: { lane: lane === 'odc' ? 'odc' : 'o11' } } });
  // In a hosted session the gate wraps all of it: a refused call never takes the lock, and the presented answer is the
  // shaped one.
  const toolInput = deps.toolInput ?? await import('./tool-input.mjs').catch(() => null);
  // deps.identity (tests): {read: () => identity (default serverIdentity()), started?: identity, cacheMs?, launchCwd?}.
  // C11 (atritos 3): the identity this process loaded (the launcher its parent loaded included) against the one on disk.
  const readIdentity = deps.identity?.read ?? (() => serverIdentity());
  const identityStarted = deps.identity?.started ?? (deps.identity?.read ? readIdentity() : serverIdentity({ loaded: true }));
  const release = releaseWatch({ started: identityStarted, read: readIdentity, cacheMs: deps.identity?.cacheMs ?? 2000 });
  const releaseExempt = (name, args) => name === 'ssam_doctor' || name === 'ssam_evidence' || (name === 'ssam_task' && args?.close == null);
  // The registered handler of every tool, as a client call reaches it (lock, release check, shaper, ceiling): ssam_code
  // writes through the delivery tool of its lane by this handler, never by a path of its own.
  const handlers = new Map();
  server.ssamHandlers = handlers;
  server.ssamConfigs = new Map();
  server.ssamTools = [];
  server.ssamOriginalTools = [];
  const { snapshotTool } = await import('./warm-start.mjs');
  // fix/no-internals: THE exit of every answer of this server (outside the call deadline, so a detached task's answer,
  // a refusal of the hub and a paged answer pass too): the exposure rule of exposure.mjs, once. The handlers map keeps the
  // inner handler (ssam_code reads a delivery's whole answer); the answer of the outer tool passes here. The handle roots:
  // the folders a later call takes a path back from (ssam_evidence's roots, this server's answers and tasks).
  // Only the work folders (.local, the module index): a catalog snapshot or a journal of the checkout is a server file.
  // a7 (no-internals list items 7 and 11): hosted, the one handle root is the customer's workspace (the gate's presenter
  // then shows each handle as ws:), the caller is the token, the day lives in ONE store per process (runServed passes it;
  // else <ws>/state/exposure), and the files whose answer a read names are the customer's own (its reference folders and
  // its ws:o11/answers).
  const handleRoots = hosted ? [hosted.context.workspace] : deps.exposure?.handleRoots ?? [...ssamPathRoots().filter(root => /[\\/]\.local(?:[\\/]|$)/.test(root)),
    ...(process.env.SSAM_MODULE_INDEX_ROOT ? [process.env.SSAM_MODULE_INDEX_ROOT] : []), path.join(answersRoot, '.local'), ...(deps.tasksDir ? [deps.tasksDir] : [])];
  // The licensee's reference by day (ssam-reference.mjs LICENSEE_REFERENCE): every answer's size per caller and day in
  // served-bytes.mjs (sizes only); a ssam_reference call past the day's bytes is one REFERENCE_DAY_LIMIT, nothing read.
  // deps.exposure {caller?: () => id, store?, dayBytes?, callBytes?}; else SSAM_EXPOSURE_CALLER (default "local"),
  // SSAM_REFERENCE_DAY_BYTES and SSAM_REFERENCE_CALL_BYTES.
  // Item 5 (telemetry): the read tools (served-bytes.mjs READ_TOOLS: ssam_reference, ssam_discover, ssam_evidence) are
  // metered per caller and day, sizes only; past alertBytes (SSAM_SERVED_ALERT_BYTES) a day's total writes one alert in the
  // day file and one line on stderr, once per caller and day; deps.exposure.onAlert(line) (the hosted quality record).
  const callerOf = hosted ? () => hosted.context.tokenId : deps.exposure?.caller ?? (() => process.env.SSAM_EXPOSURE_CALLER || 'local');
  const servedBytes = exposure === 'owner' ? null : (hosted ? hosted.exposure?.store : deps.exposure?.store)
    ?? servedBytesStore({ dir: hosted ? workspaceOf('state', 'exposure') : path.join(answersRoot, '.local', 'exposure') });
  const dayBytes = deps.exposure?.dayBytes ?? (Number(process.env.SSAM_REFERENCE_DAY_BYTES) || LICENSEE_REFERENCE.dayBytes);
  const alertBytes = deps.exposure?.alertBytes ?? (Number(process.env.SSAM_SERVED_ALERT_BYTES) || ALERT_BYTES);
  const onAlert = (hosted ? hosted.exposure?.onAlert : deps.exposure?.onAlert) ?? (line => process.stderr.write(line + '\n'));
  const answerBytes = result => (Array.isArray(result?.content) ? result.content : []).reduce((sum, part) => sum + (typeof part?.text === 'string' ? Buffer.byteLength(part.text, 'utf8') : 0), 0);
  // Round 2 (review MEDIUM 3): the day holds for every path that serves the reference: ssam_reference (a check of the
  // licensee's own job or delivery is never limited nor counted as reference) and ssam_evidence of a reference file (the
  // rest of a large reference answer, read in pages). The bytes of a limited call are reserved before it runs.
  const callBytes = deps.exposure?.callBytes ?? (Number(process.env.SSAM_REFERENCE_CALL_BYTES) || LICENSEE_REFERENCE.callBytes);
  // Round 3 (re-review MEDIUM B): a reference file is decided on its normalized path (reference-files.mjs), the same
  // answer for the day and for the exit rule's documentation mode. The folders are read per call (one may appear later).
  // Round 4 (re-review MEDIUM 2): the same function answers whose answer ANY file SSAM kept holds (fileOrigin): a reference
  // document is ssam_reference's; a kept answer (.local/answers: an omitted part, a paged answer, the final answer of a
  // detached call) names its tool and kind in its origin record; any other file is a run's evidence. servedOrigin is whose
  // answer a call serves ({tool, kind?}): ssam_evidence the answer of its file, every other tool its own. That one answer
  // meters the day, presents the answer at the exit, presents a file to the reader before any reading, and is kept with an
  // answer the call keeps for a later read.
  // The folders this server keeps answers in: hosted the customer's ws:o11/answers (answersDirectory), else <root>/.local/answers.
  const keptFolders = () => (hosted ? answerFolders({ directory: answersDirectory() }) : answerFolders({ root: answersRoot }));
  const fileOriginOf = file => fileOrigin(file, hosted
    ? { reference: referenceFolders({ folders: [workspaceOf('odc', '.local', 'reference'), workspaceOf('o11', 'reference')] }), answers: keptFolders() }
    : { reference: referenceFolders({ root: deps.reference?.root ?? anvilRoot, outDir: deps.reference?.outDir ?? null }), answers: keptFolders() });
  const servedOrigin = (name, args) => (name === 'ssam_evidence' ? fileOriginOf(args?.file) : null) ?? exposureOrigin(name, args);
  const meterOf = (name, origin) => (origin.tool === 'ssam_reference' ? (['check-job', 'check-delivery'].includes(origin.kind) ? 'ssam_reference:check' : 'ssam_reference') : name);
  // What an answer kept for a later read names as its origin (answer-size.mjs keepAnswer): a licensee's server only.
  const keptOrigin = (name, args) => (exposure === 'owner' ? null : servedOrigin(name, args));
  // The suite class names of this checkout (kernel/tests/**/*.cs), so a prose rule never takes a customer's name for one.
  const suiteNames = exposure === 'owner' ? null : (() => {
    const names = new Set();
    const walk = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of entries) { if (e.isDirectory()) { if (!['bin', 'obj', 'jobs', 'jobs-odc', 'html', 'fixtures'].includes(e.name)) walk(path.join(dir, e.name)); } else if (e.name.endsWith('.cs')) names.add(e.name.slice(0, -3)); } };
    walk(path.join(anvilRoot, 'tests'));
    // a7: the image ships no suite source (.dockerignore): without names, every Name...Tests of SSAM's documentation prose is
    // left out (the owner accepted a customer's name taken for one, 17/10).
    return names.size ? names : null;
  })();
  // Round 4 (re-review MEDIUM 1): the day and the exit rule read the arguments the tool RUNS (argsOf of the input layer:
  // what it renamed or coerced, under the name the tool knows, so {File}, {FILE}, {files} and {fi_le} of a read-only tool
  // are {file}), never the arguments as written. Arguments the layer refuses are read as sent.
  const runArgs = (argsOf, raw) => { try { return argsOf?.(raw) ?? raw; } catch { return raw; } };
  // ONE decision per call: the meter of the day it counts in and what the exit rule reads of it (the kind, and whose answer
  // the file ssam_evidence reads holds).
  // Round 6 (D15): the decision names the tool of the call, so only a continuation of that tool is the call.
  const decide = (name, args) => {
    const origin = servedOrigin(name, args);
    return { tool: name, metered: meterOf(name, origin), args: typeof args?.kind === 'string' ? { kind: args.kind } : {}, origin: origin.tool === name ? null : origin };
  };
  // Round 4 (re-review LOW 1): a continuation {continueTask} answers the call that detached, so it is decided as THAT call
  // (its meter, its kind, its file), never on its own arguments ({continueTask, lane} name no kind and no file). It is
  // never refused by the day: the call was admitted and the continuation reads nothing new; its bytes are counted. The
  // decision of a call that detached is kept by its task id for every server of this process on the same task folder
  // (detachedDecisions) and in <tasks>/.exposure/<id>.json (a continuation after a restart). (An unknown task: round 5, below.)
  // Round 5 (re-review round 4, LOW 1; D14 of the Integradora, 17/10): the decision keeps the callers the call was admitted
  // for (a digest of each caller id: no id reaches a decision file). A continuation by one of them is the call (D9: never
  // refused by the day, only counted). A continuation by any other caller, or of a task whose decision is unknown, is decided
  // as a new call on whose answer it serves: the reference day holds, its bytes are reserved and counted for that caller,
  // and when the call is still running that caller is admitted to it too.
  // Round 5 (the record of the re-review): the decision lives as long as the call, so <tasks>/.exposure never grows without
  // end. It is removed when the final answer has reached every caller the call was admitted for, and it expires a day after
  // it was made (a call never continued): an expired decision is ignored, and the folder is swept of them (and this process of
  // the reservations of past days) when a call detaches. A later continuation is a new call (D14), decided on whose answer
  // the task's kept final answer holds (its origin record, fileOriginOf, the one function of the day and the exit); a kept
  // answer whose origin is unknown is never served on a licensee's server (ANSWER_ORIGIN_UNKNOWN, D13). A task without a kept
  // answer (still running, or ended without one) is decided on the tool alone.
  // a7: hosted, the task folder is the customer's (ws:o11/tasks) and a decision is kept in <ws>/state/exposure/decisions (no
  // folder the agent writes). Hosted the rule runs inside the deadline (registration below): no continuation reaches it, so
  // the decisions, the callers and the held reservations of round 5 are never written there (a detached call keeps its own
  // reservation until its handler really ends); D13 holds hosted in ssam_evidence (keptFolders, below).
  const tasksFolder = deps.tasksDir ?? (hosted ? tasksDir(answersRoot) : path.join(answersRoot, '.local', 'tasks'));
  const decisionsFolder = hosted ? workspaceOf('state', 'exposure', 'decisions') : path.join(tasksFolder, '.exposure');
  const decisionKey = id => folderKey(tasksFolder) + '|' + String(id).toLowerCase();
  const decisionFile = id => (TASK_ID.test(String(id)) ? path.join(decisionsFolder, String(id).toLowerCase() + '.json') : null);
  const callerKey = caller => createHash('sha256').update('ssam-exposure-caller\0' + callerId(caller)).digest('hex').slice(0, 32);
  const writeDecision = (id, decision) => {
    const file = decisionFile(id);
    if (!file) return;
    try { fs.mkdirSync(decisionsFolder, { recursive: true }); const temporary = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(decision)); fs.renameSync(temporary, file); }
    catch { /* the process still holds it */ }
  };
  const dropDecision = id => {
    detachedDecisions.delete(decisionKey(id));
    const file = decisionFile(id);
    if (file) { try { fs.rmSync(file, { force: true }); } catch { /* swept when it expires */ } }
  };
  const current = decision => typeof decision?.metered === 'string' && Array.isArray(decision.callers) && Number.isFinite(decision.at) && Date.now() - decision.at < DECISION_TTL_MS;
  const decisionOfTask = id => {
    let held = detachedDecisions.get(decisionKey(id)) ?? null;
    if (!held) { const file = decisionFile(id); try { held = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { held = null; } }
    if (held && !current(held)) { dropDecision(id); return null; }
    return held;
  };
  const sweepDecisions = () => {
    const now = Date.now(), today = servedBytes.dayOf();
    for (const [key, decision] of detachedDecisions) if (!(now - decision.at < DECISION_TTL_MS)) detachedDecisions.delete(key);
    for (const [key, held] of heldReservations) if (held.day !== today) { heldReservations.delete(key); held.release(); }
    let names = [];
    try { names = fs.readdirSync(decisionsFolder); } catch { return; }
    for (const name of names) {
      const file = path.join(decisionsFolder, name);
      try { if (now - fs.statSync(file).mtimeMs >= DECISION_TTL_MS) fs.rmSync(file, { force: true }); } catch { /* removed meanwhile */ }
    }
  };
  const admitCaller = (id, decision, caller) => {
    const who = callerKey(caller);
    const held = decisionOfTask(id);
    if (held?.callers.includes(who)) return;
    const kept = held ? { ...held, callers: [...held.callers, who] } : { ...decision, callers: [who], at: Date.now() };
    detachedDecisions.set(decisionKey(id), kept);
    writeDecision(id, kept);
    if (!held) sweepDecisions();
  };
  // The final answer reached a caller the call was admitted for: that caller leaves the decision, the last one ends it.
  const leaveCall = (id, caller) => {
    const held = decisionOfTask(id);
    if (!held) return;
    const callers = held.callers.filter(who => who !== callerKey(caller));
    if (!callers.length) { dropDecision(id); return; }
    const kept = { ...held, callers };
    detachedDecisions.set(decisionKey(id), kept);
    writeDecision(id, kept);
  };
  const decisionOfKept = (name, id) => {
    const task = readTask(id, { dir: tasksFolder });
    const file = task?.tool === name && typeof task.answer?.file === 'string' ? task.answer.file : null;
    if (!file) return decide(name, {});
    const origin = fileOriginOf(file);
    if (!origin) return { ...decide(name, {}), unknown: true };
    return { tool: name, metered: meterOf(name, origin), args: typeof origin.kind === 'string' ? { kind: origin.kind } : {}, origin: origin.tool === name ? null : origin };
  };
  const valueOfAnswer = answer => (answer?.structuredContent !== undefined ? answer.structuredContent : (() => { try { return JSON.parse(answer?.content?.[0]?.text); } catch { return null; } })());
  // Round 5 (re-review round 4, MEDIUM 1; D12 of the Integradora, 17/10): a limited call is admitted with its bytes reserved
  // for the day. When it detaches, its first answer is "running" (a few hundred bytes) and its content only comes with the
  // continuation, so the reservation is NOT released with that first answer: it is held with the call (task folder, id and
  // caller) and released after the continuation that delivers its final answer to that caller has recorded its bytes. A call
  // that is never continued keeps it for the rest of the day (the store's reservations are per day). Detached calls can no
  // longer each cost a few hundred bytes at admission and serve their content past the day.
  const holdKey = (id, caller) => decisionKey(id) + '|' + callerId(caller);
  const holdReservation = (id, caller, release) => {
    const key = holdKey(id, caller);
    if (heldReservations.has(key)) { release(); return; } // one reservation per call and caller (an identical call joined it)
    heldReservations.set(key, { release, day: servedBytes.dayOf() });
  };
  const releaseHeld = (id, caller) => {
    const key = holdKey(id, caller);
    const held = heldReservations.get(key);
    if (held) { heldReservations.delete(key); held.release(); }
  };
  const exposeHandler = (name, fn, argsOf = null) => (exposure === 'owner' ? fn : async (...params) => {
    const caller = callerOf();
    const raw = params.length > 1 && params[0] && typeof params[0] === 'object' ? params[0] : {};
    const continued = Object.hasOwn(raw, 'continueTask');
    const args = continued ? raw : runArgs(argsOf, raw);
    // Round 6 (re-review round 5, LOW 1; D15 of the Integradora, 17/10): a continuation is the call only when it names the
    // call's tool (a decision without its tool, written before this round, is no call: decided as a new one); a continuation
    // under another tool is decided on that tool alone.
    const found = continued ? decisionOfTask(raw.continueTask) : null;
    const held = found?.tool === name ? found : null;
    // D9 for a caller the call was admitted for; any other continuation is a new call (D14)
    const admitted = Boolean(held?.callers.includes(callerKey(caller)));
    const decision = continued ? held ?? decisionOfKept(name, raw.continueTask) : decide(name, args);
    if (decision.unknown) {
      const value = { ok: false, code: 'ANSWER_ORIGIN_UNKNOWN', tool: name, outcome: 'not-sent',
        error: 'The kept final answer of this task has no valid record of the tool that answered it, so this server does not serve it. Nothing was read.',
        fix: 'Repeat the original call with its own arguments: its new answer is kept with the record of the tool that answered.' };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
    }
    const { metered } = decision;
    let release = null;
    if (metered === 'ssam_reference' && !admitted) {
      const used = servedBytes.usage(caller, ['ssam_reference']);
      if (used >= dayBytes) {
        const value = { ok: false, code: 'REFERENCE_DAY_LIMIT', tool: name, outcome: 'not-sent', usedBytes: used, limitBytes: dayBytes, resetsAt: nextDay(),
          error: 'This token read its reference bytes of the day (' + used + ' of ' + dayBytes + '); the reference answers again at ' + nextDay() + '. Nothing was read.',
          continuation: { tool: 'ssam_discover', arguments: { intent: '<what the task builds>' }, why: 'the contracts, a proven example and the rules of a task, within its own budget' } };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
      }
      release = servedBytes.reserve(caller, 'ssam_reference', callBytes);
    }
    try {
      const answer = await fn(...params);
      const value = valueOfAnswer(answer);
      const running = value?.state === 'running' && typeof value.task?.id === 'string';
      // D15: a continuation the deadline refused before it reached the call or its task (an extra field, another tool, an
      // unknown id: call-deadline.mjs CONTINUATION_REFUSED) changes nothing: the caller stays admitted and its reservation
      // stays held, so the right continuation that follows is still the call (D9). Only an answer of the call itself (its
      // final answer, TASK_ANSWER_UNAVAILABLE, TASK_ORPHANED, an uncertain outcome) ends it for that caller.
      const reached = !answer?.[CONTINUATION_REFUSED];
      if (running) { if (!admitted) admitCaller(value.task.id, decision, caller); }
      else if (admitted && reached) leaveCall(raw.continueTask, caller);
      const result = exposedResult(answer, { exposure, handleRoots, tool: name, args: continued ? decision.args : args, suiteNames, origin: decision.origin ?? null });
      try {
        const bytes = answerBytes(result);
        if (metered === 'ssam_reference:check') servedBytes.record(caller, metered, bytes);
        else meterRead(servedBytes, caller, metered, bytes, { alertBytes, log: onAlert });
      } catch { /* metering never changes an answer */ }
      // D12: a pending call keeps its reservation; its final answer, now recorded, releases it.
      if (running && release) { holdReservation(value.task.id, caller, release); release = null; }
      else if (!running && admitted && reached) releaseHeld(raw.continueTask, caller);
      return result;
    } finally { release?.(); }
  });
  server.ssamExposure = exposure;
  // a7 (no-internals list item 13): a tool the served mode adds outside the shaper (ssam_friction) passes the same rule.
  server.ssamExposeHandler = exposeHandler;
  // a7 phase 3 (review vps-a7-2 B3, the family "an answer the call deadline builds by itself"): hosted, the deadline wraps
  // the gate (registration below), so what it answers on its own (running, a refused, orphaned or uncertain continuation,
  // TASK_ANSWER_UNAVAILABLE with the error of the file system) and a final answer it reads back from the task folder never
  // passed the rule nor the gate's presenter in that call. On the way out they pass both, the rule as SSAM's runtime prose of
  // a task answer; an answer that came out of the gate in this very call (passedGate) passes untouched, so nothing is ruled
  // or presented twice (both are idempotent anyway: a read-back answer passed them when it was kept).
  const passedGate = new WeakSet();
  // (a7 phase 4: the same view of the server layout as the gate's presenter, hosted.presentation in a test)
  const deadlinePresenter = hosted ? (await import('./hosted/policy.mjs')).presenter({ workspace: hosted.context.workspace, ...(hosted.presentation ?? {}) }) : null;
  // servidor/fase4-26 a8: the ssam_code deps of a hosted customer (hosted/code.mjs), used by ssam_code and by ssam_map below.
  const hostedCodeOf = hosted ? (await import('./hosted/code.mjs')).hostedCode : null;
  const deadlineAnswer = answer => (!answer || typeof answer !== 'object' || passedGate.has(answer) || answer.resultType === 'input_required' ? answer
    : deadlinePresenter.result(exposedResult(answer, { exposure, handleRoots, tool: 'ssam_task', args: {}, suiteNames })));
  server.registerTool = (name, config, handler) => {
    if (!profileServes(profile, name)) return null;
    // a8: hosted, a ssam_map answer (view flow, a list of actions) notes the actions this customer read, as ssam_code read
    // does: an edit of logic by ssam_code expands only a read its customer was served (hosted/code.mjs record). Only while
    // ssam_code is served (the switch off, ssam_map answers as before and keeps nothing).
    if (hosted && name === 'ssam_map' && typeof handler === 'function' && codeServedHosted(hosted.tools ?? null)) {
      const read = handler;
      handler = async (...params) => {
        const result = await read(...params);
        try {
          const args = params.length > 1 && params[0] && typeof params[0] === 'object' ? params[0] : {};
          const value = result?.structuredContent ?? (typeof result?.content?.[0]?.text === 'string' ? JSON.parse(result.content[0].text) : null);
          hostedCodeOf(hosted.context).record(args.lane === 'o11' ? 'o11' : 'odc', value);
        } catch { /* an unrecorded read only refuses a later edit */ }
        return result;
      };
    }
    // Lane wp: only a handler that declares its build and apply phases (config._meta, studio-write-lock.mjs PHASES_META)
    // builds without the Studio lock; any other write holds the Studio for its whole call.
    const phases = declaresPhases(config);
    // The ceiling also holds a budget the input layer renamed or coerced ({budget_bytes}, "100000"), before the tool's schema.
    const prepare = name === 'ssam_evidence' ? undefined : args => clampBudget(args, maxBytes);
    let argsOf = null;
    ({ config, handler, argsOf = null } = toolInput?.relaxTool?.(name, config, handler, { prepare }) ?? { config, handler });
    argsOfTool.set(name, argsOf);
    // Owner rule (2026-10-08): every client shows the tool's own name, never a descriptive title (claude.ai shows the
    // title when there is one), so the title and annotations.title are the name.
    config = { ...config, title: name, ...(config?.annotations ? { annotations: { ...config.annotations, title: name } } : {}) };
    if (listing) config = listing(name, config);
    served.add(name);
    // Quality (docs/QUALIDADE.md), hosted only: the body runs in the call context of quality-meter.mjs under the key the
    // HTTP server opened for this request (MCP session id + JSON-RPC id), so every agent call and kernel run it makes is
    // charged to it; the shaped answer is summarized there before paging (only codes and counts are kept).
    const shaped = (...params) => {
      const ctx = params.at(-1);
      const key = hosted && typeof ctx?.sessionId === 'string' && ctx.mcpReq?.id !== undefined ? ctx.sessionId + '\u0000' + JSON.stringify(ctx.mcpReq.id) : null;
      return key ? withCall(key, () => shapedCall(key, params)) : shapedCall(null, params);
    };
    const shapedCall = async (qualityKey, params) => {
      const hasArgs = Boolean(config?.inputSchema) && params.length > 1;
      const ctx = params.at(-1);
      if (!config?.inputSchema && params.length > 1) params = [ctx];
      if (hasArgs && name !== 'ssam_evidence') params[0] = clampBudget(params[0] ?? {}, maxBytes);
      // The lane, the Studio lock and the shaper read the arguments the tool runs (G7: what the input layer renamed or
      // coerced, under the name the tool knows), so a `next` reads the listing the call read and a continuation goes to its
      // Studio ({kinds} ran kind, {PID} ran pid). Arguments the layer refuses are read as sent.
      const args = hasArgs ? argsOf?.(params[0]) ?? params[0] ?? {} : {};
      // Owner decision (2026-10-18): a delivery or a creation (tool-classification.mjs runsToEnd) answers when its work ends.
      // This handler serves every client call and the delivery ssam_code writes through, so the mark reaches the call this one
      // runs inside under every deadline (this server's, the warm start's boot proxy).
      // (hosted, a8 phase 7: the prints are read asynchronously; locally these answer plain values)
      if (runsToEnd(name, args)) { markRunsToEnd(); await replays.outerPrints(name, args); } // an outer call (ssam_code write) takes its print now
      const lane = args.lane ?? (/^(studio_|odc_|hybrid_)/.test(name) ? 'odc' : 'o11');
      // fix/no-internals round 4: an answer this call keeps for a later read names whose answer it is (licensee only).
      const kept = keptOrigin(name, args);
      if (name === 'ssam_task' && args.close && args.id) {
        const dir = deps.tasksDir ?? tasksDir(answersRoot);
        const kernelId = /^[0-9a-f]{32}$/i.test(args.id) ? args.id : readTask(args.id, { dir })?.result?.taskId;
        if (isLiveTask(args.id, dir) || kernelId && findKernelFacadeTasks(kernelId, { dir }).some(task => isLiveTask(task.id, dir))) return reply({ ok: false, code: 'CLOSE_TASK_RUNNING', error: 'The real handler is still running; wait for its final answer' });
      }
      const changed = releaseExempt(name, args) ? null : release.check();
      if (changed) {
        const waiting = releaseWait(activeTasks());
        const value = { ok: false, code: 'RELEASE_CHANGED', tool: name, outcome: 'not-sent',
          error: 'The SSAM release under this MCP server changed since it started (' + changed.changed.join(', ') + '); nothing was run. '
            + (waiting ? 'Detached operations are still running; continue them until they finish.' : 'The server must restart to load it.'),
          // Hosted, only the server owner restarts the server: the launcher that reloads a local server when its detached
          // tasks end does not exist there, so the restart note stays even while tasks run (their continuation is kept).
          release: changed, ...(hosted ? { ...(waiting ?? {}), next: HOSTED_RESTART_NEXT, ...(waiting ? {} : { continuation: { tool: 'ssam_doctor', arguments: {}, why: 'shows the server root and release; after the restart it confirms the new release' } }) }
            : waiting ?? { next: RESTART_NEXT, continuation: { tool: 'ssam_doctor', arguments: {}, why: 'shows the server root and release; after the restart it confirms the new release' } }) };
        const shaped = shapeToolResult(name, args, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true }, { lane });
        return pageAnswer(fitResult(name, args, shaped, { root: answersRoot, directory: answersDirectory(), budgets: deps.answerBudgets, origin: kept }),
          { root: answersRoot, directory: answersDirectory(), maxBytes, origin: kept });
      }
      // CX15 r7 (M-1, M-3, the family): one rule for every tool of every lane, before any handler runs: a words field that is
      // present and not the owner's words (wordsGiven: a marker, a <template>, a sha256, no words) is ONE WORDS_REQUIRED.
      const noWords = callWordsProblems(name, args);
      if (noWords.length) {
        const value = wordsRequired(noWords, { tool: name });
        const shaped = shapeToolResult(name, args, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true }, { lane });
        return pageAnswer(fitResult(name, args, shaped, { root: answersRoot, directory: answersDirectory(), budgets: deps.answerBudgets, origin: kept }),
          { root: answersRoot, directory: answersDirectory(), maxBytes, origin: kept });
      }
      // The replay of an unconfirmed final answer (replay-store.mjs; Integradora, 2026-10-18, review round 3), decided here, on
      // the arguments this tool runs: the call this deadline entry serves (never a delivery nested in it) gets the kept answer
      // of the same call (normalized arguments and the sha256 of every file it reads); on a miss, any write ends the replays of
      // its subject. The print is taken as the call starts (the deadline's, when it took one), for the answer it may keep.
      const replay = await replays.start(name, args);
      if (replay?.hit) return replay.hit;
      const signal = ctx && typeof ctx === 'object' ? ctx.mcpReq?.signal : undefined;
      // Lane wp: a delivery runs its build phase without the Studio lock and takes it at its first Studio write (phased).
      const bounded = ['o11_service_center_read', 'o11_service_center_session', 'odc_read', 'odc_portal_read', 'odc_portal_login'].includes(name);
      const execute = () => {
        const budget = bounded ? readOptions('queue') : {};
        const combined = signal && budget.signal ? AbortSignal.any([signal, budget.signal]) : signal ?? budget.signal;
        return writeLock({ tool: name, args, lane, deps: deps.lock ?? {}, onBusy: onBusy(lane), signal: combined, phased: phases && isPhased(name, args) }, () => {
          if (bounded) readCheckpoint('preflight');
          return handler(...params);
        });
      };
      const readTimeoutMs = name.startsWith('o11_service_center_') || (name === 'odc_portal_login' && (!args.action || args.action === 'open')) ? 90000 : 29000;
      let result = bounded ? await boundedRead({ scope: 'mcp:' + name, args }, execute, { timeoutMs: deps.readTimeoutMs ?? readTimeoutMs }) : await execute();
      if (result?.code === 'READ_DEADLINE_EXCEEDED') result.continuation = { tool: name, arguments: args,
        why: 'Check the original pending read without resending it. Its eventual result belongs to the original request context.' };
      if (bounded && result?.ok === false && !result.content) result = reply(result);
      if (result?.resultType === 'input_required') return result;
      // Packets, exact recovery deltas and original tool definitions are immutable typed content.
      const immutableContent = ['ssam-packet/1', 'ssam-packet-part/1', 'ssam-tool-definition/1'].includes(result?.structuredContent?.schemaVersion);
      // CX15 r5 (N-1) / r6 (M-2): the one point of the hub that serves every answer: no corrected and no step {tool, arguments}
      // gives the owner's words back (authorize, authorization, words, ownerRequest at any depth become the words marker).
      let shaped = immutableContent ? result : resultWithoutWordEchoes(shapeToolResult(name, args, result, { lane }), { tool: name });
      // Only this boundary knows which tools this server actually serves. Packets own their immutable budget. M6
      // (servidor/fase4-26 a7): a hosted session serves the whole hosted catalog (profile all); nothing is marked there and no
      // path of this server (enable: <root>\.mcp.json) is ever answered.
      if (!hosted && !immutableContent && name === 'ssam_discover' && !args.packet && shaped?.structuredContent) {
        let marked = false;
        const mark = tool => {
          if (!tool?.tool || served.has(tool.tool)) return tool;
          marked = true;
          const server = profileServes('debug', tool.tool) ? 'ssam-debug' : 'ssam';
          return { ...tool, server, enable: 'Connect the ' + server + ' server from this root using ' + path.join(workspaceRoot, server === 'ssam-debug' ? 'debug.mcp.json' : '.mcp.json') + '.' };
        };
        const full = shaped.structuredContent;
        const value = { ...full, ...(Array.isArray(full.tools) ? { tools: full.tools.map(mark) } : {}),
          ...(Array.isArray(full.toolGroups) ? { toolGroups: full.toolGroups.map(group => ({ ...group, tools: group.tools.map(mark) })) } : {}) };
        if (marked) {
          if (value.size && typeof value.size.bytes === 'number') {
            value.size = { ...value.size };
            for (let i = 0; i < 6; i++) {
              const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
              if (value.size.bytes === bytes) break;
              value.size.bytes = bytes;
            }
          }
          shaped = { ...shaped, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
        }
      }
      if (qualityKey) { try { noteAnswer(qualityKey, name, args, shaped); } catch { /* the record never changes an answer */ } }
      const final = pageAnswer(fitResult(name, args, shaped, { root: answersRoot, directory: answersDirectory(), budgets: deps.answerBudgets, origin: kept }),
        { root: answersRoot, directory: answersDirectory(), maxBytes, origin: kept });
      // a8: hosted, the kept answer of a replay is the customer's, in ws:o11/answers with its origin record, as every kept answer.
      await replays.keep(replay, final, value => keepAnswer(sanitizeAnswer(value), answersRoot, kept, { directory: answersDirectory() }));
      return final;
    };
    // R1: the gate reads argsOf, so what it confines is what the tool runs. servidor/fase4-25: the handler map (ssam_code
    // writes through the delivery tool of its lane by it) keeps the GATED handler, the same one the client reaches: hosted,
    // no path of the server runs a tool around the gate.
    // a7: hosted, the exposure rule of a licensee runs here, inside the gate and before its presenter (no-internals list
    // item 6: handleRoots = [the workspace]); the handler map keeps that gated, exposed handler (item 13).
    const inner = hosted ? exposeHandler(name, shaped, argsOf) : shaped;
    const final = gate ? gate(name, config, inner, { argsOf }) : inner;
    handlers.set(name, final);
    const sdkConfig = toolInput?.continuationInput?.(config) ?? continuationSchema(config);
    server.ssamConfigs.set(name, sdkConfig);
    // CX11 x CX12 (INT-4): the warm-start snapshot is the list a session is served, the projected listing of
    // tool-listing.mjs, so a cached start never lists the originals; the originals stay for ssam_reference (toolDetails).
    const original = snapshotTool(name, sdkConfig);
    inputSchemas.set(name, original.inputSchema); // the defaults a replay fills (replay-store.mjs normalizedArguments)
    server.ssamOriginalTools.push(original);
    server.ssamTools.push(deps.listing === 'full' ? original : listedTool(original));
    // CX12: the call deadline wraps the gated handler (a continueTask reads only this server's task folder and never passes
    // the gate). Hosted (servidor/fase4-26, C): the deadline itself runs in the customer's context, so its task folder,
    // the kernel task folders it reads (kernelTaskAnswer) and the answers it keeps are that customer's, never the server's.
    // fix/no-internals: locally the exposure rule is THE exit, outside the deadline (exposeHandler, as in the product). Hosted
    // (a7) it runs inside the gate, before its presenter (above: final), so the deadline outside keeps and replays answers
    // that already passed it, a detached call holds its day reservation until it really ends, and a continuation is the
    // task of this customer's folder only.
    // a7 phase 3 (B3): hosted, every answer leaves the deadline through deadlineAnswer (above); the gate's own answers are
    // marked on the way in, so they pass untouched.
    const gated = hosted ? async (...params) => { const answer = await final(...params); if (answer && typeof answer === 'object') passedGate.add(answer); return answer; } : final;
    const wrapped = deadline.wrap(name, gated, { ...config, exempt: config._meta?.canRequestInput === true });
    return register(name, sdkConfig, inContext ? (...params) => inContext(hosted.context, async () => deadlineAnswer(await wrapped(...params))) : exposeHandler(name, wrapped, argsOf));
  };
  registerPreviewTools(server, { workspace: workspaceRoot, ...(deps.previewOptions ?? {}) });
  const clients = {}; const closers = [];
  // One O11 CLI runner for the cycle, the environment, the references and o11_data: the lane's resident worker when it
  // can serve (no assembly reload per call), else a cold process. ANVIL_WORKER=0 keeps everything cold.
  const o11Runner = deps.runAnvil ?? createWorkerFirstRunner();
  if (o11) server.registerTool('o11_data', {
    title: 'O11 headless entity data',
    description: 'Read or write published O11 business records through the Edit Data of the Service Studio connected on the O11 lane, with that Studio\'s own login (SSO included); no credential and no vault. host only checks that the Studio is on that environment. Pass a published OML snapshot and entity/attribute names. read/read-all/insert/update/delete; (System) and Users modules are refused. read-all answers at most limit rows (default 2000) within deadlineMs (default 60 s), every page with its own timeout; complete:false comes with the continuation (same read, next offset). Writes require the user authorization words and a stable operationId UUID inside request. Reuse the same operationId after a lost response; pending receipts block automatic retry. Long IDs must be strings. Several entities in one call: request {authorization, batch:[op, ...]}, each op with its own step name; an attribute value or id {"$ref": "<step>"} (or "<step>#<i>") is the record id an earlier insert of the batch created. See docs/O11-DADOS-HEADLESS.md. files:[abs paths] (JSON/JSONL/CSV) need natural keys: equal rows skip, missing rows insert; changed rows stop before writing (updatePreview) until confirmUpdates. Same operationId resumes by reading keys. close:{preview:true}, then close:{previewSha256,authorize} with the owner reply.',
    inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false, required: ['host', 'module', 'oml', 'request'], properties: {
      host: { type: 'string' }, module: { type: 'string' }, oml: { type: 'string' },
      request: o11DataRequestSchema,
    } }),
  }, async ({ host, module, oml, request }, ctx) => {
    // merge: file loads (files/close) before the CX15 words gate
    // Hosted: the lane's local folder of the context (<ws>/o11), never the server's own lane folder (nor deps.dataRoot).
    const work = hosted ? path.join(o11LaneOf(LANES.o11.lane).local, 'data')
      : path.join(deps.dataRoot ?? LANES.o11.root, LANES.o11.lane === 'ss5' ? '.local/lane-ss5/data' : '.local/data');
    if (Object.hasOwn(request, 'files') || Object.hasOwn(request,'close')) {
      const call = { host, module, oml };
      const token = ctx?.mcpReq?._meta?.progressToken;
      const progress = token == null || typeof ctx?.mcpReq?.notify !== 'function' ? undefined : stage => {
        Promise.resolve().then(() => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token,
          progress: stage.done, total: stage.total, message: `o11_data: ${stage.done}/${stage.total} batches completed` } })).catch(() => {});
      };
      return reply(await runDataLoad({ lane: 'o11', ...call, ...request },
        o11DataChannel({ runAnvil: o11Runner, call:{...call,entity:request.entity}, work, authorization: request.authorization }),
        { journalRoot: path.join(work, 'loads'), now: deps.dataNow ?? Date.now, progress, signal: ctx?.mcpReq?.signal, destructive: deps.destructive,
          continuation: { tool: 'o11_data', arguments: { ...call, request }, why: 'Resume the same load with the same operationId.' } }));
    }
    const fileFields = ['columns', 'references', 'keys', 'insertMissing', 'batchSize', 'delimiter', 'dryRun', 'confirmUpdates'].filter(field => Object.hasOwn(request, field));
    if (fileFields.length) return reply({ ok: false, code: 'INPUT_INVALID', written: 0,
      error: 'File-load options require files; no records were sent.', problemCount: fileFields.length,
      problems: fileFields.map(field => ({ code: 'INPUT_INVALID', at: field, reason: `${field} requires files` })) });
    const gate = await import('./data-delete-gate.mjs');
    const noWords = gate.dataWordsRefusal(request); if (noWords) return reply(noWords); // CX15 r6 (M-1)
    if (gate.hasDataDelete(request)) {
      // Hosted: the gate refused every delete before (hosted/destructive.mjs, DESTRUCTIVE_HOSTED_OFF); the CX15 two-step
      // delete and its store are local only until they are ported per customer, so a delete that got here is refused again.
      if (hosted) return reply((await import('./hosted/destructive.mjs')).destructiveUnavailable('o11_data'));
      return reply(await gate.o11DataDelete({ host, module, oml, request }, { o11Runner, o11DataArguments, o11DataAnswer, dataRoot: deps.dataRoot ?? LANES.o11.root, lane: LANES.o11.lane, ...deps.destructive, signal: ctx?.mcpReq?.signal ?? null })); // CX15: a delete previews first; r2: the client's cancellation reaches it
    }
    const send=async()=>{
      const requests = path.join(work, 'requests'); fs.mkdirSync(requests, { recursive: true });
      // CX15 r4 (W-4): the request file and the kernel (which copies it into its receipt) get sha256:<hex> of the owner's
      // words, never the words; the answer's continuation is built from the same hashed request.
      const kernelRequest = gate.hashedDataRequest(request);
      const file = path.join(requests, randomUUID() + '.json'); fs.writeFileSync(file, JSON.stringify(kernelRequest));
      return o11DataAnswer(await o11Runner(['data', ...o11DataArguments({ host, module, oml }, file, work)], { read: !isWrite('o11_data', { request }) }), kernelRequest, { host, module, oml });
    };
    const entities=[...new Set((request.batch??[request]).filter(op=>['insert','update'].includes(op.operation)).map(op=>op.entity))].sort();
    // Review 6: no --schema before an inline write unless a file load of the lane is open (withInlineDataReservation).
    // Review 7 (R7-1): only a failed identity read (nothing sent yet) is not-sent; an error of the write itself (a dead worker,
    // a cancelled call) may have run: it goes up to the hub, which answers it uncertain (TASK_FAILED_UNCERTAIN).
    const identities=async()=>{try{const out=[];for(const entity of entities)out.push(await o11DataChannel({runAnvil:o11Runner,call:{host,module,oml,entity},work}).identity());return out;}
      catch(error){throw Object.assign(error,{code:error.code??'DATA_TARGET_IDENTITY_REQUIRED',identityFailure:true});}};
    try{return reply(entities.length?await withInlineDataReservation({lane:'o11'},identities,{journalRoot:path.join(work,'loads')},send):await send());}
    catch(error){if(!error?.identityFailure)throw error;return reply({ok:false,code:error.code,error:error.message,written:0,outcome:'not-sent'});}
  });
  // The headless debugger of both lanes, in this process and independent of Studio proxies: the server debugger
  // (ssam_debug), the action runner (ssam_debug_run: execution=native-entry through the nearest public entry the code
  // resolves, both lanes; the REST wrapper paths are legacy) and the ODC invocation of an existing entry (ssam_debug_invoke).
  const debugReply = fn => async args => {
    try { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok ? {} : { isError: true }) }; }
    catch (error) { return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }], isError: true }; }
  };
  const { registerDebugTools } = await import('./debug.mjs');
  const { headlessDebug } = await import('./debug-runtime.mjs');
  registerDebugTools(server, headlessDebug, debugReply);
  // Register locally: a relay cancellation must not lose the UUID created before native query dispatch.
  registerQueryTestTools(server, deps.queryTest ?? {});
  const { registerInvokeTools } = await import('./debug-invoke.mjs');
  const { invokeDebug } = await import('./debug-invoke-runtime.mjs');
  registerInvokeTools(server, invokeDebug, debugReply);
  const { registerRunTools, debugRun, debugRunToolSchema } = await import('./debug-run.mjs');
  registerRunTools(server, debugRun, debugReply);
  const { registerClientSessionTool } = await import('./debug-client-session.mjs');
  registerClientSessionTool(server, debugRunToolSchema, debugReply);
  const { registerServerSessionTool } = await import('./debug-server-session.mjs');
  registerServerSessionTool(server, debugRunToolSchema, debugReply);
  // Read-only final matrix (req 19): same generator as `ssam debug matrix [--check]`.
  const { registerMatrixTool, debugMatrix } = await import('./debug-final-matrix.mjs');
  registerMatrixTool(server, debugMatrix, debugReply);
  registerO11Operations(server, fromJsonSchema);
  // The O11 lane in this process (no Python): the controlled app session, the read/deliver cycle, the Studio,
  // the environment, references and long tasks. Each module keeps its own gates and words. They share o11Runner (above).
  if (o11) {
    // surface 'ssam' (I10): the four app tools only work with the hook of the controlled profile, so on this server they are
    // registered only when SSAM_APP_HOOK_TOOLS=1 (o11-app-session.mjs decides; createAppSessionServer keeps them).
    (deps.registerAppSession ?? registerO11AppSession)(server, { descriptionPrefix: '[o11] ', gate: assertSelectedO11, surface: 'ssam', ...(deps.appSession ?? {}) });
    registerO11Cycle(server, { runAnvil: o11Runner, ...(deps.cycle ?? {}) });
    registerO11Studio(server, deps.studio ?? {});
    registerO11Environment(server, { runAnvil: o11Runner, ...(deps.environment ?? {}) });
    registerO11Publish(server, deps.publish ?? {});
    // O11 .NET extensions without Integration Studio (o11-extension.mjs): built by the kernel (anvil xif), read and
    // published through the connected Studio's session; consumers:true reuses the o11_publish cascade.
    registerO11Extension(server, { runAnvil: o11Runner, publishDeps: deps.publish ?? {}, ...(deps.extension ?? {}) });
  }
  // CX15 r3 (CT-9): ssam_task on EVERY server. It is the one read of the destructive records (previews and executions)
  // that the descriptions and continuations of o11_service_center_write, studio_data_delete, studio_command and the odc_*
  // tools send the model to after an interruption, CANCELLED or a local failure; an ODC-only server did not serve it. With
  // the O11 lane the cycle registers it with the delivery close; otherwise here, the same tool without the close
  // (close answers CLOSE_UNAVAILABLE): it lists the long tasks of this root and reads the destructive records.
  // Junction CX12 x CX15 (M6-7): the one ssam_task of this server reads the tasks this server's deadline writes.
  if (!o11 || deps.cycle?.registerTask === false) registerSsamTask(server, { root: anvilRoot, tasksDir: deps.tasksDir ?? tasksDir(answersRoot), ...(deps.task ?? {}) });
  let toolDetails = async () => null;
  registerSsamReference(server, { toolDetails: name => toolDetails(name), runAnvil: o11Runner, exposure, callBytes, ...(deps.reference ?? {}) });
  // Evidence files of both lanes (inspect out, result.json, receipts, journals) read without a script; read-only.
  // Hosted: only the visible area of the customer's workspace.
  // fix/no-internals round 4 (re-review MEDIUM 2): on a licensee's server, a file that holds a tool's answer (fileOriginOf:
  // a reference document, a kept answer) is presented as that tool's answer before the reader reads it (every shape).
  // Round 5 (re-review round 4, LOW 2; D13 of the Integradora, 17/10): a kept answer whose origin is unknown (its record
  // missing or not valid: kept by an older release, by an owner's server on the same folder, or a record write that failed)
  // is refused on a licensee's server (fail-closed), never read as a run's evidence.
  // a7 (phase 3): hosted, the kept answers are the customer's ws:o11/answers (keptFolders) and their records are in
  // <ws>/state/answer-origins (reference-files.mjs originRecord): a page kept before the swap (no record) answers
  // ANSWER_ORIGIN_UNKNOWN.
  registerSsamEvidence(server, { ...(deps.evidence ?? {}), ...(hosted ? { roots: ['odc', 'o11', 'inbox'].map(dir => workspaceOf(dir)) } : {}),
    ...(exposure === 'owner' ? {} : { present: {
      originOf: real => fileOriginOf(real),
      unknown: real => isKeptAnswer(real, keptFolders()) && !fileOriginOf(real),
      apply: (doc, origin) => presentedDocument(doc, { exposure, handleRoots, origin, suiteNames }) } }) });

  if (odc) {
    // deps.odcFacade: a factory of the ODC MCP server (tests: a fake studio_deliver; never a Studio).
    const facade = deps.odcFacade ? await deps.odcFacade() : await (await import('./mcp.mjs')).createFacadeServer();
    configureRelayFacade(facade);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ssam-odc-proxy', version: '0.1.0' });
    await Promise.all([facade.connect(serverSide), client.connect(clientSide)]);
    clients.odc = client; closers.push(() => client.close());
  }
  const connectLanes = [...(o11 ? ['o11'] : []), ...(odc ? ['odc'] : [])];
  if (o11 || odc) server.registerTool('ssam_connect', {
    title: 'Connect to the Studios already open',
    description: 'Attach to every running Studio of the lanes served here (or only `lane`), reusing each session and its unsaved work: a Studio whose bridge already answers is left as it is. Never closes, saves, publishes, validates or reopens modules. Answers per Studio {lane, pid, target, attached, alreadyAttached, tenant, account} and reconnectNeeded (false when nothing had to be attached). ok speaks for the target only: pid, else the only Studio of each lane; the others never fail the call. Uses an external runtime bridge; does not change the installation.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {
      lane: { type: 'string', enum: connectLanes, description: 'Only this lane; omitted: every open Studio of every lane served here.' },
      pid: { type: 'integer', minimum: 1, description: 'The target Studio when several are open.' }
    }, additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (input = {}) => {
    // The O11 tools read the connection record on every call: nothing to restart after a new attach. Hosted, only the
    // lanes of this customer's token are served (the others answer LANE_NOT_SERVED), and every Studio is the customer's:
    // the listing, the probes and the attaches go through the customer's executor (studio-connect.mjs connectAll).
    const servedHere = hosted ? connectLanes.filter(l => (hosted.session?.lanes ?? hosted.context.lanes ?? []).includes(l)) : connectLanes;
    let value;
    try { value = await (deps.connect ?? connectAll)(input, { served: servedHere, ...(deps.connectDeps ?? {}) }); }
    catch (error) { value = { ok: false, stage: 'connect', error: error.message }; }
    if (value && value.ok === false && !value.code) value = { ...value, code: 'CONNECT_FAILED', stage: 'connect' };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok ? {} : { isError: true }) };
  });

  // One registration per tool of each lane. The schema travels as it came from the lane's own server.
  // The ODC lane root the studio_deliver proxy writes inline and patched jobs under (deps.odcRoot: tests); hosted, the
  // customer's <ws>/odc, with the patch journal in <ws>/odc/journal.
  const odcLaneRoot = deps.odcRoot ?? (hosted ? workspaceOf('odc') : LANES.odc.root);
  const patchJournal = hosted ? path.join(odcLaneRoot, 'journal') : path.join(odcLaneRoot, '.local', 'journal');
  const listed = {};
  for (const [name, client] of Object.entries(clients)) listed[name] = (await client.listTools()).tools;
  const listedNames = new Set(Object.values(listed).flatMap(tools => tools.map(t => t.name)));
  const relayTimeoutMs = deps.relayTimeoutMs ?? RELAY_TIMEOUT_MS;
  const shared = new Set(Object.values(listed).flatMap(tools => tools.map(t => t.name))
    .filter((n, i, all) => all.indexOf(n) !== i));
  for (const [laneName, tools] of Object.entries(listed)) {
    for (const tool of tools) {
      if (tool.name === 'ssam_debug') continue; // Registered above for both lanes, independent of Studio proxies.
      if (tool.name === 'ssam_query_test') continue; // Both lanes and UUID-aware cancellation are registered locally.
      if (tool.name === 'ssam_task') continue; // CX15 r3 (CT-9): every ssam server registers its own; the ODC facade's serves `odc mcp` alone.
      const needsLane = shared.has(tool.name);
      if (needsLane && laneName !== Object.keys(listed)[0]) continue; // one registration, the `lane` argument routes
      const schema = needsLane
        ? { ...tool.inputSchema, properties: { lane: { type: 'string', enum: Object.keys(listed), description: 'Which lane answers this tool.' }, ...(tool.inputSchema?.properties ?? {}) },
            required: [...(tool.inputSchema?.required ?? []), 'lane'] }
        : tool.inputSchema;
      // An ssam_* tool with its own `lane` argument (ssam_discover, ssam_map) serves both lanes: no lane prefix.
      const ownLane = tool.name.startsWith('ssam_') && tool.inputSchema?.properties?.lane != null;
      // studio_deliver also takes the job inline (the ops themselves), like o11_deliver: one call, no file to write; and
      // patch + basedOn {job, sha256} (the nextBasedOn of an answer) instead of the whole job again, paths by index or by
      // name, or job + basedOn: a partial job with only the changed or new elements (job-patch.mjs).
      const inlineJob = tool.name === 'studio_deliver' && schema?.properties?.job;
      // feature (with owners and changes) may be left out for a job with a prototype op: the proxy fills them from the
      // prototype's prefix (prototype-op.mjs prototypeDeliveryDefaults); any other job still needs feature (refused here).
      const exposed = inlineJob ? { ...schema, required: (schema.required ?? []).filter(r => r !== 'feature'), properties: { ...schema.properties, job: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
        description: 'Path of the job JSON (absolute or relative to the SSAM-Hybrid-ODC root), or the job itself ({ops:[...]} or an array of ops). '
          + 'With basedOn: a partial job, only the changed or new actions/entities/ops (same name replaces, new name is added).' },
        patch: patchJsonSchema, basedOn: basedOnJsonSchema, autoPatch: { type: 'boolean', description: 'false: offer verified repairs without automatically applying them.' } } } : schema;
      const description = (needsLane ? '[o11 | odc] ' : ownLane ? '' : '[' + laneName + '] ') + (tool.description ?? '')
        + (inlineJob ? ' Every answer with a job names nextBasedOn {job, sha256}; a refusal also job, jobSha256, failedOp and each patch by name (patchByName). '
          + 'Correct it with patch + basedOn (paths by index or by name: actions/<Action>/steps/<as>/...), or with only the changed actions as a partial job + basedOn; never rewrite the whole job. '
          + PROTOTYPE_DELIVER_TEXT + ' ' + CODE_JOB_TEXT : '');
      // Discover owns its first-answer, packet and expansion defaults; other budgeted tools use the shared ceiling.
      const budgeted = schema?.properties?.budgetBytes != null;
      server.registerTool(proxyName(tool.name, laneName), {
        title: tool.title, description,
        inputSchema: fromJsonSchema(exposed ?? { type: 'object' }), annotations: tool.annotations,
        ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}),
        // Lane wp: the lane's handler declares its phases in the listing; the declaration travels with the proxy.
        ...((declaresPhases(tool) || tool._meta?.canRequestInput === true) ? { _meta: { ...(declaresPhases(tool) ? { [PHASES_META]: true } : {}), ...(tool._meta?.canRequestInput === true ? { canRequestInput: true } : {}) } } : {}),
      }, async (args = {}, ctx) => {
        const { lane: chosen, ...rest } = args;
        const client = clients[needsLane ? chosen : laneName];
        if (!client) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Unknown lane ' + chosen }) }], isError: true };
        let forwarded = needsLane ? rest : { ...args };
        if (budgeted && tool.name !== 'ssam_discover' && forwarded.budgetBytes == null) forwarded = { ...forwarded, budgetBytes: budgetCeiling(maxBytes) };
        let partial = null;
        // The op shapes of the job taken as meant (ssam-code.mjs normalizeCodeOps), listed on the answer.
        let jobNotes = [];
        let carried = null; let joinOf = null; let pending = null; let precheckModule = null;
        // CX16 r3: the precheck running alongside the relay, settled where its problems join the answer.
        const settle = async () => { if (!pending) return; const pre = await pending; pending = null; if (pre?.carry) carried = pre; };
        if (inlineJob && (forwarded.patch != null || forwarded.basedOn != null)) {
          // The corrected job is a new file under <odcRoot>/.local/jobs/inline; the base never changes. The ODC server
          // is strict: patch/basedOn never travel to it (a partial job travels as the whole job it completes).
          const { patch, basedOn, ...others } = forwarded;
          const patched = resolvePatchedJob({ job: others.job, patch, basedOn }, { root: odcLaneRoot, inlineDir: path.join(odcLaneRoot, '.local', 'jobs', 'inline'),
            journalDir: patchJournal, tool: 'studio_deliver' });
          if (!patched.ok) return reply(patched);
          forwarded = { ...others, job: patched.path };
          partial = patched.partial ?? null;
          jobNotes = patched.normalizations ?? [];
        }
        // fase4-24: the job as its JSON text is the job itself (a hosted session sends jobs inline), never a path of the ODC root.
        if (inlineJob && typeof forwarded.job === 'string' && /^\s*[[{]/.test(forwarded.job)) {
          try { forwarded = { ...forwarded, job: JSON.parse(forwarded.job) }; }
          catch (error) { return reply({ ok: false, code: 'JOB_INVALID', error: 'job is neither a path nor valid JSON: ' + error.message }); }
        }
        // CX16 r2: the problems a carried UI precheck found, in the answer of the relay (ui-precheck.mjs joinPrecheck).
        const joined = value => (carried && joinOf ? joinOf(value, carried) : value);
        // A job with a prototype op: feature, owners and changes default to the prototype's prefix (one call, 1.1).
        if (inlineJob) {
          const given = forwarded.job != null && typeof forwarded.job === 'object' ? forwarded.job
            : typeof forwarded.job === 'string' ? readJobDocument(path.resolve(odcLaneRoot, forwarded.job)) : null;
          // The ssam_code op aliases (op "ddl", logic data.text): a job file that has them runs as a new inline file.
          const aliased = given ? normalizeCodeOps(given) : { job: given, changed: false };
          if (aliased.normalizations?.length) jobNotes = [...jobNotes, ...aliased.normalizations];
          const document = aliased.job;
          if (aliased.changed && typeof forwarded.job === 'string') forwarded = { ...forwarded, job: writeInlineJob(odcLaneRoot, document) };
          // WIRED (text-routes.mjs): a text form whose way back is not wired is refused before the delivery runs.
          const unwired = document ? textFormRefusal(document, undefined, typeof forwarded.job === 'string' ? { readPart: partReader(path.resolve(odcLaneRoot, forwarded.job), fs, path) } : {}) : null;
          if (unwired) return reply(unwired);
          // CX16 (ui-precheck.mjs): a job of screens or blocks is judged on the newest snapshot's index. CX16 r3 (M3): alongside
          // the relay (the relay is the apply path, nothing to spare): its problems join the relayed answer below.
          precheckModule = document ? await import('./ui-precheck.mjs') : null;
          const pre = document ? await precheckModule.startUiPrecheck({ lane: 'odc', module: forwarded.module, job: typeof forwarded.job === 'string' ? path.resolve(odcLaneRoot, forwarded.job) : document, document, mode: 'deliver', input: forwarded }, { runAnvil: o11Runner, odcRoot: odcLaneRoot, ...(deps.precheck ?? {}) }) : null;
          if (pre?.stop) return reply(jobNotes.length ? { ...pre.stop, normalizations: jobNotes } : pre.stop);
          if (pre?.pending) { pending = pre.pending; joinOf = precheckModule.joinPrecheck; }
          const defaults = document ? prototypeDeliveryDefaults(document, forwarded) : null;
          if (defaults) forwarded = { ...forwarded, ...defaults };
          if (!(typeof forwarded.feature === 'string' && forwarded.feature.trim())) {
            await settle();
            return reply(joined({ ok: false, code: 'INPUT_INVALID', error: 'studio_deliver needs feature (with job: also owners and changes); only a job with a prototype op takes them from the prototype.' }));
          }
        }
        if (inlineJob && forwarded.job != null && typeof forwarded.job !== 'string') forwarded = { ...forwarded, job: writeInlineJob(odcLaneRoot, forwarded.job) };
        // SDK 2 (installed @modelcontextprotocol/client 2.0.0): callTool(params, options).
        let result;
        try { result = await relayWork(client, { name: tool.name, arguments: forwarded }, ctx, relayOptions(ctx, { timeoutMs: relayTimeoutMs }), { write: isMutation(tool.name, forwarded) }); }
        catch (error) {
          if (['studio_data_insert', 'studio_data_update'].includes(tool.name) && (forwarded.files !== undefined || forwarded.close !== undefined))
            await waitForDataLoadEnd(deps.odcDataRoot ?? path.join(odcLaneRoot, 'journal', 'data', 'loads'), forwarded.operationId);
          return reply(relayFailure(error, { tool: tool.name, args: forwarded, signal: ctx?.mcpReq?.signal, timeoutMs: relayTimeoutMs,
            statusTool: listedNames.has('studio_status') ? 'studio_status' : 'ssam_doctor' }));
        }
        // A refusal names the job it ran (job, jobSha256, nextBasedOn, failedOp when the kernel names the op, each patch also
        // by name) for the next patch; a success names nextBasedOn; an uncertain one never does (it is settled from its
        // receipts, never corrected).
        let value = result?.structuredContent;
        // CX16 r4 (M3): an accepted or uncertain relayed answer never waits for check-job (joinPrecheck would not change it).
        if (pending && precheckModule && !precheckModule.waitsForPrecheck(value)) { precheckModule.settleLater(pending, value); pending = null; }
        await settle();
        if (carried && value && typeof value === 'object' && !Array.isArray(value)) {
          const both = joined(value);
          if (both !== value) { value = both; result = { ...result, structuredContent: both, content: [{ type: 'text', text: JSON.stringify(both) }] }; }
        }
        // One field (normalizations.mjs): the relayed answer's kernel object {total, byRule, items} or list keeps its
        // entries; the job notes join it, never replace it.
        const notes = jobNotes.length ? { normalizations: mergeNormalizations(value?.normalizations, jobNotes) } : {};
        if (inlineJob && typeof forwarded.job === 'string' && value && typeof value === 'object' && !Array.isArray(value) && value.outcome !== 'uncertain') {
          const file = path.resolve(odcLaneRoot, forwarded.job);
          let named;
          if (result?.isError) {
            const failedOp = failedOpOf(value.error ?? value.refusal?.error, file);
            named = withNamedPatches({ ...value, ...jobIdentity(file), ...(failedOp != null ? { failedOp } : {}), ...(partial ? { partial } : {}), ...notes }, file);
          } else if (value.ok === true) {
            const corrected = appliedJobIdentity(value.patchedJob, { path: file, sha256: jobIdentity(file).jobSha256 }, { journalDir: path.join(odcLaneRoot, '.local', 'journal'), tool: 'studio_deliver' });
            const { nextBasedOn } = jobIdentity(corrected.path);
            if (nextBasedOn || partial || jobNotes.length) named = { ...value, ...(nextBasedOn ? { nextBasedOn } : {}), ...(partial ? { partial } : {}), ...notes };
          }
          if (named) return { ...result, structuredContent: named, content: [{ type: 'text', text: JSON.stringify(named) }] };
        }
        if (jobNotes.length && value && typeof value === 'object' && !Array.isArray(value)) { const noted = { ...value, ...notes }; return { ...result, structuredContent: noted, content: [{ type: 'text', text: JSON.stringify(noted) }] }; }
        return result;
      });
    }
  }

  // ssam_code (ssam-code.mjs): the module as code, both lanes; read is ssam_map, write is the registered handler of the
  // lane's delivery tool above (o11_deliver, studio_deliver proxy), the same call a client makes.
  {
    const { registerSsamCode } = await import('./ssam-code.mjs');
    // An omitted budget is the answer ceiling (less the shaper's room), as the ssam_map relay does.
    const codeMap = deps.codeMap ?? (async input => (await import('./module-map.mjs')).moduleMap({ ...input, budgetBytes: input.budgetBytes ?? budgetCeiling(maxBytes) }));
    // feat/ssam-code-hosted: deps.code() gives the deps of each check, plan and write, read at the call (a server that keeps
    // each session apart: code-check.mjs roots, code-plan.mjs place, the read an edit expands); none, this checkout's.
    // servidor/fase4-26 a8: hosted, those deps are this customer's, read at the call (hosted/code.mjs: the roots of its
    // workspace, the places of a plan on the server and on the user's machine, the reads it was served), whatever deps say;
    // and every read of ssam_code notes the actions it answered (an edit of logic expands only those).
    const codeDeps = () => (hosted ? hostedCodeOf(hosted.context) : typeof deps.code === 'function' ? deps.code() ?? {} : {});
    const readMap = !hosted ? codeMap : async input => {
      const answer = await codeMap(input);
      try { hostedCodeOf(hosted.context).record(input?.lane === 'o11' ? 'o11' : 'odc', answer); } catch { /* an unrecorded read only refuses a later edit */ }
      return answer;
    };
    // a8 review (M2): hosted, every check takes a slot of its customer and of the server (one queue; hosted/checks.mjs) and
    // leaves no candidate behind; a plan, and each check, first sweeps the candidates an interrupted check left.
    const check = deps.codeCheck ?? (async input => (await import('./code-check.mjs')).codeCheck(input, codeDeps()));
    const plan = deps.codePlan ?? (async input => (await import('./code-plan.mjs')).codePlan(input, codeDeps()));
    const checks = hosted ? await import('./hosted/checks.mjs') : null;
    registerSsamCode(server, { fromJsonSchema, map: readMap, lanes: laneNames,
      check: hosted ? checks.hostedCheck(hosted.context, check, { slots: hosted.checkSlots ?? null }) : check,
      plan: hosted ? async input => { checks.sweepCandidates(hosted.context.workspace); return plan(input); } : plan,
      write: () => codeDeps(),
      deliver: async (tool, args, ctx) => {
        const handler = handlers.get(tool);
        if (!handler) {
          const value = { ok: false, code: 'LANE_NOT_SERVED', tool: 'ssam_code', error: `${tool} is not served here: this server does not serve that lane` };
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
        }
        return handler(args, ctx ?? {});
      } });
  }

  // The O11 job runner, which the Anvil MCP does not expose: one fixture proof per call, no Studio and no merge.
  // producers/captureProducers are the Manage Dependencies inputs of a job's `reference` ops (producerArgs below).
  // The job runner in this process (job-runner.mjs: the resident worker when it is up, else a cold CLI process;
  // no Python). It proves a job on a fixture; it delivers nothing to the Studio.
  const runJobTool = deps.jobTool ?? jobTool;
  server.registerTool('o11_job', { title: 'Run a verb job on an O11 fixture', description:
    '[o11] Applies a job to a fixture and returns ok/isValid and the messages. '
    + 'It proves a job; it delivers nothing to the Studio (o11_deliver does, validating inside the call: deliver directly, and prove here only when the person asks). '
    + 'A refused run answers ONCE with every problem of every phase over the base (problems[]: phase, op, pointer, code, fix, patch when certain; verifyRan). A failed run also returns `discovery` (contract of the failing '
    + 'op, catalog capability of its element, proven refusal, next step). job is a path or the job itself (inline ops); '
    + 'patch (paths by index or by name: actions/<Action>/steps/<as>/...) + basedOn {job, sha256} (the nextBasedOn of an answer) corrects it, '
    + 'or job with only the changed or new elements + basedOn (a partial job); never resend the whole job. '
    + 'producers binds {Name: absolute .oml/.avsig path}; captureProducers ["Name" | "Name=Producer", e.g. "System=(System)"] '
    + 'first reads each producer\'s current signature read-only through the logged-in Studio and binds the .avsig.',
    inputSchema: fromJsonSchema({ type: 'object',
      properties: { job: inlineJobSchema, patch: patchJsonSchema, basedOn: basedOnJsonSchema, autoPatch: { type: 'boolean', description: 'false: offer verified repairs without automatically applying them.' }, base: { type: 'string' }, out: { type: 'string' }, ...producerSchema }, additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    async ({ job, patch, basedOn, base, out, producers, captureProducers, autoPatch }) => reply(await runJobTool({ lane: 'o11', job, patch, basedOn, base, out, producers, captureProducers, autoPatch })));

  // The same job runner for either lane: O11 over an Anvil fixture, ODC over an ODC fixture through the anvil-odc
  // CLI (the same kernel compiled against the ODC Studio). It proves a job; it delivers nothing to any Studio.
  server.registerTool('ssam_job', { title: 'Run a verb job on a fixture, in either lane', description:
    'Applies a job to a fixture and returns ok/isValid and the '
    + 'messages. lane o11 (default) uses the Anvil fixtures; lane odc uses tests/jobs-odc over the ODC fixture. job is a path or the job itself (inline ops); '
    + 'patch (paths by index or by name: actions/<Action>/steps/<as>/...) + basedOn {job, sha256} (the nextBasedOn of an answer) corrects it, '
    + 'or job with only the changed or new elements + basedOn (a partial job); never resend the whole job. '
    + 'Only when the person asks for a headless proof: a normal change goes straight to o11_deliver (O11) or studio_deliver with job/module/feature/owners/changes (ODC), '
    + 'which validate inside the call and refuse before any change; studio_manifest prepares an existing candidate. '
    + 'A refused run answers ONCE with every problem of every phase over the base (problems[]: phase, op, pointer, code, fix, patch when certain, identical ones grouped; verifyRan). '
    + 'A failed run also returns `discovery` (contract of the failing op, catalog capability of its element, proven refusal, next step); ssam_discover gives the contracts before writing the job. ' + CODE_JOB_TEXT, inputSchema: fromJsonSchema({ type: 'object',
      properties: { job: inlineJobSchema, patch: patchJsonSchema, basedOn: basedOnJsonSchema, autoPatch: { type: 'boolean', description: 'false: offer verified repairs without automatically applying them.' }, lane: { type: 'string', enum: laneNames, description: 'o11 (default) or odc.' },
        base: { type: 'string' }, out: { type: 'string' }, ...producerSchema }, additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    async ({ job, patch, basedOn, lane: which = 'o11', base, out, producers, captureProducers, autoPatch }) => reply(await runJobTool({ lane: which, job, patch, basedOn, base, out, producers, captureProducers, autoPatch })));

  // O11 end-user roles by versioned manifest (o11-access.mjs): plan offline; apply EXECUTES with the user's words (one delivery
  // per owner module, bound to the manifest environment), never publishes and never creates accounts.
  registerO11Access(server, { runAnvil: o11Runner, ...(deps.access ?? {}) });

  // ssam's own view of both lanes, the first call of a session, with the identity of this server (A09): its root and
  // release, and the session's SSAM root (an MCP root of the client, else the cwd the client launched the server with).
  // release (A28) frees one foreign or orphan module reservation with the user's words; it writes only that file.
  // deps.doctor (tests): {lanes: {o11, odc}, reservations} reach doctor(); deps.reservations reach the release.
  const launchCwd = deps.identity?.launchCwd ?? (process.env.SSAM_CLIENT_CWD || process.cwd());
  const clientRoots = async () => {
    try {
      if (!server.server.getClientCapabilities?.()?.roots) return [];
      const listed = await server.server.listRoots(undefined, { timeout: 3000 });
      return (listed?.roots ?? []).map(r => r?.uri).filter(u => typeof u === 'string');
    } catch { return []; }
  };
  // a9 (review marco-a6 M1): the hosted network texts are this line's own bytes in the fixed core of the listing budget (B2,
  // context-budget-listing.test.mjs): kept short, so CX13 and X3 fit under 167747 B (total) and 34178 B (core) here too.
  server.registerTool('ssam_doctor', { title: 'Both lanes side by side', description:
    'O11 and ODC side by side: root, CLI, catalog, open Studio per lane; ok: the lane asked (or some lane) is usable; warnings: '
    + 'optional gaps; server: root and release of this server. release frees a foreign or orphan reservation it lists. '
    + 'task.stop requests stop of a live write; cancelling the wait does not stop work. task reads facade evidence; task.close explicitly closes an uncertain facade operation after reconciliation. '
    + 'Hosted: network:true tests the agent\'s uploads per internet exit (about 5 s).',
    inputSchema: fromJsonSchema({ type: 'object', properties: { lane: { type: 'string', enum: laneNames },
      network: { type: 'boolean', description: 'Hosted only: small and 1 MB agent uploads on new connections; a verdict per exit, in plain words.' },
      release: { type: 'object', required: ['reservation'], additionalProperties: false,
        description: 'Alone: frees one foreign or orphan module reservation (its next names this call); lane o11.',
        properties: { reservation: { type: 'string', description: 'reservations.active[].file' },
          authorize: { type: 'string', description: 'The user\'s words, verbatim' } } },
      task: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' }, stop: { type: 'boolean', const: true }, close: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } } } }, additionalProperties: false }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async ({ lane: which, release: freeing, network = false, task: taskRequest } = {}) => {
      let value;
      // CX12: the facade task of a detached call. Its folder follows the workspace (tasksDir: hosted, the customer's
      // <ws>/o11/tasks, the folder this server's deadline writes; never <anvilRoot>/.local/tasks, which the server shares).
      const taskAnswer = () => {
        const dir = deps.tasksDir ?? tasksDir(answersRoot);
        let answer;
        if (freeing) answer = { ok: false, code: 'INPUT_INVALID', error: 'Choose task or release in one request.' };
        else if (taskRequest.stop && taskRequest.close) answer = { ok: false, code: 'INPUT_INVALID', error: 'Choose stop or close in one request.' };
        else if (taskRequest.stop) answer = deadline.stop(taskRequest.id).structuredContent;
        else if (taskRequest.close) answer = closeFacadeTask(taskRequest.id, taskRequest.close.reason, { dir });
        else { const task = readTask(taskRequest.id, { dir }); answer = task ? { ok: true, task } : { ok: false, code: 'TASK_NOT_FOUND', error: 'No facade task ' + taskRequest.id }; }
        if (answer.continuation?.tool === 'ssam_task' && !served.has('ssam_task')) answer = { ...answer, continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'This task requires kernel proof on a server serving O11; no facade close was performed.' } };
        return answer;
      };
      // Hosted: the agent, the versions and the customer's Studios (hostedDoctor), plus the module reservations of this
      // customer only (<ws>/state/relay-authority, named by file name); release frees one of those, never the owner's.
      if (hosted) {
        value = taskRequest ? taskAnswer()
          : freeing ? (which === 'odc' ? { ok: false, code: 'BAD_ARGS', error: 'release frees an O11 module reservation: lane "o11" or no lane.' }
            : hostedRelease(freeing, hosted)) : await hostedDoctor(which, hosted, { network });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...((freeing || taskRequest) && value?.ok === false ? { isError: true } : {}) };
      }
      if (taskRequest) {
        value = taskAnswer();
      } else if (freeing) {
        value = which === 'odc' ? { ok: false, code: 'BAD_ARGS', error: 'release frees an O11 module reservation: lane "o11" or no lane.',
          continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11', release: freeing }, why: 'the same release on the O11 lane' } }
          : releaseReservation(freeing, deps.reservations ?? {});
      } else {
        const roots = await clientRoots();
        const fromRoots = roots.length ? sessionRoot({ roots, cwd: null }) : null;
        const root = fromRoots ?? sessionRoot({ cwd: launchCwd, roots: [] });
        const session = root ? { root, from: fromRoots ? 'mcp roots' : 'launch cwd' } : null;
        let current = null; try { current = readIdentity(); } catch { current = null; }
        value = await doctor(which, { ...(deps.reservations ? { reservations: deps.reservations } : {}), ...(deps.doctor ?? {}), identity: { server: identityStarted, current, session }, activeTasks: activeTasks() });
        // The network check measures the agent's uploads over the internet: a local SSAM has no agent and no such path.
        if (network === true && value && typeof value === 'object') value = { ...value, network: { ran: false, code: 'NOT_HOSTED',
          message: 'the network check belongs to a hosted server (the agent uploads files over the internet); here SSAM runs on this machine' } };
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });

  // A server whose tools a caller registers itself (deps.registerTool: the deadline tests of CX12) has no SDK tools/list
  // to project; the originals recorded above still answer ssam_reference.
  const sdkList = typeof server.server?._getRequestHandler?.('tools/list') === 'function';
  // fix/no-internals round 6 (re-review round 5, LOW 5; D17): a licensee is served each tool's definition as SSAM's
  // documentation (exposure.mjs exposedToolDefinition), in the listing as in ssam_reference {kind:"tool"}.
  const presentTool = exposure === 'owner' ? null : tool => exposedToolDefinition(tool, { isHandle: handleTest(handleRoots), suiteNames });
  // servidor/fase4-26 (a7): a hosted tools/list gives a tool whose part is off (hosted/destructive.mjs) its note in front of
  // the same projection a local server lists (hostedListed); every other tool is listed as the projection gives it.
  // a7 phase 3 (no-internals list item 13, R6): the definition rule is the LAST step of every hosted listed tool, after the
  // note went back in front (presented before, the projection would no longer match the text it reviewed).
  const hostedProjection = Boolean(hosted && sdkList && deps.listing !== 'full');
  const sdkDetails = sdkList || !deps.registerTool ? installToolListing(server, { full: deps.listing === 'full',
    ...(presentTool && !hostedProjection ? { present: presentTool } : {}) }) : async () => null;
  if (hostedProjection) {
    const { hostedListed } = await import('./hosted/destructive.mjs');
    const projected = server.server._getRequestHandler('tools/list');
    server.server.removeRequestHandler('tools/list');
    server.server.setRequestHandler('tools/list', async (request, context) => {
      const result = await projected(request, context);
      return { ...result, tools: result.tools.map(tool => { const listed = hostedListed(tool, listedTool); return presentTool ? presentTool(listed) : listed; }) };
    });
  }
  // A cached start registers the snapshot (projected) configs: the full text comes from the originals recorded above.
  toolDetails = async name => {
    const sdk = await sdkDetails(name), original = server.ssamOriginalTools.find(tool => tool.name === name);
    return original && JSON.stringify(sdk) !== JSON.stringify(original) ? original : sdk ?? original ?? null;
  };
  server.close = (close => async () => { for (const c of closers) await c().catch(() => {}); return close.call(server); })(server.close);
  return server;
}

// The controlled app profile registers its MCP server as `ssam_hybrid`: the host (AppSessions.cs, stamped kernel)
// authorizes only mcp__ssam_hybrid__<tool> calls. This server serves just the four app tools, in this process,
// replacing `python scripts/ssam_app.py --cli <anvil.dll>`; `ssam app-hook` replaces its `--hook` mode.
export async function createAppSessionServer({ workspace, deps = {} } = {}) {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const server = new McpServer({ name: 'ssam_hybrid', version: '1.0.0' });
  registerO11AppSession(server, { ...(workspace ? { workspace } : {}), ...deps });
  return server;
}

// SSAM_MCP_LANES (from "mcpLanes" in .ssam-workspace.json) serves only the listed lanes; unset serves both.
// stdio and the served mode use the same lanes, so both list the same tools.
export function servedLanes(env = process.env) {
  const only = (env.SSAM_MCP_LANES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return only.length ? { o11: only.includes('o11'), odc: only.includes('odc') } : {};
}

export function createDoctorFacts({ readProcesses = listDoctorProcesses, readOdc = async () => (await import('./lib.mjs')).doctor({live:false}), now = Date.now, ttlMs = 10000 } = {}) {
  const cache = new Map();
  async function read(key, load) {
    let entry=cache.get(key);
    if (entry?.promise) { await entry.promise; return {value:entry.value,ageMs:Math.max(0,now()-entry.at)}; }
    if (!entry || now()-entry.at > ttlMs) {
      entry={};cache.set(key,entry);
      entry.promise=Promise.resolve().then(load).then(value=>{entry.value=value;entry.at=now();entry.promise=null;},error=>{cache.delete(key);throw error;});
      await entry.promise;
    }
    return {value:entry.value,ageMs:Math.max(0,now()-entry.at)};
  }
  const processes=async name=>{const result=await read('processes',readProcesses);return {...result,value:result.value[name]??[]};};
  const odc=()=>read('odc',readOdc);
  return {processes,odc,warm:()=>Promise.all([read('processes',readProcesses),odc()])};
}
async function listDoctorProcesses() {
  // Reuse the existing window/creation-time reader, with both image names in a single CIM query.
  const { execFile }=await import('node:child_process');
  const { promisify }=await import('node:util');
  const names=[LANES.o11.studioProcess,LANES.odc.studioProcess];
  const script=studioProcessScript(names[0]).replace("Name='"+names[0]+"'",names.map(n=>"Name='"+n+"'").join(' OR '))
    .replace('Select-Object ProcessId,ExecutablePath,CreationDate','Select-Object Name,ProcessId,ExecutablePath,CreationDate')
    .replace('@{ ProcessId = $p.ProcessId;','@{ ImageName = $p.Name; ProcessId = $p.ProcessId;');
  const {stdout}=await promisify(execFile)('powershell',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:60000});
  const parsed=JSON.parse(stdout); const all=Array.isArray(parsed)?parsed:[parsed];
  return Object.fromEntries(['o11','odc'].map((name,i)=>[name,parseStudioProcesses(JSON.stringify(all.filter(p=>String(p.ImageName).toLowerCase()===names[i].toLowerCase())))]));
}
const defaultDoctorFacts=createDoctorFacts();
export async function warmBackground({env=process.env,lanes=['odc','o11'],indexes=warmIndexes,facts=defaultDoctorFacts,worker=name=>createWorkerClient(name),log=text=>process.stderr.write(text+'\n'),friction}={}) {
  if(env.SSAM_NO_WARM==='1')return;
  const work=[['indexes',()=>indexes({lanes})],['facts',()=>facts.warm()],...lanes.filter(name=>!workerDisabled(name,env)).map(name=>['worker-'+name,()=>worker(name).ensure()])];
  await Promise.all(work.map(async([step,run])=>{
    try{await run();}catch(error){
      log(JSON.stringify({ssam:'warm',ok:false,step,error:String(error?.message??error)}));
      try{const store=friction??await import(pathToFileURL(path.join(workspaceRoot,'facade','friction-store.mjs')).href);await store?.recordEvent?.({operation:'warm',code:'WARM_BACKGROUND_FAILED',step,outcome:'failed'});}catch{}
    }
  }));
}

// The warm-up starts WARM_DELAY_MS after the server is up (SSAM_WARM_DELAY_MS), on an unref'd timer: a session's first
// ssam_discover comes after its doctor/connect, while a short-lived server (a test that lists the tools) ends before the
// warm-up would start and never builds an index. With the index already built by `ssam warm` it is a cache hit.
export const WARM_DELAY_MS = 5000;
// The hosted server's warm-up (servidor/fase4): the discover indexes, then, with the ODC lane, the resident builder and the
// ODC worker, so the first delivery of the first customer does not pay their cold start (C02: kernel 17 s, builder 11 s).
export async function warmServer({ lanes = ['odc', 'o11'], log = () => {}, indexes = warmIndexes, processes } = {}) {
  const started = Date.now();
  const index = await indexes({ lanes }).catch(error => ({ ok: false, error: String(error?.message ?? error) }));
  const delivery = lanes.includes('odc') ? await (processes ?? (await import('./lib.mjs')).warmDeliveryProcesses)().catch(error => ({ error: String(error?.message ?? error) })) : null;
  const result = { indexes: index, ...(delivery ? { delivery } : {}), ms: Date.now() - started };
  try { log({ event: 'warm', ...result }); } catch { /* the log never stops the warm-up */ }
  return result;
}
export function scheduleWarm({ env = process.env, lanes = ['odc', 'o11'], warm = warmBackground, setTimer = setTimeout, log = text => process.stderr.write(text + '\n') } = {}) {
  if (env.SSAM_NO_WARM === '1' || !lanes.length) return null;
  const raw = env.SSAM_WARM_DELAY_MS; const asked = Number(raw);
  const delay = raw != null && raw !== '' && Number.isFinite(asked) ? Math.max(0, asked) : WARM_DELAY_MS;
  const timer = setTimer(() => {
    Promise.resolve().then(() => warm({ lanes })).catch(error => log(JSON.stringify({ ssam: 'warm', ok: false, error: String(error?.message ?? error) })));
  }, delay);
  timer?.unref?.();
  return { delay, lanes, timer };
}

// The served mode warms only what belongs to the server, never a customer's data: at start (servidor/fase4) the discover
// indexes of its lanes and the ODC delivery processes (resident builder and worker; warmServer), and after each hosted
// delivery or app creation the same processes again (lib.mjs warmSoon). SSAM_NO_WARM=1 turns both off.
export async function runStdio({ env = process.env, profile, warm = warmBackground, setTimer = setTimeout, args = [] } = {}) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  // stdio only (servidor/fase4-26): the warm start (createWarmServer, cached tool listing) and warmBackground; the served
  // mode (runServed) keeps no listing cache and warms with warmServer.
  const selectedProfile = profile ?? parseMcpProfile([], env);
  serverProfile(selectedProfile);
  const served = servedLanes(env);
  try {
    const { createWarmServer } = await import('./warm-start.mjs');
    // fix/no-internals round 4 (D10): ONE exposure decision for this server, taken here and handed to the server it builds.
    // A licensee's server never starts from the cached tool listing (warm start): the cached surface answers through a proxy
    // that calls each tool's inner handler, outside the licensee rule (the exit, the day, the presentation of kept answers),
    // and its listing is the one any start of the same release and arguments wrote (the key never names the exposure), the
    // owner's included. So a licensee starts cold (built, then connected) and writes no cached listing.
    const exposure = exposureOf(env);
    const warmEnv = exposure === 'owner' ? env : { ...env, SSAM_TOOLS_SNAPSHOT_DISABLE: '1' };
    let active;
    const bootTools = new Set();
    const bootDeadline = createCallDeadline({ root: anvilRoot, env, hasTool: name => bootTools.has(name), defaultLane: served.o11 === false ? 'odc' : 'o11', notify: notification => active?.server.notification(notification),
      inputsOf: (name, args) => active?.server?.ssamInputsOf?.(name, args) });
    const result = await createWarmServer({ root: workspaceRoot, identity: serverIdentity(), env: warmEnv, serverInfo: { name: serverProfile(selectedProfile).name, version: '0.2.0' }, args: [...args, 'profile:' + selectedProfile], startAfterConnect: true, build: (server, registerTool) => createSsamServer({ ...served, profile: selectedProfile, deps: { server, registerTool, activeDeadline: () => bootDeadline, exposure: { profile: exposure } } }),
      wrap: (name, handler, config) => { bootTools.add(name); return bootDeadline.wrap(name, handler, { ...config, exempt: config?._meta?.canRequestInput === true }); },
      onStale: async () => { const store = await import(pathToFileURL(path.join(workspaceRoot, 'facade', 'friction-store.mjs')).href); await store.recordEvent({ operation: 'mcp-start', code: 'TOOL_LIST_SNAPSHOT_STALE', outcome: 'reconciled' }); } });
    active = result.server;
    await active.connect(new StdioServerTransport());
    // Give the initialize/list handshake an I/O turn before CPU-heavy registration starts.
    if (result.snapshotUsed) setTimer(result.start, 100);
    result.ready.catch(error => process.stderr.write(JSON.stringify({ ok: false, step: 'mcp-ready', error: error.message }) + '\n'));
  }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; return null; }
  // The discover indexes of the served lanes, in the background: no call waits for them (C38).
  return scheduleWarm({ env, lanes: selectedProfile === 'debug' ? [] : ['odc', 'o11'].filter(l => served[l] !== false), warm, setTimer });
}

// The kernel this server has (docs/FASE2-AGENTE.md 7): the first three numbers of the ProductVersion of the Service
// Studio of the O11 lane and of the ODC Studio, and the ODC bridge version. <dir>/kernel.json ({o11, odc, odcBridge,
// o11Hook}) wins field by field, when detection fails or the owner pins a version. o11Hook is only pinned: "h1" makes
// the hub accept only agent packages with the signed release hook (docs/O11-BRIDGE-FINA.md 13).
// A-M1: kernel.json studioBuildPolicy ("warn" | "refuse", or per lane) passes through as written; the hub normalizes it
// (studio-identity.mjs buildPolicyOf). exe: the ProductVersions of this machine's Studio executables (studioExeVersions).
export async function detectKernel({ dir, fileVersion, env = process.env, exe = null }) {
  const three = value => String(value ?? '').match(/^\d+\.\d+\.\d+/)?.[0] ?? null;
  const lib = await import('./lib.mjs');
  const { signedRuntime } = await import('./signed-runtime.mjs');
  const versions = exe ?? await studioExeVersions({ fileVersion, env });
  const detected = { o11: three(versions.o11), odc: three(versions.odc), odcBridge: null, o11Hook: null };
  try { detected.odcBridge = signedRuntime(lib.root)?.version ?? lib.newestBridgeDll()?.version ?? null; } catch { /* not built */ }
  let pinned = {};
  try { pinned = JSON.parse(fs.readFileSync(path.join(dir, 'kernel.json'), 'utf8').replace(/^﻿/, '')) ?? {}; } catch { pinned = {}; }
  return { ...Object.fromEntries(Object.keys(detected).map(k => [k, typeof pinned[k] === 'string' && pinned[k] ? pinned[k] : detected[k]])),
    ...(Array.isArray(pinned.odcBridgeAccepted) ? { odcBridgeAccepted: pinned.odcBridgeAccepted } : {}),
    ...(pinned.studioBuildPolicy !== undefined && pinned.studioBuildPolicy !== null ? { studioBuildPolicy: pinned.studioBuildPolicy } : {}) };
}
// The ProductVersion (four numbers) of the Service Studio of the O11 lane and of the ODC Studio of this machine, or null.
export async function studioExeVersions({ fileVersion, env = process.env }) {
  const lib = await import('./lib.mjs');
  const out = { o11: null, odc: null };
  try { out.o11 = (await fileVersion(path.join(o11LaneOf(LANES.o11.lane, { env }).studioDir, 'ServiceStudio.exe'))) ?? null; } catch { /* not installed */ }
  try { out.odc = (await fileVersion(path.join(lib.odcStudioDir(env), 'ODCStudio.exe'))) ?? null; } catch { /* not installed */ }
  return out;
}

// The kernel the hosted server starts with (multi-version design rev. 3, O.6.1; kernel-image.mjs). kernel.json v1
// (detectKernel), then the pair with the image: a lane whose kernel.json names another Studio version than the image
// declares (ENV SSAM_IMAGE_O11 / SSAM_IMAGE_ODC) is off, so the hub answers KERNEL_UNAVAILABLE for it and the image's
// kernel never runs against another Studio. Then, in an image that declares its versions, the caches that carry no Studio
// version are emptied for a lane whose version changed, and for a lane that is off (an invalid stamp: its stamp is
// dropped too). Logs the notes of kernel.json (kernel-v2-ignored,
// kernel-json-unsupported), the `kernel` event with the same shape as before ({kernel: {o11, odc, odcBridge, o11Hook,
// odcBridgeAccepted?}}, a refused lane null), one kernel-version-missing per refused lane and kernel-cache-reset.
// A-M1 (C:\t\multiver\minimo\PROPOSTA.md): the kernel also carries builds {o11, odc}, the four-part build each lane serves
// (kernel-image.mjs servedBuilds: the image's Studio folder, else this machine's Studio executable), and kernel.json
// studioBuildPolicy as written; the hub compares the user's Studio with that build (studio-identity.mjs). The `kernel`
// event keeps its shape (neither field); `studio-builds` names the builds and the policy per lane (policyInvalid when
// kernel.json names a value the server does not know: both lanes then refuse another build).
export async function startupKernel({ dir, fileVersion, env = process.env, log = () => {}, image, caches } = {}) {
  const ki = await import('./kernel-image.mjs');
  const { buildPolicyOf } = await import('./studio-identity.mjs');
  for (const note of ki.kernelFileNotes(dir)) log(note);
  const exe = await studioExeVersions({ fileVersion, env });
  const detected = await detectKernel({ dir, fileVersion, env, exe });
  const lib = await import('./lib.mjs');
  const folder = of => { try { return of(); } catch { return null; } };
  const declared = image ?? ki.imageKernel({ env, studioDirs: { o11: folder(() => o11LaneOf(LANES.o11.lane, { env }).studioDir), odc: folder(() => lib.odcStudioDir(env)) } });
  const { kernel: paired, refused } = ki.kernelPair(detected, declared);
  const { studioBuildPolicy, ...shape } = paired;
  log({ event: 'kernel', kernel: shape });
  for (const [lane, why] of Object.entries(refused)) log({ event: 'kernel-version-missing', lane, ...why });
  const builds = ki.servedBuilds({ kernel: shape, image: declared, exe });
  const policy = buildPolicyOf(studioBuildPolicy);
  log({ event: 'studio-builds', builds, studioBuildPolicy: { o11: policy.o11, odc: policy.odc }, ...(policy.invalid ? { policyInvalid: true } : {}) });
  const kernel = { ...shape, builds, ...(studioBuildPolicy !== undefined ? { studioBuildPolicy } : {}) };
  const imageDeclares = Object.values(declared ?? {}).some(Boolean);
  if (caches ?? imageDeclares) {
    try {
      const map = await import('./module-map.mjs');
      const indexRoot = map.indexRoot(env);
      ki.resetStaleCaches({ kernel, indexRoot, log, off: Object.keys(refused), roots: ki.legacyCacheRoots({ indexRoot, readerRoot: map.readerConfig('o11', { env }).cacheRoot,
        prefetchRoot: map.prefetchCacheRoot('o11', env), o11Platform: LANES.o11.lane }) });
    } catch (error) { log({ event: 'kernel-cache-reset-failed', error: error?.code ?? error?.name ?? 'Error' }); }
  }
  return { kernel, refused };
}

// The friction queue of one customer (docs/FASE2-AGENTE.md 6.1): <ws>/.local/friction, always passed as the store's
// directory, so SSAM_FRICTION_DIR (a test or bench queue of the owner, friction-store.mjs) never merges the queues of
// several customers into one.
export const customerFrictionDirectory = workspace => path.join(workspace, '.local', 'friction');

// `ssam serve`: the same MCP over Streamable HTTP at /mcp, loopback only, bearer tokens (http-server.mjs,
// docs/SERVIDOR-LOCAL.md). Every client session gets its own server from createSsamServer, as stdio does.
//   - Hosted (the default, docs/FASE2-AGENTE.md): each session drives the Studios of ITS customer through that
//     customer's agent, with a hosted context per token (workspace, AgentExecutor, O11 relay) and a friction queue per
//     customer. The process default is the DenyExecutor: code that loses the context fails closed, never on the
//     Studios of this machine.
//   - --local-studios: phase 1, the tools drive the Studios of this machine's owner (loopback only, agents:false).
//   - Quality (docs/QUALIDADE.md): hosted only, a recorder writes <dir>/quality-YYYYMMDD.jsonl (codes, counts and times per
//     tool call and per MCP session); SSAM_QUALITY=0 (read once here) turns it off. --local-studios and stdio never record.
// The kernel rules a hosted server sets in its own environment (servidor/fase4-26), the same hostedSpawnEnv gives each
// customer's kernel process: A1, the CX14 bridge stall probes off (they would check the customer's Studio pid on this
// server); M2, a job reads a kept reading of the shared module index (html, data text, flow) only of its own base capture.
export function hostedServerEnv(env) {
  env.ANVIL_BRIDGE_PROBE_MS = '0';
  env.ANVIL_KEPT_READINGS = 'own';
  // a7 (SD): the processes this server shares between customers (the resident ODC worker and builder) keep no Studio
  // defaults on disk: a root that is not absolute is none (kernel StudioDefaults.CacheDir), so each such process measures a
  // context once, in memory (what a context gives is the Studio's alone). A customer's own process gets its folder
  // (executor.mjs hostedSpawnEnv).
  env.SSAM_STUDIO_DEFAULTS_ROOT = HOSTED_SHARED_STUDIO_DEFAULTS;
  return env;
}
export const HOSTED_SHARED_STUDIO_DEFAULTS = 'memory';
export async function runServed(args) {
  const { startHttpServer, parseServeArguments } = await import('./http-server.mjs');
  const { serverDir } = await import('./server-tokens.mjs');
  const options = parseServeArguments(args);
  const lanes = servedLanes();
  const dir = serverDir(workspaceRoot);
  const log = event => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
  // On stdio the root launcher adds ssam_friction to tools/list and records each call in the friction queue
  // (facade/friction-boundary.mjs). The served mode does the same here, so both modes list and record alike.
  const boundary = await import(pathToFileURL(path.join(workspaceRoot, 'facade', 'friction-boundary.mjs')).href);
  const frictionStore = await import(pathToFileURL(path.join(workspaceRoot, 'facade', 'friction-store.mjs')).href);
  const meta = boundary.boundaryMetadata(workspaceRoot, 'ssam', ['mcp']);
  const { fromJsonSchema } = await import('@modelcontextprotocol/server');
  const { frictionTool } = boundary;
  const frictionConfig = { description: frictionTool.description, inputSchema: fromJsonSchema(frictionTool.inputSchema), annotations: frictionTool.annotations };
  // Like stdio, this answer does not go through the SSAM response shaper (registerServedTool uses the prototype method).
  const frictionHandler = store => async (input = {}) => {
    try { const value = boundary.readQueue(store, input); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
    catch { return { isError: true, content: [{ type: 'text', text: 'Invalid friction query; use issues or task with an explicit taskId.' }] }; }
  };
  const observer = store => params => {
    if (params.name === frictionTool.name) return null;
    const lane = frictionStore.laneName(params.arguments?.lane);
    const inferred = String(params.name).startsWith('o11_') ? 'o11' : /^(studio_|odc_)/.test(params.name) ? 'odc' : meta.lane;
    const taskId = params._meta?.['ssam/taskId'] ?? params.arguments?.task_id;
    const op = store.begin({ ...meta, interface: 'mcp', operation: frictionStore.operationName(params.name), lane: lane === 'unknown' ? inferred : lane,
      taskId, correlationSource: taskId ? 'explicit-task' : 'absent' });
    return { finish: message => op.finish(message.result ?? message.error, { protocolError: !!message.error }) };
  };
  const closers = [];
  const served = handle => {
    const stop = () => Promise.allSettled(closers.map(close => close())).then(() => handle.close()).finally(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return handle;
  };

  if (options.localStudios) {
    const store = frictionStore.createStore({ root: workspaceRoot });
    const createServer = async () => {
      const server = await createSsamServer(lanes);
      registerServedTool(server, frictionTool.name, frictionConfig, frictionHandler(store));
      return server;
    };
    return served(await startHttpServer({ ...options, agents: false, dir, createServer, observeCall: observer(store), log }));
  }

  // servidor/fase4-26: the kernel rules of a hosted server for the processes it shares between customers (the resident ODC
  // worker and builder of the warm-up inherit this environment); every customer's own kernel process gets them from
  // hostedSpawnEnv.
  hostedServerEnv(process.env);
  const executor = await import('./executor.mjs');
  executor.setDefaultExecutor(new executor.DenyExecutor());
  const { kernel, refused: kernelRefused } = await startupKernel({ dir: ensureRuntime(dir), fileVersion: executor.fileVersion, log });
  // a8 phase 6 (owner request): the hosted catalog is read here, at the start, with SSAM_HOSTED_SSAM_CODE (off | on); the
  // log names what this server serves of ssam_code and whether the variable switched it ({served, switch, ignored?}).
  log({ event: 'hosted-ssam-code', ...(await import('./hosted/served.mjs')).codeSwitchState() });
  // One hosted context per token (workspace, AgentExecutor, relay), shared by the sessions of that token and closed when
  // the agent link closes (revoked, expired, server-stop).
  const contexts = new Map();
  const contextOf = session => {
    if (!session?.agent || !session.tokenId || !session.workspace) return Promise.reject(new Error('A hosted session needs its token, workspace and agent link'));
    let pending = contexts.get(session.tokenId);
    if (!pending) {
      pending = executor.createHostedContext({ tokenId: session.tokenId, customer: session.customer, lanes: session.lanes ?? [],
        agent: session.agent, workspace: session.workspace });
      contexts.set(session.tokenId, pending);
      pending.then(context => {
        session.agent.onClose?.(reason => {
          if (contexts.get(session.tokenId) === pending) contexts.delete(session.tokenId);
          log({ event: 'hosted-context-closed', token: session.tokenId, reason });
          context.close().catch(() => {});
        });
      }, () => { if (contexts.get(session.tokenId) === pending) contexts.delete(session.tokenId); });
    }
    return pending;
  };
  closers.push(async () => { for (const pending of contexts.values()) await pending.then(context => context.close(), () => {}); });
  // a7 (no-internals list item 7): ONE store of the bytes a token is served per day for every session of this process, in
  // the server's own folder (sizes only, by token id); an alert past the day's limit is one line of server.log.
  const { servedBytesStore } = await import('./served-bytes.mjs');
  const exposure = { store: servedBytesStore({ dir: path.join(ensureRuntime(dir), 'exposure') }),
    onAlert: line => { let value; try { value = JSON.parse(line); } catch { value = { line: String(line) }; } log({ event: 'served-bytes-alert', ...value }); } };
  const stores = new Map();
  const storeOf = workspace => { let store = stores.get(workspace); if (!store) stores.set(workspace, store = frictionStore.createStore({ root: workspace, directory: customerFrictionDirectory(workspace) })); return store; };
  const createServer = async session => {
    const context = await contextOf(session);
    const server = await executor.runWithExecutor(context, () => createSsamServer({ ...lanes, hosted: { context, session, kernelRefused, exposure } }));
    registerServedTool(server, frictionTool.name, frictionConfig, frictionHandler(storeOf(session.workspace)));
    return server;
  };
  const observeCall = (params, session) => session?.workspace ? observer(storeOf(session.workspace))(params) : null;
  const quality = await qualityRecorder({ dir: ensureRuntime(dir), log });
  // The audit and server.log keep a tool name only when it is a tool of the hosted catalog; another name is '?'.
  const { hostedTools } = await import('./hosted/policy.mjs');
  const handle = served(await startHttpServer({ ...options, agents: { kernel, kernelRefused }, dir, createServer, observeCall, log, quality,
    tools: Object.keys(hostedTools()) }));
  // The server's own warm-up (outside any customer context): discover indexes and the ODC delivery processes.
  scheduleWarm({ lanes: hostedWarmLanes(lanes, kernelRefused), warm: ({ lanes: warmLanes }) => warmServer({ lanes: warmLanes, log }) });
  return handle;
}

// The quality recorder of the hosted server, or null with SSAM_QUALITY=0. The native verify ids come from the kernel's own
// catalogs (<kernel>/catalog: the image keeps them), the tool names and lanes from hosted/tools.json. Logs once
// {event:"quality", on, nativeIds}.
export async function qualityRecorder({ dir, log, env = process.env, catalogDir = path.join(anvilRoot, 'catalog') }) {
  if (env.SSAM_QUALITY === '0') { log({ event: 'quality', on: false, nativeIds: 0 }); return null; }
  const [{ createQualityRecorder }, { loadNativeIds }, { hostedTools }] = await Promise.all([import('./quality-recorder.mjs'), import('./quality-line.mjs'), import('./hosted/policy.mjs')]);
  const nativeIds = loadNativeIds(catalogDir, { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
  const catalog = hostedTools();
  const quality = createQualityRecorder({ dir, log, nativeIds, tools: Object.keys(catalog), lanes: Object.fromEntries(Object.entries(catalog).map(([name, entry]) => [name, entry?.lane ?? null])) });
  log({ event: 'quality', on: true, nativeIds: nativeIds.size });
  return quality;
}

export async function dispatchDebugRunCli(args, explicit, options) {
  const { parseRunCli, debugRun } = await import('./debug-run.mjs');
  const request = parseRunCli(args);
  if (explicit && request.lane && explicit !== request.lane) throw new Error('debug_run_lane_mismatch');
  request.lane ??= explicit ?? 'odc';
  // Keep the same defaults and schema as ssam_debug_run, including O11 native-entry.
  return debugRun(request, options);
}

const [verb, ...rest] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { value: explicit, rest: args } = option(rest, '--lane');
    if (explicit) lane(explicit);
    if (verb === 'mcp') await runStdio({ args, profile: parseMcpProfile(args) });
    else if (verb === 'serve') await runServed(args);
    else if (verb === 'server-token') { const { runTokenCli } = await import('./server-tokens.mjs'); print(await runTokenCli(args, { root: workspaceRoot })); }
    else if (verb === 'db') { const { dbCli } = await import('./db.mjs'); print(await dbCli(args)); }
    else if (verb === 'package') { const {routePackage}=await import(pathToFileURL(path.join(workspaceRoot,'facade','package-route.mjs'))); const result=await routePackage(rest,{root:workspaceRoot}); if(!result.stdio)print(result); if(!result.ok)process.exitCode=1; }
    else if (verb === 'debug') {
      // ssam debug invoke ... (ODC only) | run|prepare|release|authorize|reconcile|status --request <json-file> (runner;
      // ODC by default, O11 by --lane o11 or the request's lane) | the server debugger verbs.
      if (['server', 'client'].includes(args[0])) {
        if (args.length !== 2 || args[1] !== '--stdio') throw new Error('Usage: ssam debug server|client --stdio [--lane o11|odc]');
        const { runInspectionCli } = await import('./debug-inspection-cli.mjs');
        await runInspectionCli({ runtime: args[0], lane: explicit });
      } else {
      let result;
      if (args[0] === 'invoke') { if (explicit && explicit !== 'odc') throw new Error('invoke_odc_only'); const { parseInvokeCli } = await import('./debug-invoke.mjs'); const { invokeDebug } = await import('./debug-invoke-runtime.mjs'); result = await invokeDebug(parseInvokeCli(args.slice(1))); }
      // ssam debug locks [--lane o11|odc]: read-only lock inventory (same answer as ssam_debug_run op locks).
      else if (args[0] === 'locks') { const { parseLocksCli, debugLocks } = await import('./debug-lock-inventory.mjs'); result = debugLocks(parseLocksCli(args, explicit)); }
      // ssam debug matrix [--check]: final matrix (req 19), same answer as ssam_debug_matrix; exit 1 on drift.
      else if (args[0] === 'matrix') { const { parseMatrixCli, debugMatrix } = await import('./debug-final-matrix.mjs'); result = await debugMatrix(parseMatrixCli(args)); }
      else if (['run', 'prepare', 'release', 'authorize', 'reconcile'].includes(args[0]) || (args[0] === 'status' && args[1] === '--request')) {
        result = await dispatchDebugRunCli(args, explicit);
      }
      else { const { parseDebugCli } = await import('./debug.mjs'); const { headlessDebug } = await import('./debug-runtime.mjs'); result = await headlessDebug(parseDebugCli(rest)); }
      print(result); if (!result.ok) process.exitCode = 1;
      }
    }
    else if (verb === 'app') {
      if (explicit && explicit !== 'odc') throw new Error('ssam app currently resolves ODC URLs; use --lane odc.');
      const { appUrl } = await import('./lib.mjs');
      print(await appUrl(parseAppArguments(args)));
    }
    else if (verb === 'connect') {
      // ssam connect [--lane o11|odc] [--pid <pid>]: the same one call as MCP ssam_connect (every open Studio without --lane).
      const { value: pid, rest: remaining } = option(args, '--pid');
      if (remaining.length || (args.includes('--pid') && pid === undefined)) throw new Error('Usage: ssam connect [--lane o11|odc] [--pid <pid>]');
      const only = (process.env.SSAM_MCP_LANES ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const result = await connectAll({ ...(explicit ? { lane: lane(explicit).name } : {}), ...(pid !== undefined ? { pid: Number(pid) } : {}) },
        { served: only.length ? laneNames.filter(l => only.includes(l)) : laneNames });
      print(result); if (!result.ok) process.exitCode = 1;
    }
    else if (verb === 'warm') {
      // ssam warm [--lane o11|odc]: builds (or finds cached) the discover index of each lane in the foreground; the end of
      // scripts/build.ps1 runs it, so the first ssam_discover of a session never builds it.
      if (args.length) throw new Error('Usage: ssam warm [--lane o11|odc]');
      const result = await warmIndexes({ lanes: explicit ? [lane(explicit).name] : ['odc', 'o11'] });
      print(result); if (!result.ok) process.exitCode = 1;
    }
    else if (verb === 'doctor') { const report = await doctor(explicit); print(report); if (!report.ok) process.exitCode = 2; }
    else if (verb === 'map') {
      // ssam map [--lane o11|odc] <capture.oml|Module> [...]: every element of a capture from its module index
      // (module-map.mjs), the same answer as MCP ssam_map; the lane is explicit (default odc) because the index is per lane.
      const { moduleMap, parseMapArguments } = await import('./module-map.mjs');
      const result = await moduleMap(parseMapArguments(explicit ? [...args, '--lane', explicit] : args));
      print(result); if (!result.ok) process.exitCode = 1;
    }
    else if (verb === 'discover') {
      // ssam discover <intent...> [--lane odc|o11] [--app <capture.oml>] [--detail <capability>] [--budget <bytes>]: the
      // same index and answer as `odc discover`; the lane is explicit (default odc) because the index is per lane.
      const { parseDiscoverArguments, laneInspect, laneMap } = await import('./discovery.mjs');
      const { discoverAll } = await import('./tool-routing.mjs');
      const { inspect } = await import('./lib.mjs');
      const input = parseDiscoverArguments(explicit ? [...args, '--lane', explicit] : args);
      // The capture reader of the lane: the ODC resident reader, or the O11 kernel reader (kernel-reading.mjs); the
      // kind reads come from the module index of the capture.
      // The same single entry as MCP ssam_discover: `tools` for an SSAM operation, matches for a model change.
      const result = await discoverAll({ ...input, inspect: laneInspect(input.lane, inspect), map: laneMap(input.lane) });
      print(result); if (!result.ok) process.exitCode = 1;
    }
    else if (verb === 'prototype') {
      // ssam prototype <folder> --lane o11|odc --module <M> [--base <oml>] [--dry]: the rehearsal of the one-call import
      // (docs/PROTOTIPO-NATIVO.md 9): capture, `anvil apply` headless on the local base, fidelity, and the receipt. Without
      // --dry it answers the MCP call of the import (the owner's words go there).
      const { prototypeCli } = await import('./prototype-op.mjs');
      let result;
      try { result = await prototypeCli(explicit ? [...args, '--lane', explicit] : args); }
      finally {
        // the capture keeps its child processes resident for the next call of a server; a CLI run ends with its answer
        try { (await import('./prototype/capture.mjs')).closeResidentPools?.(); } catch { /* no capture engine: nothing resident */ }
      }
      print(result); if (!result.ok) process.exitCode = 1;
    }
    else if (verb === 'app-hook') {
      // Codex/Claude hook of the controlled app profile (UserPromptSubmit/PreToolUse): event JSON on stdin.
      const { value: workspace } = option(args, '--workspace');
      process.stdin.setEncoding('utf8'); let input = ''; for await (const chunk of process.stdin) input += chunk;
      const out = await runHook(input, { ...(workspace ? { workspace } : {}) });
      process.stdout.write(out.stdout ?? ''); process.stderr.write(out.stderr ?? ''); process.exitCode = out.exitCode;
    }
    else if (verb === 'app-profile') {
      // The Codex profile of the controlled app (app-profile.mjs, the port of configure_app_profile.py): server ssam_hybrid
      // = `node ssam.mjs app-mcp`, hooks = `node ssam.mjs app-hook`; no Python.
      const { appProfileCli } = await import('./app-profile.mjs');
      const out = appProfileCli(args);
      process.stdout.write(out.stdout ?? ''); process.stderr.write(out.stderr ?? ''); process.exitCode = out.exitCode;
    }
    else if (verb === 'app-mcp') {
      const { value: workspace } = option(args, '--workspace');
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      await (await createAppSessionServer({ workspace })).connect(new StdioServerTransport());
    }
    else if (verbs.includes(verb)) {
      const chosen = chooseLane(explicit, args);
      if (!chosen.ok) fail(chosen.error);
      else {
        let result = await run(chosen.lane, verb, args);
        // A failed job also returns the catalog's contract and next step for the failing op (job-guidance.mjs).
        if (verb === 'job' && !result.ok) { const { withJobGuidance, jobArgument } = await import('./job-guidance.mjs'); result = await withJobGuidance(chosen.lane, jobArgument(args), result); }
        print({ ...result, laneFrom: chosen.from ?? 'catalog' }); if (!result.ok) process.exitCode = 1;
      }
    } else fail('Usage: ssam connect [--lane o11|odc] [--pid <pid>] | ssam warm [--lane o11|odc] | ssam ' + verbs.join('|') + ' [--lane ' + laneNames.join('|') + '] <args...> | ssam map [--lane odc|o11] <capture.oml|Module> [--kind K] [--name N] [--prefix P] [--role R] [--parent @key] [--offset N] [--max N] [--budget <bytes>] [--detail] | ssam discover <intent...> [--lane odc|o11] [--app <capture.oml>] [--detail <capability>] [--type <Interface>] [--budget <bytes>] | ssam app <App> [Screen] --lane odc [--environment <origin>] | ssam prototype <folder> --lane o11|odc --module <M> [--base <oml>] [--dry] | ssam mcp | ssam serve [--port 7300] [--host 127.0.0.1] | ssam server-token issue|revoke|list|import | ssam db migrate|status');
  } catch (error) { fail(error.message); }
}

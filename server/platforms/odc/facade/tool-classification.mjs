// One classification for cancellation, persisted outcomes and relays. Unknown tools and operations mutate by default.
// The Studio queue uses the narrower exported STUDIO_WRITE_TOOLS scope: Portal and local-file writes do not hold a Studio.
import { systemModuleName } from './studio-module.mjs';
// Junction CX12 x CX15 (M6 adjustments 1 and 2): the destructive phase decides first. destructive-operations.mjs imports only
// node:*, and the Portal modules below import nothing of the facade: no cycle.
import { destructivePhase } from './destructive-operations.mjs';
import { writeIsDestructive, effectOf } from '../portal/runtime/effects.mjs';
import { PORTAL_WRITES } from '../portal/runtime/portal-routes.mjs';
import { Catalog } from '../portal/runtime/catalog.mjs';

// ---- Which calls write. Kept equal to o11-environment.mjs ENVIRONMENT_WRITES (the test compares them).
const ENVIRONMENT_WRITES = new Set(['create-app', 'add-modules', 'create-module', 'update-app', 'refresh-refs', 'set-user-provider', 'delete-app']);
// o11_studio: open-module and wait{open} (open_module selects the tab), snapshot WITH module (open_module first),
// dismiss-dialog (closes a window a running write may depend on), login (a modal sign-in over the Studio),
// refresh-references (the native Refresh References changes the module). UI freeze of 2026-10-08 (pattern 4): wait
// idle|no-dialogs are writes too. Both answer the dependencies dialog and run the Studio's Refresh References (MB2), and
// idle waits for "no SSAM write": as a read it timed out behind a stream of other agents' writes. As a write it takes its
// turn in the FIFO queue (for up to its own timeoutSeconds, QUEUE_LIMITS) and, holding the Studio, never counts itself.
// status, errors, windows, wait signed-in and snapshot of the active module (pinned to its key) are reads; status answers
// the dependencies dialog only when the Studio lock is free at that moment (o11-studio.mjs). A module named by its alias
// (open-module {module}, snapshot {name}) is the same call; a system module is refused before the Studio (A29): a read.
const O11_STUDIO_WRITES = new Set(['open-module', 'close-module', 'dismiss-dialog', 'login', 'refresh-references']);
const O11_STUDIO_BARRIER_WAITS = new Set(['idle', 'no-dialogs']);
const O11_STUDIO_OPENS = new Set(['open-module', 'snapshot', 'refresh-references']);
const namedModule = a => a.args?.module ?? a.args?.name;
const opensSystem = a => (O11_STUDIO_OPENS.has(a.command) || (a.command === 'wait' && a.args?.condition === 'open'))
  && typeof namedModule(a) === 'string' && systemModuleName(namedModule(a)) != null;
const O11_DATA_WRITES = new Set(['insert', 'update', 'delete']);          // o11_data through the Studio's Edit Data
// o11_data request: one op, or {authorization?, batch:[op]} (contract I12): a batch with any write is a write.
// The close preview of a file load (close:{preview:true}, or close without previewSha256) reads its journal and writes
// no data, like a dryRun (CX13 review 5, F12); its confirmation (close.previewSha256) is a write.
const closePreviewOnly = a => a?.close != null && typeof a.close === 'object' && (a.close.preview === true || !a.close.previewSha256);
const o11DataWrites = request => (!request?.dryRun && !closePreviewOnly(request) && O11_DATA_WRITES.has(request?.operation))
  || (Array.isArray(request?.batch) && request.batch.some(op => !op?.dryRun && O11_DATA_WRITES.has(op?.operation)));
const SC_SESSION_WRITES = new Set(['sign-in', 'web-sign-in', 'close']);   // Studio login dialog / Service Center window
// The Service Center deletes (CX15 DESTRUCTIVE_TOOLS): previewed, then executed with the confirmationToken.
const SC_DESTRUCTIVE = new Set(['delete', 'module-delete', 'extension-delete', 'application-delete', 'solution-delete', 'db-connection-delete']);
const ODC_DELIVER_READS = new Set(['snapshot', 'build', 'check-base', 'preview']);
const APP_TOOLS = new Set(['context', 'propose', 'continue', 'status']);  // the O11 controlled app session (o11-app-session.mjs)
const always = () => true;

// o11_inspect {module}, ssam_map and ssam_discover with an O11 module name are reads (see the header): their capture takes
// this lock itself only to select an open module.
export const STUDIO_WRITE_TOOLS = Object.freeze({
  o11_deliver: always, // merge, resume, close, closePrevious, and until=apply (open_module to capture the module)
  o11_publish: always,
  o11_access: a => a.action === 'apply',
  o11_environment: a => ENVIRONMENT_WRITES.has(a.action) && (a.action !== 'delete-app' || Boolean(a.confirmationToken)), // CX15: a delete-app without token previews
  o11_studio: a => !opensSystem(a) && (O11_STUDIO_WRITES.has(a.command) || (a.command === 'snapshot' && Boolean(namedModule(a)))
    || (a.command === 'wait' && (a.args?.condition === 'open' || O11_STUDIO_BARRIER_WAITS.has(a.args?.condition)))),
  o11_data: a => o11DataWrites(a.request),
  // ssam_task reads tasks; with close it closes a delivery task in the kernel (snapshot of the module, reservation).
  // ssam_grant writes only the grants file, never a Studio: outside this queue scope.
  ssam_task: a => a.close != null,
  // CX15: a delete (any of SC_DESTRUCTIVE) executes only with its confirmationToken; without it, a preview outside the queue.
  // Junction: the phase decides first (isStudioWrite); a token on a non-destructive action changes nothing (PHASE_CASES null).
  o11_service_center_write: a => (SC_DESTRUCTIVE.has(a.action) ? String(a.confirmationToken ?? '').trim() !== '' : a.execute === true && a.action !== 'verify'),
  o11_service_center_session: a => SC_SESSION_WRITES.has(a.action),
  // A .NET extension published or deleted through the Studio's session (o11_extension); read is a read.
  o11_extension: a => a.action === 'publish' || (a.action === 'delete' && Boolean(a.confirmationToken)), // CX15: a delete without token previews
  // An ODC External Library uploaded and published, or a pending generation discarded; build and status are reads.
  odc_external_library: a => a.action === 'deploy' || a.action === 'discard',
  odc_mcp_import: always,
  continue: always, // advances the accepted app task: snapshot, compilation, merge
  studio_deliver: a => !ODC_DELIVER_READS.has(a.until ?? 'merge'),
  studio_merge: always, studio_publish: always, studio_create: always, studio_close: always,
  studio_create_app: a => (a.action ?? 'create') === 'create', // templates is a read
  studio_refresh_references: always, studio_data_insert: a => !a.dryRun && !closePreviewOnly(a), studio_data_update: a => !a.dryRun && !closePreviewOnly(a), studio_data_delete: always,
  studio_dismiss_dialog: always, studio_open: always,
  // Passthrough of any bridge command (stop included): treated as a write, except publish-log, a read of the messages
  // pane the bridge answers even while another command runs.
  studio_command: a => a.command !== 'publish-log',
});


export const TOOL_CLASSIFICATIONS = new Map();
const pureReads = ['ssam_discover', 'ssam_map', 'ssam_reference', 'ssam_evidence', 'ssam_app_url',
  'o11_inspect', 'studio_status', 'studio_doctor', 'studio_inspect', 'studio_data', 'studio_consumers',
  'studio_check_base', 'studio_preview', 'hybrid_tenants'];
for (const name of pureReads) TOOL_CLASSIFICATIONS.set(name, Object.freeze({ mode: 'pure-read', annotations: Object.freeze({ readOnlyHint: true }) }));
const actionReads = values => a => values.includes(a.action);
// Only named read operations are exceptions. An invalid/new operation remains a mutation even before its handler refuses it.
export const PURE_READ_OPERATIONS = Object.freeze({
  ssam_task: a => a.close == null && a.stop !== true,
  ssam_doctor: a => a.release == null && a.task?.close == null && a.task?.stop !== true,
  ssam_grant: a => (a.action ?? 'list') === 'list',
  o11_service_center_session: actionReads(['status']),
  o11_service_center_write: a => a.action === 'verify' || a.execute === false,
  ssam_code: actionReads(['grammar', 'read', 'check']),
  ssam_preview: a => ['list', 'status'].includes(a.action ?? 'list'),
  o11_access: actionReads(['plan', 'verify', 'users']),
  o11_environment: actionReads(['inventory', 'download', 'download-app', 'templates', 'references', 'referenceable']),
  o11_extension: actionReads(['read']),
  o11_data: a => {
    const ops = Array.isArray(a.request?.batch) ? a.request.batch : [a.request];
    return ops.length > 0 && ops.every(op => ['read', 'read-all'].includes(op?.operation) || (!Array.isArray(a.request?.batch) && (op?.dryRun === true || closePreviewOnly(op))));
  },
  studio_data_insert: a => a.dryRun === true || closePreviewOnly(a), // CX13 F12: a dryRun and a close preview write no data
  studio_data_update: a => a.dryRun === true || closePreviewOnly(a),
  o11_studio: a => opensSystem(a) || ['status', 'errors', 'windows'].includes(a.command)
    || (a.command === 'snapshot' && !namedModule(a))
    || (a.command === 'wait' && a.args?.condition === 'signed-in'),
  odc_configurations: a => (a.action ?? 'get') === 'get',
  odc_external_db_connection: actionReads(['providers', 'list', 'entities', 'plan-entities', 'plan-header']),
  odc_external_library: actionReads(['status']),
  studio_create_app: actionReads(['templates']),
  studio_deliver: a => ODC_DELIVER_READS.has(a.until),
  studio_command: a => a.command === 'publish-log',
  ssam_debug: a => a.op === 'status',
  ssam_debug_server: a => ['status', 'read', 'read-many', 'read-frame', 'read-scope', 'private-read', 'private-compare'].includes(a.op),
  ssam_debug_client: a => ['status', 'read', 'read-many', 'read-scope', 'private-read', 'private-compare'].includes(a.op),
});
for (const name of Object.keys(PURE_READ_OPERATIONS)) TOOL_CLASSIFICATIONS.set(name, Object.freeze({ mode: 'mixed', annotations: Object.freeze({}) }));
for (const name of Object.keys(STUDIO_WRITE_TOOLS)) if (!TOOL_CLASSIFICATIONS.has(name))
  TOOL_CLASSIFICATIONS.set(name, Object.freeze({ mode: 'mutation', annotations: Object.freeze({ readOnlyHint: false }) }));

export function declareToolClassification(name, config = {}) {
  const annotations = Object.freeze({ ...(config.annotations ?? {}) });
  const mode = Object.hasOwn(PURE_READ_OPERATIONS, name) ? 'mixed'
    : annotations.readOnlyHint === true && annotations.destructiveHint !== true ? 'pure-read' : 'mutation';
  const declaration = Object.freeze({ mode, annotations });
  TOOL_CLASSIFICATIONS.set(name, declaration);
  return declaration;
}
// ---- The destructive phase (CX15, destructive-operations.mjs DESTRUCTIVE_TOOLS) of a call: 'preview' (no confirmationToken:
// nothing is sent, a read), 'execute' (with it: a write), 'refuse' (a passthrough line the guard stops: a read), null (not a
// destructive call: the tables above decide). The effect of odc_write only the catalog knows (writeIsDestructive: DELETE,
// Undeploy, PATCH with *ToRemove); of odc_portal_write, PORTAL_WRITES. The catalog is read once, on the first odc_write; if it
// cannot be read the phase is null and odc_write stays a mutation (never guessed a read).
let catalog;
const odcWriteCatalog = () => { if (catalog === undefined) { try { catalog = new Catalog(); } catch { catalog = null; } } return catalog; };
const DESTRUCTIVE_EFFECT = Object.freeze({
  odc_write: args => { const c = odcWriteCatalog(); return c ? writeIsDestructive(c, args) : false; },
  odc_portal_write: args => PORTAL_WRITES[args?.operationId]?.effect === 'destructive',
});
export function phaseOfCall(name, args = {}) {
  try { return destructivePhase(name, args, { destructive: DESTRUCTIVE_EFFECT[name] }); } catch { return null; }
}
export function classifyTool(name, args = {}, config) {
  const declaration = config == null ? TOOL_CLASSIFICATIONS.get(name) : declareToolClassification(name, config);
  const a = args && typeof args === 'object' ? args : {};
  const phase = phaseOfCall(name, a);
  const isReadOnly = phase === 'preview' || phase === 'refuse' ? true : phase === 'execute' ? false
    : Object.hasOwn(PURE_READ_OPERATIONS, name) ? PURE_READ_OPERATIONS[name](a) === true
    : declaration?.mode === 'pure-read';
  return { declared: declaration != null, isWrite: !isReadOnly, isReadOnly,
    destructive: !isReadOnly && declaration?.annotations?.destructiveHint === true,
    ...(phase ? { phase } : {}),
    source: phase ? 'destructive-phase' : Object.hasOwn(PURE_READ_OPERATIONS, name) ? 'operation' : declaration ? 'annotations' : 'default-mutation' };
}
export const isMutation = (name, args = {}, config) => classifyTool(name, args, config).isWrite;
// The Studio queue: a destructive execution of a Studio tool is a write that queues; its preview or a refused line never
// enters the queue (they send nothing). Without a phase, the tool's own predicate decides.
export function isStudioWrite(name, args = {}) {
  if (!Object.hasOwn(STUDIO_WRITE_TOOLS, name)) return false;
  const a = args && typeof args === 'object' ? args : {};
  const phase = phaseOfCall(name, a);
  if (phase === 'execute') return true;
  if (phase === 'preview' || phase === 'refuse') return false;
  return STUDIO_WRITE_TOOLS[name](a) === true;
}

// ---- Deliveries and creations run to their end in the same call (owner decision, 2026-10-18: no time limit for them). One
// rule over the write classification above, by a property of the operation, its effect (effectOfCall): a write runs to its
// end when its effect is a delivery, a publication, a deployment, a package or a creation (RUN_TO_END_EFFECTS). The effect:
//  - in the tenant, the Portal operation's own (effects.mjs effectOf): "mutation-job", a job that changes the tenant's assets
//    (a deployment, a publication, the build of a package, a generation, a bulk creation), whichever tool sends it;
//  - declared by the code that runs the operation when its name does not say it (DECLARED_EFFECTS, each with its source);
//  - else the verb the tool, or the operation it selects (action; command of o11_studio), names (VERB_EFFECTS). A passthrough
//    bridge line (studio_command) names no operation: the family's own tools (studio_publish, studio_merge...) do.
// The base is the write classification: for a Studio tool its Studio writes (isStudioWrite), for any other tool its writes
// (isMutation). Such a call waits for its work (call-deadline.mjs markRunsToEnd, applied by ssam.mjs to every served call,
// and so to the call a nested delivery runs inside: ssam_code write). Every other call keeps the call deadline and its
// continueTask: the reads, and the other writes (open/close, dialogs, sign-in, waits, data rows, grants, settings, closing a
// task). A destructive call (CX15: an undeployment, a delete...) keeps its deadline and its record, whatever its effect.
export const RUN_TO_END_EFFECTS = Object.freeze(['deliver', 'publish', 'deploy', 'package', 'create']);
const VERB_EFFECTS = Object.freeze({ deliver: 'deliver', merge: 'deliver', refresh: 'deliver', publish: 'publish', deploy: 'deploy', create: 'create' });
// Kept equal to o11-environment.mjs CREATING (the test compares them): add-modules creates the modules it names.
const ENVIRONMENT_EFFECTS = Object.freeze({ 'create-app': 'create', 'add-modules': 'create', 'create-module': 'create',
  'set-user-provider': 'publish' }); // o11-environment.mjs: set-user-provider changes the module and publishes it
const DECLARED_EFFECTS = Object.freeze({
  o11_environment: a => ENVIRONMENT_EFFECTS[a.action] ?? null,
  o11_access: a => (a.action === 'apply' ? 'deliver' : null), // o11-access.mjs: one ordinary deliver per owner module
  o11_service_center_write: a => (a.action === 'apply-settings' ? 'deploy' : null), // the Service Center redeploys the application
  ssam_debug_run: a => (a.op === 'run' ? 'publish' : null), // publishes the debug wrapper the run goes through
  continue: () => 'deliver', // the O11 app session resumes the accepted delivery: snapshot, compilation, merge (kernel deliver --resume)
});
// The tenant jobs that change assets, by what they make: a package (a build, a library generation), a creation (users in
// bulk); every other one (a deployment, a publication) deploys.
const TENANT_JOB_EFFECTS = Object.freeze({
  'build-operations-api-v1:post:/build-operations': 'package', 'native-application-orchestration-service-api-v1:post:/build-operations': 'package',
  'external-library-generation-api-v1:post:/generation-operations': 'package', 'user-access-management-api-v1:post:/users/bulk': 'create',
});
const TENANT_EFFECTS = Object.freeze({
  odc_deploy: () => 'deploy', // POST deployment-operations: Deploy or ApplyConfigs of an app revision to a stage
  odc_write: a => { const c = odcWriteCatalog(); try { return c && effectOf(c.get(a.operationId).operation, a.body) === 'mutation-job' ? TENANT_JOB_EFFECTS[a.operationId] ?? 'deploy' : null; } catch { return null; } },
});
const namedWords = (name, a) => [name, a.action, name === 'studio_command' ? null : a.command]
  .flatMap(text => (typeof text === 'string' ? text.toLowerCase().split(/[^a-z0-9]+/) : []));
export function effectOfCall(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  if (Object.hasOwn(TENANT_EFFECTS, name)) return TENANT_EFFECTS[name](a);
  const declared = DECLARED_EFFECTS[name]?.(a);
  if (declared) return declared;
  for (const word of namedWords(name, a)) if (Object.hasOwn(VERB_EFFECTS, word)) return VERB_EFFECTS[word];
  return null;
}
export function runsToEnd(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  if (phaseOfCall(name, a) != null) return false;
  if (!(Object.hasOwn(STUDIO_WRITE_TOOLS, name) ? isStudioWrite(name, a) : isMutation(name, a))) return false;
  return RUN_TO_END_EFFECTS.includes(effectOfCall(name, a));
}
// What a write works on, for the end of the replays it makes stale (replay-store.mjs): its subjects, the module, app or name
// its arguments name (none: every subject); dependsOnOthers, a publication, deployment, package or refresh (or a delivery that
// also publishes), whose outcome depends on the other modules too.
export function subjectsOf(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  return [...new Set([a.module, a.app, a.application, a.name, a.feature, a.assetKey, a.applicationKey, a.args?.module]
    .filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().toLowerCase()))];
}
export function dependsOnOthers(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  return a.publish === true || ['publish', 'deploy', 'package'].includes(effectOfCall(name, a)) || namedWords(name, a).includes('refresh');
}
// Round 3b (Integradora, 2026-10-18: where the content cannot be checked, no replay and no blind join). A run-to-end call
// keeps its final answer for the identical call (replay-store.mjs) only when what it works on is in its arguments and the
// files they name: a delivery (its job), a creation. A publication, a refresh, a deployment or a package works on what the
// Studio or the tenant holds at that moment (the module open in the Studio, an app's revision or settings), which no print
// covers: it keeps no replay, neither the round 2 one nor the CX12 answer of a cancelled call (call-deadline.mjs); an
// identical call joins it only while it runs, and after its end runs again. A call a delivery runs inside (ssam_code write)
// takes the rule of the call nested in it (replay-store.mjs outerPrints).
const LIVE_STATE_EFFECTS = new Set(['publish', 'deploy', 'package']);
export function keepsReplay(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  return !LIVE_STATE_EFFECTS.has(effectOfCall(name, a)) && !namedWords(name, a).includes('refresh');
}
// Round 3d (re-review M3, Integradora, 2026-10-18): a call a delivery runs inside, ssam_code write (it delivers through
// o11_deliver/studio_deliver), is in the family by the mark of that nested delivery, and what it delivers is in its own
// arguments and files: the deadline joins and replays it by their content too (replay-store.mjs inputsOf), the same rule as
// every other delivery, never by its arguments alone.
const NESTS_DELIVERY = Object.freeze({ ssam_code: a => a.action === 'write' });
export function nestsDelivery(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  return NESTS_DELIVERY[name]?.(a) === true && isMutation(name, a);
}

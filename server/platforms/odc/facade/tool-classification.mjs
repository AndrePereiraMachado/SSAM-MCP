// One classification for cancellation, persisted outcomes and relays. Unknown tools and operations mutate by default.
// The Studio queue uses the narrower exported STUDIO_WRITE_TOOLS scope: Portal and local-file writes do not hold a Studio.
import { systemModuleName } from './studio-module.mjs';
// Junction CX12 x CX15 (M6 adjustments 1 and 2): the destructive phase decides first. destructive-operations.mjs imports only
// node:*, and the Portal modules below import nothing of the facade: no cycle.
import { destructivePhase } from './destructive-operations.mjs';
import { writeIsDestructive } from '../portal/runtime/effects.mjs';
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
const o11DataWrites = request => O11_DATA_WRITES.has(request?.operation)
  || (Array.isArray(request?.batch) && request.batch.some(op => O11_DATA_WRITES.has(op?.operation)));
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
  studio_refresh_references: always, studio_data_insert: always, studio_data_update: always, studio_data_delete: always,
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
    return ops.length > 0 && ops.every(op => ['read', 'read-all'].includes(op?.operation));
  },
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

// Continuations: the next MCP call of every known refusal and hint (plan §4.1, lane Z). A refusal of the release never
// sends the model to a shell: it carries `continuation: {tool, arguments, why}`, where tool is one of the 79 tools of
// plan §4.2 (MCP_TOOLS). The facade lanes (D, G, H, I, N, Q, Y, J) take their continuations from here, and the kernel
// mirrors the ones it needs as C# constants (lane S, kernel/src/Anvil.Core/Kernel/McpContinuations.cs).
//
// Pure data and two small functions: no I/O, no clock, no state. Nothing here is release-only, so the checkout may use
// it as it is. Texts (`why`) are English (owner rule 15/10/2026: every text SSAM emits is English), short, for the
// model and the person; arguments use the tool's own names.
//
// Placeholders: an argument value written `<...>` (e.g. lane "<lane>", host "<host>", path "@<key>") is filled by
// continuationFor(code, values) with values[<argument name>]. WORDS stands for the user's own authorization words and
// is never filled: only the person gives them, quoted verbatim, after the model asks.
//
// Mirror contract for lane S (checked by platforms/odc/tests/continuations.test.mjs when the C# file exists):
//   - every code of KERNEL_CODES has `const string <Name> = "<callText(code)>";` in McpContinuations.cs, where <Name> is
//     the code in PascalCase (DIALOG_WEB -> DialogWeb, O11_SC_SECRET_NOT_FOUND -> O11ScSecretNotFound);
//   - an optional `const string <Name>Why = "<why>";` carries the reason;
//   - every constant there mirrors a code of this table (plain literals, `+` allowed; no other constant).
//
// Same tool and argument names as platforms/odc/facade/responses.mjs (front "MCP completo e velocidade") where both
// cover a case: o11_studio {command:"dismiss-dialog", args:{title}}, ssam_doctor {lane} for a missing component,
// ssam_job {lane, job}, ssam_reference {lane, kind, query}, o11_inspect {oml, path, expectedSourceSha256},
// o11_deliver {module, job, checks, authorize}, ssam_connect {lane}, studio_attach {pid}, odc_portal_routes {tenant, module}.
// formatCall writes the same notation as its formatCall.

export const WORDS = "<the user's own words>";
// A continuation that is the refused call itself, corrected (INPUT_INVALID: the same tool with `corrected`) or repeated
// (CREDENTIAL_PROMPT_PENDING: the same call once the prompt is answered). continuationFor fills the tool and the
// arguments from values {tool, arguments}; without them the markers stay.
export const SAME_TOOL = '<the same tool>';

// Plan §4.2: 66 tools of today (3 widened) plus 13 new ones, then the live tools the guides and the continuations name
// (o11_publish, ssam_grant, ssam_evidence, ssam_map's siblings). The list never changes with the license, the Studio or
// the connection (§4.1).
export const MCP_TOOLS = Object.freeze([
  // lifecycle
  'ssam_status', 'ssam_doctor', 'ssam_license', 'ssam_setup', 'ssam_update', 'ssam_credentials', 'ssam_reprove', 'ssam_task',
  'ssam_connect', 'ssam_friction', 'ssam_grant', 'ssam_evidence',
  // knowledge
  'ssam_discover', 'ssam_map', 'ssam_code', 'ssam_app_url', 'hybrid_tenants', 'ssam_reference',
  // O11 lane
  'context', 'propose', 'continue', 'status', 'o11_job', 'o11_data', 'o11_access', 'o11_dependencies', 'ssam_job',
  'o11_service_center_session', 'o11_service_center_read', 'o11_service_center_write',
  'o11_inspect', 'o11_deliver', 'o11_environment', 'o11_studio', 'o11_publish',
  // GitSSAM integrations (2026-10-05): .NET extensions without Integration Studio, ODC External Libraries
  'o11_extension', 'odc_external_library',
  // ODC lane: the 28 studio_* of platforms/odc/facade/mcp.mjs, the catalog, the tenant access and the Portal routes
  'studio_doctor', 'studio_attach', 'studio_status', 'studio_wait', 'studio_assets', 'studio_consumers', 'studio_data',
  'studio_data_insert', 'studio_data_update', 'studio_data_delete', 'studio_open', 'studio_close', 'studio_snapshot',
  'studio_reference_producers', 'studio_reference_snapshot', 'studio_latest', 'studio_refresh_references', 'studio_dismiss_dialog', 'studio_build',
  'studio_inspect', 'studio_check_base', 'studio_preview', 'studio_merge', 'studio_authorize', 'studio_publish',
  'studio_create', 'studio_create_app', 'studio_command', 'studio_manifest', 'studio_deliver',
  'odc_status', 'odc_portal_capabilities', 'odc_describe_capability', 'odc_list_apis', 'odc_search_operations',
  'odc_describe_operation',
  'odc_auth_status', 'odc_read', 'odc_write', 'odc_receipt', 'odc_portal_read', 'odc_portal_write', 'odc_portal_login',
  'odc_operation_status', 'odc_deploy', 'odc_configurations', 'odc_asset_delete', 'odc_external_db_connection',
  'odc_portal_routes',
  // debugger
  'ssam_debug',
]);

const PROMPT = 'the tool opens the private Windows prompt; the person types there, never in the chat; then repeat the call';
const NOT_IN_RELEASE = 'component missing from the release; the session never compiles: reinstall or update (ssam_update)';
const ASK_PERSON = 'ask the person to answer the dialog in the Studio; this call waits for it to close, then repeat';
const c = (tool, args, why) => ({ tool, arguments: args, why });
const noDialogs = why => c('o11_studio', { command: 'wait', args: { condition: 'no-dialogs' } }, why);
const prompt = (kind, why = PROMPT) => c('ssam_credentials', { action: 'prompt', kind, host: '<host>' }, why);

// code -> {tool, arguments, why}. Comments name the text each code replaces (file:line of the base).
const TABLE = {
  // ---- license (LICENCA.md §7; the .NET parts answer license_<state>, the facade turns it into LICENSE_<STATE>)
  LICENSE_NOT_ACTIVATED: c('ssam_license', { action: 'activate' }, 'SSAM is not activated on this machine yet; the tool opens the private Windows prompt and the person types the code there, never in the chat'),
  ACTIVATION_PROMPT_OPENED: c('ssam_license', { action: 'status' }, 'the person types the activation code in the private prompt, never in the chat; then check the state'),
  LICENSE_EXPIRING: c('ssam_license', { action: 'renew' }, 'renewal pending; renew now'),
  LICENSE_GRACE: c('ssam_license', { action: 'renew' }, 'no contact with the license server; SSAM stops at the end of the grace period; renew'),
  LICENSE_EXPIRED: c('ssam_license', { action: 'renew' }, 'the license expired without renewal; connect to the internet and renew; no data and no Studio was changed'),
  LICENSE_REVOKED: c('ssam_license', { action: 'status' }, 'the publisher revoked the license; no data and no Studio was changed; renewing makes it valid again if the publisher reactivates it'),
  LICENSE_CLOCK_INVALID: c('ssam_license', { action: 'renew' }, 'the Windows clock is behind the last known time, or the license state was deleted; fix the clock and renew online'),
  LICENSE_INSTALLATION_MISMATCH: c('ssam_license', { action: 'activate' }, 'this license belongs to another installation; activate with a new code'),
  LICENSE_RELEASE_TOO_OLD: c('ssam_update', { action: 'install', source: { packagePath: '<packagePath>' }, authorize: WORDS }, 'this SSAM version is no longer accepted; install the new version (the package comes from the publisher)'),
  RELEASE_TOO_OLD: c('ssam_update', { action: 'install', source: { packagePath: '<packagePath>' }, authorize: WORDS }, 'this SSAM version is no longer accepted; install the new version (the package comes from the publisher)'),
  LICENSE_UNAVAILABLE: c('ssam_doctor', { checks: ['license'] }, 'the license state could not be read; the doctor shows the license and the activation prompt'),

  // ---- setup (ssam_setup, J)
  SETUP_REQUIRED: c('ssam_setup', { action: 'plan' }, 'shows Studios, free ports, tenants and the registration in each client; applying needs the user\'s words'),
  SETUP_ENTRY_EXISTS: c('ssam_setup', { action: 'plan' }, 'an entry with that name already points elsewhere; overwrite only with replace:true and the user\'s words'),
  PORT_IN_USE: c('ssam_setup', { action: 'plan' }, 'tests each port of the config.json range and says which one is in use'),
  AUTHORITY_MISSING: c('ssam_doctor', { checks: ['authority'] }, 'checks the authority folder and the bridge key, without touching the Studio'),

  // ---- connection (ssam.mjs:52, studio-connect.mjs:116,150-151, lib.mjs:448,452, BridgeClientOdc.cs:48-49)
  STUDIO_NOT_OPEN: c('ssam_status', {}, 'open the Studio as usual (Start menu) and sign in; ssam_status shows the open Studios of each lane'),
  STUDIO_NOT_CONNECTED: c('ssam_connect', { lane: '<lane>' }, 'connects the Studio open on this lane, without saving, publishing or restarting'),
  STUDIO_SESSION_CHANGED: c('ssam_connect', { lane: 'o11' }, 'the selected Studio is no longer connected; connect the Studio that is open now'),
  STUDIO_NOT_SIGNED_IN: c('hybrid_tenants', {}, 'the person signs in to the tenant in the ODC Studio itself; hybrid_tenants shows the session of each tenant'),
  SEVERAL_STUDIOS: c('ssam_connect', { lane: '<lane>', pid: '<pid>' }, 'more than one Studio is open; ssam_status lists the pids; pick one'),
  ODC_STUDIO_NOT_RUNNING: c('studio_attach', {}, 'open the ODC Studio as usual and sign in to the tenant; then this call attaches the bridge'),
  ODC_SEVERAL_STUDIOS: c('studio_attach', { pid: '<pid>' }, 'more than one ODC Studio is open; ssam_status lists the pids; pick one'),
  BRIDGE_NOT_RESPONDING: c('ssam_doctor', { lane: '<lane>', checks: ['studios', 'ports'] }, 'the loaded bridge does not answer; no other DLL is attached over it; the doctor gathers the receipts without touching the Studio'),
  LEGACY_BRIDGE_LOADED: c('ssam_connect', { lane: '<lane>', coexistLegacy: true, authorize: WORDS }, 'the Studio already has a checkout bridge; prefer another Studio; go on beside it only after the risk warning and with the user\'s words'),
  STUDIO_BUSY: c('studio_wait', { condition: 'idle' }, 'the ODC Studio was busy; nothing was sent; wait and repeat'),
  O11_STUDIO_BUSY: c('o11_studio', { command: 'wait', args: { condition: 'idle' } }, 'the Service Studio was busy; nothing was sent; wait and repeat'),
  STUDIO_REQUIRED: c('ssam_connect', { lane: 'odc' }, 'a secret only passes through the Portal window inside the ODC Studio, read by the bridge; connect the ODC Studio and repeat'),

  // ---- credentials (ScSecrets.cs:134, lib.mjs:372,468, odc3-context.mjs:20, debug.mjs:9,43, portal/runtime/access.mjs)
  CREDENTIAL_MISSING: prompt('<kind>'),
  O11_SC_SECRET_NOT_FOUND: prompt('o11-service-center', PROMPT + '; nothing was sent'),
  ODC_API_CLIENT_MISSING: prompt('odc-api-client'),
  ODC_PORTAL_CREDENTIAL_MISSING: prompt('odc-portal'),
  O11_DEBUGGER_CREDENTIAL_MISSING: prompt('o11-debugger', 'the debugger uses the Studio session or the vault; ' + PROMPT),
  SECRET_IN_ARGUMENTS: c('ssam_credentials', { action: 'prompt', kind: '<kind>', host: '<host>' }, 'a secret is never a tool argument; store it through the private prompt and pass only the entry name'),
  CREDENTIAL_PROMPT_OPENED: c('ssam_credentials', { action: 'status', kind: '<kind>', host: '<host>' }, 'the private prompt is open; the person types there, never in the chat; check and repeat the call'),
  // F8 (A13, 2026-10-06): the call waits for the prompt within SSAM_PROMPT_WAIT_MS and, past it, is the continuation itself.
  CREDENTIAL_PROMPT_PENDING: c(SAME_TOOL, { '<arguments>': '<the same>' }, 'a private Windows prompt is open; the person types there, never in the chat; repeat the same call, which resumes where it stopped'),
  CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE: c('odc_portal_login', { action: 'focus', tenant: '<tenant>' }, 'recover the private prompt; only a visibility confirmation allows saying it opened'),
  CREDENTIAL_PROMPT_UNAVAILABLE: c('odc_portal_login', { action: 'focus', tenant: '<tenant>' }, 'the private process did not confirm a window; try to recover it through the prompt\'s own manager'),
  CREDENTIAL_FOCUS_DENIED: c('odc_portal_login', { action: 'focus', tenant: '<tenant>' }, 'Windows did not confirm the focus of the private prompt; do not claim it is in front'),
  CREDENTIAL_PROMPT_CANCELLED: c('odc_portal_login', { action: 'prompt', tenant: '<tenant>' }, 'the prompt was cancelled; reopen it only when the person asks to continue'),
  AUTH_NOT_CONFIGURED: c('ssam_doctor', { checks: ['vault'] }, 'no Studio session, no stored credential, and the private prompt did not open; the doctor shows the vault and the prompt'),
  PORTAL_VAULT_UNAVAILABLE: c('ssam_doctor', { checks: ['vault'] }, 'the Windows vault could not be read; the doctor shows why'),
  API_CLIENT_VAULT_UNAVAILABLE: c('ssam_doctor', { checks: ['vault'] }, 'the Windows vault could not be read; the doctor shows why'),
  PORTAL_AUTH_REQUIRED: c('odc_portal_login', { tenant: '<tenant>' }, 'authenticate through the compatible native session or the saved private profile; authentication that needs another provider or interaction is reported explicitly'),
  WEB_SIGN_IN_REQUIRED: c('odc_portal_login', { tenant: '<tenant>' }, 'check the Portal authentication; without a stored credential, the tool opens and verifies its own private prompt'),
  O11_STUDIO_OPERATION_UNAVAILABLE: c('o11_environment', { action: 'inventory', host: '<host>' }, 'this operation has no path through the connected Studio session; o11_environment offers only the actions that have one (inventory, download, create-app...)'),

  // ---- update (ssam_update, J)
  UPDATE_AVAILABLE: c('ssam_update', { action: 'check' }, 'a new version is available; check it before installing'),
  RECONNECT_REQUIRED: c('ssam_status', {}, 'the person reconnects the client (/mcp in Claude Code, or restart Claude Desktop); then check the version'),
  UPDATE_PACKAGE_INVALID: c('ssam_doctor', { checks: ['signatures'] }, 'the package does not match (signature, hashes or minRelease); nothing was installed'),
  RELEASE_IN_USE: c('ssam_update', { action: 'prune', dryRun: true }, 'a live process or a connection record uses that release; the dryRun shows what stays'),
  RELEASE_INTEGRITY: c('ssam_doctor', { checks: ['install', 'signatures'] }, 'release files changed or are missing; reinstall or update'),
  SMART_APP_CONTROL_BLOCKED: c('ssam_doctor', { checks: ['signatures'] }, 'Windows blocked an unsigned binary; the doctor shows the Smart App Control state'),
  TASK_RUNNING: c(SAME_TOOL, { continueTask: '<taskId>' }, 'the same tool waits up to 25 s for the result; never repeat the original call nor sleep'),
  TASK_NOT_FOUND: c('ssam_task', {}, 'lists the task records of this root'),
  TASK_TOOL_MISMATCH: c(SAME_TOOL, { continueTask: '<taskId>' }, 'continue through the tool that started this task'),
  TASK_ORPHANED: c('ssam_doctor', { lane: '<lane>' }, 'reconcile the state of the lane; never repeat an uncertain write'),
  TASK_ANSWER_UNAVAILABLE: c('ssam_task', { id: '<taskId>' }, 'read the record and reconcile the stored result'),

  // ---- compat (the static check before every attach)
  INCOMPATIBLE_STUDIO: c('ssam_doctor', { lane: '<lane>', checks: ['compat'] }, 'static check, without touching the Studio; nothing was sent; the answer lists members and versions'),
  STUDIO_CHANGED: c('ssam_connect', { lane: '<lane>', dryRun: true }, 'the Studio changed version; the dryRun only checks and sends nothing to the Studio'),
  CAPABILITY_UNAVAILABLE: c('ssam_doctor', { lane: '<lane>', checks: ['compat'] }, 'the selftest marked this capability as unavailable in this Studio'),
  FEATURE_NOT_IN_RELEASE: c('ssam_discover', { intent: '<intent>', lane: 'odc' }, 'this builder feature is not in the release; discover the equivalent job operation'),

  // ---- dialogs (DialogPolicy.cs:54-58, MergeHandler.cs:74; D-DONOS-4: a web dialog goes back to the person)
  DIALOG_OPEN: c('o11_studio', { command: 'dismiss-dialog', args: { title: '<dialog title>' } }, 'closes only a window with an owner, by its title, like the X (Cancel), if the person agrees; a web dialog: ask the person to answer it in the Studio and repeat'),
  DIALOG_RECOVERY: noDialogs('recovery dialog (Open | Discard): the person chooses in the Studio; this call waits for it to close, then repeat'),
  DIALOG_MANAGE_DEPENDENCIES: noDialogs('references dialog: the person chooses in the Studio (Manage Dependencies and Apply updates; Cancel opens without updating); never restart the Studio for it'),
  DIALOG_MERGE_EDITOR: noDialogs('a merge editor is open: the person finishes or cancels it in the Studio; never restart the Studio for it'),
  DIALOG_WEB: noDialogs('web dialog the bridge does not read: ' + ASK_PERSON),
  ODC_DIALOG_OPEN: c('studio_dismiss_dialog', { caption: '<caption>', action: '<action>' }, 'only when the person has already decided; the bridge closes informational dialogs by itself'),

  // ---- missing component (ssam.mjs:51, lib.mjs:73,122,174,444, kernel-delivery.mjs:18,41, discovery.mjs:582,
  //      BridgeClientOdc.cs:58): in a release nothing is built on the person's machine
  COMPONENT_MISSING: c('ssam_doctor', { lane: '<lane>' }, NOT_IN_RELEASE),
  ODC_BRIDGE_CLIENT_MISSING: c('ssam_doctor', { lane: 'odc' }, NOT_IN_RELEASE),
  WORKER_UNAVAILABLE: c('ssam_doctor', { lane: '<lane>', checks: ['workers'] }, 'the lane worker did not answer; the doctor shows the state of the workers'),

  // ---- O11 by MCP instead of the CLI (ssam.mjs:142-143,264,284, discovery.mjs:80-81, module-map.mjs:292,
  //      lanes.mjs:66-69, FunctionCatalog.cs:129, ExpressionCheck.cs:66, Verbs.cs:536,549,1056, DataPreflight.cs:49,
  //      ReferenceRefresher.cs:128, NativeReferenceSnapshot.cs:104, the internal-routes verb of the ODC CLI)
  O11_INSPECT_BY_KEY: c('o11_inspect', { oml: '<capture.oml>', path: '@<key>', expectedSourceSha256: '<sha256>' }, 'reads the subtree, the properties and the usages of the element by the @key of the same capture'),
  O11_DELIVER: c('o11_deliver', { module: '<module>', job: '<job.json>', checks: ['<check>'], authorize: WORDS }, 'delivers by merge in the Service Studio; never publishes'),
  O11_PUBLISH_BY_PERSON: c('o11_studio', { command: 'status' }, 'publishing on O11 stays with the person, in the Service Studio, after the merge; the status shows the open module'),
  RUN_JOB: c('ssam_job', { lane: '<lane>', job: '<job.json>' }, 'applies the job to a fixture and returns ok/isValid and the messages; delivers nothing to the Studio; only when the person asks for a headless proof: to change the module, deliver directly (studio_deliver / o11_deliver validates inside the call)'),
  // A module name that is no module open in the ODC Studio (studio-module.mjs resolveOpenModule): nothing was sent.
  // O11 (F4, A29): continuationFor(code, {lane:'o11'}) answers o11_environment {action:"download", module} (LANE_TABLE).
  MODULE_NOT_OPEN: c('studio_open', { module: '<module>' }, 'the module is not open in the ODC Studio; this opens it from the organization; then repeat the call with the same arguments (on O11: o11_environment {action:"download", module})'),
  FUNCTIONS_LOOKUP: c('ssam_reference', { lane: 'o11', kind: 'functions', query: '<name>' }, 'built-in function catalog of the lane'),
  API_CONTRACT: c('ssam_reference', { lane: '<lane>', kind: 'api', query: '<Interface>' }, 'contract of the Model API and of the kernel ops of the lane'),
  O11_PRODUCER_CAPTURE: c('ssam_job', { lane: 'o11', job: '<job.json>', captureProducers: ['<Producer>'] }, 'the producer signature is not an attested capture of the O11 server; the runner captures it read-only, through the signed-in Studio, and binds it to the job'),
  ODC_PORTAL_ROUTES: c('odc_portal_routes', { tenant: '<tenant>', module: '<module>' }, 'internal Portal routes of a module'),

  // ---- the refusal codes of the 2026-10-06 package (docs/PACOTE-ATRITOS-2.md section 5.3). Each lane puts the code and
  //      its continuation on its own answers; this table is the catalog (and the refusals guide).
  INPUT_INVALID: c(SAME_TOOL, { '<arguments>': '<corrected>' }, 'the same tool with the arguments of corrected (each violation has path, message and accepted); nothing ran'),
  DISCOVERY_INDEX_INVALID: c('ssam_doctor', {}, 'the discover index does not match the sources of this release; the doctor shows the release and the index'),
  DATA_PROOF_DIFFERS: c('ssam_evidence', { file: '<task>/result.json', pointer: '/dataProof/differences' }, 'the delivered data differ from the job; each difference has element, property, expected and actual'),
  PRODUCER_SIGNATURE_MISSING: c('o11_dependencies', { action: 'list', producer: '<producer>' }, 'lists the public elements of the producer; each missing one says the cause (private, not published, theme or missing) and the fix'),
  STUDIO_WRITE_QUEUE_TIMEOUT: c('o11_studio', { command: 'status' }, 'the write waited for its turn in the Studio queue past the limit; read the state (on ODC: studio_status) before repeating'),
  SYSTEM_MODULE_NOT_OPENABLE: c('ssam_map', { lane: 'o11', target: '<module>' }, 'Users, OutSystemsUI and System do not open as modules; the map reads the published OML without opening a tab'),
  DOCTOR_LANE_UNUSABLE: c('ssam_connect', { lane: '<lane>' }, 'the requested lane is not usable; this connects its already open Studio, without saving, publishing or restarting'),
  RELEASE_CHANGED: c('ssam_doctor', {}, 'the release changed under this session; restart this MCP server (Claude Code: /mcp and reconnect; Codex: restart the session)'),
  WRONG_SERVER: c('ssam_doctor', {}, 'this MCP server is not the one of the session folder; the doctor shows the root of each'),
  TOOL_CATALOG_STALE: c('ssam_doctor', {}, 'the tool catalog changed since the server started; restart the MCP server'),
  MODULE_RESERVED: c('ssam_task', { id: '<id>' }, 'an earlier delivery of this root still holds the module; read the task to resume or close it'),
  MODULE_RESERVED_FOREIGN: c('ssam_doctor', { lane: 'o11' }, 'the module is reserved by another SSAM root; the doctor shows the reservation and how to release it with the user\'s words'),
  BLANK_UI_MODULE: c('o11_environment', { action: '<action>' }, 'repeat the same call without blank: blank applies only to Service and Library modules'),

  // ---- the refusal codes of the atritos 3 package (docs/PACOTE-ATRITOS-3.md section 5.3), registered here outside
  //      KERNEL_CODES (no C# mirror); each lane puts the code and its continuation on its own answers.
  PUBLISH_BLOCKED_BY_DIALOG: c('o11_studio', { command: 'refresh-references', args: { module: '<module>' } }, 'the publish stopped at a Studio dialog; with Manage Dependencies, refresh-references updates the references; with another dialog, o11_studio {command:"status"} shows which one'),
  EVIDENCE_FILTER_INVALID: c('ssam_evidence', { file: '<file>', where: '<example>' }, 'the same read with the example clause, built from the fields the rows of the file have'),
  STUDIO_WINDOWLESS: c('ssam_connect', { lane: 'o11' }, 'this Service Studio has no main window: SSAM ignores it and the Studio with a window is the one of the lane; SSAM never closes nor ends a Studio'),
  DUPLICATE_MCP_ENTRY: c('ssam_doctor', {}, 'two MCP entries point to the same SSAM server; use only one (one MCP entry per server)'),
  PATH_OUTSIDE_WORKSPACE: c(SAME_TOOL, { '<arguments>': '<the same, with the job inline or agent:inbox/name>' }, 'job: repeat the same call with the job itself inline (compact JSON); another file of the user: write it to the agent inbox with the Write tool (UTF-8) and repeat with agent:inbox/<name>'),

  // ---- lane wp of the atritos 3 package (the build pool, studio-write-lock.mjs and build-pool.mjs): a delivery whose
  //      module guard or build worker did not come within the queue limit; nothing of it ran.
  BUILD_QUEUE_TIMEOUT: c('ssam_doctor', {}, 'the delivery waited for another delivery of the same module, or for a build worker, past the limit; none of it ran: the doctor shows the lane, and the same delivery may be repeated'),

  // ---- the O11 tab codes (o11-studio.mjs close-module, o11_publish/snapshot/refresh-references by key; lane mb2 and the
  //      16th release) and the dependencies-dialog refresh of lane mb2 (o11-studio.mjs, Delivery.ReferencesRefreshFailedCode).
  MODULE_TAB_NOT_CLOSABLE: c('o11_publish', { module: '<module>' }, 'the tab has unsaved changes, is still opening or has a pending operation; nothing was closed: the publish saves the module (with the user\'s words), then close the tab'),
  MODULE_TAB_AMBIGUOUS: c('o11_studio', { command: 'status' }, 'two Studio tabs have that name; the status shows the tabs with the key of each: pass moduleKey'),
  REFERENCES_REFRESH_FAILED: c('o11_studio', { command: 'refresh-references', args: { module: '<module>' } }, 'the dependencies dialog was answered (Cancel), but the references refresh failed; repeat the refresh of the module and then the same call'),

  // ---- F5, the family rule of producer signatures (producer-signatures.mjs, Delivery.ProducerChangedCode): a producer
  //      published again since the capture a delivery reused, seen right before the merge; nothing was written.
  PRODUCER_CHANGED: c('o11_deliver', { module: '<module>', job: '<job.json>', authorize: WORDS }, 'a producer was published again since the capture; nothing was written: the same delivery again (with closePrevious of the refused task) captures the new version; on ODC, the same studio_deliver'),
  // fix-ext-refs (Delivery.ReferencesNotAddedCode, ManageDependencies.Code): the Studio's own Manage Dependencies refused the
  // producer elements a delivery needs; nothing was applied and every problem carries its fix.
  REFERENCES_NOT_ADDED: c('o11_dependencies', { action: 'list', producer: '<producer>' }, 'The Studio\'s Manage Dependencies added nothing and the module is unchanged: list what the producer publishes, follow the fix of each problem (publish the producer with the element public, or name it by its original key), then deliver the same job again'),
};

// The same code answered by the other lane with another call: continuationFor(code, {lane}) prefers these.
const LANE_TABLE = {
  o11: {
    // module-map.mjs / o11-studio.mjs (A29): a closed O11 module is read from its published OML, never opened.
    MODULE_NOT_OPEN: c('o11_environment', { action: 'download', module: '<module>' }, 'the module is not open in the Service Studio; this downloads the published OML without opening a tab'),
  },
  odc: {
    STUDIO_WRITE_QUEUE_TIMEOUT: c('studio_status', {}, 'the write waited for its turn in the ODC Studio queue past the limit; see the running command before repeating'),
  },
};

function freeze(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
export const CONTINUATIONS = freeze(TABLE);
export const LANE_CONTINUATIONS = freeze(LANE_TABLE);
// The codes of section 5.3 of docs/PACOTE-ATRITOS-2.md (registered here, outside KERNEL_CODES: no C# mirror needed).
export const PACKAGE_CODES = Object.freeze(['INPUT_INVALID', 'DISCOVERY_INDEX_INVALID', 'DATA_PROOF_DIFFERS', 'PRODUCER_SIGNATURE_MISSING',
  'STUDIO_WRITE_QUEUE_TIMEOUT', 'SYSTEM_MODULE_NOT_OPENABLE', 'MODULE_NOT_OPEN', 'DOCTOR_LANE_UNUSABLE', 'RELEASE_CHANGED', 'WRONG_SERVER',
  'TOOL_CATALOG_STALE', 'MODULE_RESERVED', 'MODULE_RESERVED_FOREIGN', 'BLANK_UI_MODULE', 'CREDENTIAL_PROMPT_PENDING']);
// The codes of section 5.3 of docs/PACOTE-ATRITOS-3.md.
export const PACKAGE_3_CODES = Object.freeze(['PUBLISH_BLOCKED_BY_DIALOG', 'EVIDENCE_FILTER_INVALID', 'STUDIO_WINDOWLESS', 'DUPLICATE_MCP_ENTRY',
  'PATH_OUTSIDE_WORKSPACE']);
// The code of lane wp (the build pool), outside the contract's section 5.3.
export const BUILD_POOL_CODES = Object.freeze(['BUILD_QUEUE_TIMEOUT']);
// The O11 tab and dependencies-dialog codes (lane mb2 and the 16th release), outside the contract's section 5.3.
export const O11_TAB_CODES = Object.freeze(['MODULE_TAB_NOT_CLOSABLE', 'MODULE_TAB_AMBIGUOUS', 'REFERENCES_REFRESH_FAILED']);
// F5: the producer signature codes (no C# mirror needed: the facade answers the continuation).
export const PRODUCER_SIGNATURE_CODES = Object.freeze(['PRODUCER_CHANGED', 'REFERENCES_NOT_ADDED']);

// The codes the kernel answers itself (lane S mirrors them in McpContinuations.cs): DialogPolicy.Hint (Recovery,
// ManageDependencies, MergeEditor, WebDialog, default) and MergeHandler.cs:74 (B); ScSecrets.cs:134;
// BridgeClientOdc.cs:48,49,58; HeadlessSession.cs:27; FunctionCatalog.cs:129 and ExpressionCheck.cs:66 (FUNCTIONS_LOOKUP);
// ReferenceRefresher.cs:128 and NativeReferenceSnapshot.cs:104 (O11_PRODUCER_CAPTURE). API_CONTRACT (Verbs.cs:536,549,1056,
// DataPreflight.cs:49) stays out: its lane is open (<lane>), and S fills it with the lane of the build.
export const KERNEL_CODES = Object.freeze(['DIALOG_RECOVERY', 'DIALOG_MANAGE_DEPENDENCIES', 'DIALOG_MERGE_EDITOR', 'DIALOG_WEB',
  'DIALOG_OPEN', 'O11_SC_SECRET_NOT_FOUND', 'ODC_STUDIO_NOT_RUNNING', 'ODC_SEVERAL_STUDIOS', 'ODC_BRIDGE_CLIENT_MISSING',
  'O11_STUDIO_OPERATION_UNAVAILABLE', 'FUNCTIONS_LOOKUP', 'O11_PRODUCER_CAPTURE']);

const isPlaceholder = v => typeof v === 'string' ? /<[^<>]+>/.test(v) && v !== WORDS
  : Array.isArray(v) && v.length > 0 && v.every(isPlaceholder);
function fill(args, values) {
  const out = {};
  for (const [key, v] of Object.entries(args)) {
    if (key !== 'authorize' && Object.hasOwn(values, key) && values[key] !== undefined && isPlaceholder(v)) out[key] = values[key];
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[key] = fill(v, values);
    else out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

// The continuation of a code as a fresh object {tool, arguments, why}, or null for an unknown code. values fills the
// placeholders by argument name (lane, host, kind, pid, tenant, title...); fixed values and the user's words never change.
// values.lane picks the other lane's call when the code has one (LANE_CONTINUATIONS). A SAME_TOOL entry takes its tool
// and arguments from values {tool, arguments} (the user's words in them become the marker).
export function continuationFor(code, values = {}) {
  values ??= {};
  const byLane = typeof values.lane === 'string' && Object.hasOwn(LANE_CONTINUATIONS, values.lane) && Object.hasOwn(LANE_CONTINUATIONS[values.lane], code)
    ? LANE_CONTINUATIONS[values.lane][code] : null;
  const entry = byLane ?? (Object.hasOwn(CONTINUATIONS, code) ? CONTINUATIONS[code] : null);
  if (!entry) return null;
  if (entry.tool === SAME_TOOL && typeof values.tool === 'string' && values.tool && values.arguments && typeof values.arguments === 'object' && !Array.isArray(values.arguments)) {
    const args = structuredClone(values.arguments);
    for (const key of ['authorize', 'words']) if (typeof args[key] === 'string') args[key] = WORDS;
    return { tool: values.tool, arguments: args, why: entry.why };
  }
  return { tool: entry.tool, arguments: fill(entry.arguments, values), why: entry.why };
}

// `tool {key:"value", n:1}`: the notation of the tool descriptions (and of responses.mjs formatCall).
export function formatCall(tool, args = {}) {
  const value = v => (v !== null && typeof v === 'object' && !Array.isArray(v)
    ? '{' + Object.entries(v).map(([k, x]) => k + (x === true ? '' : ':' + JSON.stringify(x))).join(', ') + '}'
    : JSON.stringify(v));
  return tool + ' {' + Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => k + ':' + value(v)).join(', ') + '}';
}

// The continuation of a code written as a call, for a text (kernel messages, guides); null for an unknown code.
export function callText(code, values) {
  const next = continuationFor(code, values);
  return next ? formatCall(next.tool, next.arguments) : null;
}

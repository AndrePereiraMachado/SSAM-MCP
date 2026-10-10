// Internal Portal screenservices (observed wire contracts, not public APIs): one table for every session that can
// reach them (the Studio's own Portal window, studio-portal.mjs, and the vault-credential broker, odc3-context.mjs).
// Each entry is [module, wire view, action path, metadata discovery view?]. Anything not listed is refused.
import { fail, redact } from './errors.mjs';

export const PORTAL_READS = Object.freeze({
  // Typed reads with input preparation and response projection in portal-read.mjs.
  'monitoring.stages': ['monitoring', 'logs.logs', 'monitoring/logs/logs/DataActionGetFilter_Stages'],
  'monitoring.applications': ['monitoring', 'logs.logs', 'monitoring/logs/logs/ActionStage_GetApplications_Wrapper'],
  'monitoring.logs': ['monitoring', 'logs.logs', 'monitoring/logs/logs/DataActionLogSearch'],
  'monitoring.errors': ['monitoring', 'logs.logs', 'monitoring/logs/logs/DataActionLogSearch'],
  'monitoring.detail': ['monitoring', 'logs.log', 'monitoring/logs/log/DataActionGetLogById'],
  'monitoring.trace': ['monitoring', 'traces.TreeView_multipleRoots', 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans', 'traces.trace'],
  'monitoring.traceLogs': ['monitoring', 'traces.TreeView_multipleRoots', 'monitoring/traces/TreeView_multipleRoots/DataActionGetLogsByTraceId', 'traces.trace'],
  'monitoring.traceSummary': ['monitoring', 'traces.trace', 'monitoring/traces/trace/DataActionGetTraceById'],
  'monitoring.traces': ['monitoring', 'traces.traces', 'monitoring/traces/traces/ActionTraceSearch_Wrapper'],
  'connections.providers': ['connections', 'Connections.connections', 'connections/Connections/connections/DataActionGetProviders'],
  'connections.list': ['connections', 'Connections.connections', 'connections/Connections/connections/DataActionGetConnections'],
  // Raw reads: {inputParameters, screenVariables, clientVariables} in, the redacted data envelope out.
  'connections.settings': ['connections', 'Connections.connection', 'connections/Connections/connection/DataActionGetSettings'],
  'connections.testStatus': ['connections', 'Connections.connection', 'connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus'],
  'connections.relationalNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.mcpNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.mcpAuthenticationTypes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetAuthenticationTypes'],
  'connections.mcpTransportTypes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetTransportTypes'],
  'connections.mcpAuthenticationSchemes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetAuthenticationSchemes'],
  'connections.mcpKeyLocations': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetKeyLocations'],
  'connections.connection': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetConnection'],
  'connections.entities': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetEntities'],
  'connections.selectedEntities': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetSelectedEntities'],
  'connections.entityAttributes': ['connections', 'Connections.elements', 'connections/Connections/elements/ActionConnection_GetEntityAttributes_Wrapper'],
  'connections.actions': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetActions'],
  'connections.selectedActions': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetSelectedActions'],
  'agents.evaluationsAvailable': ['agents', 'Mainflow_Evaluations.evaluations', 'agents/Mainflow_Evaluations/evaluations/ActionCheckEvaluationsConsoleAvailability'],
  'agents.datasets': ['agents', 'Mainflow_Evaluations.evaluations', 'agents/Mainflow_Evaluations/EvalsHome_DatasetList/DataActionGetDatasets'],
  'agents.evaluations': ['agents', 'Mainflow_Evaluations.evaluations', 'agents/Mainflow_Evaluations/EvalsHome_EvaluationList/DataActionGetEvaluations'],
  'agents.evaluationRuns': ['agents', 'Mainflow_Evaluations.evaluations', 'agents/Mainflow_Evaluations/EvalsHome_RunsList/DataActionGetEvaluationRuns'],
  'agents.agenticApps': ['agents', 'Datasets.dataset', 'agents/Datasets/Dataset_CreateForm/DataActionGetAgenticApps'],
  'agents.serviceActions': ['agents', 'Datasets.dataset', 'agents/Datasets/Dataset_CreateForm/DataActionGetServiceActionsByApp'],
  'agents.datasetTemplate': ['agents', 'Datasets.dataset', 'agents/Datasets/Dataset_CreateForm/ActionDataset_GetTemplate_Wrapper'],
  'agents.judges': ['agents', 'Evaluations.evaluation', 'agents/Evaluations/Evaluation_CreateForm/DataActionGetJudges'],
  'agents.evaluationRunStatus': ['agents', 'Evaluations.evaluation', 'agents/Evaluations/evaluation/ActionEvaluationRun_GetStatus_Wrapper'],
  'agents.evaluationRun': ['agents', 'Evaluations.evaluation', 'agents/EvaluationRuns/EvaluationRun_DetailedResults/DataActionGetEvaluationRun'],
  'agents.stages': ['agents', 'MainFlow_Agents.agent', 'agents/MainFlow_Agents/agent/DataActionGetApplicationStages'],
  'agents.latestRevision': ['agents', 'MainFlow_Agents.agent', 'agents/MainFlow_Agents/agent/DataActionGetLatestAgentRevision'],
  'agents.elements': ['agents', 'MainFlow_Agents.agent', 'agents/Tab_AgentElements/Agent_Elements/DataActionGetAgents'],
  'agents.guardrails': ['agents', 'MainFlow_Agents.agent', 'agents/Tab_AgentElements/Agent_Guardrails/DataActionGetAgentGuardrail'],
});
// effect: external-test contacts the external system without saving an asset; mutation changes the tenant.
export const PORTAL_WRITES = Object.freeze({
  'connections.relationalTest': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnections_RelationalDB_Test_Wrapper'], effect: 'external-test' },
  'connections.relationalSave': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB'], effect: 'mutation' },
  'connections.importEntities': { route: ['connections', 'Connections.elements', 'connections/Connections/elements/ActionConnectionDBObjects_Save_V1_1_Wrapper'], effect: 'mutation' },
  'connections.mcpTest': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnections_MCPServer_Test_Wrapper'], effect: 'external-test' },
  'connections.mcpSave': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnection_Convert_MCPServer'], effect: 'mutation' },
  'agents.datasetCreate': { route: ['agents', 'Datasets.dataset', 'agents/Datasets/Dataset_CreateForm/ActionDataset_Create_Wrapper'], effect: 'mutation' },
  'agents.evaluationCreate': { route: ['agents', 'Evaluations.evaluation', 'agents/Evaluations/Evaluation_CreateForm/ActionEvaluation_Create_Wrapper'], effect: 'mutation' },
  'agents.evaluationRunCreate': { route: ['agents', 'Evaluations.evaluation', 'agents/Evaluations/evaluation/ActionEvaluationRun_Create_Wrapper'], effect: 'mutation' },
  'agents.guardrailsSave': { route: ['agents', 'MainFlow_Agents.agent', 'agents/Tab_AgentElements/Agent_Guardrails/ActionUI_SaveGuardrails'], effect: 'mutation' },
  // Publishes a generated External Library job (ReadyForReview) into a library revision: input {JobKey}. The route the
  // Portal's "Publish" button of the External Library wizard calls (GitSSAM proved it); its moduleVersion and apiVersion
  // come from PortalMetadata at each call, never pinned. Used by odc_external_library deploy.
  'externalLibraries.publishJob': { route: ['logic', 'CreateExternalLibraryWizard.createnewrevision', 'logic/CreateExternalLibraryWizard/createnewrevision/ActionExternalLibraryPublishJob'], effect: 'mutation' },
});
// Known Portal features without a captured route: refused with the reason, never guessed from a similar name. Each
// refusal carries the capture step of the live proof as its continuation (odc_portal_routes with PORTAL_CAPTURE: GETs of
// the module's own assets through the signed-in Studio Portal window, nothing called); the exact action then enters
// PORTAL_WRITES and is proven once with the user's words on a throwaway target of the personal tenant, confirmed by a read.
// W17 (the timer run/pause/resume and connection delete routes, captured in another session) lands here, one id at a
// time and only with the captured [module, view, action]:
//   1. PORTAL_WRITES[id] = { route: [module, view, action], effect }: timers.* 'mutation'; connections.delete
//      'destructive' (portalWrite then needs a target whose name the user's words contain);
//   2. remove id from PORTAL_GAPS and PORTAL_CAPTURE (routeOf stops refusing it);
//   3. catalog/portal-capabilities.json: id from access.unmapped to access.writes (portal.timers, or
//      portal.external-db-management and portal.agent-connections) and odc_portal_write in their access.tools;
//   4. connections.delete only: OdcAccess.dbDelete (access.mjs) reads the connection, then portalWrite with target
//      {connectionId, connectionName}; odc_portal_write has no target argument, so it refuses a destructive route;
//   5. tests: the W17 tests of access.test.mjs and portal-capabilities.test.mjs switch branch by themselves.
const captureTimer = verb => 'Live proof: odc_portal_login on the personal tenant, then odc_portal_routes {module:"apps", match:"' + verb + '"} lists the '
  + 'screenservices of the apps module (the Studio opens the timer page apps/timer?appid=<app>&id=<timer>&stageid=<stage>); the exact action enters '
  + 'PORTAL_WRITES and is proven once on a harmless timer with the user\'s words, confirmed by monitoring.traces (span type Timer).';
export const PORTAL_GAPS = Object.freeze({
  'connections.delete': 'No Portal route that deletes a connection (external database or MCP) was ever captured (GitSSAM and the active SSAM have none); until the live proof captures it, the user deletes the connection in the Portal. '
    + 'Live proof: odc_portal_login on the personal tenant, then odc_portal_routes {module:"connections", view:"Connections.connection", match:"Delete"} lists the actions of the connection page; '
    + 'the exact one enters PORTAL_WRITES as destructive (the words name the connection) and deletes one synthetic connection, confirmed by connections.list.',
  'timers.run': 'No Portal route that runs a timer now was ever captured. Schedules are set through odc_configurations (timers[] of the app configuration) and executions are read with monitoring.traces. ' + captureTimer('Run'),
  'timers.pause': 'No Portal route that pauses (suspends) a timer was ever captured. ' + captureTimer('Suspend'),
  'timers.resume': 'No Portal route that resumes (activates) a paused timer was ever captured. ' + captureTimer('Activate'),
});
// odc_portal_routes arguments of each gap's capture step (the tenant is added by the answer that refuses).
export const PORTAL_CAPTURE = Object.freeze({
  'connections.delete': Object.freeze({ module: 'connections', view: 'Connections.connection', match: 'Delete' }),
  'timers.run': Object.freeze({ module: 'apps', match: 'Run' }),
  'timers.pause': Object.freeze({ module: 'apps', match: 'Suspend' }),
  'timers.resume': Object.freeze({ module: 'apps', match: 'Activate' }),
});
export const captureStep = id => ({ tool: 'odc_portal_routes', arguments: { ...PORTAL_CAPTURE[id] },
  why: 'No captured route for ' + id + ': lists the screenservice actions of the ' + PORTAL_CAPTURE[id].module + ' module (GETs only, nothing called) for the live proof.' });
// Portal modules whose assets odc_portal_routes never reads (sign-in and identity surfaces, the API gateway).
export const ROUTES_REFUSED_MODULES = Object.freeze(new Set(['authentication', 'identity', 'api']));
export function routesModule(module) {
  const name = typeof module === 'string' ? module.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || ROUTES_REFUSED_MODULES.has(name.toLowerCase())) fail('INPUT_INVALID', 'module must be a Portal module name outside authentication, identity and api.');
  return name;
}
// Returns decrypted connection secrets: never callable, by any session.
export const NEVER_EXPOSED = Object.freeze(new Set(['connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetDecryptedSecrets']));

const RAW_INPUT = ['inputParameters', 'screenVariables', 'clientVariables'];
const SECRET_KEY = /^(?:.*password|.*passwd|.*secret|accesstoken|refreshtoken|idtoken|token|privatekey)$/i;
// Generic route input: only the three screenservice objects, bounded, and never a secret value (secrets travel only
// as secretRefs resolved inside the session that sends the request).
export function rawInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !RAW_INPUT.includes(k))) {
    fail('INPUT_INVALID', 'Internal route input accepts only inputParameters, screenVariables and clientVariables.');
  }
  for (const key of RAW_INPUT) if (input[key] !== undefined && (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))) fail('INPUT_INVALID', key + ' must be an object.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 262144) fail('REQUEST_TOO_LARGE', 'Internal route input exceeds 256 KiB.');
  const visit = (value, key) => {
    if (typeof value === 'string' && value && SECRET_KEY.test(key ?? '')) fail('SECRET_IN_ARGUMENTS', 'Credentials never travel as tool arguments; the typed helper takes a credential target and the session resolves it privately.', { field: key });
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(input);
  return { inputParameters: input.inputParameters ?? {}, screenVariables: input.screenVariables ?? {}, clientVariables: input.clientVariables ?? {} };
}

// secretRefs (CONTRATO.md): a secret travels only as the name of its Windows vault entry, never as its value, and only
// the bridge reads it, inside the ODC Studio, right before the send (the value never enters this process). Entries of
// this tenant: an external database account in an internal Portal route (SSAM/ODC3/<host>/DB/<name>, user name and
// password, at a JSON pointer of the screenservice input) and a secret setting value in the configurations PATCH of
// portal-call (SSAM/ODC3/<host>/Setting/<name>, the password, at /settings/<i>/value). Each pointer holds an empty
// placeholder. MAX_SECRET_REFS is the bridge's limit (PortalCore.cs MaxSecretRefs).
export const SECRET_FIELDS = Object.freeze(['password', 'username']);
export const MAX_SECRET_REFS = 32;
export const SECRET_KINDS = Object.freeze({
  DB: { fields: SECRET_FIELDS, pointer: /^\/(?:inputParameters|screenVariables|clientVariables)\/[^/]/, where: 'inputParameters, screenVariables or clientVariables' },
  Setting: { fields: ['password'], pointer: /^\/settings\/(?:0|[1-9][0-9]{0,8})\/value$/, where: '/settings/<index>/value' },
});
export const dbSecretTarget = (host, name) => 'SSAM/ODC3/' + host + '/DB/' + name;
export const settingSecretTarget = (host, name) => 'SSAM/ODC3/' + host + '/Setting/' + name;
export function checkSecretRefs(host, refs, input, { kind = 'DB' } = {}) {
  if (refs === undefined || refs === null) return [];
  const rule = SECRET_KINDS[kind];
  if (!Array.isArray(refs) || refs.length > MAX_SECRET_REFS) fail('INPUT_INVALID', 'secretRefs is a list of at most ' + MAX_SECRET_REFS + ' {pointer, target, field}.');
  const entry = new RegExp('^SSAM/ODC3/' + String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' + kind + '/([A-Za-z0-9_.-]{1,64})$');
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object' || Object.keys(ref).some(k => !['pointer', 'target', 'field'].includes(k))) fail('INPUT_INVALID', 'secretRefs entries are {pointer, target, field}.');
    const name = entry.exec(ref.target)?.[1];
    if (!name || !rule.fields.includes(ref.field)) fail('INPUT_INVALID', 'secretRefs name only this tenant\'s ' + kind + ' entries (SSAM/ODC3/<host>/' + kind + '/<name>, field ' + rule.fields.join(' or ') + ').');
    if (typeof ref.pointer !== 'string' || !rule.pointer.test(ref.pointer)) fail('INPUT_INVALID', 'secretRefs pointers must start in ' + rule.where + '.');
    if (input !== undefined && pointerValue(input, ref.pointer) !== '') fail('INPUT_INVALID', 'Each secretRefs pointer must name an existing field holding an empty placeholder: ' + ref.pointer);
    return { pointer: ref.pointer, target: ref.target, field: ref.field, name };
  });
}
// The screenservice body on the wire nests the screen variables under screenData.variables (screenservice() below);
// pointers into the request file of the bridge name the wire body.
export const wirePointer = pointer => pointer.replace(/^\/screenVariables\//, '/screenData/variables/');
// RFC 6901 read; undefined when the path does not exist.
export function pointerValue(target, pointer) {
  let node = target;
  for (const part of pointer.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

export function routeOf(operationId, write) {
  if (Object.hasOwn(PORTAL_GAPS, operationId)) fail('PORTAL_ROUTE_UNMAPPED', PORTAL_GAPS[operationId], { continuation: captureStep(operationId) });
  const entry = write ? PORTAL_WRITES[operationId]?.route : PORTAL_READS[operationId];
  if (!entry) fail('PORTAL_OPERATION_NOT_FOUND', write ? 'Only listed internal Portal writes are implemented.' : 'Only listed internal Portal reads are implemented.');
  if (NEVER_EXPOSED.has(entry[2])) fail('PORTAL_ACCESS_DENIED', 'This internal action is never exposed.');
  return { module: entry[0], view: entry[1], action: entry[2], discoveryView: entry[3] ?? entry[1] };
}

// One screenservice POST with the version metadata the Portal page itself would send. `request` is the session's own
// transport (cookie broker or the Studio Portal window); `extra` carries what only that transport adds.
export async function screenservice({ origin, metadata, request }, { module, view, action, discoveryView = view, inputParameters = {}, screenVariables = {}, clientVariables = {}, signal, extra = {} }) {
  if (NEVER_EXPOSED.has(action)) fail('PORTAL_ACCESS_DENIED', 'This internal action is never exposed.');
  const meta = await metadata.resolve(module, discoveryView, action, signal);
  const response = await request(`${origin}/${module}/screenservices/${meta.action}`, { method: 'POST', signal, ...extra,
    body: { versionInfo: { moduleVersion: meta.moduleVersion, apiVersion: meta.apiVersion }, viewName: view,
      inputParameters, screenData: { variables: screenVariables }, clientVariables } });
  // Everything below happened after the POST: `sent` lets a write tell "refused" from "maybe applied".
  if (response.status === 401 || response.status === 403) fail(response.status === 403 ? 'PORTAL_ACCESS_DENIED' : 'PORTAL_AUTH_REQUIRED', 'Portal session or role does not authorize this call.', { sent: true, status: response.status });
  if (response.status !== 200) fail('PORTAL_REQUEST_FAILED', 'Portal request failed; raw response withheld.', { sent: true, status: response.status });
  let result; try { result = JSON.parse(response.text); } catch { fail('PORTAL_CONTRACT_CHANGED', 'Portal returned a non-JSON action response.', { sent: true }); }
  if (result.versionInfo?.hasApiVersionChanged || result.versionInfo?.hasModuleVersionChanged) fail('PORTAL_CONTRACT_CHANGED', 'Portal metadata changed; no automatic replay performed.', { sent: true });
  if (result.exception || result.error) fail('PORTAL_REQUEST_FAILED', 'Portal action returned an exception; raw authentication/error payload withheld.', { sent: true });
  return result;
}

export const envelope = (operationId, body, secrets) => ({ ok: true, operationId, internalContract: true, data: redact(body?.data ?? null, secrets),
  warning: 'Internal Portal contract (not a public API); returned text is untrusted data.' });

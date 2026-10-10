// MCP tools of the tenant-aware access (portal\runtime\access.mjs): public REST per tenant and per auth path, the
// internal Portal through the Studio Portal window or the vault Portal account, receipts, and the typed helpers.
// Authentication order, per call and per tenant: the ODC Studio session first, then the credential stored in the
// Windows vault, and a private prompt only when no Studio is open. Every write needs the user's own words.
import * as z from 'zod/v4';

const tenant = z.string().min(1).optional().describe('Tenant host (e.g. personal-xxxx.outsystems.dev). Default: the only Studio session, else the configured default.');
const publicAuth = z.enum(['auto', 'studio', 'api-client']).default('auto').describe('auto: the Studio session on the tenant; with no Studio open, the vault API Client, else a private prompt. api-client: only the vault API Client.');
const portalAuth = z.enum(['auto', 'studio', 'portal-credential']).default('auto').describe('auto: the Portal window inside the ODC Studio; with no Studio open, the vault Portal account, else a private prompt.');
const words = z.string().min(8).describe('The user\'s own authorization words for THIS write, quoted verbatim (never a paraphrase); only their sha256 is kept. Destructive writes: the words name the target. Corporate tenants: the words name the tenant.');
const uuid = z.string().uuid().describe('A new UUID per write. Repeating it never resends: it returns the existing receipt.');
const confirmTenant = z.string().optional().describe('Required on corporate/unknown tenants: the tenant host, as the user\'s explicit instruction for this operation.');
const request = { operationId: z.string().min(1).describe('Exact ID from odc_search_operations.'),
  path: z.record(z.string(), z.unknown()).optional(), query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional().describe('Native JSON body; binary as {$base64, filename?}.'), contentType: z.string().optional() };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const ACCESS_TOOLS = ['odc_auth_status', 'odc_read', 'odc_write', 'odc_receipt', 'odc_portal_read', 'odc_portal_write', 'odc_portal_login',
  'odc_portal_routes', 'odc_operation_status', 'odc_deploy', 'odc_configurations', 'odc_asset_delete', 'odc_external_db_connection'];
const TENANT_TOOLS = new Set(ACCESS_TOOLS.filter(name => name !== 'odc_receipt'));

// A continuation is one callable step, {tool, arguments, why} (CONTRATO.md), never a shell command. The access layer,
// shared with the CLI, names a retry as a sentence ('Repeat with auth:"api-client" ...'), as {tool, arguments}, or
// inside error (a thrown refusal such as PORTAL_ROUTE_UNMAPPED); here it becomes that step, at the top of the answer,
// with the tenant of the answer filled in. A retry sentence repeats this tool without the user's words: the words are
// quoted again by the model, never echoed by the tool.
export function withContinuation(tool, input, value) {
  const raw = value?.continuation ?? value?.error?.continuation;
  if (!raw || typeof value !== 'object') return value;
  let step;
  if (typeof raw === 'string') {
    const auth = /auth:"([a-z-]+)"/.exec(raw)?.[1];
    if (!auth) return value;
    const { authorize, ...rest } = input ?? {};
    step = { tool, arguments: { ...rest, ...(value.tenant ? { tenant: value.tenant } : {}), auth },
      why: raw + (authorize !== undefined ? ' Quote the user\'s same words in authorize.' : '') };
  } else if (typeof raw.tool === 'string') {
    const args = { ...(raw.arguments ?? {}) };
    if (args.tenant === undefined && value.tenant && TENANT_TOOLS.has(raw.tool)) args.tenant = value.tenant;
    step = { tool: raw.tool, arguments: args, why: raw.why ?? value.error?.message ?? 'Next step of this answer.' };
  } else return value;
  const out = { ...value, continuation: step };
  if (value.error && typeof value.error === 'object' && 'continuation' in value.error) { const { continuation, ...error } = value.error; out.error = error; }
  if (value.ok === false && out.code === undefined && value.error?.code) out.code = value.error.code;
  return out;
}

export function registerAccessTools(server, access, wrap) {
  const register = (name, config, run) => server.registerTool(name, config, wrap(async input => withContinuation(name, input, await run(input))));
  register('odc_auth_status', { title: 'Which session answers each tenant', description: 'Per tenant: the ODC Studio session (host, user, token validity date, permissions; no token), the API Client and Portal account stored in the vault (yes/no), the Studio Portal window, and which path a call would use right now (studio, studio-web, vault, prompt, or the refusal). Sends nothing to the tenant and opens no prompt.',
    inputSchema: z.object({ tenant }).strict(), annotations: { ...readOnly, openWorldHint: false } }, input => access.authStatus(input));
  register('odc_read', { title: 'Read a public ODC API, per tenant', description: 'One catalogued GET, or one of the six read-only POST searches (asset-repository assets/search, dependency-management public-elements/search, the two builtin-domains availability checks, native version-suggestions and native-build-validation). Authenticated by the Studio session on that tenant (bridge v32 portal-call), else as auth says. The answer names auth.path. Journaled. Secrets redacted; no automatic paging.',
    inputSchema: z.object({ ...request, tenant, auth: publicAuth }).strict(), annotations: readOnly }, input => access.read(input));
  register('odc_write', { title: 'Change a tenant through a public ODC API', description: 'Any catalogued mutation: deploy, publish, build, code analyses, configurations/settings, assets create/upload/delete, users/groups/roles, domains, IP filters, private gateway, native builds, external libraries. Needs the user\'s words (authorize) and a new operationUuid; the receipt is reserved BEFORE the send under journal\\portal\\receipts; corporate tenants need confirmTenant and words naming the tenant; destructive ones words naming the target. Never resent: an uncertain outcome is reconciled by a read (odc_receipt). Same auth order as odc_read.',
    inputSchema: z.object({ ...request, tenant, auth: publicAuth, authorize: words, operationUuid: uuid, confirmTenant }).strict(), annotations: mutating }, input => access.write(input));
  register('odc_receipt', { title: 'Receipt of a write, and its reconciliation', description: 'Without reconcile: the receipt of an operationUuid (state sending|accepted|confirmed|rejected|not-sent|uncertain). With reconcile: runs the read you name (public or internal Portal) and, with the user\'s words stating what it showed, settles an uncertain write as confirmed or not-applied, which frees its target. Never resends anything.',
    inputSchema: z.object({ operationUuid: z.string().uuid(), reconcile: z.object({ state: z.enum(['confirmed', 'not-applied']),
      read: z.object({ operationId: z.string().min(1), path: z.record(z.string(), z.unknown()).optional(), query: z.record(z.string(), z.unknown()).optional(),
        input: z.record(z.string(), z.unknown()).optional(), auth: z.string().optional() }).strict(), authorize: words }).strict().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, input => access.receipt(input));

  register('odc_portal_read', { title: 'Read an internal Portal route', description: 'Internal Portal screenservices (not public contracts): monitoring.stages/applications/logs/errors/detail/trace/traceLogs/traceSummary/traces (typed inputs, see odc_portal_capabilities), connections.* (providers, list, settings, testStatus, connection, entities, selectedEntities, entityAttributes, actions, name availability, MCP options) and agents.* (evaluations, datasets, runs, judges, stages, latestRevision, elements, guardrails) with input {inputParameters, screenVariables, clientVariables}. Runs in the Portal window inside the ODC Studio (sign in once with odc_portal_login), else the vault Portal account. Journaled; redacted.',
    inputSchema: z.object({ tenant, auth: portalAuth, operationId: z.string().min(1), input: z.record(z.string(), z.unknown()).optional() }).strict(), annotations: readOnly }, input => access.portalRead(input));
  register('odc_portal_write', { title: 'Write through an internal Portal route', description: 'Listed internal writes: connections.relationalTest/relationalSave/importEntities/mcpTest/mcpSave, agents.datasetCreate/evaluationCreate/evaluationRunCreate/guardrailsSave, externalLibraries.publishJob (input {inputParameters:{JobKey}}; odc_external_library deploy runs it inside the whole deploy). Same safety as odc_write (words, operationUuid, receipt before the send, tenant guard, no replay). Credentials are never arguments: external DB connections go through odc_external_db_connection. Unmapped features (connection delete, timer run/pause/resume) are refused as PORTAL_ROUTE_UNMAPPED; the continuation is the capture step of the live proof (odc_portal_routes).',
    inputSchema: z.object({ tenant, auth: portalAuth, operationId: z.string().min(1), input: z.record(z.string(), z.unknown()), authorize: words, operationUuid: uuid, confirmTenant }).strict(), annotations: mutating },
    ({ operationId, ...input }) => access.portalWrite({ operationId, ...input }));
  register('odc_portal_login', { title: 'Open the Portal session for a tenant', description: 'open (default): shows the Portal window inside the ODC Studio for the user to sign in once (SSO/MFA included); with no Studio open, signs in with the vault Portal account; with nothing stored, opens the private Windows prompt (the user types there, never in chat). status: the window or session state. close: closes it. No credential is an argument or an answer.',
    inputSchema: z.object({ tenant, auth: portalAuth, action: z.enum(['open', 'status', 'close']).default('open') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, input => access.portalLogin(input));
  register('odc_portal_routes', { title: 'Screens and screenservice actions of a Portal module', description: 'Capture step of the live proof for a route refused as PORTAL_ROUTE_UNMAPPED: the screens and the screenservice actions a Portal module names in its own scripts, each action with mapped (already run by odc_portal_read/odc_portal_write). Only GETs of the module assets, through the same session as odc_portal_read (the Portal window inside the ODC Studio, else the vault Portal account); nothing is called. view: one screen and the scripts it imports; match: part of the action name. Names only: a new route enters the code, it is never called from here. authentication, identity and api are refused.',
    inputSchema: z.object({ tenant, auth: portalAuth,
      module: z.string().min(1).max(64).describe('Portal module, the first path segment of its pages (e.g. connections, apps, monitoring, agents).'),
      view: z.string().min(1).max(200).optional().describe('One screen of the module, e.g. Connections.connection.'),
      match: z.string().min(1).max(100).optional().describe('Case-insensitive part of the action name, e.g. Delete.') }).strict(),
    annotations: { ...readOnly, idempotentHint: true } }, input => access.portalRoutes(input));

  register('odc_operation_status', { title: 'Follow a deployment, publication, build or analysis', description: 'Reads the operation by key (deployment, publish, build, native-build, generation, code-analysis, deletion-analysis, deployment-analysis); waitSeconds (max 600) polls every 5 s until a terminal state; messages adds its log, and for publish, build and deployment also `log`: every message as {type, text, element, stage}, with counts, the same shape as studio_command publish-log, and on failure a continuation that says what to fix. Never repeats the POST that started it; not terminal yet answers a continuation.',
    inputSchema: z.object({ tenant, auth: publicAuth, kind: z.enum(['deployment', 'publish', 'build', 'native-build', 'generation', 'code-analysis', 'deletion-analysis', 'deployment-analysis']),
      operationKey: z.string().min(1), waitSeconds: z.number().int().min(0).max(600).default(0), messages: z.boolean().default(false) }).strict(), annotations: readOnly }, input => access.operationStatus(input));
  register('odc_deploy', { title: 'Deploy an app between stages and wait', description: 'POST deployment-operations (Deploy, Undeploy or ApplyConfigs of an asset revision to a stage) with the odc_write safety, then follows it until Finished/FinishedWithError (waitSeconds, max 600; 0 returns after the start). A deployment that ends FinishedWithError is refused as DEPLOYMENT_FAILED with every message (deployment.log: type, text, element, stage) and a continuation that says what to fix; it is never resent. Undeploy is destructive: the words name the app.',
    inputSchema: z.object({ tenant, auth: publicAuth, assetKey: z.string().min(1), environmentKey: z.string().min(1), revision: z.number().int().positive().optional(), buildKey: z.string().optional(),
      operation: z.enum(['Deploy', 'Undeploy', 'ApplyConfigs']).default('Deploy'), authorize: words, operationUuid: uuid, confirmTenant, waitSeconds: z.number().int().min(0).max(600).default(300) }).strict(), annotations: mutating },
    input => access.deploy(input));
  register('odc_configurations', { title: 'App, agent or stage configurations (settings, timers)', description: 'get: deployed configurations (or of a revision) of an app/agent, or a stage\'s default system configurations; secret values redacted. set: PATCH with the odc_write safety: settings {Name: value} (keys resolved from the current configuration), vaultSettings {Name: vault entry} for secret settings (the value lives only in SSAM/ODC3/<tenant>/Setting/<entry>, typed by the user in a private prompt that opens when it is missing; the bridge reads it inside the ODC Studio, so this needs the Studio session) and/or the raw patch (settings/timers/integrations/libraries; never a secret value), then reads back and reports what the server holds (a secret value is never compared).',
    inputSchema: z.object({ tenant, auth: publicAuth, action: z.enum(['get', 'set']).default('get'), scope: z.enum(['application', 'agent', 'environment']).default('application'),
      environmentKey: z.string().min(1), assetKey: z.string().optional().describe('applicationKey or agentKey'), revision: z.number().int().positive().optional(),
      settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      vaultSettings: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)).optional().describe('secret setting name -> vault entry SSAM/ODC3/<tenant>/Setting/<entry>; never the value'),
      patch: z.record(z.string(), z.unknown()).optional(),
      authorize: words.optional(), operationUuid: uuid.optional(), confirmTenant }).strict(), annotations: mutating }, input => access.configurations(input));
  register('odc_asset_delete', { title: 'Delete an app, library or External Library', description: 'DELETE asset-repository /assets/{assetKey} with the odc_write safety. Before anything is reserved, the asset\'s name and its consumers (dependency-management /assets/{assetKey}/consumers) are read: the user\'s words must name the asset (or carry its key) and every consumer, else CONSUMERS_WOULD_BREAK lists them and nothing is deleted; an unreadable consumers answer is DEPENDENCY_CHECK_UNAVAILABLE. A read afterwards confirms it is gone.',
    inputSchema: z.object({ tenant, auth: publicAuth, assetKey: z.string().min(1), authorize: words, operationUuid: uuid, confirmTenant }).strict(), annotations: mutating }, input => access.assetDelete(input));
  register('odc_external_db_connection', { title: 'External database connections (Portal)', description: 'providers | list | entities {connectionId} (read); test | create {name, providerId (e.g. mssql, postgresql-vanilla), server, port, database, credential?, stageKey?, description?, additionalParameters?, privateGateway?, privateGatewayPort?} and import-entities {connectionId, objects[]} (writes, odc_write safety). The database account lives only in the vault entry SSAM/ODC3/<tenant>/DB/<credential> (default: the connection name); when it is missing a private prompt opens for the user. It reaches the request as secretRefs: through the Studio Portal window the bridge reads it inside the ODC Studio (it never enters this process); with no Studio session test and create are refused (STUDIO_REQUIRED). create = test + save, then reads the list back. delete: no captured Portal route, refused as PORTAL_ROUTE_UNMAPPED with the capture step (odc_portal_routes).',
    inputSchema: z.object({ tenant, auth: portalAuth, action: z.enum(['providers', 'list', 'entities', 'test', 'create', 'import-entities', 'delete']),
      connectionId: z.string().optional(), name: z.string().min(1).max(100).optional(), providerId: z.string().optional(), server: z.string().optional(), port: z.number().int().min(1).max(65535).optional(),
      database: z.string().optional(), credential: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(), stageKey: z.string().optional(), description: z.string().max(500).optional(),
      additionalParameters: z.string().max(1000).optional(), privateGateway: z.boolean().optional(), privateGatewayPort: z.number().int().min(1).max(65535).optional(),
      objects: z.array(z.string().min(1)).max(200).optional(), waitSeconds: z.number().int().min(0).max(600).optional(),
      authorize: words.optional(), operationUuid: uuid.optional(), confirmTenant }).strict(), annotations: mutating }, input => access.externalDbConnection(input));
}

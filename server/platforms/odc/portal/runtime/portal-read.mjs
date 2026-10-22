import { fail, publicError, boundedText } from './errors.mjs';
import { projectForAgent, trustedProjection } from './agent-projection.mjs';
import { PAGE_FIELDS, pageInteger, paginationDiagnostic } from './pagination-diagnostic.mjs';
import { normalizeTraceResult } from './trace-result.mjs';
import { normalizeTraceSearchResult, normalizeTraceSummary } from './trace-metadata-result.mjs';
import { PORTAL_READS } from './portal-routes.mjs';
import { createLogScreenDefaults } from './log-screen-defaults.mjs';

const logScreen = createLogScreenDefaults().screen;
const logDiagnosticFields = new Set([...Object.keys(logScreen.GetSettings), ...Object.keys(logScreen.SelectedEnviroment)]);

// Fresh adapter built from observed wire contracts. It does not import GitSSAM,
// recover browser cookies, accept headers/tokens, or implement password login.
// Only a trusted host can inject the origin-bound session broker below.
const routes = Object.freeze({
  'monitoring.stages': { capability: 'portal.runtime-logs', module: 'monitoring', action: 'monitoring/logs/logs/DataActionGetFilter_Stages', view: 'logs.logs', collection: 'EnvironmentList', wrapper: 'Environment', fields: ['Key', 'Name', 'Hostname', 'Purpose'] },
  'monitoring.applications': { capability: 'portal.runtime-logs', module: 'monitoring', action: 'monitoring/logs/logs/ActionStage_GetApplications_Wrapper', view: 'logs.logs', collection: 'ApplicationVersions', wrapper: 'ApplicationVersion', fields: ['ApplicationKey', 'AssetKey', 'Key', 'Name', 'ApplicationName', 'AssetName', 'Revision', 'DeploymentKey'] },
  'monitoring.logs': { capability: 'portal.runtime-logs', module: 'monitoring', action: 'monitoring/logs/logs/DataActionLogSearch', view: 'logs.logs', collection: 'LogsList' },
  'monitoring.errors': { capability: 'portal.runtime-logs', module: 'monitoring', action: 'monitoring/logs/logs/DataActionLogSearch', view: 'logs.logs', collection: 'LogsList' },
  'monitoring.detail': { capability: 'portal.trace-correlation', module: 'monitoring', action: 'monitoring/logs/log/DataActionGetLogById', view: 'logs.log', collection: 'Log' },
  'monitoring.trace': { capability: 'portal.runtime-traces', module: 'monitoring', action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans', view: 'traces.trace', discoveryView: 'traces.trace' },
  'monitoring.traceLogs': { capability: 'portal.trace-correlation', module: 'monitoring', action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetLogsByTraceId', view: 'traces.trace', discoveryView: 'traces.trace', collection: 'RelatedLogList' },
  'monitoring.traceSummary': { capability: 'portal.runtime-traces', module: 'monitoring', action: 'monitoring/traces/trace/DataActionGetTraceById', view: 'traces.trace' },
  'monitoring.traces': { capability: 'portal.runtime-traces', module: 'monitoring', action: 'monitoring/traces/traces/ActionTraceSearch_Wrapper', view: 'traces.traces' },
  'connections.providers': { capability: 'portal.connection-discovery', module: 'connections', action: 'connections/Connections/connections/DataActionGetProviders', view: 'Connections.connections', collection: 'Providers', fields: ['Id', 'ProviderId', 'ProviderKey', 'Key', 'Label', 'Name', 'DisplayName', 'Title', 'ServiceProviderId', 'ServiceProviderKey'] },
  'connections.list': { capability: 'portal.connection-discovery', module: 'connections', action: 'connections/Connections/connections/DataActionGetConnections', view: 'Connections.connections', collection: 'Connections', fields: ['ConnectionId', 'Id', 'Key', 'Name', 'ConnectionName', 'ProviderId', 'ProviderKey', 'ProviderName', 'Provider', 'Status'] },
});
const logFields = ['LogId', 'Id', 'Instant', 'Time', 'Timestamp', 'Severity', 'ConcatenatedMessageException', 'Message', 'InnerMessage', 'StackTrace', 'TraceId', 'SpanId', 'ApplicationKey', 'ApplicationName', 'AssetKey', 'AssetName', 'RequestKey', 'ExceptionMessage', 'ErrorCode'];
const inputDescriptions = {
  'monitoring.applications': { required: ['environmentKey'], optional: ['search', 'includeAgents', 'portfolioKey'] },
  'monitoring.logs': { required: ['environmentKey', 'applicationKey', 'since', 'until'], optional: ['severities', 'search', 'limit', 'offset'],
    constraints: 'ISO timestamps with timezone; positive window <=30 days; severities Error/Warning/Information/Debug; limit 1..100; offset 0..10000; one app, one page, no automatic detail calls.' },
  'monitoring.errors': { required: ['environmentKey', 'applicationKey', 'since', 'until'], optional: ['search', 'limit', 'offset'],
    constraints: 'Same bounds as monitoring.logs; severity fixed to Error.' },
  'monitoring.detail': { required: ['environmentKey', 'logId'], optional: [] },
  'monitoring.trace': { required: ['environmentKey', 'traceId'], optional: ['maxSpans'], constraints: 'One explicit trace and stage. maxSpans 1..1000 (default 500). Server processing/missing-span states and local truncation are preserved; no automatic trace crawl.' },
  'monitoring.traceLogs': { required: ['environmentKey', 'traceId'], optional: ['maxLogs'], constraints: 'One explicit trace and stage. maxLogs 1..100 (default 100) is a local output cap, not server pagination. Does not fetch spans automatically.' },
  'monitoring.traceSummary': { required: ['environmentKey', 'traceId'], optional: [] },
  'monitoring.traces': { required: ['environmentKey', 'applicationKey', 'since', 'until'], optional: ['search', 'limit', 'offset', 'statuses', 'spanTypes', 'minDurationMs'], constraints: 'One app/stage and ISO window <=30 days. One page, limit 1..100, offset 0..10000. No automatic paging.' },
};
function inputSchema(id) {
  const description = inputDescriptions[id] ?? { required: [], optional: [] };
  const properties = {};
  for (const key of [...description.required, ...description.optional]) {
    properties[key] = key === 'includeAgents' ? { type: 'boolean', default: true }
      : key === 'limit' ? { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      : key === 'offset' ? { type: 'integer', minimum: 0, maximum: 10000, default: 0 }
      : key === 'maxSpans' ? { type: 'integer', minimum: 1, maximum: 1000, default: 500 }
      : key === 'maxLogs' ? { type: 'integer', minimum: 1, maximum: 100, default: 100 }
      : key === 'minDurationMs' ? { type: 'integer', minimum: 0, maximum: 86400000, default: 0 }
      : key === 'statuses' ? { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['Ok', 'Error'] }, default: ['Ok', 'Error'] }
      : key === 'spanTypes' ? { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 80 } }
      : key === 'severities' ? { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['Error', 'Warning', 'Information', 'Debug'] } }
      : key === 'since' || key === 'until' ? { type: 'string', format: 'date-time', maxLength: 40 }
      : { type: 'string', ...(description.required.includes(key) ? { minLength: 1 } : {}), maxLength: key === 'search' && id !== 'monitoring.applications' ? 500 : 200 };
  }
  return { type: 'object', additionalProperties: false, required: description.required, properties,
    ...(description.constraints ? { description: description.constraints } : {}) };
}
const text = (value, field, max = 200, optional = false) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\u0000-\u001f]/.test(value)) fail('INPUT_INVALID', `Invalid ${field}.`);
  return value;
};
function originOnly(value) {
  let url;
  try { url = new URL(value); } catch { fail('PORTAL_TARGET_INVALID', 'An explicit HTTPS Portal origin is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) fail('PORTAL_TARGET_INVALID', 'Portal target must be an HTTPS origin without credentials, port or path.');
  return url.origin;
}
function prepare(id, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INPUT_INVALID', 'Input must be an object.');
  let allowed = [];
  if (id === 'monitoring.applications') allowed = ['environmentKey', 'search', 'includeAgents', 'portfolioKey'];
  else if (id === 'monitoring.logs' || id === 'monitoring.errors') allowed = ['environmentKey', 'applicationKey', 'since', 'until', 'severities', 'search', 'limit', 'offset'];
  else if (id === 'monitoring.detail') allowed = ['environmentKey', 'logId'];
  else if (id === 'monitoring.trace') allowed = ['environmentKey', 'traceId', 'maxSpans'];
  else if (id === 'monitoring.traceLogs') allowed = ['environmentKey', 'traceId', 'maxLogs'];
  else if (id === 'monitoring.traceSummary') allowed = ['environmentKey', 'traceId'];
  else if (id === 'monitoring.traces') allowed = ['environmentKey', 'applicationKey', 'since', 'until', 'search', 'limit', 'offset', 'statuses', 'spanTypes', 'minDurationMs'];
  if (id === 'monitoring.errors') allowed = allowed.filter(key => key !== 'severities');
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('INPUT_INVALID', 'Unknown input; credentials, URLs and headers are never accepted.');
  const parameters = {}, variables = {}, clientVariables = {};
  let page;
  if (allowed.includes('environmentKey')) parameters.EnvironmentKey = text(input.environmentKey, 'environmentKey');
  if (id === 'monitoring.applications') {
    if (input.includeAgents !== undefined && typeof input.includeAgents !== 'boolean') fail('INPUT_INVALID', 'includeAgents must be Boolean.');
    Object.assign(parameters, { SearchTerm: text(input.search, 'search', 200, true),
      PortfolioKey: text(input.portfolioKey, 'portfolioKey', 200, true), PermissionFilter: { List: ['AppMonitor'] },
      AssetTypes: { List: input.includeAgents === false ? ['WebApplication', 'MobileApplication'] : ['WebApplication', 'MobileApplication', 'Agent'] } });
  }
  if (id === 'monitoring.logs' || id === 'monitoring.errors') {
    const parseTime = (value, field) => {
      text(value, field, 40);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INPUT_INVALID', `${field} must be an ISO timestamp with timezone.`);
      return Date.parse(value);
    };
    const start = parseTime(input.since, 'since'), end = parseTime(input.until, 'until');
    if (end <= start || end - start > 30 * 86400000) fail('INPUT_INVALID', 'Log window must be positive and at most 30 days.');
    const limit = input.limit ?? 25, offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) fail('INPUT_INVALID', 'Pagination exceeds the bounded log query limits.');
    const severity = id === 'monitoring.errors' ? ['Error'] : input.severities ?? ['Error', 'Warning', 'Information'];
    if (!Array.isArray(severity) || !severity.length || severity.length > 4 || severity.some(value => !['Error', 'Warning', 'Information', 'Debug'].includes(value))) fail('INPUT_INVALID', 'Invalid severities.');
    // Current application logs are a DataAction, not the AgentsLogs wrapper.
    // This filter subset is mapped from public Portal assets. Missing or changed
    // server contracts fail explicitly; offline mapping is not a live proof.
    Object.assign(clientVariables, { StageId: parameters.EnvironmentKey, ApplicationId: text(input.applicationKey, 'applicationKey'),
      DateTimeStart: new Date(start).toISOString(), DateTimeEnd: new Date(end).toISOString(),
      // The native SearchInput_MON action writes EncodeTextToBase64(Text)
      // into LogListSearchKeyword; LogsSearchKeyword is a widget local only.
      LogListSearchKeyword: Buffer.from(text(input.search, 'search', 500, true), 'utf8').toString('base64'),
      LogsSeverity: [...new Set(severity)].join(','), UserId: '' });
    Object.assign(variables, { SelectedEnviroment: { Key: parameters.EnvironmentKey }, SeverityList: { List: [...new Set(severity)] },
      Page: { Limit: String(limit), Offset: String(offset), NextPageOffset: '0', TotalPages: '0', TotalResults: '0' } });
    delete parameters.EnvironmentKey;
    page = { offset, limit };
  }
  if (id === 'monitoring.detail') {
    Object.assign(variables, { id: text(input.logId, 'logId'), stageid: parameters.EnvironmentKey, fromrelated: false });
    delete parameters.EnvironmentKey;
  }
  if (id === 'monitoring.traceSummary') {
    Object.assign(variables, { id: text(input.traceId, 'traceId'), stageid: parameters.EnvironmentKey, spanid: '' });
    delete parameters.EnvironmentKey;
  }
  if (id === 'monitoring.traces') {
    const validated = prepare('monitoring.logs', Object.fromEntries(['environmentKey', 'applicationKey', 'since', 'until', 'search', 'limit', 'offset'].filter(key => input[key] !== undefined).map(key => [key, input[key]])));
    const statuses = input.statuses ?? ['Ok', 'Error'];
    if (!Array.isArray(statuses) || !statuses.length || statuses.length > 2 || statuses.some(value => !['Ok', 'Error'].includes(value))) fail('INPUT_INVALID', 'Invalid trace statuses.');
    const spanTypes = input.spanTypes ?? [];
    if (!Array.isArray(spanTypes) || spanTypes.length > 40 || (input.spanTypes && !spanTypes.length) || spanTypes.some(value => typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value))) fail('INPUT_INVALID', 'Invalid trace span types.');
    const duration = input.minDurationMs ?? 0;
    if (!Number.isInteger(duration) || duration < 0 || duration > 86400000) fail('INPUT_INVALID', 'Invalid minimum trace duration.');
    delete parameters.EnvironmentKey;
    Object.assign(parameters, { StageKey: input.environmentKey, ApplicationKey: '', AssetKey: input.applicationKey, AssetType: '', UserId: '',
      Since: validated.clientVariables.DateTimeStart, To: validated.clientVariables.DateTimeEnd, ContainsText: text(input.search, 'search', 500, true),
      SpanTypes: { List: [...new Set(spanTypes)] }, Status: { List: [...new Set(statuses)] }, MinDurationMs: String(duration), MaxDurationMs: '0',
      Limit: String(validated.page.limit), Offset: String(validated.page.offset) });
    page = validated.page;
  }
  if (id === 'monitoring.trace' || id === 'monitoring.traceLogs') {
    const maximum = id === 'monitoring.trace' ? input.maxSpans ?? 500 : input.maxLogs ?? 100;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > (id === 'monitoring.trace' ? 1000 : 100)) fail('INPUT_INVALID', 'Invalid local trace result cap.');
    Object.assign(variables, { StageKey: parameters.EnvironmentKey, TraceKey: text(input.traceId, 'traceId'), FetchAgentTraceData: false, IsReadyToLoad: true });
    delete parameters.EnvironmentKey;
  }
  return { parameters, variables, clientVariables, page };
}

export class PortalReadAdapter {
  constructor({ target, origin, broker, timeoutMs = 15000 } = {}) {
    if (target !== 'odc3') fail('PORTAL_TARGET_INVALID', 'This adapter is restricted to the explicit ODC3 target.');
    this.target = target;
    this.origin = originOnly(origin);
    this.broker = broker;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) fail('PORTAL_CONFIG_INVALID', 'Invalid timeout.');
    this.timeoutMs = timeoutMs;
  }

  status() {
    return { target: this.target, origin: this.origin, brokerConfigured: Boolean(this.broker), liveVerified: false,
      operations: Object.entries(routes).map(([id, route]) => ({ id, capability: route.capability, readOnly: true,
        implementation: 'current-contract-mapped', authenticatedReadVerified: this.broker?.verifiedOperations?.has(id) === true,
        ...(this.broker?.blockedOperations?.has(id) ? { available: false, reason: 'Current tenant contract requires additional mapping; no similar-name fallback is allowed.' } : {}),
        input: inputDescriptions[id] ?? { required: [], optional: [] }, inputSchema: inputSchema(id) })),
      limitation: 'Internal observed screenservice contracts require current host-managed Portal session and exact version metadata. No mutation, secret settings, raw HTTP or authentication fallback is exposed. Trace completeness depends on collection/processing state, not presence of a TraceId.' };
  }

  capabilities() {
    if (!this.broker || this.broker.target !== 'odc3' || this.broker.origin !== this.origin
      || typeof this.broker.readScreenservice !== 'function') return new Map();
    const broker = this.broker;
    return new Map([...new Set(Object.values(routes).map(route => route.capability))].map(id => [id, {
      target: 'odc3', get authenticated() { return broker.authenticated === true; }, execute: request => this.execute(request),
    }]));
  }

  async execute({ operationId, input = {} } = {}) {
    return projectForAgent(() => this.executeRaw({ operationId, input }), this.broker?.credentialRegistry);
  }

  async executeRaw({ operationId, input = {} } = {}) {
    try {
      const route = Object.hasOwn(routes, operationId) ? routes[operationId] : null;
      if (!route) fail('PORTAL_OPERATION_NOT_FOUND', 'Only listed read-only internal operations are implemented.');
      const request = prepare(operationId, input);
      if (!this.broker) fail('PORTAL_AUTH_REQUIRED', 'Configure an ODC3-scoped managed Portal-session broker in the host. No credentials should be sent to the model.');
      if (this.broker.target !== 'odc3' || this.broker.origin !== this.origin || typeof this.broker.readScreenservice !== 'function') {
        fail('PORTAL_BROKER_SCOPE_MISMATCH', 'The managed session broker does not match the explicit ODC3 tenant.');
      }
      // The trusted broker returns raw data for validation. Remote projections
      // mask structured secrets only after the scope and pagination checks.
      const controller = new AbortController();
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { code: 'PORTAL_TIMEOUT' })); }, this.timeoutMs);
      });
      let response;
      try {
        const read = async () => {
          if (!this.broker.nativeTraceContext && (operationId === 'monitoring.trace' || operationId === 'monitoring.traceLogs')) {
            // The native trace screen passes GetTraceById.StartTime to this
            // block, plus the stage and settings returned by its data actions.
            const summaryRoute = routes['monitoring.traceSummary'];
            const summary = await this.broker.readScreenservice({ target: this.target, origin: this.origin,
              operationId: 'monitoring.traceSummary', module: summaryRoute.module, action: summaryRoute.action, view: summaryRoute.view,
              inputParameters: {}, screenVariables: { id: input.traceId, stageid: input.environmentKey, spanid: '' }, clientVariables: {},
              requireCurrentMetadata: true, readOnly: true, maxResponseBytes: 1048576, signal: controller.signal });
            if (summary?.target !== this.target || summary?.origin !== this.origin) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Trace context response scope was not verified by the host.');
            if (!summary.body?.data || summary.body.exception || summary.body.error || Buffer.byteLength(JSON.stringify(summary.body)) > 1048576)
              fail('PORTAL_CONTRACT_CHANGED', 'Trace context response is invalid.');
            const context = normalizeTraceSummary(summary.body.data, { traceId: input.traceId });
            if (context.notFound) fail('PORTAL_TRACE_NOT_FOUND', 'No accessible trace context was returned.');
            const readContext = async contextOperation => {
              if (controller.signal.aborted) fail('PORTAL_TIMEOUT', 'Trace context read timed out.');
              const [module, view, action] = PORTAL_READS[contextOperation];
              const answer = await this.broker.readScreenservice({ target: this.target, origin: this.origin,
                operationId: contextOperation, module, view, action, inputParameters: {},
                screenVariables: { id: input.traceId, stageid: input.environmentKey, spanid: '' }, clientVariables: { StageId: input.environmentKey },
                requireCurrentMetadata: true, readOnly: true, maxResponseBytes: 1048576, signal: controller.signal });
              if (answer?.target !== this.target || answer?.origin !== this.origin) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Trace context tenant does not match.');
              if (!answer.body?.data || answer.body.exception || answer.body.error || Buffer.byteLength(JSON.stringify(answer.body)) > 1048576)
                fail('PORTAL_CONTRACT_CHANGED', 'Trace context response is invalid.');
              return answer.body.data;
            };
            const stage = await readContext('monitoring.traceStage');
            const environment = stage.Environment;
            if (stage.FoundStage !== true || environment?.Key !== input.environmentKey || ['Name', 'Purpose', 'PortfolioKey'].some(key => typeof environment[key] !== 'string'))
              fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Trace stage context does not match the requested environment.');
            const settings = await readContext('monitoring.traceSettings');
            if (!/^[1-9]\d{0,9}$/.test(String(settings.MaxSupportedSpans)) || !Number.isSafeInteger(Number(settings.MaxSupportedSpans))
              || !Number.isSafeInteger(settings.MaxSpansExpandDegreeLevel) || settings.MaxSpansExpandDegreeLevel < 0 || typeof settings.IsTraceDuratiomFilterEnabled !== 'boolean')
              fail('PORTAL_CONTRACT_CHANGED', 'Trace settings context is invalid.');
            Object.assign(request.variables, { TraceStartTime: context.trace.StartTime, StageName: environment.Name, StagePurpose: environment.Purpose,
              PortfolioKey: environment.PortfolioKey, TraceStatusLabel: context.trace.StatusLabel ?? '', SelectedSpanId: '',
              MaxSupportedSpans: String(settings.MaxSupportedSpans), MaxSpansExpandDegreeLevel: settings.MaxSpansExpandDegreeLevel,
              IsTraceDuratiomFilterEnabled: settings.IsTraceDuratiomFilterEnabled });
            for (const field of Object.keys(request.variables)) request.variables[`_${field[0].toLowerCase()}${field.slice(1)}InDataFetchStatus`] = 1;
            request.clientVariables.StageId = input.environmentKey;
            if (controller.signal.aborted) fail('PORTAL_TIMEOUT', 'Trace context read timed out. No span request sent.');
          }
          return this.broker.readScreenservice({ target: this.target, origin: this.origin,
          operationId, module: route.module, action: route.action, view: route.view, discoveryView: route.discoveryView,
          inputParameters: request.parameters, screenVariables: request.variables, clientVariables: request.clientVariables,
          requireCurrentMetadata: true, readOnly: true, maxResponseBytes: 1048576,
          signal: controller.signal });
        };
        response = await Promise.race([read(), expired]);
      } catch (error) {
        // WEB_SIGN_IN_REQUIRED and HOST_MISMATCH come from the Studio Portal window (studio-portal.mjs).
        const codes = new Set(['PORTAL_AUTH_REQUIRED', 'PORTAL_ACCESS_DENIED', 'PORTAL_CONTRACT_CHANGED', 'PORTAL_REQUEST_FAILED', 'PORTAL_RESPONSE_TOO_LARGE', 'PORTAL_BROKER_SCOPE_MISMATCH', 'PORTAL_TRACE_NOT_FOUND', 'PORTAL_TIMEOUT', 'WEB_SIGN_IN_REQUIRED', 'HOST_MISMATCH']);
        const timeout = ['AbortError', 'TimeoutError'].includes(error?.name) || ['READ_DEADLINE_EXCEEDED', 'PORTAL_TIMEOUT'].includes(error?.code);
        const code = timeout ? 'PORTAL_TIMEOUT' : codes.has(error?.code) ? error.code : 'PORTAL_BROKER_FAILED';
        fail(code, 'Managed Portal read failed. No raw exception or credential is returned.', {
          ...(['trace-stage', 'trace-settings', 'trace-summary', 'log-settings', 'log-stage', 'log-search'].includes(error?.details?.diagnosticStage) ? { diagnosticStage: error.details.diagnosticStage } : {}),
          ...(['log-settings', 'log-stage'].includes(error?.details?.diagnosticStage) && logDiagnosticFields.has(error?.details?.diagnosticField) ? { diagnosticField: error.details.diagnosticField } : {}),
          causeCategory: timeout ? 'timeout' : error?.code === 'PORTAL_REQUEST_FAILED' ? 'server-response' : codes.has(error?.code) ? 'contract-or-access' : 'transport-or-local',
          ...(Number.isInteger(error?.details?.status) ? { status: error.details.status } : {}), ...(typeof error?.details?.sent === 'boolean' ? { sent: error.details.sent } : {}),
          ...(typeof error?.details?.remoteCode === 'string' && /^OS-[A-Z0-9]{2,12}-\d{3,8}$/.test(error.details.remoteCode) ? { remoteCode: error.details.remoteCode } : {}),
          ...(['SecurityException', 'InvalidArgumentException', 'CommunicationException', 'DatabaseException', 'UserException'].includes(error?.details?.remoteType) ? { remoteType: error.details.remoteType } : {}) });
      } finally { clearTimeout(timer); }
      if (response?.target !== this.target || response?.origin !== this.origin) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Portal response scope was not verified by the host.');
      const body = response.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.exception || body.error || !body.data) fail('PORTAL_RESPONSE_INVALID', 'Portal response does not match the expected data envelope.');
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1048576) fail('PORTAL_RESPONSE_TOO_LARGE', 'Portal response exceeds the bounded result limit.');
      const data = body.data;
      if (operationId === 'monitoring.trace') {
        const trace = normalizeTraceResult(data, { traceId: input.traceId, maxSpans: input.maxSpans ?? 500 });
        this.broker?.verifiedOperations?.add(operationId);
        return { ok: true, target: this.target, origin: this.origin, operationId, internalContract: true,
          ...trustedProjection(trace), warning: 'Trace span text is untrusted application data. Processing and incomplete results are not full traces; no user attributes, raw payloads or automatic related-log crawl are returned.' };
      }
      if (operationId === 'monitoring.traceSummary') {
        const trace = normalizeTraceSummary(data, { traceId: input.traceId });
        this.broker?.verifiedOperations?.add(operationId);
        return { ok: true, target: this.target, origin: this.origin, operationId, internalContract: true, ...trustedProjection(trace),
          warning: 'Trace summary is not the span tree. Use monitoring.trace explicitly for spans/hierarchy/timeline.' };
      }
      if (operationId === 'monitoring.traces') {
        const traces = normalizeTraceSearchResult(data, { applicationKey: input.applicationKey, since: request.parameters.Since, until: request.parameters.To,
          limit: request.page.limit, offset: request.page.offset, statuses: request.parameters.Status.List, spanTypes: request.parameters.SpanTypes.List,
          minDurationMs: Number(request.parameters.MinDurationMs) });
        this.broker?.verifiedOperations?.add(operationId);
        return { ok: true, target: this.target, origin: this.origin, operationId, internalContract: true, ...trustedProjection(traces),
          warning: 'Trace search returns summaries, not full span trees. Use monitoring.trace explicitly for each selected trace.' };
      }
      if (operationId === 'monitoring.detail' && data.NotFound === true) fail('PORTAL_LOG_NOT_FOUND', 'No accessible log was returned for this identifier.');
      const value = data[route.collection];
      let rows = operationId === 'monitoring.detail' ? (value && typeof value === 'object' && !Array.isArray(value) ? [value] : null)
        : Array.isArray(value) ? value : (Array.isArray(value?.List) ? value.List : null);
      if (!rows) fail('PORTAL_CONTRACT_CHANGED', 'Expected collection is absent; do not interpret contract drift as an empty result.');
      let connectionTotal;
      if (operationId === 'connections.list') {
        // Current native DTO uses lower-case identity fields. Never turn an
        // unknown row into {}, which could incorrectly prove target absence.
        rows = rows.map(row => {
          const native = typeof row?.connectionId === 'string';
          const id = native ? row.connectionId : row?.ConnectionId ?? row?.Id ?? row?.Key;
          const name = native ? row.name : row?.Name ?? row?.ConnectionName;
          if (typeof id !== 'string' || !id || typeof name !== 'string' || !name)
            fail('PORTAL_CONTRACT_CHANGED', 'Connection inventory row has no verifiable identity.');
          return native ? { ConnectionId:id, Name:name,
            ...(typeof row.providerId === 'string' ? {ProviderId:row.providerId} : {}),
            ...(typeof row.providerName === 'string' ? {ProviderName:row.providerName} : {}) } : row;
        });
        if (data.TotalResults !== undefined) {
          if (!/^[0-9]+$/.test(String(data.TotalResults)) || !Number.isSafeInteger(Number(data.TotalResults))
              || Number(data.TotalResults) < rows.length)
            fail('PORTAL_CONTRACT_CHANGED', 'Invalid connection inventory total.');
          connectionTotal = Number(data.TotalResults);
        }
      }
      if (operationId === 'monitoring.detail' && (rows.length !== 1 || rows[0].LogId !== input.logId))
        fail('PORTAL_RESPONSE_SCOPE_MISMATCH', 'The log detail did not echo the requested log ID. No log content returned.');
      // Never expose a row outside the requested scope, and never drop a whole valid page for one such row (C34, atritos 3:
      // a row 1 s after the window, the server's rounding, refused the page). Rows outside the scope leave the answer and
      // come back counted in droppedOutOfScope; only an unreadable row (not an object) refuses, as before.
      let droppedOutOfScope = 0;
      if ((operationId === 'monitoring.traceLogs' || request.page) && rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('PORTAL_RESPONSE_SCOPE_MISMATCH', 'Returned rows are not readable records. No rows returned.');
      if (operationId === 'monitoring.traceLogs') {
        const kept = rows.filter(row => row.TraceId === input.traceId);
        droppedOutOfScope += rows.length - kept.length; rows = kept;
      }
      if (request.page) {
        // Do not expose an accidentally broad result if the server ignored a
        // changed filter contract. Verify every returned row before projection.
        const expected = request.clientVariables;
        const severities = expected.LogsSeverity.split(',');
        const inScope = row => row.ApplicationKey === expected.ApplicationId && severities.includes(row.Severity)
          && Number.isFinite(Date.parse(row.Time)) && Date.parse(row.Time) >= Date.parse(expected.DateTimeStart)
          && Date.parse(row.Time) <= Date.parse(expected.DateTimeEnd);
        const kept = rows.filter(inScope);
        droppedOutOfScope += rows.length - kept.length; rows = kept;
      }
      let paginationSemantics, pagination, serverPagination, paginationSource = 'server';
      if (request.page) {
        const source = data.LogSearch_Page;
        const diagnostic = fields => paginationDiagnostic(request.page, source, fields);
        if (!source || typeof source !== 'object' || Array.isArray(source)) fail('PORTAL_CONTRACT_CHANGED', 'Expected log pagination is absent.', diagnostic(PAGE_FIELDS));
        const invalid = PAGE_FIELDS.filter(key => pageInteger(source[key]) === null || pageInteger(source[key]) < (key === 'NextPageOffset' ? -1 : 0));
        if (invalid.length) fail('PORTAL_RESPONSE_INVALID', 'Invalid server pagination.', diagnostic(invalid));
        pagination = Object.fromEntries(PAGE_FIELDS.map(key => [key, pageInteger(source[key])]));
        // Preserve the native empty page without asserting a successful app session.
        const nativeEmptyPage = !droppedOutOfScope && rows.length === 0 && Object.values(pagination).every(value => value === 0);
        paginationSemantics = nativeEmptyPage ? 'native-empty-page' : 'bounded-page';
        // Current logs UI keeps Limit/Offset locally and copies only totals from
        // LogSearch_Page. Its DataAction returns zero in the unused fields.
        // Accept that precise shape only with the exact bounded in-scope row count.
        if (!nativeEmptyPage && pagination.Limit === 0 && pagination.Offset === 0 && pagination.NextPageOffset === 0 && pagination.TotalPages === 0) {
          const expectedRows = Math.min(request.page.limit, Math.max(0, pagination.TotalResults - request.page.offset));
          if (droppedOutOfScope || rows.length !== expectedRows) fail('PORTAL_RESPONSE_SCOPE_MISMATCH', 'Total-only pagination cannot be reconciled with scoped rows.', diagnostic(['TotalResults']));
          serverPagination = pagination;
          paginationSource = 'request-and-server-total';
          const next = request.page.offset + request.page.limit;
          pagination = { Limit: request.page.limit, Offset: request.page.offset, NextPageOffset: next < pagination.TotalResults ? next : -1,
            TotalPages: Math.ceil(pagination.TotalResults / request.page.limit), TotalResults: pagination.TotalResults };
        }
        // C34: the server may cap the page size (Limit 50 when 100 was asked); its Limit is accepted with the requested
        // Offset, and the next page is computed from the server's values. A larger Limit or another Offset is a scope the
        // request never asked for.
        const scopeFields = [ ...(pagination.Offset !== request.page.offset ? ['Offset'] : []), ...(pagination.Limit < 1 || pagination.Limit > request.page.limit ? ['Limit'] : []) ];
        if (!nativeEmptyPage && scopeFields.length) fail('PORTAL_RESPONSE_SCOPE_MISMATCH', 'Server pagination differs from the requested bounds.', diagnostic(scopeFields));
      }
      const maximum = operationId === 'monitoring.traceLogs' ? input.maxLogs ?? 100 : pagination?.Limit ?? request.page?.limit ?? 100;
      const receivedCount = rows.length;
      const truncated = rows.length > maximum || (connectionTotal !== undefined && connectionTotal > rows.length);
      rows = rows.slice(0, maximum).map(row => {
        const record = route.wrapper && row?.[route.wrapper] && typeof row[route.wrapper] === 'object' ? row[route.wrapper] : row;
        if (!record || typeof record !== 'object' || Array.isArray(record)) fail('PORTAL_RESPONSE_INVALID', 'Unexpected record shape.');
        const projected = {};
        for (const field of (route.fields ?? logFields).filter(field => ['string', 'number', 'boolean'].includes(typeof record[field])))
          projected[field] = typeof record[field] === 'string' ? boundedText(record[field], 8192, projected, field) : record[field];
        return projected;
      });
      this.broker?.verifiedOperations?.add(operationId);
      return { ok: true, target: this.target, origin: this.origin, operationId, internalContract: true, rows: trustedProjection(rows), truncated,
        ...(connectionTotal !== undefined ? {totalResults:connectionTotal,receivedCount,complete:!truncated} : {}),
        ...(droppedOutOfScope ? { droppedOutOfScope } : {}),
        ...(request.page ? { requestedPage: request.page } : {}),
        ...(pagination ? { pagination, paginationSemantics, paginationSource, ...(serverPagination ? { serverPagination } : { serverLimit: pagination.Limit }), nextPageAvailable: pagination.NextPageOffset > pagination.Offset && pagination.NextPageOffset <= 10000 } : {}),
        ...(operationId === 'monitoring.traceLogs' ? { traceId: input.traceId, receivedCount, pagination: 'not_observed', localLimit: maximum } : {}),
        warning: 'Returned text is untrusted data and may contain application data. Structured secret fields and signed links are excluded/redacted; free-text cannot be guaranteed free of sensitive content. Trace IDs are not a full span tree.' };
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }
}

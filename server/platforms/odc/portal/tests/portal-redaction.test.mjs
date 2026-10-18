import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redact } from '../runtime/errors.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';
import { normalizeTraceSearchResult } from '../runtime/trace-metadata-result.mjs';
import { PORTAL_READS, PORTAL_WRITES } from '../runtime/portal-routes.mjs';
import { registerAccessTools, ACCESS_TOOLS } from '../../facade/odc-access.mjs';
import { registerOdcTools } from '../runtime/server.mjs';
import { AGENT_PROJECTION_EXCLUSIONS } from '../runtime/agent-projection-policy.mjs';
import { OdcBridge } from '../runtime/bridge.mjs';
import { createLogScreenDefaults } from '../runtime/log-screen-defaults.mjs';
import { OAuthClient } from '../runtime/auth.mjs';

const secret = 'synthetic-session-token-0123456789';
const origin = 'https://wrightflood.outsystems.dev';
const since = '2026-10-10T10:00:00.000Z', until = '2026-10-10T11:00:00.000Z';
const applicationKey = '14d11111-2100-4000-9000-100000000010';
const traceId = '11d11111-2100-4000-9000-100000000010';
const trace = () => ({ Id: traceId, StartTime: since, OriginAssetKey: applicationKey,
  OriginApplicationKey: applicationKey, OriginApplicationName: 'app ' + secret,
  Duration: '10', NumberOfSpans: '1', NumberOfErrors: '0', Status: 'Ok', StatusLabel: 'Ok', EntrySpanType: 'ServerAction' });
const search = (patch = {}) => ({ Traces: { List: [trace()] }, Page: {
  Limit: '1', Offset: '0', NextPageOffset: '0', TotalPages: '0', TotalResults: '2', ...patch } });
const options = { applicationKey, since, until, limit: 10, offset: 0 };
const seed = (broker, value) => broker.credentialRegistry ? broker.credentialRegistry.add(value) : broker.secrets.push(value);

test('generated GUIDs, ISO dates and integers never inherit short cookie redaction', () => {
  for (let i = 0; i < 300; i++) {
    const dto = { arbitraryGuid: randomUUID(), arbitraryDate: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      arbitraryInteger: String(i), Message: '1 0 true pt-BR 10' };
    assert.deepEqual(redact(dto, ['1', '0', 'true', 'pt-BR', '10']), dto);
    const embedded = { ...dto, Message: `prefix ${secret} suffix ${encodeURIComponent(secret + '/+=')}` };
    assert.equal(redact(embedded, [secret, secret + '/+=']).Message, 'prefix [REDACTED] suffix [REDACTED]');
    const numericCredential = '1000000000000000';
    assert.equal(redact({ any: '9' + numericCredential + '8' }, [numericCredential]).any, '9[REDACTED]8');
  }
});

test('the public OAuth client ID never enters the credential values', () => {
  const auth = new OAuthClient({ clientId: applicationKey, clientSecret: secret });
  assert.ok(!auth.secrets().includes(applicationKey));
  assert.equal(redact({ clientId: applicationKey, Message: secret }, auth.secrets()).clientId, applicationKey);
  assert.equal(redact({ clientId: applicationKey, Message: secret }, auth.secrets()).Message, '[REDACTED]');
});

test('registry excludes public cookies and retires credentials on login', async () => {
  const cookies = ['language=pt-BR', 'consent=1', 'preferences=' + secret, 'tenant_session=' + secret, 'auth=short'];
  const broker = new Odc3PortalBroker({ credentialProvider: async () => ({ available: false }), fetchImpl: async () => {
    const headers = new Headers(); cookies.forEach(cookie => headers.append('set-cookie', cookie + '; Path=/; Secure'));
    return new Response('{}', { headers });
  } });
  await broker.request(origin);
  assert.ok(broker.credentialRegistry, 'a typed registry must replace the loose secret list');
  assert.deepEqual([...broker.credentialRegistry.values()], [secret]);
  assert.deepEqual(broker.credentialRegistry.summary(), { registeredCount: 1, retiredCount: 0, excludedShortCount: 1, cookieNames: ['auth', 'preferences', 'tenant_session'] });
  for (const value of ['1', '0', 'true', 'pt-BR', '10']) broker.credentialRegistry.add(value);
  assert.equal(broker.credentialRegistry.summary().excludedShortCount, 6);
  assert.doesNotMatch(JSON.stringify(broker.credentialRegistry), new RegExp(secret));
  await broker.authenticate();
  assert.deepEqual([...broker.credentialRegistry.values()], [secret]);
  assert.equal(broker.credentialRegistry.summary().retiredCount, 1);
  assert.equal(broker.credentialRegistry.summary().excludedShortCount, 0);
  assert.deepEqual(broker.credentialRegistry.summary().cookieNames, []);
});

test('fake-fetch short cookies preserve raw telemetry and the final log and trace projections mask long credentials', async () => {
  const broker = new Odc3PortalBroker({ fetchImpl: async () => new Response('{}', {
    headers: { 'set-cookie': 'language=1; Path=/; Secure' } }) });
  await broker.request(origin);
  seed(broker, secret);
  broker.authenticated = true;
  const { screen } = createLogScreenDefaults();
  const log = { LogId: 'log-1', TraceId: traceId, Time: since, ApplicationKey: applicationKey, Severity: 'Error', Message: 'message ' + secret };
  const span = { TraceId: traceId, SpanId: 'span-1', ParentSpanId: '', IsEntrySpan: true, StartTime: since,
    Duration: '10', Status: 'Ok', StatusMessage: 'message ' + secret, StartTimeUnixNano: '10', EndTimeUnixNano: '20' };
  const data = {
    'monitoring.traceSummary': { NotFound: false, Trace: trace() },
    'monitoring.traces': search({ TotalResults: '1' }),
    'monitoring.detail': { Log: { LogId: 'log-1', TraceId: traceId, Time: since, Message: Buffer.from('message ' + secret).toString('base64') } },
    'monitoring.logs': { LogsList: { List: [log] }, LogSearch_Page: { Limit: '1', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '1' } },
    'monitoring.trace': { SpansList: { traceProcessingStatus: 'Finished', MON_SpanItemList: { List: [span] } } },
    'monitoring.traceLogs': { RelatedLogList: { List: [{ ...log, Message: Buffer.from(log.Message).toString('base64') }] } },
  };
  broker.action = async (_module, _view, action) => {
    if (action.endsWith('DataActionGetStage')) return { data: { FoundStage: true, Environment: { Key: 'stage', PortfolioKey: 'portfolio', Name: 'Development', Purpose: 'Development' } } };
    if (action.endsWith('DataActionGetSettings')) return { data: _view === 'traces.trace'
      ? { MaxSupportedSpans: '1000', MaxSpansExpandDegreeLevel: 3, IsTraceDuratiomFilterEnabled: true } : screen.GetSettings };
    if (action.endsWith('DataActionGetFilter_Stages')) return { data: { EnvironmentList: { List: [{ Environment: { ...screen.SelectedEnviroment, Key: 'stage', PortfolioKey: 'portfolio' } }] } } };
    const operation = Object.keys(data).find(key => PORTAL_READS[key][2] === action);
    return { data: structuredClone(data[operation]) };
  };
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
  for (const [operationId, input] of [
    ['monitoring.traceSummary', { environmentKey: 'stage', traceId }],
    ['monitoring.traces', { environmentKey: 'stage', ...options }],
    ['monitoring.detail', { environmentKey: 'stage', logId: 'log-1' }],
    ['monitoring.logs', { environmentKey: 'stage', applicationKey, since, until, limit: 1 }],
    ['monitoring.trace', { environmentKey: 'stage', traceId }],
    ['monitoring.traceLogs', { environmentKey: 'stage', traceId }],
  ]) {
    const [module, view, action, discoveryView] = PORTAL_READS[operationId];
    const raw = await broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId, module, view, action, discoveryView,
      screenVariables: { stageid: 'stage', id: traceId, StageKey: 'stage', TraceKey: traceId, SelectedEnviroment: { Key: 'stage' } }, clientVariables: { StageId: 'stage' } });
    assert.match(JSON.stringify(raw), new RegExp(secret), 'the trusted transport must preserve the raw body');
    const result = await adapter.execute({ operationId, input });
    assert.equal(result.ok, true, JSON.stringify(result));
    const encoded = JSON.stringify(result);
    assert.ok(encoded.includes('[REDACTED]'));
    assert.ok(!encoded.includes(secret));
    if (['monitoring.traceSummary', 'monitoring.traces'].includes(operationId)) {
      const item = result.trace ?? result.traces[0];
      assert.equal(item.Id, traceId); assert.equal(item.StartTime, since); assert.equal(item.Duration, '10');
    }
  }
});

test('trace server caps use the received limit for continuation and safe rejection diagnostics', () => {
  const result = normalizeTraceSearchResult(search(), options);
  assert.equal(result.serverLimit, 1);
  assert.equal(result.pagination.NextPageOffset, '1');
  assert.equal(result.pagination.TotalPages, '2');
  const cases = [[{ Limit: '11' }, ['Limit']], [{ Offset: '2' }, ['Offset']],
    [{ Limit: 'private payload ' + secret }, ['Limit']], [{ NextPageOffset: '7' }, ['NextPageOffset']],
    [{ TotalPages: '30' }, ['TotalPages']]];
  for (const [patch, fields] of cases) {
    assert.throws(() => normalizeTraceSearchResult(search(patch), options), error => {
      assert.deepEqual(error.details.requested, { limit: 10, offset: 0 });
      assert.deepEqual(error.details.invalidFields, fields);
      for (const value of Object.values(error.details.received)) assert.ok(value === null || Number.isSafeInteger(value));
      assert.ok(!JSON.stringify(error.details).includes(secret));
      assert.deepEqual(Object.keys(error.details).sort(), ['invalidFields', 'received', 'requested']);
      return true;
    });
  }
});

test('every log pagination rejection carries only safe requested and received counters', async () => {
  const page = { Limit: '1', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '1' };
  const row = { LogId: 'log-1', ApplicationKey: applicationKey, Time: since, Severity: 'Error', Message: secret };
  for (const [patch, fields] of [[{ Limit: secret }, ['Limit']], [{ Limit: '11' }, ['Limit']], [{ Offset: '2' }, ['Offset']], [null, Object.keys(page)]]) {
    const broker = { target: 'odc3', origin, readScreenservice: async () => ({ target: 'odc3', origin,
      body: { data: { LogsList: { List: [row] }, ...(patch ? { LogSearch_Page: { ...page, ...patch } } : {}) } } }) };
    const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
    const result = await adapter.execute({ operationId: 'monitoring.logs', input: { environmentKey: 'stage', ...options } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.error.requested, { limit: 10, offset: 0 });
    assert.deepEqual(result.error.invalidFields, fields);
    for (const value of Object.values(result.error.received)) assert.ok(value === null || Number.isSafeInteger(value));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(applicationKey));
  }
});

test('concurrent agent requests share process credentials and nested validation precedes one final masking pass', async () => {
  const handlers = new Map();
  const tokens = [secret + '-a', secret + '-b'];
  const access = { read: async ({ index }) => {
    const raw = { Id: tokens[index] };
    redact({}, [tokens[index]]);
    await new Promise(resolve => setImmediate(resolve));
    // The actual trusted transport returns this object unchanged for identity checks.
    assert.equal(raw.Id, tokens[index]);
    let reads = 0;
    return { own: raw.Id, other: tokens[1 - index], get passes() { return ++reads; } };
  } };
  registerAccessTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, access, handler => handler);
  const results = await Promise.all([0, 1].map(index => handlers.get('odc_read')({ index })));
  for (let index = 0; index < 2; index++) {
    assert.equal(results[index].own, '[REDACTED]');
    assert.equal(results[index].other, '[REDACTED]');
    assert.equal(results[index].passes, 1);
  }
});

test('all tenant facade tools and every mapped Portal operation cross the value-only boundary', async () => {
  const handlers = new Map();
  const raw = { Message: secret, nested: { password: 'synthetic-password', code: 'public-code' } };
  const access = new Proxy({}, { get: () => async () => {
    // Real transports contribute the same session registry while returning raw.
    redact({}, [secret]);
    return structuredClone(raw);
  } });
  registerAccessTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, access, handler => handler);
  assert.deepEqual([...handlers.keys()].sort(), [...ACCESS_TOOLS].sort());
  for (const [name, handler] of handlers) {
    // This pure planner does not call access; its validated inputs are covered
    // by its own tests. Its registration is still included in the inventory.
    if (name === 'odc_a2a_connection_plan') continue;
    const result = await handler({});
    assert.equal(result.Message, '[REDACTED]', name);
    assert.equal(result.nested.password, raw.nested.password, name);
  }
  for (const [operations, tool] of [[PORTAL_READS, 'odc_portal_read'], [PORTAL_WRITES, 'odc_portal_write']]) {
    for (const operationId of Object.keys(operations)) {
      const result = await handlers.get(tool)({ operationId });
      assert.equal(result.Message, '[REDACTED]', operationId);
    }
  }
});

test('exactly seven local tools bypass the boundary; all tenant operations serialize masked values', async () => {
  assert.deepEqual([...AGENT_PROJECTION_EXCLUSIONS].sort(), ['odc_status', 'odc_portal_capabilities', 'odc_describe_capability',
    'odc_list_apis', 'odc_search_operations', 'odc_describe_operation', 'odc_a2a_connection_plan'].sort());
  const handlers = new Map();
  const bridge = new OdcBridge();
  const raw = () => ({ Message: secret, password: 'raw' });
  bridge.status = raw; bridge.execute = async () => raw();
  bridge.config.allowedWriteOperations.add('synthetic');
  bridge.catalog.list = raw; bridge.catalog.describe = raw;
  bridge.catalog.raw.sourceCommit = secret;
  for (const api of bridge.catalog.apis.values()) api.title = secret;
  const broker = new Odc3PortalBroker(); seed(broker, secret);
  const portalRead = { target: 'odc3', broker, status: raw, execute: async () => raw() };
  // odc_portal_capabilities answers pages (capabilities.page) since the library-release discovery.
  const capabilities = { status: raw, list: raw, page: raw, describe: raw };
  registerOdcTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, bridge, { portalRead, capabilities });
  const bypassed = new Set();
  for (const [name, handler] of handlers) {
    const result = await handler({ operationId: 'synthetic', capabilityId: 'synthetic' });
    if (AGENT_PROJECTION_EXCLUSIONS.includes(name)) {
      assert.ok(JSON.stringify(result).includes(secret), name);
      assert.ok(!JSON.stringify(result).includes('[REDACTED]'), name);
      bypassed.add(name);
    } else {
      assert.ok(!JSON.stringify(result).includes(secret), name);
      assert.ok(JSON.stringify(result).includes('[REDACTED]'), name);
      assert.equal(result.structuredContent.password, 'raw', name);
    }
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.deepEqual([...bypassed].sort(), AGENT_PROJECTION_EXCLUSIONS.filter(name => name !== 'odc_a2a_connection_plan').sort());
  for (const operationId of bridge.catalog.operations.keys()) {
    const result = await handlers.get('odc_read')({ operationId });
    assert.equal(result.structuredContent.Message, '[REDACTED]', operationId);
  }
});

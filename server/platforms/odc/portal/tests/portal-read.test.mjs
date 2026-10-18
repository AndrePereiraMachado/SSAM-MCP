import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';

const origin = 'https://tenant.example.test';
const query = { environmentKey: 'stage-x', applicationKey: 'app-x', since: '2026-09-14T12:00:00Z', until: '2026-09-14T13:00:00Z' };
function setup(data, extra = {}) {
  const requests = [];
  const broker = { target: 'odc3', origin, async readScreenservice(request) {
    requests.push(request);
    if (request.operationId === 'monitoring.traceSummary' && (data.SpansList || data.RelatedLogList))
      return { target: 'odc3', origin, body: { data: { NotFound: false, Trace: { Id: request.screenVariables.id, StartTime: '2026-09-14T12:30:00Z' } } } };
    if (request.operationId === 'monitoring.traceStage')
      return { target: 'odc3', origin, body: { data: { FoundStage: true, Environment: { Key: 'stage-x', Name: 'Development', Purpose: 'Development', PortfolioKey: 'portfolio-x' } } } };
    if (request.operationId === 'monitoring.traceSettings')
      return { target: 'odc3', origin, body: { data: { MaxSupportedSpans: '1000000', MaxSpansExpandDegreeLevel: 3, IsTraceDuratiomFilterEnabled: true } } };
    return { target: 'odc3', origin, body: { data } };
  }, ...extra };
  return { requests, broker, adapter: new PortalReadAdapter({ target: 'odc3', origin, broker }) };
}

test('eleven observed read operations are discoverable; credentials and arbitrary routes are not inputs', async () => {
  const { adapter, requests } = setup({});
  assert.equal(adapter.status().operations.length, 11);
  assert.equal(adapter.status().liveVerified, false);
  for (const operationId of ['toString', 'constructor', 'connections.save', 'https://evil.invalid']) {
    const result = await adapter.execute({ operationId });
    assert.equal(result.error.code, 'PORTAL_OPERATION_NOT_FOUND');
  }
  const result = await adapter.execute({ operationId: 'connections.list', input: { headers: { Cookie: 'secret' } } });
  assert.equal(result.error.code, 'INPUT_INVALID');
  assert.equal(requests.length, 0);
});

test('auth scope is explicit ODC3 and exact tenant, with no credential acquisition fallback', async () => {
  assert.throws(() => new PortalReadAdapter({ target: 'odc1', origin }), /ODC3/);
  for (const value of ['http://tenant.test', 'https://a:b@tenant.test', 'https://tenant.test/path', 'https://tenant.test?token=secret']) {
    assert.throws(() => new PortalReadAdapter({ target: 'odc3', origin: value }));
  }
  const missing = new PortalReadAdapter({ target: 'odc3', origin });
  assert.equal((await missing.execute({ operationId: 'monitoring.stages' })).error.code, 'PORTAL_AUTH_REQUIRED');
  const { adapter, requests } = setup({}, { target: 'odc1' });
  assert.equal(adapter.capabilities().size, 0);
  assert.equal((await adapter.execute({ operationId: 'monitoring.stages' })).error.code, 'PORTAL_BROKER_SCOPE_MISMATCH');
  assert.equal(requests.length, 0);
});

test('runtime error query is one bounded explicit-app read with observed contract and no hardcoded version', async () => {
  const { adapter, requests } = setup({ LogsList: { List: [{ LogId: 'log-x', Severity: 'Error', Message: 'failure', TraceId: 'trace-x', ApplicationKey: 'app-x', Time: '2026-09-14T12:30:00Z' }] },
    LogSearch_Page: { Limit: '2', Offset: '5', NextPageOffset: '7', TotalPages: '5', TotalResults: '10' } });
  const result = await adapter.execute({ operationId: 'monitoring.errors', input: { ...query, limit: 2, offset: 5 } });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].inputParameters, {});
  assert.equal(requests[0].action, 'monitoring/logs/logs/DataActionLogSearch');
  assert.deepEqual(requests[0].screenVariables.SeverityList, { List: ['Error'] });
  assert.deepEqual(requests[0].screenVariables.Page, { Limit: '2', Offset: '5', NextPageOffset: '0', TotalPages: '0', TotalResults: '0' });
  assert.deepEqual(requests[0].screenVariables.SelectedEnviroment, { Key: 'stage-x' });
  assert.equal(requests[0].clientVariables.DateTimeStart, '2026-09-14T12:00:00.000Z');
  assert.equal(requests[0].clientVariables.ApplicationId, 'app-x');
  assert.equal(requests[0].clientVariables.StageId, 'stage-x');
  assert.equal(requests[0].clientVariables.LogsSeverity, 'Error');
  assert.deepEqual(result.requestedPage, { offset: 5, limit: 2 });
  assert.equal(requests[0].requireCurrentMetadata, true);
  assert.equal(requests[0].readOnly, true);
  assert.equal('apiVersion' in requests[0], false);
  assert.equal(result.rows[0].TraceId, 'trace-x');
  assert.equal(result.nextPageAvailable, true);
  assert.equal(result.pagination.NextPageOffset, 7);
});

test('application discovery uses current permission and asset-type filters, not old flags', async () => {
  const { adapter, requests } = setup({ ApplicationVersions: { List: [] } });
  const result = await adapter.execute({ operationId: 'monitoring.applications', input: { environmentKey: 'stage-x', includeAgents: false } });
  assert.equal(result.ok, true);
  assert.deepEqual(requests[0].inputParameters, { EnvironmentKey: 'stage-x', SearchTerm: '', PortfolioKey: '',
    PermissionFilter: { List: ['AppMonitor'] }, AssetTypes: { List: ['WebApplication', 'MobileApplication'] } });
});

test('current total-only log pagination derives bounded continuation and refuses mismatched rows', async () => {
  const row = { LogId: 'log-x', Severity: 'Error', ApplicationKey: 'app-x', Time: '2026-09-14T12:30:00Z' };
  const page = { Limit: '0', Offset: '0', NextPageOffset: '0', TotalPages: '0', TotalResults: '3' };
  const { adapter, requests } = setup({ LogsList: { List: [row] }, LogSearch_Page: page });
  const first = await adapter.execute({ operationId: 'monitoring.errors', input: { ...query, limit: 1, offset: 1 } });
  assert.equal(first.ok, true);
  assert.equal(first.paginationSource, 'request-and-server-total');
  assert.deepEqual(first.pagination, { Limit: 1, Offset: 1, NextPageOffset: 2, TotalPages: 3, TotalResults: 3 });
  assert.equal(first.serverPagination.Limit, 0);
  assert.equal(requests[0].screenVariables.Page.Offset, '1');
  for (const rows of [[], [row, row], [{ ...row, ApplicationKey: 'other' }]]) {
    const h = setup({ LogsList: { List: rows }, LogSearch_Page: page });
    const result = await h.adapter.execute({ operationId: 'monitoring.errors', input: { ...query, limit: 1 } });
    assert.equal(result.error.code, 'PORTAL_RESPONSE_SCOPE_MISMATCH');
    assert.equal('rows' in result, false);
  }
});

test('trace spans use the current block view with separate page discovery and preserve complete graph', async () => {
  const { adapter, requests } = setup({ SpansList: { traceProcessingStatus: 'Finished', MON_SpanItemList: { List: [
    { TraceId: 'trace-x', SpanId: 'root', ParentSpanId: '', StartTimeUnixNano: '1000000000000000001', EndTimeUnixNano: '1000000000000000041' },
    { TraceId: 'trace-x', SpanId: 'child', ParentSpanId: 'root', StartTimeUnixNano: '1000000000000000002', EndTimeUnixNano: '1000000000000000012' },
  ] } } });
  const result = await adapter.execute({ operationId: 'monitoring.trace', input: { environmentKey: 'stage-x', traceId: 'trace-x', maxSpans: 10 } });
  assert.equal(result.ok, true); assert.equal(result.complete, true);
  assert.deepEqual(result.hierarchy.edges, [{ parentSpanId: 'root', spanId: 'child' }]);
  assert.equal(result.timeline[1].offsetNanoseconds, '1');
  assert.equal(requests[0].operationId, 'monitoring.traceSummary');
  assert.deepEqual(requests[0].screenVariables, { id: 'trace-x', stageid: 'stage-x', spanid: '' });
  assert.equal(requests[3].view, 'traces.trace');
  assert.equal(requests[3].discoveryView, 'traces.trace');
  const vars = requests[3].screenVariables;
  assert.equal(vars.TraceStartTime, '2026-09-14T12:30:00Z');
  assert.equal(vars.StageKey, 'stage-x'); assert.equal(vars.TraceKey, 'trace-x');
  assert.equal(vars.MaxSupportedSpans, '1000000'); assert.equal(vars.MaxSpansExpandDegreeLevel, 3);
  assert.equal(vars.PortfolioKey, 'portfolio-x'); assert.equal(vars._traceStartTimeInDataFetchStatus, 1);
  assert.equal(requests[3].clientVariables.StageId, 'stage-x');
  assert.equal(requests.length, 4);
  assert.equal((await adapter.execute({ operationId: 'monitoring.trace', input: { environmentKey: 'stage-x', traceId: 'trace-x', maxSpans: 1001 } })).error.code, 'INPUT_INVALID');
});

test('related trace logs are explicit, scoped and locally capped, not a paginated trace substitute', async () => {
  const { adapter, requests } = setup({ RelatedLogList: { List: [{ TraceId: 'trace-x', SpanId: 's1', Message: 'first' }, { TraceId: 'trace-x', SpanId: 's2', Message: 'second' }] } });
  const input = { environmentKey: 'stage-x', traceId: 'trace-x', maxLogs: 1 };
  const result = await adapter.execute({ operationId: 'monitoring.traceLogs', input });
  assert.equal(result.ok, true); assert.equal(result.rows.length, 1); assert.equal(result.truncated, true);
  assert.equal(result.receivedCount, 2); assert.equal(result.pagination, 'not_observed'); assert.equal(requests.length, 4);
  // C34 (atritos 3): a log of another trace leaves the answer, counted; it is never exposed.
  const foreign = setup({ RelatedLogList: { List: [{ TraceId: 'other', Message: 'private' }] } });
  const rejected = await foreign.adapter.execute({ operationId: 'monitoring.traceLogs', input });
  assert.equal(rejected.ok, true); assert.deepEqual(rejected.rows, []); assert.equal(rejected.droppedOutOfScope, 1); assert.equal(JSON.stringify(rejected).includes('private'), false);
});

test('trace search and summary use distinct current contracts without fetching spans implicitly', async () => {
  const row = { Id: 'trace-x', StartTime: '2026-09-14T12:30:00Z', OriginAssetKey: 'app-x', OriginApplicationKey: 'app-x', Status: 'Ok', EntrySpanType: 'Timer' };
  let fixture = setup({ Traces: { List: [row] }, Page: { Limit: '25', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '1' } });
  let result = await fixture.adapter.execute({ operationId: 'monitoring.traces', input: query });
  assert.equal(result.ok, true); assert.equal(result.returnedCount, 1); assert.equal(result.includesSpans, false);
  const parameters = fixture.requests[0].inputParameters;
  assert.equal(parameters.StageKey, 'stage-x'); assert.equal(parameters.ApplicationKey, ''); assert.equal(parameters.AssetKey, 'app-x');
  assert.deepEqual(parameters.Status, { List: ['Ok', 'Error'] }); assert.deepEqual(parameters.SpanTypes, { List: [] });
  assert.equal(parameters.Limit, '25'); assert.equal(parameters.MaxDurationMs, '0'); assert.equal(fixture.requests.length, 1);
  fixture = setup({ Trace: row, NotFound: false });
  result = await fixture.adapter.execute({ operationId: 'monitoring.traceSummary', input: { environmentKey: 'stage-x', traceId: 'trace-x' } });
  assert.equal(result.ok, true); assert.equal(result.trace.Id, 'trace-x'); assert.equal(result.includesSpans, false);
  assert.deepEqual(fixture.requests[0].screenVariables, { id: 'trace-x', stageid: 'stage-x', spanid: '' });
  assert.equal(fixture.requests.length, 1);
});

test('trace context refuses foreign identity, invalid time and not found before fetching any spans', async () => {
  for (const data of [
    { NotFound: true },
    { NotFound: false, Trace: { Id: 'other', StartTime: '2026-09-14T12:30:00Z' } },
    { NotFound: false, Trace: { Id: 'trace-x', StartTime: '' } },
  ]) {
    const { adapter, requests } = setup(data);
    const result = await adapter.execute({ operationId: 'monitoring.trace', input: { environmentKey: 'stage-x', traceId: 'trace-x' } });
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operationId, 'monitoring.traceSummary');
  }
});

test('late trace context cannot send a span request after the shared timeout', async () => {
  const calls = [];
  let release;
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, timeoutMs: 100, broker: { target: 'odc3', origin,
    async readScreenservice(request) {
      calls.push(request.operationId);
      await new Promise(resolve => { release = resolve; });
      return { target: 'odc3', origin, body: { data: { NotFound: false, Trace: { Id: '', StartTime: '2026-09-14T12:30:00Z' } } } };
    } } });
  const result = await adapter.execute({ operationId: 'monitoring.trace', input: { environmentKey: 'stage-x', traceId: 'trace-x' } });
  assert.equal(result.error.code, 'PORTAL_TIMEOUT');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['monitoring.traceSummary']);
});

test('log response drops rows outside the scope (counted, never exposed) and refuses invalid server pagination', async () => {
  const page = { Limit: '25', Offset: '0', NextPageOffset: '0', TotalPages: '1', TotalResults: '1' };
  const row = { ApplicationKey: 'app-x', Severity: 'Error', Time: '2026-09-14T12:30:00Z', Message: 'never expose on mismatch' };
  for (const changed of [{ ApplicationKey: 'other-app' }, { Time: '2020-01-01T00:00:00Z' }, { Severity: 'Information' }, { Time: 'invalid' }]) {
    const { adapter } = setup({ LogsList: { List: [{ ...row, ...changed }] }, LogSearch_Page: page });
    const result = await adapter.execute({ operationId: 'monitoring.errors', input: query });
    // C34 (atritos 3): one row out of scope no longer refuses the page; it leaves the answer, counted.
    assert.equal(result.ok, true); assert.deepEqual(result.rows, []); assert.equal(result.droppedOutOfScope, 1);
    assert.equal(JSON.stringify(result).includes(row.Message), false);
  }
  const unreadable = setup({ LogsList: { List: ['text row'] }, LogSearch_Page: page });
  assert.equal((await unreadable.adapter.execute({ operationId: 'monitoring.errors', input: query })).error.code, 'PORTAL_RESPONSE_SCOPE_MISMATCH');
  for (const changed of [{ Limit: '100' }, { Offset: '1' }, { TotalResults: '-1' }]) {
    const { adapter } = setup({ LogsList: { List: [row] }, LogSearch_Page: { ...page, ...changed } });
    assert.equal((await adapter.execute({ operationId: 'monitoring.errors', input: query })).ok, false);
  }
});

test('invalid filters and broad/unbounded search are rejected before accessing broker', async () => {
  const { adapter, requests } = setup({});
  for (const changed of [{ applicationKey: '' }, { since: '2026-01-01T00:00:00Z' }, { since: '2026-09-14' },
    { since: query.until }, { limit: 101 }, { offset: -1 }, { severities: ['Fatal'] }, { userKey: 'user' }]) {
    const result = await adapter.execute({ operationId: 'monitoring.logs', input: { ...query, ...changed } });
    assert.equal(result.error.code, 'INPUT_INVALID');
  }
  assert.equal(requests.length, 0);
});

test('connections expose metadata only; stage/app wrappers and detail screen context work', async () => {
  let fixture = setup({ Connections: { List: [{ Id: 'c', Name: 'db', Password: 'raw-secret', Settings: { secret: 'nested' }, ConnectionString: 'private' }] } });
  let result = await fixture.adapter.execute({ operationId: 'connections.list' });
  assert.deepEqual(result.rows, [{ Id: 'c', Name: 'db' }]);
  fixture = setup({ EnvironmentList: { List: [{ Environment: { Key: 'e', Name: 'Dev' } }] } });
  assert.deepEqual((await fixture.adapter.execute({ operationId: 'monitoring.stages' })).rows, [{ Key: 'e', Name: 'Dev' }]);
  fixture = setup({ Log: { LogId: 'l', Message: 'Bearer tokenValue', UserName: 'private@example.test', StackTrace: 'at Function' } });
  result = await fixture.adapter.execute({ operationId: 'monitoring.detail', input: { environmentKey: 'e', logId: 'l' } });
  assert.deepEqual(fixture.requests[0].screenVariables, { id: 'l', stageid: 'e', fromrelated: false });
  assert.deepEqual(fixture.requests[0].inputParameters, {});
  assert.equal(result.rows[0].Message, 'Bearer [REDACTED]');
  assert.equal('UserName' in result.rows[0], false);
});

test('log detail rejects missing and foreign identifiers before returning content', async () => {
  for (const LogId of [undefined, '', 'foreign']) {
    const fixture = setup({ Log: { LogId, Message: 'PRIVATE_FOREIGN_MESSAGE' } });
    const result = await fixture.adapter.execute({ operationId: 'monitoring.detail', input: { environmentKey: 'e', logId: 'wanted' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PORTAL_RESPONSE_SCOPE_MISMATCH');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FOREIGN_MESSAGE/);
  }
});

test('contract drift, mismatched response tenant and broker failures never appear as empty success', async () => {
  let fixture = setup({ Unrecognized: [] });
  assert.equal((await fixture.adapter.execute({ operationId: 'connections.list' })).error.code, 'PORTAL_CONTRACT_CHANGED');
  fixture = setup({}, { async readScreenservice() { return { target: 'odc3', origin: 'https://other.test', body: { data: { Connections: [] } } }; } });
  assert.equal((await fixture.adapter.execute({ operationId: 'connections.list' })).error.code, 'PORTAL_BROKER_SCOPE_MISMATCH');
  fixture = setup({}, { async readScreenservice() { throw new Error('password=do-not-leak'); } });
  const result = await fixture.adapter.execute({ operationId: 'connections.list' });
  assert.equal(result.error.code, 'PORTAL_BROKER_FAILED');
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
});

test('timeouts abort the host request and do not retry or refresh credentials', async () => {
  let calls = 0, signal;
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, timeoutMs: 100, broker: { target: 'odc3', origin,
    readScreenservice(request) { calls++; signal = request.signal; return new Promise(() => {}); } } });
  const result = await adapter.execute({ operationId: 'connections.list' });
  assert.equal(result.error.code, 'PORTAL_TIMEOUT');
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('managed read preserves safe server and deadline causes without replaying or exposing raw errors', async () => {
  for (const [error, expected, category] of [
    [Object.assign(new Error('private response'), { code: 'PORTAL_REQUEST_FAILED', details: { status: 500, sent: true, body: 'private' } }), 'PORTAL_REQUEST_FAILED', 'server-response'],
    [Object.assign(new Error('private abort'), { name: 'AbortError' }), 'PORTAL_TIMEOUT', 'timeout'],
    [Object.assign(new Error('private deadline'), { code: 'READ_DEADLINE_EXCEEDED' }), 'PORTAL_TIMEOUT', 'timeout'],
  ]) {
    let calls = 0;
    const { adapter } = setup({}, { async readScreenservice() { calls++; throw error; } });
    const result = await adapter.execute({ operationId: 'connections.list' });
    assert.equal(calls, 1);
    assert.equal(result.error.code, expected);
    assert.equal(result.error.causeCategory, category);
    if (error.details) { assert.equal(result.error.status, 500); assert.equal(result.error.sent, true); }
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});


test('native connection inventory keeps identity, checks totals and never emits empty rows', async () => {
  const row={connectionId:'c',name:'Fixture',providerId:'mssql',providerName:'SQL Server',description:'PRIVATE',Embedded:{secret:'PRIVATE'}};
  let result=await setup({Connections:{List:[row]},TotalResults:'1',MaxRecords:100}).adapter.execute({operationId:'connections.list'});
  assert.equal(result.complete,true);assert.equal(result.totalResults,1);
  assert.deepEqual(result.rows,[{ConnectionId:'c',Name:'Fixture',ProviderId:'mssql',ProviderName:'SQL Server'}]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  result=await setup({Connections:{List:[row]},TotalResults:'2',MaxRecords:1}).adapter.execute({operationId:'connections.list'});
  assert.equal(result.truncated,true);assert.equal(result.complete,false);
  for(const data of [{Connections:{List:[{}]}},{Connections:{List:[{connectionId:'c'}]}},
    {Connections:{List:[row]},TotalResults:'0'},{Connections:{List:[row]},TotalResults:'invalid'}]) {
    result=await setup(data).adapter.execute({operationId:'connections.list'});
    assert.equal(result.ok,false);assert.equal(result.error.code,'PORTAL_CONTRACT_CHANGED');
  }
});

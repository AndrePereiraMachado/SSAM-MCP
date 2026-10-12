import test from 'node:test';
import assert from 'node:assert/strict';
import { readTraceScreenservice } from '../runtime/trace-screen-contract.mjs';
import { normalizeTraceSummary } from '../runtime/trace-metadata-result.mjs';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';

const stage = { FoundStage: true, Environment: { Key: 'stage', PortfolioKey: 'portfolio', Name: 'DEV', Purpose: 'Development' } };
const settings = { MaxSupportedSpans: '8000', MaxSpansExpandDegreeLevel: 3, IsTraceDuratiomFilterEnabled: true };
const summary = { NotFound: false, ExceptionMessage: '', Trace: { Id: '', StartTime: '2026-10-04T19:03:08.247Z', StatusLabel: '' } };
const request = { operationId: 'monitoring.trace', module: 'monitoring', view: 'traces.trace',
  discoveryView: 'traces.trace', action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans',
  screenVariables: { StageKey: 'stage', TraceKey: 'trace' }, signal: new AbortController().signal };
function fixture(overrides = {}) {
  const calls = [], final = { data: { SpansList: { traceProcessingStatus: 'Finished', MON_SpanItemList: { List: [] } } } };
  const dependencies = { GetStage: stage, GetSettings: settings, GetTraceById: summary, ...overrides };
  const action = async (...args) => {
    calls.push(structuredClone(args.slice(0,5)));
    assert.equal(args[5], request.signal);
    assert.equal(args[6].StageId, 'stage'); assert.equal(args[6].UserId, '');
    const key = args[2].split('DataAction')[1];
    return key in dependencies ? { data: structuredClone(dependencies[key]) } : final;
  };
  return { action, calls, final };
}

test('trace block receives complete native input state from scoped stage/settings/summary dependencies', async () => {
  const f = fixture(); assert.equal(await readTraceScreenservice(f.action, request), f.final);
  assert.deepEqual(f.calls.map(v => v[2].split('DataAction')[1]), ['GetStage', 'GetSettings', 'GetTraceById', 'GetSpans']);
  assert.equal(f.calls[3][1], 'traces.trace');
  assert.equal(f.calls[0][4]._stageidInDataFetchStatus, 1);
  assert.deepEqual(f.calls[0][4].ScreenPermissions_trace, { UsersData: 'NoAccess' });
  assert.equal(f.calls[1][4].ActivePortfolioKey, 'portfolio');
  const block = f.calls[3][4];
  assert.equal(Object.keys(block).length, 46); assert.equal(block.TraceKey, 'trace');
  assert.equal(block.TraceStartTime, summary.Trace.StartTime); assert.equal(block.PortfolioKey, 'portfolio');
  assert.equal(block.MaxSupportedSpans, '8000'); assert.equal(block._traceStartTimeInDataFetchStatus, 1);
  assert.equal(block.StageName, 'DEV'); assert.equal(block.IsReadyToLoad, true);
  assert.equal(block.FetchAgentTraceData, false); assert.equal(block._maxSupportedSpansInDataFetchStatus, 1);
  assert.deepEqual(block.SpansListTreeViewDetail.List, []); assert.equal(block.SelectedSpanDetails.Span.TraceId, '');
  // A second call must not inherit state from the first envelope.
  block.SelectedSpanDetails.Span.TraceId = 'must-not-persist';
  const fresh = fixture(); await readTraceScreenservice(fresh.action, request);
  assert.equal(fresh.calls[3][4].SelectedSpanDetails.Span.TraceId, '');
});

test('foreign stage, invalid settings and invalid/foreign summary refuse before fetching the block', async () => {
  const cases = [
    [{ GetStage: { ...stage, Environment: { ...stage.Environment, Key: 'other' } } }, 1],
    [{ GetStage: { ...stage, FoundStage: false } }, 1],
    [{ GetSettings: { ...settings, MaxSupportedSpans: 8000 } }, 2],
    [{ GetSettings: { ...settings, MaxSupportedSpans: '9223372036854775808' } }, 2],
    [{ GetTraceById: { ...summary, NotFound: true } }, 3],
    [{ GetTraceById: { ...summary, ExceptionMessage: 'PRIVATE_CUSTOMER' } }, 3],
    [{ GetTraceById: { ...summary, Trace: { ...summary.Trace, Id: 'other-trace' } } }, 3],
    [{ GetTraceById: { ...summary, Trace: { ...summary.Trace, StartTime: '1900-01-01T00:00:00' } } }, 3],
  ];
  for (const [change, count] of cases) {
    const f = fixture(change);
    const expected = change.GetTraceById?.NotFound === true ? 'PORTAL_TRACE_NOT_FOUND' : 'PORTAL_CONTRACT_CHANGED';
    await assert.rejects(readTraceScreenservice(f.action, request), error => error.code === expected && !error.message.includes('PRIVATE_CUSTOMER'));
    assert.equal(f.calls.length, count);
  }
});

test('partial native summary does not relax public summary identity requirements', async () => {
  const f = fixture();
  const response = await readTraceScreenservice(f.action, { ...request, operationId: 'monitoring.traceSummary', screenVariables: { id: 'trace', stageid: 'stage' } });
  assert.deepEqual(f.calls.map(v => v[2].split('DataAction')[1]), ['GetStage', 'GetTraceById', 'GetSettings', 'GetSpans']);
  assert.throws(() => normalizeTraceSummary(response.data, { traceId: 'trace' }), error => error.code === 'PORTAL_BROKER_SCOPE_MISMATCH');
});

test('related log read uses the same block dependencies but does not fetch spans', async () => {
  const f = fixture();
  await readTraceScreenservice(f.action, { ...request, operationId: 'monitoring.traceLogs', action: request.action.replace('GetSpans', 'GetLogsByTraceId') });
  assert.deepEqual(f.calls.map(v => v[2].split('DataAction')[1]), ['GetStage', 'GetSettings', 'GetTraceById', 'GetLogsByTraceId']);
});

test('real broker binding preserves final trace scope rejection and does not expose foreign attributes', async () => {
  const broker = new Odc3PortalBroker(); broker.authenticated = true;
  const calls = [];
  broker.action = async (_module, _view, action) => {
    const key = action.split('DataAction')[1]; calls.push(key);
    const data = { GetStage: stage, GetSettings: settings, GetTraceById: summary }[key];
    return { data: data ?? { SpansList: { traceProcessingStatus: 'Finished', MON_SpanItemList: { List: [
      { TraceId: 'foreign', SpanId: 'root', ParentSpanId: '', Attributes: { private: 'PRIVATE_CUSTOMER' } },
    ] } } } };
  };
  const adapter = new PortalReadAdapter({ target: 'odc3', origin: 'https://wrightflood.outsystems.dev', broker });
  const result = await adapter.execute({ operationId: 'monitoring.trace', input: { environmentKey: 'stage', traceId: 'trace' } });
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('PRIVATE_CUSTOMER'), false);
  assert.equal(broker.verifiedOperations.has('monitoring.trace'), false);
  assert.deepEqual(calls, ['GetStage', 'GetSettings', 'GetTraceById', 'GetSpans']);
});


test('native summary confirms an empty wire ID only against a scoped matching entry', async () => {
  const root = { TraceId:'trace', SpanId:'entry', ParentSpanId:'', IsEntrySpan:true,
    StartTime:summary.Trace.StartTime, Duration:'42', Status:'Ok' };
  const broker = new Odc3PortalBroker(); broker.authenticated = true;
  const calls=[];
  broker.action=async (_module,_view,action) => {
    const key=action.split('DataAction')[1]; calls.push(key);
    return {data: {GetStage:stage,GetSettings:settings,
      GetTraceById:{...summary,Trace:{...summary.Trace,Duration:'42',Status:'Ok'}},
      GetSpans:{SpansList:{traceProcessingStatus:'Finished',MON_SpanItemList:{List:[root]}}}}[key]};
  };
  const adapter = new PortalReadAdapter({ target:'odc3', origin:'https://wrightflood.outsystems.dev', broker });
  const result=await adapter.execute({operationId:'monitoring.traceSummary',input:{environmentKey:'stage',traceId:'trace'}});
  assert.equal(result.ok,true); assert.equal(result.trace.Id,''); assert.equal(result.identity.spanId,'entry');
  assert.equal(result.includesSpans,false); assert.equal('SummaryIdentitySpans' in result,false);
  assert.deepEqual(calls,['GetStage','GetTraceById','GetSettings','GetSpans']);
});

test('cancelled summary dependencies never send a later span request', async () => {
  const controller=new AbortController(), calls=[];
  const action=async (_module,_view,action) => {
    const key=action.split('DataAction')[1]; calls.push(key);
    if(key==='GetSettings') controller.abort();
    return {data:{GetStage:stage,GetTraceById:summary,GetSettings:settings}[key]};
  };
  await assert.rejects(readTraceScreenservice(action,{...request,operationId:'monitoring.traceSummary',
    screenVariables:{id:'trace',stageid:'stage'},signal:controller.signal}),error=>error.code==='PORTAL_TIMEOUT');
  assert.deepEqual(calls,['GetStage','GetTraceById','GetSettings']);
});

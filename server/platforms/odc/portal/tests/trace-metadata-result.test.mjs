import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTraceSearchResult, normalizeTraceSummary } from '../runtime/trace-metadata-result.mjs';

const options = { applicationKey: 'app', since: '2026-09-15T10:00:00Z', until: '2026-09-15T11:00:00Z', limit: 10, offset: 0 };
const row = () => ({ Id: 'trace', StartTime: '2026-09-15T10:30:00Z', OriginApplicationKey: 'app', OriginAssetKey: 'app',
  OriginApplicationName: 'Example', Status: 'Ok', ProcessingStatus: 'Finished', EntrySpanType: 'ServerAction',
  Duration: '9007199254740993', NumberOfSpans: '2', NumberOfErrors: '0', UserId: 'private-user',
  UserName: 'private-name', Country: 'private-country', Url: 'https://example.test/?token=secret', Attributes: { password: 'secret' } });
const search = (rows = [row()]) => ({ Traces: { List: rows }, Page: { Limit: '10', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: String(rows.length) } });
const code = expected => error => error.code === expected;

test('summary projects metadata without claiming a complete span tree or exposing private fields', () => {
  const result = normalizeTraceSummary({ Trace: row(), NotFound: false, ExceptionMessage: '' }, { traceId: 'trace' });
  assert.equal(result.trace.Id, 'trace');
  assert.equal(result.trace.Duration, '9007199254740993');
  assert.equal(result.includesSpans, false);
  assert.equal(result.trace.UserId, undefined);
  assert.equal(result.trace.Attributes, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-|secret|Country|Url/);
});

test('summary with an empty echoed ID refuses public projection; internal block dependencies validate their own results', () => {
  assert.throws(() => normalizeTraceSummary({ Trace: { ...row(), Id: '' }, NotFound: false }, { traceId: 'requested' }), code('PORTAL_CONTRACT_CHANGED'));
});

test('summary handles explicit not found and rejects foreign/missing identity and raw server errors', () => {
  assert.deepEqual(normalizeTraceSummary({ NotFound: true }, { traceId: 'trace' }), { traceId: 'trace', notFound: true, trace: null, includesSpans: false });
  assert.throws(() => normalizeTraceSummary({ Trace: row(), NotFound: false }, { traceId: 'other' }), code('PORTAL_BROKER_SCOPE_MISMATCH'));
  assert.throws(() => normalizeTraceSummary({ Trace: { ...row(), Id: undefined, TraceId: 'trace' }, NotFound: false }, { traceId: 'trace' }), code('PORTAL_CONTRACT_CHANGED'));
  assert.throws(() => normalizeTraceSummary({ Trace: row() }, { traceId: 'trace' }), code('PORTAL_CONTRACT_CHANGED'));
  assert.throws(() => normalizeTraceSummary({ ExceptionMessage: 'password=private' }, { traceId: 'trace' }), error => !error.message.includes('private'));
});

test('search validates explicit page and scope while preserving exact integer strings', () => {
  const result = normalizeTraceSearchResult(search(), options);
  assert.equal(result.returnedCount, 1);
  assert.equal(result.page.NextPageOffset, '-1');
  assert.equal(result.traces[0].Duration, '9007199254740993');
  assert.doesNotMatch(JSON.stringify(result), /private-|secret|UserName/);
  assert.equal(normalizeTraceSearchResult(search([{ ...row(), OriginAssetKey: '' }]), options).returnedCount, 1);
  assert.equal(normalizeTraceSearchResult(search([]), options).returnedCount, 0);
});

test('search fails closed for foreign asset, time, status or span type', () => {
  for (const override of [{ OriginAssetKey: 'foreign' }, { StartTime: '2026-09-15T12:00:00Z' }, { OriginAssetKey: '', OriginApplicationKey: 'foreign' }]) {
    assert.throws(() => normalizeTraceSearchResult(search([{ ...row(), ...override }]), options), code('PORTAL_BROKER_SCOPE_MISMATCH'));
  }
  for (const filter of [{ statuses: ['Error'] }, { spanTypes: ['Timer'] }]) {
    assert.throws(() => normalizeTraceSearchResult(search(), { ...options, ...filter }), code('PORTAL_BROKER_SCOPE_MISMATCH'));
  }
});

test('minimum duration is verified on the projected result, including missing and boundary values', () => {
  const scoped = { ...options, minDurationMs: 1000 };
  assert.equal(normalizeTraceSearchResult(search([{...row(), Duration:'1000'}]), scoped).returnedCount, 1);
  for (const Duration of ['999', undefined])
    assert.throws(() => normalizeTraceSearchResult(search([{...row(), Duration}]), scoped), code('PORTAL_BROKER_SCOPE_MISMATCH'));
  assert.throws(() => normalizeTraceSearchResult(search(), {...options,minDurationMs:-1}), code('INPUT_INVALID'));
});

test('search rejects malformed or mismatched pagination, excess and duplicate rows', () => {
  assert.throws(() => normalizeTraceSearchResult({ Traces: { List: [] } }, options), code('PORTAL_CONTRACT_CHANGED'));
  assert.throws(() => normalizeTraceSearchResult({ ...search(), Page: { ...search().Page, Offset: '10' } }, options), code('PORTAL_BROKER_SCOPE_MISMATCH'));
  assert.throws(() => normalizeTraceSearchResult(search([row(), row()]), options), code('PORTAL_CONTRACT_CHANGED'));
  assert.throws(() => normalizeTraceSearchResult(search(Array.from({ length: 11 }, (_, n) => ({ ...row(), Id: String(n) }))), options), code('PORTAL_CONTRACT_CHANGED'));
  assert.throws(() => normalizeTraceSearchResult(search(), { ...options, limit: 1001 }), code('INPUT_INVALID'));
  assert.throws(() => normalizeTraceSearchResult(search([{ ...row(), Duration: 9007199254740992 }]), options), code('PORTAL_CONTRACT_CHANGED'));
});

test('trace pager derives continuation from current native zero placeholders and preserves the wire page', () => {
  const data = search();
  Object.assign(data.Page, { Limit: '1', NextPageOffset: '0', TotalPages: '0', TotalResults: '3' });
  const result = normalizeTraceSearchResult(data, { ...options, limit: 1 });
  assert.equal(result.page.NextPageOffset, '0');
  assert.equal(result.pagination.NextPageOffset, '1');
  assert.equal(result.pagination.TotalPages, '3');
  assert.equal(result.nextPageAvailable, true);
  assert.equal(result.complete, false);
  data.Page.Offset = '2';
  const last = normalizeTraceSearchResult(data, { ...options, limit: 1, offset: 2 });
  assert.equal(last.pagination.NextPageOffset, '-1');
  assert.equal(last.complete, true);
});

test('trace pager rejects missing rows and contradictory explicit counters instead of skipping records', () => {
  for (const page of [{ TotalResults: '3' }, { TotalResults: '0' }, { TotalPages: '2' }, { NextPageOffset: '9' }]) {
    const data = search(); Object.assign(data.Page, page);
    assert.throws(() => normalizeTraceSearchResult(data, options), code('PORTAL_CONTRACT_CHANGED'));
  }
});


test('empty native summary ID requires matching server span identity without inventing a wire ID', () => {
  const trace = { Id:'', StartTime:'2026-10-08T21:47:35.034Z', Duration:'17334', Status:'Ok' };
  const root = { TraceId:'trace-proof', SpanId:'entry', ParentSpanId:'', IsEntrySpan:true,
    StartTime:trace.StartTime, Duration:trace.Duration, Status:trace.Status };
  const data = rows => ({ NotFound:false, Trace:trace, SummaryIdentitySpans:{ SpansList:{
    traceProcessingStatus:'Finished', MON_SpanItemList:{List:rows} } } });
  const result = normalizeTraceSummary(data([root]),{traceId:'trace-proof'});
  assert.equal(result.trace.Id,''); assert.equal(result.identity.basis,'entry-span-id-and-metadata');
  assert.equal(result.identity.checkedSpanCount,1); assert.equal(result.includesSpans,false);
  for (const patch of [{TraceId:'foreign'},{StartTime:'2026-10-08T00:00:00Z'},{Duration:'1'},{Status:'Error'},{IsEntrySpan:false},{ParentSpanId:'parent'}]) {
    assert.throws(()=>normalizeTraceSummary(data([{...root,...patch}]),{traceId:'trace-proof'}));
  }
  assert.throws(()=>normalizeTraceSummary(data([root,{...root,SpanId:'other'}]),{traceId:'trace-proof'}));
  assert.throws(()=>normalizeTraceSummary(data([root,{...root,SpanId:'foreign',TraceId:'foreign'}]),{traceId:'trace-proof'}));
  assert.throws(()=>normalizeTraceSummary(data(Array.from({length:1001},(_,i)=>({...root,SpanId:String(i)}))),{traceId:'trace-proof'}));
});

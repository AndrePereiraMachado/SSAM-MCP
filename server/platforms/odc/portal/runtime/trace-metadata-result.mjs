import { fail, redact } from './errors.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const textFields = ['Id', 'StartTime', 'OriginApplicationKey', 'OriginApplicationName', 'OriginAssetKey',
  'OriginAssetName', 'OriginAssetType', 'EntrySpanType', 'EntrySpanTypeLabel', 'EntrySpanName',
  'EntrySpanElementPath', 'Status', 'StatusLabel', 'ProcessingStatus'];
const integerFields = ['OriginApplicationVersion', 'OriginAssetVersion', 'Duration', 'NumberOfSpans', 'NumberOfErrors'];
const integer = value => typeof value === 'string' && /^-?\d{1,30}$/.test(value) ? value
  : Number.isSafeInteger(value) ? String(value) : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function envelope(data) {
  if (!isRecord(data) || data.ExceptionMessage) fail('PORTAL_RESPONSE_INVALID', 'Trace metadata response contains an error or invalid envelope.');
}

function project(row) {
  if (!isRecord(row) || !validId(row.Id) || timestamp(row.StartTime) === null) {
    fail('PORTAL_CONTRACT_CHANGED', 'Trace metadata identity or start time is invalid.');
  }
  const result = {};
  for (const key of textFields) if (typeof row[key] === 'string') result[key] = row[key].slice(0, 512);
  for (const key of integerFields) {
    if (row[key] === undefined) continue;
    const value = integer(row[key]);
    if (value === null || BigInt(value) < 0n) fail('PORTAL_CONTRACT_CHANGED', 'Trace metadata contains an invalid numeric field.');
    result[key] = value;
  }
  return result;
}

/** Summary is not a span tree and makes no full-trace completeness assertion. */
export function normalizeTraceSummary(data, { traceId } = {}) {
  if (!validId(traceId)) fail('INPUT_INVALID', 'An explicit trace ID is required.');
  envelope(data);
  if (typeof data.NotFound !== 'boolean') fail('PORTAL_CONTRACT_CHANGED', 'Trace summary NotFound flag is absent.');
  if (data.NotFound) return { traceId, notFound: true, trace: null, includesSpans: false };
  const trace = project(data.Trace);
  if (trace.Id !== traceId) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'The returned summary belongs to a different trace.');
  return redact({ traceId, notFound: false, trace, includesSpans: false });
}

/** Require explicit application/time scope and exact server pagination; never return an unscoped row. */
export function normalizeTraceSearchResult(data, { applicationKey, since, until, limit = 100, offset = 0, statuses = [], spanTypes = [] } = {}) {
  const start = timestamp(since), end = timestamp(until);
  if (!validId(applicationKey) || start === null || end === null || start > end
    || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(statuses) || !Array.isArray(spanTypes)
    || statuses.length > 100 || spanTypes.length > 100 || ![...statuses, ...spanTypes].every(validId)) {
    fail('INPUT_INVALID', 'Explicit application, valid time range, bounded limit and nonnegative offset are required.');
  }
  envelope(data);
  if (!Array.isArray(data.Traces?.List) || !isRecord(data.Page)) fail('PORTAL_CONTRACT_CHANGED', 'Expected trace collection and page metadata are absent.');
  const page = {};
  for (const key of ['Limit', 'Offset', 'NextPageOffset', 'TotalPages', 'TotalResults']) {
    const value = integer(data.Page[key]);
    if (value === null || BigInt(value) < (key === 'NextPageOffset' ? -1n : 0n)) fail('PORTAL_CONTRACT_CHANGED', 'Invalid trace page metadata.');
    page[key] = value;
  }
  if (BigInt(page.Limit) !== BigInt(limit) || BigInt(page.Offset) !== BigInt(offset)) {
    fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Trace response pagination does not match the request.');
  }
  if (data.Traces.List.length > limit) fail('PORTAL_CONTRACT_CHANGED', 'Trace search exceeded its requested page size.');
  const ids = new Set();
  const traces = data.Traces.List.map(row => {
    const trace = project(row), time = timestamp(row.StartTime);
    // The current UI sends application selection as AssetKey. Older rows may omit asset identity.
    const scopedKey = row.OriginAssetKey || row.OriginApplicationKey;
    if (scopedKey !== applicationKey || time < start || time > end
      || (statuses.length && !statuses.includes(row.Status)) || (spanTypes.length && !spanTypes.includes(row.EntrySpanType))) {
      fail('PORTAL_BROKER_SCOPE_MISMATCH', 'A trace search row is outside the requested application or time scope.');
    }
    if (ids.has(row.Id)) fail('PORTAL_CONTRACT_CHANGED', 'Trace search contains duplicate trace IDs.');
    ids.add(row.Id);
    return trace;
  });
  return redact({ applicationKey, since, until, traces, page, returnedCount: traces.length, includesSpans: false });
}

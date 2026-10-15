import { fail, boundedText, limitedText } from './errors.mjs';
import { normalizeTraceResult } from './trace-result.mjs';
import { PAGE_FIELDS, pageInteger, paginationDiagnostic } from './pagination-diagnostic.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const textFields = ['Id', 'StartTime', 'OriginApplicationKey', 'OriginApplicationName', 'OriginAssetKey',
  'OriginAssetName', 'OriginAssetType', 'EntrySpanType', 'EntrySpanTypeLabel', 'EntrySpanName',
  'EntrySpanElementPath', 'Status', 'StatusLabel', 'ProcessingStatus'];
const integerFields = ['OriginApplicationVersion', 'OriginAssetVersion', 'Duration', 'NumberOfSpans', 'NumberOfErrors'];
const freeTextFields = new Set(['OriginApplicationName', 'OriginAssetName', 'EntrySpanTypeLabel', 'EntrySpanName', 'EntrySpanElementPath', 'StatusLabel']);
const integer = value => typeof value === 'string' && /^-?\d{1,30}$/.test(value) ? value
  : Number.isSafeInteger(value) ? String(value) : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function envelope(data) {
  if (!isRecord(data) || data.ExceptionMessage) fail('PORTAL_RESPONSE_INVALID', 'Trace metadata response contains an error or invalid envelope.');
}

function project(row, allowEmptyId = false) {
  if (!isRecord(row) || (!validId(row.Id) && !(allowEmptyId && row.Id === '')) || timestamp(row.StartTime) === null) {
    fail('PORTAL_CONTRACT_CHANGED', 'Trace metadata identity or start time is invalid.');
  }
  const result = {};
  for (const key of textFields) if (typeof row[key] === 'string') {
    result[key] = freeTextFields.has(key) ? boundedText(row[key], 512, result, key) : limitedText(row[key], 512, result, key);
  }
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
  let identity = { verified: true, basis: 'summary-id' };
  if (data.Trace?.Id === '') {
    if (!isRecord(data.SummaryIdentitySpans)) fail('PORTAL_CONTRACT_CHANGED', 'Summary identity is absent and has no span evidence.');
    const evidence = normalizeTraceResult(data.SummaryIdentitySpans, { traceId, maxSpans: 1000 });
    if (evidence.truncated || evidence.receivedSpanCount !== evidence.returnedSpanCount)
      fail('PORTAL_CONTRACT_CHANGED', 'Summary identity requires a bounded set without duplicate spans.');
    const entries = evidence.spans.filter(span => span.IsEntrySpan === true && span.ParentSpanId === '');
    const entry = entries[0];
    if (entries.length !== 1 || timestamp(entry.StartTime) !== timestamp(data.Trace.StartTime)
      || timestamp(entry.StartTime) === null || entry.Duration !== integer(data.Trace.Duration)
      || !entry.Status || entry.Status !== data.Trace.Status)
      fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Summary metadata does not match the identified entry span.');
    identity = { verified: true, basis: 'entry-span-id-and-metadata', spanId: entry.SpanId, checkedSpanCount: evidence.returnedSpanCount };
  }
  const trace = project(data.Trace, identity.basis === 'entry-span-id-and-metadata');
  if (trace.Id !== '' && trace.Id !== traceId) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'The returned summary belongs to a different trace.');
  return { traceId, notFound: false, trace, identity, includesSpans: false };
}

/** Require explicit application/time scope and bounded server pagination. */
export function normalizeTraceSearchResult(data, { applicationKey, since, until, limit = 100, offset = 0, statuses = [], spanTypes = [], minDurationMs = 0 } = {}) {
  const start = timestamp(since), end = timestamp(until);
  if (!validId(applicationKey) || start === null || end === null || start > end
    || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(statuses) || !Array.isArray(spanTypes) || !Number.isSafeInteger(minDurationMs) || minDurationMs < 0
    || statuses.length > 100 || spanTypes.length > 100 || ![...statuses, ...spanTypes].every(validId)) {
    fail('INPUT_INVALID', 'Explicit application, valid time range, bounded limit and nonnegative offset are required.');
  }
  envelope(data);
  const diagnostic = fields => paginationDiagnostic({ limit, offset }, data.Page, fields);
  if (!isRecord(data.Page)) fail('PORTAL_CONTRACT_CHANGED', 'Expected trace page metadata is absent.', diagnostic(PAGE_FIELDS));
  if (!Array.isArray(data.Traces?.List)) fail('PORTAL_CONTRACT_CHANGED', 'Expected trace collection is absent.');
  const page = {};
  const invalid = PAGE_FIELDS.filter(key => {
    const value = pageInteger(data.Page[key]);
    if (value === null || value < (key === 'NextPageOffset' ? -1 : 0)) return true;
    page[key] = String(value);
    return false;
  });
  if (invalid.length) fail('PORTAL_CONTRACT_CHANGED', 'Invalid trace page metadata.', diagnostic(invalid));
  const receivedLimit = Number(page.Limit);
  const scopeFields = [ ...(receivedLimit < 1 || receivedLimit > limit ? ['Limit'] : []), ...(Number(page.Offset) !== offset ? ['Offset'] : []) ];
  if (scopeFields.length) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'Trace response pagination does not match the request.', diagnostic(scopeFields));
  if (data.Traces.List.length > receivedLimit) fail('PORTAL_CONTRACT_CHANGED', 'Trace search exceeded its server page size.', diagnostic(['Limit']));
  const ids = new Set();
  const traces = data.Traces.List.map(row => {
    const trace = project(row), time = timestamp(row.StartTime);
    // The current UI sends application selection as AssetKey. Older rows may omit asset identity.
    const scopedKey = row.OriginAssetKey || row.OriginApplicationKey;
    if (scopedKey !== applicationKey || time < start || time > end
      || (statuses.length && !statuses.includes(row.Status)) || (spanTypes.length && !spanTypes.includes(row.EntrySpanType))
      || (minDurationMs > 0 && (trace.Duration === undefined || BigInt(trace.Duration) < BigInt(minDurationMs)))) {
      fail('PORTAL_BROKER_SCOPE_MISMATCH', 'A trace search row is outside the requested application or time scope.');
    }
    if (ids.has(row.Id)) fail('PORTAL_CONTRACT_CHANGED', 'Trace search contains duplicate trace IDs.');
    ids.add(row.Id);
    return trace;
  });
  // The current Portal pager uses Offset, Limit and TotalResults. Its search
  // action leaves NextPageOffset/TotalPages at zero, including on middle pages.
  // Preserve that wire page and expose the derived continuation separately.
  const total = BigInt(page.TotalResults), after = BigInt(offset) + BigInt(traces.length);
  if ((traces.length > 0 && after > total) || (after < total && traces.length < receivedLimit))
    fail('PORTAL_CONTRACT_CHANGED', 'Trace page count is inconsistent with its reported total.', diagnostic(['Limit', 'TotalResults']));
  const nextPageAvailable = after < total;
  const nextOffset = nextPageAvailable ? after : -1n;
  if (page.NextPageOffset !== '0' && BigInt(page.NextPageOffset) !== nextOffset)
    fail('PORTAL_CONTRACT_CHANGED', 'Trace continuation is inconsistent with its page and total.', diagnostic(['NextPageOffset']));
  const totalPages = (total + BigInt(receivedLimit) - 1n) / BigInt(receivedLimit);
  if (page.TotalPages !== '0' && BigInt(page.TotalPages) !== totalPages && !(total === 0n && page.TotalPages === '1'))
    fail('PORTAL_CONTRACT_CHANGED', 'Trace total page count is inconsistent.', diagnostic(['TotalPages']));
  return { applicationKey, since, until, traces, page,
    pagination: { ...page, NextPageOffset: String(nextOffset), TotalPages: String(totalPages) },
    paginationSource: 'offset-limit-total', serverLimit: receivedLimit, nextPageAvailable, complete: !nextPageAvailable,
    returnedCount: traces.length, includesSpans: false };
}

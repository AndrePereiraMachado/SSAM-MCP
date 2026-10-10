import { fail, redact } from './errors.mjs';

const textFields = ['ApplicationKey', 'ApplicationName', 'LibraryKey', 'LibraryName', 'AssetKey', 'AssetName',
  'AssetType', 'ElementPath', 'StartTime', 'EndTime', 'TraceId', 'SpanId', 'ParentSpanId', 'SpanType',
  'SpanTypeLabel', 'SpanName', 'Status', 'StatusLabel', 'StatusMessage', 'SpanKind'];
const integerFields = ['ApplicationVersion', 'LibraryVersion', 'AssetVersion', 'Duration', 'StartTimeUnixNano', 'EndTimeUnixNano'];
const decimalInteger = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const identifier = value => typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f]/.test(value);

/** Project the observed MON_TraceSpan wire response without exposing arbitrary attributes or URLs.
 * Completeness means the server claims Finished AND the bounded returned graph is structurally intact.
 * It does not establish that upstream tracing captured every event.
 */
export function normalizeTraceResult(data, { traceId, maxSpans = 1000 } = {}) {
  if (!identifier(traceId) || !traceId || !Number.isInteger(maxSpans) || maxSpans < 1 || maxSpans > 1000) {
    fail('INPUT_INVALID', 'An explicit trace ID and maxSpans between 1 and 1000 are required.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ExceptionMessage) {
    fail('PORTAL_RESPONSE_INVALID', 'Trace span response contains an error or invalid envelope.');
  }
  const response = data.SpansList;
  const source = response?.MON_SpanItemList?.List;
  if (!Array.isArray(source) || typeof response.traceProcessingStatus !== 'string' || response.traceProcessingStatus.length > 100) {
    fail('PORTAL_CONTRACT_CHANGED', 'Expected MON_TraceSpan collection and processing status are absent.');
  }
  const processingStatus = response.traceProcessingStatus;
  const reasons = new Set();
  const serverClaimsComplete = processingStatus === 'Finished';
  if (!serverClaimsComplete) reasons.add(processingStatus === 'Processing' ? 'server_processing'
    : processingStatus === 'FinishedWithMissingSpans' ? 'server_missing_spans'
    : processingStatus === 'FinishedWithMissingRootSpan' ? 'server_missing_root'
    : 'server_completeness_not_confirmed');
  const truncated = source.length > maxSpans;
  if (truncated) reasons.add('local_span_limit');
  const spans = [], nodes = new Map();
  // Inspect only the bounded subset; do not expand nested Attributes or return unbounded free text.
  for (const row of source.slice(0, maxSpans)) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !identifier(row.SpanId) || !row.SpanId
      || !identifier(row.ParentSpanId) || !identifier(row.TraceId) || !row.TraceId) {
      fail('PORTAL_CONTRACT_CHANGED', 'A span record has invalid identity or parent fields.');
    }
    if (row.TraceId !== traceId) fail('PORTAL_BROKER_SCOPE_MISMATCH', 'A returned span belongs to a different trace.');
    if (nodes.has(row.SpanId)) { reasons.add('duplicate_span_ids'); continue; }
    const span = {};
    for (const field of textFields) if (typeof row[field] === 'string') span[field] = row[field].slice(0, field === 'StatusMessage' ? 2048 : 512);
    for (const field of integerFields) {
      const value = decimalInteger(row[field]);
      if (value !== null) span[field] = value;
    }
    for (const field of ['LowCode', 'IsEntrySpan']) if (typeof row[field] === 'boolean') span[field] = row[field];
    spans.push(span); nodes.set(row.SpanId, span);
  }
  const roots = [], edges = [], missingParents = [];
  for (const span of spans) {
    if (!span.ParentSpanId) roots.push(span.SpanId);
    else if (nodes.has(span.ParentSpanId)) edges.push({ parentSpanId: span.ParentSpanId, spanId: span.SpanId });
    else missingParents.push({ spanId: span.SpanId, parentSpanId: span.ParentSpanId });
  }
  if (missingParents.length) reasons.add('missing_parent_spans');
  if (!roots.length) reasons.add('missing_root_span');
  const checked = new Set(), cycleIds = new Set();
  for (const span of spans) {
    const path = [], positions = new Map();
    let id = span.SpanId;
    while (id && nodes.has(id) && !checked.has(id)) {
      if (positions.has(id)) { for (const member of path.slice(positions.get(id))) cycleIds.add(member); break; }
      positions.set(id, path.length); path.push(id); id = nodes.get(id).ParentSpanId;
    }
    path.forEach(value => checked.add(value));
  }
  if (cycleIds.size) reasons.add('cyclic_parent_relationships');
  const timed = [];
  for (const span of spans) {
    const start = decimalInteger(span.StartTimeUnixNano), end = decimalInteger(span.EndTimeUnixNano);
    if (start === null || end === null || BigInt(end) < BigInt(start)) { reasons.add('invalid_or_missing_timing'); continue; }
    timed.push({ spanId: span.SpanId, start: BigInt(start), end: BigInt(end) });
  }
  timed.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.spanId.localeCompare(b.spanId));
  const base = timed[0]?.start;
  const timeline = timed.map(span => ({ spanId: span.spanId, startTimeUnixNano: String(span.start),
    endTimeUnixNano: String(span.end), offsetNanoseconds: String(span.start - base), durationNanoseconds: String(span.end - span.start) }));
  return redact({ traceId, processingStatus, serverClaimsComplete, complete: reasons.size === 0,
    completenessBasis: 'Server status and structural checks on the returned bounded set; not proof of complete upstream capture.',
    incompleteReasons: [...reasons], receivedSpanCount: source.length, returnedSpanCount: spans.length, truncated,
    spans, timeline, hierarchy: { roots, edges, missingParents, cyclicSpanIds: [...cycleIds] } });
}

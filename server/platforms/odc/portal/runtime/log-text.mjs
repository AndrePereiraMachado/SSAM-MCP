import { fail } from './errors.mjs';

// Observed logs.log and trace log-list clients decode these three fields;
// StackTrace is rendered as plain text. Never infer encoding in search results.
const encodedFields = ['Message', 'ExceptionMessage', 'ConcatenatedMessageException'];
export function decodeLogText(body, operationId) {
  let rows;
  if (operationId === 'monitoring.detail') rows = body?.data?.Log ? [body.data.Log] : [];
  else if (operationId === 'monitoring.traceLogs') {
    const list = body?.data?.RelatedLogList;
    rows = Array.isArray(list) ? list : list?.List ?? [];
  } else return body;
  if (!Array.isArray(rows)) fail('PORTAL_CONTRACT_CHANGED', 'Encoded log collection has an invalid shape.');
  for (const row of rows) for (const key of encodedFields) {
    const value = row?.[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 1048576 || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      fail('PORTAL_CONTRACT_CHANGED', 'An encoded log text field is malformed or exceeds its bound.');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) fail('PORTAL_CONTRACT_CHANGED', 'An encoded log text field is noncanonical.');
    try { row[key] = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('PORTAL_CONTRACT_CHANGED', 'An encoded log text field is not UTF-8.'); }
  }
  return body;
}

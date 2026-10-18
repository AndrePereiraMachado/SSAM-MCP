import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialRegistry } from '../runtime/credential-registry.mjs';
import { normalizeTraceResult } from '../runtime/trace-result.mjs';
import { normalizeTraceSummary, normalizeTraceSearchResult } from '../runtime/trace-metadata-result.mjs';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';
import { projectForAgent } from '../runtime/agent-projection.mjs';
import { envelope } from '../runtime/portal-routes.mjs';
import { markTruncatedField } from '../runtime/errors.mjs';

const traceId = 'trace-redaction', applicationKey = 'app-redaction';
const since = '2026-10-10T10:00:00Z', until = '2026-10-10T11:00:00Z';
const token = 'synthetic-session-credential-0123456789abcdef';
const longToken = 'synthetic-long-credential-' + '0123456789abcdef'.repeat(40);
const credentialRegistry = new CredentialRegistry();
credentialRegistry.add(token); credentialRegistry.add(longToken);
const crossing = (limit, secret = token) => 'Z'.repeat(limit - 12) + secret;
const assertNoFragments = (value, secret = token) => {
  const text = JSON.stringify(value);
  // Never put synthetic credential fragments in assertion diagnostics either.
  for (let index = 0; index <= secret.length - 8; index++)
    assert.equal(text.includes(secret.slice(index, index + 8)), false, 'credential fragment is exposed');
};
const traceSpan = changes => ({ TraceId: traceId, SpanId: 'span-redaction', ParentSpanId: '',
  StartTimeUnixNano: '1720000000000000001', EndTimeUnixNano: '1720000000000000011', ...changes });
const traceBody = spans => ({ SpansList: { traceProcessingStatus: 'Finished', MON_SpanItemList: { List: spans } } });
const metadataRow = changes => ({ Id: traceId, StartTime: since, OriginApplicationKey: applicationKey,
  OriginAssetKey: applicationKey, Status: 'Ok', Duration: '1', ...changes });

test('M3 span text masks registered values before the 512 and 2048 bounds', () => {
  const actual = normalizeTraceResult(traceBody([traceSpan({ SpanName: crossing(512), StatusMessage: crossing(2048) })]), { traceId });
  assertNoFragments(actual);
  assert.equal(actual.complete, true);
  assert.equal(actual.spans[0].SpanName.endsWith('[REDACTED]'), true);
  assert.equal(actual.spans[0].StatusMessage.endsWith('[REDACTED]'), true);
  assert.equal(actual.timeline[0].durationNanoseconds, '10');
});

test('M3 a credential longer than 512 characters is fully removed from SpanName', () => {
  const actual = normalizeTraceResult(traceBody([traceSpan({ SpanName: longToken })]), { traceId });
  assertNoFragments(actual, longToken);
  assert.equal(actual.spans[0].SpanName, '[REDACTED]');
});

test('M3 trace summary and search mask free text before their 512 bound', () => {
  const row = metadataRow({ EntrySpanName: crossing(512), OriginApplicationName: longToken });
  const summary = normalizeTraceSummary({ NotFound: false, Trace: row }, { traceId });
  const search = normalizeTraceSearchResult({ Traces: { List: [row] }, Page: {
    Limit: '1', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '1',
  } }, { applicationKey, since, until, limit: 1, offset: 0 });
  for (const actual of [summary, search]) { assertNoFragments(actual); assertNoFragments(actual, longToken); }
  assert.equal(summary.trace.Id, traceId);
  assert.equal(search.traces[0].StartTime, since);
});

test('M3 log text masks registered values before the 8192 bound after validation', async () => {
  const origin = 'https://tenant.example.test';
  const broker = { target: 'odc3', origin, credentialRegistry, async readScreenservice() {
    return { target: 'odc3', origin, body: { data: { LogsList: { List: [{ LogId: 'log-redaction',
      TraceId: traceId, ApplicationKey: applicationKey, Time: since, Severity: 'Error', Message: crossing(8192) }] },
    LogSearch_Page: { Limit: '1', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '1' } } } };
  } };
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
  // Test the remote projection before the outer boundary's prefix fallback.
  const actual = await adapter.executeRaw({ operationId: 'monitoring.errors', input: {
    environmentKey: 'stage-redaction', applicationKey, since, until, limit: 1, offset: 0,
  } });
  assert.equal(actual.ok, true);
  assertNoFragments(actual);
  assert.equal(actual.rows[0].Message.endsWith('[REDACTED]'), true);
  assert.equal(actual.pagination.Limit, 1);
});

test('remote envelope retains structured secret protection after validation', () => {
  const actual = envelope('fixture', { data: { ClientSecret: '', setting: { isSecret: true, Value: 'fixture-private-value' }, versionToken: 'public-version' } });
  assert.equal(actual.data.ClientSecret, '[REDACTED]');
  assert.equal(actual.data.setting.Value, '[REDACTED]');
  assert.equal(actual.data.versionToken, 'public-version');
});

test('M3 final boundary removes truncated credential suffixes of at least eight characters', async () => {
  for (const value of [token, encodeURIComponent(token + '/+=')]) {
    credentialRegistry.add(token + '/+=');
    const actual = await projectForAgent(async () => {
      const projection = { text: 'prefix ' + value.slice(0, 12), short: value.slice(0, 7), untouched: 'prefix ' + value.slice(0, 12) };
      markTruncatedField(projection, 'text');
      return projection;
    });
    assert.equal(actual.text, 'prefix [REDACTED]');
    assert.equal(actual.short === value.slice(0, 7), true);
    assert.equal(actual.untouched === 'prefix ' + value.slice(0, 12), true);
  }
});

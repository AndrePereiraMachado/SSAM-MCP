// Isolated synthetic workload. Messages contain only counts, booleans and timings.
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { PortalReadAdapter } from '../../runtime/portal-read.mjs';
import * as registryModule from '../../runtime/credential-registry.mjs';
import { redact, redactValues } from '../../runtime/errors.mjs';
import { Odc3PortalBroker } from '../../runtime/odc3-context.mjs';
import { OAuthClient } from '../../runtime/auth.mjs';

const { CredentialRegistry, processCredentials } = registryModule;
const synthetic = length => randomBytes(length).toString('base64url').slice(0, length);
const origin = 'https://synthetic-tenant.outsystems.dev';
const lengths = [1000, 1200, 1780, 36, 36, ...Array(13).fill(40)];
function logins(registry, count) {
  for (let index = 0; index < count; index++) {
    registry.reset();
    registry.tokens({ AccessToken: synthetic(1000), IdToken: synthetic(1200), RefreshToken: synthetic(1780) });
    registry.add(synthetic(36)); registry.add(synthetic(36));
    for (let cookie = 0; cookie < 13; cookie++) registry.cookie({ key: 'synthCookie' + cookie, value: synthetic(40) }, new URL(origin).host);
  }
}
async function trace(count, active = false) {
  const registry = new CredentialRegistry();
  if (active) for (let i = 0; i < count; i++) registry.add(synthetic(40));
  else {
    for (let i = 0; i < count; i++) { if (i % 18 === 0) registry.reset(); registry.add(synthetic(lengths[i % 18])); }
  }
  const traceId = 'a'.repeat(32), appKey = '11111111-2222-3333-4444-555555555555';
  const List = Array.from({ length: 1000 }, (_, i) => ({
    TraceId: traceId, SpanId: 's' + i, ParentSpanId: i ? 's' + (i - 1) : '',
    StartTime: '2026-10-01T12:00:00Z', EndTime: '2026-10-01T12:00:01Z', StartTimeUnixNano: String(1e18 + i), EndTimeUnixNano: String(1e18 + i + 5),
    Duration: 5, ApplicationKey: appKey, ApplicationName: 'Synthetic App', AssetKey: appKey, AssetName: 'Asset', AssetType: 'Web',
    ElementPath: 'Flow/Screen/Action' + i, SpanType: 'ServerAction', SpanTypeLabel: 'Server action', SpanName: 'Span ' + i + ' ' + 'y'.repeat(160),
    Status: 'Ok', StatusLabel: 'Ok', StatusMessage: 'z'.repeat(160), SpanKind: 'Internal', LowCode: true, IsEntrySpan: i === 0,
  }));
  const body = { data: { SpansList: { MON_SpanItemList: { List }, traceProcessingStatus: 'Finished' } } };
  const broker = { target: 'odc3', origin, credentialRegistry: registry, nativeTraceContext: true, authenticated: true,
    verifiedOperations: new Set(), blockedOperations: new Set(), readScreenservice: async () => ({ target: 'odc3', origin, body }) };
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
  const measurementMode = count === 4096 ? 'warm-read' : 'cold-read';
  let compileMs = null, matcherReadyBeforeRead = false;
  if (measurementMode === 'warm-read') {
    // Compile outside both the measured read and its event-loop probe.
    const compileStart = performance.now();
    const probe = processCredentials()[0];
    const maskedProbe = redactValues(probe);
    compileMs = performance.now() - compileStart;
    matcherReadyBeforeRead = maskedProbe === '[REDACTED]';
  }
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  last = performance.now(); maxGap = 0;
  const start = performance.now();
  const result = await adapter.execute({ operationId: 'monitoring.trace', input: { environmentKey: 'env', traceId, maxSpans: 1000 } });
  const elapsedMs = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(timer);
  return { count: processCredentials().length, ...registryModule.processCredentialSummary(), measurementMode, compileMs, matcherReadyBeforeRead,
    bodyBytes: Buffer.byteLength(JSON.stringify(body)), elapsedMs, maxGapMs: maxGap,
    ok: result.ok, spans: result.spans?.length ?? 0 };
}
function bulk() {
  const registry = new CredentialRegistry();
  for (let i = 0; i < 1000; i++) registry.add(synthetic(lengths[i % lengths.length]));
  const sample = [...registry.values()][0];
  // A realistic text collection also catches rebuilding the matcher per field.
  const chunks = Array.from({ length: 1024 }, () => 'x'.repeat(8192));
  chunks[chunks.length - 1] = 'x'.repeat(8192 - sample.length) + sample;
  const value = { text: chunks };
  const measurements = {};
  for (const [name, fn] of [['redactValues', redactValues], ['redact', redact]]) {
    const start = performance.now(); const result = fn(value);
    measurements[name] = { elapsedMs: performance.now() - start, safe: !result.text.some(text => text.includes(sample)), masked: result.text.at(-1).endsWith('[REDACTED]') };
  }
  return { bytes: chunks.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0), count: processCredentials().length, ...measurements };
}
async function growth() {
  const registry = new CredentialRegistry(); logins(registry, 1000);
  const loginCount = processCredentials().length, loginSummary = registryModule.processCredentialSummary();
  const fetchImpl = async () => ({ status: 200, headers: { getSetCookie: () => ['synthSession=' + synthetic(48) + '; Path=/; Secure; HttpOnly'], get: () => null }, body: null });
  const broker = new Odc3PortalBroker({ origin, fetchImpl });
  for (let i = 0; i < 1000; i++) await broker.request(origin + '/monitoring/');
  const cookieCount = processCredentials().length, cookieSummary = registryModule.processCredentialSummary();
  const liveBefore = registryModule.processCredentialSummary?.().registryCount;
  for (let i = 0; i < 1000; i++) {
    const released = new Odc3PortalBroker({ origin, fetchImpl });
    await released.request(origin + '/monitoring/');
    if (typeof released.dispose === 'function') await released.dispose();
    else if (typeof released.credentialRegistry.dispose === 'function') released.credentialRegistry.dispose();
    else released.credentialRegistry.reset();
  }
  const releaseCount = processCredentials().length, releaseSummary = registryModule.processCredentialSummary(), liveAfter = releaseSummary.registryCount;
  let now = 0;
  const auth = new OAuthClient({ origin, clientId: 'synthetic-client', clientSecret: synthetic(40), trustedTokenOrigins: new Set([origin]), timeoutMs: 5000, maxResponseBytes: 1048576 }, async url => Response.json(String(url).includes('.well-known')
    ? { token_endpoint: origin + '/token' }
    : { access_token: synthetic(900), token_type: 'Bearer', expires_in: 1 }), () => now);
  for (let i = 0; i < 1000; i++) { await auth.getToken(); now += 10000; }
  return { limit: registryModule.MAX_PROCESS_CREDENTIALS ?? 4096, loginCount, cookieCount, releaseCount, loginSummary, cookieSummary, releaseSummary, oauthSummary: registryModule.processCredentialSummary(),
    oauthCount: processCredentials().length, oauthKnown: auth.knownTokens.size, liveBefore, liveAfter,
    registrySize: [...registry.values()].length, cookieRegistrySize: [...broker.credentialRegistry.values()].length,
    oauthRegistrySize: [...auth.credentialRegistry.values()].length };
}

function nested(count) {
  const values = Array.from({ length: count }, (_, index) => 'A'.repeat(16 + index));
  const registry = new CredentialRegistry(); for (const value of values) registry.add(value);
  const text = 'A'.repeat(1024 * 1024);
  // Frozen reference semantics from 834f7542, without its prefix/pattern pass.
  let expected = text;
  for (const value of [...values].sort((left, right) => right.length - left.length)) expected = expected.split(value).join('[REDACTED]');
  const start = performance.now();
  const result = redactValues(text);
  return { count: processCredentials().length, bytes: text.length, elapsedMs: performance.now() - start,
    exact: result === expected, heapUsedBytes: process.memoryUsage().heapUsed };
}

try {
  const result = workerData.kind === 'trace' ? await trace(workerData.count, workerData.active) : workerData.kind === 'bulk' ? bulk()
    : workerData.kind === 'nested' ? nested(workerData.count) : await growth();
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ failure: error.code ?? error.name }); }

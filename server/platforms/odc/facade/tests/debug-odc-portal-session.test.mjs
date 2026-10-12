import test from 'node:test';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import assert from 'node:assert/strict';
import { OdcStudioSessionAuth, debugDevelopmentStage, explicitDebugTenant, debugAsset, debugApplicationRuntime } from '../debug-odc-portal-session.mjs';
import { connect } from '../debug-odc-portal.mjs';
import { OdcBridge } from '../../portal/runtime/bridge.mjs';
import { readConfig } from '../../portal/runtime/config.mjs';
const host = 'personal-example.outsystems.dev';
const binding = { host, pid: 123, startedUtc: '2026-10-05T02:00:00.0000000Z', studioDir: 'C:/SDK', includeToken: true };
const response = (token = 'private-token') => ({ ok: true, token, metadata: { host, developerKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, binding: { ...binding } });
test('developer token stays private, caches only in memory and pins the complete native process binding', async () => {
  let now = 0, calls = 0, next = response();
  const auth = new OdcStudioSessionAuth({ host, now: () => now, acquire: async input => { assert.deepEqual(input, { host, includeToken: true }); calls++; return next; } });
  assert.equal(await auth.getToken(), 'private-token'); assert.equal(next.token, null);
  assert.equal(await auth.getToken(), 'private-token'); assert.equal(calls, 1);
  assert.equal(JSON.stringify(auth).includes('private-token'), false);
  now = 61000; next = response('new-token'); next.binding.pid++;
  await assert.rejects(auth.getToken(), /native_binding_changed/);
  next = response('new-token'); next.metadata.developerKey = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  await assert.rejects(auth.getToken(), /native_binding_changed/);
});

test('technical app route resolves a spaced display name through metadata and confirms the exact native URL/key', async () => {
  const key = '11111111-2222-3333-4444-555555555555', moduleKey = 'K'.repeat(22), stage = { domain: 'personal-example-dev.outsystems.app' };
  const asset = { assetKey: key, name: 'Escala Viva', assetType: 'WebApplication', _embedded: { metadata: { urlPath: 'EscalaViva' } } };
  const queries = [], portal = { nativeSession: true, host, read: async (_op, { query }) => { queries.push(query);
    return { results: query.nameContains ? [] : [asset], page: { offset: 0, count: query.nameContains ? 0 : 1, nextPageOffset: null, totalResults: query.nameContains ? 0 : 1 } }; },
    readApplication: async received => { assert.equal(received, moduleKey); return { host, moduleKey, moduleName: 'Escala Viva', runtimeUrl: 'https://' + stage.domain + '/EscalaViva' }; } };
  const found = await debugAsset(portal, 'EscalaViva'); assert.equal(found.assetKey, key);
  assert.equal(queries[1]['metadata.urlPathContains'], 'EscalaViva');
  assert.equal(await debugApplicationRuntime(portal, stage, found, moduleKey), 'https://' + stage.domain + '/EscalaViva/');
  portal.readApplication = async () => ({ host, moduleKey: 'X'.repeat(22), runtimeUrl: 'https://' + stage.domain + '/EscalaViva' });
  await assert.rejects(debugApplicationRuntime(portal, stage, found, moduleKey), /application_binding_invalid/);
});
test('native 401 is terminal: no refresh, retry or API Client fallback and response tokens are redacted', { skip: foreignPendingReason('bridge-auth') }, async () => {
  let acquisitions = 0, sends = 0;
  const auth = new OdcStudioSessionAuth({ host, acquire: async () => { acquisitions++; return response(); } });
  const bridge = new OdcBridge({ config: readConfig({ ODC_PORTAL_ORIGIN: 'https://' + host }), auth,
    fetchImpl: async (_url, options) => { sends++; assert.equal(options.headers.authorization, 'Bearer private-token');
      return new Response(JSON.stringify({ echoed: 'private-token' }), { status: 401, headers: { 'content-type': 'application/json' } }); } });
  const result = await bridge.execute('portfolio-api-v2:get:/environments', {}, 'read');
  assert.equal(result.status, 401); assert.equal(sends, 1); assert.equal(acquisitions, 1);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(bridge.status().auth.method, 'ODC Studio developer session');
  const again = await bridge.execute('portfolio-api-v2:get:/environments', {}, 'read');
  assert.equal(again.ok, false); assert.equal(sends, 1); assert.equal(acquisitions, 1);
});
test('unknown tenant requires an explicit exact ODC host, and missing Development metadata is discovered read-only', async () => {
  const missing = () => { throw Error('Unknown tenant explicit'); };
  assert.equal(explicitDebugTenant(host, missing).tenant.nativeSessionOnly, true);
  assert.throws(() => explicitDebugTenant(undefined, missing), /Unknown tenant/);
  assert.throws(() => explicitDebugTenant('https://' + host, missing), /Unknown tenant/);
  const environment = { key: '11111111-2222-3333-4444-555555555555', purpose: 'Development', builtinDomain: 'personal-example-dev.outsystems.app' };
  let queries = 0;
  const portal = { tenant: {}, nativeSession: true, read: async (operation, input) => { queries++; assert.equal(operation, 'portfolio-api-v2:get:/environments'); assert.deepEqual(input, {}); return { results: [environment] }; } };
  const stage = await debugDevelopmentStage(portal);
  assert.equal(stage.key, environment.key); assert.equal(stage.domain, environment.builtinDomain); assert.equal(queries, 1);
  portal.read = async () => ({ results: [environment, { ...environment, key: '66666666-2222-3333-4444-555555555555' }] });
  await assert.rejects(debugDevelopmentStage(portal), /environment_ambiguous/);
});
test('connection chooses native authentication only for confirmed missing credentials; a configured 401 cannot switch authority', { skip: foreignPendingReason('bridge-auth') }, async () => {
  let native = 0, configured = false, sends = 0;
  const config = readConfig({ ODC_PORTAL_ORIGIN: 'https://' + host });
  const lib = { portal: async () => ({ OdcBridge }), tenantOf: () => ({ host, tenant: { portalOrigin: config.origin } }),
    portalBridge: async () => ({ credentialAvailable: configured, bridge: new OdcBridge({ config,
      auth: { method: 'test API Client', configured: () => true, getToken: async () => 'client-token', invalidate: () => {}, secrets: () => ['client-token'] },
      fetchImpl: async () => { sends++; return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }); } }) }) };
  const services = { lib, credentialStatus: async () => ({ available: configured }), getNativeSession: async () => { native++; return response(); } };
  const first = await connect(host, { services }); assert.equal(first.nativeSession, true);
  assert.equal(first.bridge.status().auth.method, 'ODC Studio developer session');
  assert.equal(await first.bridge.auth.getToken(), 'private-token'); assert.equal(native, 1);
  await assert.rejects(first.direct('POST', config.origin + '/api/asset-repository/v1/uploads'), /native_write_unavailable/);
  await assert.rejects(first.direct('GET', 'https://other.outsystems.dev/path'), /origin_mismatch/);
  configured = true;
  const second = await connect(host, { services });
  await assert.rejects(second.read('portfolio-api-v2:get:/environments', {}), /read_failed/);
  assert.equal(native, 1); assert.equal(sends, 2);
  services.credentialStatus = async () => { throw Error('vault unavailable'); };
  await assert.rejects(connect(host, { services }), /vault unavailable/); assert.equal(native, 1);
});

test('configured built-in API Client remains valid when reused by the connection writer', async () => {
  const config = readConfig({ ODC_PORTAL_ORIGIN: 'https://' + host, ODC_CLIENT_ID: 'synthetic-client', ODC_CLIENT_SECRET: 'synthetic-secret' });
  const requests = [], injected = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    if (String(url).endsWith('/identity/.well-known/openid-configuration')) return Response.json({ token_endpoint: config.origin + '/identity/connect/token' });
    if (String(url).endsWith('/identity/connect/token')) return Response.json({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 });
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    return Response.json({ results: [] });
  };
  // Use the real built-in OAuthClient: a fake provider carrying method masked this regression.
  const configured = new OdcBridge({ config, fetchImpl });
  class RecordingBridge extends OdcBridge {
    constructor(options) { super(options); injected.push(options.auth); }
  }
  const lib = { portal: async () => ({ OdcBridge: RecordingBridge }), tenantOf: () => ({ host, tenant: { portalOrigin: config.origin } }),
    portalBridge: async () => ({ credentialAvailable: true, bridge: configured }) };
  const portal = await connect(host, { services: { lib, credentialStatus: async () => ({ available: true }),
    getNativeSession: async () => { assert.fail('A configured API Client must never switch to Studio identity.'); } } });
  assert.equal(portal.nativeSession, false);
  assert.equal(injected.length, 1);
  assert.equal(injected[0], configured.auth);
  assert.equal(portal.bridge.status().auth.method, 'OAuth 2.0 client_credentials');
  assert.deepEqual(await portal.read('portfolio-api-v2:get:/environments', {}), { results: [] });
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1).method, 'GET');
});

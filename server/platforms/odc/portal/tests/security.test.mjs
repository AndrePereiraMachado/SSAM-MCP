import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, httpsOrigin } from '../runtime/config.mjs';
import { OAuthClient } from '../runtime/auth.mjs';
import { OdcBridge } from '../runtime/bridge.mjs';
import { Catalog } from '../runtime/catalog.mjs';
import { redact } from '../runtime/errors.mjs';
import { mockFetch, testConfig, sampleRequest } from './helpers.mjs';

const readId = 'asset-repository-api-v1:get:/assets';
const catalog = new Catalog();

test('catalog works without credentials and access is reported unverified', async () => {
  const mock = mockFetch();
  const bridge = new OdcBridge({ catalog, config: readConfig({}), fetchImpl: mock.fetchImpl });
  assert.equal(bridge.status().auth.configured, false);
  assert.equal(bridge.status().auth.accessVerified, false);
  const output = await bridge.execute(readId);
  assert.equal(output.error.code, 'AUTH_NOT_CONFIGURED');
  assert.equal(mock.calls.length, 0);
});

test('OAuth discovery, client_secret_post, token cache/expiry and single-flight acquisition', async () => {
  const mock = mockFetch();
  let now = 1_000_000;
  const auth = new OAuthClient(testConfig(), mock.fetchImpl, () => now);
  const tokens = await Promise.all(Array.from({ length: 10 }, () => auth.getToken()));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(mock.tokenCount, 1);
  const request = mock.calls.find(c => c.method === 'POST');
  assert.equal(new URLSearchParams(request.body).get('grant_type'), 'client_credentials');
  assert.equal(new URLSearchParams(request.body).get('client_secret'), 'mock-secret-not-real');
  now += 3_601_000;
  assert.equal(await auth.getToken(), 'mock-access-token-2');
  assert.equal(mock.calls.filter(c => c.url.includes('.well-known')).length, 1);
});

test('read 401 refreshes once; 403 and 429 are not retried', async () => {
  let reads = 0;
  const mock = mockFetch({ apiHandler: () => ++reads === 1 ? Response.json({}, { status: 401 }) : Response.json({ ok: true }) });
  const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  assert.equal((await bridge.execute(readId)).ok, true);
  assert.equal(mock.tokenCount, 2);
  assert.equal(reads, 2);
  for (const status of [403, 429]) {
    const m = mockFetch({ apiHandler: () => Response.json({}, { status, headers: { 'retry-after': '10' } }) });
    const b = new OdcBridge({ catalog, config: testConfig(), fetchImpl: m.fetchImpl });
    const result = await b.execute(readId);
    assert.equal(result.status, status);
    assert.equal(m.calls.length, 3);
    if (status === 429) assert.equal(result.retryAfter, '10');
  }
});

test('writes denied by default; exact allowlist works but 401 never replays a write', async () => {
  const op = [...catalog.operations.values()].find(o => !o.readOnly);
  const input = sampleRequest(catalog.apis.get(op.apiId), op);
  const mock = mockFetch({ apiHandler: () => Response.json({}, { status: 401 }) });
  const blocked = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  assert.equal((await blocked.execute(op.id, input, 'write')).error.code, 'WRITE_BLOCKED');
  assert.equal((await blocked.execute(op.id, input, 'read')).error.code, 'WRITE_BLOCKED');
  assert.equal(mock.calls.length, 0);
  const allowed = new OdcBridge({ catalog, config: testConfig({ allowedWriteOperations: new Set([op.id]) }), fetchImpl: mock.fetchImpl });
  const result = await allowed.execute(op.id, input, 'write');
  assert.equal(result.status, 401);
  assert.equal(mock.tokenCount, 1);
  assert.equal(mock.calls.length, 3);
  assert.match(result.error.retrySafety, /reconciled/);
});

test('reject insecure origins and discovery endpoint exfiltration', async () => {
  for (const origin of ['http://tenant.test', 'https://user:pass@tenant.test', 'https://tenant.test/path', 'https://tenant.test?x=1']) {
    assert.throws(() => httpsOrigin(origin), { code: 'CONFIGURATION_INVALID' });
  }
  const mock = mockFetch({ discoveryHandler: () => Response.json({ token_endpoint: 'https://evil.test/token' }) });
  const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  assert.equal((await bridge.execute(readId)).error.code, 'AUTH_AUTHORITY_BLOCKED');
  assert.equal(mock.calls.length, 1);
});

test('redirects blocked on discovery, token and API without following locations', async () => {
  for (const stage of ['discoveryHandler', 'tokenHandler', 'apiHandler']) {
    const mock = mockFetch({ [stage]: () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }) });
    const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
    assert.equal((await bridge.execute(readId)).error.code, 'REDIRECT_BLOCKED');
    assert.ok(mock.calls.every(c => !c.url.includes('evil')));
  }
});

test('redaction includes known secrets and isSecret configuration values', async () => {
  const mock = mockFetch({ apiHandler: () => Response.json({
    access_token: 'other-token', authorization: 'anything', nested: { clientSecret: 'another-secret' },
    echo: 'mock-secret-not-real mock-access-token-1',
    configs: [{ isSecret: true, value: 'secret-one', defaultValue: 'secret-two', deployedValue: 'secret-three' },
      { isSecret: false, value: 'visible' }],
  }) });
  const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  const output = await bridge.execute(readId);
  const encoded = JSON.stringify(output);
  for (const secret of ['other-token', 'anything', 'another-secret', 'mock-secret-not-real', 'mock-access-token-1', 'secret-one', 'secret-two', 'secret-three']) assert.ok(!encoded.includes(secret));
  assert.equal(output.data.configs[1].value, 'visible');
  assert.equal(output.data.configs[0].isSecret, true);
  assert.equal(redact({ apiKey: 'private', connectionString: 'private' }).apiKey, '[REDACTED]');
  const signed = redact({ url: 'https://files.example.test/file?X-Amz-Signature=private-signed-capability&x=1' }).url;
  assert.ok(!signed.includes('private-signed-capability'));
  assert.equal(new URL(signed).searchParams.get('x'), '1');
  assert.equal(redact({ nested: ['Bearer xyz.abc.123'] }).nested[0], 'Bearer [REDACTED]');
});

test('gateway tokens, activation codes, authorization codes, CSRF values, license keys and serials are redacted; keys and version hashes are not', () => {
  // The private gateway activation/key-rotation answer and the organization entitlements (synthetic shapes of the
  // integrator's fixtures public-private-gateway.json and public-subscription-organization.json).
  const gateway = redact({ authToken: 'SECRET-GATEWAY', gatewayToken: 'SECRET-G2', clientToken: 'SECRET-G3' });
  const entitlements = redact({ edition: 'Synthetic', activationCode: 'SECRET-ACTIVATION', addons: [], entitlements: [{ id: 'e1', value: '100', unit: 'users' }] });
  const other = redact({ AuthCode: 'SECRET-AUTHCODE', authorization_code: 'SECRET-OAUTH', 'x-csrftoken': 'SECRET-CSRF', csrfToken: 'SECRET-CSRF2',
    licenseKey: 'SECRET-LICENSE', serial: 'SECRET-SERIAL', SerialNumber: 'SECRET-SERIAL2', signingKey: 'SECRET-SIGN', passphrase: 'SECRET-PHRASE', recoveryCodes: ['SECRET-RC'] });
  assert.doesNotMatch(JSON.stringify([gateway, entitlements, other]), /SECRET-/);
  assert.equal(entitlements.edition, 'Synthetic'); assert.equal(entitlements.entitlements[0].value, '100');
  // Not secrets: the module version hash every screenservice sends back, catalog keys, and the Studio token's expiry date.
  const kept = { versionToken: 'v-hash', assetKey: 'k1', environmentKey: 'k2', applicationKey: 'k3', operationKey: 'k4', key: 'k5', tokenValidUntil: '2026-10-02T00:00:00Z',
    IsPrimaryKey: true, ErrorCode: 'E1', mobileVersionCode: 7, serialized: 'x', StageKey: 'k6' };
  assert.deepEqual(redact(kept), kept);
});

test('auth failure bodies never expose secrets', async () => {
  const mock = mockFetch({ tokenHandler: () => Response.json({ error_description: 'mock-secret-not-real malicious-credential' }, { status: 400 }) });
  const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  const result = await bridge.execute(readId);
  assert.equal(result.error.code, 'AUTH_FAILED');
  assert.ok(!JSON.stringify(result).includes('malicious-credential'));
});

test('malformed token responses fail closed and read retries are bounded', async () => {
  for (const tokenResponse of [
    { access_token: 'x', token_type: 'Bearer' },
    { access_token: 'x', token_type: 'Other', expires_in: 3600 },
    { access_token: 'x\r\ninjected', token_type: 'Bearer', expires_in: 3600 },
  ]) {
    const mock = mockFetch({ tokenHandler: () => Response.json(tokenResponse) });
    const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
    assert.equal((await bridge.execute(readId)).error.code, 'AUTH_RESPONSE_INVALID');
    assert.equal(mock.calls.length, 2);
  }
  const mock = mockFetch({ apiHandler: () => Response.json({}, { status: 401 }) });
  const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  assert.equal((await bridge.execute(readId)).status, 401);
  assert.equal(mock.tokenCount, 2);
  assert.equal(mock.calls.length, 5);
});

test('unknown/read operation IDs cannot be configured as permitted mutations', () => {
  for (const id of ['*', 'not-real', readId]) assert.throws(() => new OdcBridge({ catalog,
    config: testConfig({ allowedWriteOperations: new Set([id]) }),
  }), { code: 'CONFIGURATION_INVALID' });
});

test('non-JSON response summarized and oversized response refused', async () => {
  const mock = mockFetch({ apiHandler: () => new Response('private-file-content', { headers: { 'content-type': 'application/octet-stream' } }) });
  const b = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl });
  const output = await b.execute(readId);
  assert.equal(output.data.contentOmitted, true);
  assert.ok(!JSON.stringify(output).includes('private-file-content'));
  const oversized = mockFetch({ apiHandler: () => new Response('x'.repeat(1025)) });
  const limited = new OdcBridge({ catalog, config: testConfig({ maxResponseBytes: 1024 }), fetchImpl: oversized.fetchImpl });
  assert.equal((await limited.execute(readId)).error.code, 'RESPONSE_TOO_LARGE');
});

test('local per-domain rate budget prevents extra requests', async () => {
  const mock = mockFetch();
  const bridge = new OdcBridge({ catalog, config: testConfig(), fetchImpl: mock.fetchImpl, now: () => 1_000_000 });
  const op = [...catalog.operations.values()].find(o => o.apiId === 'environment-configurations-api-v1' && o.readOnly);
  const input = sampleRequest(catalog.apis.get(op.apiId), op);
  for (let i = 0; i < 10; i++) assert.equal((await bridge.execute(op.id, input)).ok, true);
  assert.equal((await bridge.execute(op.id, input)).error.code, 'LOCAL_RATE_LIMIT');
  assert.equal(mock.calls.length, 12);
});

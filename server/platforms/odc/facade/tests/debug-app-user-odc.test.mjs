import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { authenticateOdcAppUser, odcAppUserBinding } from '../debug-app-user-odc.mjs';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
// Port D7: us-east-2 user pools wait for cognitoRegionSupported in portal/runtime/cognito-login.mjs.
const usEast2Pending = foreignPendingReason('cognito-region');

// Synthetic runtime/broker responses; no tenant traffic or real credentials are used.
const origin = 'https://example-dev.outsystems.app', app = 'ExampleApp', time = 2000000000000;
const binding = { lane: 'odc', runtimeUrl: origin + '/' + app + '/', app, sessionId: 'bc553b4b-a033-40d9-8d60-1e5abfc75caa' };
const credentials = { username: 'app-user@example.test', password: 'SYNTHETIC_PRIVATE_PASSWORD' };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', alg: 'RS256' };
const issuer = origin + '/identity/realms/development';
const jwt = claims => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), signed = header + '.' + payload;
  return signed + '.' + sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url');
};
const safeError = code => error => error.code === code && !error.message.includes(credentials.password)
  && !error.message.includes(credentials.username) && !error.message.includes('private transport diagnostic');

function fixture(options = {}) {
  const calls = [], signins = [];
  let authorization = null, tokenForm = null;
  const discovery = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
    jwks_uri: issuer + '/certs', code_challenge_methods_supported: ['S256'], response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'], ...options.discovery };
  const response = (value, status = 200, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
  const fetchImpl = async (value, request) => {
    const url = new URL(value); calls.push({ url: value, request });
    assert.equal(request.redirect, 'manual'); assert.equal(request.credentials, 'omit');
    if (options.networkFailure) throw new Error('private transport diagnostic ' + credentials.password);
    if (url.pathname === options.failurePath) return response(options.failureBody ?? 'private native diagnostic ' + credentials.password, options.failureStatus ?? 503);
    if (url.pathname === '/' + app + '/moduleservices/clientsettingsinfo') return response(options.settings ?? { clientSettingsHash: 'synthetic-settings-hash', clientSettings: {} });
    if (url.pathname === '/' + app + '/moduleservices/auth/configs') return response(options.metadata ?? { authConfigurations: [
      { key: 'synthetic-provider', type: 'cognito', kc_hint: 'cognito-app', configs: {
        poolId: 'us-east-1_AppPool', amplifyClientId: 'AppClient123', authFlow: 'USER_SRP_AUTH',
      } },
    ] });
    if (url.pathname === '/identity/.well-known/openid-configuration') return response(discovery);
    if (url.pathname === '/identity/realms/development/authorize') {
      authorization = url;
      const login = new URL((options.loginOrigin ?? origin) + '/authentication/login');
      login.search = new URLSearchParams({ state: 'synthetic-broker-state', client_id: 'AppClient123',
        redirect_uri: (options.resumeOrigin ?? origin) + '/identity/broker/cognito/endpoint' });
      if (options.missingBrokerParameters) login.search = '';
      return response('', 302, { Location: login.href, 'Set-Cookie': 'broker=SYNTHETIC_COOKIE; Secure; HttpOnly; Path=/identity' });
    }
    if (url.pathname === '/authentication/login') return response('Native login shell; no page JavaScript is executed.');
    if (url.origin === `https://cognito-idp.${options.region ?? 'us-east-1'}.amazonaws.com`) return response({});
    if (url.pathname === '/identityapi/v1alpha1/oidc/store-token') {
      assert.deepEqual(JSON.parse(request.body), { clientId: 'AppClient123', idToken: 'SYNTHETIC_COGNITO_ID',
        accessToken: 'SYNTHETIC_COGNITO_ACCESS', refreshToken: 'SYNTHETIC_COGNITO_REFRESH' });
      return response(options.storeTokenBody ?? { authCode: 'synthetic-cognito-code' }, options.storeTokenStatus ?? 200);
    }
    if (url.pathname === '/identity/broker/cognito/endpoint') {
      assert.equal(url.searchParams.get('state'), 'synthetic-broker-state');
      assert.equal(url.searchParams.get('code'), 'synthetic-cognito-code');
      const complete = new URL(origin + '/identity');
      complete.search = new URLSearchParams({ code: 'synthetic-platform-code', state: options.badState ? 'wrong-state' : authorization.searchParams.get('state'), iss: issuer });
      return response('', 302, { Location: complete.href });
    }
    if (url.pathname === '/identity/realms/development/token') {
      assert.equal(request.method, 'POST'); assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
      tokenForm = new URLSearchParams(request.body);
      const verifier = tokenForm.get('code_verifier');
      assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
      assert.equal(tokenForm.get('grant_type'), 'authorization_code'); assert.equal(tokenForm.get('client_id'), 'client_runtime');
      assert.equal(tokenForm.get('redirect_uri'), origin + '/identity'); assert.equal(tokenForm.get('code'), 'synthetic-platform-code');
      const common = { iss: issuer, sub: 'synthetic-identity-subject', exp: time / 1000 + 300, iat: time / 1000 };
      const accessClaims = { ...common, aud: ['account'], azp: 'client_runtime', scope: 'openid', ...options.accessClaims };
      const idClaims = { ...common, aud: 'client_runtime', nonce: options.badNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce'), ...options.idClaims };
      let accessToken = jwt(accessClaims);
      if (options.badSignature) accessToken = accessToken.slice(0, -12) + 'AAAAAAAAAAAA';
      return response({ token_type: 'Bearer', access_token: accessToken, id_token: jwt(idClaims), refresh_token: 'SYNTHETIC_PLATFORM_REFRESH', expires_in: 300 });
    }
    if (url.pathname === '/identity/realms/development/certs') return response({ keys: [jwk] });
    if (url.pathname === '/api/user-information/v1/profiles/me') {
      assert.match(request.headers.Authorization, /^Bearer [A-Za-z0-9_.-]+$/);
      assert.equal(url.searchParams.get('embed'), 'UserIdentityProviders');
      return response({ id: 'synthetic-platform-user', email: credentials.username, name: 'Example User' });
    }
    if (url.pathname === '/api/user-information/v1/claims') {
      if (options.claimsDenied) return response('private native role diagnostic', 403);
      return response({ claims: options.roles ?? ['role-key-one', 'role-key-two', 'role-key-one'] });
    }
    assert.fail('Unexpected mock request to ' + url.pathname);
  };
  const cognito = async args => {
    signins.push(args);
    if (options.cognitoError) throw options.cognitoError;
    await args.request(`https://cognito-idp.${args.config.Region}.amazonaws.com/`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: { AuthFlow: 'USER_SRP_AUTH', ClientId: args.config.AmplifyClientKey, AuthParameters: { USERNAME: args.username, SRP_A: 'synthetic-proof' } } });
    return { IdToken: 'SYNTHETIC_COGNITO_ID', AccessToken: 'SYNTHETIC_COGNITO_ACCESS', RefreshToken: 'SYNTHETIC_COGNITO_REFRESH' };
  };
  return { calls, signins, get authorization() { return authorization; }, get tokenForm() { return tokenForm; },
    run: (target = binding) => authenticateOdcAppUser({ binding: target, credentials, fetchImpl, cognito, now: () => time, observer: options.observer }) };
}

test('app sign-in uses runtime metadata, SRP, broker exchange and PKCE; protected profile and claims prove the app user', async () => {
  const mock = fixture(), result = await mock.run();
  assert.deepEqual(result.binding, { ...binding, sessionId: binding.sessionId.replace(/-/g, '') });
  assert.equal(result.userKey, 'synthetic-platform-user'); assert.deepEqual(result.roles, ['role-key-one', 'role-key-two']);
  assert.equal(result.expiresAt, new Date(time + 300000).toISOString());
  assert.match(result.accessToken, /^[A-Za-z0-9_.-]+$/); assert.equal(result.refreshToken, 'SYNTHETIC_PLATFORM_REFRESH');
  assert.equal(mock.signins.length, 1);
  assert.deepEqual(mock.signins[0].config, { Region: 'us-east-1', PoolKey: 'us-east-1_AppPool', AmplifyClientKey: 'AppClient123', AuthFlow: 'USER_SRP_AUTH' });
  assert.equal(mock.signins[0].username, credentials.username); assert.equal(mock.signins[0].password, credentials.password);
  assert.equal(mock.authorization.searchParams.get('client_id'), 'client_runtime'); assert.equal(mock.authorization.searchParams.get('kc_idp_hint'), 'cognito-app');
  assert.equal(mock.authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(mock.authorization.searchParams.get('scope'), 'openid');
  assert.equal(JSON.stringify(mock.calls).includes(credentials.password), false);
  assert.ok(mock.calls.every(call => new URL(call.url).origin === origin || new URL(call.url).origin === 'https://cognito-idp.us-east-1.amazonaws.com'));
  assert.equal(mock.calls.find(call => new URL(call.url).origin.includes('amazonaws')).request.headers.Cookie, undefined);
});

test('target binding rejects other lanes, mismatched applications and embedded URL credentials before a request', async () => {
  for (const change of [{ lane: 'o11' }, { app: 'OtherApp' }, { runtimeUrl: 'https://private:password@example.test/ExampleApp/' }, { sessionId: 'invalid' }]) {
    assert.throws(() => odcAppUserBinding({ ...binding, ...change }), safeError('debug_app_auth_scope_mismatch'));
  }
});

test('native N32/D36 debug session IDs normalize to N32 and preserve the exact producer identity', async () => {
  const producer = { ...binding, module: 'ExampleServices', moduleKey: 'AbCdefghijkLmnopqrstu+' };
  assert.equal(producer.moduleKey.length, 22);
  const normalized = { ...producer, sessionId: producer.sessionId.replace(/-/g, '') };
  assert.deepEqual(odcAppUserBinding(producer), normalized);
  assert.deepEqual(odcAppUserBinding(normalized), normalized);
  const result = await fixture().run(producer);
  assert.deepEqual(result.binding, normalized);
  for (const change of [{ moduleKey: 'bad' }, { module: '' }, { moduleKey: undefined }, { module: undefined }]) {
    assert.throws(() => odcAppUserBinding({ ...producer, ...change }), safeError('debug_app_auth_scope_mismatch'));
  }
});

test('unsupported, ambiguous, or incomplete app providers stop before requesting credentials from Cognito', async () => {
  const valid = { key: 'provider', type: 'cognito', configs: { poolId: 'us-east-1_Test', amplifyClientId: 'Client123' } };
  for (const authConfigurations of [[{ ...valid, type: 'saml' }], [valid, valid], [{ ...valid, configs: {} }],
    [{ ...valid, configs: { ...valid.configs, authFlow: 'USER_PASSWORD_AUTH' } }],
    [{ ...valid, configs: { ...valid.configs, region: 'us-east-2' } }],
    [{ ...valid, configs: { ...valid.configs, poolId: 'eu-west-1_Test' } }]]) {
    const mock = fixture({ metadata: { authConfigurations } });
    await assert.rejects(mock.run(), safeError('debug_app_auth_provider_unsupported')); assert.equal(mock.signins.length, 0);
  }
});

test('personal app metadata selects us-east-2 and preserves the original broker and authenticated user', { skip: usEast2Pending }, async () => {
  const mock = fixture({ region: 'us-east-2', metadata: { authConfigurations: [{ type: 'cognito', kc_hint: 'os-builtin',
    configs: { region: 'us-east-2', poolId: 'us-east-2_AppPool', amplifyClientId: 'AppClient123', authFlow: 'USER_SRP_AUTH' } }] } });
  const result = await mock.run();
  assert.equal(mock.signins[0].config.Region, 'us-east-2');
  assert.equal(mock.authorization.searchParams.get('kc_idp_hint'), 'os-builtin');
  assert.equal(result.userKey, 'synthetic-platform-user');
  assert.deepEqual(result.roles, ['role-key-one', 'role-key-two']);
  assert.ok(mock.calls.every(call => [origin, 'https://cognito-idp.us-east-2.amazonaws.com'].includes(new URL(call.url).origin)));
});

test('published settings provider selection is authoritative, absent-only legacy and private without extra sign-in', { skip: usEast2Pending }, async () => {
  const provider = { type: 'cognito', kc_hint: 'os-builtin', configs: {
    poolId: 'us-east-2_AppPool', amplifyClientId: 'AppClient123', authFlow: 'USER_SRP_AUTH', tenantId: 'synthetic-tenant',
  } };
  const events = [], settings = { clientSettingsHash: 'synthetic-settings-hash', clientSettings: { IdentityProviders: JSON.stringify([provider]) } };
  const selected = fixture({ settings, region: 'us-east-2', metadata: { authConfigurations: [] }, observer: event => events.push(event) });
  const session = await selected.run();
  assert.equal(session.userKey, 'synthetic-platform-user');
  assert.deepEqual(selected.signins[0].config, { Region: 'us-east-2', PoolKey: 'us-east-2_AppPool', AmplifyClientKey: 'AppClient123', AuthFlow: 'USER_SRP_AUTH' });
  assert.equal(selected.signins.length, 1);
  assert.equal(selected.signins[0].username, credentials.username); assert.equal(selected.signins[0].password, credentials.password);
  assert.equal(selected.authorization.searchParams.get('kc_idp_hint'), 'os-builtin');
  assert.equal(selected.calls.filter(call => new URL(call.url).pathname.endsWith('/clientsettingsinfo')).length, 1);
  assert.equal(selected.calls.some(call => new URL(call.url).pathname.endsWith('/auth/configs')), false);
  assert.deepEqual(events.find(event => event.event === 'http'), { event: 'http', stage: 'runtime-config', endpoint: 'runtime_client_settings', method: 'GET', status: 200 });
  for (const privateText of [credentials.username, credentials.password, provider.configs.poolId, provider.configs.amplifyClientId, provider.configs.tenantId]) {
    assert.equal(JSON.stringify(events).includes(privateText), false);
  }
  for (const IdentityProviders of [undefined, null, '']) {
    const legacy = fixture({ settings: { clientSettings: { IdentityProviders } } });
    await legacy.run(); assert.equal(legacy.signins.length, 1);
    assert.equal(legacy.calls.filter(call => new URL(call.url).pathname.endsWith('/auth/configs')).length, 1);
  }
  for (const IdentityProviders of ['private malformed ' + credentials.password, '{}', '[]', '[null]', [provider], JSON.stringify([provider, provider])]) {
    const rejected = fixture({ settings: { clientSettings: { IdentityProviders } } });
    await assert.rejects(rejected.run(), safeError('debug_app_auth_provider_unsupported'));
    assert.equal(rejected.signins.length, 0); assert.equal(rejected.calls.length, 1);
  }
});

test('identity discovery and redirects cannot send app credentials to another origin', async () => {
  for (const options of [{ discovery: { authorization_endpoint: 'https://other.invalid/authorize' } },
    { discovery: { token_endpoint: 'https://other.invalid/token' } }, { discovery: { jwks_uri: 'https://other.invalid/keys' } },
    { loginOrigin: 'https://other.invalid' }, { resumeOrigin: 'https://other.invalid' }]) {
    const mock = fixture(options);
    await assert.rejects(mock.run(), safeError('debug_app_auth_scope_mismatch'));
    assert.equal(mock.signins.length, 0); assert.ok(mock.calls.every(call => new URL(call.url).origin === origin));
  }
});

test('wrong credentials and MFA stop without token exchange, profile reads or inferred roles', async () => {
  for (const [nativeCode, expected] of [['PORTAL_LOGIN_REJECTED', 'debug_app_auth_rejected'], ['PORTAL_LOGIN_CHALLENGE_REQUIRED', 'debug_app_auth_challenge_required']]) {
    const error = Object.assign(new Error('private transport diagnostic ' + credentials.password), { code: nativeCode });
    const mock = fixture({ cognitoError: error });
    await assert.rejects(mock.run(), safeError(expected));
    assert.equal(mock.signins.length, 1);
    assert.ok(mock.calls.every(call => !/store-token|\/token$|user-information/.test(new URL(call.url).pathname)));
  }
});

test('the final callback must preserve the original security state before exchanging its authorization code', async () => {
  const mock = fixture({ badState: true });
  await assert.rejects(mock.run(), safeError('debug_app_auth_scope_mismatch'));
  assert.equal(mock.tokenForm, null);
});

for (const [name, options, code] of [
  ['nonce', { badNonce: true }, 'debug_app_auth_scope_mismatch'],
  ['issuer', { accessClaims: { iss: 'https://other.invalid/issuer' } }, 'debug_app_auth_scope_mismatch'],
  ['audience', { idClaims: { aud: 'portal-client' } }, 'debug_app_auth_scope_mismatch'],
  ['scope', { accessClaims: { scope: 'portal' } }, 'debug_app_auth_scope_mismatch'],
  ['signature', { badSignature: true }, 'debug_app_auth_scope_mismatch'],
  ['expiry', { accessClaims: { exp: time / 1000 - 1 } }, 'debug_app_auth_expired'],
  ['not-before', { accessClaims: { nbf: time / 1000 + 300 } }, 'debug_app_auth_expired'],
]) {
  test(`an invalid platform token ${name} cannot establish an app-user context`, async () => {
    const mock = fixture(options);
    await assert.rejects(mock.run(), safeError(code));
    assert.ok(mock.calls.every(call => !new URL(call.url).pathname.startsWith('/api/user-information')));
  });
}

test('role API refusal rejects authentication instead of inventing permissions', async () => {
  const mock = fixture({ claimsDenied: true });
  await assert.rejects(mock.run(), safeError('debug_app_auth_rejected'));
});

test('network errors remain generic and are not retried', async () => {
  const mock = fixture({ networkFailure: true });
  await assert.rejects(mock.run(), safeError('debug_app_auth_unavailable'));
  assert.equal(mock.calls.length, 1); assert.equal(mock.signins.length, 0);
});

test('the published provider shape allows one os-builtin Cognito provider alongside an external provider', async () => {
  const mock = fixture({ metadata: { authConfigurations: [
    { key: 'synthetic-builtin', type: 'cognito', kc_hint: 'os-builtin', configs: { region: 'us-east-1',
      amplifyClientId: 'AppClient123', poolId: 'us-east-1_AppPool', tenantId: 'synthetic-tenant',
      passwordPolicy: { minLength: 12 }, authFlow: 'USER_SRP_AUTH' } },
    { key: 'synthetic-external', type: 'AzureADB2C', kc_hint: 'synthetic-external', configs: { clientId: 'external-client', clientSecret: 'SYNTHETIC_EXTERNAL_SECRET' } },
  ] } });
  const session = await mock.run();
  assert.equal(session.userKey, 'synthetic-platform-user');
  assert.equal(mock.authorization.searchParams.get('kc_idp_hint'), 'os-builtin');
  assert.equal(mock.signins.length, 1); assert.equal(mock.signins[0].config.AmplifyClientKey, 'AppClient123');
});

test('private observation records fixed stages and bounded HTTP facts without authentication data', async () => {
  const events = [], mock = fixture({ observer: event => { assert.ok(Object.isFrozen(event)); events.push(event); } });
  await mock.run();
  assert.deepEqual(events.filter(event => event.event === 'stage').map(event => event.stage), [
    'runtime-config', 'identity-discovery', 'builtin-broker', 'srp-signin', 'broker-store-token', 'broker-resume',
    'platform-token', 'platform-jwks', 'token-validation', 'user-profile', 'user-roles', 'session-complete',
  ]);
  assert.deepEqual(events.filter(event => event.event === 'http').map(event => event.endpoint), [
    'runtime_client_settings', 'runtime_auth_configs', 'identity_discovery', 'broker_authorize', 'broker_redirect', 'cognito_srp', 'token_store',
    'broker_resume', 'platform_token', 'platform_jwks', 'user_profile', 'user_roles',
  ]);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), event.event === 'stage' ? ['event', 'stage'] : ['endpoint', 'event', 'method', 'stage', 'status']);
    if (event.event === 'http') { assert.ok(Number.isInteger(event.status)); assert.ok(event.status >= 100 && event.status <= 599); }
  }
  const diagnostic = JSON.stringify(events);
  for (const secret of [credentials.username, credentials.password, origin, 'synthetic-broker-state', 'SYNTHETIC_COOKIE',
    'synthetic-cognito-code', 'SYNTHETIC_COGNITO_ID', 'SYNTHETIC_PLATFORM_REFRESH', mock.authorization.searchParams.get('nonce'), mock.tokenForm.get('code_verifier')]) {
    assert.equal(diagnostic.includes(secret), false);
  }
});

test('identical unsupported codes identify the failing public response, broker guard or later token response privately', async () => {
  for (const [options, stage, detail] of [
    [{ failurePath: '/' + app + '/moduleservices/auth/configs', failureStatus: 503 }, 'runtime-config', 'http-status'],
    [{ failurePath: '/identity/.well-known/openid-configuration', failureStatus: 200 }, 'identity-discovery', 'json-response'],
    [{ missingBrokerParameters: true }, 'builtin-broker', 'broker-parameters'],
    [{ failurePath: '/identity/realms/development/token', failureStatus: 400 }, 'platform-token', 'http-status'],
  ]) {
    const events = [], mock = fixture({ ...options, observer: event => events.push(event) });
    await assert.rejects(mock.run(), safeError('debug_app_auth_provider_unsupported'));
    assert.deepEqual(events.at(-1), { event: 'failure', stage, detail, code: 'debug_app_auth_provider_unsupported' });
    const diagnostic = JSON.stringify(events);
    assert.equal(diagnostic.includes(credentials.password), false); assert.equal(diagnostic.includes(credentials.username), false);
    assert.equal(diagnostic.includes('private native diagnostic'), false); assert.equal(diagnostic.includes('https://'), false);
    assert.ok(mock.calls.every(call => mock.calls.filter(other => other.url === call.url).length === 1));
    assert.ok(mock.calls.every(call => !new URL(call.url).pathname.startsWith('/api/user-information')));
  }
});

test('broken private observers cannot change sign-in or leak their own native errors', async () => {
  for (const observer of [() => { throw new Error('private diagnostic ' + credentials.password); },
    () => Promise.reject(new Error('private diagnostic ' + credentials.password))]) {
    const mock = fixture({ observer });
    const session = await mock.run(); assert.equal(session.userKey, 'synthetic-platform-user');
  }
});

test('the native store-token creation reply accepts 201 with authCode and preserves 200 support', async () => {
  for (const storeTokenStatus of [200, 201]) {
    const events = [], mock = fixture({ storeTokenStatus, storeTokenBody: { authCode: 'synthetic-cognito-code' }, observer: event => events.push(event) });
    const session = await mock.run();
    assert.equal(session.userKey, 'synthetic-platform-user');
    assert.deepEqual(session.roles, ['role-key-one', 'role-key-two']);
    assert.equal(mock.calls.filter(call => new URL(call.url).pathname === '/identityapi/v1alpha1/oidc/store-token').length, 1);
    assert.deepEqual(events.find(event => event.endpoint === 'token_store'), {
      event: 'http', stage: 'broker-store-token', endpoint: 'token_store', method: 'POST', status: storeTokenStatus,
    });
    assert.ok(mock.tokenForm); assert.equal(events.at(-1).stage, 'session-complete');
  }
});

test('store-token rejects unsupported success statuses and invalid creation bodies without retry or broker resume', async () => {
  for (const [options, code] of [
    [{ storeTokenStatus: 202 }, 'debug_app_auth_provider_unsupported'],
    [{ storeTokenStatus: 206 }, 'debug_app_auth_provider_unsupported'],
    [{ storeTokenStatus: 201, storeTokenBody: 'private diagnostic ' + credentials.password }, 'debug_app_auth_provider_unsupported'],
    [{ storeTokenStatus: 201, storeTokenBody: {} }, 'debug_app_auth_rejected'],
    [{ storeTokenStatus: 201, storeTokenBody: { authCode: '' } }, 'debug_app_auth_rejected'],
    [{ storeTokenStatus: 201, storeTokenBody: { authCode: 123 } }, 'debug_app_auth_rejected'],
  ]) {
    const events = [], mock = fixture({ ...options, observer: event => events.push(event) });
    await assert.rejects(mock.run(), safeError(code));
    assert.equal(mock.calls.filter(call => new URL(call.url).pathname === '/identityapi/v1alpha1/oidc/store-token').length, 1);
    assert.equal(events.at(-1).stage, 'broker-store-token');
    assert.equal(events.at(-1).code, code); assert.equal(mock.tokenForm, null);
    assert.ok(mock.calls.every(call => !/\/broker\/cognito\/endpoint|user-information/.test(new URL(call.url).pathname)));
    assert.equal(JSON.stringify(events).includes(credentials.password), false);
  }
});

test('status 201 acceptance is confined to store-token; discovery, platform tokens and user information still require 200', async () => {
  for (const [failurePath, failureBody] of [
    ['/identity/.well-known/openid-configuration', { issuer }],
    ['/identity/realms/development/token', { token_type: 'Bearer' }],
    ['/api/user-information/v1/profiles/me', { id: 'synthetic-platform-user' }],
    ['/api/user-information/v1/claims', { claims: [] }],
  ]) {
    const events = [], mock = fixture({ storeTokenStatus: 201, failurePath, failureBody, failureStatus: 201, observer: event => events.push(event) });
    await assert.rejects(mock.run(), safeError('debug_app_auth_provider_unsupported'));
    assert.equal(events.at(-1).detail, 'http-status');
    assert.equal(mock.calls.filter(call => new URL(call.url).pathname === failurePath).length, 1);
    assert.equal(events.some(event => event.stage === 'session-complete'), false);
  }
});

import { inspect } from 'node:util';
import { odcAppUserAnchor } from '../debug-app-user-odc.mjs';
test('the app-user identity anchor keeps userKey private and exists only for an authenticated, identity-matched ODC login', () => {
  const userKey = '9F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9', expiresAt = new Date(Date.now() + 60000).toISOString();
  const descriptor = { credentialRef: '11111111-2222-4333-8444-555555555555', binding: { ...odcAppUserBinding(binding), runtimeUrl: binding.runtimeUrl },
    expiresAt, state: 'authenticated', authenticated: true, userKey };
  const anchor = odcAppUserAnchor(descriptor, { authenticated: true, identityMatches: true });
  for (const view of [JSON.stringify(anchor), inspect(anchor, { showHidden: true, depth: 8 }), String(Object.keys(anchor)), JSON.stringify(Object.getOwnPropertyDescriptors(anchor))])
    assert.doesNotMatch(view, /9f1e2d3c|9F1E2D3C|A4B3C2D1E0F9/i);
  assert.equal(Object.isFrozen(anchor), true); assert.equal(anchor.kind, 'app-user');
  // The canonical lower-case userKey reaches only the sealing function, for the server runtime.
  let sealed; const token = anchor.seal(value => { sealed = value; return 'token'; }, { runtime: 'server' });
  assert.equal(token, 'token'); assert.equal(sealed.type, 'Scalar'); assert.equal(sealed.value, userKey.toLowerCase()); assert.deepEqual(sealed.children, []);
  assert.throws(() => anchor.seal(() => 'token', { runtime: 'client' }), /debug_app_auth_anchor_unavailable|anchor/);
  for (const [d, a] of [[{ ...descriptor, authenticated: false }, { authenticated: true, identityMatches: true }],
    [{ ...descriptor, state: 'credentials-entered' }, { authenticated: true, identityMatches: true }],
    [{ ...descriptor, userKey: 'not-a-guid' }, { authenticated: true, identityMatches: true }],
    [{ ...descriptor, userKey: undefined }, { authenticated: true, identityMatches: true }],
    [{ ...descriptor, binding: { ...descriptor.binding, lane: 'o11' } }, { authenticated: true, identityMatches: true }],
    [{ ...descriptor, expiresAt: new Date(Date.now() - 1000).toISOString() }, { authenticated: true, identityMatches: true }],
    [descriptor, { authenticated: true, identityMatches: false }], [descriptor, undefined], [undefined, { authenticated: true, identityMatches: true }]]) {
    assert.throws(() => odcAppUserAnchor(d, a), error => error.code === 'debug_app_auth_anchor_unavailable' && !/9f1e2d3c/i.test(error.message));
  }
});

// Port D7 (review B1): on the consolidation's cognito-login.mjs (no cognitoRegionSupported yet) the module still loads,
// us-east-1 apps sign in, and a us-east-2 app is refused with the typed provider code before any Cognito request,
// whether the pool comes from the legacy metadata or from the IdentityProviders setting. Runs only while pending.
test('until cognitoRegionSupported arrives, us-east-2 apps are refused typed before Cognito and us-east-1 settings stay authoritative',
  { skip: usEast2Pending ? false : 'cognitoRegionSupported delivered: the us-east-2 sign-in tests above cover this' }, async () => {
  const east2 = { type: 'cognito', kc_hint: 'os-builtin', configs: { region: 'us-east-2', poolId: 'us-east-2_AppPool', amplifyClientId: 'AppClient123', authFlow: 'USER_SRP_AUTH' } };
  for (const options of [{ metadata: { authConfigurations: [east2] } },
    { settings: { clientSettings: { IdentityProviders: JSON.stringify([{ ...east2, configs: { ...east2.configs, region: undefined } }]) } }, metadata: { authConfigurations: [] } }]) {
    const mock = fixture({ ...options, region: 'us-east-2' });
    await assert.rejects(mock.run(), safeError('debug_app_auth_provider_unsupported'));
    assert.equal(mock.signins.length, 0);
    assert.ok(mock.calls.every(call => new URL(call.url).origin === origin));
  }
  const provider = { type: 'cognito', kc_hint: 'os-builtin', configs: { poolId: 'us-east-1_AppPool', amplifyClientId: 'AppClient123', authFlow: 'USER_SRP_AUTH', tenantId: 'synthetic-tenant' } };
  const events = [], selected = fixture({ settings: { clientSettings: { IdentityProviders: JSON.stringify([provider]) } }, metadata: { authConfigurations: [] }, observer: event => events.push(event) });
  assert.equal((await selected.run()).userKey, 'synthetic-platform-user');
  assert.deepEqual(selected.signins[0].config, { Region: 'us-east-1', PoolKey: 'us-east-1_AppPool', AmplifyClientKey: 'AppClient123', AuthFlow: 'USER_SRP_AUTH' });
  assert.equal(selected.calls.some(call => new URL(call.url).pathname.endsWith('/auth/configs')), false);
  for (const privateText of [credentials.username, credentials.password, provider.configs.poolId, provider.configs.tenantId])
    assert.equal(JSON.stringify(events).includes(privateText), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Odc3PortalBroker, createOdc3HostContext } from '../runtime/odc3-context.mjs';
const origin = 'https://wrightflood.outsystems.dev';
const json = (data, headers = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const actions = {
  provider: '/authentication/screenservices/authentication/UnifiedAuthentication/login/DataActionGetProviders',
  complete: '/authentication/screenservices/authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect',
  list: '/connections/screenservices/connections/Connections/connections/DataActionGetProviders',
};
function fixture({ missing = false, challenge = false } = {}) {
  const credentialCalls = [], calls = [];
  const broker = new Odc3PortalBroker({ credentialProvider: async mode => {
    credentialCalls.push(mode);
    return mode === 'status' ? { available: !missing } : { available: true, username: 'PRIVATE_USERNAME', password: 'PRIVATE_PASSWORD' };
  }, fetchImpl: async (value, request) => {
    const url = new URL(value); calls.push({ url, request });
    if (url.pathname === actions.provider) {
      const login = new URL('https://id.outsystems.dev/login');
      login.searchParams.set('authorization_code', 'PRIVATE_AUTH_CODE'); login.searchParams.set('state', 'PRIVATE_STATE');
      login.searchParams.set('client_id', 'public-client'); login.searchParams.set('redirect_uri', origin + '/id/callback');
      return json({ data: { RedirectNowUrl: login.href } });
    }
    if (url.origin === 'https://cognito-idp.eu-west-1.amazonaws.com') {
      const input = JSON.parse(request.body);
      assert.equal(input.AuthParameters.PASSWORD, 'PRIVATE_PASSWORD');
      return json(challenge ? { ChallengeName: 'SOFTWARE_TOKEN_MFA' } : { AuthenticationResult: { AccessToken: 'PRIVATE_ACCESS', IdToken: 'PRIVATE_ID', RefreshToken: 'PRIVATE_REFRESH' } });
    }
    if (url.origin === 'https://id.outsystems.dev' && url.pathname === '/v1/storage') return json({ ok: true });
    if (url.pathname === '/id/callback') return new Response(null, { status: 302, headers: { Location: origin + '/authentication/redirect?code=PRIVATE_TENANT_CODE&state=PRIVATE_TENANT_STATE' } });
    if (url.pathname === actions.complete) return json({ data: {} }, { 'set-cookie': 'tenant_session=PRIVATE_SESSION; Path=/; Secure; HttpOnly' });
    if (url.pathname === actions.list) {
      assert.match(request.headers.Cookie, /tenant_session=PRIVATE_SESSION/);
      return json({ data: { Providers: [{ Id: 'mssql', Label: 'SQL Server' }] } });
    }
    return json({ data: { Logs: [{ LogId: 'log', Message: 'PRIVATE_PASSWORD PRIVATE_ACCESS PRIVATE_SESSION' }] } });
  } });
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'current-module', apiVersion: 'current-api', action, view });
  return { broker, calls, credentialCalls };
}

test('ODC3 host initializes without login, network or secret read; missing credential gives a private bootstrap action', async () => {
  const { broker, calls, credentialCalls } = fixture({ missing: true });
  const context = await createOdc3HostContext({ env: {}, broker });
  assert.deepEqual(credentialCalls, ['status']); assert.equal(calls.length, 0);
  assert.equal(context.status().authenticated, false);
  const result = await context.authenticate();
  assert.equal(result.error.code, 'PORTAL_AUTH_REQUIRED');
  assert.match(result.error.operatorAction, /Mode bootstrap/);
  assert.equal(credentialCalls.includes('read'), false); assert.equal(calls.length, 0);
  await assert.rejects(createOdc3HostContext({ env: { ODC_PORTAL_ORIGIN: 'https://other.example' }, broker }), error => error.code === 'PORTAL_TARGET_INVALID');
});

test('managed login completes full mocked session flow, confirms protected read and redacts its own secrets', async () => {
  const { broker, calls } = fixture();
  await broker.initialize();
  const login = await broker.authenticate();
  assert.equal(login.ok, true); assert.equal(login.session.authenticated, true);
  assert.equal(login.session.lastSuccessfulRead.operation, 'connections.providers');
  assert.equal(calls.filter(call => call.url.origin.includes('cognito')).length, 1);
  const output = await broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId: 'monitoring.detail',
    module: 'monitoring', view: 'logs.log', action: 'monitoring/logs/log/DataActionGetLogById', inputParameters: {}, screenVariables: {} });
  assert.equal(JSON.stringify(output).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(login).includes('PRIVATE_'), false);
});

test('MFA challenge is explicit and never bypassed, replayed or treated as authenticated', async () => {
  const { broker, calls } = fixture({ challenge: true });
  const output = await broker.authenticate();
  assert.equal(output.error.code, 'PORTAL_LOGIN_CHALLENGE_REQUIRED');
  assert.equal(output.session.authenticated, false);
  assert.equal(calls.some(call => call.url.pathname === '/v1/storage'), false);
  assert.equal(calls.filter(call => call.url.origin.includes('cognito')).length, 1);
});

test('broker refuses cross-tenant/mutating calls and unallowlisted redirect origins', async () => {
  const { broker, calls } = fixture();
  await assert.rejects(broker.request('https://untrusted.example/'), error => error.code === 'PORTAL_ORIGIN_DENIED');
  await assert.rejects(broker.readScreenservice({ target: 'odc1', origin, readOnly: true }), error => error.code === 'PORTAL_ACCESS_DENIED');
  await assert.rejects(broker.readScreenservice({ target: 'odc3', origin, readOnly: false }), error => error.code === 'PORTAL_ACCESS_DENIED');
  assert.equal(calls.length, 0);
});

test('vault failure does not prevent discovery startup and never leaks raw helper error', async () => {
  const broker = new Odc3PortalBroker({ credentialProvider: async () => { throw new Error('PRIVATE_HELPER_SECRET'); } });
  await broker.initialize();
  assert.equal(broker.status().authenticated, false);
  assert.equal(broker.status().bootstrapRequired, false);
  assert.equal(JSON.stringify(broker.status()).includes('PRIVATE_HELPER_SECRET'), false);
});

test('unverified current contracts require auth, while an explicit contract block fails closed', async () => {
  const { broker, calls } = fixture();
  await assert.rejects(broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId: 'monitoring.logs' }),
    error => error.code === 'PORTAL_AUTH_REQUIRED');
  broker.authenticated = true;
  for (const operationId of ['monitoring.logs', 'monitoring.errors', 'monitoring.applications']) {
    broker.blockedOperations.add(operationId);
    await assert.rejects(broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId }),
      error => error.code === 'PORTAL_CONTRACT_CHANGED');
  }
  assert.equal(calls.length, 0);
});

test('trace block wire view stays distinct from metadata discovery page and cannot be swapped', async () => {
  const calls = [], resolved = [];
  const broker = new Odc3PortalBroker({ credentialProvider: async () => ({ available: false }), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: { SpansList: {} } }), { status: 200 });
  } });
  broker.authenticated = true;
  broker.metadata.resolve = async (module, view, action) => { resolved.push({ module, view, action }); return { moduleVersion: 'current-module', apiVersion: 'current-action', action }; };
  const input = { target: 'odc3', origin, operationId: 'monitoring.trace', module: 'monitoring', view: 'traces.TreeView_multipleRoots',
    discoveryView: 'traces.trace', action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans', readOnly: true,
    screenVariables: { StageKey: 'stage', TraceKey: 'trace', IsReadyToLoad: true, FetchAgentTraceData: false } };
  await broker.readScreenservice(input);
  assert.equal(resolved[0].view, 'traces.trace');
  assert.equal(calls[0].body.viewName, 'traces.TreeView_multipleRoots');
  assert.deepEqual(calls[0].body.screenData.variables, input.screenVariables);
  await assert.rejects(broker.readScreenservice({ ...input, discoveryView: 'traces.agenttrace' }), { code: 'PORTAL_ACCESS_DENIED' });
  assert.equal(calls.length, 1);
});

test('native tenant SRP flow passes observed inputs to Portal and proves protected provider read', async () => {
  const { broker } = fixture();
  const received = [];
  broker.cognito = async input => {
    assert.equal(input.config.AuthFlow, 'USER_SRP_AUTH');
    assert.equal(input.password, 'PRIVATE_PASSWORD');
    return { IdToken: 'PRIVATE_ID', AccessToken: 'PRIVATE_ACCESS', RefreshToken: 'PRIVATE_REFRESH' };
  };
  broker.action = async (module, view, action, parameters, variables) => {
    received.push({ action, parameters, variables });
    if (action.endsWith('/DataActionGetProviders') && module === 'authentication') return { data: { CognitoEnabled: true, CognitoConfig: { AuthFlow: 'USER_SRP_AUTH' } } };
    if (action.endsWith('/DataActionGetRedirect')) return { data: { Url: origin + '/broker/start' } };
    if (action.endsWith('/ActionProcessCognitoToken')) return { data: { AuthCode: 'PRIVATE_COGNITO_CODE' } };
    if (action.endsWith('/ActionProcessCodeRedirect')) return { data: {} };
    if (module === 'connections') return { data: { Providers: { List: [] } } };
    throw new Error('Unexpected action');
  };
  broker.redirects = async url => url.includes('/broker/start')
    ? new URL(origin + '/authentication/login?client_id=client&redirect_uri=' + encodeURIComponent(origin + '/broker/callback') + '&state=PRIVATE_STATE')
    : new URL(origin + '/authentication/redirect?code=PRIVATE_FINAL_CODE&state=PRIVATE_FINAL_STATE');
  const output = await broker.authenticate();
  assert.equal(output.ok, true); assert.equal(output.session.authenticated, true);
  const call = received.find(entry => entry.action.endsWith('/ActionProcessCognitoToken'));
  assert.equal(call.parameters.ClientId, 'client');
  assert.equal(call.parameters.CognitoAccessToken, 'PRIVATE_ACCESS');
  assert.equal(call.variables.state, 'PRIVATE_STATE');
  assert.equal(JSON.stringify(output).includes('PRIVATE_'), false);
});

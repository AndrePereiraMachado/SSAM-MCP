// The community sign-in (OutSystems ID, id.outsystems.com) inside the redaction boundary: every credential the sign-in
// brings into this process (the Portal callback code, the OutSystems ID tokens, the Portal session cookies set while the
// code is processed) is masked when a later Portal read echoes it. Synthetic values only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';
import { PORTAL_READS } from '../runtime/portal-routes.mjs';
import { createLogScreenDefaults } from '../runtime/log-screen-defaults.mjs';
import { projectForAgent } from '../runtime/agent-projection.mjs';

const origin = 'https://personal-test.outsystems.dev';
const since = '2026-10-10T10:00:00.000Z', until = '2026-10-10T11:00:00.000Z';
const applicationKey = '14d11111-2100-4000-9000-100000000010';
const input = { environmentKey: 'stage', applicationKey, since, until, limit: 1 };
const { screen } = createLogScreenDefaults();
const credential = () => 'synthetic-community-' + randomUUID();
const parameters = { response_type: 'code', client_id: 'portal-client', scope: 'openid', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
  redirect_uri: origin + '/authentication/redirect', state: 'original-state', nonce: 'original-nonce' };
const logResponse = message => ({ data: { LogsList: { List: [{ LogId: 'log-0', TraceId: 'trace', Time: since, ApplicationKey: applicationKey,
  Severity: 'Error', Message: message }] }, LogSearch_Page: { Limit: '1', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '1' } } });

function communityBroker(values, { registerCookie = true } = {}) {
  const closed = { count: 0 };
  const broker = new Odc3PortalBroker({ origin,
    fetchImpl: async () => {
      const headers = new Headers();
      if (registerCookie) headers.append('set-cookie', 'tenant_session=' + values.session + '; Path=/; Secure; HttpOnly');
      return new Response('{}', { headers });
    },
    credentialProvider: async mode => mode === 'status' ? { available: true } : { available: true, username: 'dev@example.test', password: values.password },
    communityFactory: () => {
      const identity = { tokens: { access_token: values.access, id_token: values.idToken, refresh_token: values.refresh, token_type: 'Bearer' },
        authorizePortal: async () => new URL(origin + '/authentication/redirect?code=' + values.code + '&state=' + parameters.state),
        close: async () => { closed.count++; identity.tokens = null; } };
      return identity;
    } });
  broker.action = async (module, _view, action, inputParameters) => {
    if (module === 'authentication' && action.endsWith('/DataActionGetProviders'))
      return { data: { RedirectNowUrl: 'https://id.outsystems.com/community/login?' + new URLSearchParams(parameters) } };
    if (action.endsWith('/ActionProcessCodeRedirect')) {
      assert.equal(inputParameters.Code, values.code);
      await broker.request(origin + '/authentication/');   // the Portal session cookie arrives with the processed code
      return { data: {} };
    }
    if (module === 'connections') return { data: { Providers: [] } };
    if (action.endsWith('DataActionGetSettings')) return { data: screen.GetSettings };
    if (action.endsWith('DataActionGetFilter_Stages'))
      return { data: { EnvironmentList: { List: [{ Environment: { ...screen.SelectedEnviroment, Key: 'stage', PortfolioKey: 'portfolio' } }] } } };
    if (action === PORTAL_READS['monitoring.logs'][2]) return logResponse('echo ' + [values.code, values.access, values.idToken, values.refresh, values.session].join(' '));
    throw new Error('Unexpected synthetic action ' + action);
  };
  return { broker, closed };
}

test('community sign-in: the callback code, the OutSystems ID tokens and the Portal session cookie are masked in an echoed read', async () => {
  const values = { code: credential(), access: credential(), idToken: credential(), refresh: credential(), session: credential(), password: credential() };
  const { broker, closed } = communityBroker(values);
  const login = await broker.authenticate();
  assert.equal(login.ok, true); assert.equal(broker.authenticated, true); assert.equal(closed.count, 1);
  for (const value of Object.values(values)) assert.equal(JSON.stringify(login).includes(value), false);
  const result = await projectForAgent(() => new PortalReadAdapter({ target: 'odc3', origin, broker }).execute({ operationId: 'monitoring.logs', input }));
  assert.equal(result.ok, true);
  const json = JSON.stringify(result);
  for (const name of ['code', 'access', 'idToken', 'refresh', 'session']) assert.equal(json.includes(values[name]), false, name + ' must never escape');
  assert.equal(json.includes('[REDACTED]'), true);
  assert.deepEqual(broker.credentialRegistry.summary().cookieNames, ['tenant_session']);
});

test('community sign-in: a new login retires the previous sign-in values, and an in-flight echo of them stays masked', async () => {
  const values = { code: credential(), access: credential(), idToken: credential(), refresh: credential(), session: credential(), password: credential() };
  const first = { ...values };
  const { broker } = communityBroker(values);   // the fakes read `values` at call time
  assert.equal((await broker.authenticate()).ok, true);
  assert.equal(broker.credentialRegistry.summary().registeredCount, 5, 'code, three tokens and the session cookie are registered');
  const second = { code: credential(), access: credential(), idToken: credential(), refresh: credential(), session: credential() };
  Object.assign(values, second);
  assert.equal((await broker.authenticate()).ok, true);
  assert.equal(broker.credentialRegistry.summary().registeredCount, 5);
  const echo = await projectForAgent(async () => ({ ok: true, echo: [...Object.values(first), ...Object.values(second)].join(' ') }));
  for (const name of ['code', 'access', 'idToken', 'refresh', 'session']) {
    assert.equal(echo.echo.includes(first[name]), false, 'previous ' + name);
    assert.equal(echo.echo.includes(second[name]), false, 'current ' + name);
  }
});

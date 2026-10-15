import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OdcAccess } from '../runtime/access.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';
import { OdcBridge } from '../runtime/bridge.mjs';
import { OdcError } from '../runtime/errors.mjs';
import { PORTAL_READS } from '../runtime/portal-routes.mjs';
import { createLogScreenDefaults } from '../runtime/log-screen-defaults.mjs';
import { projectForAgent } from '../runtime/agent-projection.mjs';
import { boundedRead } from '../../facade/read-budget.mjs';
import { registerAccessTools } from '../../facade/odc-access.mjs';
import { testConfig } from './helpers.mjs';

const origin = 'https://personal-test.outsystems.dev';
const since = '2026-10-10T10:00:00.000Z', until = '2026-10-10T11:00:00.000Z';
const applicationKey = '14d11111-2100-4000-9000-100000000010';
const input = { environmentKey: 'stage', applicationKey, since, until, limit: 1 };
const { screen } = createLogScreenDefaults();
const credential = () => 'synthetic-session-' + randomUUID();
const row = (id, message) => ({ LogId: id, TraceId: 'trace', Time: since, ApplicationKey: applicationKey, Severity: 'Error', Message: message });
const page = (offset = 0, next = -1) => ({ Limit: '1', Offset: String(offset), NextPageOffset: String(next), TotalPages: '2', TotalResults: '2' });
const response = (message, offset = 0, next = -1) => ({ data: { LogsList: { List: [row('log-' + offset, message)] }, LogSearch_Page: page(offset, next) } });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const safe = (result, values) => {
  assert.equal(result.ok, true);
  const json = JSON.stringify(result);
  for (const value of values) assert.equal(json.includes(value), false, 'registered credential must never escape');
  assert.equal(json.includes('[REDACTED]'), true);
};
function logs(broker, handler) {
  broker.action = async (_module, _view, action, parameters, variables) => {
    if (action.endsWith('DataActionGetSettings')) return { data: screen.GetSettings };
    if (action.endsWith('DataActionGetFilter_Stages')) return { data: { EnvironmentList: { List: [{ Environment: { ...screen.SelectedEnviroment, Key: 'stage', PortfolioKey: 'portfolio' } }] } } };
    if (action === PORTAL_READS['monitoring.logs'][2]) return handler(parameters, variables);
    throw new Error('Unexpected synthetic action');
  };
}
function facade(access, tool) {
  const handlers = new Map();
  registerAccessTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, access, handler => handler);
  return handlers.get(tool);
}
function portalFixture() {
  const token = credential(), started = gate(), release = gate();
  const broker = new Odc3PortalBroker({ origin, fetchImpl: async () => new Response('{}') });
  broker.credentialRegistry.add(token); broker.authenticated = true;
  let sends = 0;
  logs(broker, async () => { sends++; started.resolve(); await release.promise; return response('echo ' + token); });
  const self = { portalReadWithinBudget: ({ operationId, input }) => new PortalReadAdapter({ target: 'odc3', origin, broker }).execute({ operationId, input }) };
  const tool = facade({ portalRead: args => OdcAccess.prototype.portalRead.call(self, args) }, 'odc_portal_read');
  return { token, started, release, tool, sends: () => sends, args: { tenant: new URL(origin).host, operationId: 'monitoring.logs', input } };
}

test('M1: both identical concurrent Portal facade reads mask the shared session token', async () => {
  const f = portalFixture();
  const first = f.tool(f.args); await f.started.promise;
  const second = f.tool(f.args); f.release.resolve();
  for (const result of await Promise.all([first, second])) safe(result, [f.token]);
  assert.equal(f.sends(), 1);
});

test('M1: resumed Portal read masks the session token without resending', async () => {
  const f = portalFixture(), key = randomUUID();
  // The production budget supports a shorter deadline; retain its actual pending-result path.
  const call = () => projectForAgent(() => boundedRead(key, () => f.tool(f.args), { timeoutMs: 5 }));
  const first = await call(); assert.equal(first.code, 'READ_DEADLINE_EXCEEDED');
  f.release.resolve(); await new Promise(resolve => setImmediate(resolve));
  safe(await call(), [f.token]); assert.equal(f.sends(), 1);
});

async function apiFixture() {
  const secret = credential(), token = credential(), started = gate(), release = gate();
  const config = testConfig({ clientSecret: secret }); let sends = 0;
  const bridge = new OdcBridge({ config, fetchImpl: async url => {
    if (String(url).includes('.well-known')) return Response.json({ token_endpoint: config.origin + '/token' });
    if (String(url).endsWith('/token')) return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    sends++; started.resolve(); await release.promise;
    return Response.json({ items: [{ description: 'echo ' + secret + ' ' + token }] });
  } });
  await bridge.auth.getToken();
  const operationId = 'asset-repository-api-v1:get:/assets';
  const self = { readWithinBudget: () => bridge.execute(operationId) };
  const tool = facade({ read: args => OdcAccess.prototype.read.call(self, args) }, 'odc_read');
  const args = { tenant: new URL(config.origin).host, auth: 'api-client', operationId };
  return { secret, token, started, release, tool, args, sends: () => sends };
}

test('M1: joined odc_read masks the API Client secret and acquired token', async () => {
  const f = await apiFixture();
  const first = f.tool(f.args); await f.started.promise;
  const second = f.tool(f.args); f.release.resolve();
  for (const result of await Promise.all([first, second])) safe(result, [f.secret, f.token]);
  assert.equal(f.sends(), 1);
});

test('M1: resumed odc_read masks API Client credentials without resending', async () => {
  const f = await apiFixture(), key = randomUUID();
  const call = () => projectForAgent(() => boundedRead(key, () => f.tool(f.args), { timeoutMs: 5 }));
  const first = await call(); assert.equal(first.code, 'READ_DEADLINE_EXCEEDED');
  await f.started.promise;
  f.release.resolve(); await new Promise(resolve => setImmediate(resolve));
  safe(await call(), [f.secret, f.token]); assert.equal(f.sends(), 1);
});

for (const success of [false, true]) test('M4: concurrent ' + (success ? 'successful' : 'failed') + ' authenticate preserves old credentials', async () => {
  const old = credential(), fresh = credential(), started = gate(), release = gate();
  const broker = new Odc3PortalBroker({ origin, fetchImpl: async () => new Response('{}'),
    credentialProvider: async mode => mode === 'status' ? { available: success } : { available: true, username: 'synthetic@example.test', password: fresh } });
  broker.credentialRegistry.add(old); broker.authenticated = true;
  logs(broker, async () => { started.resolve(); await release.promise; return response('echo ' + old); });
  const logAction = broker.action;
  broker.action = async (...args) => args[2].endsWith('login/DataActionGetProviders')
    ? { data: { CognitoEnabled: true, CognitoConfig: { AuthFlow: 'USER_SRP_AUTH' } } }
    : args[2].endsWith('connections/DataActionGetProviders') ? { data: { Providers: [] } } : logAction(...args);
  // Keep real login/reset/confirmAuthentication; substitute only remote identity exchange.
  broker.nativeCognitoLogin = async () => { broker.credentialRegistry.tokens({ AccessToken: fresh }); };
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
  const reading = projectForAgent(() => adapter.execute({ operationId: 'monitoring.logs', input }));
  await started.promise;
  const authenticated = await broker.authenticate(); assert.equal(authenticated.ok, success);
  release.resolve(); safe(await reading, [old]);
});

test('M4: page-2 recoverRead keeps the first page credential masked', async () => {
  const old = credential(), fresh = credential(); let calls = 0, logins = 0;
  const broker = new Odc3PortalBroker({ origin, fetchImpl: async () => new Response('{}') });
  broker.credentialRegistry.add(old); broker.authenticated = true;
  broker.login = async () => { logins++; broker.credentialRegistry.reset(); broker.credentialRegistry.add(fresh); broker.authenticated = true; return { ok: true }; };
  logs(broker, async () => {
    calls++;
    if (calls === 1) return response('echo ' + old, 0, 1);
    if (calls === 2) throw new OdcError('PORTAL_AUTH_REQUIRED', 'Synthetic expired session', { sent: true, status: 401 });
    return response('echo ' + fresh, 1, -1);
  });
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker });
  const result = await projectForAgent(async () => {
    const first = await adapter.execute({ operationId: 'monitoring.logs', input });
    const second = await adapter.execute({ operationId: 'monitoring.logs', input: { ...input, offset: 1 } });
    return { ok: first.ok && second.ok, rows: [...(first.rows ?? []), ...(second.rows ?? [])] };
  });
  safe(result, [old, fresh]); assert.equal(result.rows.length, 2); assert.equal(logins, 1); assert.equal(calls, 3);
});

test('M2: broker cookies and the decoded nr2 CSRF are masked in echoed logs', async () => {
  const direct = credential(), ticket = credential(), decoded = credential() + '/+=';
  const packed = encodeURIComponent('crf=' + decoded + ';uid=7;unm=synthetic');
  const cookies = [['crf', direct], ['nr1Portal', ticket], ['nr2Portal', packed]];
  const broker = new Odc3PortalBroker({ origin, fetchImpl: async () => {
    const headers = new Headers();
    for (const [name, value] of cookies) headers.append('set-cookie', name + '=' + value + '; Path=/; Secure');
    return new Response('{}', { headers });
  } });
  await broker.request(origin + '/apps/');
  broker.authenticated = true;
  const values = [direct, ticket, packed, decoded];
  logs(broker, async () => response('echo ' + values.join(' ')));
  const result = await new PortalReadAdapter({ target: 'odc3', origin, broker }).execute({ operationId: 'monitoring.logs', input });
  safe(result, values);
  assert.deepEqual(broker.credentialRegistry.summary().cookieNames, ['crf', 'nr1Portal', 'nr2Portal']);
});

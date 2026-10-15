import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CredentialRegistry, processCredentials, processCredentialSummary } from '../runtime/credential-registry.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { OdcAccess } from '../runtime/access.mjs';
import { Catalog } from '../runtime/catalog.mjs';
import { OAuthClient } from '../runtime/auth.mjs';
import { registerAccessTools } from '../../facade/odc-access.mjs';
import { openOdcTimerInstance } from '../../facade/debug-odc-background-instance.mjs';
import { observeCredentials } from '../runtime/projection-context.mjs';

const host = 'personal-test.outsystems.dev', origin = 'https://' + host;
const environmentKey = '44444444-4444-4444-8444-444444444444';
const synthetic = () => 'synthetic-' + randomUUID();
function fixture(cookies = false) {
  const state = { tokens: { AccessToken: synthetic(), IdToken: synthetic(), RefreshToken: synthetic() }, code: synthetic(), reads: 0, responses: 0, message: '', rotate: false };
  const broker = new Odc3PortalBroker({ origin, cognito: async () => state.tokens,
    credentialProvider: async mode => mode === 'status' ? { available: true } : { available: true, username: 'synthetic@example.test', password: synthetic() },
    fetchImpl: async url => {
      const u = new URL(url), action = u.pathname.split('/').pop(); let data = {};
      if (action === 'DataActionGetProviders') data = u.pathname.startsWith('/connections/') ? { Providers: [] } : { CognitoEnabled: true, CognitoConfig: { AuthFlow: 'USER_SRP_AUTH' } };
      if (action === 'DataActionGetRedirect') data = { Url: origin + '/authentication/login?client_id=synthetic&redirect_uri=' + encodeURIComponent(origin + '/authentication/redirect') };
      if (action === 'ActionProcessCognitoToken') data = { AuthCode: state.code };
      if (action === 'DataActionGetLogById') { state.reads++; data = { Log: { LogId: state.logId, Severity: 'Error', Time: '2026-10-14T00:00:00Z', Message: Buffer.from(state.message).toString('base64') } }; }
      const headers = new Headers({ 'content-type': 'application/json' });
      if (cookies) for (let i = 0; i < [3, 3, 2, 2, 2, 2][state.responses]; i++) headers.append('set-cookie', 'SynDbg' + state.responses + '_' + i + '=' + synthetic() + '; Path=/; Secure');
      if (state.rotate) headers.append('set-cookie', 'SynSession=' + synthetic() + '; Path=/; Secure');
      state.responses++; return Response.json({ data }, { headers });
    } });
  broker.action = async function (module, view, action, inputParameters = {}, screenVariables = {}, signal) {
    const response = await this.request(origin + '/' + module + '/screenservices/' + action, { method: 'POST', body: { inputParameters, screenVariables }, signal });
    return JSON.parse(response.text);
  };
  return { broker, state };
}
async function login(f) { await f.broker.initialize(); assert.equal((await f.broker.authenticate()).ok, true); }
async function debuggerSessions(count) {
  for (let i = 0; i < count; i++) {
    const f = fixture(true); await login(f);
    const instance = openOdcTimerInstance({ binding: { environmentKey, tenant: host, moduleKey: 'AAAAAAAAAAAAAAAAAAAAAA', module: 'Synthetic', revision: 1, runtimeUrl: origin },
      sourceSha256: 'a'.repeat(64), timer: { timerKey: 'synthetic-timer', name: 'SyntheticTimer' }, broker: f.broker });
    assert.equal((await instance.release()).released, true);
  }
}
function tool(f) {
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: host, tenants: { [host]: { class: 'personal', portalOrigin: origin } } },
    studio: { running: async () => false }, vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: true }), bridge: async () => ({}) },
    prompt: {}, portalBroker: () => f.broker, journal: () => {}, requestFile: () => { throw new Error('No synthetic request files'); }, sleep: async () => {} });
  const handlers = new Map(); registerAccessTools({ registerTool: (name, config, handler) => handlers.set(name, handler) }, access, handler => handler);
  return handlers.get('odc_portal_read');
}
async function echo(f, value) {
  f.state.message = 'Synthetic upstream echo ' + value; f.state.logId = 'log-' + randomUUID();
  const before = f.state.reads;
  const result = await tool(f)({ tenant: host, operationId: 'monitoring.detail', input: { environmentKey, logId: f.state.logId } });
  assert.equal(result.ok, true); assert.equal(f.state.reads, before + 1);
  assert.equal(JSON.stringify(result).includes(value), false, 'A live credential must remain masked at the facade');
  assert.equal(processCredentials().includes(value), true, 'Live values must remain in the process matcher');
  assert.ok(processCredentialSummary().activeCount >= 1, 'The process summary must count live credentials');
  assert.ok(processCredentialSummary().retiredCount <= 4096);
}

for (const scenario of ['A', 'B', 'C', 'D']) test('N1 ' + scenario + ': active credentials survive churn through the real facade and broker', async () => {
  const f = fixture(); await login(f); let value = f.state.tokens.RefreshToken, oauth;
  if (scenario === 'C') { value = synthetic(); oauth = new OAuthClient({ origin, clientId: 'synthetic-client', clientSecret: value, trustedTokenOrigins: new Set([origin]) }); }
  if (scenario === 'A' || scenario === 'C') await debuggerSessions(228);
  if (scenario === 'B') { f.state.rotate = true; for (let i = 0; i < 4095; i++) await f.broker.request(origin + '/monitoring/rotate'); f.state.rotate = false; }
  if (scenario === 'D') {
    const other = new CredentialRegistry(); for (let i = 0; i < 4000; i++) other.add(synthetic());
    f.broker.credentialRegistry.add(value); f.broker.credentialRegistry.tokens(f.state.tokens); observeCredentials(f.broker.credentialRegistry);
    for (let i = 0; i < 100; i++) other.add(synthetic());
    await echo(f, value); other.dispose(); f.broker.dispose(); return;
  }
  await echo(f, value); assert.equal(oauth ? [...oauth.credentialRegistry.values()].includes(value) : [...f.broker.credentialRegistry.values()].includes(value), true);
  oauth?.dispose(); f.broker.dispose();
});

test('N1: 10000 foreign values and 10000 same-broker cookie rotations preserve live tokens', async () => {
  const f = fixture(); await login(f); const value = f.state.tokens.RefreshToken;
  const other = new CredentialRegistry(); for (let i = 0; i < 10000; i++) other.add(synthetic()); other.dispose();
  f.state.rotate = true; for (let i = 0; i < 10000; i++) await f.broker.request(origin + '/monitoring/rotate'); f.state.rotate = false;
  await echo(f, value); f.broker.dispose();
});

test('N1: distinct cookie identities and tokens remain active beyond 128 values', () => {
  const registry = new CredentialRegistry(), token = synthetic(); registry.add(token);
  for (let i = 0; i < 300; i++) registry.cookie({ key: 'Distinct' + i, value: synthetic() }, host);
  assert.equal(registry.summary().registeredCount, 301);
  assert.equal([...registry.values()].includes(token), true, 'Distinct cookie names must not retire a direct token');
  registry.dispose();
});

test('N1: cookie rotations preserve shared cookie, direct-token and decoded-CSRF owners', () => {
  for (const mode of ['cookies', 'direct', 'csrf']) {
    const registry = new CredentialRegistry(), value = synthetic();
    const packed = encodeURIComponent('crf=' + value + ';uid=synthetic');
    registry.cookie({ key: mode === 'csrf' ? 'nr2First' : 'First', value: mode === 'csrf' ? packed : value }, host);
    if (mode === 'direct') registry.add(value);
    else registry.cookie({ key: mode === 'csrf' ? 'nr2Second' : 'Second', value: mode === 'csrf' ? packed : value }, host);
    registry.cookie({ key: mode === 'csrf' ? 'nr2First' : 'First', value: synthetic() }, host);
    const active = typeof registry.activeValues === 'function' ? [...registry.activeValues()] : [];
    assert.equal(active.includes(value), true, 'Rotating one identity must preserve another live owner');
    registry.dispose();
  }
});

test('N1: a shared value remains active until its final registry owner retires', () => {
  const first = new CredentialRegistry(), second = new CredentialRegistry(), value = synthetic();
  first.add(value); second.add(value); first.reset();
  assert.equal(processCredentials().includes(value), true);
  assert.ok(processCredentialSummary().activeCount >= 1);
  first.dispose(); second.dispose();
  assert.equal(processCredentials().includes(value), true, 'Final disposal must keep recent retired values masked');
});

test('N1: repeating a retired value refreshes its FIFO position', () => {
  const registry = new CredentialRegistry(), value = synthetic(); registry.add(value); registry.reset();
  for (let i = 0; i < 4000; i++) { registry.add(synthetic()); registry.reset(); }
  registry.add(value); registry.reset();
  for (let i = 0; i < 100; i++) { registry.add(synthetic()); registry.reset(); }
  assert.equal(processCredentials().includes(value), true, 'A repeated retired value must move to the newest end');
  assert.ok(processCredentialSummary().retiredCount <= 4096); registry.dispose();
});

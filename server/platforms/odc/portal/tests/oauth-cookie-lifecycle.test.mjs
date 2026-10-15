import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OAuthClient } from '../runtime/auth.mjs';
import { CredentialRegistry, processCredentials, processCredentialSummary, credentialStateVersion } from '../runtime/credential-registry.mjs';
import { projectForAgent } from '../runtime/agent-projection.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { OdcAccess } from '../runtime/access.mjs';
import { Catalog } from '../runtime/catalog.mjs';
import { registerAccessTools } from '../../facade/odc-access.mjs';

const synthetic = () => 'synthetic-' + randomUUID();
const host = 'personal-test.outsystems.dev', origin = 'https://' + host;

test('R4-1: 10000 OAuth renewals retain only the secret and 16 known tokens as active', async t => {
  const secret = synthetic(); let current, count = 0, oldest, recentlyRetired;
  const auth = new OAuthClient({ origin, clientId: 'synthetic-client', clientSecret: secret,
    trustedTokenOrigins: new Set([origin]), timeoutMs: 1000, maxResponseBytes: 262144 }, async () => {
    current = synthetic();
    if (count === 0) oldest = current;
    if (count === 9983) recentlyRetired = current;
    count++;
    return Response.json({ access_token: current, token_type: 'Bearer', expires_in: 60 });
  });
  t.after(() => auth.dispose()); auth.tokenEndpoint = origin + '/token';
  for (let index = 0; index < 10000; index++) { auth.invalidate(current); await auth.getToken(); }
  assert.equal(count, 10000);
  assert.ok(auth.credentialRegistry.summary().registeredCount <= 17, 'OAuth active credentials must remain bounded');
  assert.ok(processCredentialSummary().retiredCount <= 4096);
  assert.equal(auth.knownTokens.size, 16);
  assert.equal([...auth.credentialRegistry.activeValues()].includes(recentlyRetired), false, 'The recently evicted token must leave active ownership');
  assert.equal(processCredentials().includes(recentlyRetired), true, 'Recent tokens must protect joined or resumed reads');
  assert.equal(processCredentials().includes(oldest), false, 'The oldest retired token must leave bounded retention');
  const output = JSON.stringify(await projectForAgent(async () => ({ message: secret + ' ' + current + ' ' + recentlyRetired })));
  assert.equal(output.includes(secret) || output.includes(current), false, 'The current OAuth token and secret must remain masked');
  assert.equal(output.includes(recentlyRetired), false, 'A recent retired token must remain masked at the boundary');
});

test('R4-1 control: evicting a token equal to the client secret preserves the secret owner', async t => {
  const secret = synthetic(); let count = 0;
  const auth = new OAuthClient({ origin, clientId: 'synthetic-client', clientSecret: secret,
    trustedTokenOrigins: new Set([origin]), timeoutMs: 1000, maxResponseBytes: 262144 }, async () =>
    Response.json({ access_token: count++ === 0 ? secret : synthetic(), token_type: 'Bearer', expires_in: 60 }));
  t.after(() => auth.dispose()); auth.tokenEndpoint = origin + '/token';
  for (let index = 0; index < 18; index++) await auth.acquire();
  assert.equal([...auth.credentialRegistry.activeValues()].includes(secret), true, 'The config secret remains active after token eviction');
  assert.equal(auth.credentialRegistry.summary().registeredCount, 17);
});

test('R4-1 control: retirement preserves cookie and other-registry owners without matcher invalidation', () => {
  const value = synthetic(), registry = new CredentialRegistry(), other = new CredentialRegistry();
  try {
    registry.add(value); registry.cookie({ key: 'SyntheticSession', domain: host, path: '/', value }, host); other.add(value);
    const before = credentialStateVersion();
    registry.retire(value);
    assert.equal([...registry.activeValues()].includes(value), true, 'A same-registry cookie keeps its value active');
    assert.equal(credentialStateVersion(), before, 'Removing an overlapping owner must not invalidate matcher membership');
    registry.cookie({ key: 'SyntheticSession', domain: host, path: '/', value: '1' }, host);
    assert.equal([...other.activeValues()].includes(value), true, 'A second registry keeps its value active');
    assert.equal(processCredentials().includes(value), true);
    assert.equal(credentialStateVersion(), before, 'Retiring one registry must preserve shared matcher membership');
  } finally { registry.dispose(); other.dispose(); }
});

for (const mode of ['path', 'domain']) test('R4-3: distinct cookie ' + mode + ' identities survive retired-value churn at the real facade', async t => {
  const first = synthetic(), second = synthetic(), state = { message: '', reads: 0 };
  const broker = new Odc3PortalBroker({ origin, cognito: async () => ({ AccessToken: synthetic(), IdToken: synthetic(), RefreshToken: synthetic() }),
    credentialProvider: async mode => mode === 'status' ? { available: true } : { available: true, username: 'synthetic@example.test', password: synthetic() }, fetchImpl: async url => {
    const parsed = new URL(url), headers = new Headers({ 'content-type': 'application/json' }); let data = {};
    if (parsed.pathname.endsWith('DataActionGetProviders')) data = parsed.pathname.startsWith('/connections/') ? { Providers: [] } : { CognitoEnabled: true, CognitoConfig: { AuthFlow: 'USER_SRP_AUTH' } };
    if (parsed.pathname.endsWith('DataActionGetRedirect')) data = { Url: origin + '/authentication/login?client_id=synthetic&redirect_uri=' + encodeURIComponent(origin + '/authentication/redirect') };
    if (parsed.pathname.endsWith('ActionProcessCognitoToken')) data = { AuthCode: synthetic() };
    if (parsed.pathname === '/apps/set') headers.append('set-cookie', 'SynSess=' + first + '; Path=/apps; Secure');
    if (parsed.pathname === '/monitoring/set') headers.append('set-cookie', mode === 'path'
      ? 'SynSess=' + second + '; Path=/monitoring; Secure' : 'SynSess=' + second + '; Domain=outsystems.dev; Path=/; Secure');
    if (parsed.pathname.endsWith('DataActionGetLogById')) {
      state.reads++; data = { Log: { LogId: 'synthetic-log', Severity: 'Error', Time: '2026-10-14T00:00:00Z', Message: Buffer.from(state.message).toString('base64') } };
    }
    return Response.json({ data }, { headers });
  } });
  t.after(() => broker.dispose());
  broker.action = async function (module, view, action, inputParameters = {}, screenVariables = {}, signal) {
    return JSON.parse((await this.request(origin + '/' + module + '/screenservices/' + action,
      { method: 'POST', body: { inputParameters, screenVariables }, signal })).text);
  };
  await broker.initialize(); assert.equal((await broker.authenticate()).ok, true);
  await broker.request(origin + '/apps/set'); await broker.request(origin + '/monitoring/set');
  assert.equal((await broker.jar.getCookieString(origin + '/apps/x')).includes(first), true, 'The jar must still send the first cookie');
  for (let index = 0; index < 4096; index++) { const registry = new CredentialRegistry(); registry.add(synthetic()); registry.dispose(); }
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: host, tenants: { [host]: { class: 'personal', portalOrigin: origin } } },
    studio: { running: async () => false }, vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: true }), bridge: async () => ({}) },
    prompt: {}, portalBroker: () => broker, journal: () => {}, requestFile: () => { throw new Error('No request files'); }, sleep: async () => {} });
  const handlers = new Map(); registerAccessTools({ registerTool: (name, config, handler) => handlers.set(name, handler) }, access, handler => handler);
  state.message = 'Synthetic upstream echo ' + first;
  const result = await handlers.get('odc_portal_read')({ tenant: host, operationId: 'monitoring.detail',
    input: { environmentKey: '44444444-4444-4444-8444-444444444444', logId: 'synthetic-log' } });
  assert.equal(result.ok, true, 'Synthetic facade read failed: ' + result.error?.code); assert.equal(state.reads, 1);
  assert.equal(JSON.stringify(result).includes(first), false, 'A still-sent cookie must remain masked');
  assert.equal([...broker.credentialRegistry.activeValues()].includes(first), true, 'The first cookie identity must stay active');
  assert.equal(processCredentials().includes(first), true);
});

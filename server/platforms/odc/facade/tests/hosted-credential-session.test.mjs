import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithExecutor } from '../executor.mjs';
import { Resolver } from '../service-center/auth.mjs';
import { StudioBridge } from '../service-center/bridge.mjs';
import { StudioWebTransport } from '../service-center/http.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { CredentialProfiles } from '../credential-profiles.mjs';
import { CredentialAgent } from '../hosted/credential-agent.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { readPerformanceEvents } from '../service-center/performance-events.mjs';
import { wrapHostedTool, refusalBeforeAgent } from '../hosted/policy.mjs';
import { boundedRead } from '../read-budget.mjs';
import { publicError } from '../../portal/runtime/errors.mjs';

const host = 'example.outsystemscloud.com', portalHost = 'example.outsystems.dev', profile = 'a'.repeat(64);
const principal = 'person@example.test';
function harness({ supported = true, available = true, authenticated = true, reply = null } = {}) {
  const calls = [];
  const context = { hosted: true, workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'r40-credential-test-')), lanes: ['o11', 'odc'], executor: { hosted: true, call: async () => { throw new Error('No legacy machine call'); } },
    agent: { supports: kind => supported && kind === 'credential.session', call: async (kind, args) => {
      calls.push({ kind, ...args });
      if (reply) return reply(args);
      if (args.op === 'request') return { status: 200, body: Buffer.from('<html><body>Protected page</body></html>').toString('base64'), contentType: 'text/html', url: args.url };
      return { available, authenticated, profile, principal, profiles: [{ profile, principal }], visible: true, opened: true };
    } } };
  return { context, calls, within: fn => runWithExecutor(context, fn) };
}
const bridge = (webSigned = false) => ({ supports: async () => true, capabilities: async () => new Set(['sc_http:studioSession']),
  session: async () => ({ studio: { signedIn: true, user: principal } }), web: async () => ({ signedIn: webSigned }) });
const resolver = (options = {}) => new Resolver(host, { locate: async () => bridge(), present: () => assert.fail('No server vault'), ...options });
const access = () => new OdcAccess({ hosted: true, tenants: { tenants: { [portalHost]: { class: 'personal' } } },
  studio: { running: async () => false }, vault: new Proxy({}, { get: () => () => assert.fail('No server vault') }),
  portalBroker: () => assert.fail('No server broker') });

test('invalid private response URL is a fixed credential error, not a raw TypeError', async () => {
  const h = harness({ reply: args => ({ status: 200, body: 'e30=', contentType: 'application/json', url: 'https://tenant[redacted].example.com/' }) });
  await assert.rejects(new CredentialAgent(h.context).call(host, 'service-center', 'request', { url: `https://${host}/ServiceCenter/`, method: 'GET' }), e => {
    assert.equal(publicError(e).code, 'CREDENTIAL_AGENT_RESPONSE_INVALID');
    assert.doesNotMatch(publicError(e).message, /tenant|redacted/); return true;
  });
  assert.equal(publicError({ code: 'CREDENTIAL_password_value', message: 'secret' }).code, 'INTERNAL_ERROR');
});

test('private error outcomes and metadata normalization notes use closed projections', async () => {
  for (const executed of [false, true, null]) {
    const error = publicError({ code: 'CREDENTIAL_RESPONSE_STRUCTURE_REDACTED', executed, message: 'private', arbitrary: 'private' });
    assert.equal(error.executed, executed); assert.equal(error.arbitrary, undefined); assert.doesNotMatch(error.message, /^private$/);
  }
  assert.equal('executed' in publicError({ code: 'CREDENTIAL_RESPONSE_INVALID', executed: 'private' }), false);
  const notes = ['Response redirect metadata was normalized or withheld to preserve the approved origin.', 'Response content type was normalized to a recognized media type and charset.'];
  const h = harness({ reply: args => ({ status: 200, body: 'e30=', contentType: 'application/json', url: args.url, notes: [...notes, 'private'] }) });
  const value = await new CredentialAgent(h.context).call(host, 'service-center', 'request', { url: `https://${host}/ServiceCenter/`, method: 'GET' });
  assert.deepEqual(value.notes, notes);
});

test('credential cold reads reserve authentication time while explicit Studio retains default budget', async () => {
  const h = harness(); await h.within(async () => {
    const a = access(); assert.deepEqual(a.credentialReadBudget({ auth: 'portal-credential' }), { timeoutMs: 120000 });
    assert.deepEqual(a.credentialReadBudget({ auth: 'api-client' }), { timeoutMs: 120000 });
    assert.deepEqual(a.credentialReadBudget({ auth: 'studio' }), {});
  });
});

test('expired credential read cannot send a later transport and same fingerprint reconciles without replay', async () => {
  let release; const pause = new Promise(r => release = r); let sends = 0;
  const h = harness({ reply: () => { sends++; return {}; } });
  const agent = new CredentialAgent(h.context), key = { test: 'credential-expired-' + Math.random() };
  const work = async () => { await pause; return agent.call(host, 'service-center', 'request', { url: `https://${host}/ServiceCenter/`, method: 'GET' }); };
  const timed = await boundedRead(key, work, { timeoutMs: 5 });
  assert.equal(timed.code, 'READ_DEADLINE_EXCEEDED'); release();
  await new Promise(r => setImmediate(r));
  const reconciled = await boundedRead(key, () => assert.fail('must not replay'));
  assert.equal(reconciled.code, 'READ_DEADLINE_EXCEEDED'); assert.equal(sends, 0);
});

for (const service of ['service-center', 'odc-portal']) test(`${service} binds default selection before login and reuses the same explicit session`, async () => {
  const sessions = new Set(); let logins = 0, reads = 0;
  const selectedHost = service === 'service-center' ? host : portalHost;
  const h = harness({ reply: args => {
    const key = args.profile ?? 'default';
    if (args.op === 'status') return { available: true, authenticated: sessions.has(key), profile, principal };
    if (args.op === 'login') { assert.equal(key, profile); sessions.add(key); logins++; return { authenticated: true }; }
    if (args.op === 'request') {
      assert.equal(key, profile); assert.equal(sessions.has(key), true, 'request must have the exact session created by login'); reads++;
      return { status: 200, body: Buffer.from('{}').toString('base64'), contentType: 'application/json', url: args.url };
    }
    assert.fail('No prompt or retry expected');
  } });
  const agent = new CredentialAgent(h.context);
  for (let i = 0; i < 2; i++) {
    const selected = await agent.resolve(selectedHost, service);
    if (service === 'service-center') await agent.scBridge(selectedHost, selected.profile).web(selectedHost, 'fetch', { path: '/ServiceCenter/Errors_List.aspx', method: 'GET' });
    else await agent.portalBroker(selectedHost, selected.profile).request(`https://${selectedHost}/api/test`);
  }
  assert.equal(logins, 1); assert.equal(reads, 2);
});

test('Service Center auto falls back from expired Studio web session to the private agent', async () => {
  const h = harness(); await h.within(async () => {
    const resolved = await resolver().resolve('web'); assert.equal(resolved.path, 'agent-vault');
    const transport = new StudioWebTransport(host, resolved.bridge);
    const [, , body] = await transport.fetch(`https://${host}/ServiceCenter/Errors_List.aspx`);
    assert.match(body.toString(), /Protected page/);
    assert.deepEqual(h.calls.map(c => c.op), ['status', 'status', 'request']);
  });
});
test('Service Center missing credentials opens one private window and returns the same read continuation', async () => {
  const h = harness({ available: false }); await h.within(async () => {
    const args = ['logs', '--host', host, '--session', 'vault'];
    const result = await runServiceCenter(args, { locate: async () => null });
    assert.equal(result.code, 'CREDENTIAL_PROMPT_PENDING', JSON.stringify(result));
    assert.equal(result.continuation.tool, 'o11_service_center_read');
    assert.equal(result.continuation.arguments.host, host);
    assert.deepEqual(h.calls.map(c => c.op), ['status', 'prompt']);
  });
});
test('Service Center explicit Studio and authPrompt never do not open a private window', async () => {
  const h = harness({ available: false }); await h.within(async () => {
    assert.equal((await resolver({ session: 'studio' }).resolve('web')).path, 'studio-http');
    await assert.rejects(resolver({ session: 'vault', prompt: 'never' }).resolve('web'), e => e.code === 'AUTH_REQUIRED');
    assert.equal(h.calls.some(c => c.op === 'prompt'), false);
  });
});
test('a typed expired Studio probe falls back once; unrelated probe errors remain visible', async () => {
  const h = harness(); await h.within(async () => {
    const b = bridge(); b.web = async () => { throw Object.assign(new Error('expired'), { code: 'WEB_SIGN_IN_REQUIRED' }); };
    assert.equal((await resolver({ locate: async () => b }).resolve('web')).path, 'agent-vault');
    b.web = async () => { throw Object.assign(new Error('busy'), { code: 'STUDIO_BUSY' }); };
    await assert.rejects(resolver({ locate: async () => b }).resolve('web'), e => e.code === 'STUDIO_BUSY');
    assert.equal(h.calls.length, 2);
  });
});
test('sc_private_http delegates to the same private session without the server cookie or pipe', async () => {
  const h = harness(); await h.within(async () => {
    const b = new StudioBridge(1, null, { request: () => assert.fail('No Studio or pipe call') });
    const result = await b.privateWeb(host, { method: 'GET', path: '/ServiceCenter/Errors_List.aspx' }, { principal, cookie: 'do-not-forward-cookie' });
    assert.equal(result.status, 200); assert.equal(JSON.stringify(h.calls).includes('do-not-forward-cookie'), false);
    assert.equal(h.calls.at(-1).op, 'request');
  });
});
test('stored profile resolves only on the account agent and rejects another principal', async () => {
  const h = harness(); await h.within(async () => {
    const profiles = new CredentialProfiles({ list: () => assert.fail('No native metadata') });
    const selected = await profiles.resolve({ lane: 'o11', host, principal }, { target: profile, interactive: false });
    assert.equal(selected.ok, true); assert.equal(selected.target, profile);
    assert.equal((await profiles.resolve({ lane: 'o11', host, principal: 'other@example.test' }, { target: profile })).code, 'CREDENTIAL_PROFILE_MISMATCH');
  });
});
for (const auth of ['portal-credential', 'api-client']) test(`Portal ${auth} resolves to private agent instead of hosted refusal`, async () => {
  const h = harness(); await h.within(async () => {
    const a = access(); const result = await (auth === 'api-client' ? a.resolvePublic(portalHost, auth) : a.resolvePortal(portalHost, auth));
    assert.equal(result.path, 'agent-vault'); assert.equal(h.calls[0].auth, auth === 'api-client' ? 'api-client' : 'credential');
    if (auth === 'portal-credential') { const page = await result.broker.request(`https://${portalHost}/apps/`); assert.equal(page.status, 200); }
  });
});
test('public API read sends catalog-generated request privately and returns original read continuation when credentials are absent', async () => {
  const catalog = { get: () => ({ operation: { id: 'test:get:/items', method: 'GET', readOnly: true, path: '/items', parameters: [] },
    api: { id: 'test', basePath: '/api/test', spec: {} } }) };
  const input = { tenant: portalHost, auth: 'api-client', operationId: 'test:get:/items' };
  for (const available of [true, false]) {
    const h = harness({ reply: args => args.op === 'request' ? { status: 200, body: Buffer.from('{"items":[{"name":"example"}]}').toString('base64'), contentType: 'application/json', url: args.url }
      : { available, authenticated: available, visible: true, opened: true } });
    await h.within(async () => {
      const a = access(); a.catalog = catalog;
      const result = await a.read(input);
      if (available) { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.items[0].name, 'example'); assert.equal(h.calls.at(-1).url, `https://${portalHost}/api/test/items`); }
      else { assert.equal(result.code, 'CREDENTIAL_PROMPT_PENDING'); assert.deepEqual(result.continuation.arguments, input); assert.equal(result.continuation.tool, 'odc_read'); }
    });
  }
});
test('older agents retain typed hosted refusals and receive the update link without a private call', async () => {
  const h = harness({ supported: false }); await h.within(async () => {
    await assert.rejects(resolver({ session: 'vault' }).resolve('web'), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY' && /dist.ssam.pro/.test(e.message));
    const a = access(); assert.equal((await a.resolvePublic(portalHost, 'api-client')).code, 'HOSTED_STUDIO_SESSION_ONLY');
    assert.match((await a.openPrompt('portal', portalHost)).error.message, /dist.ssam.pro/);
    assert.deepEqual(h.calls, []);
  });
});
test('private response boundary drops unexpected secret properties and fixes agent error text', async () => {
  const secret = 'sentinel-private-value';
  const h = harness({ reply: args => args.op === 'request' ? { status: 200, body: 'e30=', contentType: 'application/json', url: args.url,
    cookie: secret, token: secret, password: secret, headers: { 'set-cookie': secret } } : { available: true, authenticated: true, password: secret, token: secret } });
  const a = new CredentialAgent(h.context);
  const status = await a.call(host, 'service-center', 'status'); const page = await a.call(host, 'service-center', 'request', { url: `https://${host}/ServiceCenter/` });
  assert.equal(JSON.stringify([status, page]).includes(secret), false);
  h.context.agent.call = async () => { throw Object.assign(new Error(secret), { code: 'CREDENTIAL_LOGIN_FAILED' }); };
  await assert.rejects(a.call(host, 'service-center', 'login'), e => !e.message.includes(secret) && e.code === 'CREDENTIAL_LOGIN_FAILED');
  h.context.agent.call = async () => { throw Object.assign(new Error(secret), { code: 'CREDENTIAL_' + secret.toUpperCase() }); };
  await assert.rejects(a.call(host, 'service-center', 'login'), e => e.code === 'CREDENTIAL_AGENT_FAILED');
});
test('private response boundary rejects cross-host and oversized responses', async () => {
  for (const response of [{ status: 200, body: 'e30=', url: 'https://other.test/' }, { status: 200, body: 'x'.repeat(24 * 1024 * 1024 + 1) }]) {
    const h = harness({ reply: () => response }); const a = new CredentialAgent(h.context);
    await assert.rejects(a.call(host, 'service-center', 'request', { url: `https://${host}/ServiceCenter/` }), e => ['HOST_MISMATCH', 'CREDENTIAL_AGENT_RESPONSE_INVALID'].includes(e.code));
  }
});
test('secret-reference writes remain refused before any private request', async () => {
  const h = harness(); const a = new CredentialAgent(h.context);
  await assert.rejects(a.scBridge(host).web(host, 'fetch', { method: 'POST', path: '/ServiceCenter/', write: true, secretRefs: [{}] }), e => e.code === 'HEADLESS_AUTH_UNAVAILABLE');
  assert.deepEqual(h.calls, []);
});
test('Service Center write authorization is checked before opening a private window or sending a request', async () => {
  const h = harness(); await h.within(async () => {
    const result = await runServiceCenter(['timer-run', '--host', host, '--session', 'vault', '--timer', 'TestTimer', '--execute'], { locate: async () => null });
    assert.equal(result.ok, false); assert.equal(h.calls.length, 0);
  });
});
test('unknown private transport failure never claims that a write was not sent', async () => {
  const h = harness(); h.context.agent.call = async () => { throw new Error('socket lost'); };
  await assert.rejects(new CredentialAgent(h.context).call(host, 'service-center', 'request', { method: 'POST', url: `https://${host}/ServiceCenter/` }),
    e => e.extra.executed !== false);
});
test('private response normalization is retained as an English note in the authentication result', async () => {
  const note = 'Sensitive authentication values were removed from the response.';
  const charsetNote = 'Response text encoding was normalized to UTF-8.';
  let requestCount = 0;
  const h = harness({ reply: args => args.op === 'request' ? { status: 200, body: 'PGh0bWw+PC9odG1sPg==', contentType: 'text/html; charset=utf-8', url: args.url, notes: [requestCount++ ? charsetNote : note, 'untrusted text'] }
    : { available: true, authenticated: true, principal } });
  await h.within(async () => {
    const auth = await resolver({ session: 'vault' }).resolve('web');
    await new StudioWebTransport(host, auth.bridge).fetch(`https://${host}/ServiceCenter/`);
    assert.deepEqual(auth.describe().notes, [note]);
    await new StudioWebTransport(host, auth.bridge).fetch(`https://${host}/ServiceCenter/`);
    assert.deepEqual(auth.describe().notes, [note, charsetNote]);
  });
});
for (const eventAuth of ['basic', 'service-token']) test(`timer-events uses agent ${eventAuth} and preserves completion scope`, async () => {
  const h = harness({ reply: args => args.op === 'request' ? { status: 200, body: Buffer.from(JSON.stringify({ RequestEventList: [], ResultsTruncated: false })).toString('base64'), contentType: 'application/json', url: args.url }
    : { available: true, authenticated: false } });
  await h.within(async () => {
    const result = await readPerformanceEvents({ host, eventAuth, since: '2026-11-02T10:00:00Z', until: '2026-11-02T10:05:00Z' });
    assert.equal(result.ok, true); assert.equal(result.executionCausalityVerified, false);
    assert.deepEqual(h.calls.map(c => c.op), ['status', 'request']);
    assert.equal(h.calls.at(-1).auth, eventAuth);
    assert.equal(new URL(h.calls.at(-1).url).pathname, '/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/');
  });
});
test('hosted credential family does not require a Studio or compiler, while lane and explicit-Studio gates remain', async () => {
  const entry = { class: 'tenant-agent', lane: 'o11', agent: 'always', paths: { in: [], out: [] } };
  const h = harness(); let invoked = 0;
  h.context.agent.connected = () => true;
  h.context.agent.info = () => ({ credential: true, compatible: { o11: { ok: false, code: 'KERNEL_UNAVAILABLE' } } });
  const tool = wrapHostedTool('o11_service_center_session', { inputSchema: {} }, async () => { invoked++; return { content: [], structuredContent: { ok: true } }; },
    { context: h.context, tools: { o11_service_center_session: entry }, kernelRefused: { o11: { code: 'KERNEL_UNAVAILABLE' } } });
  const result = await tool({ action: 'status', session: 'vault', host }, {});
  assert.equal(result.structuredContent.ok, true); assert.equal(invoked, 1);
  const explicit = refusalBeforeAgent('o11_service_center_session', { action: 'status', session: 'studio' }, { entry, lanes: ['o11'], kernelRefused: { o11: {} }, supports: () => true });
  assert.equal(explicit.refusal.code, 'KERNEL_UNAVAILABLE');
  const disabled = refusalBeforeAgent('o11_service_center_session', { action: 'status', session: 'vault' }, { entry, lanes: [], supports: () => true });
  assert.equal(disabled.refusal.code, 'HOSTED_LANE_DISABLED');
});

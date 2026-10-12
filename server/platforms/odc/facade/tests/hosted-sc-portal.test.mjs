// The hosted side of the Service Center and Portal paths of the 24th release (servidor/fase4-24; PLANO-24-PRODUCAO 2.2,
// 5.1 and risks R3, R4). In hosted mode only the session of the user's own Studio reaches a tenant: every other path of
// the 24th release is refused, typed, before any attempt (HOSTED_STUDIO_SESSION_ONLY, HOSTED_PROMPT_UNAVAILABLE), one
// test per family: the private credential profiles, the credential window and authPrompt, sc_private_http*, the Portal
// select-profile and portal-credential, the private Portal transport (portal-private-*), single sign-on and the identity
// protocol, LifeTime, and the direct HTTP of the server (odc3-context). The solution-download records land in the
// customer's workspace, the contextual approval files too, and the Portal request files of odc_read, odc_write and
// odc_portal_* are written in ws:odc/journal/portal/requests and mirrored to the agent, never under a bridge root of the
// server (R4). child_process and net are spies installed before any facade module loads: no PowerShell, no vault, no
// pipe and no socket of this machine.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [], connections = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  spawned.push({ file, args: [...(args ?? [])] });
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
cp.execFileSync = (file, args) => { spawned.push({ file, args, sync: true }); throw new Error('execFileSync is not allowed in hosted tests'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const lib = await import('../lib.mjs');
const { AgentExecutor, HOSTED_REFUSED_COMMANDS, HOSTED_REFUSED_METHODS } = await import('../hosted/agent-executor.mjs');
const { fakeAgentLink } = await import('./fixtures/fake-agent-link.mjs');
const { CredentialProfiles } = await import('../credential-profiles.mjs');
const { Resolver, openPrompt, promptAndWait, storedProfile, hiddenSignIn } = await import('../service-center/auth.mjs');
const { runServiceCenter } = await import('../service-center/index.mjs');
const { StudioBridge } = await import('../service-center/bridge.mjs');
const { ServiceCenterSso } = await import('../service-center/sso.mjs');
const { CommunityIdentity } = await import('../service-center/community-identity.mjs');
const { DownloadContextStore, downloadRoots } = await import('../service-center/download-context.mjs');
const { withPrivateSessionHandoff } = await import('../../portal/runtime/private-session-pipe.mjs');
const { withPrivateCookieExchange } = await import('../service-center/private-cookie-pipe.mjs');
const odc3 = await import('../../portal/runtime/odc3-context.mjs');
const { createFacadeServer } = await import('../mcp.mjs');
const { authorizationContext } = await import('../authorization-context.mjs');

const TENANT = 'customer-x.outsystems.dev';
const SC_HOST = 'customer-x.outsystemscloud.com';
const temps = [];
test.after(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const within = (context, fn) => runWithExecutor(context, fn);
const reset = () => { spawned.length = 0; connections.length = 0; };
const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

// One customer: a workspace, an agent root and the real AgentExecutor over a fake AgentLink (the hub's link in tests).
function customer({ handlers = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sc-portal-')); temps.push(root);
  const workspace = path.join(root, 'server', 'customers', 'tok_' + randomUUID().slice(0, 8));
  prepareWorkspace(workspace);
  fs.writeFileSync(path.join(workspace, 'odc', 'tenants.json'), JSON.stringify({ default: null, tenants: { [TENANT]: { portalOrigin: 'https://' + TENANT, class: 'personal' } } }));
  const agentRoot = path.join(root, 'agent');
  for (const dir of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private']) fs.mkdirSync(path.join(agentRoot, dir), { recursive: true });
  const link = fakeAgentLink({ agentRoot, handlers: {
    'studio.processes': ({ image }) => ({ processes: image === 'ODCStudio.exe' ? [{ pid: 4120, path: 'C:\\Customer\\ODCStudio.exe', version: '1.7.27.4021' }] : [] }), ...handlers } });
  const executor = new AgentExecutor({ link, workspace, o11: {} });
  const context = { id: randomUUID(), hosted: true, tokenId: link.tokenId, customer: 'Cliente X', lanes: ['odc', 'o11'], workspace, agent: link, executor, close: async () => {} };
  return { root, workspace, agentRoot, link, executor, context };
}
// The bridge of a customer's Service Studio as the Service Center modules see it.
const scBridge = ({ capabilities = ['sc_http:studioSession'], signedIn = true } = {}) => ({ pid: 5150, version: 'thin',
  supports: async () => true, capabilities: async () => new Set(capabilities),
  session: async () => ({ studio: { signedIn, user: signedIn ? 'dev@customer' : null } }),
  web: async (host, verb) => ({ signedIn: true, submitted: verb === 'login' }) });

test('private credential profiles: never listed, selected, remembered or prompted hosted; createAccess and the Service Center keep them null', async () => {
  reset();
  const h = customer();
  const used = [];
  const fake = { resolve: async () => { used.push('resolve'); return { ok: true, principal: 'x', target: 'SSAM/O11/x/ServiceCenter' }; },
    remember: async () => used.push('remember'), select: async () => used.push('select') };
  await within(h.context, async () => {
    const profiles = new CredentialProfiles();
    for (const result of [await profiles.resolve({ lane: 'o11', host: SC_HOST, principal: 'dev@customer' }),
      await profiles.remember({ lane: 'odc', host: TENANT }, { target: 'SSAM/ODC3/' + TENANT + '/Portal', principal: 'dev' }),
      await profiles.select({ lane: 'odc', host: TENANT }, { target: 'SSAM/ODC3/' + TENANT + '/Portal', principal: 'dev', authorize: 'use dev on ' + TENANT })])
      assert.equal(result.code, 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(storedProfile({ profiles: fake, host: SC_HOST }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    // The OdcAccess of the customer has no profiles; the Service Center main never takes the profiles it is given.
    assert.equal((await lib.createAccess()).profiles, null, 'CredentialProfiles is null in hosted mode');
    const signIn = await runServiceCenter(['session-sign-in', '--host', SC_HOST], { locate: async () => null, profiles: fake, present: async () => true });
    assert.equal(signIn.code, 'STUDIO_NOT_CONNECTED');
    const target = await runServiceCenter(['session-status', '--host', SC_HOST, '--credential-target', 'SSAM/O11/' + SC_HOST + '/ServiceCenter'], { locate: async () => null, profiles: fake });
    assert.equal(target.code, 'HOSTED_STUDIO_SESSION_ONLY', JSON.stringify(target));
  });
  assert.deepEqual(used, [], 'no profile of the server was used');
  assert.deepEqual(spawned, [], 'no PowerShell of the credential profiles'); assert.deepEqual(connections, []);
});

test('the credential window and authPrompt: no prompt opens hosted; the flows that would open it answer HOSTED_PROMPT_UNAVAILABLE', async () => {
  reset();
  const h = customer();
  const opened = [], asked = [];
  const opener = async (...args) => { opened.push(args); return { opened: true }; };
  const present = async target => { asked.push(target); return false; };
  await within(h.context, async () => {
    assert.throws(() => openPrompt(SC_HOST, 'ServiceCenter'), e => e.code === 'HOSTED_PROMPT_UNAVAILABLE');
    await assert.rejects(promptAndWait({ host: SC_HOST, target: 'SSAM/O11/' + SC_HOST + '/ServiceCenter', opener, present, why: 'test' }), e => e.code === 'HOSTED_PROMPT_UNAVAILABLE');
    // authPrompt auto with nothing signed in: the Studio's own refusal, never the window.
    for (const [bridge, code] of [[null, 'STUDIO_NOT_CONNECTED'], [scBridge({ signedIn: false }), 'STUDIO_NOT_SIGNED_IN'], [scBridge({ capabilities: [] }), 'STUDIO_BRIDGE_OUTDATED']]) {
      const resolver = new Resolver(SC_HOST, { prompt: 'auto', locate: async () => bridge, present, running: async () => false, opener });
      await assert.rejects(resolver.resolve('web'), e => e.code === code, code);
    }
    // The customer's signed-in Studio is the path (headless sc_http), with authPrompt auto too.
    const ok = await new Resolver(SC_HOST, { prompt: 'auto', locate: async () => scBridge(), present, running: async () => true, opener }).resolve('web');
    assert.equal(ok.path, 'studio-http');
    // The Portal prompts of the customer's OdcAccess.
    const access = await lib.createAccess();
    assert.equal((await access.openPrompt('api-client', TENANT)).code, 'HOSTED_PROMPT_UNAVAILABLE');
    assert.equal((await access.openPrompt('portal', TENANT)).code, 'HOSTED_PROMPT_UNAVAILABLE');
  });
  assert.deepEqual(opened, []); assert.deepEqual(asked, [], 'the vault of the server is never asked');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('sc_private_http and sc_private_http_cookie: refused before any call, by the Service Center bridge and by the executor', async () => {
  reset();
  const h = customer({ handlers: { 'o11.bridge': () => assert.fail('nothing reaches the agent') } });
  assert.deepEqual([...HOSTED_REFUSED_METHODS].sort(), ['sc_private_http', 'sc_private_http_cookie']);
  await within(h.context, async () => {
    const sent = [];
    const bridge = new StudioBridge(41001, null, { request: async (...args) => { sent.push(args); return { success: true, data: {} }; } });
    await assert.rejects(bridge.privateWeb(SC_HOST, { method: 'GET', path: '/ServiceCenter/Home.aspx' }, { principal: 'dev' }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY' && e.extra?.executed === false);
    assert.deepEqual(sent, []);
    for (const method of HOSTED_REFUSED_METHODS)
      await assert.rejects(h.executor.call('o11.bridge', { method, params: { host: SC_HOST } }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY' && e.executed === false, method);
  });
  assert.deepEqual(h.link.calls, [], 'nothing was sent to the agent');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('Portal select-profile and auth portal-credential: HOSTED_STUDIO_SESSION_ONLY before any profile, vault or broker', async () => {
  reset();
  const h = customer({ handlers: { 'odc.pipe': ({ args }) => ({ line: JSON.stringify(args[0] === 'auth-status'
    ? { ok: true, bridge: 'v96', sessions: [{ host: TENANT, loggedIn: true, user: 'dev@customer' }], portalWindows: [], capabilities: ['portal-session:headless'] }
    : { ok: true, host: TENANT, signedIn: true }) }) } });
  await within(h.context, async () => {
    const access = await lib.createAccess();
    for (const auth of ['auto', 'studio', 'portal-credential']) {
      const value = await access.portalLogin({ tenant: TENANT, auth, action: 'select-profile', profile: { target: 'SSAM/ODC3/' + TENANT + '/Portal', principal: 'dev' }, authorize: 'select dev on ' + TENANT });
      assert.equal(value.code, 'HOSTED_STUDIO_SESSION_ONLY', auth + ': ' + JSON.stringify(value));
    }
    assert.equal((await access.portalLogin({ tenant: TENANT, auth: 'portal-credential' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
    assert.equal((await access.portalRead({ tenant: TENANT, auth: 'portal-credential', operationId: 'monitoring.stages' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
    assert.equal((await access.read({ tenant: TENANT, auth: 'api-client', operationId: 'asset-repository-api-v1:get:/assets' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(access.vault.portal(TENANT), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    assert.throws(() => access.portalBroker(TENANT), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
  });
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('portal-private-*: the private Portal transport is refused before staging or sending, whatever path asks; its pipes never open', async () => {
  reset();
  const h = customer({ handlers: { 'odc.pipe': ({ args }) => ({ line: JSON.stringify({ ok: true, command: args[0] }) }) } });
  assert.deepEqual([...HOSTED_REFUSED_COMMANDS].sort(), ['portal-api-client-fixture-cleanup', 'portal-private-call', 'portal-private-download', 'portal-upload']);
  const request = path.join(h.workspace, 'odc', 'journal', 'portal', 'requests', 'private.json');
  fs.mkdirSync(path.dirname(request), { recursive: true }); fs.writeFileSync(request, '{}');
  await within(h.context, async () => {
    for (const command of HOSTED_REFUSED_COMMANDS)
      await assert.rejects(h.executor.call('odc.pipe', { pid: 4120, version: 'v96', args: [command, request, randomUUID(), '--tenant', TENANT] }),
        e => e.code === 'HOSTED_STUDIO_SESSION_ONLY' && e.sent === false, command);
    // studio_command passes any command: the private ones come back typed, nothing reached the agent.
    const facade = await createFacadeServer();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'hosted-sc-portal', version: '1.0.0' });
    await Promise.all([facade.connect(serverSide), client.connect(clientSide)]);
    try {
      const value = (await client.callTool({ name: 'studio_command', arguments: { command: 'portal-private-call', args: [request, randomUUID(), '--tenant', TENANT] } })).structuredContent;
      assert.equal(value.code, 'HOSTED_STUDIO_SESSION_ONLY', JSON.stringify(value));
    } finally { await client.close(); await facade.close(); }
    // The handoff pipes of the private transport (Portal and Service Center) never open in hosted mode.
    const connect = () => assert.fail('no pipe is opened');
    const scope = { host: TENANT, principal: 'dev@customer', requestSha256: 'a'.repeat(64), cookie: 'c=1', url: 'https://' + TENANT + '/x', applyCookies: async () => {} };
    await assert.rejects(withPrivateSessionHandoff(scope, async () => assert.fail('no bridge call'), { connect, platform: 'win32' }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(withPrivateCookieExchange(scope, async () => assert.fail('no bridge call'), { connect, platform: 'win32' }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
  });
  const sent = h.link.calls.filter(c => c.kind === 'odc.pipe').map(c => c.params.args[0]);
  assert.ok(!sent.some(c => HOSTED_REFUSED_COMMANDS.includes(c)), 'no private command reached the agent: ' + sent.join(', '));
  assert.ok(!h.link.calls.some(c => c.kind === 'file.put' && /private\.json/.test(c.params.path)), 'the request was never staged');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('single sign-on, the identity protocol and LifeTime: refused before any request (sso, community-identity, LifeTime actions)', async () => {
  reset();
  const h = customer();
  const fetched = [];
  const fetchImpl = async (...args) => { fetched.push(args); throw new Error('no HTTP in hosted tests'); };
  await within(h.context, async () => {
    assert.throws(() => new ServiceCenterSso({ host: SC_HOST, principal: 'dev', target: 'SSAM/O11/' + SC_HOST + '/ServiceCenter', fetchImpl }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    assert.throws(() => new CommunityIdentity({ host: SC_HOST, principal: 'dev', target: 't', fetchImpl }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    const createSso = () => assert.fail('no single sign-on in hosted mode');
    for (const argv of [['lifetime-web-status', '--host', SC_HOST, '--session', 'vault'], ['lifetime-capabilities', '--host', SC_HOST, '--session', 'vault'],
      ['session-sign-in', '--host', SC_HOST, '--surface', 'lifetime'], ['timer-events', '--host', SC_HOST, '--session', 'vault', '--since', '2026-10-01', '--until', '2026-10-02']]) {
      const value = await runServiceCenter(argv, { locate: async () => scBridge(), createSso, present: async () => true, opener: async () => assert.fail('no prompt') });
      assert.equal(value.code, 'HOSTED_STUDIO_SESSION_ONLY', argv[0] + ': ' + JSON.stringify(value));
    }
    await assert.rejects(new Resolver(SC_HOST, { locate: async () => scBridge(), present: async () => true }).resolve('lifetime'), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(new Resolver(SC_HOST, { session: 'vault', locate: async () => scBridge(), present: async () => true }).resolve('web'), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
  });
  assert.deepEqual(fetched, [], 'no HTTP request left the server'); assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('the direct HTTP of the server (odc3-context): its vault, broker and host context refuse hosted before any request or PowerShell', async () => {
  reset();
  const h = customer();
  const fetched = [];
  await within(h.context, async () => {
    await assert.rejects(odc3.portalVault('status', 'https://' + TENANT), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    assert.throws(() => new odc3.Odc3PortalBroker({ origin: 'https://' + TENANT, fetchImpl: async (...a) => { fetched.push(a); } }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
    await assert.rejects(odc3.createOdc3HostContext({ env: {} }), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY');
  });
  // A broker made outside a hosted call still refuses inside one (its request is the HTTP).
  const broker = new odc3.Odc3PortalBroker({ origin: 'https://' + TENANT, credentialProvider: async () => ({ available: false }), fetchImpl: async (...a) => { fetched.push(a); return new Response('{}'); } });
  await within(h.context, async () => assert.rejects(broker.request('https://' + TENANT + '/x'), e => e.code === 'HOSTED_STUDIO_SESSION_ONLY'));
  assert.deepEqual(fetched, []); assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

test('solution-download records: in ws:o11/service-center/downloads, without PowerShell or DPAPI, one per UUID and identity', async () => {
  reset();
  const a = customer(), b = customer();
  const identity = { host: SC_HOST, principal: 'dev@customer', solution: 'Orders' };
  const id = randomUUID();
  const marker = 'PRIVATE_FORM_' + randomUUID();
  const process = { env: { ...globalThis.process.env, SSAM_SC_DOWNLOADS: path.join(a.root, 'owner-downloads') } };
  await within(a.context, async () => {
    const roots = downloadRoots(process.env);
    assert.deepEqual(roots, { root: path.join(a.workspace, 'o11', 'service-center', 'downloads'), legacy: [] }, 'never the owner\'s folders or SSAM_SC_DOWNLOADS');
    const store = new DownloadContextStore();
    assert.deepEqual(await store.create(id, identity, { phase: 'prepared', fields: [['__OSVSTATE', marker]] }), { revision: 0 });
    assert.deepEqual(await store.read(id, identity), { revision: 0, context: { phase: 'prepared', fields: [['__OSVSTATE', marker]] } });
    await assert.rejects(store.create(id, identity, { phase: 'again' }), { code: 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE' });
    await assert.rejects(store.read(id, { ...identity, principal: 'other@customer' }), { code: 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE' });
    assert.deepEqual(await store.replace(id, identity, 0, { phase: 'downloading' }), { revision: 1 });
    await assert.rejects(store.replace(id, identity, 0, { phase: 'stale' }), { code: 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE' });
    const race = await Promise.allSettled([store.replace(id, identity, 1, { phase: 'a' }), store.replace(id, identity, 1, { phase: 'b' })]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1, 'one of two contenders reserves the next send');
    assert.equal((await store.find(id, identity)).revision, 2);
    assert.equal(await store.find(randomUUID(), identity), null);
  });
  const file = path.join(a.workspace, 'o11', 'service-center', 'downloads', id + '.context');
  assert.ok(fs.existsSync(file), 'the record is the customer\'s');
  assert.equal(path.extname(file), '.context', 'not a .json: ssam_evidence never reads the form state');
  assert.equal(fs.existsSync(path.join(a.root, 'owner-downloads')), false);
  // Another customer never finds it.
  await within(b.context, async () => assert.equal(await new DownloadContextStore().find(id, identity), null));
  assert.deepEqual(spawned, [], 'no PowerShell DPAPI on the server'); assert.deepEqual(connections, []);
});

test('authorizationContext hosted: the context and the proposal it names are files of the customer\'s visible workspace, never of the server', async () => {
  reset();
  const h = customer();
  const words = 'pode apagar o Orders em ' + SC_HOST;
  const proposal = path.join(h.workspace, 'inbox', 'proposal.md'); fs.writeFileSync(proposal, 'delete Orders');
  const outsideProposal = path.join(h.root, 'server', 'owner-proposal.md'); fs.writeFileSync(outsideProposal, 'delete Orders');
  const record = file => ({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
    source: { kind: 'human-conversation', threadId: randomUUID(), messageId: randomUUID(), question: 'Delete Orders?' },
    proposal: { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex') },
    scope: [{ lane: 'o11', host: SC_HOST, operation: 'solution-delete', targets: ['Orders'] }] });
  const ctx = (name, value) => { const file = path.join(h.workspace, 'inbox', name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const check = file => authorizationContext(file, words, { lane: 'o11', host: SC_HOST, operation: 'solution-delete', targets: ['Orders'] });
  await within(h.context, async () => {
    assert.equal(check(ctx('ws.json', record('ws:inbox/proposal.md'))).proposalSha256.length, 64, 'a ws: proposal');
    assert.equal(check(ctx('abs.json', record(proposal))).targets[0], 'Orders', 'an absolute proposal inside the workspace');
    assert.equal(check('ws:inbox/ws.json').operation, 'solution-delete', 'a ws: context');
    assert.throws(() => check(ctx('outside.json', record(outsideProposal))), e => e.code === 'AUTHORIZATION_CONTEXT_INVALID', 'a proposal of the server');
    const serverContext = path.join(h.root, 'server', 'owner-context.json'); fs.writeFileSync(serverContext, JSON.stringify(record(proposal)));
    assert.throws(() => check(serverContext), e => e.code === 'AUTHORIZATION_CONTEXT_INVALID', 'a context of the server');
    const stateFile = path.join(h.workspace, 'state', 'ctx.json'); fs.writeFileSync(stateFile, JSON.stringify(record(proposal)));
    assert.throws(() => check(stateFile), e => e.code === 'AUTHORIZATION_CONTEXT_INVALID', 'state/ is internal');
  });
  // Locally an absolute path anywhere is read, as before.
  assert.equal(check(path.join(h.root, 'server', 'owner-context.json')).targets[0], 'Orders');
});

test('R4: odc_read, odc_write, odc_portal_read and odc_portal_write write each request in ws:odc/journal/portal/requests and mirror it to the agent; no bridge root', async () => {
  reset();
  const fetches = [], calls = [];
  const h = customer({ handlers: { 'odc.pipe': ({ args }, link) => {
    if (args[0] === 'auth-status') return { line: JSON.stringify({ ok: true, bridge: 'v96', sessions: [{ host: TENANT, loggedIn: true, user: 'dev@customer' }], portalWindows: [],
      capabilities: ['portal-session:headless', 'portal-call:secretRefs', 'portal-session:secretRefs'] }) };
    if (args[0] === 'portal-call') { calls.push({ file: args[1], request: JSON.parse(link.readAgent(args[1])) });
      return { line: JSON.stringify({ ok: true, status: 200, contentType: 'application/json', body: { items: [], key: 'k' }, source: 'studio', host: TENANT }) }; }
    if (args[0] === 'portal-session' && args[1] === 'fetch') { fetches.push({ file: args[2], request: JSON.parse(link.readAgent(args[2])) });
      return { line: JSON.stringify({ ok: true, host: TENANT, status: 200, text: '{}' }) }; }
    if (args[0] === 'portal-session') return { line: JSON.stringify({ ok: true, host: TENANT, signedIn: true, studioUser: 'dev@customer' }) };
    return { line: JSON.stringify({ ok: false, error: 'unexpected ' + args[0] }) };
  } } });
  const bridgeRequests = path.join(lib.root, 'journal', 'portal', 'requests');
  const before = fs.existsSync(bridgeRequests) ? fs.readdirSync(bridgeRequests) : [];
  const requests = path.join(h.workspace, 'odc', 'journal', 'portal', 'requests');
  const answers = {};
  await within(h.context, async () => {
    const facade = await createFacadeServer();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'hosted-r4', version: '1.0.0' });
    await Promise.all([facade.connect(serverSide), client.connect(clientSide)]);
    try {
      const call = async (name, args) => (answers[name] = (await client.callTool({ name, arguments: args })).structuredContent);
      await call('odc_read', { tenant: TENANT, operationId: 'asset-repository-api-v1:get:/assets' });
      await call('odc_write', { tenant: TENANT, operationId: 'user-access-management-api-v1:patch:/organization-roles/{key}', path: { key: '11111111-1111-4111-8111-111111111111' },
        body: {}, authorize: 'pode mudar o papel no ' + TENANT, operationUuid: randomUUID() });
      await call('odc_portal_read', { tenant: TENANT, operationId: 'monitoring.stages' });
      await call('odc_portal_write', { tenant: TENANT, operationId: 'connections.relationalTest', authorize: 'pode testar a conexao no ' + TENANT, operationUuid: randomUUID(),
        input: { inputParameters: { Common: { ConnectionPassword: '', ConnectionServer: 'db.test' } } } });
    } finally { await client.close(); await facade.close(); }
  });
  assert.ok(calls.length >= 2, 'odc_read and odc_write sent portal-call: ' + JSON.stringify(answers).slice(0, 600));
  assert.ok(calls.some(c => c.request.write === true), 'the write went through portal-call');
  assert.ok(fetches.length >= 1, 'the Portal tools sent portal-session fetch: ' + JSON.stringify(answers).slice(0, 600));
  for (const { file } of [...calls, ...fetches]) {
    assert.match(file, /^agent:odc\/journal\/portal\/requests\/[^/]+\.json$/, 'the agent reads the request from its own odc/journal/portal/requests');
    const server = path.join(requests, path.basename(file));
    assert.ok(fs.existsSync(server) && inside(server, h.workspace), 'the request file is the customer\'s: ' + server);
  }
  const asked = h.link.calls.filter(c => c.kind === 'odc.pipe').map(c => c.params.args);
  assert.ok(!asked.some(a => a[0] === 'status' && a[1] === 'root'), 'the bridge root is never asked');
  assert.deepEqual(fs.existsSync(bridgeRequests) ? fs.readdirSync(bridgeRequests) : [], before, 'nothing under the bridge root of this server');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

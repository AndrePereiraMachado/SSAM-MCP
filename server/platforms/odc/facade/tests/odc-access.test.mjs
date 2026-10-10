import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { ACCESS_TOOLS, registerAccessTools } from '../odc-access.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';
import { PORTAL_CAPTURE } from '../../portal/runtime/portal-routes.mjs';

// The same result shape as mcp.mjs: isError when value.ok === false.
const wrap = fn => async args => { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) }; };
async function connect(access) {
  const server = new McpServer({ name: 't', version: '0' });
  registerAccessTools(server, access, wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const CLI = /`odc |odc portal|internal-routes|pwsh|powershell|\.ps1|python|--match|--tenant|--view/i;

// The MCP surface of the tenant-aware access, over an in-memory transport and a recording fake of OdcAccess.
test('access tools: one per capability, writes need words and a UUID, no credential argument exists', async () => {
  const seen = [];
  const method = name => async input => { seen.push([name, input]); return { ok: name !== 'write', echo: name }; };
  const access = Object.fromEntries(['authStatus', 'read', 'write', 'receipt', 'portalRead', 'portalWrite', 'portalLogin', 'portalRoutes', 'operationStatus', 'deploy', 'configurations', 'assetDelete', 'externalDbConnection'].map(n => [n, method(n)]));
  const { client, close } = await connect(access);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), [...ACCESS_TOOLS].sort());
    for (const tool of tools) {
      assert.equal(Object.keys(tool.inputSchema.properties ?? {}).some(k => /password|secret|token|clientId|cookie/i.test(k)), false, tool.name);
      if (['odc_write', 'odc_portal_write', 'odc_deploy', 'odc_asset_delete'].includes(tool.name)) {
        assert.equal(tool.annotations.destructiveHint, true, tool.name);
        assert.ok(tool.inputSchema.required.includes('authorize') && tool.inputSchema.required.includes('operationUuid'), tool.name);
      }
    }
    assert.deepEqual(tools.find(t => t.name === 'odc_read').inputSchema.properties.auth.enum, ['auto', 'studio', 'api-client']);
    assert.deepEqual(tools.find(t => t.name === 'odc_portal_read').inputSchema.properties.auth.enum, ['auto', 'studio', 'portal-credential']);
    const read = await client.callTool({ name: 'odc_read', arguments: { tenant: 'personal-x.outsystems.dev', operationId: 'portfolio-api-v2:get:/environments' } });
    assert.equal(read.structuredContent.echo, 'read');
    assert.deepEqual(seen.at(-1), ['read', { tenant: 'personal-x.outsystems.dev', operationId: 'portfolio-api-v2:get:/environments', auth: 'auto' }]);
    const write = await client.callTool({ name: 'odc_write', arguments: { operationId: 'x', authorize: 'the user said yes', operationUuid: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(write.isError, true);
    const refused = await client.callTool({ name: 'odc_write', arguments: { operationId: 'x', authorize: 'the user said yes', operationUuid: 'nope' } })
      .catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(refused.isError, true); assert.equal(seen.filter(s => s[0] === 'write').length, 1);
    const extra = await client.callTool({ name: 'odc_external_db_connection', arguments: { action: 'create', password: 'x' } })
      .catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(extra.isError, true); assert.equal(seen.some(s => s[0] === 'externalDbConnection'), false);
  } finally { await close(); }
});

// Lane extlib: odc_asset_delete names the consumer rule (read before anything is reserved) and odc_portal_write lists
// the External Library publish route; a consumers refusal reaches the client as a refusal with its consumers.
test('odc_asset_delete states the consumers rule and forwards CONSUMERS_WOULD_BREAK; odc_portal_write lists externalLibraries.publishJob', async () => {
  const access = { assetDelete: async () => ({ ok: false, code: 'CONSUMERS_WOULD_BREAK', sent: false, consumers: ['OrdersApp'], error: { code: 'CONSUMERS_WOULD_BREAK', message: 'OrdersApp would break' },
    problems: [{ code: 'CONSUMERS_WOULD_BREAK', target: 'OrdersApp', message: 'm', fix: 'f', ssamRule: true }] }) };
  for (const name of ['authStatus', 'read', 'write', 'receipt', 'portalRead', 'portalWrite', 'portalLogin', 'portalRoutes', 'operationStatus', 'deploy', 'configurations', 'externalDbConnection']) access[name] = async () => ({ ok: true });
  const { client, close } = await connect(access);
  try {
    const tools = (await client.listTools()).tools;
    const del = tools.find(t => t.name === 'odc_asset_delete');
    assert.match(del.description, /every consumer/); assert.match(del.description, /CONSUMERS_WOULD_BREAK/); assert.match(del.description, /DEPENDENCY_CHECK_UNAVAILABLE/);
    assert.doesNotMatch(del.description, /Consider odc_write dependency-management deletion-analyses first/);
    assert.match(tools.find(t => t.name === 'odc_portal_write').description, /externalLibraries\.publishJob/);
    const out = await client.callTool({ name: 'odc_asset_delete', arguments: { assetKey: 'lib-1', authorize: 'delete SSAMTextTools now', operationUuid: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(out.isError, true); assert.equal(out.structuredContent.code, 'CONSUMERS_WOULD_BREAK'); assert.deepEqual(out.structuredContent.consumers, ['OrdersApp']);
  } finally { await close(); }
});

test('odc_portal_routes: a read tool with the Portal auth enum that passes tenant, auth, module, view and match through', async () => {
  const seen = [];
  const { client, close } = await connect({ portalRoutes: async input => { seen.push(input); return { ok: true, tenant: input.tenant, module: input.module, screens: [], actions: [], truncated: false }; } });
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'odc_portal_routes');
    assert.ok(tool, 'odc_portal_routes is listed');
    assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.idempotentHint, true);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['auth', 'match', 'module', 'tenant', 'view']);
    assert.deepEqual(tool.inputSchema.required, ['module']);
    assert.deepEqual(tool.inputSchema.properties.auth.enum, ['auto', 'studio', 'portal-credential']);
    assert.doesNotMatch(tool.description, CLI);
    const args = { tenant: 'personal-x.outsystems.dev', auth: 'portal-credential', module: 'connections', view: 'Connections.connection', match: 'Delete' };
    const out = await client.callTool({ name: 'odc_portal_routes', arguments: args });
    assert.equal(out.isError, undefined); assert.deepEqual(seen.at(-1), args);
    await client.callTool({ name: 'odc_portal_routes', arguments: { module: 'apps' } });
    assert.deepEqual(seen.at(-1), { module: 'apps', auth: 'auto' });
    const unknown = await client.callTool({ name: 'odc_portal_routes', arguments: { module: 'apps', url: 'https://x' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(unknown.isError, true); assert.equal(seen.length, 2);
    // No tool description tells the model to run a command line.
    for (const t of (await client.listTools()).tools) assert.doesNotMatch(t.description, CLI, t.name);
  } finally { await close(); }
});

// The real OdcAccess behind the tools, on fakes of the ODC Studio bridge (auth-status, portal-session), the vault and
// the prompt: nothing here reaches a Studio, a vault, a tenant or a window.
const PERSONAL = 'personal-test.outsystems.dev', CORPORATE = 'corp.outsystems.dev';
const ASSETS = {
  '/connections/moduleservices/moduleversioninfo': JSON.stringify({ versionToken: 'v-1' }),
  '/connections/': '<script src="scripts/connections._osbundle-1.index.js"></script>',
  '/connections/scripts/connections._osbundle-1.index.js': 'x={screenName:"Connections.connections"},{screenName:"Connections.connection",load:()=>import("./connections.Connections.connection.mvc.js")}',
  '/connections/scripts/connections.Connections.connection.mvc.js': '"screenservices/connections/Connections/connection/ActionFixture_Delete","av1";"screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB","av2";"screenservices/other/X/y/ActionZ","av3"',
};
function realAccess({ apiClient = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-access-mcp-'));
  const calls = [], gets = [], requests = new Map(), prompts = [];
  let n = 0;
  const studio = { running: async () => true, call: async args => {
    calls.push(args);
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v32', sessions: [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }], portalWindows: [] };
    if (args[0] === 'portal-session' && args[1] === 'fetch') {
      const request = requests.get(args[2]); gets.push(request);
      return Object.hasOwn(ASSETS, request.path) ? { ok: true, status: 200, host: PERSONAL, text: ASSETS[request.path] } : { ok: false, code: 'REMOTE_ERROR' };
    }
    if (args[0] === 'portal-session') return { ok: true, host: args.at(-1), signedIn: true };
    if (args[0] === 'portal-call') throw new Error('no public call in this test');
    return { ok: false, error: 'Unknown command' };
  } };
  const vault = { apiClient: async () => ({ available: apiClient }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } };
  const prompt = { apiClient: async host => { prompts.push(host); return { opened: true }; }, portal: async host => { prompts.push(host); return { opened: true }; } };
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: PERSONAL, tenants: { [PERSONAL]: { class: 'personal' }, [CORPORATE]: { class: 'corporate' } } },
    studio, vault, prompt, portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {}, status: () => ({}) }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {},
    requestFile: json => { const file = path.join(dir, 'req-' + (++n) + '.json'); requests.set(file, json); return file; } });
  return { access, calls, gets, prompts };
}

test('odc_portal_routes on the real access: short answer, GETs only, refused modules never touch a session', async () => {
  const h = realAccess();
  const { client, close } = await connect(h.access);
  try {
    const out = (await client.callTool({ name: 'odc_portal_routes', arguments: { tenant: PERSONAL, module: 'connections', view: 'Connections.connection' } })).structuredContent;
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(Object.keys(out).sort(), ['actions', 'module', 'next', 'ok', 'screens', 'tenant', 'truncated', 'view']);
    assert.deepEqual([out.tenant, out.module, out.view, out.truncated], [PERSONAL, 'connections', 'Connections.connection', false]);
    assert.deepEqual(out.screens, ['Connections.connection', 'Connections.connections']);
    assert.deepEqual(out.actions, [{ action: 'connections/Connections/connection/ActionFixture_Delete', mapped: false },
      { action: 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB', mapped: true }]);
    assert.doesNotMatch(out.next, CLI);
    assert.ok(h.gets.length > 0 && h.gets.every(g => g.method === 'GET' && g.write === false && g.body === undefined), 'GETs only');
    const plain = (await client.callTool({ name: 'odc_portal_routes', arguments: { tenant: PERSONAL, module: 'connections', view: 'Connections.connection', match: 'convert' } })).structuredContent;
    assert.deepEqual(plain.actions.map(a => a.mapped), [true]); assert.equal(plain.next, undefined); assert.equal('view' in plain, true);
    const before = h.calls.length;
    for (const module of ['authentication', 'identity', 'api', 'Identity', ' API ', '../connections']) {
      const refused = await client.callTool({ name: 'odc_portal_routes', arguments: { tenant: PERSONAL, module } });
      assert.equal(refused.isError, true, module); assert.equal(refused.structuredContent.error.code, 'INPUT_INVALID', module);
    }
    assert.equal(h.calls.length, before, 'a refused module reaches no bridge, session or prompt'); assert.deepEqual(h.prompts, []);
  } finally { await close(); }
});

test('refusals answer code and one callable continuation {tool, arguments, why}, never a command line', async () => {
  const h = realAccess({ apiClient: true });
  const { client, close } = await connect(h.access);
  try {
    // An unmapped route: the continuation is its capture step, with the tenant, at the top of the answer.
    for (const id of Object.keys(PORTAL_CAPTURE)) {
      const out = (await client.callTool({ name: 'odc_portal_write', arguments: { tenant: PERSONAL, operationId: id, input: {}, authorize: 'yes, do it on the personal tenant', operationUuid: crypto.randomUUID() } })).structuredContent;
      assert.equal(out.code, 'PORTAL_ROUTE_UNMAPPED', id); assert.equal(out.error.continuation, undefined, id);
      assert.deepEqual(out.continuation.tool, 'odc_portal_routes'); assert.deepEqual(out.continuation.arguments, { ...PORTAL_CAPTURE[id], tenant: PERSONAL });
      assert.equal(typeof out.continuation.why, 'string'); assert.doesNotMatch(JSON.stringify(out), CLI, id);
    }
    // While connections.delete is a gap (W17 pending), the typed helper refuses it the same way and the step is callable as it stands.
    if (PORTAL_CAPTURE['connections.delete']) {
      const del = (await client.callTool({ name: 'odc_external_db_connection', arguments: { tenant: PERSONAL, action: 'delete', connectionId: 'c-1' } })).structuredContent;
      assert.equal(del.code, 'PORTAL_ROUTE_UNMAPPED'); assert.deepEqual(del.continuation.arguments, { ...PORTAL_CAPTURE['connections.delete'], tenant: PERSONAL });
      const step = await client.callTool({ name: del.continuation.tool, arguments: del.continuation.arguments });
      assert.equal(step.structuredContent.ok, true, JSON.stringify(step.structuredContent));
      assert.deepEqual(step.structuredContent.actions, [{ action: 'connections/Connections/connection/ActionFixture_Delete', mapped: false }]);
    }
    // A retry sentence of the access layer becomes this tool with the other auth; a write's words are never echoed.
    const read = (await client.callTool({ name: 'odc_read', arguments: { tenant: CORPORATE, operationId: 'asset-repository-api-v1:get:/assets' } })).structuredContent;
    assert.equal(read.code, 'STUDIO_NOT_SIGNED_IN');
    assert.deepEqual(read.continuation.arguments, { tenant: CORPORATE, operationId: 'asset-repository-api-v1:get:/assets', auth: 'api-client' });
    assert.equal(read.continuation.tool, 'odc_read'); assert.match(read.continuation.why, /auth:"api-client"/);
    const words = 'yes, delete it on corp now';
    const write = (await client.callTool({ name: 'odc_write', arguments: { tenant: CORPORATE, operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: 'a-1' },
      authorize: words, operationUuid: crypto.randomUUID(), confirmTenant: CORPORATE } })).structuredContent;
    assert.equal(write.code, 'STUDIO_NOT_SIGNED_IN'); assert.equal(write.continuation.tool, 'odc_write'); assert.equal(write.continuation.arguments.auth, 'api-client');
    assert.equal('authorize' in write.continuation.arguments, false); assert.match(write.continuation.why, /authorize/);
    assert.doesNotMatch(JSON.stringify(write.continuation), new RegExp(words));
  } finally { await close(); }
});

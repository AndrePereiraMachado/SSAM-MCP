import './fixtures/isolated-profile.mjs';
// CX15 r2, family F3 (D, E): a generic route whose effect has a dedicated tool is refused at the entry (MCP and the .\odc
// CLI), in ONE answer with every problem, with the exact call of the dedicated tool as its continuation, and nothing is
// reserved or sent. E: odc_write DELETE /assets/{assetKey} -> odc_asset_delete (consumers, OML backup, preview, count).
// D: odc_portal_write connections.importEntities/importActions that can unselect anything (IsSelected not true, a selected
// entity left out, an empty list; the current selection is read, read only, and an unreadable one refuses) ->
// odc_external_db_connection remove-entities / import-entities. A save that unselects nothing runs as before.
// Offline: the real OdcAccess over a fake ODC Studio bridge (portal-call) or stubbed Portal reads and transport, the MCP SDK
// (McpServer + Client + InMemoryTransport) with the wrap of mcp.mjs, and the CLI with SSAM_ODC_OFFLINE=1. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap } from '../mcp.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'personal-r2routes.outsystems.dev', CORP = 'acme-r2routes.outsystems.dev';
const LIB = '3f2a9c10-1b2c-4d3e-8f40-5a6b7c8d9e01', APP = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const CONN = '11111111-2222-4333-8444-555555555555';
const DELETE_ASSET = 'asset-repository-api-v1:delete:/assets/{assetKey}';
const NEEDS = 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
const codes = answer => (answer.problems ?? []).map(p => p.code);
const files = dir => { const out = []; const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : out.push(f); } }; walk(dir); return out; };

// The real OdcAccess on the tenant HOST (personal) and CORP (corporate); a fake ODC Studio bridge serves portal-call over an
// in-memory tenant (OrdersLib consumed by OrdersApp). portal: optional stubs of portalRead/resolvePortal (the D cases).
async function world({ portal = null } = {}) {
  const dir = tmp('cx15r2-routes-'), root = path.join(dir, 'destructive');
  const assets = { [LIB]: { assetKey: LIB, name: 'OrdersLib', revision: 4, assetType: 'Library' }, [APP]: { assetKey: APP, name: 'OrdersApp', revision: 7, assetType: 'App' } };
  const consumersOf = { [LIB]: [{ key: APP, name: 'OrdersApp', type: 'App', revision: 7 }] };
  const writes = [], gets = [], requests = new Map(); let n = 0;
  const reply = (body, status = 200) => ({ ok: true, status, contentType: 'application/json', body, host: HOST });
  const tenantCall = request => {
    const route = request.basePath + request.path; let m;
    if (request.method !== 'GET') writes.push(request.method + ' ' + route); else gets.push(route);
    if (route === '/api/portfolios/v2/environments') return reply({ results: [{ key: 'dev' }, { key: 'qa' }] });
    if ((m = /^\/api\/dependency-management\/v1\/assets\/([^/]+)\/consumers$/.exec(route))) return reply({ results: assets[m[1]] ? (consumersOf[m[1]] ?? []) : [] });
    if ((m = /^\/api\/asset-repository\/v1\/assets\/([^/]+)$/.exec(route))) {
      if (request.method === 'DELETE') { delete assets[m[1]]; return { ok: true, status: 204, host: HOST }; }
      return assets[m[1]] ? reply(assets[m[1]]) : reply({ title: 'not found' }, 404);
    }
    return reply({ title: 'unexpected ' + request.method + ' ' + route }, 400);
  };
  const studio = { running: async () => true, call: async args => {
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v38', sessions: [{ host: HOST, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] };
    if (args[0] === 'portal-call') return tenantCall(requests.get(args[1]));
    return { ok: false, error: 'Unknown command ' + args[0] };
  } };
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' }, [CORP]: { class: 'corporate' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } },
    prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) },
    portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {},
    requestFile: json => { const file = 'req-' + (++n); requests.set(file, structuredClone(json)); return file; } });
  // D: the Portal reads and the screenservice transport, counted (no session, no network).
  const portalLog = { reads: [], sends: [] };
  if (portal) {
    access.portalRead = async ({ operationId, input }) => { portalLog.reads.push(operationId); return portal.read(operationId, input); };
    access.resolvePortal = async () => ({ ok: true, path: 'vault', broker: { callScreenservice: async request => { portalLog.sends.push(structuredClone(request.input)); return { data: {} }; } } });
  }
  const clock = { t: Date.parse('2026-10-15T12:00:00.000Z') };
  const server = new McpServer({ name: 'cx15r2-routes', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { now: () => clock.t, root }), wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r2-routes-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { dir, root, access, assets, writes, gets, portalLog, clock,
    call: async (name, args) => valueOf(await client.callTool({ name, arguments: args })),
    wait: () => { clock.t += CONFIRM_MIN_AGE_MS + 1000; },
    receiptFiles: () => files(path.join(dir, 'receipts')).filter(f => f.endsWith('.json')),
    close: async () => { await client.close(); await server.close(); } };
}

// ---------------------------------------------------------------- E
test('E: odc_write DELETE /assets/{assetKey} is one refusal with odc_asset_delete as its continuation; the two calls of the review send nothing', async () => {
  const w = await world();
  try {
    const first = await w.call('odc_write', { tenant: HOST, operationId: DELETE_ASSET, path: { assetKey: LIB } });
    assert.equal(first.code, NEEDS, JSON.stringify(first).slice(0, 400));
    assert.equal(first.sent, false); assert.equal(first.outcome, 'not-sent');
    assert.deepEqual(first.continuation.tool, 'odc_asset_delete');
    assert.deepEqual(first.continuation.arguments, { tenant: HOST, assetKey: LIB });
    assert.ok(codes(first).includes(NEEDS)); assert.match(first.problems[0].message, /consumers/);
    assert.equal(first.confirmationToken, undefined, 'no preview, no token');
    // The review's second call (the token of the first, the owner's reply with the count): still refused, nothing sent.
    w.wait();
    const second = await w.call('odc_write', { tenant: HOST, operationId: DELETE_ASSET, path: { assetKey: LIB },
      confirmationToken: first.confirmationToken ?? 'r2routes.synthetic-token', operationUuid: first.confirmationToken ? first.operationId : crypto.randomUUID(), authorize: 'confirmo, pode apagar o 1, a OrdersLib' });
    assert.deepEqual(second.route, { tool: 'odc_write', operationId: DELETE_ASSET });
    assert.equal(second.code, NEEDS, JSON.stringify(second).slice(0, 400));
    assert.deepEqual(w.writes, [], 'no DELETE reached the tenant');
    assert.ok(w.assets[LIB], 'OrdersLib still exists');
    assert.deepEqual(w.receiptFiles(), [], 'nothing was reserved');
    assert.deepEqual(files(path.join(w.root, 'previews')), [], 'no preview was written');
    assert.deepEqual(files(path.join(w.root, 'backups')), [], 'no JSON backup was written');
  } finally { await w.close(); }
});

test('E: the continuation is callable; the words of the refused call never confirm the dedicated preview; consumers break as before', async () => {
  const w = await world();
  try {
    const said = 'confirmo, pode apagar o 1, a OrdersLib';
    const refused = await w.call('odc_write', { tenant: HOST, operationId: DELETE_ASSET, path: { assetKey: LIB }, authorize: said, operationUuid: crypto.randomUUID() });
    assert.equal(refused.code, NEEDS);
    const preview = await w.call(refused.continuation.tool, refused.continuation.arguments);
    assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 400));
    assert.deepEqual(preview.items.map(i => [i.name, i.consumers]), [['OrdersLib', ['OrdersApp']]]);
    w.wait();
    const reused = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: said });
    assert.ok(codes(reused).includes('WORDS_BEFORE_PREVIEW'), JSON.stringify(reused).slice(0, 600));
    const unnamed = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: 'sim, apaga o 1, a OrdersLib' });
    assert.ok(codes(unnamed).includes('CONSUMERS_WOULD_BREAK'), JSON.stringify(unnamed).slice(0, 600));
    assert.deepEqual(w.writes, []);
  } finally { await w.close(); }
});

test('E: an operationUuid that already has a receipt answers odc_receipt first, never a new delete', async () => {
  const w = await world();
  try {
    const used = crypto.randomUUID();
    const lookup = w.access.receipts.lookup.bind(w.access.receipts);
    w.access.receipts.lookup = (id, ...rest) => (String(id).toLowerCase() === used ? { operationUuid: used, state: 'accepted' } : lookup(id, ...rest));
    const out = await w.call('odc_write', { tenant: HOST, operationId: DELETE_ASSET, path: { assetKey: LIB }, operationUuid: used });
    assert.equal(out.code, NEEDS);
    assert.deepEqual([out.continuation.tool, out.continuation.arguments], ['odc_receipt', { operationUuid: used }]);
    assert.deepEqual(out.continuations.assetDelete.arguments, { tenant: HOST, assetKey: LIB });
    assert.deepEqual(w.writes, []);
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- D
const SELECTED_NOW = [{ OriginalName: 'Orders', Name: 'Orders' }];
const portalOf = ({ selected = SELECTED_NOW, actions = [], fail = false } = {}) => ({
  read: (operationId) => {
    if (fail) return { ok: false, operationId, error: { code: 'PORTAL_AUTH_REQUIRED', message: 'No Portal session.' } };
    if (operationId === 'connections.selectedEntities') return { ok: true, data: { SelectedEntityList_Original: { List: selected } } };
    if (operationId === 'connections.selectedActions') return { ok: true, data: { ActionList: { List: actions } } };
    if (operationId === 'connections.detail') return { ok: true, data: { Connection: { connectionId: CONN, name: 'ErpConn', providerId: 'mssql' } } };
    return { ok: true, data: {} };
  } });
const save = (entities, actions = []) => ({ inputParameters: { ConnectionId: CONN, DatabaseObjects: { Entities: { List: entities }, Actions: { List: actions } } } });
const entity = (name, selected = true, attributes = [{ OriginalName: 'Id', Name: 'Id', IsSelected: true }]) => ({ OriginalName: name, Name: name, IsSelected: selected, Attributes: { List: attributes } });
const portalWrite = (w, input, extra = {}) => w.call('odc_portal_write', { tenant: HOST, operationId: 'connections.importEntities', input, authorize: 'pode seguir com isso', operationUuid: crypto.randomUUID(), ...extra });

test('D: IsSelected:false through odc_portal_write is one refusal naming odc_external_db_connection remove-entities; nothing is sent (importEntities, importActions, corporate)', async () => {
  const w = await world({ portal: portalOf() });
  try {
    const removal = save([entity('Orders', false)]);
    const out = await portalWrite(w, removal);
    assert.equal(out.code, NEEDS, JSON.stringify(out).slice(0, 600));
    assert.equal(out.sent, false); assert.ok(codes(out).includes('ENTITY_UNSELECTED'));
    assert.deepEqual(out.problems.find(p => p.code === 'ENTITY_UNSELECTED').targets, ['Orders']);
    assert.deepEqual(out.continuation, { tool: 'odc_external_db_connection', arguments: { tenant: HOST, connectionId: CONN, action: 'remove-entities', objects: ['Orders'] }, why: out.continuation.why });
    // The same native save under the other route id, and a corporate tenant with confirmTenant: the same refusal.
    const actions = await portalWrite(w, removal, { operationId: 'connections.importActions' });
    assert.equal(actions.code, NEEDS); assert.equal(actions.continuation.arguments.action, 'remove-entities');
    const corp = await portalWrite(w, removal, { tenant: CORP, confirmTenant: CORP, authorize: 'pode seguir no acme-r2routes' });
    assert.equal(corp.code, NEEDS); assert.equal(corp.continuation.arguments.tenant, CORP);
    // The review's full native shape (D5): the same.
    const native = { inputParameters: { ConnectionId: CONN, DatabaseObjects: { Entities: { List: [{ EntityId: 'e1', ...entity('Orders', false), NullWriteBehavior: 'ConvertNull' }] }, Actions: { List: [] } },
      ConnectionOriginalUpdateTimestamp: '2026-10-15T00:00:00' }, screenVariables: { ConnectionId: CONN } };
    assert.equal((await portalWrite(w, native)).code, NEEDS);
    assert.deepEqual(w.portalLog.sends, [], 'nothing reached the Portal');
    assert.deepEqual(w.receiptFiles(), [], 'nothing was reserved');
    assert.ok(w.portalLog.reads.every(id => ['connections.selectedEntities', 'connections.selectedActions'].includes(id)), 'reads only: ' + w.portalLog.reads.join(','));
  } finally { await w.close(); }
});

test('D: an empty list and a selected entity left out are refused the same way (the selection is read first); a pure addition names import-entities', async () => {
  const w = await world({ portal: portalOf() });
  try {
    const empty = await portalWrite(w, save([]));
    assert.equal(empty.code, NEEDS, JSON.stringify(empty).slice(0, 600));
    assert.deepEqual(codes(empty).sort(), ['SELECTED_OMITTED', 'SELECTION_EMPTY']);
    assert.deepEqual(empty.continuation.arguments, { tenant: HOST, connectionId: CONN, action: 'remove-entities', objects: ['Orders'] });
    const omitted = await portalWrite(w, save([entity('Lines')]));
    assert.equal(omitted.code, NEEDS);
    assert.deepEqual(codes(omitted), ['SELECTED_OMITTED']);
    assert.deepEqual(omitted.continuation.arguments, { tenant: HOST, connectionId: CONN, action: 'import-entities', objects: ['Lines'] });
    assert.deepEqual(omitted.continuations.removeEntities.arguments.objects, ['Orders']);
    assert.deepEqual(w.portalLog.sends, []);
  } finally { await w.close(); }
});

test('D: an unreadable selection refuses (fail closed); an unselected attribute or action is refused; every problem in one answer', async () => {
  const blind = await world({ portal: portalOf({ fail: true }) });
  try {
    const out = await portalWrite(blind, save([entity('Orders'), entity('Lines')]));
    assert.equal(out.code, NEEDS, JSON.stringify(out).slice(0, 600));
    assert.deepEqual(codes(out), ['SELECTION_UNREADABLE']); assert.equal(out.problems[0].cause, 'PORTAL_AUTH_REQUIRED');
    assert.deepEqual(blind.portalLog.sends, []);
  } finally { await blind.close(); }
  const w = await world({ portal: portalOf({ actions: [{ OriginalName: 'search', Name: 'search' }] }) });
  try {
    const out = await portalWrite(w, save([entity('Orders', true, [{ OriginalName: 'Id', Name: 'Id', IsSelected: true }, { OriginalName: 'Total', Name: 'Total', IsSelected: false }]), entity('Lines', false)],
      [{ OriginalName: 'search', Name: 'search', IsSelected: false }]), { operationId: 'connections.importActions' });
    assert.equal(out.code, NEEDS);
    assert.deepEqual(codes(out).sort(), ['ACTION_UNSELECTED', 'ATTRIBUTE_UNSELECTED', 'ENTITY_UNSELECTED']);
    assert.deepEqual(out.problems.find(p => p.code === 'ATTRIBUTE_UNSELECTED').targets, ['Total']);
    assert.deepEqual(out.continuation.arguments.objects, ['Lines']);
    assert.deepEqual(w.portalLog.sends, []);
  } finally { await w.close(); }
});

test('D: a save that unselects nothing and names everything selected now runs as before (one send)', async () => {
  const w = await world({ portal: portalOf() });
  try {
    const out = await portalWrite(w, save([entity('Orders'), entity('Lines')]));
    assert.notEqual(out.code, NEEDS, JSON.stringify(out).slice(0, 600));
    assert.equal(w.portalLog.sends.length, 1, 'the save was sent once');
    assert.deepEqual(w.portalLog.sends[0].inputParameters.DatabaseObjects.Entities.List.map(e => [e.OriginalName, e.IsSelected]), [['Orders', true], ['Lines', true]]);
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- the CLI (.\odc portal write / internal-write)
const cli = path.resolve(here, '..', 'odc.mjs');
const runCli = args => new Promise(resolve => execFile(process.execPath, [cli, 'portal', '--tenant', HOST, ...args], { env: { ...process.env, SSAM_ODC_OFFLINE: '1' }, windowsHide: true, timeout: 90000 },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
const parsed = out => { try { return JSON.parse(out.stdout); } catch { return { unparsed: out.stdout.slice(0, 300), stderr: out.stderr.slice(0, 300) }; } };

test('E and D through the CLI: .\\odc portal write (asset DELETE) and internal-write (importEntities with IsSelected:false) give the same refusal', async () => {
  const e = parsed(await runCli(['write', DELETE_ASSET, '--path', JSON.stringify({ assetKey: LIB }), '--authorize', 'pode apagar a OrdersLib agora', '--operation-uuid', crypto.randomUUID()]));
  assert.equal(e.code, NEEDS, JSON.stringify(e).slice(0, 500));
  assert.deepEqual([e.continuation.tool, e.continuation.arguments], ['odc_asset_delete', { tenant: HOST, assetKey: LIB }]);
  const d = parsed(await runCli(['internal-write', 'connections.importEntities', '--input', JSON.stringify(save([entity('Orders', false)])),
    '--authorize', 'pode seguir com isso agora', '--operation-uuid', crypto.randomUUID()]));
  assert.equal(d.code, NEEDS, JSON.stringify(d).slice(0, 500));
  assert.deepEqual([d.continuation.tool, d.continuation.arguments.action, d.continuation.arguments.objects], ['odc_external_db_connection', 'remove-entities', ['Orders']]);
  assert.ok(d.problems.some(p => p.code === 'ENTITY_UNSELECTED'));
});

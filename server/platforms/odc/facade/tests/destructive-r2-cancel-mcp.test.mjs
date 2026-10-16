import './fixtures/isolated-profile.mjs';
// CX15 r2, family F2 through MCP (C2/T5): the client's cancellation (notifications/cancelled, so ctx.mcpReq.signal on the
// server) reaches the odc_* guard and the data deletes: an abort during the read again or after the backup sends nothing,
// the record is cancelled with its items not-started, the CANCELLED answer names ssam_task, and ssam_task finds the record
// while the execution runs (never TASK_NOT_FOUND) and the state of a preview never executed. Offline: an SDK McpServer with
// the tools registered as mcp.mjs does (its wrap), Client + InMemoryTransport, a fake ODC access, a fake O11 kernel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap } from '../mcp.mjs';
import { registerSsamTask } from '../ssam-task.mjs';
import { createSsamServer } from '../ssam.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS, readOperation } from '../destructive-operations.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const PERSONAL = 'personal-r2cancel.outsystems.dev';
const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11';
const ASSET_GET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
// The execution goes on in the server after the client cancelled: wait until its record is no longer running.
async function settled(id, root) {
  for (let i = 0; i < 100; i++) { const r = readOperation(id, { root }); if (r && r.state !== 'running') return r; await tick(20); }
  return readOperation(id, { root });
}

function odcServer() {
  const dir = tmp('cx15r2-cancel-odc-'); const root = path.join(dir, 'destructive');
  const h = { dir, root, sends: [], reads: 0, onReread: async () => {}, onSource: async () => {}, controller: null, clock: { t: Date.parse('2026-10-15T12:00:00Z') } };
  h.clock.now = () => h.clock.t;
  const access = {
    pickTenant: async tenant => tenant ?? PERSONAL,
    tenantInfo: host => ({ host, known: true, class: 'personal', readOnly: false, label: null }),
    resolvePublic: async (host, auth) => ({ path: auth === 'api-client' ? 'vault' : 'studio', host }),
    apiClientAvailable: async () => true,
    dependentsOf: async () => { h.reads++; if (h.reads === 2) await h.onReread(); return { ok: true, name: 'ScratchLib', consumers: [], checkedEnvironments: ['dev'], includesPublishingDefault: true }; },
    read: async ({ operationId, path: p = {} }) => (operationId === ASSET_GET && p.assetKey === ASSET ? { ok: true, status: 200, data: { assetKey: ASSET, name: 'ScratchLib', revision: 2, assetType: 'Library' } } : { ok: false, status: 404 }),
    assetSource: async () => { const file = path.join(dir, 'source.oml'); fs.writeFileSync(file, 'OML synthetic'); await h.onSource(); return { ok: true, file }; },
    receipts: { lookup: () => null },
    assetDelete: async input => { h.sends.push(input); return { ok: true, receipt: { operationUuid: input.operationUuid, state: 'confirmed' }, readBack: { gone: true } }; },
  };
  const server = new McpServer({ name: 'cx15r2-cancel', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { now: h.clock.now, root }), wrap);
  registerSsamTask(server, { destructiveRoot: root, tasksDir: path.join(dir, 'tasks') });
  h.connect = async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    h.client = new Client({ name: 'cx15r2-cancel-client', version: '1.0.0' });
    await Promise.all([server.connect(a), h.client.connect(b)]);
  };
  h.call = async (name, args, options) => valueOf(await h.client.callTool({ name, arguments: args }, options));
  h.close = async () => { await h.client.close(); await server.close(); };
  return h;
}

test('C2/T5 (odc_asset_delete): an abort during the read again sends nothing; while it runs and after, ssam_task finds the record; a preview never executed answers previewed', async () => {
  const h = odcServer(); await h.connect();
  try {
    const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
    assert.equal(preview.state, 'previewed');
    // T5: the preview alone answers its state, never TASK_NOT_FOUND.
    const before = await h.call('ssam_task', { id: preview.operationId });
    assert.deepEqual([before.ok, before.destructiveOperation?.state, before.destructiveOperation?.executed], [true, 'previewed', false], JSON.stringify(before).slice(0, 300));
    h.clock.t += CONFIRM_MIN_AGE_MS + 1000;
    const controller = new AbortController();
    let during = null;
    h.onReread = async () => { during = await h.call('ssam_task', { id: preview.operationId }); controller.abort(); await tick(); };
    const cancelled = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId,
      authorize: 'pode apagar o 1, ScratchLib' }, { signal: controller.signal }).catch(error => ({ aborted: true, error: String(error?.message ?? error) }));
    assert.ok(cancelled.aborted || cancelled.code === 'CANCELLED', JSON.stringify(cancelled).slice(0, 300));
    assert.equal(during?.destructiveOperation?.state, 'running', 'ssam_task finds the record during the read again: ' + JSON.stringify(during).slice(0, 300));
    const record = await settled(preview.operationId, h.root);
    assert.deepEqual(h.sends, [], 'nothing sent after the abort');
    assert.deepEqual([record.state, record.items.map(i => i.state)], ['cancelled', ['not-started']]);
    const after = await h.call('ssam_task', { id: preview.operationId });
    assert.equal(after.destructiveOperation.state, 'cancelled');
  } finally { await h.close(); }
});

test('C2 (odc_asset_delete): an abort during the backup sends nothing; the record is cancelled and keeps the backup', async () => {
  const h = odcServer(); await h.connect();
  try {
    const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
    h.clock.t += CONFIRM_MIN_AGE_MS + 1000;
    const controller = new AbortController();
    h.onSource = async () => { controller.abort(); await tick(); };
    await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId,
      authorize: 'pode apagar o 1, ScratchLib' }, { signal: controller.signal }).catch(() => null);
    const record = await settled(preview.operationId, h.root);
    assert.deepEqual(h.sends, [], 'nothing sent after the abort');
    assert.deepEqual([record.state, record.items[0].state, Boolean(record.items[0].backup?.files?.length)], ['cancelled', 'not-started', true]);
  } finally { await h.close(); }
});

test('C2: the CANCELLED answer of a destructive call names ssam_task with the id of its preview', async () => {
  const h = odcServer(); await h.connect();
  try {
    const preview = await h.call('odc_asset_delete', { tenant: PERSONAL, assetKey: ASSET });
    const answer = await wrap(async () => new Promise(() => {}))({ confirmationToken: preview.confirmationToken }, { mcpReq: { signal: AbortSignal.abort() } });
    const value = answer.structuredContent;
    assert.equal(value.code, 'CANCELLED');
    assert.deepEqual([value.continuation?.tool, value.continuation?.arguments?.id], ['ssam_task', preview.previewId]);
    assert.match(value.error, /ssam_task/);
  } finally { await h.close(); }
});

test('C2 (o11_data): an abort during the read again before the delete sends nothing; the record is cancelled', async t => {
  const dataRoot = tmp('cx15r2-cancel-data-'), root = tmp('cx15r2-cancel-data-root-');
  let now = Date.parse('2026-10-15T12:00:00Z');
  const table = new Map([1, 2].map(id => [String(id), { Id: String(id), Name: 'Customer ' + id }]));
  const deletes = []; let reads = 0; let onRead = async () => {};
  const runAnvil = async args => {
    const request = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
    const ops = Array.isArray(request.batch) ? request.batch : [request];
    const results = [];
    for (const op of ops) {
      if (op.operation === 'read') { reads++; if (reads === 2) await onRead(); results.push({ ok: true, records: op.ids.map(String).filter(id => table.has(id)).map(id => table.get(id)), operation: 'read', entity: op.entity }); }
      else if (op.operation === 'delete') { deletes.push(op); results.push({ ok: true, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })), operation: 'delete', entity: op.entity }); }
    }
    return { ok: true, exitCode: 0, via: 'worker', wallMs: 1, stderr: [], envelope: { ok: true, command: 'data', data: { ok: true, host: 'dev.example.test', module: 'Orders_CS', submitted: results.length, total: results.length, results } } };
  };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot, answersRoot: dataRoot, lock: { o11Root: dataRoot, odcRoot: dataRoot, connection: () => null },
    destructive: { now: () => now, root } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r2-cancel-data', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const target = { host: 'dev.example.test', module: 'Orders_CS', oml: 'C:\\captures\\Orders_CS.oml' };
  const call = async (request, options) => valueOf(await client.callTool({ name: 'o11_data', arguments: { ...target, request } }, options));
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1', '2'] });
  assert.equal(preview.count, 2);
  now += CONFIRM_MIN_AGE_MS + 1000;
  const controller = new AbortController();
  onRead = async () => { controller.abort(); await tick(); };
  await call({ ...preview.continuation.arguments.request, authorization: 'pode apagar os 2 registros de Customer' }, { signal: controller.signal }).catch(() => null);
  const record = await settled(preview.operationId, root);
  assert.deepEqual(deletes, [], 'nothing deleted after the abort');
  assert.deepEqual([record?.state, record?.items.map(i => i.state)], ['cancelled', ['not-started', 'not-started']]);
});

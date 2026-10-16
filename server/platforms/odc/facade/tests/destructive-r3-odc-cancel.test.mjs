import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-3 (F2.3): the odc_* guard read the client's cancellation for the last time BEFORE calling the unguarded
// access, whose destructive methods still read (consumers in every stage, approvals, target names) before their write. An
// abort during those reads let the DELETE out and the record ended completed with no trace of the cancellation. Now the
// signal goes into the access (withSignal), which reads it again right before the write leaves: nothing is sent, the
// record ends cancelled and ssam_task says so. An abort while the write is in flight never cuts it: the record keeps
// cancelRequestedAt and the item cancelledInFlight. The real OdcAccess over a fake ODC Studio bridge, through the MCP SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { r3OdcWorld, HOST, LIB, GROUP, USERS } from './fixtures/r3-odc-world.mjs';
import crypto from 'node:crypto';
import { readOperation } from '../destructive-operations.mjs';

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const sendingOf = (w, id) => readOperation(id, { root: w.root })?.items?.[0]?.state === 'sending';
async function settled(w, id) { for (let i = 0; i < 100 && readOperation(id, { root: w.root })?.state === 'running'; i++) await tick(20); return readOperation(id, { root: w.root }); }

test('CT-3: an abort during the consumers read INSIDE the access (after the guard\'s last check) sends no DELETE; the record ends cancelled and ssam_task says so', async () => {
  const w = await r3OdcWorld();
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
    w.wait();
    const controller = new AbortController(); let fired = false;
    w.hooks.beforeGet = async route => {
      if (fired || !/\/consumers$/.test(route) || !sendingOf(w, preview.operationId)) return;
      fired = true; controller.abort(); await tick();
    };
    const answer = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId,
      authorize: 'pode apagar o 1, ZZScratchLib' }, { signal: controller.signal }).catch(error => ({ aborted: true, error: String(error?.message ?? error) }));
    assert.ok(fired, 'the abort came during the access\'s own consumers read');
    assert.ok(answer.aborted || answer.code === 'CANCELLED', JSON.stringify(answer).slice(0, 300));
    const record = await settled(w, preview.operationId);
    assert.deepEqual(w.writes.filter(x => x.method === 'DELETE'), [], 'no DELETE left after the abort');
    assert.ok(w.assets[LIB], 'ZZScratchLib still exists');
    assert.equal(record.state, 'cancelled', JSON.stringify(record).slice(0, 400));
    assert.ok(record.cancelledAt);
    assert.deepEqual(record.items.map(i => i.state), ['not-started']);
    const task = await w.call('ssam_task', { id: preview.operationId });
    assert.equal(task.destructiveOperation.state, 'cancelled');
    assert.ok(w.receipts().every(r => r.state === 'not-sent'), 'a reserved receipt (if any) says not-sent');
  } finally { await w.close(); }
});

test('CT-3: an abort during the target-name read inside access.write (odc_write PATCH with *ToRemove) sends no PATCH; the record ends cancelled', async () => {
  const w = await r3OdcWorld();
  try {
    const [ana, bia] = Object.keys(USERS);
    const body = { userKeysToAdd: [], userKeysToRemove: [ana, bia] };
    const preview = await w.call('odc_write', { tenant: HOST, operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', path: { key: GROUP }, body });
    assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
    w.wait();
    const controller = new AbortController(); let fired = false;
    w.hooks.beforeGet = async route => {
      if (fired || route !== `/api/identity/v1/groups/${GROUP}` || !sendingOf(w, preview.operationId)) return;
      fired = true; controller.abort(); await tick();
    };
    await w.call('odc_write', { ...preview.continuation.arguments, authorize: 'sim, os 2: ZZBia e ZZAna saem do ZZOps' }, { signal: controller.signal }).catch(() => null);
    assert.ok(fired);
    const record = await settled(w, preview.operationId);
    assert.deepEqual(w.writes.filter(x => x.method === 'PATCH'), []);
    assert.equal(record.state, 'cancelled');
    assert.ok(record.items.every(i => i.state === 'not-started'));
  } finally { await w.close(); }
});

test('CT-3: an abort while the DELETE is in flight does not cut it; the record keeps cancelRequestedAt and the item cancelledInFlight', async () => {
  const w = await r3OdcWorld();
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    w.wait();
    const controller = new AbortController(); let fired = false;
    w.hooks.beforeWrite = async request => { if (request.method !== 'DELETE' || fired) return; fired = true; controller.abort(); await tick(60); };
    await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId,
      authorize: 'pode apagar o 1, ZZScratchLib' }, { signal: controller.signal }).catch(() => null);
    assert.ok(fired);
    const record = await settled(w, preview.operationId);
    assert.deepEqual(w.writes.filter(x => x.method === 'DELETE').length, 1, 'the DELETE in flight went out');
    assert.ok(record.cancelRequestedAt, 'the record keeps the time of the cancellation: ' + JSON.stringify(record).slice(0, 400));
    assert.equal(record.items[0].cancelledInFlight, true);
    assert.notEqual(record.state, 'running');
  } finally { await w.close(); }
});

test('CT-3 (portalWrite): an abort during the read before an internal Portal write sends nothing; the receipt (if any) is not-sent', async () => {
  const CONN = '11111111-2222-4333-8444-555555555555';
  const portal = { read: operationId => (operationId === 'connections.selectedEntities' ? { ok: true, data: { SelectedEntityList_Original: { List: [{ OriginalName: 'Orders', Name: 'Orders' }] } } } : { ok: true, data: {} }) };
  const w = await r3OdcWorld({ portal });
  try {
    const controller = new AbortController(); let fired = false;
    w.hooks.beforePortalRead = async operationId => { if (operationId !== 'connections.selectedEntities' || fired) return; fired = true; controller.abort(); await tick(); };
    const entity = name => ({ OriginalName: name, Name: name, IsSelected: true, Attributes: { List: [{ OriginalName: 'Id', Name: 'Id', IsSelected: true }] } });
    // A save that unselects nothing (it runs as one write, CX15 r2 D): the abort comes during its selection read.
    await w.call('odc_portal_write', { tenant: HOST, operationId: 'connections.importEntities', authorize: 'pode importar a Orders', operationUuid: crypto.randomUUID(),
      input: { inputParameters: { ConnectionId: CONN, DatabaseObjects: { Entities: { List: [entity('Orders')] }, Actions: { List: [] } } } } }, { signal: controller.signal }).catch(() => null);
    assert.ok(fired);
    for (let i = 0; i < 50; i++) await tick(10);
    assert.deepEqual(w.portalLog.sends, [], 'nothing was sent after the abort');
    assert.ok(w.receipts().every(r => r.state === 'not-sent'));
  } finally { await w.close(); }
});

import './fixtures/isolated-profile.mjs';
// CX15 r2, T11: the destructive root and the client of a call come from ONE injectable resolution in the common module,
// used by every caller (the Service Center engine, ssam_task, the data gate, the odc_* guard), none of which computes a
// root of its own. A process that serves several clients (the hosted line) maps each call to its client's root and id;
// another client never lists, reads or confirms what a client previewed or ran, also when the root is shared (a literal
// port): the token binds the client. Offline: fakes only (the Service Center fake bridge, a fake studioData, a fake ODC
// access), synthetic names, temporary roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as ops from '../destructive-operations.mjs';
import { registerSsamTask } from '../ssam-task.mjs';
import { studioDataDelete } from '../data-delete-gate.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { Journal } from '../service-center/client.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup } from './fixtures/destructive-flow.mjs';

const { CONFIRM_MIN_AGE_MS, beginOperation, checkExecute, createPreview, destructiveRoot, listOperations, readOperation, readPreview, readPreviewState, tokenNames } = ops;
const HOST = 'personal-r2roots.outsystemscloud.com';
const ODC = 'personal-r2roots.outsystems.dev';
const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const filesUnder = dir => { try { return fs.readdirSync(dir, { recursive: true }).filter(n => /\.json$/.test(n)); } catch { return []; } };

// The hosted executor of these tests: each call runs as one client (its own AsyncLocalStorage, which the common module
// does not know); the injected resolver maps it to that client's root and id.
const clients = new AsyncLocalStorage();
const asClient = (client, fn) => clients.run(client, fn);
function inject(t) {
  assert.equal(typeof ops.setDestructiveRootResolver, 'function', 'the common module has an injectable resolver of the destructive root and client');
  const previous = ops.setDestructiveRootResolver(() => clients.getStore() ?? null);
  t.after(() => ops.setDestructiveRootResolver(previous));
}
function ssamTask() {
  let handler = null;
  // As the servers register it: no destructive root of its own.
  registerSsamTask({ registerTool: (name, config, h) => { handler = h; } }, { tasksDir: path.join(tmp('cx15r2-roots-tasks-'), 'tasks'), root: tmp('cx15r2-roots-kernel-') });
  return async args => (await handler(args, {})).structuredContent;
}
const ITEMS = [{ kind: 'application', key: 'app-1', name: 'ZZ Alpha' }];
const previewOf = () => createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items: ITEMS, now: T0 });
const confirm = token => checkExecute({ token, tool: 'o11_service_center_write', host: HOST, operation: 'delete', words: 'pode apagar o 1, ZZ Alpha', now: T0 + 60000 });
function nothingOfA(block) {
  assert.deepEqual(listOperations(), [], 'B lists no operation of A');
  assert.equal(readOperation(block.operationId), null, 'readOperation of B by the operationId of A');
  assert.equal(readOperation(block.previewId), null, 'readOperation of B by the previewId of A');
  assert.equal(readPreviewState(block.operationId), null, 'the preview state of A is not seen by B');
  assert.equal(readPreview(block.previewId), null);
  assert.equal(tokenNames(block.confirmationToken, 'ZZ Alpha'), null, 'the token of A is unknown to B');
  assert.deepEqual(confirm(block.confirmationToken).problems.map(p => p.code), ['PREVIEW_UNKNOWN'], 'the token of A is refused in B');
}

test('T11: two clients with their own roots (injected resolver): ssam_task {} of B does not list A, readOperation of B is null, the token of A is refused in B', async t => {
  inject(t);
  const A = { root: tmp('cx15r2-rootA-'), clientId: 'client-a' }, B = { root: tmp('cx15r2-rootB-'), clientId: 'client-b' };
  const block = asClient(A, previewOf);
  asClient(A, () => beginOperation({ preview: readPreview(block.previewId), now: T0 + 6000 }));
  assert.ok(filesUnder(path.join(A.root, 'previews')).length === 1 && filesUnder(path.join(A.root, 'operations')).length === 1, 'A writes under its own root');
  assert.deepEqual([filesUnder(B.root), filesUnder(destructiveRoot())], [[], []], 'nothing under the root of B nor under the default root');
  asClient(B, () => nothingOfA(block));
  asClient(A, () => {
    assert.deepEqual(listOperations().map(o => o.operationId), [block.operationId]);
    assert.equal(readOperation(block.previewId)?.operationId, block.operationId);
  });
  const call = ssamTask();
  const listB = await asClient(B, () => call({}));
  assert.deepEqual([listB.ok, listB.destructive], [true, []], 'ssam_task {} of B');
  const byIdB = await asClient(B, () => call({ id: block.operationId }));
  assert.equal(byIdB.code, 'TASK_NOT_FOUND', 'ssam_task {id} of B: ' + JSON.stringify(byIdB).slice(0, 200));
  assert.ok(!JSON.stringify(byIdB).includes(A.root), 'no path of A');
  const listA = await asClient(A, () => call({}));
  assert.deepEqual(listA.destructive.map(o => o.operationId), [block.operationId], 'ssam_task {} of A');
});

test('T11: under ONE shared root (a literal port), the client still separates them, and the token binds the client', () => {
  assert.equal(typeof ops.withDestructiveScope, 'function', 'the common module runs a call inside a scope {root, clientId}');
  const root = tmp('cx15r2-shared-');
  const A = { root, clientId: 'client-a' }, B = { root, clientId: 'client-b' };
  const block = ops.withDestructiveScope(A, previewOf);
  ops.withDestructiveScope(A, () => beginOperation({ preview: readPreview(block.previewId), now: T0 + 6000 }));
  ops.withDestructiveScope(B, () => nothingOfA(block));
  // A call without a client (the local server) does not see the client's either, and a client does not see a local one.
  assert.equal(readOperation(block.operationId, { root }), null);
  assert.deepEqual(listOperations({ root }), []);
  const local = createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items: ITEMS, now: T0, root });
  assert.equal(ops.withDestructiveScope(A, () => readPreview(local.previewId)), null);
  assert.equal(readPreview(local.previewId, { root })?.previewId, local.previewId, 'the local call reads its own');
  // The preview file of A relabelled as B's: B reads it, but the token was bound to A and does not match.
  const file = path.join(root, 'previews', block.previewId + '.json');
  const relabelled = JSON.parse(fs.readFileSync(file, 'utf8')); relabelled.clientId = 'client-b'; fs.writeFileSync(file, JSON.stringify(relabelled));
  ops.withDestructiveScope(B, () => {
    assert.equal(readPreview(block.previewId)?.previewId, block.previewId);
    assert.deepEqual(confirm(block.confirmationToken).problems.map(p => p.code), ['PREVIEW_UNKNOWN'], 'the token binds the client it was made for');
  });
});

// ---- every caller resolves its root through the common module
function serviceCenter(clock) {
  const s = { apps: [{ key: 'a-1', name: 'ZZ One' }], espaces: [{ key: 'm-1', name: 'ZZOne_CS', app: 'a-1' }], dir: temp(), ids: 0 };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => s.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => s.espaces.filter(m => !m.gone).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app })),
    ListExtensions: () => [],
    GetConsumers: () => [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: ['ZZOne_CS'] };
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: ['ZZOne_CS'] };
    },
    DeleteModule: () => ({ success: true, message: null }),
  } });
  // No destructiveRoot: the engine takes the root of the call from the common module.
  const deps = () => ({ journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, opener: () => assert.fail('no prompt'),
    exports: s.dir, registry: REGISTRY, sleep: async () => {}, clock, previewUuid: () => `00000000-0000-4000-8000-${String(++s.ids).padStart(12, '0')}`, backup: noBackup });
  s.run = (...argv) => runServiceCenter([...argv, '--host=' + HOST], deps());
  s.sends = () => s.bridge.calls.filter(c => c[0] === 'api' && c[4]);
  return s;
}
function odcAccess() {
  const dir = tmp('cx15r2-roots-odc-');
  const h = { sends: [] };
  h.access = {
    pickTenant: async tenant => tenant ?? ODC,
    tenantInfo: host => ({ host, known: true, class: 'personal', readOnly: false, label: null }),
    resolvePublic: async (host, auth) => ({ path: auth === 'api-client' ? 'vault' : 'studio', host }),
    apiClientAvailable: async () => true,
    dependentsOf: async () => ({ ok: true, name: 'ScratchLib', consumers: [], checkedEnvironments: ['dev'], includesPublishingDefault: true }),
    read: async ({ operationId, path: p = {} }) => (/get:\/assets\/\{assetKey\}$/.test(operationId) && p.assetKey === ASSET ? { ok: true, status: 200, data: { assetKey: ASSET, name: 'ScratchLib', revision: 2, assetType: 'Library' } } : { ok: false, status: 404 }),
    assetSource: async () => { const file = path.join(dir, 'source.oml'); fs.writeFileSync(file, 'OML synthetic'); return { ok: true, file }; },
    receipts: { lookup: () => null },
    assetDelete: async input => { h.sends.push(input); return { ok: true, receipt: { operationUuid: input.operationUuid, state: 'confirmed' }, readBack: { gone: true } }; },
  };
  return h;
}

test('T11: the Service Center engine, the data gate and the odc_* guard write the preview under the root of the client of the call; another client cannot run its token', async t => {
  inject(t);
  const A = { root: tmp('cx15r2-sitesA-'), clientId: 'client-a' }, B = { root: tmp('cx15r2-sitesB-'), clientId: 'client-b' };
  // Service Center engine (o11_service_center_write delete, o11_environment delete-app, o11_extension delete).
  const clock = fakeClock();
  const sc = serviceCenter(clock);
  const scPreview = await asClient(A, () => sc.run('delete', '--prefix=ZZ'));
  assert.equal(scPreview.state, 'previewed', JSON.stringify(scPreview).slice(0, 300));
  assert.ok(fs.existsSync(path.join(A.root, 'previews', scPreview.previewId + '.json')), 'the engine wrote the preview under the root of A');
  clock.advance(CONFIRM_MIN_AGE_MS + 1000);
  const scRun = await asClient(B, () => sc.run('delete', '--confirmation-token=' + scPreview.confirmationToken, '--words=pode apagar o 1, ZZ One'));
  assert.match(JSON.stringify(scRun), /PREVIEW_UNKNOWN/, 'the engine in B: ' + JSON.stringify(scRun).slice(0, 300));
  assert.deepEqual(sc.sends(), [], 'nothing sent by B');

  // Data gate (studio_data_delete; o11_data and ssam data use the same functions).
  let now = T0;
  const deleted = [];
  const studioData = async ({ op, ids }) => (op === 'read' ? { ok: true, tenant: ODC, module: 'Orders', entity: 'Customer', records: [{ Id: '1', Name: 'Customer 1' }], more: false }
    : (deleted.push(ids), { ok: true, reports: [] }));
  const dataPreview = await asClient(A, () => studioDataDelete({ module: 'Orders', entity: 'Customer', ids: ['1'] }, { studioData, now: () => now }));
  assert.equal(dataPreview.state, 'previewed', JSON.stringify(dataPreview).slice(0, 300));
  assert.ok(fs.existsSync(path.join(A.root, 'previews', dataPreview.previewId + '.json')), 'the data gate wrote the preview under the root of A');
  now += CONFIRM_MIN_AGE_MS + 1000;
  const dataRun = await asClient(B, () => studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: dataPreview.confirmationToken, authorize: 'pode apagar o 1 registro de Customer' }, { studioData, now: () => now }));
  assert.match(JSON.stringify(dataRun), /PREVIEW_UNKNOWN/, 'the data gate in B: ' + JSON.stringify(dataRun).slice(0, 300));
  assert.deepEqual(deleted, [], 'nothing deleted by B');

  // odc_* guard (odc_asset_delete; odc_write, odc_deploy, odc_portal_write and the others go through the same guard).
  const odc = odcAccess();
  let at = T0;
  const guarded = guardedAccess(odc.access, { now: () => at });
  const odcPreview = await asClient(A, () => guarded.assetDelete({ tenant: ODC, assetKey: ASSET }));
  assert.equal(odcPreview.state, 'previewed', JSON.stringify(odcPreview).slice(0, 300));
  assert.ok(fs.existsSync(path.join(A.root, 'previews', odcPreview.previewId + '.json')), 'the odc_* guard wrote the preview under the root of A');
  at += CONFIRM_MIN_AGE_MS + 1000;
  const odcRun = await asClient(B, () => guarded.assetDelete({ tenant: ODC, assetKey: ASSET, confirmationToken: odcPreview.confirmationToken, operationUuid: odcPreview.operationId, authorize: 'pode apagar o 1, ScratchLib' }));
  assert.match(JSON.stringify(odcRun), /PREVIEW_UNKNOWN/, 'the odc_* guard in B: ' + JSON.stringify(odcRun).slice(0, 300));
  assert.deepEqual(odc.sends, [], 'nothing sent by B');
  assert.deepEqual(filesUnder(B.root).filter(n => !n.startsWith('seen-words')), [], 'B wrote no preview, record or backup');
  assert.deepEqual(filesUnder(destructiveRoot()), [], 'nothing under the default root');
});

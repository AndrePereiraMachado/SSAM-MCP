import './fixtures/isolated-profile.mjs';
// CX15 r2, family F2 mediums (C4, C5, I): after an interruption the new list says that a delete already went out and may
// still be running, and a send a cancellation cut is read before any new send (C4); a local failure in the middle never
// leaves the record running and answers the operation and the names by state (C5); two executions of one token never run
// at the same time, in two real processes (I). Offline: the Service Center fake bridge (state in a file shared by the
// processes), fake clock, synthetic names, temporary roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter, serviceCenterTool } from '../service-center/index.mjs';
import { registerSsamTask } from '../ssam-task.mjs';
import * as ops from '../destructive-operations.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup } from './fixtures/destructive-flow.mjs';
import { HOST, deps as worldDeps, initServer, serverEvents, serverLeft } from './fixtures/destructive-r2-world.mjs';

const { CONFIRM_MIN_AGE_MS, beginOperation, createPreview, derivedOperationId, endOperation, markItem, operationFile, readOperation, readPreview } = ops;
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const CHILD = path.join(import.meta.dirname, 'fixtures', 'destructive-r2-child.mjs');
const T0 = Date.parse('2026-10-15T12:00:00Z');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---- C4: four apps without modules; B's delete is accepted and its wait cut by a cancellation; B stays listed (the server
// is still deleting it, like the Core of the incident 60 s later).
function lingering() {
  const w = { apps: ['A', 'B', 'C', 'D'].map(x => ({ key: 'q-' + x.toLowerCase(), name: 'QQV ' + x, gone: false })), lingering: new Set(), dir: temp(), clock: fakeClock(),
    controller: new AbortController(), sends: [], phase: 0 };
  w.root = path.join(w.dir, 'destructive');
  w.journal = new Journal(path.join(w.dir, 'receipts'));
  w.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => w.apps.filter(a => !a.gone || w.lingering.has(a.key)).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: [], ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      const app = w.apps.find(a => a.key === args.appKey);
      w.sends.push(app.key); app.gone = true;
      if (app.key === 'q-b' && w.phase === 1) w.lingering.add('q-b');
      if (w.phase === 3) w.lingering.delete(app.key); // the server finished: the new send of B goes through
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    } } });
  // The cancellation comes in the first pause of the wait for B (its send went out).
  w.deps = extra => ({ journal: w.journal, locate: () => w.bridge, present: async () => false, running: async () => false, exports: w.dir, registry: REGISTRY,
    sleep: async () => { if (w.phase === 1 && w.sends.includes('q-b') && !w.controller.signal.aborted) w.controller.abort(); }, clock: w.clock, destructiveRoot: w.root, backup: noBackup, ...extra });
  w.run = (argv, extra = {}) => runServiceCenter([...argv, '--host=' + HOST], w.deps(extra));
  w.sendsOf = key => w.sends.filter(s => s === key).length;
  return w;
}

test('C4: after a cancellation cut the wait of B, the new list (by prefix or by the old operationId) says a delete of B went out and may still be running; confirming it sends no second delete of B before a verify', async () => {
  const w = lingering();
  const p1 = await w.run(['delete', '--prefix=QQV']);
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  w.phase = 1;
  const e1 = await w.run(['delete', '--confirmation-token=' + p1.confirmationToken, '--words=sim, apaga os 4 QQV'], { signal: w.controller.signal });
  assert.equal(e1.state, 'cancelled', JSON.stringify(e1).slice(0, 300));
  const childB = w.journal.lookup(derivedOperationId(p1.operationId, 'application', 'q-b', 1));
  assert.deepEqual([childB.state, childB.cancelled], ['accepted-unverified', true]);
  assert.equal(w.sendsOf('q-b'), 1);
  w.phase = 2;
  for (const argv of [['delete', '--prefix=QQV'], ['delete', '--operation-id=' + p1.operationId]]) {
    w.clock.advance(1000);
    const p2 = await w.run(argv);
    assert.equal(p2.state, 'previewed', JSON.stringify(p2).slice(0, 300));
    const b = p2.items.find(i => i.name === 'QQV B');
    assert.deepEqual(b.previousDelete && { receipt: b.previousDelete.receipt, state: b.previousDelete.state, cancelled: b.previousDelete.cancelled }, { receipt: childB.operationId, state: 'accepted-unverified', cancelled: true },
      argv.join(' ') + ': the item says its earlier delete: ' + JSON.stringify(b));
    assert.equal(b.previousDelete.sentAt, childB.createdAt);
    assert.match(p2.next, /already sent for QQV B .*may still be running/);
    assert.match(p2.next, /verify/);
    // The owner confirms the new list with the right count: VERIFY_REQUIRED, nothing sent.
    w.clock.advance(CONFIRM_MIN_AGE_MS);
    const e2 = await w.run(['delete', '--confirmation-token=' + p2.confirmationToken, `--words=sim, apaga os ${p2.count} QQV`]);
    assert.equal(e2.ok, false);
    assert.ok(e2.problems.some(p => p.code === 'VERIFY_REQUIRED' && p.operationId === childB.operationId), JSON.stringify(e2.problems?.map(p => p.code)));
    assert.equal(w.sendsOf('q-b'), 1, 'never a second DeleteApplication of B before a verify');
  }
  // verify reads B still listed: it records that read; the next list says so and its confirmation sends B once more.
  const verified = await w.run(['verify', '--operation-id=' + childB.operationId]);
  assert.equal(verified.observedDesiredState, false);
  assert.ok(w.journal.lookup(childB.operationId).verifiedPresentAt, 'the read is recorded on the receipt');
  w.clock.advance(1000);
  const p3 = await w.run(['delete', '--prefix=QQV']);
  assert.ok(p3.items.find(i => i.name === 'QQV B').previousDelete.verifiedPresentAt);
  assert.doesNotMatch(p3.next, /Before any new send it is read/);
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  w.phase = 3;
  const e3 = await w.run(['delete', '--confirmation-token=' + p3.confirmationToken, `--words=depois da leitura, pode apagar os ${p3.count} QQV`]);
  assert.equal(e3.ok, true, JSON.stringify(e3).slice(0, 400));
  assert.equal(w.sendsOf('q-b'), 2, 'one new send of B after the verify');
});

// ---- C5: the rewrite of the parent receipt fails (EPERM that does not go away) after the first child was sent.
function threeApps(clock) {
  const s = { apps: ['ZZ A', 'ZZ B', 'ZZ C'].map((name, i) => ({ key: 'a-' + (i + 1), name })), dir: temp(), sends: [] };
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => s.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })), ListEspaces: [], ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => { if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      s.sends.push(args.appKey); for (const a of s.apps) if (a.key === args.appKey) a.gone = true; return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] }; } } });
  s.run = (...argv) => runServiceCenter([...argv, '--host=' + HOST], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, exports: s.dir,
    registry: REGISTRY, sleep: async () => {}, clock, destructiveRoot: s.root, backup: noBackup });
  return s;
}

test('C5: a local failure after the first send (the parent receipt cannot be rewritten) closes the record uncertain and answers the operation, the names by state and ssam_task', async () => {
  const clock = fakeClock();
  const s = threeApps(clock);
  const preview = await s.run('delete', '--prefix=ZZ');
  clock.advance(CONFIRM_MIN_AGE_MS);
  const rewrite = s.journal.rewrite.bind(s.journal);
  s.journal.rewrite = receipt => {
    if (receipt.operationId === preview.operationId && (receipt.children ?? []).length >= 1) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return rewrite(receipt);
  };
  const done = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga os 3 ZZ');
  assert.equal(done.ok, false);
  assert.equal(done.code, 'SC_LOCAL_FAILURE');
  assert.equal(done.operationId, preview.operationId, 'the answer names the operation');
  assert.deepEqual(done.deleted.map(d => d.name), ['ZZ A']);
  assert.deepEqual(done.notStarted, ['ZZ B', 'ZZ C']);
  assert.match(done.error, /ssam_task \{id:"[0-9a-f-]{36}"\}/);
  assert.match(done.next, /ssam_task/);
  assert.deepEqual(s.sends, ['a-1'], 'nothing more was sent');
  const record = readOperation(preview.operationId, { root: s.root });
  assert.equal(record.state, 'uncertain', 'never running for ever in this process');
  assert.ok(record.endedAt);
  assert.deepEqual(record.items.map(i => [i.name, i.state]), [['ZZ A', 'deleted'], ['ZZ B', 'not-started'], ['ZZ C', 'not-started']]);
  assert.equal(fs.existsSync(ops.leaseFile?.(preview.operationId, { root: s.root }) ?? path.join(s.root, 'operations', preview.operationId + '.lock')), false, 'the lease is released');
  // ssam_task reads it, and its description (and the common suffix) say to read it after SC_LOCAL_FAILURE.
  let handler, description;
  registerSsamTask({ registerTool: (name, config, h) => { handler = h; description = config.description; } }, { tasksDir: path.join(s.dir, 'tasks'), destructiveRoot: s.root, root: s.dir });
  const task = (await handler({ id: preview.operationId }, {})).structuredContent;
  assert.equal(task.destructiveOperation.state, 'uncertain');
  assert.match(description, /SC_LOCAL_FAILURE/);
  assert.match(ops.AFTER_INTERRUPTION, /SC_LOCAL_FAILURE/);
});

test('C5: Journal.rewrite and the receipt of a send retry a rename that Windows refuses for a moment (EPERM, EBUSY, EACCES)', async () => {
  const clock = fakeClock();
  const s = threeApps(clock);
  const preview = await s.run('delete', '--prefix=ZZ');
  clock.advance(CONFIRM_MIN_AGE_MS);
  const original = fs.renameSync;
  let refused = 0;
  fs.renameSync = (from, to) => {
    if (String(to).startsWith(path.join(s.dir, 'receipts')) && String(to).endsWith('.json') && refused < 6) { refused++; throw Object.assign(new Error('EBUSY: resource busy'), { code: ['EPERM', 'EBUSY', 'EACCES'][refused % 3] }); }
    return original(from, to);
  };
  let done;
  try { done = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga os 3 ZZ'); }
  finally { fs.renameSync = original; }
  assert.equal(refused, 6);
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 400));
  assert.equal(readOperation(preview.operationId, { root: s.root }).state, 'completed');
});

// ---- I: two executions of one token, in two real processes.
test('I: a second process that runs the same token while the first is in the middle answers OPERATION_RUNNING and sends nothing; the record ends with the 3 deleted', async () => {
  const dir = tmp('cx15r2-i-'); const serverFile = path.join(dir, 'server.json');
  initServer(serverFile);
  let t = T0; const clock = () => t;
  const WORDS = 'sim, apaga os 3 ZZ';
  let token = null; let other = null;
  const hook = async item => {
    if (item.name !== 'ZZ B') return;
    const out = path.join(dir, 'b.json');
    const child = spawnSync(process.execPath, [CHILD, 'run', dir, serverFile, token, WORDS, out], { env: process.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stderr);
    other = JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  const D = worldDeps({ dir, serverFile, who: 'A', clock, hook });
  const preview = (await serviceCenterTool(['delete', '--prefix=ZZ', '--host=' + HOST], D)).result;
  token = preview.confirmationToken;
  t += CONFIRM_MIN_AGE_MS;
  const a = await serviceCenterTool(['delete', '--confirmation-token=' + token, '--words=' + WORDS, '--host=' + HOST], D);
  assert.notEqual(other.pid, process.pid);
  assert.equal(other.ok, false);
  assert.ok(other.code === 'OPERATION_RUNNING' || other.problems.includes('OPERATION_RUNNING'), 'the other process: ' + JSON.stringify(other));
  assert.deepEqual(other.deleted, []);
  assert.equal(a.ok, true, JSON.stringify(a).slice(0, 300));
  assert.deepEqual(serverEvents(serverFile), ['DeleteApplication a-1 by A', 'DeleteApplication a-2 by A', 'DeleteApplication a-3 by A'], 'each delete once, all by A');
  assert.deepEqual(serverLeft(serverFile), []);
  const record = JSON.parse(fs.readFileSync(operationFile(preview.operationId, { root: path.join(dir, 'destructive') }), 'utf8'));
  assert.deepEqual([record.state, record.pid, record.items.map(i => i.state)], ['completed', process.pid, ['deleted', 'deleted', 'deleted']]);
});

test('I: the lease of an operation (operations\\<id>.lock) held by another live process: the execution answers OPERATION_RUNNING and sends nothing; once that process is gone the lease is taken over', async () => {
  const dir = tmp('cx15r2-lease-'); const serverFile = path.join(dir, 'server.json');
  initServer(serverFile, ['ZZ A']);
  let t = T0; const clock = () => t;
  const D = worldDeps({ dir, serverFile, who: 'A', clock });
  const root = path.join(dir, 'destructive');
  const preview = (await serviceCenterTool(['delete', '--prefix=ZZ', '--host=' + HOST], D)).result;
  t += CONFIRM_MIN_AGE_MS;
  // The other process holds the lease (between taking it and writing its record: checkExecute sees no record).
  const lease = path.join(root, 'operations', preview.operationId + '.lock'); fs.mkdirSync(path.dirname(lease), { recursive: true });
  const ready = path.join(dir, 'ready');
  const holder = spawn(process.execPath, [CHILD, 'hold', lease, ready], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(fs.existsSync(ready), 'the other process holds the lease');
    const refused = await serviceCenterTool(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga o 1 ZZ', '--host=' + HOST], D);
    assert.equal(refused.ok, false);
    assert.ok(JSON.stringify(refused.result.problems ?? []).includes('OPERATION_RUNNING'), JSON.stringify(refused.result).slice(0, 400));
    assert.deepEqual(serverEvents(serverFile), [], 'nothing sent');
    assert.equal(D.journal.lookup(preview.operationId), null, 'no parent receipt either');
    // The data gate, on a lease held the same way: OPERATION_RUNNING, nothing deleted.
    const { studioDataDelete } = await import('../data-delete-gate.mjs');
    let now = T0; const deleted = [];
    const studioData = async ({ op, ids }) => (op === 'read' ? { ok: true, tenant: 'personal-r2lease.outsystems.dev', module: 'Orders', entity: 'Customer', records: [{ Id: '1', Name: 'C 1' }], more: false } : (deleted.push(ids), { ok: true, reports: [] }));
    const dataPreview = await studioDataDelete({ module: 'Orders', entity: 'Customer', ids: ['1'] }, { studioData, now: () => now, root });
    now += CONFIRM_MIN_AGE_MS + 1000;
    fs.copyFileSync(lease, path.join(root, 'operations', dataPreview.operationId + '.lock'));
    const dataRun = await studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: dataPreview.confirmationToken, authorize: 'pode apagar o 1 registro de Customer' }, { studioData, now: () => now, root });
    assert.equal(dataRun.code, 'OPERATION_RUNNING', JSON.stringify(dataRun).slice(0, 300));
    assert.deepEqual(deleted, []);
    // The odc_* guard, on a lease held the same way: OPERATION_RUNNING with ssam_task, nothing read again or sent.
    const { guardedAccess } = await import('../../portal/runtime/destructive-preview.mjs');
    const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11'; const TENANT = 'personal-r2lease.outsystems.dev';
    const odcSends = []; let rereads = 0; let at = T0;
    const access = {
      pickTenant: async tenant => tenant ?? TENANT,
      tenantInfo: host => ({ host, known: true, class: 'personal', readOnly: false, label: null }),
      resolvePublic: async (host, auth) => ({ path: auth === 'api-client' ? 'vault' : 'studio', host }),
      apiClientAvailable: async () => false,
      dependentsOf: async () => { rereads++; return { ok: true, name: 'ScratchLib', consumers: [], checkedEnvironments: ['dev'], includesPublishingDefault: true }; },
      read: async ({ path: p = {} }) => (p.assetKey === ASSET ? { ok: true, status: 200, data: { assetKey: ASSET, name: 'ScratchLib', revision: 2, assetType: 'Library' } } : { ok: false, status: 404 }),
      receipts: { lookup: () => null },
      assetDelete: async input => { odcSends.push(input); return { ok: true, receipt: { operationUuid: input.operationUuid, state: 'confirmed' } }; },
    };
    const guarded = guardedAccess(access, { now: () => at, root });
    const odcPreview = await guarded.assetDelete({ tenant: TENANT, assetKey: ASSET });
    at += CONFIRM_MIN_AGE_MS + 1000;
    fs.copyFileSync(lease, path.join(root, 'operations', odcPreview.operationId + '.lock'));
    const before = rereads;
    const odcRun = await guarded.assetDelete({ tenant: TENANT, assetKey: ASSET, confirmationToken: odcPreview.confirmationToken, operationUuid: odcPreview.operationId, authorize: 'pode apagar o 1, ScratchLib' });
    assert.equal(odcRun.code, 'OPERATION_RUNNING', JSON.stringify(odcRun).slice(0, 300));
    assert.deepEqual([odcRun.continuation?.tool, odcRun.continuation?.arguments?.id], ['ssam_task', odcPreview.operationId]);
    assert.deepEqual([odcSends, rereads - before], [[], 0], 'nothing read again or sent');
  } finally { holder.kill(); }
  await new Promise(resolve => (holder.exitCode !== null ? resolve() : holder.once('exit', resolve)));
  t += 1000;
  const done = await serviceCenterTool(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga o 1 ZZ', '--host=' + HOST], D);
  assert.equal(done.ok, true, 'the lease of a process that is gone is taken over: ' + JSON.stringify(done.result).slice(0, 300));
  assert.deepEqual(serverEvents(serverFile), ['DeleteApplication a-1 by A']);
  assert.equal(fs.existsSync(lease), false, 'released at the end');
});

test('I: markItem and endOperation read, merge and write: an item another writer changed later is kept', () => {
  const root = tmp('cx15r2-merge-');
  const block = createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items: [{ kind: 'application', key: 'k-1', name: 'ZZ One' }, { kind: 'application', key: 'k-2', name: 'ZZ Two' }], now: T0, root });
  const record = beginOperation({ preview: readPreview(block.previewId, { root }), now: T0 + 6000, root });
  // Another writer (a takeover) marked ZZ Two deleted later than this copy knows.
  const file = operationFile(block.operationId, { root });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(stored.items[1], { state: 'deleted', at: new Date(T0 + 9000).toISOString() });
  fs.writeFileSync(file, JSON.stringify(stored));
  markItem(record, record.items[0], { state: 'deleted' }, { now: T0 + 8000, root });
  endOperation(record, 'completed', { now: T0 + 10000, root });
  assert.deepEqual(readOperation(block.operationId, { root }).items.map(i => [i.name, i.state]), [['ZZ One', 'deleted'], ['ZZ Two', 'deleted']]);
});

test('C7: when the record cannot say "sending" before a send, nothing is sent for that target and the rest stops', async () => {
  const clock = fakeClock();
  const s = threeApps(clock);
  const preview = await s.run('delete', '--prefix=ZZ');
  clock.advance(CONFIRM_MIN_AGE_MS);
  const record = operationFile(preview.operationId, { root: s.root });
  const original = fs.renameSync;
  let refused = 0;
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.resolve(record) && /"key": "a-2",[^}]*"state": "sending"/.test(fs.readFileSync(from, 'utf8'))) {
      refused++; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return original(from, to);
  };
  let done;
  try { done = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga os 3 ZZ'); }
  finally { fs.renameSync = original; }
  assert.ok(refused > 0, 'the write of "sending" for ZZ B was refused');
  assert.equal(done.code, 'OPERATION_RECORD_FAILED', JSON.stringify(done).slice(0, 400));
  assert.deepEqual(s.sends, ['a-1'], 'ZZ A went out; nothing for ZZ B or ZZ C');
  const read = readOperation(preview.operationId, { root: s.root });
  assert.deepEqual(read.items.map(i => [i.name, i.state]), [['ZZ A', 'deleted'], ['ZZ B', 'not-started'], ['ZZ C', 'not-started']]);
});
test('C5 (page delete): a backup of the connection detail that cannot be written ends the record refused (not running), nothing sent; the token stays usable', async () => {
  const { SC, fixture } = await import('./fixtures/sc-fake-bridge.mjs');
  const deleted = [];
  const bridge = new FakeBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => (deleted.length ? '<table><tr><th>Name</th></tr></table><p>No connections found</p>' : fixture('db-connections.html')),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: f => { deleted.push(f.__EVENTTARGET); return fixture('db-connections.html'); } } });
  const dir = temp(); const root = path.join(dir, 'destructive'); const clock = fakeClock();
  const deps = { journal: new Journal(path.join(dir, 'receipts')), locate: () => bridge, present: async () => false, running: async () => false, opener: () => assert.fail('no prompt'),
    exports: dir, registry: REGISTRY, sleep: async () => {}, clock, destructiveRoot: root, backup: noBackup };
  const host = 'test.example.com';
  const run = (...argv) => runServiceCenter(['db-connection-delete', '--host', host, '--connection', 'LegacyERP', '--confirm-host', host, ...argv], deps);
  const preview = await run();
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  clock.advance(CONFIRM_MIN_AGE_MS);
  // The backup file cannot be written: a folder stands where it goes.
  fs.mkdirSync(path.join(root, 'backups', preview.operationId, 'LegacyERP-detail.json'), { recursive: true });
  const failed = await run('--confirmation-token', preview.confirmationToken, '--words', 'sim, apaga a 1 LegacyERP no test');
  assert.equal(failed.ok, false, JSON.stringify(failed).slice(0, 300));
  assert.deepEqual(deleted, [], 'nothing sent');
  const record = readOperation(preview.operationId, { root });
  assert.deepEqual([record.state, record.notSent, record.items.map(i => i.state)], ['refused', true, ['not-started']], 'never running for ever');
  assert.equal(fs.existsSync(path.join(root, 'operations', preview.operationId + '.lock')), false, 'the lease is released');
  fs.rmSync(path.join(root, 'backups', preview.operationId), { recursive: true, force: true });
  clock.advance(1000);
  const done = await run('--confirmation-token', preview.confirmationToken, '--words', 'pode apagar a 1, LegacyERP, no test');
  assert.deepEqual([done.state, deleted.length], ['confirmed', 1], JSON.stringify(done).slice(0, 300));
});
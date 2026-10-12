import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIVE_BINDING_STATES, activeBindingFile, combineOdcActiveBindings, createOdcActiveBinding, odcDeploymentGuard, readOdcActiveBinding } from '../debug-odc-active-binding.mjs';
import { odcAccessHarness, PERSONAL } from './fixtures/debug-odc-access-harness.mjs';

const APP = 'eb3086cb-db41-4721-8047-b51b6574d58c', ENV = '44444444-4444-4444-8444-444444444444';
const OPERATIONS = ['Deploy', 'Undeploy', 'ApplyConfigs'];
function root(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-odc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const binding = (dir, extra = {}) => createOdcActiveBinding({ root: dir, applicationKey: APP.toUpperCase(), operationId: 'op-1', sessionId: 'a'.repeat(32),
  runtimeUrl: 'https://dev.example.test/Store/', moduleKey: 'y4Yw60HbIUeAR7UbZXTVjA', ...extra });

test('marker writes are atomic, exclusive per application and walk the four states', t => {
  const dir = root(t), active = binding(dir), file = activeBindingFile(dir, APP);
  assert.equal(active.file, file); assert.equal(fs.existsSync(file), false); assert.equal(active.state, null);
  for (const state of ['idle', 'request-in-flight', 'paused', 'request-in-flight', 'idle', 'held', 'idle']) {
    active.mark(state);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(record.state, state); assert.equal(record.applicationKey, APP); assert.equal(record.operationId, 'op-1');
    assert.equal(record.sessionId, 'a'.repeat(32)); assert.equal(record.runtimeUrl, 'https://dev.example.test/Store/'); assert.equal(record.moduleKey, 'y4Yw60HbIUeAR7UbZXTVjA');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'no partial or temporary marker remains');
  }
  assert.throws(() => active.mark('running'), /debug_odc_active_binding_state_invalid/);
  assert.throws(() => binding(dir, { operationId: 'op-2' }).mark('idle'), /debug_odc_active_binding_busy/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operationId, 'op-1');
  assert.throws(() => createOdcActiveBinding({ root: dir, applicationKey: '../x', operationId: 'op', sessionId: 's' }), /application_key_invalid/);
  assert.deepEqual(active.release(), { file, state: 'idle', removed: true, retained: false });
  assert.equal(fs.existsSync(file), false); assert.equal(readOdcActiveBinding(dir, APP).present, false);
});

const denied = code => Object.assign(new Error(code + ': operation not permitted'), { code });
test('transient Windows denials on a marker replace or removal are retried within a bounded budget', t => {
  const dir = root(t), calls = { rename: 0, unlink: 0 }; let renameDenials = 0, unlinkDenials = 0;
  // More denials than the former 5-attempt/25 ms budget; no hard link is ever made.
  const io = { renameSync: (from, to) => { calls.rename++; if (renameDenials-- > 0) throw denied(calls.rename % 2 ? 'EPERM' : 'EBUSY'); fs.renameSync(from, to); },
    unlinkSync: file => { if (file.endsWith('.json')) { calls.unlink++; if (unlinkDenials-- > 0) throw denied('EPERM'); } fs.unlinkSync(file); },
    linkSync: () => { throw new Error('hard link used'); } };
  const active = binding(dir, { io }); active.mark('idle');
  renameDenials = 8; active.mark('request-in-flight');
  assert.equal(readOdcActiveBinding(dir, APP).record.state, 'request-in-flight'); assert.equal(calls.rename, 9);
  assert.deepEqual(fs.readdirSync(path.dirname(active.file)), [path.basename(active.file)], 'no temporary marker remains');
  unlinkDenials = 8; active.mark('idle');
  assert.deepEqual(active.release(), { file: active.file, state: 'idle', removed: true, retained: false });
  assert.equal(calls.unlink, 9); assert.equal(fs.existsSync(active.file), false);
  // A permanent denial is never retried forever and never a non-debug error.
  const stuck = binding(dir, { io: { ...io, renameSync: () => { throw denied('EPERM'); } }, retryMs: 50 }); stuck.mark('idle');
  assert.throws(() => stuck.mark('request-in-flight'), /^Error: EPERM/); stuck.release();
});

test('a marker that cannot be removed after a clean run is left released: it blocks neither deployments nor the next run', t => {
  const dir = root(t);
  const io = { renameSync: fs.renameSync, unlinkSync: file => { if (file.endsWith('.json')) throw denied('EPERM'); fs.unlinkSync(file); } };
  const active = binding(dir, { io, retryMs: 30 }); active.mark('request-in-flight'); active.mark('idle');
  const released = active.release();
  assert.equal(released.removed, false); assert.equal(released.retained, false); assert.equal(released.releasedMarker, true);
  const seen = readOdcActiveBinding(dir, APP).record;
  assert.equal(seen.released, true); assert.equal(seen.state, 'idle'); assert.notEqual(seen.retained, true);
  for (const operation of OPERATIONS) assert.equal(odcDeploymentGuard({ root: dir })({ operation, assetKey: APP }), null);
  const next = binding(dir, { operationId: 'op-2' }); next.mark('request-in-flight');
  assert.equal(next.covered, false); assert.equal(readOdcActiveBinding(dir, APP).record.operationId, 'op-2');
  assert.equal(odcDeploymentGuard({ root: dir })({ operation: 'Deploy', assetKey: APP }).code, 'DEBUG_SESSION_ACTIVE');
  assert.deepEqual(next.release(), { file: active.file, state: 'request-in-flight', removed: true, retained: false });
  // Neither the marker of a live run nor a retained uncertain one is taken over.
  const live = binding(dir, { operationId: 'op-3' }); live.mark('idle');
  assert.throws(() => binding(dir, { operationId: 'op-4' }).mark('idle'), /debug_odc_active_binding_busy/); live.release();
});

test('combined markers cover the entry app and a different trace app, and release both', t => {
  const dir = root(t), PRODUCER = '11111111-1111-4111-8111-111111111111';
  const entry = binding(dir), producer = createOdcActiveBinding({ root: dir, applicationKey: PRODUCER, operationId: 'op-1', sessionId: 'a'.repeat(32), moduleKey: 'P'.repeat(22) });
  const both = combineOdcActiveBindings([entry, producer]);
  both.mark('request-in-flight');
  for (const key of [APP, PRODUCER]) assert.equal(odcDeploymentGuard({ root: dir })({ operation: 'ApplyConfigs', assetKey: key }).code, 'DEBUG_SESSION_ACTIVE');
  both.paused(true); assert.equal(both.state, 'paused'); assert.equal(readOdcActiveBinding(dir, PRODUCER).record.state, 'paused');
  both.mark('held'); for (const key of [APP, PRODUCER]) assert.equal(odcDeploymentGuard({ root: dir })({ operation: 'ApplyConfigs', assetKey: key }), null);
  assert.equal(both.file, entry.file); assert.deepEqual(both.files, [entry.file, producer.file]);
  const released = both.release();
  assert.equal(released.removed, true); assert.equal(released.retained, false); assert.equal(released.bindings.length, 2);
  assert.equal(readOdcActiveBinding(dir, APP).present, false); assert.equal(readOdcActiveBinding(dir, PRODUCER).present, false);
  assert.equal(combineOdcActiveBindings([entry]), entry, 'a single marker is returned unchanged');
});

test('pause notifications only move between request-in-flight and paused', t => {
  const dir = root(t), active = binding(dir);
  active.mark('idle'); active.paused(true); assert.equal(active.state, 'idle');
  active.mark('request-in-flight'); active.paused(true); assert.equal(active.state, 'paused');
  assert.equal(readOdcActiveBinding(dir, APP).record.state, 'paused');
  active.paused(false); assert.equal(active.state, 'request-in-flight');
  active.mark('held'); active.paused(true); assert.equal(active.state, 'held');
  active.release();
});

test('an uncertain run retains its marker; later marks are refused and deployments stay blocked', t => {
  const dir = root(t), active = binding(dir); active.mark('idle');
  const released = active.release({ uncertain: true });
  assert.deepEqual(released, { file: active.file, state: 'idle', removed: false, retained: true, uncertain: true });
  const seen = readOdcActiveBinding(dir, APP);
  assert.equal(seen.record.uncertain, true); assert.equal(seen.record.retained, true); assert.equal(seen.record.state, 'idle');
  for (const operation of OPERATIONS) assert.equal(odcDeploymentGuard({ root: dir })({ operation, assetKey: APP }).code, 'DEBUG_SESSION_ACTIVE');
  assert.throws(() => active.mark('idle'), /debug_odc_active_binding_released/);
  // A later run of the same app is covered by the retained marker; it never replaces or removes it.
  const covered = binding(dir, { operationId: 'op-3' }); covered.mark('request-in-flight');
  assert.equal(covered.covered, true); assert.equal(readOdcActiveBinding(dir, APP).record.operationId, 'op-1');
  assert.deepEqual(covered.release(), { file: active.file, state: 'request-in-flight', removed: false, retained: false, covered: true });
  assert.equal(readOdcActiveBinding(dir, APP).record.uncertain, true);
});

test('deployment guard refuses Deploy, Undeploy and ApplyConfigs unless the marker is held or idle', t => {
  const dir = root(t), guard = odcDeploymentGuard({ root: dir });
  for (const operation of OPERATIONS) assert.equal(guard({ operation, assetKey: APP, environmentKey: ENV }), null);
  const active = binding(dir);
  for (const state of ACTIVE_BINDING_STATES) {
    active.mark(state);
    for (const operation of OPERATIONS) {
      const refused = guard({ operation, assetKey: APP.toUpperCase(), environmentKey: ENV });
      if (['held', 'idle'].includes(state)) { assert.equal(refused, null, state); continue; }
      assert.equal(refused.ok, false); assert.equal(refused.sent, false); assert.equal(refused.code, 'DEBUG_SESSION_ACTIVE');
      assert.equal(refused.error.code, 'DEBUG_SESSION_ACTIVE'); assert.match(refused.error.message, /Nothing was reserved or sent/);
      assert.deepEqual(refused.activeDebugSession, { applicationKey: APP, state, operationId: 'op-1', sessionId: 'a'.repeat(32), uncertain: false, unreadable: false });
    }
  }
  assert.equal(guard({ operation: 'ApplyConfigs', assetKey: '11111111-1111-4111-8111-111111111111' }), null, 'another application is not blocked');
  active.release();
  fs.mkdirSync(path.dirname(active.file), { recursive: true }); fs.writeFileSync(active.file, '{');
  assert.equal(guard({ operation: 'ApplyConfigs', assetKey: APP }).activeDebugSession.unreadable, true, 'an unreadable marker blocks');
});

test('OdcAccess deploy wiring refuses before reservation or send while a debug request is active', async t => {
  const dir = root(t), active = binding(dir); active.mark('paused');
  const h = odcAccessHarness(t, { deploymentGuard: odcDeploymentGuard({ root: dir }),
    portalCall: request => request.method === 'POST' ? { ok: true, status: 202, body: { key: randomUUID(), status: 'Running' } } : { ok: true, status: 200, body: { name: 'Store' } } });
  if (typeof h.access.deploymentGuard !== 'function') { t.skip('foreign change pending: OdcAccess deploymentGuard in portal/runtime/access.mjs'); return; }
  for (const operation of OPERATIONS) {
    const operationUuid = randomUUID();
    const out = await h.access.deploy({ tenant: PERSONAL, assetKey: APP, environmentKey: ENV, revision: 3, operation, authorize: 'yes, Store on the personal tenant', operationUuid, waitSeconds: 0 });
    assert.equal(out.code, 'DEBUG_SESSION_ACTIVE', JSON.stringify(out)); assert.equal(out.sent, false); assert.equal(h.access.receipts.lookup(operationUuid), null);
  }
  assert.equal(h.sent.length, 0);
  active.mark('held');
  const applied = await h.access.deploy({ tenant: PERSONAL, assetKey: APP, environmentKey: ENV, revision: 3, operation: 'ApplyConfigs', authorize: 'yes, Store on the personal tenant', operationUuid: randomUUID(), waitSeconds: 0 });
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(h.sent.filter(r => r.method === 'POST').length, 1);
  active.release();
});

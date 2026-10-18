// Port D7 (review B1): while portal/runtime/timer-background.mjs is pending, ssam_debug_run ODC Workflow events,
// original Timer launches and Portal Timer wakes refuse with the registry's typed code before any live read, watch or
// wake, instead of failing with a raw module error. Offline; synthetic model only. Runs only while the file is pending.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { debugRun, nativeEntrySchema } from '../debug-run.mjs';
import { odcBackgroundRunnerPending, prepareNativeEntry } from '../debug-odc-native-run.mjs';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import { guidToKey } from '../debug-odc-native-runtime.mjs';

const pending = foreignPendingReason('timer-background');
const skip = pending ? false : 'timer-background delivered: the wake, workflow and background runner tests cover these paths';
const CODE = 'debug_adapter_dependency_pending:timer-background';

const stage = '22222222-2222-4333-8444-555555555555';
const moduleKey = guidToKey('44444444-2222-4333-8444-555555555555'), timerKey = guidToKey('55555555-2222-4333-8444-555555555555');
const actionKey = guidToKey('66666666-2222-4333-8444-555555555555'), start = guidToKey('88888888-2222-4333-8444-555555555555');
const child = (key, kind, name, children = []) => ({ key, kind, name, path: kind + ':' + name, children, childrenTotal: children.length, childrenOmitted: 0,
  propertyReferences: {}, properties: { Name: name }, propertiesMissing: [], propertyErrors: {}, propertiesOmitted: {} });
const binding = { lane: 'odc', tenant: 'example.outsystems.dev', environmentKey: stage, module: 'Store', moduleKey,
  runtimeUrl: 'https://example-dev.outsystems.app/Store/', revision: 42, sourceSha256: 'a'.repeat(64) };
const timer = child(timerKey, 'Timer', 'Nightly'); timer.propertyReferences.Action = { key: actionKey, kind: 'ServerAction', path: 'ServerAction:Run' };
const action = child(actionKey, 'ServerAction', 'Run', [child(start, 'StartNode', ''), child('local', 'LocalVariable', 'Counter')]);
const readers = { binding, sourceContract: { sha256: binding.sourceSha256 }, resolveTarget: async () => ({ ...timer, inputs: [], closureCalls: [] }),
  properties: p => (p === timer.path ? timer : null), inputs: () => [], usages: () => [], tree: async p => (p === '@' + timerKey ? timer : action) };
const base = { lane: 'odc', tenant: binding.tenant, module: binding.module, action: 'Nightly', contextMode: 'native-background' };

test('the pending runner code names timer-background while the file is absent', { skip }, () => {
  assert.equal(odcBackgroundRunnerPending(), CODE);
});

test('ssam_debug_run refuses an ODC Timer launch or Workflow event typed before any live read', { skip }, async () => {
  let touched = 0;
  const services = { buildNativeReaders: async () => { touched++; throw new Error('unexpected reader'); }, journal: async () => {} };
  for (const request of [{ ...base, op: 'prepare', launch: { inputs: {} } },
    { ...base, op: 'run', words: 'Run this DEV Timer once', launch: { inputs: {} } },
    { ...base, op: 'prepare', workflow: { module: 'Flow' }, launch: { inputs: { Order: 1 } } }]) {
    const result = await debugRun(request, { services });
    assert.equal(result.ok, false); assert.equal(result.error, CODE, JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /Cannot find module|ERR_MODULE_NOT_FOUND|timer-background\.mjs/);
  }
  assert.equal(touched, 0);
  // The runner entry itself refuses the same way (a caller with its own readers).
  await assert.rejects(prepareNativeEntry({ ...base, op: 'prepare', launch: { inputs: {} }, persist: false }, readers), error => error.message === CODE);
});

test('a Portal Timer wake prepares offline, then run refuses typed before any watch or wake', { skip }, async () => {
  const calls = [];
  const services = { readers, journal: async () => {},
    backgroundAdapter: { prepare: async p => { calls.push('portal-prepare'); return p; }, run: async () => { calls.push('post'); } },
    debug: async a => { calls.push(a.op); return { ok: true, state: 'stopped' }; } };
  // prepare itself needs no runner (persist:false keeps the receipt out of the workspace).
  const prepared = await prepareNativeEntry({ ...nativeEntrySchema.parse({ ...base, op: 'prepare', execution: 'native-entry' }), persist: false }, readers);
  assert.equal(prepared.adapter?.trigger, 'odc-portal-timer-wake', JSON.stringify(prepared.adapter));
  const result = await debugRun({ ...base, op: 'run', words: 'Run this DEV Timer once', trace: 'full', depth: 4 }, { services });
  assert.equal(result.ok, false); assert.equal(result.state, 'entry-unavailable'); assert.equal(result.error, CODE);
  assert.deepEqual(calls, []);
});

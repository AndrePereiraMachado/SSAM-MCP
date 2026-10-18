import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOdcNativeLive } from '../debug-odc-native-live.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { activeBindingFile, odcDeploymentGuard } from '../debug-odc-active-binding.mjs';
import { keyToGuid } from '../debug-odc-native-runtime.mjs';
function fixture(t, { uncertain = false, cleanup = true, visits = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-live-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [], actionKey = 'A'.repeat(22), binding = { tenant: 'dev.example.test', module: 'Store', moduleKey: 'B'.repeat(22), runtimeUrl: 'https://dev.example.test/Store/', revision: 1 };
  const prepared = { action: { key: actionKey }, entry: { key: actionKey }, path: [{ key: actionKey }], bindings: [], assumptions: [],
    scenarios: ['first', 'second'].map(name => ({ name, inputs: {} })) };
  const member = { key: actionKey, chunk: 'client.js', holder: { name: 'work', local: 'work' }, type: 'CLIENT_ACTION' };
  const readers = { binding, sourceContract: { sha256: 'f'.repeat(64) }, runtime: { moduleVersion: 'v1', index: { functions: { [actionKey]: [member] }, views: {}, screens: {}, groups: {} } } };
  const services = { root,
    prepareUser: async (input, { sessionId }) => { events.push('login'); return { ok: true, descriptor: { binding: appUserBinding(input, sessionId), expiresAt: new Date(Date.now() + 600000).toISOString() } }; },
    releaseUser: async () => { events.push('release'); return { ok: true }; },
    broker: () => ({ prepare: async () => { events.push('prepare'); }, authenticate: async () => ({ authenticated: true, identityMatches: true }),
      invoke: async call => { events.push(call.name); return { name: call.name, ok: !uncertain, uncertain, visits }; },
      dispose: async () => { events.push('dispose'); return { completed: cleanup }; } }),
  };
  return { prepared, readers, services, events, actionKey };
}
test('native runs prepare before login, invoke serially and confirm both kinds of cleanup', async t => {
  const f = fixture(t); const r = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(r.ok, true); assert.equal(r.lockRetained, false); assert.equal(r.credentialsReleased, true);
  assert.deepEqual(f.events, ['prepare', 'login', 'first', 'second', 'dispose', 'release']);
});

test('client inspection obtains pinned producer models before preparing or authenticating the broker', async t => {
  const f = fixture(t), models = [{ moduleKey: 'P'.repeat(22), source: { path: 'producer.oml', sha256: 'a'.repeat(64), revision: 7 } }];
  f.services.requireClientInspection = true;
  f.readers.clientInspectionModels = async () => { f.events.push('models'); return models; };
  const create = f.services.broker;
  f.services.broker = () => {
    const broker = create();
    return { ...broker, prepare: async input => { assert.deepEqual(input.modelSources, models); return broker.prepare(input); } };
  };
  const result = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true);
  assert.deepEqual(f.events, ['models', 'prepare', 'login', 'first', 'second', 'dispose', 'release']);
  const g = fixture(t); g.services.requireClientInspection = true;
  g.readers.clientInspectionModels = async () => { throw new Error('debug_odc_producer_source_changed'); };
  const refused = await runOdcNativeLive({ trace: 'none' }, g.prepared, g.readers, g.services);
  assert.equal(refused.ok, false); assert.deepEqual(refused.results, []);
  assert.deepEqual(g.events, ['dispose']);
});
test('private precollected session ID is exact and cannot weaken the application binding', async t => {
  const sessionId = 'ab'.repeat(16);
  const valid = fixture(t); valid.services.sessionId = sessionId;
  const result = await runOdcNativeLive({ trace: 'none' }, valid.prepared, valid.readers, valid.services);
  assert.equal(result.ok, true); assert.equal(result.sessionId, sessionId);
  assert.equal(valid.events.filter(event => event === 'login').length, 1);
  for (const invalid of [null, '', sessionId.toUpperCase(), sessionId + '0', '../' + sessionId, 42]) {
    const f = fixture(t); f.services.sessionId = invalid;
    await assert.rejects(runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services), /debug_odc_native_session_id_invalid/);
    assert.deepEqual(f.events, []);
  }
  const foreign = fixture(t); foreign.services.sessionId = sessionId;
  foreign.services.prepareUser = async () => ({ ok: true, descriptor: {
    binding: appUserBinding({ ...foreign.readers.binding, lane: 'odc', runtimeUrl: 'https://dev.example.test/Other/', app: 'Other' }, sessionId),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  } });
  const refused = await runOdcNativeLive({ trace: 'none' }, foreign.prepared, foreign.readers, foreign.services);
  assert.equal(refused.error, 'debug_odc_native_app_user_scope_mismatch');
  assert.deepEqual(refused.results, []); assert.deepEqual(foreign.events, ['prepare', 'dispose', 'release']);
  assert.equal(refused.cleanup.completed, true); assert.equal(refused.credentialsReleased, true);
  assert.equal(refused.uncertain, false); assert.equal(refused.lockRetained, false);
});
test('publication refresh refusal after authenticated login is private, sends no scenario and keeps the required guard', async t => {
  const f = fixture(t); let checks = 0;
  f.readers.verifyPublication = async () => {
    checks++;
    if (checks === 2) throw new Error('PORTAL_AUTH_FAILED: debug_odc_session_exchange_uncertain private-token private-user');
  };
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.equal(checks, 2); assert.equal(result.authentication.authenticated, true);
  assert.equal(result.error, 'debug_odc_native_publication_check_failed');
  assert.equal(result.failurePhase, 'publication-before-invocation');
  assert.deepEqual(result.results, []); assert.deepEqual(result.notSent, ['first', 'second']);
  assert.deepEqual(f.events, ['prepare', 'login', 'dispose', 'release']);
  assert.equal(result.cleanup.completed, true); assert.equal(result.credentialsReleased, true);
  assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(result.ok, false);
  const persisted = fs.readFileSync(result.receiptPath, 'utf8');
  assert.doesNotMatch(persisted, /private-token|private-user|PORTAL_AUTH_FAILED/);
  assert.equal(JSON.parse(persisted).failurePhase, 'publication-before-invocation');
});
test('uncertain send retains the binding lock and does not execute remaining scenarios', async t => {
  const f = fixture(t, { uncertain: true }); const r = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(r.ok, false); assert.equal(r.lockRetained, true); assert.deepEqual(r.notSent, ['second']);
  const again = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(again.error, 'debug_odc_native_binding_busy'); assert.equal(f.events.filter(e => e === 'first').length, 1);
});
test('missing trace and missing cleanup are never reported as success', async t => {
  const f = fixture(t); const r = await runOdcNativeLive({ trace: 'nodes' }, f.prepared, f.readers, f.services);
  assert.equal(r.ok, false); assert.equal(r.results[0].error, 'debug_odc_native_trace_incomplete'); assert.deepEqual(r.notSent, ['second']);
  const g = fixture(t, { cleanup: false }); const failed = await runOdcNativeLive({ trace: 'none' }, g.prepared, g.readers, g.services);
  assert.equal(failed.ok, false); assert.equal(failed.uncertain, true); assert.equal(failed.lockRetained, true);
});

test('requested full-value depth reaches the native server debugger without being fixed to two', async t => {
  const f = fixture(t);
  f.prepared.action.kind = 'ServerAction';
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], steps: 12 });
  const starts = [];
  f.services.debug = async input => {
    if (input.op === 'start') { starts.push(input); return { ok: true, state: 'connected', sessionId: 'trace-session', expiresAt: new Date(Date.now() + input.seconds * 1000).toISOString() }; }
    return { ok: true, state: 'stopped' };
  };
  let reads = 0;
  f.services.traceRead = () => reads++ % 2 === 0 ? [] : [{ functionKey: f.actionKey, threadId: 'thread', kind: 'step' }, { threadId: 'thread', kind: 'thread-end' }];
  const result = await runOdcNativeLive({ trace: 'full', depth: 4 }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true); assert.equal(starts[0].trace.depth, 4); assert.equal(starts[0].trace.fullValues, true);
});

test('interactive server inspection coordinates the fixed request lease before invoking the original entry', async t => {
  const f = fixture(t); f.prepared.action.kind = 'ServerAction';
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], steps: 12 });
  let deadline, configured;
  f.services.debug = async input => input.op === 'start'
    ? { ok: true, state: 'connected', sessionId: 'trace', inspectionMode: 'interactive', autoContinue: false,
        expiresAt: deadline = new Date(Date.now() + input.seconds * 1000).toISOString() }
    : { ok: true, state: 'stopped' };
  const create = f.services.broker;
  f.services.broker = () => ({ ...create(), configureServerInspection: async options => {
    f.events.push('inspection-lease'); configured = options; return { configured: true, ...options };
  } });
  let reads = 0;
  f.services.traceRead = () => reads++ % 2 === 0 ? [] : [{ functionKey: f.actionKey, threadId: 'thread' }, { threadId: 'thread', kind: 'thread-end' }];
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true); assert.equal(configured.expiresAt, deadline);
  assert.equal(result.serverTrace.requestDeadline, deadline);
  assert.deepEqual(f.events, ['prepare', 'login', 'inspection-lease', 'first', 'second', 'dispose', 'release']);
  const g = fixture(t); g.prepared.action.kind = 'ServerAction'; g.readers.traceTarget = f.readers.traceTarget;
  g.services.debug = f.services.debug;
  const refused = await runOdcNativeLive({ trace: 'full' }, g.prepared, g.readers, g.services);
  assert.equal(refused.error, 'debug_odc_native_inspection_deadline_unavailable');
  assert.deepEqual(refused.results, []); assert.deepEqual(g.events, ['prepare', 'login', 'dispose', 'release']);
  assert.equal(refused.uncertain, false);
});

test('ODC server model hook receives the producer capture and refuses model failure before login or invoke', async t => {
  const f = fixture(t); f.prepared.action.kind = 'ServerAction';
  const source = { path: path.join(f.services.root, 'producer.oml'), sha256: 'a'.repeat(64) };
  f.readers.traceTarget = async () => ({ actionKey: f.actionKey, nodeKeys: ['node'],
    binding: { ...f.readers.binding, moduleKey: 'P'.repeat(22) }, producerTarget: { sourceContract: source } });
  let prepared;
  f.services.prepareServerInspection = async binding => { prepared = binding; throw new Error('debug_native_scope_source_changed'); };
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.deepEqual(prepared.source, source); assert.equal(prepared.moduleKey, 'P'.repeat(22));
  assert.equal(result.error, 'debug_native_scope_source_changed'); assert.equal(result.uncertain, false);
  assert.equal(f.events.includes('login'), false); assert.deepEqual(result.results, []);
});

test('producer trace uses original body keys and consumer runtime while original entry stays unchanged', async t => {
  const f = fixture(t), producerKey = 'P'.repeat(22), originalKey = 'O'.repeat(22);
  const producerTarget = { actionKey: originalKey, producerModuleKey: producerKey };
  f.prepared.producerTarget = producerTarget;
  f.readers.traceTarget = async () => ({ actionKey: originalKey, nodeKeys: ['node'], steps: 4,
    binding: { ...f.readers.binding, module: 'Library', moduleKey: producerKey }, producerTarget, scopes: { [originalKey]: ['Result'] } });
  const starts = []; f.services.debug = async (input, options) => {
    if (input.op === 'start') { starts.push({ input, options }); return { ok: true, state: 'connected', sessionId: 'trace', expiresAt: new Date(Date.now() + input.seconds * 1000).toISOString() }; }
    return { ok: true, state: 'stopped' };
  };
  let reads = 0;
  f.services.traceRead = () => reads++ % 2 === 0 ? [] : [{ functionKey: originalKey, threadId: 'right', kind: 'step' }, { threadId: 'wrong', kind: 'thread-end' }, { threadId: 'right', kind: 'thread-end' }];
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true, result.error);
  assert.equal(starts[0].input.moduleKey, producerKey); assert.equal(starts[0].input.runtimeUrl, f.readers.binding.runtimeUrl);
  assert.equal(starts[0].input.trace.focusFunctionKey, originalKey); assert.equal(starts[0].options.redactionOnly, true);
  assert.equal(result.entry.key, f.actionKey); assert.equal(result.results[0].producerObservation.propagationProved, false);
});

test('publication delay cannot send an action after the shorter worker observation budget is consumed', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t); f.prepared.scenarios = f.prepared.scenarios.slice(0, 1);
  f.prepared.action.kind = 'ServerAction';
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'] });
  let checks = 0, stops = 0, workerDeadline;
  f.readers.verifyPublication = async () => { if (++checks === 2) now += 200000; };
  f.services.debug = async input => {
    if (input.op === 'start') {
      workerDeadline = new Date(now + input.seconds * 1000).toISOString();
      return { ok: true, state: 'connected', sessionId: 'trace', expiresAt: workerDeadline };
    }
    stops++; return { ok: true, state: 'stopped' };
  };
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.equal(result.error, 'debug_odc_native_debugger_budget_insufficient');
  assert.equal(result.failurePhase, 'debugger-budget-before-invocation');
  assert.equal(result.serverTrace.expiresAt, workerDeadline);
  assert.deepEqual(result.results, []); assert.deepEqual(result.notSent, ['first']);
  assert.deepEqual(f.events, ['prepare', 'login', 'dispose', 'release']);
  assert.equal(stops, 1); assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false);
});

const markerOf = f => activeBindingFile(f.services.root, keyToGuid(f.readers.binding.moduleKey));
const markerState = f => fs.existsSync(markerOf(f)) ? JSON.parse(fs.readFileSync(markerOf(f), 'utf8')) : null;
function holdFixture(t, { stop = () => ({ ok: true, state: 'stopped' }) } = {}) {
  const f = fixture(t); f.prepared.action.kind = 'ServerAction';
  f.prepared.scenarios = ['first', 'second', 'third'].map(name => ({ name, inputs: {} }));
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], steps: 12 });
  f.starts = []; f.stops = []; f.checks = []; f.markers = [];
  let started = 0;
  f.services.debug = async input => {
    if (input.op === 'start') { const id = 'trace-' + ++started; f.starts.push(input); f.events.push('start:' + id);
      return { ok: true, state: 'connected', sessionId: id, expiresAt: new Date(Date.now() + input.seconds * 1000).toISOString() }; }
    f.stops.push(input.sessionId); f.events.push('stop:' + input.sessionId); return stop(input.sessionId);
  };
  let reads = 0;
  f.services.traceRead = () => reads++ % 2 === 0 ? [] : [{ functionKey: f.actionKey, threadId: 't' + reads, kind: 'step' }, { threadId: 't' + reads, kind: 'thread-end' }];
  f.readers.verifyPublication = async () => { f.checks.push(f.events.at(-1) ?? 'none'); };
  f.services.readRuntimeVersion = async () => 'v1';
  f.services.holdBetweenScenarios = async info => { f.events.push('hold:' + info.scenario); f.markers.push(markerState(f).state);
    assert.equal(odcDeploymentGuard({ root: f.services.root })({ operation: 'ApplyConfigs', assetKey: keyToGuid(f.readers.binding.moduleKey) }), null); };
  f.services.nativeSessionRenewed = id => f.events.push('renewed:' + id);
  const create = f.services.broker;
  f.services.broker = options => { const broker = create(options); return { ...broker, invoke: async call => { f.markers.push(markerState(f).state);
    assert.equal(odcDeploymentGuard({ root: f.services.root })({ operation: 'ApplyConfigs', assetKey: keyToGuid(f.readers.binding.moduleKey) }).code, 'DEBUG_SESSION_ACTIVE');
    return broker.invoke(call); } }; };
  return f;
}
const runHold = f => runOdcNativeLive({ trace: 'full', holdBetweenScenarios: true }, f.prepared, f.readers, f.services);

test('hold confirms the native stop, waits, re-verifies and renews the native session before the next scenario', async t => {
  const f = holdFixture(t), result = await runHold(f);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.events, ['prepare', 'login', 'start:trace-1', 'first', 'stop:trace-1', 'hold:scenario-1', 'start:trace-2', 'renewed:trace-2',
    'second', 'stop:trace-2', 'hold:scenario-2', 'start:trace-3', 'renewed:trace-3', 'third', 'stop:trace-3', 'dispose', 'release']);
  for (const name of ['first', 'second', 'third']) assert.equal(f.events.filter(e => e === name).length, 1, 'exactly one submission per scenario');
  assert.deepEqual(f.checks, ['none', 'start:trace-1', 'hold:scenario-1', 'renewed:trace-2', 'hold:scenario-2', 'renewed:trace-3']);
  assert.deepEqual(f.starts.map(s => s.trace.steps), [36, 24, 12]);
  assert.deepEqual(result.serverTrace.sessions.map(s => [s.scenario, s.sessionId, s.stopped]), [['scenario-1', 'trace-1', true], ['scenario-2', 'trace-2', true]]);
  assert.equal(result.serverTrace.sessionId, 'trace-3'); assert.equal(result.serverTrace.stopped, true);
  assert.deepEqual(f.markers, ['request-in-flight', 'held', 'request-in-flight', 'held', 'request-in-flight']);
  assert.equal(markerState(f), null); assert.equal(result.activeBinding.removed, true); assert.equal(result.activeBinding.retained, false);
  assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.deepEqual(result.notSent, []);
});

test('an uncertain native stop never holds, ends uncertain and retains the lock and active marker', async t => {
  for (const stop of [() => ({ ok: false, state: 'connected', stopError: 'debug_native_stop_timeout' }), () => { throw new Error('lost'); }]) {
    const f = holdFixture(t, { stop }), result = await runHold(f);
    assert.equal(result.state, 'uncertain'); assert.equal(result.error, 'debug_odc_native_stop_before_hold_unconfirmed');
    assert.equal(result.failurePhase, 'native-stop-before-hold'); assert.deepEqual(result.notSent, ['second', 'third']);
    assert.equal(f.events.some(e => e.startsWith('hold:') || e === 'second'), false); assert.deepEqual(f.stops, ['trace-1'], 'never a second native stop');
    assert.equal(result.serverTrace.stopped, false); assert.equal(result.lockRetained, true);
    assert.equal(markerState(f).uncertain, true); assert.equal(result.activeBinding.retained, true);
    assert.equal(odcDeploymentGuard({ root: f.services.root })({ operation: 'ApplyConfigs', assetKey: keyToGuid(f.readers.binding.moduleKey) }).code, 'DEBUG_SESSION_ACTIVE');
  }
});

test('publication, runtime version or app-user budget changes after the hold refuse before any request or native start', async t => {
  const cases = [
    [f => { const verify = f.readers.verifyPublication; f.readers.verifyPublication = async () => { await verify(); if (f.events.at(-1) === 'hold:scenario-1') throw new Error('debug_native_endpoint_publication_changed'); }; },
      'debug_native_endpoint_publication_changed', 'publication-after-hold'],
    [f => { f.services.readRuntimeVersion = async () => 'v2'; }, 'debug_odc_native_runtime_version_changed_after_hold', 'publication-after-hold'],
    [f => { f.services.readRuntimeVersion = async () => { throw new Error('debug_odc_native_publication_check_failed'); }; }, 'debug_odc_native_publication_check_failed', 'publication-after-hold'],
    [(f, t) => { let now = Date.now(); t.mock.method(Date, 'now', () => now); const hold = f.services.holdBetweenScenarios;
      f.services.holdBetweenScenarios = async info => { await hold(info); now += 500000; }; }, 'debug_odc_native_debugger_budget_insufficient', 'debugger-budget-after-hold'],
  ];
  for (const [change, error, phase] of cases) {
    const f = holdFixture(t); change(f, t);
    const result = await runHold(f);
    assert.equal(result.error, error); assert.equal(result.failurePhase, phase); assert.equal(result.state, 'failed');
    assert.deepEqual(result.notSent, ['second', 'third']); assert.deepEqual(result.results.map(r => r.name), ['first']);
    assert.deepEqual(f.starts.length, 1); assert.deepEqual(f.stops, ['trace-1']);
    assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(markerState(f), null);
    t.mock.restoreAll();
  }
});

test('a renewed interactive session keeps the native host request deadline configured once', async t => {
  const f = holdFixture(t), debug = f.services.debug, configured = [];
  f.services.debug = async (input, context) => { const started = await debug(input, context);
    return input.op === 'start' ? { ...started, inspectionMode: 'interactive', autoContinue: false } : started; };
  const create = f.services.broker;
  f.services.broker = options => ({ ...create(options), configureServerInspection: async request => { configured.push(request.expiresAt); return { configured: true, ...request }; } });
  const result = await runHold(f);
  assert.equal(result.ok, true, result.error); assert.equal(configured.length, 1);
  assert.equal(result.serverTrace.requestDeadline, configured[0]);
  assert.ok(Date.parse(result.serverTrace.expiresAt) <= Date.parse(configured[0]), 'a renewed session never extends the request deadline');
});

test('after a long hold the kept request deadline refuses before a fresh native session is opened', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = holdFixture(t), debug = f.services.debug;
  // The app-user lease outlives the hold; only the first configured request deadline is short.
  f.services.prepareUser = async (input, { sessionId }) => { f.events.push('login'); return { ok: true, descriptor: { binding: appUserBinding(input, sessionId), expiresAt: new Date(now + 1200000).toISOString() } }; };
  f.services.debug = async (input, context) => { const started = await debug(input, context);
    return input.op === 'start' ? { ...started, inspectionMode: 'interactive', autoContinue: false } : started; };
  const create = f.services.broker;
  f.services.broker = options => ({ ...create(options), configureServerInspection: async request => ({ configured: true, ...request }) });
  const hold = f.services.holdBetweenScenarios;
  f.services.holdBetweenScenarios = async info => { await hold(info); now += 400000; };
  const result = await runHold(f);
  assert.equal(result.error, 'debug_odc_native_debugger_budget_insufficient'); assert.equal(result.failurePhase, 'debugger-budget-after-hold');
  assert.equal(f.starts.length, 1, 'no native session is opened for nothing'); assert.deepEqual(f.stops, ['trace-1']);
  assert.deepEqual(result.notSent, ['second', 'third']); assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false);
});

test('a server trace in another app also marks that app, so its ApplyConfigs is refused while the request runs', async t => {
  const f = holdFixture(t), producerKey = 'P'.repeat(22), producer = keyToGuid(producerKey);
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], steps: 12, binding: { ...f.readers.binding, module: 'Library', moduleKey: producerKey, runtimeUrl: 'https://dev.example.test/Library/' } });
  const guard = odcDeploymentGuard({ root: f.services.root }), producerStates = [];
  const hold = f.services.holdBetweenScenarios;
  f.services.holdBetweenScenarios = async info => { await hold(info); assert.equal(guard({ operation: 'ApplyConfigs', assetKey: producer }), null); };
  const create = f.services.broker;
  f.services.broker = options => { const broker = create(options); return { ...broker, invoke: async call => {
    producerStates.push(JSON.parse(fs.readFileSync(activeBindingFile(f.services.root, producer), 'utf8')).state);
    assert.equal(guard({ operation: 'ApplyConfigs', assetKey: producer }).code, 'DEBUG_SESSION_ACTIVE'); return broker.invoke(call); } }; };
  const result = await runHold(f);
  assert.equal(result.ok, true, result.error); assert.deepEqual(producerStates, ['request-in-flight', 'request-in-flight', 'request-in-flight']);
  assert.equal(result.activeBinding.removed, true); assert.equal(result.activeBinding.bindings.length, 2);
  assert.equal(fs.existsSync(activeBindingFile(f.services.root, producer)), false); assert.equal(markerState(f), null);
});

test('a stop during the hold cancels the remaining scenarios without a native start', async t => {
  const f = holdFixture(t); f.services.holdBetweenScenarios = async info => { f.events.push('hold:' + info.scenario); throw new Error('debug_server_session_cancelled'); };
  const result = await runHold(f);
  assert.equal(result.state, 'cancelled'); assert.equal(result.error, 'debug_server_session_cancelled'); assert.equal(result.failurePhase, 'hold');
  assert.deepEqual(result.notSent, ['second', 'third']); assert.equal(f.starts.length, 1); assert.deepEqual(f.stops, ['trace-1']);
  assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(result.ok, false); assert.equal(markerState(f), null);
});

test('hold is refused before sign-in without its coordinator, for client-local and static-read runs and without a server trace', async t => {
  const missing = fixture(t);
  const refused = await runOdcNativeLive({ trace: 'none', holdBetweenScenarios: true }, missing.prepared, missing.readers, missing.services);
  assert.equal(refused.error, 'debug_odc_native_hold_coordinator_required'); assert.deepEqual(missing.events, []);
  for (const [mode, code] of [[{ clientLocal: { operationId: 'x' } }, 'hold_client_local_unsupported'], [{ independentStaticRead: { operationId: 'x' } }, 'hold_static_read_unsupported']]) {
    const f = fixture(t); Object.assign(f.services, mode, { holdBetweenScenarios: async () => {} });
    const out = await runOdcNativeLive({ trace: 'none', holdBetweenScenarios: true }, f.prepared, f.readers, f.services);
    assert.equal(out.error, 'debug_odc_native_' + code); assert.deepEqual(f.events, []);
  }
  const client = fixture(t); client.services.holdBetweenScenarios = async () => {};
  const traceless = await runOdcNativeLive({ trace: 'none', holdBetweenScenarios: true }, client.prepared, client.readers, client.services);
  assert.equal(traceless.error, 'debug_odc_native_hold_server_trace_required'); assert.deepEqual(client.events, []); assert.equal(traceless.lockRetained, false);
});

test('the active marker covers every invocation, is removed after a clean run and retained after an uncertain one', async t => {
  const f = fixture(t), seen = [], create = f.services.broker;
  f.services.broker = options => { const broker = create(options); return { ...broker, invoke: async call => { seen.push(markerState(f).state); return broker.invoke(call); } }; };
  let handle; f.services.activeBinding = active => { handle = active; };
  const result = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true); assert.deepEqual(seen, ['request-in-flight', 'request-in-flight']); assert.equal(handle.file, markerOf(f));
  assert.equal(markerState(f), null); assert.equal(result.activeBinding.removed, true);
  const g = fixture(t, { uncertain: true }), failed = await runOdcNativeLive({ trace: 'none' }, g.prepared, g.readers, g.services);
  assert.equal(failed.uncertain, true); assert.equal(markerState(g).state, 'request-in-flight'); assert.equal(markerState(g).uncertain, true);
  assert.equal(failed.activeBinding.retained, true);
});

// 618c60ae class: the worker's read-only preflight failed before StartDebugSession, so no native session can exist.
function preflightFixture(t, started) {
  const f = fixture(t); f.prepared.action.kind = 'ServerAction';
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], steps: 12 });
  const receipt = path.join(f.services.root, 'worker-receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ state: 'stopped', transportPreflight: { outcome: 'failed', route: 'runtime-root-get', failure: 'ConnectionReset',
    ipv4Answered: true, ipv6OnlyFailure: true, ipv6Disabled: false, detail: 'PRIVATE-HOST-TEXT' } }));
  f.stops = [];
  f.services.debug = async input => {
    if (input.op === 'start') return { ok: false, sessionId: 'trace', receiptPath: receipt, startError: 'debug_start_unreachable:preflight',
      transport: { startPhase: 'preparing', stopPhase: 'completed', startOutcome: 'not-attempted', tokenObtained: false }, ...started };
    f.stops.push(input.sessionId); return { ok: true, state: 'stopped' };
  };
  return f;
}
test('a not-attempted start after a failed preflight is a known-not-started refusal that releases the lock', async t => {
  const f = preflightFixture(t, { state: 'stopped' });
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.equal(result.state, 'refused'); assert.equal(result.error, 'debug_start_unreachable:preflight');
  assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(result.ok, false);
  assert.equal(result.serverTrace.state, 'not-started'); assert.equal(result.serverTrace.knownNotStarted, true);
  assert.deepEqual(result.serverTrace.preflight, { outcome: 'failed', failure: 'ConnectionReset', ipv4Answered: true, ipv6OnlyFailure: true, ipv6Disabled: false });
  assert.deepEqual(f.stops, [], 'a worker that confirmed its local stop is not stopped again');
  assert.deepEqual(result.results, []); assert.deepEqual(f.events, ['prepare', 'login', 'dispose', 'release']);
  assert.doesNotMatch(fs.readFileSync(result.receiptPath, 'utf8'), /PRIVATE-HOST-TEXT/);
  // A worker that did not confirm its stop is stopped once; the known-not-started class still holds.
  const g = preflightFixture(t, { state: 'start-failed' });
  const unconfirmed = await runOdcNativeLive({ trace: 'full' }, g.prepared, g.readers, g.services);
  assert.equal(unconfirmed.state, 'refused'); assert.deepEqual(g.stops, ['trace']); assert.equal(unconfirmed.lockRetained, false);
  // Contrast: an attempted start without an answer stays uncertain and keeps the lock (historical runs unchanged).
  const h = preflightFixture(t, { state: 'stop-uncertain', startError: 'debug_start_failed_or_uncertain',
    transport: { startPhase: 'rest-start', stopPhase: 'no-session-token', startOutcome: 'attempted', tokenObtained: false } });
  h.services.debug = (debug => async input => input.op === 'stop' ? { ok: false, state: 'stop-uncertain' } : debug(input))(h.services.debug);
  const attempted = await runOdcNativeLive({ trace: 'full' }, h.prepared, h.readers, h.services);
  assert.equal(attempted.state, 'uncertain'); assert.equal(attempted.uncertain, true); assert.equal(attempted.lockRetained, true);
  assert.equal(attempted.serverTrace.knownNotStarted, undefined);
});

// Consumer + library breakpoints in one native session (findings: .local/debugger/odc-library-breakpoint-contract).
function ownersFixture(t, kind = 'library-reference') {
  const f = fixture(t), producerKey = 'P'.repeat(22), originalKey = 'O'.repeat(22);
  const producerSource = { path: path.join(f.services.root, 'producer.oml'), sha256: 'a'.repeat(64) };
  const producerTarget = { kind, actionKey: originalKey, producerModuleKey: producerKey, sourceContract: producerSource,
    consumer: { moduleKey: f.readers.binding.moduleKey, sourceSha256: f.readers.sourceContract.sha256 } };
  f.prepared.producerTarget = producerTarget;
  f.readers.traceTarget = async () => ({ actionKey: originalKey, nodeKeys: ['L'.repeat(22)], consumerNodeKeys: ['K'.repeat(22)], steps: 4,
    binding: { ...f.readers.binding, module: 'Library', moduleKey: producerKey }, producerTarget, scopes: { [originalKey]: ['Result'] } });
  f.starts = [];
  f.services.debug = async (input, options) => {
    if (input.op === 'start') { f.starts.push({ input, options }); return { ok: true, state: 'connected', sessionId: 'trace', expiresAt: new Date(Date.now() + input.seconds * 1000).toISOString() }; }
    return { ok: true, state: 'stopped' };
  };
  let reads = 0;
  f.services.traceRead = () => reads++ % 2 === 0 ? [] : [{ functionKey: originalKey, threadId: 'right', kind: 'step' }, { threadId: 'right', kind: 'thread-end' }];
  return { f, producerKey, originalKey, producerSource };
}
test('a library producer start carries consumer and library breakpoint owners and both pinned models', async t => {
  const { f, producerKey, producerSource } = ownersFixture(t);
  let inspection; f.services.prepareServerInspection = async value => { inspection = value; };
  const result = await runOdcNativeLive({ trace: 'full' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true, result.error);
  const start = f.starts[0].input, consumerKey = f.readers.binding.moduleKey;
  assert.deepEqual(start.nodeKeys, ['L'.repeat(22), 'K'.repeat(22)]);
  assert.deepEqual(start.nodeModuleKeys, { ['L'.repeat(22)]: producerKey, ['K'.repeat(22)]: consumerKey });
  assert.equal(start.moduleKey, producerKey); assert.equal(start.runtimeUrl, f.readers.binding.runtimeUrl);
  assert.deepEqual(inspection.models, [{ moduleKey: consumerKey, source: f.readers.sourceContract }, { moduleKey: producerKey, source: producerSource }]);
  assert.deepEqual(inspection.nodeModuleKeys, start.nodeModuleKeys);
  assert.deepEqual(result.serverTrace.breakpointOwners, start.nodeModuleKeys);
});
test('consumer breakpoint owners are refused before sign-in outside the runner-bound library pair', async t => {
  for (const change of [
    s => { s.f.prepared.producerTarget.kind = 'service-reference'; },
    s => { const read = s.f.readers.traceTarget; s.f.readers.traceTarget = async () => ({ ...await read(), binding: { ...(await read()).binding, runtimeUrl: 'https://dev.example.test/Library/' } }); },
    s => { s.f.prepared.producerTarget.consumer.moduleKey = 'Z'.repeat(22); },
    s => { const read = s.f.readers.traceTarget; s.f.readers.traceTarget = async () => ({ ...await read(), consumerNodeKeys: ['L'.repeat(22)] }); },
    s => { const read = s.f.readers.traceTarget; s.f.readers.traceTarget = async () => ({ ...await read(), consumerNodeKeys: ['bad'] }); },
  ]) {
    const s = ownersFixture(t); change(s);
    const result = await runOdcNativeLive({ trace: 'full' }, s.f.prepared, s.f.readers, s.f.services);
    assert.equal(result.error, 'debug_odc_native_breakpoint_owners_invalid'); assert.equal(s.f.starts.length, 0);
    assert.equal(s.f.events.includes('login'), false); assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false);
  }
});
// ODC Service identity: the app-user anchor is registered from the private descriptor after the authenticated login.
const USER_KEY = '9F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9';
function anchorFixture(t, { identityMatches = true, userKey = USER_KEY } = {}) {
  const f = fixture(t), anchors = [];
  f.services.prepareUser = async (input, { sessionId }) => { f.events.push('login'); return { ok: true, descriptor: { credentialRef: '11111111-2222-4333-8444-555555555555',
    binding: appUserBinding(input, sessionId), expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'authenticated', authenticated: true, userKey } }; };
  const create = f.services.broker;
  f.services.broker = options => ({ ...create(options), authenticate: async () => ({ authenticated: true, identityMatches }) });
  f.services.registerAppUserAnchor = anchor => { f.events.push('anchor'); anchors.push(anchor); };
  return { f, anchors };
}
test('the app-user anchor is registered only after an authenticated identity-matched login, before any request, and never returned', async t => {
  const { f, anchors } = anchorFixture(t);
  const result = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.events, ['prepare', 'login', 'anchor', 'first', 'second', 'dispose', 'release']);
  assert.equal(anchors.length, 1); assert.equal(anchors[0].kind, 'app-user');
  assert.deepEqual(result.appUserAnchor, { registered: true, valueReturned: false });
  assert.doesNotMatch(JSON.stringify(result) + fs.readFileSync(result.receiptPath, 'utf8'), /9f1e2d3c/i);
  // Identity not proved: refused before the anchor and before any request.
  const unproved = anchorFixture(t, { identityMatches: false });
  const refused = await runOdcNativeLive({ trace: 'none' }, unproved.f.prepared, unproved.f.readers, unproved.f.services);
  assert.equal(refused.error, 'debug_odc_native_native_identity_unproved'); assert.deepEqual(unproved.anchors, []);
  assert.equal(refused.appUserAnchor, undefined); assert.equal(refused.credentialsReleased, true);
  // A descriptor without a GUID userKey cannot become an anchor: no request is sent.
  const bad = anchorFixture(t, { userKey: 'not-a-guid' });
  const missing = await runOdcNativeLive({ trace: 'none' }, bad.f.prepared, bad.f.readers, bad.f.services);
  assert.equal(missing.error, 'debug_odc_native_app_user_anchor_unavailable'); assert.deepEqual(missing.results, []);
  assert.deepEqual(bad.anchors, []); assert.equal(missing.uncertain, false); assert.equal(missing.lockRetained, false);
});
test('anonymous and native-background runs never register an app-user anchor', async t => {
  for (const contextMode of ['anonymous', 'native-background']) {
    const { f, anchors } = anchorFixture(t);
    const result = await runOdcNativeLive({ trace: 'none', contextMode }, f.prepared, f.readers, f.services);
    assert.equal(result.ok, true, result.error); assert.deepEqual(anchors, []); assert.equal(f.events.includes('anchor'), false);
    assert.equal(result.appUserAnchor, undefined);
  }
});

// Producer End output vs original response: the coordinator's End capture and the response prints meet here; counts only.
test('producer parity counts are attached per scenario; response prints never reach the receipt and are never substituted', async t => {
  const { createProducerOutputParity } = await import('../debug-server-private-inspection.mjs');
  const { createNativeResponseObserver } = await import('../debug-odc-native-response-observer.mjs');
  const f = fixture(t), parity = createProducerOutputParity(), END = 'E'.repeat(22);
  const leaf = (p, value) => ({ type: 'Scalar', value, path: p, unavailable: false, undefined: false, trimmed: false, deferred: false, children: [] });
  const channel = { consume: async (descriptor, context, consumer) => { await consumer(leaf(descriptor.root, descriptor.value)); return { consumed: true }; } };
  let keySeen; const printed = [];
  const create = f.services.broker;
  f.services.producerOutputParity = parity;
  f.services.broker = options => { const broker = create(options); return { ...broker,
    prepare: async input => { keySeen = input.responseParityKey; return broker.prepare(input); },
    invoke: async call => {
      await broker.invoke(call);
      const context = { threadId: 'T', eventId: '1', functionKey: f.actionKey, nodeKey: END };
      // Coordinator at the target End stop (first scenario only): private-read output roots feed the comparator.
      if (call.name === 'first') await parity.captureEnd(channel, [{ root: 'Amount', privateInspection: { root: 'Amount', value: '12.50' } },
        { root: 'Label', privateInspection: { root: 'Label', value: '"PRIVATE-Ω"' } }], context, { functionKey: f.actionKey, endNodeKey: END });
      const observer = createNativeResponseObserver({ parityKey: keySeen });
      observer.observe(JSON.stringify({ type: 3, invocationId: '0', result: { ResponseStatusCode: 200,
        ResponseBody: JSON.stringify({ data: { Amount: 12.5, Label: 'PRIVATE-Ω-ORIGINAL' } }) } }) + '\x1e', '0');
      const prints = observer.responsePrints('0'); printed.push(...prints.leaves.flat(2));
      return { name: call.name, ok: true, data: { Amount: 12.5, Label: 'PRIVATE-Ω-ORIGINAL' }, responseParity: prints };
    } }; };
  const result = await runOdcNativeLive({ trace: 'none' }, f.prepared, f.readers, f.services);
  assert.equal(result.ok, true, result.error); assert.equal(keySeen, parity.responseKey());
  assert.deepEqual(result.results[0].producerOutputParity, { schema: 'ssam-producer-output-parity/1', complete: true, compared: 2, unequal: 1, missing: 0, extra: 0, typeDifferences: 0, parityEqual: false });
  assert.equal(result.results[1].producerOutputParity.reason, 'producer-end-not-captured');
  assert.equal(result.results[0].data.Label, 'PRIVATE-Ω-ORIGINAL', 'the original response is never replaced by debugger values');
  for (const r of result.results) assert.equal(Object.hasOwn(r, 'responseParity'), false);
  const persisted = fs.readFileSync(result.receiptPath, 'utf8');
  assert.doesNotMatch(persisted, /ssam-native-response-prints|"leaves"/); assert.ok(printed.length > 0);
  for (const value of printed.filter(v => /^[a-f0-9]{64}$/.test(v))) assert.equal(persisted.includes(value), false, 'no response fingerprint persisted');
  // Without a parity coordinator the private prints are still stripped and no key is sent.
  const g = fixture(t), plain = g.services.broker; let sent;
  g.services.broker = options => { const broker = plain(options); return { ...broker, prepare: async input => { sent = input; return broker.prepare(input); },
    invoke: async call => ({ ...await broker.invoke(call), responseParity: { schema: 'ssam-native-response-prints/1', complete: true, leaves: [] } }) }; };
  const bare = await runOdcNativeLive({ trace: 'none' }, g.prepared, g.readers, g.services);
  assert.equal(bare.ok, true); assert.equal(Object.hasOwn(sent, 'responseParityKey'), false);
  for (const r of bare.results) { assert.equal(Object.hasOwn(r, 'responseParity'), false); assert.equal(Object.hasOwn(r, 'producerOutputParity'), false); }
});

import './fixtures/isolated-profile.mjs';
import { foreignImport, gatedTest } from './fixtures/debug-foreign-gate.mjs';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
// Port D7: timer-background pending in the consolidation; the tests that reach it skip by name (fixtures/debug-foreign-gate.mjs).
const test = gatedTest(undefined, foreignPendingReason('timer-background')); // every test runs the original wake/workflow runner
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareNativeEntry } from '../debug-odc-native-run.mjs';
import { debugRun, debugRunToolSchema, nativeEntrySchema } from '../debug-run.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
const { nativeOdcTimerWake } = await foreignImport('../debug-odc-native-wake-run.mjs', import.meta.url, 'timer-background');

const fixtureSource = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-odc-timer-wake-native-reading.json', import.meta.url)));
const TIMER = 'vDFxJr0BpU2dT_t3MFr4uA', ACTION = 'enYyh0j2rU+mJNNtMLmr_A', CALLER = 'urnMDNjf+Uez2lw9hLc75A';
const FP = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const bound = (fp = FP, end = fp) => [{ functionKey: ACTION, threadId: 2, eventId: '5', ...(fp ? { nativeRequestIdSha256: fp } : {}) },
  { kind: 'thread-end', threadId: 2, eventId: '9', ...(end ? { nativeRequestIdSha256: end } : {}) }];
const flatten = node => [node, ...node.children.flatMap(flatten)];
function screenCaller(trees) {
  // The native proof-5 fixture predates its screen caller. Add a synthetic
  // original ScreenAction in the test, leaving the native fixture unchanged.
  const client = trees.find(n => n.kind === 'ClientAction');
  const screenPath = 'MobileFlow:Probe/MobileScreen:Probe/ScreenAction:RunManualTimerProbe';
  const keys = new Map(flatten(client).map(n => [n.key, createHash('sha256').update('screen:' + n.key).digest().subarray(0, 16).toString('base64').replaceAll('/', '_').replace(/=+$/, '')]));
  let json = JSON.stringify(client);
  for (const [oldKey, newKey] of [...keys].sort((a, b) => b[0].length - a[0].length)) json = json.replaceAll(oldKey, newKey);
  const tree = JSON.parse(json.replaceAll(client.path, screenPath)
    .replaceAll('ExecuteServerActionNode:WakeManualTimer', 'ExecuteClientActionNode:RequestManualTimer')
    .replaceAll('"ExecuteServerActionNode"', '"ExecuteClientActionNode"'));
  tree.kind = 'ScreenAction'; tree.name = tree.properties.Name = 'RunManualTimerProbe';
  const call = tree.children.find(n => n.kind === 'ExecuteClientActionNode');
  call.name = call.properties.Name = client.name; call.properties.Action = client.path;
  call.propertyReferences.Action = { kind: client.kind, name: client.name, key: client.key, reference: '@' + client.key, path: client.path };
  trees.push(tree); return tree.key;
}
function fixture(t, { withScreen = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-timer-wake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trees = structuredClone(fixtureSource.trees), screenEntry = withScreen ? screenCaller(trees) : null, all = trees.flatMap(flatten);
  const get = selector => all.find(n => n.key === selector.replace(/^@/, '') || n.path === selector || n.name === selector);
  const file = path.join(root, 'base.oml'); fs.writeFileSync(file, 'synthetic-published-bytes');
  const readers = { async: true, tree: async s => get(s), properties: async s => { const n = get(s); return { ...n, nativeEntryKind: ['ScreenAction', 'ClientAction'].includes(n?.kind) ? 'client-action' : null }; },
    list: async kind => trees.filter(n => n.kind === kind), inputs: async () => [], argumentsOf: async () => [], closure: async () => [],
    resolveTarget: async s => { const n = get(s); return { key: n.key, name: n.name, kind: n.kind, path: n.path, inputs: [], closureCalls: [] }; },
    usages: async key => all.filter(n => n.propertyReferences?.Action?.key === key).map(n => ({ consumer: { kind: n.kind, key: n.key, path: n.path } })),
    sourceContract: { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
    binding: { tenant: 'personal.example.test', module: 'SSAMDbgWorkflowProducer', moduleKey: 'yxrq9gPJC0qKPoiEdBf4UA',
      environmentKey: 'dev', revision: 7, runtimeUrl: 'https://personal.example.test/SSAMDbgWorkflowProducer/' },
    runtime: { moduleVersion: 'r7' }, verifyPublication: async () => {} };
  const input = { op: 'run', lane: 'odc', execution: 'native-entry', tenant: readers.binding.tenant, module: readers.binding.module,
    action: '@' + ACTION, contextMode: 'native-background', launch: { contextMode: 'app-user', inputs: {} },
    trace: 'full', depth: 4, acknowledgeEffects: ['timer-wake'], timeoutSeconds: 5, words: 'Run this Timer diagnostic in DEV' };
  const calls = []; let sessionId, reserved = 0;
  const services = { root, readers, journal: async () => {},
    resolveRuntime: prepared => ({ member: { key: prepared.entry.key }, inputs: [] }),
    prepareUser: async (binding, scope) => ({ ok: true, descriptor: { binding: appUserBinding(binding, scope.sessionId), expiresAt: new Date(Date.now() + 60000).toISOString() } }),
    releaseUser: async () => ({ ok: true }),
    debug: async (request, privateContext) => {
      calls.push(request.op);
      if (request.op === 'stop') return { ok: true, state: 'stopped' };
      assert.deepEqual(privateContext, { backgroundWatch: true, contextMode: 'native-background' });
      assert.deepEqual(request.trace.scopes, { [ACTION]: ['Counter'] }); assert.equal(request.trace.depth, 4);
      return { ok: true, state: 'connected', sessionId: 'timer-session' };
    },
    observeWorkflow: async () => {},
    traceRead: () => bound(),
    broker: ({ beforeRequest }) => ({ prepare: async request => { sessionId = request.sessionId;
      assert.equal(request.prepared.action.key, CALLER); assert.notEqual(request.prepared.action.key, ACTION);
      assert.equal(request.prepared.entry.key, screenEntry); assert.equal(request.prepared.entry.kind, 'ScreenAction'); },
      authenticate: async () => ({ authenticated: true, identityMatches: true }),
      invoke: async request => { assert.equal(request.id, 'wake-1'); assert.deepEqual(request.inputs, {});
        assert.equal(await beforeRequest({ bindingSessionId: sessionId, probeId: 'wake-1-1', privateEvidenceConfirmed: true, nativeCallContextSha256: null }), true);
        reserved++; calls.push('wake'); return { ok: true, uncertain: false }; },
      dispose: async () => ({ completed: true, receipt: { transport: { uncertain: false, executeRequestSubmissions: reserved } } }) }) };
  return { input, readers, services, get, calls, screenEntry };
}

test('real ODC Timer projection proves the owned native wake signature without an invented property getter', t => {
  const f = fixture(t), timer = f.get('@' + TIMER);
  assert.equal(timer.propertyReferences.WakeTimerAction, undefined);
  assert.equal(nativeOdcTimerWake(timer).wakeActionKey, TIMER + '.#WakeTimer');
  assert.equal(nativeOdcTimerWake(timer).actionKey, ACTION);
});

test('Timer or owned ServerAction resolve to original wake caller and background body scopes', async t => {
  const f = fixture(t);
  for (const key of [TIMER, ACTION]) {
    const p = await prepareNativeEntry({ ...f.input, action: '@' + key, persist: false }, f.readers);
    assert.equal(p.adapter.kind, 'timer-original-wake'); assert.equal(p.adapter.directActivityInvocation, false);
    assert.equal(p.entry.key, f.screenEntry); assert.equal(p.entry.kind, 'ScreenAction');
    assert.deepEqual(p.emission.path.map(n => n.kind), ['ScreenAction', 'ClientAction', 'ServerAction']);
    assert.equal(p.emission.action.key, CALLER); assert.deepEqual(p.tracePlan.scopes, { [ACTION]: ['Counter'] });
    assert.deepEqual(p.needs.acknowledgeEffects, ['timer-wake']); assert.equal(p.adapter.executionCompleted, false);
  }
  const noScreen = fixture(t, { withScreen: false });
  await assert.rejects(prepareNativeEntry(noScreen.input, noScreen.readers), /original_caller_entry_unavailable/);
  assert.deepEqual(noScreen.calls, []);
});

test('native uppercase Timer source hash qualifies without weakening source validation', async t => {
  const f = fixture(t);
  f.readers.sourceContract.sha256 = f.readers.sourceContract.sha256.toUpperCase();
  assert.equal((await prepareNativeEntry(f.input, f.readers)).adapter.kind, 'timer-original-wake');
  for (const hash of ['Z'.repeat(64), '0'.repeat(64), 'abc']) {
    f.readers.sourceContract.sha256 = hash;
    await assert.rejects(prepareNativeEntry(f.input, f.readers), /published_source_changed/);
  }
});

test('public Timer launch preserves the empty app-user request and rejects direct inputs or anonymous mode', t => {
  const f = fixture(t), parsed = nativeEntrySchema.parse(debugRunToolSchema.parse(f.input));
  assert.deepEqual(parsed.launch, f.input.launch); assert.equal(parsed.words, f.input.words);
  for (const extra of [{ inputs: {} }, { contextMode: 'app-user' }, { launch: { inputs: { Counter: 1 } } }, { launch: { inputs: {}, contextMode: 'anonymous' } }])
    assert.equal(nativeEntrySchema.safeParse({ ...f.input, ...extra }).success, false);
});

test('MCP runs the original authenticated wake once and keeps scheduling distinct from completion', async t => {
  const f = fixture(t), result = await debugRun(debugRunToolSchema.parse(f.input), { services: f.services });
  assert.equal(result.ok, true); assert.equal(result.state, 'scheduled'); assert.equal(result.scheduled, true);
  assert.equal(result.wakeRequestAnswered, true); assert.equal(result.eventEmissionAnswered, undefined);
  assert.equal(result.backgroundTrace.traceVerified, true); assert.equal(result.executionCompleted, false);
  assert.equal(result.requestOwnershipProved, false); assert.equal(result.appUserIdentityProved, false);
  assert.equal(result.lockRetained, false); assert.equal(result.credentialsReleased, true);
  assert.deepEqual(f.calls, ['watch', 'wake', 'stop']);
  assert.equal(result.instanceCorrelation, undefined); assert.equal(result.wakeOwnershipProved, false);
  // Correlator outcomes: read-only Portal correlation after the wake, ThreadEnd and debugger stop; scheduling stays distinct.
  for (const [found, proved, completed, outcome] of [
    [{ state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: FP, executionCompleted: true, outcome: 'completed', wakeOwnershipProved: true, processingStatus: 'Finished', incompleteReasons: [] }, true, true, 'completed'],
    [{ state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: FP, executionCompleted: true, outcome: 'failed', wakeOwnershipProved: false, processingStatus: 'Finished' }, true, true, 'failed'],
    [{ state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: FP, executionCompleted: false, outcome: 'pending', processingStatus: 'Processing' }, true, false, 'pending'],
    [{ state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: OTHER, executionCompleted: true, outcome: 'completed', wakeOwnershipProved: true }, false, false, 'unproved'],
    [{ state: 'ambiguous', instanceCorrelationProved: false, executionCompleted: false, outcome: 'unproved' }, false, false, 'unproved']]) {
    const g = fixture(t), seen = {};
    g.services.timerInstance = { baseline: async () => { g.calls.push('baseline'); return { available: true, state: { isRunning: false } }; },
      observe: async args => { g.calls.push('observe'); Object.assign(seen, args); return found; },
      release: async () => { g.calls.push('portal-release'); return { released: true }; } };
    const r = await debugRun(debugRunToolSchema.parse(g.input), { services: g.services });
    assert.equal(r.ok, true); assert.equal(r.scheduled, true); assert.deepEqual(g.calls, ['baseline', 'watch', 'wake', 'stop', 'observe', 'portal-release']);
    assert.equal(seen.threadOutcome.requestBound, true); assert.deepEqual(seen.threadOutcome.fingerprints, [FP]);
    assert.ok(Date.parse(seen.window.since) <= Date.parse(seen.window.until)); assert.deepEqual(seen.baseline.state, { isRunning: false });
    assert.equal(r.instanceCorrelationProved, proved); assert.equal(r.executionCompleted, completed); assert.equal(r.outcome, outcome);
    assert.equal(r.wakeOwnershipProved, proved && found.wakeOwnershipProved === true);
    assert.equal(r.portalCredentialsReleased, true); assert.equal(r.credentialsReleased, true); assert.equal(r.lockRetained, false);
    assert.deepEqual(r.instanceWindow, seen.window);
  }
});

test('Portal credentials are released in finally; a refused or cancelled wake is never correlated', async t => {
  const f = interactive(fixture(t)), order = [];
  f.services.timerInstance = { baseline: async () => { order.push('baseline'); return { available: true, state: null }; },
    observe: async () => assert.fail('no correlation without an answered wake'), release: async () => { order.push('release'); return { released: true }; } };
  f.services.beforeServerInvocation = async () => { throw new Error('debug_server_session_cancelled'); };
  const result = await debugRun(debugRunToolSchema.parse(f.input), { services: f.services });
  assert.equal(result.ok, false); assert.equal(result.error, 'debug_server_session_cancelled'); assert.deepEqual(order, ['baseline', 'release']);
  assert.equal(result.portalCredentialsReleased, true); assert.equal(result.instanceCorrelation.state, 'not-observed');
  const g = fixture(t);
  g.services.timerInstance = { baseline: async () => { throw new Error('portal down'); }, observe: async () => ({ state: 'unavailable', reason: 'portal_session_unavailable' }),
    release: async () => { throw new Error('release failed'); } };
  const failed = await debugRun(debugRunToolSchema.parse(g.input), { services: g.services });
  assert.equal(failed.instanceBaseline.available, false); assert.equal(failed.portalCredentialsReleased, false);
  assert.equal(failed.uncertain, true); assert.equal(failed.lockRetained, true); assert.equal(failed.ok, false);
});

function interactive(f, expiresAt = new Date(Date.now() + 45000).toISOString()) {
  f.services.prepareServerInspection = async () => {};
  const debug = f.services.debug, broker = f.services.broker;
  f.services.debug = async (...args) => { const r = await debug(...args); return args[0].op === 'watch' ? { ...r, inspectionMode: 'interactive', autoContinue: false, expiresAt } : r; };
  f.services.broker = options => ({ ...broker(options), configureServerInspection: async request => ({ configured: true, ...request }) });
  return f;
}
// Server scope reads mirror NativeInspection output (debug-background-correlation tests).
const ctx = { runtime: 'server', threadId: '2', eventId: '5', generation: 1 };
const variable = (reference, name, category = 'local') => ({ reference, name, category });
const value = (reference, path, over = {}) => ({ reference, path, category: 'local', type: 'Scalar', value: '1', textOffset: 0, textLength: 1,
  nextTextOffset: null, valueComplete: true, nativeSummary: false, redacted: false, unavailable: false, undefined: false, trimmed: false, deferred: false, hasChildren: false, ...over });
const read = (reference, v) => ({ ok: true, context: ctx, reference, value: v, children: [], offset: 0, nextOffset: null, availableChildren: 0, deferred: false, nativeTrimmed: false, redacted: false });

test('interactive Timer ok only with a request-bound ThreadEnd', async t => {
  const ok = interactive(fixture(t)), good = await debugRun(debugRunToolSchema.parse(ok.input), { services: ok.services });
  assert.equal(good.ok, true); assert.equal(good.backgroundTrace.requestBound, true); assert.deepEqual(good.backgroundTrace.endedFingerprints, [FP]);
  for (const [lines, verified] of [[bound(FP, OTHER), false], [bound(null, null), true], [bound(FP, null), true]]) {
    const f = interactive(fixture(t)); f.services.traceRead = () => lines;
    const result = await debugRun(debugRunToolSchema.parse(f.input), { services: f.services });
    assert.equal(result.wakeRequestAnswered, true); assert.equal(result.backgroundTrace.traceVerified, verified);
    assert.equal(result.backgroundTrace.requestBound, false); assert.equal(result.ok, false);
    assert.equal(result.error, 'debug_odc_workflow_request_bound_thread_end_missing'); assert.equal(result.lockRetained, false);
    assert.deepEqual(f.calls, ['watch', 'wake', 'stop']);
  }
});

test('interactive Timer values coverage is computed per root: Counter complete, Timers roots native-unavailable', async t => {
  const timers = [variable('r1', 'Counter'), variable('r2', 'Timers.ManualTimer', 'site')];
  const cases = [[[{ scopeVariables: [variable('r1', 'Counter')], reads: [read('r1', value('r1', 'Counter'))] }], true],
    [[{ scopeVariables: timers, reads: [read('r1', value('r1', 'Counter')), read('r2', value('r2', 'Timers.ManualTimer', { valueComplete: false, undefined: true, value: '-undefined-' }))] }], false]];
  for (const [stops, complete] of cases) {
    const f = interactive(fixture(t)); f.services.scopeEvidence = async () => stops;
    const result = await debugRun(debugRunToolSchema.parse(f.input), { services: f.services });
    assert.equal(result.ok, true); assert.equal(result.valuesComplete, complete); assert.equal(result.valuesCoverage.valuesComplete, complete);
    assert.equal(result.background.valuesComplete, complete); assert.equal(result.results.at(-1).valuesCoverage.valuesComplete, complete);
    assert.equal(result.valuesCoverage.roots.find(r => r.name === 'Counter').state, 'complete');
    assert.deepEqual(result.valuesCoverage.nativeUnavailableRoots.map(r => r.name), complete ? [] : ['Timers.ManualTimer']);
    assert.doesNotMatch(JSON.stringify(result), /-undefined-/);
  }
  // A bounded automatic trace never claims complete values.
  const f = fixture(t), auto = await debugRun(debugRunToolSchema.parse(f.input), { services: { ...f.services, scopeEvidence: async () => cases[0][0] } });
  assert.equal(auto.valuesComplete, false); assert.equal(auto.valuesCoverage.reason, 'bounded_trace_without_native_completeness');
});

test('interactive ODC Timer binds its native body before sign-in and preserves the debugger deadline', async t => {
  const f=fixture(t), order=[], expiresAt=new Date(Date.now()+45000).toISOString();
  f.services.prepareServerInspection=async binding=>{
    order.push('metadata');assert.equal(binding.functionKey,ACTION);assert.equal(binding.source,f.readers.sourceContract);
    assert.equal(binding.moduleKey,f.readers.binding.moduleKey);
  };
  const signIn=f.services.prepareUser;
  f.services.prepareUser=async(...args)=>{order.push('sign-in');return signIn(...args);};
  const broker=f.services.broker;
  f.services.broker=options=>({...broker(options),configureServerInspection:async request=>{
    order.push('deadline');assert.equal(request.expiresAt,expiresAt);return {configured:true,...request};
  }});
  const debug=f.services.debug;
  f.services.debug=async(...args)=>{
    const result=await debug(...args);return args[0].op==='watch'?{...result,inspectionMode:'interactive',autoContinue:false,expiresAt}:result;
  };
  f.services.beforeServerInvocation=async()=>order.push('before-invocation');
  f.services.observeWorkflow=async(session,key,seconds)=>{assert.equal(key,ACTION);assert.ok(seconds>35&&seconds<=45);};
  const result=await debugRun(debugRunToolSchema.parse(f.input),{services:f.services});
  assert.deepEqual(order,['metadata','sign-in','deadline','before-invocation']);
  assert.equal(result.ok,true);assert.equal(result.serverTrace.inspectionMode,'interactive');
  assert.equal(result.serverTrace.requestDeadline,expiresAt);assert.equal(result.executionCompleted,false);
  assert.equal(result.requestOwnershipProved,false);assert.equal(result.wakeRequestAnswered,true);
});

test('interactive ODC Timer refuses a debugger without a valid deadline before reserving the wake', async t=>{
  const f=fixture(t);f.services.prepareServerInspection=async()=>{};
  const result=await debugRun(debugRunToolSchema.parse(f.input),{services:f.services});
  assert.equal(result.ok,false);assert.equal(result.error,'debug_odc_workflow_interactive_deadline_invalid');
  assert.equal(f.calls.includes('wake'),false);assert.equal(result.credentialsReleased,true);assert.equal(result.lockRetained,false);
});

test('cancellation before the interactive Timer invocation releases the session without scheduling', async t=>{
  const f=fixture(t),expiresAt=new Date(Date.now()+45000).toISOString();
  f.services.prepareServerInspection=async()=>{};
  const debug=f.services.debug,broker=f.services.broker;
  f.services.debug=async(...args)=>{const r=await debug(...args);return args[0].op==='watch'?{...r,inspectionMode:'interactive',autoContinue:false,expiresAt}:r;};
  f.services.broker=options=>({...broker(options),configureServerInspection:async request=>({configured:true,...request})});
  f.services.beforeServerInvocation=async()=>{throw new Error('debug_server_session_cancelled');};
  const result=await debugRun(debugRunToolSchema.parse(f.input),{services:f.services});
  assert.equal(result.ok,false);assert.equal(result.error,'debug_server_session_cancelled');
  assert.equal(f.calls.includes('wake'),false);assert.equal(result.serverTrace.stopped,true);
  assert.equal(result.cleanup.completed,true);assert.equal(result.credentialsReleased,true);assert.equal(result.lockRetained,false);
});

test('wrong signature/body or changed caller path refuses before login and wake', async t => {
  const f = fixture(t); f.get('@' + TIMER).children.find(n => n.kind === 'ActionSignature').key = 'B'.repeat(22) + '.#WakeTimer';
  await assert.rejects(prepareNativeEntry({ ...f.input, persist: false }, f.readers), /signature_unavailable/);
  const g = fixture(t); g.get('@' + CALLER).children.find(n => n.kind === 'ExecuteServerActionNode').propertyReferences.Action.path = 'ServerAction:Fake';
  await assert.rejects(prepareNativeEntry({ ...g.input, persist: false }, g.readers), /original_caller_ambiguous_or_absent/);
  assert.deepEqual(f.calls, []); assert.deepEqual(g.calls, []);
});

test('a disabled wake or a caller with additional executable nodes is not a qualified original trigger', async t => {
  const f = fixture(t), call = f.get('@' + CALLER).children.find(n => n.kind === 'ExecuteServerActionNode');
  call.properties.IsDisabled = 'True';
  await assert.rejects(prepareNativeEntry({ ...f.input, persist: false }, f.readers), /caller_flow_unqualified/);
  const g = fixture(t), caller = g.get('@' + CALLER), additional = structuredClone(caller.children.find(n => n.kind === 'ExecuteServerActionNode'));
  additional.key = 'C'.repeat(22); caller.children.push(additional); caller.childrenTotal++;
  await assert.rejects(prepareNativeEntry({ ...g.input, persist: false }, g.readers), /caller_flow_unqualified/);
});

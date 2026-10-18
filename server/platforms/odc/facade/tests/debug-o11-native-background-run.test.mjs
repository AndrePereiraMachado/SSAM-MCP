import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createO11NativeRun } from '../debug-o11-native-run.mjs';
import { createO11Lifecycle } from '../debug-o11-lifecycle.mjs';

const key = c => c.repeat(22), hash = b => createHash('sha256').update(b).digest('hex');
function fixture(t, kind = 'Timer', uncertain = false, nativeInventory = undefined, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-bg-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = (name, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), file = path.join(root, name);
    fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) }; };
  const input = { op: 'run', lane: 'o11', host: 'dev.example.test', module: 'Jobs', moduleKey: key('a'), applicationKey: key('z'),
    runtimeUrl: 'https://dev.example.test/Jobs/', action: 'Nightly', timeoutSeconds: 30, trace: 'none', contextMode: 'native-background' };
  const snapshot = pin('source.oml', 'synthetic'), calls = [], watches = [], observations = [];
  const timer = { kind, name: 'Nightly', key: key('b'), path: kind + ':Nightly', properties: {},
    children: [], childrenTotal: 0, childrenOmitted: 0, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [],
    propertyReferences: { Action: { key: key('c'), kind: 'ServerAction', name: 'Run' } } };
  const action = { kind: 'ServerAction', name: 'Run', key: key('c'), path: 'ServerAction:Run', properties: {},
    children: [{ kind: 'StartNode', key: key('d'), properties: {}, children: [] }, ...(options.actionChildren ?? [])],
    childrenTotal: 1 + (options.actionChildren?.length ?? 0), childrenOmitted: options.actionOmitted ?? 0 };
  const freshAction = { ...action, children: [{ ...action.children[0], key: options.rebuiltStartKey ?? key('d') }, ...action.children.slice(1)] };
  const readings = [{ tree: timer }, { tree: action }, ...(options.extraReadings ?? []).map(tree => ({ tree }))];
  const lifecycle = createO11Lifecycle({ root,
    nativeInventory: async () => { throw Error('debug_native_background_native_module_id_unavailable'); },
    readTree: async (_base, selector) => { calls.push('tree-' + selector); return { tree: selector === '@' + action.key ? freshAction : timer }; },
    cli: async (verb, args) => {
    calls.push(verb);
    if (verb === 'inventory') return { host: input.host, capturedAtUtc: new Date().toISOString(), modules: [{
      ...nativeInventory, Name: input.module, Key: input.moduleKey, ApplicationKey: input.applicationKey, VersionId: 7, IsActive: true }] };
    if (verb === 'download') return { Status: 'ok', IsPublishedVersion: true, Key: input.moduleKey, Name: input.module,
      VersionId: 7, FilePath: snapshot.path };
    if (verb === 'inspect') return { Key: input.moduleKey, Name: input.module };
    throw Error('unexpected native lifecycle operation ' + verb);
  } });
  if (nativeInventory !== undefined) {
    const cacheDirectory = path.join(root, '.local/debugger/native-runs/o11/model-cache'); fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(path.join(cacheDirectory, snapshot.sha256 + '.json'), JSON.stringify({
      schema: options.cacheSchema ?? 'ssam-o11-native-model-cache/4', readerGeneration: options.readerGeneration ?? 'operational',
      nativeEntriesProjection: options.projection ?? 'callbacks-and-block-instances/2',
      sourceSha256: snapshot.sha256, readings,
      // Any historical identity on a reading cache is irrelevant: inventory must always come from this capture.
      inventoryProof: { modules: [{ ModuleId: 999 }] }, moduleId: 999,
    }));
  }
  const runner = createO11NativeRun({ root,
    ...(nativeInventory !== undefined ? { lifecycle } : { capture: async target => ({ versionId: 7, snapshot, readings, inventoryProof: pin('inventory.json', {
      host: target.host, capturedAtUtc: new Date().toISOString(), modules: [{ ModuleId: 7, Name: 'Jobs', Key: target.moduleKey, ApplicationKey: target.applicationKey,
        VersionId: 7, IsActive: true }] }) }),
    }),
    assets: async () => { throw Error('background must not load AMD'); },
    modelRead: async args => { const kind = args[args.indexOf('--kind') + 1]; calls.push('list-' + kind);
      return { ok: true, data: { searchComplete: true, entries: kind === timer.kind ? [{ key: timer.key }] : kind === action.kind ? [{ key: action.key }] : [] } }; },
    endpointPublicationCheck: async () => calls.push('publication'),
    debug: options.debug ? async (request, context) => { calls.push('debug-' + request.op); return options.debug(request, context); } : async (request, context) => {
      calls.push('debug-' + request.op);
      if (request.op === 'stop') return { ok: !options.stopUncertain, state: options.stopUncertain ? 'stop-uncertain' : 'stopped' };
      watches.push(request);
      assert.equal(request.op, 'watch'); assert.deepEqual(request.nodeKeys, [options.expectedTraceStart ?? key('d')]);
      assert.equal(request.autoContinue, true); assert.deepEqual(request.paths, []);
      assert.equal(request.trace.focusFunctionKey, options.expectedTraceKey ?? key('c'));
      assert.equal(request.trace.requireFunctionKey, options.expectedTraceKey ?? key('c'));
      assert.deepEqual(context, { backgroundWatch: true, contextMode: 'native-background' });
      return { ok: !options.startFailed, state: options.startFailed ? 'not-started' : 'connected', sessionId: 'e'.repeat(32) };
    },
    observeBackground: async (...args) => { calls.push('observe'); observations.push(args); },
    traceRead: () => options.traceLines ?? [{ kind: 'visit', functionKey: key('c'), nodeKey: key('d'), threadId: 1, values: [] }, { kind: 'thread-end', threadId: 1 }],
    backgroundAdapter: {
      prepare: async plan => { calls.push('prepare'); return { ...plan, nativeAuthenticationQualified: true }; },
      run: async (plan, request) => { calls.push('run'); assert.equal(request.context, 'native-background'); assert.equal(request.authorizationWords, input.words);
        return options.runResult ?? { ok: false, scheduled: !uncertain, outcome: uncertain ? 'uncertain' : 'scheduled', executionObserved: false, executionCompleted: false }; },
    },
    ...(options.services ?? {}),
  });
  return { runner, input, calls, watches, observations };
}

test('background timer requires explicit context and words; scheduler acceptance never becomes debugger completion', async t => {
  const f = fixture(t);
  assert.match((await f.runner({ ...f.input, contextMode: 'app-user' })).error, /explicit_context_required/);
  assert.match((await f.runner(f.input)).error, /explicit_background_authorization_required/); assert.deepEqual(f.calls, []);
  const prepared = await f.runner({ ...f.input, op: 'prepare' }); assert.equal(prepared.ok, true, prepared.error);
  assert.equal(prepared.background.applicationUserContext, false); assert.equal(prepared.background.nativeAuthenticationQualified, true);
  f.input.words = 'Run this timer in its native background context';
  const run = await f.runner(f.input); assert.equal(run.state, 'scheduled'); assert.equal(run.ok, false); assert.equal(run.executionCompleted, false);
  assert.equal(run.lockRetained, false); assert.deepEqual(f.calls, ['prepare', 'prepare', 'publication', 'run']);
});

test('Timer nodes trace observes a native background thread but never attributes it to scheduler acceptance', async t => {
  const f = fixture(t); f.input.words = 'Run once in background';
  const prepared = await f.runner({ ...f.input, op: 'prepare', trace: 'nodes' });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.tracePlan.requestOwnershipProved, false);
  assert.deepEqual(f.calls, ['prepare']);
  const run = await f.runner({ ...f.input, trace: 'nodes' });
  assert.equal(run.state, 'scheduled'); assert.equal(run.ok, false); assert.equal(run.executionCompleted, false);
  assert.equal(run.backgroundTrace.captured, true); assert.equal(run.backgroundTrace.observedThreadEnds, 1);
  for (const flag of ['requestOwnershipProved', 'appUserIdentityProved', 'rolesProved', 'executionCompleted']) assert.equal(run.backgroundTrace[flag], false);
  assert.equal(run.serverTrace.stopped, true); assert.equal(run.lockRetained, false);
  assert.deepEqual(f.calls, ['prepare', 'prepare', 'publication', 'debug-watch', 'run', 'observe', 'debug-stop']);
  assert.equal(f.watches[0].trace.fullValues, false); assert.deepEqual(f.watches[0].trace.scopes, {});
});

test('uncertain timer submission keeps observing before stopping and retains the replay lock',async t=>{
 const f=fixture(t,'Timer',true);f.input.words='Run once in native background';
 const result=await f.runner({...f.input,trace:'nodes'});
 assert.equal(result.state,'uncertain');assert.equal(result.lockRetained,true);
 assert.equal(result.backgroundTrace.captured,true);assert.equal(result.executionCompleted,false);
 assert.deepEqual(f.calls,['prepare','publication','debug-watch','run','observe','debug-stop']);
 const refused=await f.runner({...f.input,trace:'nodes'});assert.match(refused.error,/binding_busy/);
 assert.equal(f.calls.filter(c=>c==='run').length,1);
});

test('Timer full trace uses only original action roots and requested depth while completion and access remain unproved', async t => {
  const f = fixture(t, 'Timer', false, undefined, { actionChildren: [
    { kind: 'InputParameter', name: 'Request', key: key('h'), properties: {} },
    { kind: 'LocalVariable', name: 'Count', key: key('i'), properties: {} },
    { kind: 'LocalVariable', name: 'Password', key: key('j'), properties: {} },
    { kind: 'OutputParameter', name: 'Result', key: key('k'), properties: {} },
    { kind: 'ExecuteServerActionNode', name: 'Call', key: key('l'), properties: { Name: 'Lookup' } },
  ] });
  f.input.words = 'Run once in native background';
  const prepared = await f.runner({ ...f.input, op: 'prepare', trace: 'full', depth: 4 });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.tracePlan.mode, 'full');
  assert.equal(prepared.tracePlan.fullValues, true); assert.equal(prepared.tracePlan.depth, 4);
  const scopes = { [key('c')]: ['Request', 'Count', 'Password', 'Result', 'Lookup'] };
  assert.deepEqual(prepared.tracePlan.scopes, scopes); assert.equal(prepared.tracePlan.omittedScopeRoots, 0);
  assert.equal(f.watches.length, 0, 'preparation never connects or invokes');
  const run = await f.runner({ ...f.input, trace: 'full', depth: 4 });
  assert.equal(run.state, 'scheduled'); assert.equal(run.ok, false);
  assert.equal(f.watches[0].trace.fullValues, true); assert.equal(f.watches[0].trace.depth, 4);
  assert.deepEqual(f.watches[0].trace.scopes, scopes);
  for (const object of [run.tracePlan, run.backgroundTrace])
    for (const flag of ['requestOwnershipProved', 'appUserIdentityProved', 'rolesProved', 'propagationProved', 'valuesComplete', 'executionCompleted'])
      assert.equal(object[flag], false, flag);
  assert.equal(run.backgroundTrace.captured, true); assert.equal(run.serverTrace.stopped, true);
  assert.equal(f.calls.filter(c => c === 'run').length, 1); assert.equal(f.calls.filter(c => c === 'debug-stop').length, 1);
});

test('Timer full trace refuses incomplete action scopes before authentication or scheduling and reports scope bounds', async t => {
  const missing = fixture(t, 'Timer', false, undefined, { actionOmitted: 1 });
  const refused = await missing.runner({ ...missing.input, op: 'prepare', trace: 'full' });
  assert.equal(refused.error, 'debug_native_background_target_scope_unread'); assert.deepEqual(missing.calls, []);
  const bounded = fixture(t, 'Timer', false, undefined, { actionChildren: Array.from({ length: 61 }, (_, i) => ({
    kind: 'LocalVariable', name: 'Value' + i, key: String(i).padStart(22, 'v'), properties: {} })) });
  const prepared = await bounded.runner({ ...bounded.input, op: 'prepare', trace: 'full' });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.tracePlan.depth, 2);
  assert.equal(prepared.tracePlan.scopes[key('c')].length, 60); assert.equal(prepared.tracePlan.omittedScopeRoots, 1);
  assert.equal(prepared.tracePlan.valuesComplete, false);
});

test('Timer -> Run -> Foo traces the requested Foo only; observing Run alone never marks Foo captured', async t => {
  const foo = { kind: 'ServerAction', name: 'Foo', key: key('m'), path: 'ServerAction:Foo', properties: {},
    childrenTotal: 2, childrenOmitted: 0, children: [
      { kind: 'StartNode', key: key('n'), properties: {}, children: [] },
      { kind: 'LocalVariable', name: 'FooValue', key: key('o'), properties: {} },
    ] };
  for (const captured of [false, true]) {
    const f = fixture(t, 'Timer', false, undefined, {
      actionChildren: [{ kind: 'ExecuteServerActionNode', key: key('p'), properties: { Name: 'CallFoo' },
        propertyReferences: { Action: { kind: 'ServerAction', key: foo.key, name: foo.name } } }],
      extraReadings: [foo], expectedTraceKey: foo.key, expectedTraceStart: key('n'),
      traceLines: [
        { kind: 'visit', functionKey: key('c'), nodeKey: key('d'), threadId: 'RunOnly', values: [{ path: 'CallerValue', value: 'caller' }] },
        { kind: 'thread-end', threadId: 'RunOnly' },
        ...(captured ? [{ kind: 'visit', functionKey: foo.key, nodeKey: key('n'), threadId: 'FooThread', values: [{ path: 'FooValue', value: '42' }] },
          { kind: 'thread-end', threadId: 'FooThread' }] : []),
      ],
    });
    f.input.action = 'Foo'; f.input.words = 'Run timer to observe Foo in native background';
    const run = await f.runner({ ...f.input, trace: 'full', depth: 3 });
    assert.equal(run.state, 'scheduled', run.error); assert.equal(run.background.actionKey, key('c'), 'trigger remains the original Timer Run');
    assert.equal(run.tracePlan.functionKey, foo.key); assert.equal(run.tracePlan.startNodeKey, key('n'));
    assert.deepEqual(f.watches[0].trace.scopes, { [foo.key]: ['FooValue'] });
    assert.equal(f.watches[0].trace.depth, 3); assert.equal(f.observations[0][1], foo.key);
    assert.equal(run.backgroundTrace.functionKey, foo.key); assert.equal(run.backgroundTrace.captured, captured);
    assert.equal(run.backgroundTrace.observedThreadEnds, captured ? 1 : 0);
    assert.equal(run.backgroundTrace.visits.length, captured ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(run.backgroundTrace.visits), /CallerValue|caller/);
    assert.equal(run.backgroundTrace.executionCompleted, false); assert.equal(run.backgroundTrace.requestOwnershipProved, false);
    assert.equal(f.calls.filter(c => c === 'run').length, 1); assert.equal(run.serverTrace.stopped, true);
  }
});

test('Timer indirect capture refuses unsupported target kinds before native preparation or invocation', async t => {
  const service = { kind: 'ServiceAction', name: 'ServiceFoo', key: key('m'), path: 'ServiceAction:ServiceFoo', properties: {},
    childrenTotal: 1, childrenOmitted: 0, children: [{ kind: 'StartNode', key: key('n'), properties: {}, children: [] }] };
  const f = fixture(t, 'Timer', false, undefined, {
    actionChildren: [{ kind: 'ExecuteServiceActionNode', key: key('p'), properties: { Name: 'CallServiceFoo' },
      propertyReferences: { Action: { kind: service.kind, key: service.key, name: service.name } } }], extraReadings: [service],
  });
  const result = await f.runner({ ...f.input, op: 'prepare', action: service.name, trace: 'full' });
  assert.equal(result.error, 'debug_native_background_target_kind_unsupported'); assert.deepEqual(f.calls, []);
});

test('Timer watch refusal sends no scheduler request and an uncertain stop retains the binding', async t => {
  const failed = fixture(t, 'Timer', false, undefined, { startFailed: true }); failed.input.words = 'Run once';
  const rejected = await failed.runner({ ...failed.input, trace: 'nodes' });
  assert.match(rejected.error, /server_trace_not_connected/); assert.equal(failed.calls.includes('run'), false);
  assert.equal(failed.calls.filter(c => c === 'debug-stop').length, 1);
  const uncertain = fixture(t, 'Timer', false, undefined, { stopUncertain: true }); uncertain.input.words = 'Run once';
  const receipt = await uncertain.runner({ ...uncertain.input, trace: 'nodes' });
  assert.equal(receipt.uncertain, true); assert.equal(receipt.lockRetained, true); assert.equal(receipt.executionCompleted, false);
  assert.equal(uncertain.calls.filter(c => c === 'run').length, 1); assert.equal(uncertain.calls.filter(c => c === 'debug-stop').length, 1);
  assert.equal((await uncertain.runner({ ...uncertain.input, trace: 'nodes' })).error, 'debug_o11_native_binding_busy');
});

test('background uncertain trigger retains the binding; BPT exposes the missing original instance capability', async t => {
  const f = fixture(t, 'Timer', true); f.input.words = 'Run once in background';
  const run = await f.runner(f.input); assert.equal(run.uncertain, true); assert.equal(run.lockRetained, true);
  assert.equal((await f.runner(f.input)).error, 'debug_o11_native_binding_busy'); assert.equal(f.calls.filter(c => c === 'run').length, 1);
  const process = fixture(t, 'Process'); const refused = await process.runner({ ...process.input, op: 'prepare' });
  assert.match(refused.error, /bpt_requires_original_launch_or_existing_instance/); assert.equal(refused.state, 'entry-not-runnable');
  assert.deepEqual(process.calls, []);
});

test('default published capture preserves verified native ModuleId through lifecycle and cached readings', async t => {
  const f = fixture(t, 'Timer', false, { ModuleId: 81 });
  const prepared = await f.runner({ ...f.input, op: 'prepare' });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.background.moduleId, '81');
  assert.deepEqual(f.calls, ['inventory', 'download', 'inspect', 'prepare']);
  const legacy = fixture(t, 'Timer', false, { Id: 81 });
  const refused = await legacy.runner({ ...legacy.input, op: 'prepare' });
  assert.equal(refused.error, 'debug_native_background_native_module_id_unavailable');
  assert.deepEqual(legacy.calls, ['inventory', 'download', 'inspect', 'inventory']);
  const malformed = fixture(t, 'Timer', false, { ModuleId: '81' });
  assert.equal((await malformed.runner({ ...malformed.input, op: 'prepare' })).error, 'debug_o11_native_module_id_invalid');
  assert.deepEqual(malformed.calls, ['inventory']);
});

test('cache v3 refreshes background, Preparation and SOAP kinds and preserves unrelated immutable action readings', async t => {
  const f = fixture(t, 'Timer', false, { ModuleId: 81 }, { cacheSchema: 'ssam-o11-native-model-cache/3' });
  const prepared = await f.runner({ ...f.input, op: 'prepare', trace: 'nodes' });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.tracePlan.functionKey, key('c'));
  assert.deepEqual(f.calls, ['inventory', 'download', 'inspect', 'list-Process', 'list-ProcessFlow', 'list-Timer', 'tree-@' + key('b'),
    ...PROJECTION_LISTS, 'prepare']);
});

// Callback flows (native-callback edges) and block instances (block-render edges) joined the projection in wave 2.
const PROJECTION_LISTS = ['Preparation', 'WebServiceMethod', 'RestService', 'RestServiceAuthenticationFlow', 'RestServiceCallbackActionFlow',
  'RestCallbackActionFlow', 'SOAPCallbackActionFlow', 'WebBlockInstanceWidget'].map(kind => 'list-' + kind);
test('cache v4 with the previous entries projection re-reads only the projection kinds', async t => {
  const f = fixture(t, 'Timer', false, { ModuleId: 81 }, { projection: 'soap-webservice-and-preparation/1' });
  const prepared = await f.runner({ ...f.input, op: 'prepare', trace: 'nodes' });
  assert.equal(prepared.ok, true, prepared.error);
  assert.deepEqual(f.calls, ['inventory', 'download', 'inspect', ...PROJECTION_LISTS, 'prepare']);
});

test('cache v4 from another reader generation rebuilds actions and background projections', async t => {
  const f = fixture(t, 'Timer', false, { ModuleId: 81 }, { readerGeneration: 'retired-reader', rebuiltStartKey: key('f') });
  const prepared = await f.runner({ ...f.input, op: 'prepare', trace: 'nodes' });
  assert.equal(prepared.ok, true, prepared.error);
  assert.equal(prepared.tracePlan.startNodeKey, key('f'), 'the old action projection must not be marked as the new generation');
  for (const call of ['list-ServerAction', 'tree-@' + key('c'), 'list-ServerActionSignature', 'list-Process', 'list-ProcessFlow', 'list-Timer', 'tree-@' + key('b')])
    assert.ok(f.calls.includes(call), call);
  f.calls.length = 0;
  const cached = await f.runner({ ...f.input, op: 'prepare', trace: 'nodes' });
  assert.equal(cached.ok, true, cached.error); assert.equal(cached.tracePlan.startNodeKey, key('f'));
  assert.deepEqual(f.calls, ['inventory', 'download', 'inspect', 'prepare']);
});

// Wave 2 (P12): an O11 Timer without a REST/SOAP caller, inspected through one Service Center Run Now inside ssam_debug_server.
function runNowFixture(t, options = {}) {
  const events = [];
  const services = {
    prepareServerInspection: async binding => { events.push('prepare-scope:' + binding.functionKey); },
    beforeServerInvocation: async (...args) => { events.push('before:' + args.length); },
    ...(options.services ?? {}),
  };
  const debug = async (request, context) => {
    events.push('debug-' + request.op);
    if (request.op === 'stop') return { ok: true, state: 'stopped' };
    assert.equal(request.op, 'watch'); assert.equal(request.autoContinue, false); assert.equal(request.trace, undefined);
    assert.deepEqual(context, { backgroundWatch: true, contextMode: 'native-background' });
    return { ok: true, state: 'connected', sessionId: 'e'.repeat(32), inspectionMode: 'interactive', autoContinue: false, expiresAt: new Date(Date.now() + 60000).toISOString() };
  };
  const f = fixture(t, 'Timer', false, undefined, { debug, services, ...(options.runResult ? { runResult: options.runResult } : {}) });
  Object.assign(f.input, { trace: 'full', trigger: 'service-center-run-now', words: 'Run the fixture Timer once' });
  return { ...f, events };
}
test('Run Now: scope binding precedes the single Run Now, no request hold is opened and the debugger stops before correlation', async t => {
  const f = runNowFixture(t);
  const run = await f.runner(f.input);
  assert.equal(run.state, 'answered', run.error); assert.equal(run.uncertain, false); assert.equal(run.lockRetained, false);
  assert.deepEqual(f.events, ['prepare-scope:' + key('c'), 'debug-watch', 'before:0', 'debug-stop']);
  assert.equal(f.calls.filter(c => c === 'run').length, 1);
  assert.equal(run.tracePlan.trigger, 'service-center-run-now'); assert.equal(run.serverTrace.stopped, true);
  assert.equal(run.instanceCorrelation.state, 'unavailable'); assert.equal(run.executionCompleted, false);
  assert.equal(run.results[0].traceVerified, true); assert.equal(run.results[0].requestBound, false);
});
test('Run Now accepted-unverified is uncertain, keeps the lock and is never resent', async t => {
  const f = runNowFixture(t, { runResult: { ok: false, scheduled: false, accepted: true, outcome: 'uncertain', executionCompleted: false } });
  const run = await f.runner(f.input);
  assert.equal(run.state, 'uncertain'); assert.equal(run.lockRetained, true);
  const again = await f.runner(f.input);
  assert.equal(again.error, 'debug_o11_native_binding_busy'); assert.equal(f.calls.filter(c => c === 'run').length, 1);
});
test('Run Now never-list binding is refused before the Service Center form read and before scope binding', async t => {
  const f = runNowFixture(t);
  const run = await f.runner({ ...f.input, moduleKey: 'bf7WCuRy7keTqvquautTGg' });
  assert.equal(run.error, 'debug_native_background_binding_blocked'); assert.equal(run.lockRetained, false);
  assert.deepEqual(f.calls.filter(c => ['prepare', 'run'].includes(c)), []); assert.deepEqual(f.events, []);
});
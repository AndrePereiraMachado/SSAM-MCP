import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareNativeEntry, runNativeEntry } from '../debug-odc-native-run.mjs';
import { compileNativeRestEndpoint } from '../debug-native-endpoint.mjs';
import { debugRun } from '../debug-run.mjs';
import { restFixture } from './fixtures/debug-native-rest-fixture.mjs';
import { runOdcNativeEndpoint } from '../debug-odc-native-endpoint-run.mjs';
import { headlessDebug } from '../debug-runtime.mjs';
import { randomUUID } from 'node:crypto';
import { endpointCredentialBinding } from '../debug-app-user.mjs';
import { customFixture } from './fixtures/debug-native-custom-fixture.mjs';

function fixture(t, authentication = 'None') {
  const f = restFixture('odc', authentication), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-odc-rest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'published.oml'); fs.writeFileSync(source, f.oml);
  const signature = [{ name: 'Value', key: f.model.tree.children[0].children[0].key, dataType: 'Text', mandatory: true }];
  const readers = { binding: f.binding, sourceContract: { path: source, sha256: f.binding.sourceSha256 },
    resolveTarget: async () => ({ ...f.entry, inputs: signature, closureCalls: [] }), usages: () => [],
    // The published RestService (no callback set) and its action, by path.
    properties: selector => selector === 'RestService:Api' ? { ...f.model.tree, path: selector } : { ...f.model.tree.children[0], path: f.entry.path }, inputs: () => signature,
    prepareEndpoint: async () => ({ contract: f.contract, plan: compileNativeRestEndpoint(f.contract) }),
  };
  return { ...f, root, readers, input: { op: 'run', lane: 'odc', execution: 'native-entry', tenant: f.binding.tenant,
    module: 'App', action: f.entry.key, inputs: { Value: 'hello' }, contextMode: 'anonymous', trace: 'none' } };
}

test('interactive anonymous ODC endpoint binds inspection before sending, preserves deadline and stops once', async t => {
  const f = fixture(t), events = [], lines = [], expiresAt = new Date(Date.now() + 60000).toISOString();
  const prepared = { endpointContract: f.contract, action: { key: f.entry.key }, entry: f.entry,
    scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }], bindings: [] };
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.entry.key });
  const result = await runOdcNativeEndpoint({ ...f.input, trace: 'full' }, prepared, f.readers, {
    root: f.root, traceRead: () => lines,
    prepareUser: async () => assert.fail('anonymous inspection must not prompt for app credentials'),
    prepareServerInspection: async scope => {
      events.push('bind'); assert.equal(scope.lane, 'odc');
      assert.equal(scope.functionKey, f.entry.key); assert.deepEqual(scope.source, f.readers.sourceContract);
    },
    debug: async (args, context) => {
      events.push(args.op);
      if (args.op === 'stop') return { ok: true, state: 'stopped' };
      assert.equal(args.op, 'watch'); assert.equal(context.anonymousWatch, true);
      return { ok: true, state: 'connected', sessionId: 'native-session', inspectionMode: 'interactive', autoContinue: false, expiresAt };
    },
    beforeServerInvocation: async () => events.push('ready'),
    invokeEndpoint: async args => {
      events.push('send'); assert.equal(args.inspectionExpiresAt, expiresAt);
      assert.equal(args.context, 'explicit-anonymous'); assert.equal(args.descriptor, undefined);
      lines.push({ functionKey: f.entry.key, threadId: 'thread' }, { kind: 'thread-end', threadId: 'thread' });
      return { ok: true, sent: true, answered: true, uncertain: false };
    }
  });
  assert.equal(result.ok, true, result.error); assert.equal(result.lockRetained, false);
  assert.equal(result.appRequestIdentityProved, false);
  assert.deepEqual(events, ['bind', 'watch', 'ready', 'send', 'stop']);
});

test('actual inspection preflight refusal is recorded before any native or endpoint start', async t => {
  const f=fixture(t);
  const prepared={endpointContract:f.contract,action:{key:f.entry.key},entry:f.entry,
    scenarios:[{name:'first',inputs:{Value:{value:'hello'}}}],bindings:[]};
  f.readers.traceTarget=async()=>({nodeKeys:['A'.repeat(22)],actionKey:f.entry.key});
  const result=await runOdcNativeEndpoint({...f.input,trace:'full'},prepared,f.readers,{
    root:f.root,prepareServerInspection:async()=>{},
    debug:async args=>headlessDebug({...args,op:'start',autoContinue:false,trace:undefined},
      {anonymousWatch:true,contextMode:'anonymous',anonymousInspection:{}}),
    invokeEndpoint:async()=>assert.fail('endpoint must not start')
  });
  assert.equal(result.error,'debug_o11_anonymous_inspection_context_invalid');
  assert.equal(result.uncertain,false);assert.equal(result.lockRetained,false);
  assert.equal(result.results.length,0);
  assert.deepEqual(result.serverTrace,{state:'not-started',failurePhase:'inspection-preflight',workerStarted:false,uncertain:false});
});

for (const failure of ['missing-id', 'expired-deadline', 'cancel-before-send', 'stop-unconfirmed']) {
  test(`interactive ODC endpoint ${failure} never sends and preserves cleanup uncertainty`, async t => {
    const f = fixture(t), commands = [];
    const prepared = { endpointContract: f.contract, action: { key: f.entry.key }, entry: f.entry,
      scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }], bindings: [] };
    f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.entry.key });
    const result = await runOdcNativeEndpoint({ ...f.input, trace: 'full' }, prepared, f.readers, {
      root: f.root, traceRead: () => [], prepareServerInspection: async () => {},
      prepareUser: async () => assert.fail('unexpected app login'),
      debug: async args => {
        commands.push(args.op);
        if (args.op === 'stop') return { ok: failure !== 'stop-unconfirmed', state: failure === 'stop-unconfirmed' ? 'unknown' : 'stopped' };
        return { ok: true, state: 'connected', ...(failure === 'missing-id' ? {} : { sessionId: 'native-session' }),
          inspectionMode: 'interactive', autoContinue: false,
          expiresAt: new Date(Date.now() + (failure === 'expired-deadline' ? -1000 : 60000)).toISOString() };
      },
      beforeServerInvocation: async () => { throw new Error('debug_server_session_cancelled'); },
      invokeEndpoint: async () => assert.fail('request must not be sent')
    });
    assert.equal(result.ok,false); assert.equal(result.results.length,0);
    assert.deepEqual(commands, failure === 'missing-id' ? ['watch'] : ['watch','stop']);
    const uncertain = ['missing-id','stop-unconfirmed'].includes(failure);
    assert.equal(result.uncertain,uncertain); assert.equal(result.lockRetained,uncertain);
    if (failure === 'missing-id') assert.equal(result.error,'debug_native_endpoint_trace_session_id_missing');
    if (failure === 'expired-deadline') assert.equal(result.error,'debug_native_endpoint_inspection_deadline_unavailable');
  });
}

test('public ODC REST route prepares native metadata and sends once with explicit anonymous context', async t => {
  const f = fixture(t), calls = [];
  const prepared = await prepareNativeEntry({ ...f.input, persist: false }, f.readers);
  assert.equal(prepared.adapter.kind, 'rest-method'); assert.equal(prepared.adapter.authentication.executable, true);
  assert.equal(JSON.stringify(prepared).includes('endpointContract'), false);
  const result = await debugRun(f.input, { services: { root: f.root, readers: f.readers, journal: async () => {},
    invokeEndpoint: async args => { calls.push(args); return { ok: true, sent: true, answered: true, uncertain: false, result: { outputs: { Result: 'hello' } } }; } } });
  assert.equal(result.ok, true, result.error); assert.equal(result.lockRetained, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].context, 'explicit-anonymous'); assert.equal(calls[0].descriptor, undefined);
  assert.deepEqual(calls[0].inputs, { Value: 'hello' }); assert.equal(result.appRequestIdentityProved, false);
});

test('ODC REST never promotes an anonymous endpoint or unqualified Basic auth to app-user access', async t => {
  const f = fixture(t), basic = fixture(t, 'Basic'); let calls = 0;
  const services = { root: f.root, invokeEndpoint: async () => { calls++; }, prepareUser: async () => { calls++; } };
  const needsContext = await runNativeEntry({ ...f.input, contextMode: undefined }, f.readers, services);
  assert.equal(needsContext.state, 'context-required');
  const unqualified = await runNativeEntry({ ...basic.input, contextMode: 'app-user' }, basic.readers, { ...services, root: basic.root });
  assert.equal(unqualified.state, 'authentication-unqualified'); assert.equal(calls, 0);
});

test('ODC Basic is a typed SSAM policy refusal before any dialog, lock or request', async t => {
  const basic = fixture(t, 'Basic'), counts = { prepareUser: 0, invokeEndpoint: 0, debug: 0, prepareServerInspection: 0 };
  const services = { root: basic.root, prepareUser: async () => { counts.prepareUser++; }, invokeEndpoint: async () => { counts.invokeEndpoint++; },
    debug: async () => { counts.debug++; }, prepareServerInspection: async () => { counts.prepareServerInspection++; } };
  const prepared = await prepareNativeEntry({ ...basic.input, op: 'prepare', persist: false }, basic.readers);
  assert.equal(prepared.adapter.authentication.error, 'debug_native_endpoint_odc_basic_unqualified');
  assert.equal(prepared.adapter.authentication.alias, 'debug_native_endpoint_basic_credentials_unavailable_after_odc_srp');
  for (const contextMode of ['app-user', 'anonymous', undefined]) for (const trace of ['none', 'full']) {
    const result = await runOdcNativeEndpoint({ ...basic.input, contextMode, trace }, { ...prepared, endpointContract: basic.contract,
      action: { key: basic.entry.key }, scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }] }, basic.readers, services);
    assert.equal(result.state, 'authentication-unqualified'); assert.equal(result.ok, false);
    assert.equal(result.error, 'debug_native_endpoint_odc_basic_unqualified');
    assert.equal(result.errorAlias, 'debug_native_endpoint_basic_credentials_unavailable_after_odc_srp');
    assert.equal(result.policy, 'ssam'); assert.equal(result.platformLimit, false); assert.match(result.limitation, /not a platform limit/);
  }
  const routed = await runNativeEntry({ ...basic.input, contextMode: 'app-user' }, basic.readers, services);
  assert.equal(routed.error, 'debug_native_endpoint_odc_basic_unqualified');
  assert.deepEqual(counts, { prepareUser: 0, invokeEndpoint: 0, debug: 0, prepareServerInspection: 0 });
  assert.equal(fs.existsSync(path.join(basic.root, '.local', 'debugger')), false);
});

test('uncertain ODC REST stops the batch and another run cannot bypass its binding lock', async t => {
  const f = fixture(t); let sends = 0;
  const input = { ...f.input, inputs: undefined, scenarios: [{ name: 'first', inputs: { Value: 'a' } }, { name: 'second', inputs: { Value: 'b' } }] };
  const services = { root: f.root, invokeEndpoint: async () => { sends++; return { ok: false, sent: true, answered: false, uncertain: true }; } };
  const first = await runNativeEntry(input, f.readers, services);
  assert.equal(first.state, 'uncertain'); assert.equal(first.lockRetained, true); assert.deepEqual(first.notSent, ['second']);
  const repeated = await runNativeEntry(input, f.readers, services);
  assert.equal(repeated.error, 'debug_odc_native_binding_busy'); assert.equal(sends, 1);
});

test('endpoint scenario validation happens before login, locks or sends', async t => {
  const f = fixture(t);
  await assert.rejects(runNativeEntry({ ...f.input, inputs: { Value: 123 } }, f.readers, { root: f.root }), /input_type_invalid/);
  await assert.rejects(runNativeEntry({ ...f.input, context: { screen: {} } }, f.readers, { root: f.root }), /screen_context_unsupported/);
  assert.equal(fs.existsSync(path.join(f.root, '.local', 'debugger')), false);
});

test('service-app public ServerAction resolves through its original REST caller without a client bundle', async t => {
  const f = fixture(t), targetKey = 'T'.repeat(22), targetPath = 'ServerAction:PublicWork';
  const signature = [{ name: 'Value', key: 'V'.repeat(22), dataType: 'Text', mandatory: true }];
  const target = { key: targetKey, kind: 'ServerAction', path: targetPath, name: 'PublicWork', properties: { Name: 'PublicWork', Public: 'True' } };
  const originalProperties = f.readers.properties;
  f.readers.runtime = null;
  f.readers.resolveTarget = async () => ({ ...target, inputs: signature, closureCalls: [] });
  f.readers.properties = selector => selector === targetPath || selector === '@' + targetKey ? target : originalProperties(selector);
  f.readers.inputs = () => signature;
  f.readers.usages = key => key === targetKey ? [{ consumer: { kind: 'ExecuteServerActionNode',
    path: f.entry.path + '/ExecuteServerActionNode:PublicWork' } }] : [];
  f.readers.argumentsOf = () => [{ parameterName: 'Value', value: 'Value' }];
  const input = { ...f.input, action: targetKey };
  const prepared = await prepareNativeEntry({ ...input, persist: false }, f.readers);
  assert.equal(prepared.entry.key, f.entry.key);
  assert.equal(prepared.entry.entryKind, 'rest-method');
  assert.equal(prepared.entry.distance, 1);
  assert.equal(prepared.bindings[0].control, 'direct');
  let sends = 0;
  const result = await runNativeEntry(input, f.readers, { root: f.root, invokeEndpoint: async request => {
    sends++; assert.deepEqual(request.inputs, { Value: 'hello' });
    return { ok: true, sent: true, answered: true, uncertain: false };
  } });
  assert.equal(result.ok, true, result.error); assert.equal(sends, 1);
});

test('anonymous cross-module inspection stays refused before any bind, watch or send', async t => {
  const f = fixture(t), events = [];
  const prepared = { endpointContract: f.contract, action: { key: f.entry.key }, entry: f.entry,
    scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }], bindings: [] };
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.entry.key, binding: { ...f.binding, moduleKey: 'P'.repeat(22) } });
  const result = await runOdcNativeEndpoint({ ...f.input, trace: 'full' }, prepared, f.readers, { root: f.root,
    prepareServerInspection: async () => events.push('bind'), debug: async args => { events.push(args.op); },
    invokeEndpoint: async () => assert.fail('request must not be sent') });
  assert.equal(result.error, 'debug_native_endpoint_anonymous_cross_module_inspection_unqualified');
  assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.deepEqual(events, []);
});

// ---- Runner-derived REST callback scopes: exposed service callbacks and consumed RestAction callbacks ----
const K = c => c.repeat(22);
function withCallbacks(f, { baseURL = 'https://dev.example.test/App/rest/Quotes' } = {}) {
  const el = (kind, name, key, p, properties = {}, children = []) => ({ kind, name, key, path: p, properties, children });
  const flow = (kind, name, key, owner, start, properties, input) => { const p = owner + '/' + kind + ':' + name;
    return el(kind, name, key, p, properties, [el('StartNode', 'Start', start, p + '/StartNode:Start'),
      el(input, 'Request', K('i'), p + '/' + input + ':Request'), el('EndNode', 'End', K('z'), p + '/EndNode:End')]); };
  const service = 'RestService:Api', client = 'RestClient:Quotes', other = 'RestService:Other';
  const roots = [
    el('RestService', 'Api', K('S'), service, { Authentication: 'None' }, [el('RestServiceAction', 'Echo', f.entry.key, f.entry.path),
      flow('RestServiceCallbackActionFlow', 'OnRequest', K('Q'), service, K('q'), { CallbackType: 'OnRequest' }, 'RestServiceCallbackActionFlowInput')]),
    el('RestClient', 'Quotes', K('C'), client, { BaseURL: baseURL }, [el('RestAction', 'GetQuote', K('G'), client + '/RestAction:GetQuote'),
      flow('RestCallbackActionFlow', 'OnBeforeRequest', K('B'), client, K('b'), { CallbackType: 'OnBeforeRequest' }, 'RestCallbackActionFlowInputSignature'),
      flow('RestCallbackActionFlow', 'OnAfterResponse', K('F'), client, K('f'), { CallbackType: 'OnAfterResponse' }, 'RestCallbackActionFlowInputSignature')]),
    el('RestService', 'Other', K('O'), other, { Authentication: 'None' }, [el('RestServiceAction', 'Ping', K('P'), other + '/RestServiceAction:Ping'),
      flow('RestServiceCallbackActionFlow', 'OnRequest', K('X'), other, K('x'), { CallbackType: 'OnRequest' }, 'RestServiceCallbackActionFlowInput')]),
  ];
  const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; roots.forEach(walk);
  const reads = [];
  f.readers.properties = selector => { reads.push(selector); return all.find(n => '@' + n.key === selector || n.path === selector) ?? null; };
  f.readers.list = kind => all.filter(n => n.kind === kind).map(({ key, kind, path }) => ({ key, kind, path }));
  const prepared = { endpointContract: f.contract, action: { key: f.entry.key }, entry: f.entry, bindings: [],
    scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }],
    effectEvidence: [{ kind: 'ExecuteServerActionNode', actionKey: K('G'), actionKind: 'RestAction', external: false, bodyRead: false }] };
  return { prepared, reads, input: { ...f.input, trace: 'full', acknowledgeEffects: ['external-http'] } };
}

test('callback scopes are derived from the published model and bound before send (exposed OnRequest, consumed OnBeforeRequest/OnAfterResponse)', async t => {
  const f = fixture(t), c = withCallbacks(f), events = [], lines = [], expiresAt = new Date(Date.now() + 60000).toISOString();
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.entry.key, scopes: { [f.entry.key]: ['Value'] } });
  const result = await runOdcNativeEndpoint(c.input, c.prepared, f.readers, { root: f.root, traceRead: () => lines,
    prepareUser: async () => assert.fail('anonymous inspection must not prompt'),
    prepareServerInspection: async scope => {
      events.push('bind'); assert.equal(scope.functionKey, f.entry.key);
      assert.deepEqual(scope.derivedScopes.map(s => [s.functionKey, s.callback, s.kind, s.nodeKeys, s.source, s.moduleKey]), [
        [K('B'), 'OnBeforeRequest', 'RestCallbackActionFlow', [K('b')], 'runner-derived', f.binding.moduleKey],
        [K('F'), 'OnAfterResponse', 'RestCallbackActionFlow', [K('f')], 'runner-derived', f.binding.moduleKey],
        [K('Q'), 'OnRequest', 'RestServiceCallbackActionFlow', [K('q')], 'runner-derived', f.binding.moduleKey]]);
      // The whole module inventory goes along, so the coordinator refuses a caller scope naming another callback.
      assert.deepEqual(scope.callbackKeys, [K('B'), K('F'), K('Q'), K('X')].map(k => f.binding.moduleKey + ':' + k));
      assert.deepEqual(scope.modules, [f.binding.moduleKey]);
    },
    debug: async (args, context) => {
      events.push(args.op); if (args.op === 'stop') return { ok: true, state: 'stopped' };
      assert.equal(context.anonymousWatch, true);
      assert.deepEqual(args.nodeKeys, ['node', K('b'), K('f'), K('q')]);
      assert.deepEqual(args.trace.scopes, { [f.entry.key]: ['Value'], [K('B')]: ['Request'], [K('F')]: ['Request'], [K('Q')]: ['Request'] });
      assert.equal(args.trace.requireFunctionKey, f.entry.key);
      return { ok: true, state: 'connected', sessionId: 'native-session', inspectionMode: 'interactive', autoContinue: false, expiresAt };
    },
    beforeServerInvocation: async () => events.push('ready'),
    invokeEndpoint: async () => { events.push('send');
      lines.push({ functionKey: f.entry.key, threadId: 'thread' }, { kind: 'thread-end', threadId: 'thread' });
      return { ok: true, sent: true, answered: true, uncertain: false }; } });
  assert.equal(result.ok, true, result.error); assert.equal(result.lockRetained, false);
  assert.deepEqual(events, ['bind', 'watch', 'ready', 'send', 'stop']);
  assert.equal(result.callbackScopes.schema, 'ssam-odc-callback-scopes/1');
  assert.deepEqual(result.serverTrace.callbacks.map(cb => [cb.callback, cb.startNodeKey, cb.consumed]),
    [['OnBeforeRequest', K('b'), true], ['OnAfterResponse', K('f'), true], ['OnRequest', K('q'), false]]);
  // The other service's callback was never read as reachable.
  assert.equal(c.reads.includes('RestService:Other'), false);
});

test('a trace target naming a callback the runner did not derive is refused before any bind, watch or send', async t => {
  const f = fixture(t), c = withCallbacks(f), events = [];
  for (const target of [{ scopes: { [f.entry.key]: [], [K('X')]: ['Request'] } }, { actionKey: K('X') }]) {
    f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.entry.key, ...target });
    const result = await runOdcNativeEndpoint(c.input, c.prepared, f.readers, { root: f.root,
      prepareServerInspection: async () => events.push('bind'), debug: async args => { events.push(args.op); },
      invokeEndpoint: async () => assert.fail('request must not be sent') });
    assert.equal(result.error, 'debug_odc_native_callback_scope_not_derived');
    assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false); assert.equal(result.results.length, 0);
  }
  assert.deepEqual(events, []);
});

test('consumed callbacks run only toward the fixture own runtime origin and under acknowledged external-http', async t => {
  for (const baseURL of ['https://api.foreign.test/v1', 'http://dev.example.test/App/rest/Quotes', '', 'relative/path']) {
    const f = fixture(t), c = withCallbacks(f, { baseURL }), counts = { bind: 0, debug: 0, send: 0, prompt: 0 };
    f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.entry.key });
    const result = await runOdcNativeEndpoint(c.input, c.prepared, f.readers, { root: f.root,
      prepareUser: async () => { counts.prompt++; }, prepareServerInspection: async () => { counts.bind++; },
      debug: async () => { counts.debug++; }, invokeEndpoint: async () => { counts.send++; } });
    assert.equal(result.ok, false); assert.equal(result.state, 'callback-unqualified');
    assert.equal(result.error, 'debug_odc_native_consumed_callback_foreign_origin');
    assert.equal(result.runtimeOrigin, 'https://dev.example.test');
    assert.equal(result.origin, baseURL.startsWith('http') ? new URL(baseURL).origin : null);
    assert.deepEqual(counts, { bind: 0, debug: 0, send: 0, prompt: 0 });
    assert.equal(fs.existsSync(path.join(f.root, '.local', 'debugger')), false);
  }
  const f = fixture(t), c = withCallbacks(f);
  f.readers.traceTarget = async () => assert.fail('no trace before the effects gate');
  for (const acknowledgeEffects of [undefined, [], ['entity-write']]) {
    const result = await runOdcNativeEndpoint({ ...c.input, acknowledgeEffects }, c.prepared, f.readers, { root: f.root,
      invokeEndpoint: async () => assert.fail('request must not be sent') });
    assert.equal(result.state, 'effects-not-acknowledged'); assert.deepEqual(result.missing, ['external-http']);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.local', 'debugger')), false);
});

// ---- ODC Custom endpoint credential (dormant until ODC's request-header API inside OnAuthentication is qualified) ----
function customOdc(t) {
  const c = customFixture({ lane: 'odc' }), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-odc-custom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'published.oml'); fs.writeFileSync(source, c.oml);
  // The O11 reader qualifies the same OnAuthentication; the plan is relabelled for ODC to exercise the runner branch.
  const o11 = compileNativeRestEndpoint(customFixture().contract()), plan = { ...o11, binding: { ...o11.binding, lane: 'odc' } };
  const binding = { ...c.binding, tenant: 'dev.example.test' }, calls = [], invocations = [], prompts = [];
  const readers = { binding, sourceContract: { path: source, sha256: binding.sourceSha256 } };
  const prepared = { endpointContract: c.contract(), action: { key: c.action.key }, entry: { key: c.action.key, entryKind: 'rest-method' },
    scenarios: [{ name: 'first', inputs: { Value: { value: 'hello' } } }], bindings: [] };
  const descriptorFor = (target, sessionId, ms = 60000) => ({ credentialRef: randomUUID(), binding: endpointCredentialBinding(target, sessionId),
    expiresAt: new Date(Date.now() + ms).toISOString(), kind: 'endpoint-credential', state: 'credentials-entered', authenticated: false });
  const services = { root, compileEndpoint: () => plan,
    prepareUser: async () => assert.fail('the app-user dialog is not the endpoint credential'),
    prepareEndpointCredential: async (target, { sessionId }) => { calls.push('prompt'); prompts.push(target);
      return { ok: true, credentialSource: 'private-dialog', descriptor: descriptorFor(target, sessionId) }; },
    releaseEndpointCredential: async descriptor => { calls.push('release:' + descriptor.kind); return { ok: true }; },
    invokeEndpoint: async args => { calls.push('send'); invocations.push(args); return { ok: true, sent: true, answered: true, uncertain: false, memoryReferencesReleased: true }; } };
  return { c, root, plan, readers, prepared, services, calls, invocations, prompts, descriptorFor,
    input: { op: 'run', lane: 'odc', execution: 'native-entry', tenant: binding.tenant, module: 'Store', action: c.action.key, contextMode: 'endpoint-credential', trace: 'none' } };
}

test('ODC Custom without a qualified request-header contract is refused before any dialog, lock or send', async t => {
  const f = customOdc(t); delete f.services.compileEndpoint;
  for (const contextMode of ['endpoint-credential', 'anonymous', undefined]) {
    const result = await runOdcNativeEndpoint({ ...f.input, contextMode }, f.prepared, f.readers, f.services);
    assert.equal(result.state, 'authentication-unqualified'); assert.equal(result.ok, false);
    assert.equal(result.error, 'debug_native_endpoint_custom_authentication_unqualified');
    assert.equal(result.reason, 'debug_native_endpoint_custom_authentication_request_header_api_unqualified');
  }
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(path.join(f.root, '.local', 'debugger')), false);
});

test('qualified ODC Custom requires the endpoint-credential context before the dialog', async t => {
  const f = customOdc(t);
  for (const contextMode of ['anonymous', 'app-user', undefined]) {
    const result = await runOdcNativeEndpoint({ ...f.input, contextMode }, f.prepared, f.readers, f.services);
    assert.equal(result.state, 'context-required'); assert.equal(result.error, 'debug_native_endpoint_context_explicit_required');
  }
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(path.join(f.root, '.local', 'debugger')), false);
});

test('qualified ODC Custom prompts before the trace, sends once with the vault descriptor, redacts only and releases', async t => {
  const f = customOdc(t), lines = [], events = f.calls;
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.c.action.key });
  const result = await runOdcNativeEndpoint({ ...f.input, trace: 'full' }, f.prepared, f.readers, { ...f.services, traceRead: () => lines,
    debug: async (args, context) => {
      events.push(args.op); if (args.op === 'stop') return { ok: true, state: 'stopped' };
      assert.equal(args.op, 'start'); assert.equal(context.redactionOnly, true); assert.equal(context.anonymousWatch, undefined);
      assert.equal(context.appUser.kind, 'endpoint-credential'); assert.equal(f.invocations.length, 0);
      return { ok: true, state: 'connected', sessionId: 'native-session' };
    },
    invokeEndpoint: async args => { events.push('send'); f.invocations.push(args);
      lines.push({ functionKey: f.c.action.key, threadId: 'thread' }, { kind: 'thread-end', threadId: 'thread' });
      return { ok: true, sent: true, answered: true, uncertain: false, memoryReferencesReleased: true }; } });
  assert.equal(result.ok, true, result.error); assert.equal(result.lockRetained, false); assert.equal(result.credentialsReleased, true);
  assert.deepEqual(events, ['prompt', 'start', 'send', 'stop', 'release:endpoint-credential']);
  assert.equal(f.invocations.length, 1); const [sent] = f.invocations;
  assert.equal(sent.context, 'endpoint-credential'); assert.equal(sent.descriptor.kind, 'endpoint-credential');
  for (const field of ['headers', 'credentials', 'endpointCredential', 'privateValues']) assert.equal(Object.hasOwn(sent, field), false);
  assert.deepEqual(f.prompts[0].headers, ['X-Api-Key']); assert.equal(f.prompts[0].serviceKey, f.plan.entry.serviceKey);
  assert.equal(f.prompts[0].revision, 42); assert.equal(f.prompts[0].lane, 'odc');
  assert.equal(result.serverTrace.identityUse, 'redaction-only'); assert.deepEqual(result.endpointHeaders, ['X-Api-Key']);
  assert.equal(result.appRequestIdentityProved, false);
});

test('qualified ODC Custom interactive inspection binds after the dialog and bounds the deadline by the credential', async t => {
  const f = customOdc(t), lines = [], events = f.calls, expiresAt = new Date(Date.now() + 120000).toISOString();
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.c.action.key });
  const result = await runOdcNativeEndpoint({ ...f.input, trace: 'full' }, f.prepared, f.readers, { ...f.services, traceRead: () => lines,
    prepareServerInspection: async () => events.push('bind'), beforeServerInvocation: async () => events.push('ready'),
    debug: async (args, context) => { events.push(args.op); if (args.op === 'stop') return { ok: true, state: 'stopped' };
      assert.equal(context.redactionOnly, true); assert.equal(context.anonymousWatch, undefined);
      return { ok: true, state: 'connected', sessionId: 'native-session', inspectionMode: 'interactive', autoContinue: false, expiresAt }; },
    invokeEndpoint: async args => { events.push('send'); f.invocations.push(args);
      lines.push({ functionKey: f.c.action.key, threadId: 'thread' }, { kind: 'thread-end', threadId: 'thread' });
      return { ok: true, sent: true, answered: true, uncertain: false, memoryReferencesReleased: true }; } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(events, ['prompt', 'bind', 'start', 'ready', 'send', 'stop', 'release:endpoint-credential']);
  // The credential lease (60 s) ends before the native lease (120 s): the request deadline is the earlier one.
  assert.ok(Date.parse(f.invocations[0].inspectionExpiresAt) <= Date.parse(f.invocations[0].descriptor.expiresAt));
});

test('qualified ODC Custom cross-module inspection is refused after the dialog and still releases the credential', async t => {
  const f = customOdc(t);
  f.readers.traceTarget = async () => ({ nodeKeys: ['node'], actionKey: f.c.action.key, producerTarget: { module: 'Producer' } });
  const result = await runOdcNativeEndpoint({ ...f.input, trace: 'full' }, f.prepared, f.readers, { ...f.services,
    debug: async () => assert.fail('no trace'), prepareServerInspection: async () => assert.fail('no bind') });
  assert.equal(result.error, 'debug_native_endpoint_endpoint_credential_cross_module_inspection_unqualified');
  assert.deepEqual(f.calls, ['prompt', 'release:endpoint-credential']); assert.equal(result.lockRetained, false);
});

test('a cancelled endpoint credential dialog sends nothing and keeps no lock', async t => {
  const f = customOdc(t);
  f.services.prepareEndpointCredential = async () => { f.calls.push('prompt'); return { ok: false, state: 'cancelled', error: 'debug_app_user_cancelled' }; };
  const result = await runOdcNativeEndpoint(f.input, f.prepared, f.readers, f.services);
  assert.equal(result.state, 'cancelled'); assert.equal(result.ok, false); assert.equal(result.lockRetained, false);
  assert.deepEqual(f.calls, ['prompt']);
});

test('an uncertain ODC Custom send keeps the binding lock, still releases the credential and blocks a second run', async t => {
  const f = customOdc(t);
  f.services.invokeEndpoint = async args => { f.calls.push('send'); f.invocations.push(args); return { ok: false, sent: true, answered: false, uncertain: true }; };
  const first = await runOdcNativeEndpoint(f.input, { ...f.prepared, scenarios: [...f.prepared.scenarios, { name: 'second', inputs: { Value: { value: 'b' } } }] }, f.readers, f.services);
  assert.equal(first.state, 'uncertain'); assert.equal(first.lockRetained, true); assert.deepEqual(first.notSent, ['second']);
  assert.equal(first.credentialsReleased, true);
  const repeated = await runOdcNativeEndpoint(f.input, f.prepared, f.readers, f.services);
  assert.equal(repeated.error, 'debug_odc_native_binding_busy');
  assert.deepEqual(f.calls, ['prompt', 'send', 'release:endpoint-credential']);
});

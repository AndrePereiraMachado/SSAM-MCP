import test from 'node:test';
import assert from 'node:assert/strict';
import { graphFromReadings, buildO11CallGraph, resolveO11Entry } from '../debug-o11-entry-graph.mjs';
import { deriveO11CallbackScopes, admitO11CallbackScopes, withO11CallbackTrace, o11CallbackFunctionKeys } from '../debug-o11-native-callbacks.mjs';

const A = { module: 'Consumer', moduleKey: 'ConsumerModxxxxxxxxxxx' }, B = { module: 'Producer', moduleKey: 'ProducerModxxxxxxxxxxx' };
const ik = id => id.padEnd(22, 'x');
const nd = (m, kind, name, id, path, properties = {}, children = []) => ({ kind, name, key: id.includes('.#') ? id : ik(id), path,
  properties: { GlobalKey: m.moduleKey + '*' + (id.includes('.#') ? id : ik(id)), ...properties }, propertyReferences: {}, children });
const start = id => ({ kind: 'StartNode', name: '', key: ik(id), properties: {}, propertyReferences: {}, children: [] });
const exec = (id, ref) => ({ kind: 'ExecuteServerActionNode', name: 'Call' + id, key: ik(id), properties: {}, propertyReferences: { Action: ref }, children: [] });
const flow = (m, client, kind, name, id, children) => nd(m, kind, name, id, client + '/' + kind + ':' + name, {}, children);

// Consumer: Preparation -> Fetch -> Weather.GetForecast (OnBeforeRequest, OnAfterResponse) and -> Producer.Remote (its own client callbacks).
// Exposed: RestService ApiBasic (OnAuthentication) and ApiOther (OnAuthentication) in the same module.
function graph() {
  const consumer = [
    nd(A, 'RestClient', 'Weather', 'Client', 'RestClient:Weather', {}, [nd(A, 'RestAction', 'GetForecast', 'Forecast', 'RestClient:Weather/RestAction:GetForecast'),
      flow(A, 'RestClient:Weather', 'RestCallbackActionFlow', 'OnBeforeRequest', 'Before', [start('BS'), { kind: 'AssignNode', name: 'SetHeader', key: ik('BA'), properties: {}, propertyReferences: {}, children: [] }]),
      flow(A, 'RestClient:Weather', 'RestCallbackActionFlow', 'OnAfterResponse', 'After', [start('AfS')])]),
    nd(A, 'ServerAction', 'Fetch', 'Fetch', 'ServerAction:Fetch', {}, [start('FS'),
      exec('FE', { kind: 'RestAction', name: 'GetForecast', key: ik('Forecast'), path: 'RestClient:Weather/RestAction:GetForecast' }),
      exec('FR', { kind: 'ServerActionSignature', name: 'Remote', key: ik('RemoteSig'), path: 'Reference:Producer/ServerActionSignature:Remote' })]),
    nd(A, 'ServerActionSignature', 'Remote', 'RemoteSig', 'Reference:Producer/ServerActionSignature:Remote', { GlobalKey: B.moduleKey + '*' + ik('Remote') }),
    nd(A, 'Preparation', '', ik('Page') + '.#Preparation', 'WebFlow:Main/WebScreen:Page/Preparation:', {}, [start('PS'),
      exec('PE', { kind: 'ServerAction', name: 'Fetch', key: ik('Fetch'), path: 'ServerAction:Fetch' })]),
    nd(A, 'RestService', 'ApiBasic', 'SvcBasic', 'RestService:ApiBasic', { Authentication: 'Basic' }, [
      nd(A, 'RestServiceAction', 'Echo', 'Echo', 'RestService:ApiBasic/RestServiceAction:Echo', {}, [start('ES')]),
      flow(A, 'RestService:ApiBasic', 'RestServiceAuthenticationFlow', 'OnAuthentication', 'AuthBasic', [start('ABS')])]),
    nd(A, 'RestService', 'ApiOther', 'SvcOther', 'RestService:ApiOther', { Authentication: 'Custom' }, [
      nd(A, 'RestServiceAction', 'Other', 'Other', 'RestService:ApiOther/RestServiceAction:Other', {}, [start('OS')]),
      flow(A, 'RestService:ApiOther', 'RestServiceAuthenticationFlow', 'OnAuthentication', 'AuthOther', [start('AOS')])]),
  ];
  const producer = [
    nd(B, 'RestClient', 'Upstream', 'UpClient', 'RestClient:Upstream', {}, [nd(B, 'RestAction', 'Pull', 'Pull', 'RestClient:Upstream/RestAction:Pull'),
      flow(B, 'RestClient:Upstream', 'RestCallbackActionFlow', 'OnBeforeRequest', 'UpBefore', [start('UBS')])]),
    nd(B, 'ServerAction', 'Remote', 'Remote', 'ServerAction:Remote', { Public: 'True' }, [start('RS'),
      exec('RE', { kind: 'RestAction', name: 'Pull', key: ik('Pull'), path: 'RestClient:Upstream/RestAction:Pull' })]),
  ];
  return buildO11CallGraph([graphFromReadings(consumer.map(tree => ({ tree })), A), graphFromReadings(producer.map(tree => ({ tree })), B)]);
}

test('runner derives same-module callback scopes reachable from the resolved entry, start nodes read', () => {
  const g = graph(), r = resolveO11Entry(g, 'Fetch');
  assert.equal(r.entry.entry, 'traditional-preparation');
  const derived = deriveO11CallbackScopes(g, r, { moduleKey: A.moduleKey });
  assert.deepEqual(derived.scopes.map(s => [s.callback, s.functionKey, s.nodeKeys[0], s.source]),
    [['OnAfterResponse', ik('After'), ik('AfS'), 'runner-derived'], ['OnBeforeRequest', ik('Before'), ik('BS'), 'runner-derived']]);
  assert.ok(derived.scopes.every(s => s.moduleKey === A.moduleKey && s.kind === 'RestCallbackActionFlow'));
  assert.deepEqual(derived.excluded.map(e => [e.functionKey, e.reason]), [[ik('UpBefore'), 'cross_module_callback']]);
  const rest = deriveO11CallbackScopes(g, resolveO11Entry(g, 'Echo'), { moduleKey: A.moduleKey });
  assert.deepEqual(rest.scopes.map(s => s.callback + ':' + s.functionKey), ['OnAuthentication:' + ik('AuthBasic')]);
});

test("a caller-supplied callback key of another service or module is refused; only runner-derived same-module callbacks are bound", () => {
  const g = graph(), r = resolveO11Entry(g, 'Echo');
  const derived = deriveO11CallbackScopes(g, r, { moduleKey: A.moduleKey });
  const target = { functionKey: ik('Echo'), nodeKeys: [ik('ES')] };
  const merged = admitO11CallbackScopes({ requested: [target], derived, graph: g, moduleKey: A.moduleKey });
  assert.deepEqual(merged.map(s => s.functionKey), [ik('Echo'), ik('AuthBasic')]);
  assert.equal(merged[1].source, 'runner-derived');
  // The derived callback may also be listed by the caller: kept once.
  assert.equal(admitO11CallbackScopes({ requested: [target, { functionKey: ik('AuthBasic'), nodeKeys: [ik('ABS')] }], derived, graph: g, moduleKey: A.moduleKey }).length, 2);
  for (const requested of [
    [target, { functionKey: ik('AuthOther'), nodeKeys: [ik('AOS')] }],                         // another service's OnAuthentication
    [target, { moduleKey: B.moduleKey, functionKey: ik('UpBefore'), nodeKeys: [ik('UBS')] }],  // another module's client callback
    [target, { functionKey: ik('AuthBasic'), nodeKeys: [ik('Forged')] }],                     // derived callback, foreign node
  ]) assert.throws(() => admitO11CallbackScopes({ requested, derived, graph: g, moduleKey: A.moduleKey }), /debug_o11_native_callback_scope_not_derived/);
  assert.throws(() => admitO11CallbackScopes({ requested: [target], derived: { scopes: [{ ...derived.scopes[0], source: 'caller' }], excluded: [] }, graph: g, moduleKey: A.moduleKey }),
    /debug_o11_native_callback_scope_not_derived/);
  // A session without the graph enforces the same rule from the runner's callback key list.
  const callbackKeys = o11CallbackFunctionKeys(g);
  assert.deepEqual(callbackKeys, [A.moduleKey + ':' + ik('After'), A.moduleKey + ':' + ik('AuthBasic'), A.moduleKey + ':' + ik('AuthOther'), A.moduleKey + ':' + ik('Before'), B.moduleKey + ':' + ik('UpBefore')]);
  assert.throws(() => admitO11CallbackScopes({ requested: [target, { functionKey: ik('AuthOther'), nodeKeys: [ik('AOS')] }], derived, callbackKeys, moduleKey: A.moduleKey }),
    /debug_o11_native_callback_scope_not_derived/);
  assert.equal(admitO11CallbackScopes({ requested: [target], derived, callbackKeys, moduleKey: A.moduleKey }).length, 2);
  assert.throws(() => admitO11CallbackScopes({ requested: [target], derived, moduleKey: A.moduleKey }), /debug_o11_native_callback_scope_not_derived/);
});

test('a malformed callback scope, a callback label the runner did not derive, or a scope of an unread module is a typed refusal', () => {
  const g = graph(), derived = deriveO11CallbackScopes(g, resolveO11Entry(g, 'Echo'), { moduleKey: A.moduleKey });
  const target = { functionKey: ik('Echo'), nodeKeys: [ik('ES')] }, callbackKeys = o11CallbackFunctionKeys(g);
  for (const requested of [
    [target, { functionKey: ik('AuthBasic') }],                                                  // derived callback without nodeKeys
    [target, { functionKey: ik('AuthBasic'), nodeKeys: 'ABS' }],
    [target, { functionKey: ik('Echo'), nodeKeys: [ik('ES')], callback: 'OnAuthentication' }],  // caller labels a non-callback as callback
    [target, { moduleKey: 'UnreadModulexxxxxxxxxx', functionKey: ik('Foreign'), nodeKeys: [ik('FS')] }], // module whose capture was not read
  ]) {
    assert.throws(() => admitO11CallbackScopes({ requested, derived, graph: g, moduleKey: A.moduleKey }), /^Error: debug_o11_native_callback_scope_not_derived$/);
    assert.throws(() => admitO11CallbackScopes({ requested, derived, callbackKeys, moduleKey: A.moduleKey }), /^Error: debug_o11_native_callback_scope_not_derived$/);
  }
  // The producer module is read (it is in the graph / named in modules): its ordinary scopes pass.
  const producerScope = { moduleKey: B.moduleKey, functionKey: ik('Remote'), nodeKeys: [ik('RS')] };
  assert.equal(admitO11CallbackScopes({ requested: [target, producerScope], derived, graph: g, moduleKey: A.moduleKey }).length, 3);
  assert.equal(admitO11CallbackScopes({ requested: [target, producerScope], derived, callbackKeys, modules: [A.moduleKey, B.moduleKey], moduleKey: A.moduleKey }).length, 3);
});

test('trace plan adds derived callback start nodes and scope roots without touching the target focus', () => {
  const g = graph(), derived = deriveO11CallbackScopes(g, resolveO11Entry(g, 'Fetch'), { moduleKey: A.moduleKey });
  const server = { moduleKey: A.moduleKey, functionKey: ik('Fetch'), nodeKeys: [ik('FS')], scopes: { [ik('Fetch')]: ['Input'] } };
  const before = structuredClone(server);
  const traced = withO11CallbackTrace(server, derived, { mode: 'full', readings: [{ tree: { kind: 'RestCallbackActionFlow', key: ik('Before'), children: [start('BS'),
    { kind: 'AssignNode', name: 'SetHeader', key: ik('BA'), properties: {}, propertyReferences: {}, children: [] },
    { kind: 'InputParameter', name: 'Request', key: ik('Req'), properties: {}, propertyReferences: {}, children: [] }] } }] });
  assert.deepEqual(server, before, 'input plan unchanged');
  assert.deepEqual(traced.nodeKeys, [ik('FS'), ik('AfS'), ik('BS')]);
  assert.equal(traced.functionKey, ik('Fetch'));
  assert.deepEqual(traced.scopes[ik('Before')], ['Request']);
  assert.equal(traced.scopes[ik('After')], undefined, 'unread callback model: breakpoint only, no invented roots');
  assert.deepEqual(traced.callbacks.map(c => c.callback), ['OnAfterResponse', 'OnBeforeRequest']);
  assert.deepEqual(withO11CallbackTrace(server, derived, { mode: 'nodes', readings: [] }).scopes, server.scopes);
});

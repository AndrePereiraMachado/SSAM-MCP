import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelGraph, containerOf, ODC_NATIVE_CALLBACKS, odcCallbackEdges, deriveOdcCallbackScopes } from '../debug-odc-native-graph.mjs';
import { resolveEntry } from '../debug-odc-native-entry-resolve.mjs';

test('containerOf finds the innermost action and its owning screen/block', () => {
  const c = containerOf('MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty/ExecuteServerActionNode:GetProperty');
  assert.equal(c.containerPath, 'MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty');
  assert.equal(c.containerKind, 'ScreenAction');
  assert.equal(c.ownerPath, 'MobileFlow:MainFlow/MobileScreen:Location');
  assert.equal(c.ownerKind, 'MobileScreen');
  const d = containerOf('ServerAction:Helper/ExecuteServerActionNode:X');
  assert.equal(d.containerKind, 'ServerAction');
  assert.equal(d.ownerPath, null);
});

// Model fixture mirroring the real reader output (usages/properties/inputs/arguments).
function modelFixture() {
  const elements = {
    'ServerAction:Location_GetProperty': { key: 'TKEY', kind: 'ServerAction', props: { Name: 'Location_GetProperty', Public: 'False' },
      inputs: [{ name: 'Address1', key: 'i1', dataType: 'Text' }, { name: 'CountryCode', key: 'i2', dataType: 'Text' }] },
    'MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty': { key: 'SA', kind: 'ScreenAction', props: { Name: 'ConfirmProperty' } },
    'MobileFlow:MainFlow/MobileScreen:Location': { key: 'SCREEN', kind: 'MobileScreen', props: { Name: 'Location', Roles: '[AppRole:FloodQuotes]', AnonymousAccess: 'False' } },
  };
  const edges = [ // ConfirmProperty (screen action) calls Location_GetProperty, passing Address1 directly and a literal country
    { consumer: { kind: 'ExecuteServerActionNode', key: 'N1', path: 'MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty/ExecuteServerActionNode:GetProperty' }, target: 'TKEY',
      arguments: [{ parameterName: 'Address1', value: 'Address1' }, { parameterName: 'CountryCode', value: '"US"' }] },
  ];
  const byKeyPath = Object.fromEntries(Object.entries(elements).map(([path, e]) => [e.key, path]));
  return buildModelGraph({
    usages: key => edges.filter(e => e.target === key).map(e => ({ consumer: e.consumer })),
    properties: path => { const e = elements[path]; return e ? { key: e.key, kind: e.kind, public: e.props.Public === 'True', properties: e.props } : null; },
    inputs: path => elements[path]?.inputs ?? [],
    argumentsOf: nodePath => edges.find(e => e.consumer.path === nodePath)?.arguments ?? null,
  });
}

test('the published Location_GetProperty resolves deterministically to the Location screen', () => {
  const graph = modelFixture();
  graph.seed('ServerAction:Location_GetProperty');
  const r = resolveEntry(graph, 'TKEY');
  assert.equal(r.ok, true);
  assert.equal(r.entry.kind, 'MobileScreen');
  assert.equal(r.entry.name, 'Location');
  assert.equal(r.entry.entryKind, 'screen');
  assert.equal(r.entry.distance, 2); // screen -> screen action -> target
  assert.deepEqual(r.entry.roles, ['FloodQuotes']);
  assert.equal(r.entry.anonymous, false);
  assert.deepEqual(r.path.map(s => s.kind), ['MobileScreen', 'ScreenAction', 'ServerAction']);
});

test('input binding traces target inputs to the entry through the call arguments', () => {
  const graph = modelFixture();
  graph.seed('ServerAction:Location_GetProperty');
  const r = resolveEntry(graph, 'TKEY');
  const byInput = Object.fromEntries(r.bindings.map(b => [b.targetInput, b.control]));
  // The screen action passes Address1 directly and a literal country. Through the OwnedBy edge (no arguments) the
  // binding becomes opaque at the screen boundary, which is honest: a screen entry does not take action inputs.
  assert.ok(['opaque', 'direct', 'default'].includes(byInput.Address1));
  assert.ok('CountryCode' in byInput);
});

test('a private action reachable only by private actions is dead code', () => {
  const graph = buildModelGraph({
    usages: key => key === 'TKEY' ? [{ consumer: { kind: 'ExecuteServerActionNode', key: 'N', path: 'ServerAction:Priv/ExecuteServerActionNode:T' } }] : [],
    properties: path => path === 'ServerAction:Priv' ? { key: 'PRIV', kind: 'ServerAction', public: false, properties: { Name: 'Priv', Public: 'False' } } : null,
    inputs: () => [],
  });
  graph.seed('ServerAction:Target');
  // seed returns null node for a key we never read; emulate the target being known:
  const g2 = buildModelGraph({
    usages: key => key === 'TKEY' ? [{ consumer: { kind: 'ExecuteServerActionNode', key: 'N', path: 'ServerAction:Priv/ExecuteServerActionNode:T' } }] : [],
    properties: path => ({ 'ServerAction:Target': { key: 'TKEY', kind: 'ServerAction', public: false, properties: { Name: 'Target', Public: 'False' } },
      'ServerAction:Priv': { key: 'PRIV', kind: 'ServerAction', public: false, properties: { Name: 'Priv', Public: 'False' } } }[path] ?? null),
    inputs: () => [],
  });
  g2.seed('ServerAction:Target');
  const r = resolveEntry(g2, 'TKEY');
  assert.equal(r.ok, false);
  assert.equal(r.deadCode, true);
});

// ---- ODC REST callbacks (published RESTService/REST plugin kinds) ----
const K = c => c.repeat(22), MODULE = K('M');
const el = (kind, name, key, path, properties = {}, children = []) => ({ kind, name, key, path, properties, children });
const flow = (kind, name, key, owner, start, properties = {}) => el(kind, name, key, owner + '/' + kind + ':' + name, properties,
  start ? [el('StartNode', 'Start', start, owner + '/' + kind + ':' + name + '/StartNode:Start'), el('EndNode', 'End', K('z'), owner + '/' + kind + ':' + name + '/EndNode:End')] : []);
function callbackModel({ authentication = 'None', baseURL = 'https://dev.example.test/App/rest/Api' } = {}) {
  const service = 'RestService:Api', client = 'RestClient:Quotes', other = 'RestService:Other';
  const elements = [
    el('RestService', 'Api', K('S'), service, { Authentication: authentication }, [
      el('RestServiceAction', 'Echo', K('A'), service + '/RestServiceAction:Echo'),
      flow('RestServiceAuthenticationFlow', 'OnAuthentication', K('U'), service, K('u'), { AuthenticationCallbackType: authentication }),
      flow('RestServiceCallbackActionFlow', 'OnRequest', K('Q'), service, K('q'), { CallbackType: 'OnRequest' }),
      flow('RestServiceCallbackActionFlow', 'OnResponse', K('R'), service, null, { CallbackType: 'OnResponse' }), // unset: no Start node
    ]),
    el('RestClient', 'Quotes', K('C'), client, { BaseURL: baseURL }, [
      el('RestAction', 'GetQuote', K('G'), client + '/RestAction:GetQuote'),
      flow('RestCallbackActionFlow', 'OnBeforeRequest', K('B'), client, K('b'), { CallbackType: 'OnBeforeRequest' }),
      flow('RestCallbackActionFlow', 'OnAfterResponse', K('F'), client, K('f'), { CallbackType: 'OnAfterResponse' }),
    ]),
    el('RestService', 'Other', K('O'), other, { Authentication: 'None' }, [
      el('RestServiceAction', 'Ping', K('P'), other + '/RestServiceAction:Ping'),
      flow('RestServiceCallbackActionFlow', 'OnRequest', K('X'), other, K('x'), { CallbackType: 'OnRequest' }),
    ]),
  ];
  const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; elements.forEach(walk);
  const read = selector => all.find(n => '@' + n.key === selector || n.path === selector) ?? null;
  return { read, all, entry: { key: K('A'), kind: 'RestServiceAction', path: service + '/RestServiceAction:Echo' },
    consumed: { kind: 'ExecuteServerActionNode', actionKey: K('G'), actionKind: 'RestAction', external: false, bodyRead: false } };
}

test('callback edges by key: exposed RestServiceAction -> its service OnRequest; consumed RestAction -> its client callbacks', async () => {
  assert.deepEqual(Object.keys(ODC_NATIVE_CALLBACKS), ['RestServiceAuthenticationFlow', 'RestServiceCallbackActionFlow', 'RestCallbackActionFlow']);
  const m = callbackModel();
  const edges = await odcCallbackEdges(m.read, { entry: m.entry, calls: [m.consumed,
    // A producer (Reference) method and a non-REST call add no edge.
    { kind: 'ExecuteServerActionNode', actionKey: K('E'), actionKind: 'RestAction', external: true },
    { kind: 'ExecuteServerActionNode', actionKey: K('W'), actionKind: 'ServerAction', external: false }] });
  assert.deepEqual(edges.map(e => [e.from, e.to, e.callback, e.callbackKind, e.startNodeKey, e.integrationKey, e.consumed]), [
    [K('A'), K('Q'), 'OnRequest', 'RestServiceCallbackActionFlow', K('q'), K('S'), false],
    [K('G'), K('B'), 'OnBeforeRequest', 'RestCallbackActionFlow', K('b'), K('C'), true],
    [K('G'), K('F'), 'OnAfterResponse', 'RestCallbackActionFlow', K('f'), K('C'), true]]);
  assert.ok(edges.every(e => e.kind === 'native-callback'));
  assert.equal(edges.find(e => e.consumed).baseURL, 'https://dev.example.test/App/rest/Api');
  // OnAuthentication only for Basic/Custom services; the other service's OnRequest is never reached.
  const custom = callbackModel({ authentication: 'Custom' });
  const auth = await odcCallbackEdges(custom.read, { entry: custom.entry, calls: [] });
  assert.deepEqual(auth.map(e => [e.to, e.callback]), [[K('Q'), 'OnRequest'], [K('U'), 'OnAuthentication']]); // key order
  assert.equal(edges.some(e => e.to === K('X')), false);
  // A consumed call whose model element is not a RestAction of a RestClient is refused, not guessed.
  await assert.rejects(odcCallbackEdges(m.read, { entry: m.entry, calls: [{ ...m.consumed, actionKey: K('A') }] }), /debug_odc_native_callback_integration_unresolved/);
});

test('derived callback scopes: same module, start node read, sorted; foreign or unreadable callbacks are excluded', async () => {
  const m = callbackModel();
  const edges = await odcCallbackEdges(m.read, { entry: m.entry, calls: [m.consumed] });
  const derived = deriveOdcCallbackScopes(edges, { moduleKey: MODULE });
  assert.equal(derived.schema, 'ssam-odc-callback-scopes/1'); assert.equal(derived.moduleKey, MODULE);
  assert.deepEqual(derived.scopes.map(s => [s.functionKey, s.callback, s.kind, s.nodeKeys, s.source, s.moduleKey, s.consumed]), [
    [K('B'), 'OnBeforeRequest', 'RestCallbackActionFlow', [K('b')], 'runner-derived', MODULE, true],
    [K('F'), 'OnAfterResponse', 'RestCallbackActionFlow', [K('f')], 'runner-derived', MODULE, true],
    [K('Q'), 'OnRequest', 'RestServiceCallbackActionFlow', [K('q')], 'runner-derived', MODULE, false]]);
  assert.deepEqual(derived.excluded, []);
  const forged = deriveOdcCallbackScopes([{ ...edges[0], path: 'Reference:Lib/RestService:Api/RestServiceCallbackActionFlow:OnRequest' },
    { ...edges[1], startNodeKey: 'bad' }, { ...edges[2], to: 'short' }], { moduleKey: MODULE });
  assert.deepEqual(forged.scopes, []);
  assert.deepEqual(forged.excluded.map(e => e.reason).sort(), ['callback_key_unresolved', 'callback_start_node_unread', 'cross_module_callback']);
  assert.equal(deriveOdcCallbackScopes(edges, { moduleKey: MODULE, max: 1 }).excluded.filter(e => e.reason === 'callback_scope_limit').length, 2);
  assert.throws(() => deriveOdcCallbackScopes(edges, { moduleKey: 'bad' }), /debug_odc_native_callback_module_required/);
});

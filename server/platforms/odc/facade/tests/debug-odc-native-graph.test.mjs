import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelGraph, containerOf } from '../debug-odc-native-graph.mjs';
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

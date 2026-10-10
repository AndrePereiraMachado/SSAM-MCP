import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseO11Assets } from '../debug-o11-native-abi.mjs';
import { graphFromReadings, graphFromAssets, buildO11CallGraph, resolveO11Entry, ENTRY_PRIORITY, ownerViewOf } from '../debug-o11-entry-graph.mjs';
import { UI, CS, KEYS, csReadings, uiReadings, uiAssets } from './fixtures/debug-o11-graph-fixture.mjs';

const full = () => buildO11CallGraph([graphFromReadings(uiReadings(), UI), graphFromAssets(parseO11Assets(uiAssets(), UI.module), UI), graphFromReadings(csReadings(), CS)]);
// Deterministic pseudo-random permutation (no Math.random in tests that prove determinism).
function shuffled(list, seed) { const out = [...list]; let s = seed; for (let i = out.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; }
// Parameter order is part of the model (declared order); every other child order is shuffled.
const PARAMETER = /^(Input|Output)Parameter(Signature)?$/;
const deepShuffle = (reading, seed) => { const copy = structuredClone(reading); const walk = (n, d) => { if (n?.children) {
  const params = n.children.filter(c => PARAMETER.test(c.kind)), rest = shuffled(n.children.filter(c => !PARAMETER.test(c.kind)), seed + d);
  n.children = shuffled([...rest, ...params], seed * 7 + d).filter(c => !PARAMETER.test(c.kind)); n.children.splice(seed % (n.children.length + 1), 0, ...params);
  n.children.forEach(c => walk(c, d + 1)); } }; walk(copy.tree, 1); return copy; };

test('nearest entry: a private server action reached through a public service is debugged from the nearest data action', () => {
  const r = resolveO11Entry(full(), 'Rate_Lookup');
  assert.equal(r.state, 'resolved');
  assert.equal(r.entry.entry, 'data-action'); assert.equal(r.entry.name, 'LoadQuotes'); assert.equal(r.distance, 2);
  assert.equal(r.callPath, 'ShopUI.LoadQuotes -> ShopCS.Quote_Compute -> ShopCS.Rate_Lookup');
  assert.deepEqual(r.bindings.map(b => [b.input, b.class, b.controllable]), [['Zip', 'fixed', false], ['Factor', 'fixed', false], ['Owner', 'identity', false]]);
  assert.equal(r.algorithm.startsWith('bfs-callers/v1'), true); assert.deepEqual(r.priority, ENTRY_PRIORITY);
});

test('a server action called by a client action is entered through its screen stub, all inputs controlled', () => {
  const r = resolveO11Entry(full(), 'Place_Order');
  assert.equal(r.state, 'resolved'); assert.equal(r.entry.entry, 'server-stub'); assert.equal(r.distance, 1);
  assert.equal(r.entry.endpoint, 'screenservices/ShopUI/MainFlow/Shop/ActionPlace_Order');
  assert.deepEqual(r.bindings.map(b => [b.input, b.class, b.entryInput]), [['Zip', 'controlled', 'Zip'], ['Amount', 'controlled', 'Amount'], ['Note', 'controlled', 'Note']]);
});

test('same model and target always give the same entry, path, bindings and graph hash (25 permutations)', () => {
  const baseline = resolveO11Entry(full(), 'Rate_Lookup'), baselineQuote = resolveO11Entry(full(), 'Quote_Compute');
  for (let seed = 1; seed <= 25; seed++) {
    const graph = buildO11CallGraph(shuffled([
      graphFromReadings(shuffled(uiReadings(), seed).map(r => deepShuffle(r, seed)), UI),
      graphFromAssets(parseO11Assets(shuffled(uiAssets(), seed + 7), UI.module), UI),
      graphFromReadings(shuffled(csReadings(), seed + 3).map(r => deepShuffle(r, seed + 3)), CS)], seed + 11));
    assert.equal(graph.graphSha256, full().graphSha256);
    assert.deepEqual(resolveO11Entry(graph, 'Rate_Lookup'), baseline);
    assert.deepEqual(resolveO11Entry(graph, 'Quote_Compute'), baselineQuote);
  }
});

test('ties at the same distance follow ENTRY_PRIORITY, then the smallest sortKey', () => {
  // Two screens call the same server action from client actions; one data action also calls it. All at distance 1.
  const M = { module: 'Tie', moduleKey: 'TTTTTTTTTTTTTTTTTTTTTT' };
  const target = { kind: 'ServerAction', name: 'Target', key: 'TargetKeyxxxxxxxxxxxxx', path: 'ServerAction:Target', properties: { GlobalKey: M.moduleKey + '*TargetKeyxxxxxxxxxxxxx' },
    propertyReferences: {}, children: [{ kind: 'InputParameter', name: 'A', key: 'AAAAAAAAAAAAAAAAAAAAAA', properties: { DataType: 'BasicType:Text' }, propertyReferences: {}, children: [] }] };
  const ref = { kind: 'ServerAction', name: 'Target', key: 'TargetKeyxxxxxxxxxxxxx', path: 'ServerAction:Target' };
  const caller = (kind, name, key, owner) => ({ kind, name, key, path: owner + '/' + kind + ':' + name, properties: { GlobalKey: M.moduleKey + '*' + key },
    propertyReferences: {}, children: [{ kind: 'ExecuteServerActionNode', name: 'Call', key: key.slice(0, 20) + 'ex', propertyReferences: { Action: ref },
      children: [{ kind: 'Argument', properties: { Value: '"x"' }, propertyReferences: { Parameter: { name: 'A' } }, children: [] }] }] });
  const readings = [target, caller('ClientAction', 'OnB', 'ClientBxxxxxxxxxxxxxxx', 'MobileFlow:Main/MobileScreen:Beta'),
    caller('ClientAction', 'OnA', 'ClientAxxxxxxxxxxxxxxx', 'MobileFlow:Main/MobileScreen:Alpha'),
    caller('DataAction', 'Fetch', 'DataAxxxxxxxxxxxxxxxxx', 'MobileFlow:Main/MobileScreen:Alpha')].map(tree => ({ tree }));
  const graph = buildO11CallGraph([graphFromReadings(readings, M)]);
  const r = resolveO11Entry(graph, 'Target');
  assert.equal(r.entry.entry, 'server-stub'); assert.equal(r.entry.sortKey, 'screenservices/Tie/Main/Alpha/ActionTarget');
  assert.deepEqual(r.candidatesAtDistance.map(c => c.entry + ':' + c.sortKey), ['server-stub:screenservices/Tie/Main/Alpha/ActionTarget',
    'server-stub:screenservices/Tie/Main/Beta/ActionTarget', 'data-action:DataAxxxxxxxxxxxxxxxxx']);
  assert.equal(r.bindings[0].class, 'controlled');
});

test('override is accepted only for an invocable caller on the graph; bindings follow the overridden path', () => {
  const graph = full();
  const viaStub = resolveO11Entry(graph, 'Quote_Compute', { entry: 'screenservices/ShopUI/MainFlow/Shop/ActionPlace_Order' });
  assert.equal(viaStub.state, 'resolved'); assert.equal(viaStub.override, true); assert.equal(viaStub.distance, 2);
  assert.deepEqual(viaStub.bindings.map(b => [b.input, b.class, b.entryInput]), [['Zip', 'controlled', 'Zip'], ['Amount', 'controlled', 'Amount']]);
  const viaClient = resolveO11Entry(graph, 'Quote_Compute', { entry: '@' + KEYS.buyClick });
  assert.equal(viaClient.state, 'resolved'); assert.equal(viaClient.distance, 3);
  assert.deepEqual(viaClient.bindings.map(b => [b.input, b.class, b.controllable, b.screenVariable ?? b.entryInput]),
    [['Zip', 'screen-variable', true, 'zipVar'], ['Amount', 'controlled', true, 'Amount']]);
  assert.equal(resolveO11Entry(graph, 'Quote_Compute', { entry: '@' + KEYS.uiPrivate }).state, 'override-refused'); // not invocable
  assert.equal(resolveO11Entry(graph, 'Quote_Compute', { entry: '@' + KEYS.slug }).state, 'override-refused');     // invocable, not a caller
  assert.equal(resolveO11Entry(graph, 'Quote_Compute', { entry: 'screenservices/ShopUI/Nope' }).state, 'override-refused');
});

test('dead code, timer-only, public without consumer and missing/ambiguous targets answer deterministically without an entry', () => {
  const graph = full();
  const dead = resolveO11Entry(graph, 'Orphan_Private');
  assert.equal(dead.state, 'dead-code'); assert.equal(dead.message, 'dead code: no public entry reaches Orphan_Private'); assert.equal(dead.entry, undefined);
  assert.equal(resolveO11Entry(graph, 'Ui_Unused').state, 'dead-code');
  const timer = resolveO11Entry(graph, 'Nightly_Recalc');
  assert.equal(timer.state, 'no-invocable-entry'); assert.equal(timer.reachedOnlyBy[0].liveness, 'timer');
  const csOnly = buildO11CallGraph([graphFromReadings(csReadings(), CS)]);
  const exposed = resolveO11Entry(csOnly, 'Rate_Lookup');
  assert.equal(exposed.state, 'public-without-consumer'); assert.match(exposed.message, /ShopCS\.Quote_Compute/);
  assert.equal(resolveO11Entry(graph, 'Nope').state, 'target-not-found');
  const orphan = csReadings()[2].tree;
  const twice = buildO11CallGraph([graphFromReadings([...csReadings(), { tree: { ...orphan, key: 'OrphanTwoxxxxxxxxxxxxx', path: 'X',
    properties: { ...orphan.properties, GlobalKey: CS.moduleKey + '*OrphanTwoxxxxxxxxxxxxx' } } }], CS)]);
  assert.equal(resolveO11Entry(twice, 'Orphan_Private').state, 'target-ambiguous');
  assert.equal(resolveO11Entry(twice, '@OrphanTwoxxxxxxxxxxxxx').state, 'dead-code');
  assert.equal(resolveO11Entry(graph, 'ShopCS.Rate_Lookup').entry.name, 'LoadQuotes');
});

test('a client action is its own entry at distance zero; the module-level client action keeps its typed inputs', () => {
  const r = resolveO11Entry(full(), 'Slugify');
  assert.equal(r.state, 'resolved'); assert.equal(r.distance, 0); assert.equal(r.entry.entry, 'client-action');
  assert.deepEqual(r.bindings, [{ input: 'Text', class: 'direct', controllable: true, entryInput: 'Text' }]);
});

test('owner view names are derived from the model path', () => {
  assert.equal(ownerViewOf('MobileFlow:Common/MobileBlock:UserInfo/DataAction:X'), 'Common.UserInfo');
  assert.equal(ownerViewOf('ServerAction:X'), '@module');
});

// Golden: real published readings and public assets cached by earlier proofs (read only, skipped without the root).
const evidence = process.env.SSAM_DEBUG_EVIDENCE_ROOT;
test('golden Headless_UI/Headless_CS published graph resolves the diagnostic service through its data action', { skip: !evidence }, () => {
  const P = path.join(evidence, 'proofs');
  const read = f => JSON.parse(fs.readFileSync(path.join(P, f), 'utf8').replace(/^﻿/, ''));
  const dir = path.join(P, 'o11-service-authenticated-chain', 'acquired', 'e662ebb3-16f8-43ca-b548-ee0fcba16a03');
  const assets = fs.readdirSync(dir).filter(n => n.endsWith('.js')).map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
  const prep = 'o11-service-authenticated-chain/witness-published-preparation/2813a16f-584a-4189-a820-6691811a327e/';
  const graph = buildO11CallGraph([
    graphFromReadings([read(prep + 'ui-data-action.json'), read(prep + 'ui-imported-service-signature.json'), read(prep + 'ui-login.json')], { module: 'Headless_UI', moduleKey: 'Mif02PxcH0K7KiABEHTwMg' }),
    graphFromAssets(parseO11Assets(assets, 'Headless_UI'), { moduleKey: 'Mif02PxcH0K7KiABEHTwMg' }),
    graphFromReadings([read('o11-service-user-context/published-proof/85d2b466-6dac-4c92-ad94-dbced825ecd7/cs-service-action.json')], { module: 'Headless_CS', moduleKey: 'Kawk_WFx5USxo7qFAB0lCQ' })]);
  const service = resolveO11Entry(graph, 'SSAM_DebugServiceUserContext');
  assert.equal(service.state, 'resolved'); assert.equal(service.entry.name, 'SSAM_DebugServiceContextFromServer'); assert.equal(service.distance, 1);
  assert.equal(service.bindings[0].class, 'derived'); // ExpectedUserId comes from a local filled by GetUserId(): never controllable
  const login = resolveO11Entry(graph, 'DoLogin');
  assert.equal(login.entry.endpoint, 'screenservices/Headless_UI/Common/Login/ActionDoLogin');
});

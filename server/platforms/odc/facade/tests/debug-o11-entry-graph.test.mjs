import './fixtures/isolated-profile.mjs';
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
  // Without native provenance the text GetUserId() is only observed: never 'identity' by regex.
  assert.deepEqual(r.bindings.map(b => [b.input, b.class, b.controllable]), [['Zip', 'fixed', false], ['Factor', 'fixed', false], ['Owner', 'derived', false]]);
  assert.equal(r.algorithm.startsWith('bfs-callers/v1'), true); assert.deepEqual(r.priority, ENTRY_PRIORITY);
});

test('identity class comes from the native GetUserId binding of the argument, never from its text', () => {
  const quote = csReadings().find(r => r.tree.key === KEYS.quoteCompute).tree, sha = 'a'.repeat(64);
  const owner = quote.children.find(c => c.kind === 'ExecuteServerActionNode').children.find(a => a.properties.Value === 'GetUserId()');
  const binding = root => ({ available: true, authority: 'installed-model-expression-tree', runtimeValuesEvaluated: false,
    identity: { moduleKey: CS.moduleKey, functionKey: KEYS.quoteCompute, sourceSha256: sha }, expressions: [{ key: owner.key + '.#Value', root }] });
  const builtin = (original = true) => ({ kind: 'FunctionCall', functionCall: true, builtin: 'GetUserId', originalBuiltin: original, usedObjects: [], children: [] });
  const graphWith = (bindings, sourceSha256 = sha) => buildO11CallGraph([graphFromReadings(uiReadings(), UI), graphFromAssets(parseO11Assets(uiAssets(), UI.module), UI),
    graphFromReadings(csReadings(), { ...CS, sourceSha256, nativeBindings: bindings })]);
  const ownerOf = g => resolveO11Entry(g, 'Rate_Lookup').bindings.find(b => b.input === 'Owner');
  const native = ownerOf(graphWith([binding(builtin())]));
  assert.deepEqual([native.class, native.controllable, native.provenance], ['identity', false, 'native-builtin:GetUserId']);
  // substituted builtin, foreign function, unpinned or other source, evaluated binding: observed only
  for (const g of [graphWith([binding(builtin(false))]), graphWith([binding({ ...builtin(), functionObject: { key: 'U'.repeat(22), kind: 'Action' } })]),
    graphWith([binding(builtin())], null), graphWith([binding(builtin())], 'b'.repeat(64)), graphWith([{ ...binding(builtin()), runtimeValuesEvaluated: true }])])
    assert.equal(ownerOf(g).class, 'derived');
  // a native binding on a non-identity text still decides; provenance never enters the canonical graph hash
  assert.equal(graphWith([binding(builtin())]).graphSha256, full().graphSha256);
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

import { o11IdentifierBase } from '../debug-o11-entry-graph.mjs';
test('identifier bases come from the EntityReference type, including producer entity signatures', () => {
  assert.equal(o11IdentifierBase('EntityReferenceLongInteger'), 'LongInteger');
  assert.equal(o11IdentifierBase('EntityReferenceInteger'), 'Integer');
  assert.equal(o11IdentifierBase('EntityReferenceText'), 'Text');
  for (const type of [undefined, null, '', 'EntityReferenceGuid', 'XEntityReferenceText', 'EntityReferenceTextual']) assert.equal(o11IdentifierBase(type), null, String(type));
  const param = (kind, name, key, type) => ({ kind, name, key, path: null, properties: { Name: name, DataType: 'IdentifierType:' + name + ' Identifier',
    IsMandatory: 'True', ...(type ? { Type: type } : {}) }, propertyReferences: {}, children: [] });
  const k = s => s.padEnd(22, 'k');
  const sig = { kind: 'ServerActionSignature', name: 'Product_Get', key: k('Sig'), path: 'Reference:Catalog_CS/ServerActionSignature:Product_Get',
    properties: { GlobalKey: CS.moduleKey + '*' + k('ProductGet'), Name: 'Product_Get' }, propertyReferences: {},
    children: [param('InputParameterSignature', 'Product', k('PProduct'), 'EntityReferenceText'), param('InputParameterSignature', 'Owner', k('POwner'), 'EntityReferenceInteger'),
      param('InputParameterSignature', 'Order', k('POrder'), 'EntityReferenceLongInteger'), param('InputParameterSignature', 'Legacy', k('PLegacy'), null)] };
  const graph = graphFromReadings([{ schema: 'ssam-reading/1', tree: sig }], UI);
  const node = [...graph.nodes.values()].find(n => n.name === 'Product_Get');
  assert.equal(node.producer, 'Catalog_CS');
  assert.deepEqual(node.inputs.map(i => [i.name, i.identifierBase]), [['Product', 'Text'], ['Owner', 'Integer'], ['Order', 'LongInteger'], ['Legacy', null]]);
});

// ---- Traditional screen actions and native REST/SOAP callbacks ----
import { o11EntryKindOf } from '../debug-o11-entry-graph.mjs';
const IG = { module: 'Integr', moduleKey: 'IntegrModxxxxxxxxxxxxx' };
const ik = id => id.padEnd(22, 'x');
const nd = (kind, name, id, path, properties = {}, children = []) => ({ kind, name, key: id.length === 22 || id.includes('.#') ? id : ik(id), path,
  properties: { GlobalKey: IG.moduleKey + '*' + (id.length === 22 || id.includes('.#') ? id : ik(id)), ...properties }, propertyReferences: {}, children });
const start = id => ({ kind: 'StartNode', name: '', key: ik(id), properties: {}, propertyReferences: {}, children: [] });
const exec = (id, ref, args = []) => ({ kind: 'ExecuteServerActionNode', name: 'Call' + id, key: ik(id), properties: {}, propertyReferences: { Action: ref }, children: args });
const serverRef = name => ({ kind: 'ServerAction', name, key: ik(name), path: 'ServerAction:' + name });
const serverAction = (name, children = []) => nd('ServerAction', name, name, 'ServerAction:' + name, {}, [start(name + 'S'), ...children]);

test('a Traditional screen action is its own entry kind and reaches server actions directly, without a screen stub', () => {
  const target = serverAction('Order_Save', [{ kind: 'InputParameter', name: 'Id', key: ik('OrderId'), properties: { DataType: 'Integer' }, propertyReferences: {}, children: [] }]);
  const action = nd('ScreenAction', 'Save', 'SaveAct', 'WebFlow:MainFlow/WebScreen:Orders/ScreenAction:Save', { IsCalledByAjax: 'False' },
    [start('SaveS'), exec('SaveE', serverRef('Order_Save'), [{ kind: 'Argument', properties: { Value: '7' }, propertyReferences: { Parameter: { name: 'Id' } }, children: [] }])]);
  const graph = buildO11CallGraph([graphFromReadings([target, action].map(tree => ({ tree })), IG)]);
  const r = resolveO11Entry(graph, 'Order_Save');
  assert.equal(r.state, 'resolved'); assert.equal(r.entry.entry, 'traditional-screen-action'); assert.equal(r.distance, 1);
  assert.equal(r.entry.runnable, false, 'runnable only through the Traditional postback runner');
  assert.equal(r.hops[0].via.kind, 'execute'); assert.equal(r.bindings[0].class, 'fixed');
  assert.ok(![...graph.nodes.values()].some(n => n.kind === 'ServerActionStub'), 'Traditional screens have no screenservices stub');
  assert.ok(ENTRY_PRIORITY.indexOf('traditional-screen-action') > ENTRY_PRIORITY.indexOf('traditional-preparation'));
  const prep = nd('Preparation', '', ik('Orders') + '.#Preparation', 'WebFlow:MainFlow/WebScreen:Orders/Preparation:', {}, [start('PrepS'), exec('PrepE', serverRef('Order_Save'))]);
  const tie = resolveO11Entry(buildO11CallGraph([graphFromReadings([target, action, prep].map(tree => ({ tree })), IG)]), 'Order_Save');
  assert.equal(tie.entry.entry, 'traditional-preparation');
  assert.deepEqual(tie.candidatesAtDistance.map(c => c.entry), ['traditional-preparation', 'traditional-screen-action']);
  // A Reactive (MobileFlow) screen action keeps the client-action kind and its stub.
  const mobile = nd('ScreenAction', 'Save', 'MobSave', 'MobileFlow:MainFlow/MobileScreen:Orders/ScreenAction:Save', {}, [start('MobS'), exec('MobE', serverRef('Order_Save'))]);
  assert.equal(resolveO11Entry(buildO11CallGraph([graphFromReadings([target, mobile].map(tree => ({ tree })), IG)]), 'Order_Save').entry.entry, 'server-stub');
});

test('a server action reached only from a WebBlock Preparation resolves through the hosting screen Preparation (nested, same module only)', () => {
  const ref = (kind, name, id, path) => ({ kind, name, key: ik(id), path });
  const home = ref('WebScreen', 'Home', 'Home', 'WebFlow:MainFlow/WebScreen:Home'), outer = ref('WebBlock', 'Outer', 'Outer', 'WebFlow:Common/WebBlock:Outer');
  const inner = ref('WebBlock', 'Inner', 'Inner', 'WebFlow:Common/WebBlock:Inner'), card = ref('WebBlockSignature', 'Card', 'Card', 'Reference:OutSystemsUIWeb/WebBlockSignature:Card');
  const prep = (owner, children = []) => nd('Preparation', '', ik(owner.key) + '.#Preparation', owner.path + '/Preparation:', {}, [start(owner.name + 'PS'), ...children]);
  const instance = (id, owner, block) => ({ ...nd('WebBlockInstanceWidget', '', id, owner.path + '/WebBlockInstanceWidget:'), propertyReferences: { Owner: owner, SourceBlock: block } });
  const readings = [serverAction('Load_Items'), prep(home), prep(outer), prep(inner, [exec('InnerE', serverRef('Load_Items'))]), prep(card),
    instance('HomeOuter', home, outer), instance('OuterInner', outer, inner), instance('HomeCard', home, card)];
  const graph = buildO11CallGraph([graphFromReadings(readings.map(tree => ({ tree })), IG)]);
  const r = resolveO11Entry(graph, 'Load_Items');
  assert.equal(r.state, 'resolved'); assert.equal(r.entry.entry, 'traditional-preparation'); assert.equal(r.entry.key, home.key + '.#Preparation');
  assert.deepEqual(r.hops.map(h => h.via.kind), ['block-render', 'block-render', 'execute']); assert.equal(r.distance, 3);
  assert.deepEqual(r.hops[0].via, { kind: 'block-render', instanceKey: ik('HomeOuter'), blockKey: outer.key });
  for (const block of [outer, inner]) assert.equal(graph.nodes.get(IG.moduleKey + '*' + block.key + '.#Preparation').entry, null, 'a block Preparation is never an entry');
  const target = resolveO11Entry(graph, IG.moduleKey + '*' + inner.key + '.#Preparation');
  assert.equal(target.entry.key, home.key + '.#Preparation'); assert.equal(target.distance, 2);
  assert.ok(!graph.edges.some(e => e.to.includes(card.key)), 'producer blocks run in their own module: no edge');
  assert.ok(!graph.edges.some(e => e.from.includes(ik('Card'))));
});

function restService(auth, flows) {
  return nd('RestService', 'Api' + auth, 'Svc' + auth, 'RestService:Api' + auth, { Authentication: auth }, [
    nd('RestServiceAction', 'Echo' + auth, 'Echo' + auth, 'RestService:Api' + auth + '/RestServiceAction:Echo' + auth, { HTTPMethod: 'POST' }, [start('ES' + auth)]), ...flows]);
}
const authFlow = (auth, children = [start('AS' + auth), exec('AE' + auth, serverRef('CheckToken'))]) =>
  nd('RestServiceAuthenticationFlow', 'OnAuthentication', 'Auth' + auth, 'RestService:Api' + auth + '/RestServiceAuthenticationFlow:OnAuthentication', { AuthenticationCallbackType: auth }, children);
const serviceCallback = (auth, name, children) => nd('RestServiceCallbackActionFlow', name, name + auth, 'RestService:Api' + auth + '/RestServiceCallbackActionFlow:' + name, { CallbackType: name }, children);

test('exposed REST: native-callback edges to OnAuthentication (Basic/Custom) and set OnRequest/OnResponse only', () => {
  const graph = buildO11CallGraph([graphFromReadings([serverAction('CheckToken'),
    restService('Basic', [authFlow('Basic'), serviceCallback('Basic', 'OnRequest', [start('RqS')]), serviceCallback('Basic', 'OnResponse', [])]),
    restService('None', [authFlow('None'), serviceCallback('None', 'OnResponse', [start('RsS')])]),
    restService('Custom', [authFlow('Custom')])].map(tree => ({ tree })), IG)]);
  const callbacks = graph.edges.filter(e => e.via.kind === 'native-callback').map(e => graph.nodes.get(e.from).name + '>' + graph.nodes.get(e.to).name + ':' + e.via.callback);
  assert.deepEqual(callbacks.sort(), ['EchoBasic>OnAuthentication:OnAuthentication', 'EchoBasic>OnRequest:OnRequest', 'EchoCustom>OnAuthentication:OnAuthentication', 'EchoNone>OnResponse:OnResponse']);
  for (const n of graph.nodes.values()) if (/Flow$/.test(n.kind)) assert.equal(n.entry, null, n.kind + ' is never an entry');
  const r = resolveO11Entry(graph, 'CheckToken');
  assert.equal(r.state, 'resolved'); assert.equal(r.entry.entry, 'rest-method'); assert.equal(r.distance, 2);
  assert.match(r.entry.name, /^Echo(Basic|Custom)$/); assert.equal(r.hops[0].via.kind, 'native-callback'); assert.equal(r.hops[0].via.callback, 'OnAuthentication');
  // A flow read on its own (no RestService container) still binds by path; its own callback type then decides.
  const loose = buildO11CallGraph([graphFromReadings([restService('Basic', []), authFlow('Basic')].map(tree => ({ tree })), IG)]);
  assert.equal(loose.edges.filter(e => e.via.kind === 'native-callback').length, 1);
});

function consumedFixture() {
  const restClient = nd('RestClient', 'Weather', 'Client', 'RestClient:Weather', {}, [
    nd('RestAction', 'GetForecast', 'Forecast', 'RestClient:Weather/RestAction:GetForecast', { HTTPMethod: 'GET' }),
    nd('RestCallbackActionFlow', 'OnBeforeRequest', 'Before', 'RestClient:Weather/RestCallbackActionFlow:OnBeforeRequest', { CallbackType: 'OnBeforeRequest' },
      [start('BS'), exec('BE', serverRef('HeaderSign'))]),
    nd('RestCallbackActionFlow', 'OnAfterResponse', 'After', 'RestClient:Weather/RestCallbackActionFlow:OnAfterResponse', {}, [start('AfS')])]);
  const soapClient = nd('SOAPClient', 'Billing', 'SoapCl', 'SOAPClient:Billing', {}, [nd('SOAPAction', 'Charge', 'Charge', 'SOAPClient:Billing/SOAPAction:Charge'),
    nd('SOAPCallbackActionFlow', 'OnBeforeRequestAdvanced', 'SoapAdv', 'SOAPClient:Billing/SOAPCallbackActionFlow:OnBeforeRequestAdvanced', {}, [start('SAS')]),
    nd('SOAPCallbackActionFlow', 'OnAfterResponse', 'SoapAft', 'SOAPClient:Billing/SOAPCallbackActionFlow:OnAfterResponse', {}, [])]);
  const plain = nd('RestClient', 'Plain', 'Plain', 'RestClient:Plain', {}, [nd('RestAction', 'Ping', 'Ping', 'RestClient:Plain/RestAction:Ping')]);
  const fetch = serverAction('Fetch', [
    exec('FE1', { kind: 'RestAction', name: 'GetForecast', key: ik('Forecast'), path: 'RestClient:Weather/RestAction:GetForecast', owner: { kind: 'RestClient', key: ik('Client'), path: 'RestClient:Weather' } }),
    exec('FE2', { kind: 'SOAPAction', name: 'Charge', key: ik('Charge'), path: 'SOAPClient:Billing/SOAPAction:Charge' }),
    exec('FE3', { kind: 'RestAction', name: 'Ping', key: ik('Ping'), path: 'RestClient:Plain/RestAction:Ping' })]);
  const page = nd('Preparation', '', ik('Page') + '.#Preparation', 'WebFlow:Main/WebScreen:Page/Preparation:', {}, [start('PgS'), exec('PgE', serverRef('Fetch'))]);
  return [serverAction('HeaderSign'), restClient, soapClient, plain, fetch, page];
}
test('consumed REST/SOAP methods are never entries; their Execute nodes get native-callback edges to set callbacks only', () => {
  for (const kind of ['RestAction', 'SOAPAction']) assert.equal(o11EntryKindOf(kind), null);
  assert.equal(o11EntryKindOf('RestServiceAction'), 'rest-method'); assert.equal(o11EntryKindOf('WebServiceMethod'), 'soap-method');
  const graph = buildO11CallGraph([graphFromReadings(consumedFixture().map(tree => ({ tree })), IG)]);
  for (const name of ['GetForecast', 'Charge', 'Ping', 'OnBeforeRequest', 'OnAfterResponse', 'OnBeforeRequestAdvanced'])
    for (const n of [...graph.nodes.values()].filter(n => n.name === name)) assert.equal(n.entry, null, name);
  const callbacks = graph.edges.filter(e => e.via.kind === 'native-callback').map(e => graph.nodes.get(e.from).name + '>' + graph.nodes.get(e.to).name);
  assert.deepEqual(callbacks.sort(), ['Charge>OnBeforeRequestAdvanced', 'GetForecast>OnAfterResponse', 'GetForecast>OnBeforeRequest']);
  const r = resolveO11Entry(graph, 'HeaderSign');
  assert.equal(r.state, 'resolved'); assert.equal(r.entry.entry, 'traditional-preparation');
  assert.equal(r.callPath, 'Integr. -> Integr.Fetch -> Integr.GetForecast -> Integr.OnBeforeRequest -> Integr.HeaderSign');
  assert.equal(r.hops[2].via.kind, 'native-callback');
  const callback = resolveO11Entry(graph, '@' + ik('Before'));
  assert.equal(callback.state, 'resolved'); assert.equal(callback.distance, 3);
});

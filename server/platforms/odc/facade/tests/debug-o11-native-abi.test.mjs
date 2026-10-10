import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseO11Assets, hostViewName, amdClosure, canonicalValue, canonicalScenario, o11TypeOf, splitArguments, resolveAmd, defines } from '../debug-o11-native-abi.mjs';
import { UI, KEYS, uiAssets } from './fixtures/debug-o11-graph-fixture.mjs';

test('compiled controllers yield stubs, data actions and client actions with typed parameters and outputs', () => {
  const parsed = parseO11Assets(uiAssets(), UI.module);
  const stub = parsed.stubs.find(s => s.serverAction === 'Place_Order');
  assert.equal(stub.owner, 'MainFlow.Shop'); assert.equal(stub.method, 'place_Order$ServerAction');
  assert.equal(stub.endpoint, 'screenservices/ShopUI/MainFlow/Shop/ActionPlace_Order'); assert.equal(stub.apiVersion, 'PLACEORDERAPIVERSION000');
  assert.deepEqual(stub.inputs, [{ param: 'zipIn', name: 'Zip', dataType: 'Text' }, { param: 'amountIn', name: 'Amount', dataType: 'Decimal' },
    { param: 'noteIn', name: 'Note', dataType: 'Text' }]);
  assert.deepEqual(stub.outputs, [{ name: 'OrderId', attribute: 'orderIdOut', mandatory: false, dataType: 'LongInteger' }]);
  const data = parsed.dataActions[0];
  assert.deepEqual([data.key, data.name, data.dataProperty, data.endpoint], [KEYS.loadQuotes, 'LoadQuotes', 'loadQuotesDataAct', 'screenservices/ShopUI/MainFlow/Shop/DataActionLoadQuotes']);
  const buy = parsed.clientActions.find(c => c.name === 'BuyClick');
  assert.equal(buy.method, 'buyClick$Action'); assert.equal(buy.implementation, '_buyClick$Action'); assert.equal(buy.moduleLevel, false);
  assert.deepEqual(buy.inputs, [{ param: 'amountIn', name: 'Amount', dataType: 'Decimal', mandatory: true }]);
  assert.deepEqual(buy.calls, [{ target: 'place_Order', kind: 'ServerAction', via: 'self', viaVariable: null,
    args: ['model.variables.zipVar', 'vars.value.amountInLocal', '"fixed note"'] }]);
  assert.deepEqual(buy.nodes, ['BUYSTARTNODEKEY0000000', 'BUYCALLNODEKEY00000000']);
  const slug = parsed.clientActions.find(c => c.name === 'Slugify');
  assert.equal(slug.moduleLevel, true); assert.equal(slug.owner, '@module');
  assert.deepEqual(slug.inputs, [{ param: 'textIn', name: 'Text', dataType: 'Text', mandatory: true }]);
  assert.deepEqual(slug.outputs, [{ name: 'Slug', attribute: 'slugOut', mandatory: false, dataType: 'Text' }]);
  assert.equal(parsed.components['MainFlow.Shop'].screen, true); assert.equal(parsed.components['MainFlow.Shop'].viewName, 'MainFlow.Shop');
  assert.deepEqual(parsed.components['MainFlow.Shop'].variables, [{ name: 'Zip', attribute: 'zipVar', dataType: 'Text' }]);
  assert.equal(hostViewName(parsed, 'MainFlow.Shop'), 'MainFlow.Shop');
});

test('AMD closure resolves relative ids, single quotes and factory-less defines, and fails closed on unknown names', () => {
  assert.equal(resolveAmd('OutSystems/ClientRuntime/Main', './Logger'), 'OutSystems/ClientRuntime/Logger');
  assert.equal(resolveAmd('a/b/c', '../d'), 'a/d');
  assert.deepEqual(defines("x;define('A/B',[\"./C\"],function(){});define(\"long\",[],t);").map(d => [d.name, d.deps]), [['A/B', ['A/C']], ['long', []]]);
  const parsed = parseO11Assets(uiAssets(), UI.module);
  const closure = amdClosure(parsed, ['ShopUI.MainFlow.Shop.mvc$controller', 'OutSystems/ClientRuntime/Debugger']);
  assert.deepEqual(closure.missing, []);
  assert.deepEqual(closure.assets, ['Debugger.js', 'OutSystems.js', 'ShopUI.MainFlow.Shop.mvc.js', 'ShopUI.controller.js', 'ShopUI.model.js']);
  assert.deepEqual(amdClosure(parsed, ['Nope.mvc$model']).missing, ['Nope.mvc$model']);
  assert.deepEqual(splitArguments('a(b, c), "x,y", {d: [1, 2]}'), ['a(b, c)', '"x,y"', '{d: [1, 2]}']);
});

test('typed inputs: every supported type canonicalizes to the runtime wire format; invalid values refuse', () => {
  const t = base => ({ base });
  assert.equal(canonicalValue(t('Text'), 'Olá "x"'), 'Olá "x"');
  assert.equal(canonicalValue(t('Integer'), -2147483648), -2147483648);
  assert.throws(() => canonicalValue(t('Integer'), 2147483648), /type_mismatch/); assert.throws(() => canonicalValue(t('Integer'), 1.5), /type_mismatch/);
  assert.equal(canonicalValue(t('LongInteger'), '9223372036854775807'), '9223372036854775807');
  assert.equal(canonicalValue(t('LongInteger'), 42), '42'); assert.throws(() => canonicalValue(t('LongInteger'), '9223372036854775808'), /type_mismatch/);
  assert.equal(canonicalValue(t('Decimal'), '0012.3400'), '12.34'); assert.equal(canonicalValue(t('Decimal'), -0.5), '-0.5');
  assert.equal(canonicalValue(t('Decimal'), '-0.000'), '0'); assert.throws(() => canonicalValue(t('Decimal'), '1e5'), /type_mismatch/);
  assert.equal(canonicalValue(t('Boolean'), false), false); assert.throws(() => canonicalValue(t('Boolean'), 'true'), /type_mismatch/);
  assert.equal(canonicalValue(t('Date'), '2024-02-29'), '2024-02-29'); assert.throws(() => canonicalValue(t('Date'), '2026-02-30'), /type_mismatch/);
  assert.equal(canonicalValue(t('Time'), '23:59:59'), '23:59:59'); assert.throws(() => canonicalValue(t('Time'), '24:00:00'), /type_mismatch/);
  assert.equal(canonicalValue(t('DateTime'), '2026-10-04T12:30:00-03:00'), '2026-10-04T15:30:00Z');
  assert.throws(() => canonicalValue(t('DateTime'), '2026-10-04T12:30:00'), /type_mismatch/); // no explicit zone
  assert.deepEqual(canonicalValue(t('Record'), { Name: 'a', Items: [{ Qty: 1 }] }), { Name: 'a', Items: [{ Qty: 1 }] });
  assert.throws(() => canonicalValue(t('Record'), { Password: 'x' }), /private_or_invalid/);
  assert.deepEqual(canonicalValue({ base: 'RecordList' }, []), []);
  assert.equal(canonicalValue(t('Text'), null), null);
  assert.throws(() => canonicalValue(t('Text'), 'Bearer abc'), /type_mismatch/);
  assert.throws(() => canonicalValue(t('BinaryData'), 'x'), /unsupported/);
  assert.deepEqual(o11TypeOf({ modelType: 'IdentifierType:Order Identifier', identifierBase: 'LongInteger' }), { base: 'LongInteger', identifier: 'Order Identifier' });
  assert.deepEqual(o11TypeOf({ modelType: 'BasicType:Date Time' }), { base: 'DateTime' });
  assert.deepEqual(o11TypeOf({ modelType: 'Structure:Point' }), { base: 'Record', of: 'Point' });
  assert.deepEqual(o11TypeOf({ dataType: 'Currency' }), { base: 'Currency' });
});

test('scenario inputs: unknown, private and uncontrollable names refuse; omitted and null are recorded, empty inputs allowed', () => {
  const parameters = [{ name: 'Zip', modelType: 'BasicType:Text', controllable: true }, { name: 'Owner', modelType: 'BasicType:Integer', controllable: false },
    { name: 'Amount', modelType: 'BasicType:Decimal', controllable: true }];
  assert.deepEqual(canonicalScenario(parameters, {}), { values: {}, presence: { Zip: 'omitted', Owner: 'omitted', Amount: 'omitted' } });
  assert.deepEqual(canonicalScenario(parameters, { Zip: '33101', Amount: null }), { values: { Zip: '33101' }, presence: { Zip: 'value', Owner: 'omitted', Amount: 'null' } });
  assert.throws(() => canonicalScenario(parameters, { Owner: 5 }), /not_controllable:Owner/);
  assert.throws(() => canonicalScenario(parameters, { Nope: 1 }), /input_unknown:Nope/);
  assert.throws(() => canonicalScenario([{ name: 'Password', controllable: true }], { Password: 'x' }), /private_or_invalid:Password/);
});

const evidence = process.env.SSAM_DEBUG_EVIDENCE_ROOT;
test('golden public Headless_UI assets: stubs, data actions, client actions, host screen and a complete closure', { skip: !evidence }, () => {
  const dir = path.join(evidence, 'proofs', 'o11-service-authenticated-chain', 'acquired', 'e662ebb3-16f8-43ca-b548-ee0fcba16a03');
  const parsed = parseO11Assets(fs.readdirSync(dir).filter(n => n.endsWith('.js')).map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') })), 'Headless_UI');
  const wishlist = parsed.stubs.find(s => s.serverAction === 'Wishlist_Add');
  assert.deepEqual(wishlist.inputs.map(i => i.dataType), ['LongInteger', 'Boolean']); assert.equal(wishlist.referenced, true);
  assert.deepEqual(parsed.dataActions.map(d => d.name).sort(), ['GetUserNameFromServer', 'LoadFeatured', 'SSAM_DebugServiceContextFromServer']);
  assert.equal(hostViewName(parsed, 'Common.UserInfo'), 'MainFlow.Home');
  assert.equal(parsed.components['Common.UserInfo'].screen, false); assert.equal(parsed.components['Common.Login'].screen, true);
  assert.deepEqual(amdClosure(parsed, ['Headless_UI.Common.Login.mvc$controller', 'Headless_UI.Common.Login.mvc$model', 'Headless_UI.Common.UserInfo.mvc$controller',
    'Headless_UI.Common.UserInfo.mvc$model', 'Headless_UI.appDefinition', 'OutSystems/ClientRuntime/Debugger']).missing, []);
  // This cached acquisition is partial for MainFlow.Home: the closure names what is missing instead of guessing.
  assert.ok(amdClosure(parsed, ['Headless_UI.MainFlow.Home.mvc$controller']).missing.includes('Headless_CS.model$GameRec'));
  const slug = parsed.clientActions.find(c => c.name === 'Slugify');
  assert.equal(slug.moduleLevel, true); assert.deepEqual(slug.outputs.map(o => o.attribute), ['slugOut']);
});

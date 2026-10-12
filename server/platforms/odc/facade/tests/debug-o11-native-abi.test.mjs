import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseO11Assets, hostViewName, amdClosure, canonicalValue, canonicalScenario, o11TypeOf, splitArguments, resolveAmd, defines, O11_NATIVE_INPUT_BYTES } from '../debug-o11-native-abi.mjs';
import { nativeWireOutput, NATIVE_OUTPUT_BYTES } from '../debug-native-wire-output.mjs';

test('native input/output transport preserves long Unicode and full compound values without historical element cuts', () => {
  const text = 'áΩx'.repeat(3000) + 'TAIL';
  assert.equal(canonicalValue({ base: 'Text' }, text), text);
  assert.equal(nativeWireOutput(text), text);
  const rows = Array.from({ length: 1001 }, (_, i) => ({ Value: i }));
  assert.deepEqual(canonicalValue({ base: 'RecordList' }, rows), rows);
  assert.deepEqual(nativeWireOutput({ List: rows, EmptyListItem: {} }), rows);
  const fields = Object.fromEntries(Array.from({ length: 210 }, (_, i) => ['Field' + i, i]));
  assert.deepEqual(nativeWireOutput(fields), fields);
  assert.equal(nativeWireOutput('prefix private-id suffix', ['private-id']), 'prefix [private] suffix');
  assert.throws(() => canonicalValue({ base: 'Text' }, 'x'.repeat(O11_NATIVE_INPUT_BYTES)), /input_transport_budget/);
  assert.throws(() => canonicalScenario([{ name: 'A', dataType: 'Text' }, { name: 'B', dataType: 'Text' }],
    { A: 'x'.repeat(70000), B: 'x'.repeat(70000) }), /input_transport_budget/);
  assert.deepEqual(nativeWireOutput('x'.repeat(NATIVE_OUTPUT_BYTES)), { omitted: true, reason: 'transport_budget', nativeInspectionRequired: true });
});
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
  assert.throws(() => canonicalValue(t('BinaryData'), 'x'), /type_mismatch/);
  assert.deepEqual(o11TypeOf({ modelType: 'IdentifierType:Order Identifier', identifierBase: 'LongInteger' }), { base: 'LongInteger', identifier: 'Order Identifier' });
  assert.deepEqual(o11TypeOf({ modelType: 'BasicType:Date Time' }), { base: 'DateTime' });
  assert.deepEqual(o11TypeOf({ modelType: 'Structure:Point' }), { base: 'Record', of: 'Point' });
  assert.deepEqual(o11TypeOf({ dataType: 'Currency' }), { base: 'Currency' });
});

test('binary inputs preserve all bytes in canonical inline base64 and reject URL-backed or malformed values', () => {
  const value = Buffer.from(Array.from({length:256}, (_,i) => i)).toString('base64');
  assert.equal(canonicalValue({base:'BinaryData'}, value), value);
  assert.equal(canonicalValue({base:'BinaryData'}, ''), '');
  assert.equal(canonicalValue({base:'BinaryData'}, null), null);
  for (const invalid of ['A', 'AAA', 'AB==', 'AAA===', 'AA==\n', 'data:application/octet-stream;base64,AA==',
    'https://example.org/file', {content:'AA==',url:'https://example.org/file'}, [0,1]])
    assert.throws(() => canonicalValue({base:'BinaryData'}, invalid), /type_mismatch/);
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

// ----- typed inputs: basic lists, typed records, identifier bases, Binary caps ---------------------------------------
import { o11InputClassFor, O11_NATIVE_BINARY_INPUT_BYTES, O11_NATIVE_ENVELOPE_BYTES } from '../debug-o11-native-abi.mjs';
import { typedModelAssets } from './fixtures/debug-o11-typed-model-fixture.mjs';

test('basic-type lists canonicalize every item by the element type; object or mixed items refuse', () => {
  const list = modelType => o11TypeOf({ name: 'L', modelType, dataType: 'RecordList' });
  assert.deepEqual(list('ListType:Text List'), { base: 'RecordList', of: 'Text List', element: { base: 'Text' } });
  assert.deepEqual(canonicalValue(list('ListType:Text List'), ['a', 'Olá']), ['a', 'Olá']);
  assert.deepEqual(canonicalValue(list('ListType:Integer List'), [1, -2147483648]), [1, -2147483648]);
  assert.deepEqual(canonicalValue(list('ListType:Long Integer List'), ['9223372036854775807', 7]), ['9223372036854775807', '7']);
  assert.deepEqual(canonicalValue(list('ListType:Date List'), ['2024-02-29']), ['2024-02-29']);
  assert.deepEqual(canonicalValue(list('ListType:Date Time List'), ['2026-10-04T12:30:00-03:00']), ['2026-10-04T15:30:00Z']);
  for (const [type, items] of [['Text', [{ Value: 'a' }]], ['Text', ['a', 1]], ['Integer', [1, '2']], ['Integer', [[1]]], ['Date', ['2026-02-30']],
    ['Text', [null]], ['Long Integer', [9007199254740993]], ['Boolean', [true, 'false']]])
    assert.throws(() => canonicalValue(list('ListType:' + type + ' List'), items), /type_mismatch/, type + ' ' + JSON.stringify(items));
  assert.throws(() => canonicalValue(list('ListType:Text List'), 'a'), /type_mismatch/);
  assert.throws(() => canonicalValue(list('ListType:Object List'), [{}]), /type_unsupported/);
  assert.deepEqual(canonicalScenario([{ name: 'Tags', modelType: 'ListType:Text List' }], { Tags: ['x', ''] }).values, { Tags: ['x', ''] });
  assert.throws(() => canonicalScenario([{ name: 'Tags', modelType: 'ListType:Text List' }], { Tags: [{ x: 1 }] }), /type_mismatch:Tags\[0\]/);
});

test('list and record classes resolve from the published asset item type and schema, never from a class name alone', () => {
  const parsed = parseO11Assets(typedModelAssets(), 'ShopUI');
  assert.deepEqual(parsed.classes['ShopUI.model$TextList'], { define: 'ShopUI.model$', kind: 'list', itemType: { dataType: 'Text' } });
  assert.deepEqual(parsed.classes['ShopUI.model$LineList'], { define: 'ShopUI.model$LineList', kind: 'list', itemType: { recordClass: 'ShopUI.model$LineRec' } });
  assert.deepEqual(parsed.classes['ShopUI.model$LineRec'].attributes.map(a => [a.name, a.attribute, a.dataType, a.complexType ?? null]), [
    ['Sku', 'skuAttr', 'Text', null], ['Qty', 'qtyAttr', 'Integer', null], ['Ref', 'refAttr', 'LongInteger', null], ['Price', 'priceAttr', 'Decimal', null],
    ['At', 'atAttr', 'DateTime', null], ['Blob', 'blobAttr', 'BinaryData', null], ['Tags', 'tagsAttr', 'RecordList', 'runtime:TextList']]);
  assert.deepEqual(parsed.classes['ShopUI.model$OrderRec'].attributes.map(a => a.complexType ?? null), [null, null, 'ShopUI.model$LineRec', 'ShopUI.model$LineList', null]);
  const resolve = (module, name, dataType, modelType, extra = {}) => o11InputClassFor(parsed, module, { name, dataType, modelType, ...extra });
  // A published module list with a basic item type is a GenericRecordList the original converter cannot instantiate
  // (golden worker test): basic lists use the runtime OS.DataTypes.<X>List.
  assert.deepEqual(resolve('ShopUI', 'Tags', 'RecordList', 'ListType:Text List'), { runtimeList: 'TextList', element: 'Text' });
  assert.deepEqual(resolve('ShopUI', 'Ids', 'RecordList', 'ListType:Long Integer List'), { runtimeList: 'LongIntegerList', element: 'LongInteger' });
  assert.deepEqual(resolve('ShopUI', 'Days', 'RecordList', 'ListType:Date List'), { runtimeList: 'DateList', element: 'Date' });
  // Trap.model$TextList is a list of the Text STRUCTURE: the published item type wins over the "Text List" name.
  assert.deepEqual(resolve('Trap', 'Texts', 'RecordList', 'ListType:Text List'), { recordClass: 'Trap.model$TextList' });
  assert.deepEqual(resolve('ShopUI', 'Lines', 'RecordList', 'ListType:Line List'), { recordClass: 'ShopUI.model$LineList' });
  assert.deepEqual(resolve('ShopUI', 'Order', 'Record', 'ServerEntity:Order'), { recordClass: 'ShopUI.model$OrderRec' });
  assert.deepEqual(resolve('Consumer', 'Text', 'Record', 'Structure:Text'), { recordClass: 'Ext.model$TextRec' }); // unique producer class
  assert.deepEqual(resolve('ShopUI', 'Lines', 'RecordList', null, { complexType: 'ShopUI.model$LineList' }), { recordClass: 'ShopUI.model$LineList' });
  assert.deepEqual(resolve('ShopUI', 'Ints', 'RecordList', null, { complexType: 'runtime:IntegerList' }), { runtimeList: 'IntegerList', element: 'Integer' });
  assert.throws(() => resolve('ShopUI', 'X', 'Record', 'Structure:Nope'), /record_class_unresolved:X/);
  assert.throws(() => resolve('ShopUI', 'X', 'RecordList', null, { complexType: 'ShopUI.model$Nope' }), /record_class_unresolved:X/);
  assert.equal(resolve('ShopUI', 'Zip', 'Text', 'BasicType:Text'), undefined);
  const action = parsed.clientActions.find(c => c.name === 'AddLines');
  assert.deepEqual(action.inputs, [{ param: 'linesIn', name: 'Lines', dataType: 'RecordList', mandatory: true, complexType: 'ShopUI.model$LineList' }]);
});

test('record attributes are typed by the published record schema, recursively; unknown attributes refuse', () => {
  const schemas = parseO11Assets(typedModelAssets(), 'ShopUI').classes;
  const order = { base: 'Record', of: 'Order', recordClass: 'ShopUI.model$OrderRec', schemas };
  const value = { Id: '9223372036854775807', Note: 'n', Main: { Sku: 'A', Qty: 2, Price: '010.50', At: '2026-10-04T12:30:00-03:00', Blob: 'AAEC', Tags: ['x'] },
    Lines: [{ Sku: 'B', Ref: 42 }, { Ref: '-9223372036854775808' }] };
  assert.deepEqual(canonicalValue(order, value), { Id: '9223372036854775807', Note: 'n',
    Main: { Sku: 'A', Qty: 2, Price: '10.5', At: '2026-10-04T15:30:00Z', Blob: 'AAEC', Tags: ['x'] },
    Lines: [{ Sku: 'B', Ref: '42' }, { Ref: '-9223372036854775808' }] });
  for (const [input, code] of [[{ Id: 9223372036854775807 }, /type_mismatch:value\.Id/], [{ Main: { Price: '1.123456789' } }, /type_mismatch:value\.Main\.Price/],
    [{ Main: { At: '2026-10-04T12:30:00' } }, /type_mismatch:value\.Main\.At/], [{ Main: { Blob: 'AAA' } }, /type_mismatch:value\.Main\.Blob/],
    [{ Bogus: 1 }, /unknown_attribute:value\.Bogus/], [{ Lines: [{ Nope: 1 }] }, /unknown_attribute:value\.Lines\[0\]\.Nope/],
    [{ Lines: [1] }, /type_mismatch:value\.Lines\[0\]/], [{ Payload: {} }, /type_unsupported:Object:value\.Payload/],
    [{ Main: { Tags: [1] } }, /type_mismatch:value\.Main\.Tags\[0\]/], [{ Main: { Qty: '2' } }, /type_mismatch:value\.Main\.Qty/],
    [{ Main: { secretKey: 'x' } }, /private_or_invalid:value\.Main\.secretKey/]])
    assert.throws(() => canonicalValue(order, input), code, JSON.stringify(input));
  // A typed scenario names its record class; with schemas present an unresolved class refuses instead of passing raw JSON.
  const parameter = { name: 'Order', modelType: 'ServerEntity:Order', recordClass: 'ShopUI.model$OrderRec' };
  assert.deepEqual(canonicalScenario([parameter], { Order: { Id: 5 } }, { schemas }).values, { Order: { Id: '5' } });
  assert.throws(() => canonicalScenario([parameter], { Order: { Nope: 1 } }, { schemas }), /unknown_attribute:Order\.Nope/);
  assert.throws(() => canonicalScenario([{ name: 'Order', modelType: 'ServerEntity:Order' }], { Order: {} }, { schemas }), /record_schema_unresolved:Order/);
  assert.throws(() => canonicalScenario([{ name: 'Lines', modelType: 'ListType:Line List' }], { Lines: [] }, { schemas }), /record_schema_unresolved:Lines/);
  assert.deepEqual(canonicalScenario([{ name: 'Lines', modelType: 'ListType:Line List', recordClass: 'ShopUI.model$LineList' }],
    { Lines: [{ Qty: 1, Tags: [] }] }, { schemas }).values, { Lines: [{ Qty: 1, Tags: [] }] });
  assert.deepEqual(canonicalScenario([{ name: 'Tags', modelType: 'ListType:Text List', recordClass: 'ShopUI.model$TextList' }],
    { Tags: ['a'] }, { schemas }).values, { Tags: ['a'] });
  assert.throws(() => canonicalScenario([{ name: 'Tags', modelType: 'ListType:Text List', recordClass: 'ShopUI.model$TextList' }], { Tags: [{}] }, { schemas }), /type_mismatch:Tags\[0\]/);
});

test('scenario classes resolve lazily from the published assets: the item type decides, an omitted input never refuses', () => {
  const parsed = parseO11Assets(typedModelAssets(), 'ShopUI'), schemas = parsed.classes;
  const options = module => ({ schemas, classFor: p => o11InputClassFor(parsed, module, p) });
  const texts = [{ name: 'Texts', modelType: 'ListType:Text List' }];
  assert.deepEqual(canonicalScenario(texts, { Texts: ['a'] }, options('ShopUI')).values, { Texts: ['a'] }); // runtime TextList
  assert.deepEqual(canonicalScenario(texts, { Texts: [{ Text: 'a' }] }, options('Trap')).values, { Texts: [{ Text: 'a' }] }); // Text STRUCTURE list
  assert.throws(() => canonicalScenario(texts, { Texts: ['a'] }, options('Trap')), /type_mismatch:Texts\[0\]/);
  assert.throws(() => canonicalScenario(texts, { Texts: [{ Nope: 'a' }] }, options('Trap')), /unknown_attribute:Texts\[0\]\.Nope/);
  assert.deepEqual(canonicalScenario([{ name: 'Order', modelType: 'ServerEntity:Order' }], { Order: { Id: 5, Lines: [{ Tags: ['t'] }] } }, options('ShopUI')).values,
    { Order: { Id: '5', Lines: [{ Tags: ['t'] }] } });
  assert.deepEqual(canonicalScenario([{ name: 'X', modelType: 'Structure:Nope' }], {}, options('ShopUI')), { values: {}, presence: { X: 'omitted' } });
  assert.throws(() => canonicalScenario([{ name: 'X', modelType: 'Structure:Nope' }], { X: {} }, options('ShopUI')), /record_class_unresolved:X/);
  // A screen variable typed with a runtime basic list names that list, never a module class.
  const screen = `define("ShopUI.Main.Home.mvc$model", ["OutSystems/ClientRuntime/Main", "ShopUI.model"], function (OutSystems, ShopUIModel) {
var OS = OutSystems.Internal;
var VariablesRecord = (function (_super) {
VariablesRecord.attributesToDeclare = function () {
return [
this.attr("Tags", "tagsVar", "Tags", true, false, OS.DataTypes.DataTypes.RecordList, function () {
return new OS.DataTypes.TextList();
}, false, OS.DataTypes.TextList),
this.attr("Order", "orderVar", "Order", true, false, OS.DataTypes.DataTypes.Record, function () {
return new ShopUIModel.OrderRec();
}, false, ShopUIModel.OrderRec)
].concat(_super.attributesToDeclare.call(this));
};
})(OS.DataTypes.GenericRecord);
return new OS.Model.ModelFactory(Model, "Main.Home");
});
`;
  assert.deepEqual(parseO11Assets([{ name: 'ShopUI.Main.Home.mvc.js', text: screen }], 'ShopUI').components['Main.Home'].variables, [
    { name: 'Tags', attribute: 'tagsVar', dataType: 'RecordList', runtimeList: 'TextList', element: 'Text' },
    { name: 'Order', attribute: 'orderVar', dataType: 'Record', recordClass: 'ShopUI.model$OrderRec' }]);
});

test('identifier inputs are typed by the entity reference base and refuse when that base is unresolved', () => {
  const identifier = (name, base, extra = {}) => ({ name, modelType: 'IdentifierType:' + name + ' Identifier', ...(base ? { identifierBase: base } : {}), ...extra });
  assert.deepEqual(o11TypeOf(identifier('User', 'Integer')), { base: 'Integer', identifier: 'User Identifier' });
  assert.deepEqual(o11TypeOf(identifier('Code', 'Text')), { base: 'Text', identifier: 'Code Identifier' });
  assert.deepEqual(o11TypeOf(identifier('Order', null, { dataType: 'LongInteger' })), { base: 'LongInteger', identifier: 'Order Identifier' }); // published asset type
  assert.deepEqual(canonicalScenario([identifier('User', 'Integer')], { User: 7 }).values, { User: 7 });
  assert.throws(() => canonicalScenario([identifier('User', 'Integer')], { User: '7' }), /type_mismatch:User/);
  assert.deepEqual(canonicalScenario([identifier('Order', 'LongInteger')], { Order: 42 }).values, { Order: '42' });
  assert.throws(() => canonicalScenario([identifier('Order', 'LongInteger')], { Order: 'abc' }), /type_mismatch:Order/);
  assert.deepEqual(canonicalScenario([identifier('Code', 'Text')], { Code: 'A-1' }).values, { Code: 'A-1' });
  assert.throws(() => o11TypeOf(identifier('Order', null)), /^Error: debug_o11_native_identifier_base_unresolved:Order$/);
  assert.throws(() => o11TypeOf(identifier('Order', 'Guid')), /identifier_base_unresolved:Order/);
  assert.throws(() => canonicalScenario([identifier('Order', null)], { Order: '1' }), /identifier_base_unresolved:Order/);
});

test('Binary inputs: the largest accepted and first refused values under the explicit SSAM caps', () => {
  assert.equal(O11_NATIVE_INPUT_BYTES, 131072); assert.equal(O11_NATIVE_ENVELOPE_BYTES, 262144);
  assert.equal(O11_NATIVE_BINARY_INPUT_BYTES, 98301);
  const bytes = n => Buffer.alloc(n, 7).toString('base64');
  assert.equal(canonicalValue({ base: 'BinaryData' }, bytes(98301)), bytes(98301));
  assert.throws(() => canonicalValue({ base: 'BinaryData' }, bytes(98302)), /^Error: debug_o11_native_input_binary_too_large:value$/);
  const schemas = parseO11Assets(typedModelAssets(), 'ShopUI').classes, line = { base: 'Record', recordClass: 'ShopUI.model$LineRec', schemas };
  assert.throws(() => canonicalValue(line, { Blob: bytes(98302) }), /binary_too_large:value\.Blob/);
  // The whole scenario's inputs share the same JSON budget: a value named File carries 11 bytes of object overhead.
  const file = [{ name: 'File', modelType: 'BasicType:Binary Data' }];
  assert.equal(canonicalScenario(file, { File: bytes(98295) }).values.File.length, 131060);
  assert.throws(() => canonicalScenario(file, { File: bytes(98296) }), /input_transport_budget:inputs/);
  assert.throws(() => canonicalScenario(file, { File: bytes(98302) }), /binary_too_large:File/);
});

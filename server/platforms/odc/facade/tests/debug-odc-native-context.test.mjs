import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeInputBindings, prepareOdcNativeContext } from '../debug-odc-native-context.mjs';

const DataTypes = { Integer: 0, LongInteger: 1, Decimal: 2, Text: 4, Boolean: 7, Record: 9, RecordList: 10 };
const converted = [];
const converter = { from(value, type) { converted.push({ value, type }); return { native: value, type }; } };
class Details {
  static getAttributes() { return [{ name: 'Count', nameForJson: 'count', attrName: 'countAttr', dataType: DataTypes.Integer }]; }
}
class Items { static getItemType() { return Details; } }
const attrs = [
  { name: 'RecordId', attrName: 'recordIdIn', nameForJson: 'RecordId', dataType: DataTypes.LongInteger },
  { name: 'Enabled', attrName: 'enabledVar', nameForJson: 'Enabled', dataType: DataTypes.Boolean },
  { name: 'Details', attrName: 'detailsVar', dataType: DataTypes.Record, complexType: Details },
  { name: 'Items', attrName: 'itemsVar', dataType: DataTypes.RecordList, complexType: Items },
  { name: '_RecordIdStatus', attrName: '_recordIdInDataFetchStatus', dataType: DataTypes.Integer },
  { name: 'Rows', attrName: 'rowsDataAct', dataType: DataTypes.Record, complexType: Details },
];
class Model {
  constructor() { this.variables = { getAttributes: () => attrs, enabledVar: false }; }
  setInputs(input) { if ('RecordId' in input) this.variables.recordIdIn = converter.from(input.RecordId, DataTypes.LongInteger); }
}
const services = model => ({ screenModel: model, dataTypes: DataTypes, converter });

test('context validates before assignment and applies exact native setInputs and typed local variables', () => {
  const model = new Model(), before = model.variables.enabledVar;
  const result = prepareOdcNativeContext({ screen: { inputs: { RecordId: '9007199254740993' }, variables: { Enabled: true } } }, services(model));
  assert.equal(model.variables.enabledVar, before);
  assert.equal(nativeInputBindings(model).get('recordIdIn'), 'RecordId');
  result.apply();
  assert.equal(model.variables.recordIdIn.native, '9007199254740993');
  assert.equal(model.variables.enabledVar.native, true);
  assert.deepEqual(result.receipt, { screen: { inputs: ['RecordId'], variables: ['Enabled'] } });
  assert.equal(JSON.stringify(result.receipt).includes('9007199254740993'), false);
});

test('context preserves declared nested record/list types and rejects undeclared fields', () => {
  const model = new Model();
  const context = prepareOdcNativeContext({ screen: { variables: { Details: { Count: 2 }, Items: [{ Count: 3 }] } } }, services(model));
  context.apply();
  assert.deepEqual(model.variables.detailsVar.native, { Count: 2 });
  assert.deepEqual(model.variables.itemsVar.native, { List: [{ Count: 3 }] });
  assert.throws(() => prepareOdcNativeContext({ screen: { variables: { Details: { Unknown: 1 } } } }, services(model)), /input_unknown_attribute/);
});

test('context rejects unknown owners, types, credentials and internal model state before apply', () => {
  const model = new Model();
  for (const context of [
    { owner: {} }, { block: { inputs: { RecordId: '1' } } },
    { screen: { roles: ['Administrator'] } }, { screen: { variables: { _RecordIdStatus: 1 } } },
    { screen: { variables: { Rows: { Count: 1 } } } }, { screen: { variables: { Enabled: 'true' } } },
    { screen: { inputs: { Unknown: 1 } } }, { screen: { inputs: { AccessToken: 'private' } } },
  ]) assert.throws(() => prepareOdcNativeContext(context, services(model)), /debug_odc_native_/);
  assert.equal(model.variables.enabledVar, false);
  assert.equal(model.variables.recordIdIn, undefined);
});

test('screen and block context bind separate native models', () => {
  const screen = new Model(), block = new Model();
  prepareOdcNativeContext({ screen: { inputs: { RecordId: '1' } }, block: { inputs: { RecordId: '2' } } },
    { ...services(screen), blockModel: block }).apply();
  assert.equal(screen.variables.recordIdIn.native, '1');
  assert.equal(block.variables.recordIdIn.native, '2');
});

test('block direct input setters receive native typed values and never expose fetch status', () => {
  class BlockModel {
    constructor() { this.variables = { getAttributes: () => attrs }; }
    setInputs(input) {
      if ('RecordId' in input) this.variables.recordIdIn = input.RecordId;
      if ('_RecordIdStatus' in input) this.variables._recordIdInDataFetchStatus = input._RecordIdStatus;
    }
  }
  const block = new BlockModel();
  assert.deepEqual([...nativeInputBindings(block)], [['recordIdIn', 'RecordId']]);
  const prepared = prepareOdcNativeContext({ block: { inputs: { RecordId: '9007199254740993' } } },
    { blockModel: block, dataTypes: DataTypes, converter });
  assert.equal(block.variables.recordIdIn, undefined);
  prepared.apply();
  assert.deepEqual(block.variables.recordIdIn, { native: '9007199254740993', type: DataTypes.LongInteger });
  assert.throws(() => prepareOdcNativeContext({ block: { inputs: { _RecordIdStatus: 2 } } },
    { blockModel: block, dataTypes: DataTypes, converter }), /context_attribute_unresolved/);
});

test('ambiguous wire/native setter bindings are refused before context mutation', () => {
  const model = new Model();
  model.setInputs = { setInputs(input) {
    this.variables.recordIdIn = input.RecordId;
    this.variables.recordIdIn = converter.from(input.RecordId, DataTypes.LongInteger);
  } }.setInputs;
  assert.throws(() => prepareOdcNativeContext({ screen: { inputs: { RecordId: '1' } } }, services(model)), /context_input_binding_ambiguous/);
  assert.equal(model.variables.recordIdIn, undefined);
});

test('context identifiers keep their runtime base in the field signature; unbound record classes refuse', () => {
  class Unbound { static getAttributes() { return []; } }
  const typed = [{ name: 'OwnerId', attrName: 'ownerIdVar', dataType: DataTypes.LongInteger }, { name: 'Code', attrName: 'codeVar', dataType: DataTypes.Text },
    { name: 'Seat', attrName: 'seatVar', dataType: DataTypes.Integer }, { name: 'Empty', attrName: 'emptyVar', dataType: DataTypes.Record, complexType: Unbound },
    { name: 'Nested', attrName: 'nestedVar', dataType: DataTypes.Record, complexType: class { static getAttributes() { return [{ name: 'Inner', dataType: DataTypes.Record, complexType: Unbound }]; } } }];
  class TypedModel { constructor() { this.variables = { getAttributes: () => typed }; } setInputs() {} }
  const model = new TypedModel(), seen = [];
  const capture = { from(value, type) { seen.push(value); return value; } };
  prepareOdcNativeContext({ screen: { variables: { OwnerId: 42, Code: 'A-1', Seat: 3 } } }, { screenModel: model, dataTypes: DataTypes, converter: capture }).apply();
  assert.deepEqual(seen, ['42', 'A-1', 3]);
  for (const [variables, code] of [[{ OwnerId: 'abc' }, /input_type_invalid/], [{ Seat: '3' }, /input_type_invalid/], [{ Code: 5 }, /input_type_invalid/],
    [{ Empty: { Any: 1 } }, /input_record_unbound/], [{ Empty: {} }, /input_record_unbound/], [{ Nested: { Inner: { Any: 1 } } }, /input_record_unbound/]])
    assert.throws(() => prepareOdcNativeContext({ screen: { variables } }, { screenModel: new TypedModel(), dataTypes: DataTypes, converter: capture }), code, JSON.stringify(variables));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeInputs, canonicalizeValue, decodeOutput, SUPPORTED_INPUT_TYPES } from '../debug-odc-native-types.mjs';

const sig = [
  { name: 'Address1', dataType: 'Text', mandatory: true },
  { name: 'IsManual', dataType: 'Boolean', mandatory: true },
  { name: 'Floors', dataType: 'Integer', mandatory: false },
  { name: 'Year', dataType: 'Long Integer', mandatory: false },
  { name: 'Cost', dataType: 'Decimal', mandatory: false },
  { name: 'When', dataType: 'Date Time', mandatory: false },
];

test('accepts every scalar type in canonical form', () => {
  const c = canonicalizeInputs({ Address1: '100 Main', IsManual: false, Floors: 2, Year: '1998', Cost: '123.45', When: '2026-10-04T12:00:00' }, sig);
  assert.deepEqual(c.Address1, { value: '100 Main' });
  assert.deepEqual(c.Floors, { value: 2 });
  assert.deepEqual(c.Year, { value: '1998' });     // Long Integer kept as string
  assert.deepEqual(c.Cost, { value: '123.45' });   // Decimal kept as string
});

test('Integer range is Int32-bounded', () => {
  assert.throws(() => canonicalizeInputs({ Address1: 'x', IsManual: true, Floors: 3000000000 }, sig), /input_type_invalid/);
  assert.deepEqual(canonicalizeInputs({ Address1: 'x', IsManual: true, Floors: 2147483647 }, sig).Floors, { value: 2147483647 });
});

test('mandatory omitted fails, optional omitted is marked', () => {
  assert.throws(() => canonicalizeInputs({ IsManual: true }, sig), /input_mandatory_missing/);
  const c = canonicalizeInputs({ Address1: 'x', IsManual: true }, sig);
  assert.deepEqual(c.Floors, { omitted: true });
});

test('unknown key and private name are refused in prepare', () => {
  assert.throws(() => canonicalizeInputs({ Address1: 'x', IsManual: true, Bogus: 1 }, sig), /input_unknown/);
  assert.throws(() => canonicalizeInputs({ Address1: 'x', IsManual: true, password: 'p' }, sig), /input_private_name/);
});

test('Record and RecordList canonicalize nested fields', () => {
  const field = { name: 'Rows', dataType: 'RecordList', mandatory: false, complexType: [{ name: 'Id', dataType: 'Text', mandatory: true }, { name: 'Order', dataType: 'Integer', mandatory: false }] };
  const out = canonicalizeValue([{ Id: 'A', Order: 1 }, { Id: 'B' }], field);
  assert.deepEqual(out, [{ Id: 'A', Order: 1 }, { Id: 'B', Order: null }]);
  assert.throws(() => canonicalizeValue([{ Order: 1 }], field), /input_mandatory_missing/);
  assert.throws(() => canonicalizeValue([{ Id: 'A', Extra: 1 }], field), /input_unknown_attribute/);
});

test('Binary is refused in this surface', () => {
  assert.throws(() => canonicalizeValue('AA=', { name: 'B', dataType: 'Binary Data', mandatory: false }), /input_type_unsupported/);
  assert.ok(!SUPPORTED_INPUT_TYPES.includes('Binary Data'));
});

test('empty inputs allowed for a zero-input action', () => {
  assert.deepEqual(canonicalizeInputs({}, []), {});
  assert.deepEqual(canonicalizeInputs(null, []), {});
});

test('output decoding keeps Long/Decimal as strings', () => {
  assert.equal(decodeOutput(12345678901234n, 'LongInteger'), '12345678901234');
  assert.equal(decodeOutput(123.45, 'Decimal'), '123.45');
  assert.equal(decodeOutput('text', 'Text'), 'text');
  assert.equal(decodeOutput(null, 'Text'), null);
});

import './fixtures/isolated-profile.mjs';
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
  const c = canonicalizeInputs({ Address1: '100 Main', IsManual: false, Floors: 2, Year: '1998', Cost: '123.45', When: '2026-10-04T12:00:00-03:00' }, sig);
  assert.deepEqual(c.Address1, { value: '100 Main' });
  assert.deepEqual(c.Floors, { value: 2 });
  assert.deepEqual(c.Year, { value: '1998' });     // Long Integer kept as string
  assert.deepEqual(c.Cost, { value: '123.45' });   // Decimal kept as string
  assert.deepEqual(c.When, { value: '2026-10-04T15:00:00Z' }); // explicit offset normalized to UTC
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

test('Binary accepts canonical bytes and rejects malformed or ambiguous base64 before execution', () => {
  for (const dataType of ['Binary Data', 'BinaryData', 'Binary']) {
    for (const size of [0, 3, 256, 8192]) {
      const bytes = Buffer.from(Array.from({length:size}, (_, i) => i % 256));
      assert.deepEqual(Buffer.from(canonicalizeValue(bytes.toString('base64'), {dataType}), 'base64'), bytes);
    }
    for (const value of ['AA=', 'AB==', 'AA', 'AA==\n', 'AA-_', 'data:;base64,AA==', {}, 3])
      assert.throws(() => canonicalizeValue(value, {dataType}), /input_type_invalid/);
    assert.throws(() => canonicalizeValue('A'.repeat(1048580), {dataType}), /input_binary_too_large/);
  }
  assert.ok(SUPPORTED_INPUT_TYPES.includes('Binary Data'));
  const signature = [{name:'Rows',dataType:'RecordList',complexType:[{name:'Bytes',dataType:'Binary Data'}]}];
  assert.deepEqual(canonicalizeInputs({Rows:[{Bytes:'AAEC'}]},signature).Rows.value,[{Bytes:'AAEC'}]);
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

test('unsafe numeric identifiers, Int64 overflow and invalid dates never enter the native runtime', () => {
  const value = (v, dataType) => canonicalizeValue(v, { dataType });
  for (const v of [9007199254740992, '9223372036854775808', '-9223372036854775809']) assert.throws(() => value(v, 'Long Integer'), /input_type_invalid/);
  assert.equal(value('9223372036854775807', 'Long Integer'), '9223372036854775807');
  assert.throws(() => value(9007199254740992, 'Identifier'), /input_type_invalid/);
  for (const v of ['2025-02-29', '2026-02-30', '0000-01-01']) assert.throws(() => value(v, 'Date'), /input_type_invalid/);
  assert.equal(value('2024-02-29', 'Date'), '2024-02-29');
  assert.throws(() => value('2026-10-04T24:00:00Z', 'Date Time'), /input_type_invalid/);
  assert.throws(() => value({ deep: [{ token: 'private' }] }, 'Record'), /input_private_name/);
  assert.throws(() => value(JSON.parse('{"__proto__":{"polluted":true}}'), 'Record'), /input_private_name/);
});

// ----- parity with the O11 canonical forms -------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { ODC_NATIVE_TEXT_INPUT_CHARS, ODC_NATIVE_BINARY_INPUT_BYTES, ODC_NATIVE_DECIMAL_MAX_SCALE } from '../debug-odc-native-types.mjs';

test('Decimal and Currency use the native Decimal bounds (96-bit mantissa, scale 28) and normalize like O11', () => {
  for (const dataType of ['Decimal', 'Currency']) {
    const value = v => canonicalizeValue(v, { name: 'D', dataType });
    assert.equal(value('0012.3400'), '12.34'); assert.equal(value(-0.5), '-0.5'); assert.equal(value('-0.000'), '0'); assert.equal(value(7), '7');
    assert.equal(value('79228162514264337593543950335'), '79228162514264337593543950335');
    assert.equal(value('-79228162514264337593543950335'), '-79228162514264337593543950335');
    assert.equal(value('7922816251426433759354395033.5'), '7922816251426433759354395033.5');
    assert.equal(value('0.' + '0'.repeat(27) + '1'), '0.' + '0'.repeat(27) + '1');
    assert.equal(value('1.' + '0'.repeat(40)), '1'); // trailing zeros carry no scale
    for (const bad of ['79228162514264337593543950336', '7922816251426433759354395033.6', '0.' + '0'.repeat(28) + '1', '1e5', 1e21, NaN, '', '.5', '5.', '+1', '1,5', true])
      assert.throws(() => value(bad), /input_type_invalid/, dataType + ' ' + String(bad));
  }
  assert.equal(ODC_NATIVE_DECIMAL_MAX_SCALE, 28);
});

test('the native Decimal range matches the published client runtime constants when the evidence is present', { skip: !process.env.SSAM_DEBUG_EVIDENCE_ROOT }, () => {
  const runtime = fs.readFileSync(path.join(process.env.SSAM_DEBUG_EVIDENCE_ROOT, 'proofs', 'o11-service-authenticated-chain', 'acquired',
    'e662ebb3-16f8-43ca-b548-ee0fcba16a03', 'OutSystems.js'), 'utf8');
  assert.match(runtime, /MIN_DECIMAL_VALUE=new [\w.]+\("2"\)\.pow\(96\)\.neg\(\)/);
  assert.match(runtime, /MAX_DECIMAL_VALUE=new [\w.]+\("2"\)\.pow\(96\)\.minus\(1\)/);
});

test('Date Time requires Z or an explicit offset and normalizes to UTC like O11', () => {
  const value = v => canonicalizeValue(v, { name: 'When', dataType: 'Date Time' });
  assert.equal(value('2026-10-04T12:30:00-03:00'), '2026-10-04T15:30:00Z');
  assert.equal(value('2026-10-04T12:30:00Z'), '2026-10-04T12:30:00Z');
  assert.equal(value('2026-10-04T12:30:00.250+01:00'), '2026-10-04T11:30:00.250Z');
  assert.equal(canonicalizeValue('2026-12-31T23:30:00-01:00', { dataType: 'DateTime' }), '2027-01-01T00:30:00Z');
  for (const bad of ['2026-10-04T12:30:00', '2026-10-04', '2026-10-04 12:30:00Z', '2026-10-04T24:00:00Z', '2026-02-30T00:00:00Z',
    '2026-10-04T12:30:00+24:00', '2026-10-04T12:30Z', '0001-01-01T00:30:00+01:00', 1728000000000])
    assert.throws(() => value(bad), /input_type_invalid/, String(bad));
});

test('identifiers canonicalize by the runtime base the signature carries; native-entry refuses an unresolved base', () => {
  const id = (v, field) => canonicalizeValue(v, { name: 'Id', dataType: 'Identifier', ...field });
  assert.equal(id('42', { identifierBase: 'LongInteger' }), '42'); assert.equal(id(42, { identifierBase: 'Long Integer' }), '42');
  assert.equal(id('9223372036854775807', { runtimeDataType: 'LongInteger' }), '9223372036854775807');
  for (const bad of ['abc', '9223372036854775808', 9007199254740992, '1.5']) assert.throws(() => id(bad, { identifierBase: 'LongInteger' }), /input_type_invalid/, String(bad));
  assert.equal(id(7, { identifierBase: 'Integer' }), 7);
  for (const bad of ['7', 2147483648]) assert.throws(() => id(bad, { identifierBase: 'Integer' }), /input_type_invalid/);
  assert.equal(id('A-1', { identifierBase: 'Text' }), 'A-1');
  for (const bad of [5, 'x'.repeat(201)]) assert.throws(() => id(bad, { identifierBase: 'Text' }), /input_type_invalid/);
  assert.equal(canonicalizeValue('abc', { name: 'Code', dataType: 'Text Identifier' }), 'abc');
  assert.throws(() => canonicalizeValue('abc', { name: 'Ref', dataType: 'Long Integer Identifier' }), /input_type_invalid/);
  const signature = [{ name: 'Id', dataType: 'Identifier', mandatory: true }];
  assert.throws(() => canonicalizeInputs({ Id: '1' }, signature, { strictIdentifiers: true }), /^Error: debug_odc_native_input_identifier_base_unresolved:Id$/);
  assert.throws(() => canonicalizeValue([{ Id: '1' }], { name: 'Rows', dataType: 'RecordList', complexType: signature }, { strictIdentifiers: true }), /identifier_base_unresolved:Id/);
  assert.deepEqual(canonicalizeInputs({ Id: '2147483647' }, signature), { Id: { value: '2147483647' } }); // REST endpoint lane keeps its own OpenAPI typing
});

test('records refuse when the runtime record class attributes are not bound', () => {
  assert.throws(() => canonicalizeValue({ A: 1 }, { name: 'R', dataType: 'Record' }), /^Error: debug_odc_native_input_record_unbound:R$/);
  assert.throws(() => canonicalizeValue({}, { name: 'R', dataType: 'Structure', complexType: [] }), /input_record_unbound:R/);
  assert.throws(() => canonicalizeValue([{ A: 1 }], { name: 'Rows', dataType: 'RecordList' }), /input_record_unbound:Rows/);
  assert.throws(() => canonicalizeInputs({ R: { A: 1 } }, [{ name: 'R', dataType: 'Record' }]), /input_record_unbound:R/);
  assert.deepEqual(canonicalizeValue(['a'], { name: 'Tags', dataType: 'RecordList', elementType: { name: 'Item', dataType: 'Text' } }), ['a']);
});

test('Email and Phone Number stay Text', () => {
  for (const dataType of ['Email', 'Phone Number', 'PhoneNumber']) {
    assert.equal(canonicalizeValue('ana@example.invalid', { dataType }), 'ana@example.invalid');
    assert.equal(canonicalizeValue('+1 (555) 010-0000', { dataType }), '+1 (555) 010-0000');
    assert.equal(canonicalizeValue('', { dataType }), '');
    for (const bad of [5551234, true, ['a'], {}]) assert.throws(() => canonicalizeValue(bad, { dataType }), /input_type_invalid/, dataType + ' ' + String(bad));
  }
});

test('Text and Binary caps: the largest accepted and first refused values', () => {
  assert.equal(ODC_NATIVE_TEXT_INPUT_CHARS, 1048576); assert.equal(ODC_NATIVE_BINARY_INPUT_BYTES, 786432);
  assert.equal(canonicalizeValue('x'.repeat(1048576), { dataType: 'Text' }).length, 1048576);
  assert.throws(() => canonicalizeValue('x'.repeat(1048577), { dataType: 'Text' }), /input_size_limit/);
  const bytes = n => Buffer.alloc(n, 9).toString('base64');
  assert.equal(canonicalizeValue(bytes(786432), { dataType: 'Binary Data' }), bytes(786432));
  assert.throws(() => canonicalizeValue(bytes(786433), { dataType: 'Binary Data' }), /^Error: debug_odc_native_input_binary_too_large:/);
  assert.throws(() => canonicalizeInputs({ File: bytes(786433) }, [{ name: 'File', dataType: 'Binary Data' }]), /input_binary_too_large/);
  assert.throws(() => canonicalizeValue({ Bytes: bytes(786433) }, { name: 'R', dataType: 'Record', complexType: [{ name: 'Bytes', dataType: 'Binary Data' }] }), /input_binary_too_large/);
});

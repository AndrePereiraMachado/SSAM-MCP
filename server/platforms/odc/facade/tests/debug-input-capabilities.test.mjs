import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inputCapabilities, CLIENT_PRIVATE_READ_BASE64_CHARS } from '../debug-input-capabilities.mjs';
import { canonicalValue, canonicalScenario } from '../debug-o11-native-abi.mjs';
import { canonicalizeValue } from '../debug-odc-native-types.mjs';

test('O11 server and client advertise the SSAM transport caps with their specific refusal codes', () => {
  for (const runtime of ['server', 'client']) {
    const caps = inputCapabilities('o11', runtime);
    assert.equal(caps.schema, 'ssam-debug-input-capabilities/1'); assert.equal(caps.imposedBy, 'ssam');
    assert.deepEqual([caps.lane, caps.runtime], ['o11', runtime]);
    assert.equal(caps.maxBinaryInputBytes, 98301); assert.equal(caps.maxTextBytes, 131070); assert.equal(caps.textUnit, 'utf8-json-bytes');
    assert.equal(caps.maxScenarioInputBytes, 131072); assert.equal(caps.maxRequestEnvelopeBytes, 262144);
    assert.deepEqual(caps.refusalCodes, { binaryTooLarge: 'debug_o11_native_input_binary_too_large', textTooLarge: 'debug_o11_native_input_transport_budget',
      scenarioTooLarge: 'debug_o11_native_input_transport_budget', requestEnvelopeTooLarge: 'debug_o11_native_envelope_invalid',
      identifierBaseUnresolved: 'debug_o11_native_identifier_base_unresolved', recordSchemaUnresolved: 'debug_o11_native_record_schema_unresolved',
      unknownAttribute: 'debug_o11_native_input_unknown_attribute', recordClassMismatch: 'debug_o11_native_record_class_mismatch',
      typeMismatch: 'debug_o11_native_input_type_mismatch', typeUnsupported: 'debug_o11_native_input_type_unsupported' });
    assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps.refusalCodes));
  }
  assert.deepEqual(inputCapabilities('o11', 'client').binaryObservation, { mode: 'private-read-byte-exact', maxBinaryBytes: 1572864,
    maxBase64Chars: 2097152, refusalCode: 'debug_native_client_binary_content_budget' });
  assert.deepEqual(inputCapabilities('o11', 'server').binaryObservation, { mode: 'size-only', limitation: 'native_binary_content_unavailable' });
});

test('ODC advertises the 1 MiB string cap, its Binary equivalent and the 2 MiB client private-read cap', () => {
  const client = inputCapabilities('odc', 'client'), server = inputCapabilities('odc', 'server');
  for (const caps of [client, server]) {
    assert.equal(caps.maxBinaryInputBytes, 786432); assert.equal(caps.maxTextBytes, 1048576); assert.equal(caps.textUnit, 'utf16-code-units');
    assert.equal(caps.maxScenarioInputBytes, null); assert.equal(caps.maxRequestEnvelopeBytes, null);
    assert.equal(caps.refusalCodes.binaryTooLarge, 'debug_odc_native_input_binary_too_large');
    assert.equal(caps.refusalCodes.textTooLarge, 'debug_odc_native_input_size_limit');
    assert.equal(caps.refusalCodes.identifierBaseUnresolved, 'debug_odc_native_input_identifier_base_unresolved');
    assert.equal(caps.refusalCodes.recordUnbound, 'debug_odc_native_input_record_unbound');
  }
  assert.equal(client.binaryObservation.mode, 'private-read-byte-exact'); assert.equal(client.binaryObservation.maxBinaryBytes, 1572864);
  assert.deepEqual(server.binaryObservation, { mode: 'unproved', limitation: 'odc_server_binary_observation_unproved' });
});

test('the advertised caps are exactly the enforced boundaries (largest accepted, first refused)', () => {
  const bytes = n => Buffer.alloc(n, 3).toString('base64');
  const o11 = inputCapabilities('o11', 'server');
  assert.equal(canonicalValue({ base: 'BinaryData' }, bytes(o11.maxBinaryInputBytes)).length > 0, true);
  assert.throws(() => canonicalValue({ base: 'BinaryData' }, bytes(o11.maxBinaryInputBytes + 1)), new RegExp('^Error: ' + o11.refusalCodes.binaryTooLarge + ':'));
  assert.equal(canonicalValue({ base: 'Text' }, 'x'.repeat(o11.maxTextBytes)).length, o11.maxTextBytes);
  assert.throws(() => canonicalValue({ base: 'Text' }, 'x'.repeat(o11.maxTextBytes + 1)), new RegExp('^Error: ' + o11.refusalCodes.textTooLarge + ':'));
  assert.throws(() => canonicalScenario([{ name: 'A', modelType: 'BasicType:Text' }, { name: 'B', modelType: 'BasicType:Text' }],
    { A: 'x'.repeat(70000), B: 'x'.repeat(70000) }), new RegExp('^Error: ' + o11.refusalCodes.scenarioTooLarge + ':inputs$'));
  const odc = inputCapabilities('odc', 'client');
  assert.equal(canonicalizeValue(bytes(odc.maxBinaryInputBytes), { dataType: 'Binary Data' }).length, odc.maxTextBytes);
  assert.throws(() => canonicalizeValue(bytes(odc.maxBinaryInputBytes + 1), { dataType: 'Binary Data' }), new RegExp('^Error: ' + odc.refusalCodes.binaryTooLarge));
  assert.throws(() => canonicalizeValue('x'.repeat(odc.maxTextBytes + 1), { dataType: 'Text' }), new RegExp('^Error: ' + odc.refusalCodes.textTooLarge));
});

test('the private-read budget mirrors the native client inspection, which still enforces it', () => {
  const source = fs.readFileSync(new URL('../debug-native-client-inspection-core.mjs', import.meta.url), 'utf8');
  assert.equal(CLIENT_PRIVATE_READ_BASE64_CHARS, 2 * 1024 * 1024);
  assert.match(source, /if\(content\.length>2\*1024\*1024\)fail\('binary_content_budget'\)/);
  assert.match(source, /const fail = code => \{ throw new Error\('debug_native_client_' \+ code\); \};/);
});

test('unknown lanes or runtimes refuse', () => {
  for (const [lane, runtime] of [['o12', 'server'], ['odc', 'browser'], [undefined, undefined], ['O11', 'server']])
    assert.throws(() => inputCapabilities(lane, runtime), /^Error: debug_input_capabilities_invalid$/);
});

// Input capabilities of the headless debugger for the prepare/status payloads: the SSAM-imposed size caps (not OutSystems
// limits) per lane and runtime, with the exact refusal code each one raises. Every number is the constant the
// canonicalizer or worker enforces; nothing here raises a cap.
import { O11_NATIVE_INPUT_BYTES, O11_NATIVE_ENVELOPE_BYTES, O11_NATIVE_BINARY_INPUT_BYTES } from './debug-o11-native-abi.mjs';
import { ODC_NATIVE_TEXT_INPUT_CHARS, ODC_NATIVE_BINARY_INPUT_BYTES } from './debug-odc-native-types.mjs';

// Client private-read of BinaryData content (debug-native-client-inspection-core.mjs: content.length > 2 MiB of base64
// fails 'binary_content_budget'). Server frames render BinaryData as a byte count only (native limit).
export const CLIENT_PRIVATE_READ_BASE64_CHARS = 2 * 1024 * 1024;
const PRIVATE_READ = Object.freeze({ mode: 'private-read-byte-exact', maxBinaryBytes: CLIENT_PRIVATE_READ_BASE64_CHARS / 4 * 3,
  maxBase64Chars: CLIENT_PRIVATE_READ_BASE64_CHARS, refusalCode: 'debug_native_client_binary_content_budget' });
const O11_CODES = Object.freeze({ binaryTooLarge: 'debug_o11_native_input_binary_too_large', textTooLarge: 'debug_o11_native_input_transport_budget',
  scenarioTooLarge: 'debug_o11_native_input_transport_budget', requestEnvelopeTooLarge: 'debug_o11_native_envelope_invalid',
  identifierBaseUnresolved: 'debug_o11_native_identifier_base_unresolved', recordSchemaUnresolved: 'debug_o11_native_record_schema_unresolved',
  unknownAttribute: 'debug_o11_native_input_unknown_attribute', recordClassMismatch: 'debug_o11_native_record_class_mismatch',
  typeMismatch: 'debug_o11_native_input_type_mismatch', typeUnsupported: 'debug_o11_native_input_type_unsupported' });
const ODC_CODES = Object.freeze({ binaryTooLarge: 'debug_odc_native_input_binary_too_large', textTooLarge: 'debug_odc_native_input_size_limit',
  identifierBaseUnresolved: 'debug_odc_native_input_identifier_base_unresolved', recordUnbound: 'debug_odc_native_input_record_unbound',
  unknownAttribute: 'debug_odc_native_input_unknown_attribute', typeMismatch: 'debug_odc_native_input_type_invalid',
  typeUnsupported: 'debug_odc_native_input_type_unsupported' });

// inputCapabilities('o11'|'odc', 'server'|'client') -> frozen { maxBinaryInputBytes, maxTextBytes, refusalCodes, ... }.
// O11: one value's JSON <= 128 KiB (Text counts UTF-8 JSON bytes, escapes included); a scenario's whole inputs share that
// budget (a value named N adds N.length + 7 bytes); each POST the original runtime builds is <= 256 KiB.
// ODC: one string <= 1 MiB of UTF-16 code units; Binary Data is that string in base64.
export function inputCapabilities(lane, runtime) {
  if (!['o11', 'odc'].includes(lane) || !['server', 'client'].includes(runtime)) throw new Error('debug_input_capabilities_invalid');
  const binaryObservation = runtime === 'client' ? PRIVATE_READ : lane === 'o11'
    ? Object.freeze({ mode: 'size-only', limitation: 'native_binary_content_unavailable' })
    : Object.freeze({ mode: 'unproved', limitation: 'odc_server_binary_observation_unproved' });
  return Object.freeze(lane === 'o11'
    ? { schema: 'ssam-debug-input-capabilities/1', lane, runtime, imposedBy: 'ssam', maxBinaryInputBytes: O11_NATIVE_BINARY_INPUT_BYTES,
        maxTextBytes: O11_NATIVE_INPUT_BYTES - 2, textUnit: 'utf8-json-bytes', maxScenarioInputBytes: O11_NATIVE_INPUT_BYTES,
        maxRequestEnvelopeBytes: O11_NATIVE_ENVELOPE_BYTES, binaryObservation, refusalCodes: O11_CODES }
    : { schema: 'ssam-debug-input-capabilities/1', lane, runtime, imposedBy: 'ssam', maxBinaryInputBytes: ODC_NATIVE_BINARY_INPUT_BYTES,
        maxTextBytes: ODC_NATIVE_TEXT_INPUT_CHARS, textUnit: 'utf16-code-units', maxScenarioInputBytes: null,
        maxRequestEnvelopeBytes: null, binaryObservation, refusalCodes: ODC_CODES });
}

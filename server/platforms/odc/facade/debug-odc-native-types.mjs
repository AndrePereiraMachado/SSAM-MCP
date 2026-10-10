// Typed scenario inputs for the ODC native-entry debugger. Validation and canonicalization happen here, offline, in
// prepare (before any login or send). The worker turns the canonical form into native runtime records; this module
// never imports app code. Output decoding is the inverse: LongInteger/Decimal come back as strings, private values
// filtered by the caller. Binary is refused in this surface.
const fail = (code, detail) => { throw new Error('debug_odc_native_' + code + (detail ? ':' + detail : '')); };
const PRIVATE = /password|credential|authorization|cookie|token|secret/i;

// OutSystems data-type kinds this surface accepts, with the JSON it accepts and the canonical value it stores.
// 'canonical' is JSON-safe (numbers stay numbers, Long/Decimal/Identifier-as-string stay strings) so a scenario
// round-trips through a receipt without precision loss.
const INT32_MIN = -2147483648, INT32_MAX = 2147483647;
const isInt = v => typeof v === 'number' && Number.isInteger(v);

const SCALARS = {
  Text: v => typeof v === 'string' ? v : fail('input_type_invalid', 'Text expects string'),
  Email: v => typeof v === 'string' ? v : fail('input_type_invalid', 'Email expects string'),
  'Phone Number': v => typeof v === 'string' ? v : fail('input_type_invalid', 'Phone expects string'),
  Boolean: v => typeof v === 'boolean' ? v : fail('input_type_invalid', 'Boolean expects true/false'),
  Integer: v => isInt(v) && v >= INT32_MIN && v <= INT32_MAX ? v : fail('input_type_invalid', 'Integer out of Int32 range'),
  'Long Integer': v => typeof v === 'string' && /^-?\d{1,19}$/.test(v) ? v : isInt(v) ? String(v) : fail('input_type_invalid', 'Long Integer expects an integer string'),
  Decimal: v => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? v : (typeof v === 'number' && Number.isFinite(v)) ? String(v) : fail('input_type_invalid', 'Decimal expects a decimal string'),
  Currency: v => SCALARS.Decimal(v),
  Date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fail('input_type_invalid', 'Date expects YYYY-MM-DD'),
  Time: v => typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v) ? v : fail('input_type_invalid', 'Time expects HH:mm[:ss]'),
  'Date Time': v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(v) ? v : fail('input_type_invalid', 'Date Time expects ISO 8601'),
};
// Identifier maps to the underlying key type; accept both text and integer identifiers as strings.
const identifier = v => (typeof v === 'string' && v.length <= 200) ? v : isInt(v) ? String(v) : fail('input_type_invalid', 'Identifier expects a string');

// Canonicalize one value against a declared field: { name, dataType, mandatory, complexType? } (complexType carries
// the structure's fields for Record / RecordList).
export function canonicalizeValue(value, field) {
  if (value === null || value === undefined) {
    if (field.mandatory) fail('input_mandatory_missing', field.name);
    return null;
  }
  const dt = field.dataType;
  if (dt === 'Binary Data' || dt === 'Binary') fail('input_type_unsupported', 'Binary not supported in native-entry');
  if (dt in SCALARS) return SCALARS[dt](value);
  if (/^Identifier/.test(dt) || dt === 'Identifier') return identifier(value);
  if (dt === 'Record' || dt === 'Structure') {
    if (typeof value !== 'object' || Array.isArray(value)) fail('input_type_invalid', 'Record expects an object');
    return canonicalizeRecord(value, field.complexType ?? field.fields ?? []);
  }
  if (dt === 'RecordList' || dt === 'List') {
    if (!Array.isArray(value)) fail('input_type_invalid', 'RecordList expects an array');
    return value.map(item => canonicalizeRecord(item, field.complexType ?? field.fields ?? []));
  }
  fail('input_type_unsupported', dt);
}

function canonicalizeRecord(value, fields) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('input_type_invalid', 'Record expects an object');
  const byName = new Map((fields ?? []).map(f => [f.name, f]));
  for (const key of Object.keys(value)) {
    if (PRIVATE.test(key)) fail('input_private_name', key);
    if (fields?.length && !byName.has(key)) fail('input_unknown_attribute', key);
  }
  const out = {};
  for (const f of fields ?? []) out[f.name] = canonicalizeValue(value[f.name], f);
  if (!fields?.length) for (const [k, v] of Object.entries(value)) out[k] = v; // unknown structure: pass through scalars
  return out;
}

// Validate a whole scenario's inputs against an ordered signature [{ name, dataType, mandatory, complexType? }].
// Returns the canonical inputs. Unknown keys, private names, wrong types and out-of-range all fail here, in prepare.
export function canonicalizeInputs(inputs, signature) {
  if (inputs === null || inputs === undefined) inputs = {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) fail('input_type_invalid', 'inputs must be an object');
  const byName = new Map(signature.map(f => [f.name, f]));
  for (const key of Object.keys(inputs)) {
    if (PRIVATE.test(key)) fail('input_private_name', key);
    if (!byName.has(key)) fail('input_unknown', key);
  }
  const canonical = {};
  for (const field of signature) {
    const present = Object.prototype.hasOwnProperty.call(inputs, field.name);
    if (!present) { if (field.mandatory) fail('input_mandatory_missing', field.name); canonical[field.name] = { omitted: true }; continue; }
    canonical[field.name] = { value: canonicalizeValue(inputs[field.name], field) };
  }
  return canonical;
}

// Decode a runtime output value back to a JSON-safe form. Long/Decimal -> string; Date/Time/DateTime -> string.
export function decodeOutput(value, dataType) {
  if (value === null || value === undefined) return null;
  if (dataType === 'LongInteger' || dataType === 'Long Integer' || dataType === 'Decimal' || dataType === 'Currency') return String(value);
  return value;
}

export const SUPPORTED_INPUT_TYPES = Object.freeze([...Object.keys(SCALARS), 'Identifier', 'Record', 'RecordList']);

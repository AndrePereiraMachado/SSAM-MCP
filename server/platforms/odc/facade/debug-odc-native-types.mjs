// Typed scenario inputs for the ODC native-entry debugger. Validation and canonicalization happen here, offline, in
// prepare (before any login or send). The worker turns the canonical form into native runtime records; this module
// never imports app code. Output decoding is the inverse: LongInteger/Decimal come back as strings, private values
// filtered by the caller. Binary inputs use canonical base64 for the native converter.
const fail = (code, detail) => { throw new Error('debug_odc_native_' + code + (detail ? ':' + detail : '')); };
const PRIVATE = /password|credential|authorization|cookie|token|secret/i;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
// SSAM caps, not ODC limits: one string value (Text, or Binary Data as base64) is at most 1 MiB of UTF-16 code units.
export const ODC_NATIVE_TEXT_INPUT_CHARS = 1048576;
export const ODC_NATIVE_BINARY_INPUT_BYTES = ODC_NATIVE_TEXT_INPUT_CHARS / 4 * 3;
// Native Decimal: a 96-bit mantissa with scale 0..28 (.NET System.Decimal; the client runtime's MIN/MAX_DECIMAL_VALUE are -/+(2^96-1)).
export const ODC_NATIVE_DECIMAL_MAX_SCALE = 28;
const DECIMAL_MAX_MANTISSA = 2n ** 96n - 1n;
function safeJson(value, depth = 0, count = { n: 0 }) {
  if (depth > 16 || ++count.n > 10000) fail('input_size_limit');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (RESERVED.has(key) || PRIVATE.test(key)) fail('input_private_name', key);
    safeJson(child, depth + 1, count);
  }
}
const text = label => v => typeof v !== 'string' ? fail('input_type_invalid', label + ' expects string')
  : v.length > ODC_NATIVE_TEXT_INPUT_CHARS ? fail('input_size_limit', label + ' exceeds ' + ODC_NATIVE_TEXT_INPUT_CHARS + ' characters') : v;
function longInteger(v) {
  const s = typeof v === 'string' ? v : Number.isSafeInteger(v) ? String(v) : '';
  if (!/^-?\d{1,19}$/.test(s) || BigInt(s) < -9223372036854775808n || BigInt(s) > 9223372036854775807n) fail('input_type_invalid', 'Long Integer out of Int64 range');
  return BigInt(s).toString();
}
// Same canonical form as O11 (no leading zeros, no trailing fractional zeros, no "-0"), bounded by the native Decimal.
function decimal(v, label = 'Decimal') {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  if (typeof s !== 'string' || s.length > 80 || !/^-?\d+(\.\d+)?$/.test(s)) fail('input_type_invalid', label + ' expects a decimal string');
  const [int, frac = ''] = s.replace(/^-/, '').split('.'), whole = int.replace(/^0+(?=\d)/, ''), fraction = frac.replace(/0+$/, '');
  if (fraction.length > ODC_NATIVE_DECIMAL_MAX_SCALE || BigInt(whole + fraction) > DECIMAL_MAX_MANTISSA) fail('input_type_invalid', label + ' outside the native Decimal range');
  const normalized = (s.startsWith('-') ? '-' : '') + whole + (fraction ? '.' + fraction : '');
  return normalized === '-0' ? '0' : normalized;
}
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.slice(0,4) === '0000') fail('input_type_invalid', 'Date expects YYYY-MM-DD');
  const parsed = new Date(v + 'T00:00:00Z');
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== v) fail('input_type_invalid', 'Invalid calendar date');
  return v;
}
function time(v) {
  if (typeof v !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(v)) fail('input_type_invalid', 'Time expects HH:mm[:ss]');
  return v;
}
// An explicit Z or offset is required (a zoneless value is ambiguous); the canonical value is UTC, as in O11.
function dateTime(v) {
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(v) : null;
  if (!m) fail('input_type_invalid', 'Date Time expects ISO 8601 with Z or an explicit offset');
  date(m[1]); time(m[2]);
  const utc = new Date(v).toISOString();
  if (utc.slice(0, 4) === '0000' || utc.startsWith('-')) fail('input_type_invalid', 'Date Time before year 1');
  return utc.replace(/\.000Z$/, 'Z');
}

// OutSystems data-type kinds this surface accepts, with the JSON it accepts and the canonical value it stores.
// 'canonical' is JSON-safe (numbers stay numbers, Long/Decimal/Identifier-as-string stay strings) so a scenario
// round-trips through a receipt without precision loss.
const INT32_MIN = -2147483648, INT32_MAX = 2147483647;
const isInt = v => typeof v === 'number' && Number.isInteger(v);
function binary(v) {
  if (typeof v !== 'string') fail('input_type_invalid', 'Binary Data expects canonical base64');
  const padding = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0;
  if (Math.floor(v.length * 3 / 4) - padding > ODC_NATIVE_BINARY_INPUT_BYTES) fail('input_binary_too_large', 'Binary Data exceeds ' + ODC_NATIVE_BINARY_INPUT_BYTES + ' bytes');
  if (v.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || Buffer.from(v, 'base64').toString('base64') !== v)
    fail('input_type_invalid', 'Binary Data expects canonical base64');
  return v;
}

const SCALARS = {
  Text: text('Text'),
  Email: text('Email'), // Email and Phone Number are Text on the wire
  'Phone Number': text('Phone'),
  PhoneNumber: text('Phone'),
  Boolean: v => typeof v === 'boolean' ? v : fail('input_type_invalid', 'Boolean expects true/false'),
  Integer: v => isInt(v) && v >= INT32_MIN && v <= INT32_MAX ? v : fail('input_type_invalid', 'Integer out of Int32 range'),
  'Long Integer': longInteger,
  LongInteger: longInteger,
  Decimal: v => decimal(v),
  Currency: v => decimal(v, 'Currency'),
  Date: date,
  Time: time,
  'Date Time': dateTime,
  DateTime: dateTime,
  'Binary Data': binary,
  BinaryData: binary,
  Binary: binary,
};
// An identifier is canonicalized by its runtime base (the entity Id type) carried in the signature as identifierBase or
// runtimeDataType, or named by a basic identifier type ("Text Identifier"). Without a base, native-entry inputs
// (strictIdentifiers) refuse; other callers keep the historical untyped identifier string.
const IDENTIFIER_BASES = { LongInteger: 'Long Integer', 'Long Integer': 'Long Integer', Integer: 'Integer', Text: 'Text' };
const identifierBase = field => IDENTIFIER_BASES[field.identifierBase ?? field.runtimeDataType ??
  /^(Long ?Integer|Integer|Text) ?Identifier$/.exec(field.dataType ?? '')?.[1]] ?? null;
function identifier(v, field, options) {
  const base = identifierBase(field);
  if (base === 'Text') return typeof v === 'string' && v.length <= 200 ? v : fail('input_type_invalid', 'Text Identifier expects a string of at most 200 characters');
  if (base) return SCALARS[base](v);
  if (options.strictIdentifiers) fail('input_identifier_base_unresolved', field.name);
  return (typeof v === 'string' && v.length <= 200) ? v : Number.isSafeInteger(v) ? String(v) : fail('input_type_invalid', 'Identifier expects a string');
}

// Canonicalize one value against a declared field: { name, dataType, mandatory, complexType? } (complexType carries
// the structure's fields for Record / RecordList; elementType the item of a basic-type list).
export function canonicalizeValue(value, field, options = {}) {
  safeJson(value);
  if (value === null || value === undefined) {
    if (field.mandatory) fail('input_mandatory_missing', field.name);
    return null;
  }
  const dt = field.dataType;
  if (dt in SCALARS) return SCALARS[dt](value);
  if (/^Identifier|Identifier$/.test(dt)) return identifier(value, field, options);
  if (dt === 'Record' || dt === 'Structure') {
    if (typeof value !== 'object' || Array.isArray(value)) fail('input_type_invalid', 'Record expects an object');
    return canonicalizeRecord(value, field.complexType ?? field.fields, field.name, options);
  }
  if (dt === 'RecordList' || dt === 'List') {
    if (!Array.isArray(value)) fail('input_type_invalid', 'RecordList expects an array');
    if (field.elementType && !['Record', 'Structure'].includes(field.elementType.dataType))
      return value.map(item => item === null || item === undefined ? fail('input_type_invalid', 'List items cannot be null') : canonicalizeValue(item, field.elementType, options));
    const fields = field.complexType ?? field.fields;
    if (!fields?.length) fail('input_record_unbound', field.name);
    return value.map(item => canonicalizeRecord(item, fields, field.name, options));
  }
  fail('input_type_unsupported', dt);
}

// A record is typed only by the attributes bound from its runtime record class; an unbound structure refuses.
function canonicalizeRecord(value, fields, name, options) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('input_type_invalid', 'Record expects an object');
  if (!fields?.length) fail('input_record_unbound', name);
  const byName = new Map(fields.map(f => [f.name, f]));
  for (const key of Object.keys(value)) {
    if (PRIVATE.test(key)) fail('input_private_name', key);
    if (!byName.has(key)) fail('input_unknown_attribute', key);
  }
  const out = {};
  for (const f of fields) out[f.name] = canonicalizeValue(value[f.name], f, options);
  return out;
}

// Validate a whole scenario's inputs against an ordered signature [{ name, dataType, mandatory, complexType? }].
// Returns the canonical inputs. Unknown keys, private names, wrong types and out-of-range all fail here, in prepare.
// options.strictIdentifiers: identifiers without a runtime base refuse (native-entry scenarios).
export function canonicalizeInputs(inputs, signature, options = {}) {
  if (inputs === null || inputs === undefined) inputs = {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) fail('input_type_invalid', 'inputs must be an object');
  safeJson(inputs);
  const byName = new Map(signature.map(f => [f.name, f]));
  for (const key of Object.keys(inputs)) {
    if (PRIVATE.test(key)) fail('input_private_name', key);
    if (!byName.has(key)) fail('input_unknown', key);
  }
  const canonical = {};
  for (const field of signature) {
    const present = Object.prototype.hasOwnProperty.call(inputs, field.name);
    if (!present) { if (field.mandatory) fail('input_mandatory_missing', field.name); canonical[field.name] = { omitted: true }; continue; }
    canonical[field.name] = { value: canonicalizeValue(inputs[field.name], field, options) };
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

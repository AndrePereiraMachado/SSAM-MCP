import { createHash } from 'node:crypto';
export const sensitive = /password|passwd|secret|token|authorization|cookie|credential|api.?key|client.?id|username|headers/i;
const privateField = /email|phone|firstname|lastname|fullname|logo|image|pdf|binary/i;
export const fail = code => { throw new Error(code); };
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parts(pointer) {
  const result = pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!pointer.startsWith('/') || result.some(s => !s || ['__proto__', 'prototype', 'constructor'].includes(s))) fail('invoke_invalid_pointer');
  return result;
}
export function at(value, pointer) {
  for (const key of parts(pointer)) { if (!value || !Object.hasOwn(value, key)) fail('invoke_parameter_missing'); value = value[key]; }
  return value;
}
export function typeOf(value, depth = 0) {
  if (depth > 12) fail('invoke_type_depth');
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) { if (value.length > 1000) fail('invoke_list_limit'); return { type: 'array', items: value.length ? typeOf(value[0], depth + 1) : null }; }
  if (typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeOf(v, depth + 1)])) };
  if (typeof value === 'number') { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('invoke_unsafe_number'); return { type: Number.isInteger(value) ? 'integer' : 'number' }; }
  if (typeof value === 'string') return { type: /^-?\d+(?:\.\d+)?$/.test(value) ? 'numeric-string' : 'string' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  fail('invoke_invalid_value');
}
export function validateValue(value, schema, depth = 0) {
  if (depth > 12) fail('invoke_type_depth');
  if (value === null) { if (schema.type !== 'null') fail('invoke_parameter_type'); return value; }
  if (schema.type === 'numeric-string') {
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) value = String(value);
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) fail('invoke_parameter_type');
  } else if (schema.type === 'integer') { if (!Number.isSafeInteger(value)) fail('invoke_parameter_type'); }
  else if (schema.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) fail('invoke_parameter_type'); }
  else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 1000 || (!schema.items && value.length)) fail('invoke_parameter_type');
    value = value.map(v => validateValue(v, schema.items, depth + 1));
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(schema.properties).length) fail('invoke_parameter_type');
    value = Object.fromEntries(Object.entries(schema.properties).map(([key, type]) => { if (!Object.hasOwn(value, key) || sensitive.test(key)) fail('invoke_secret_or_missing_input'); return [key, validateValue(value[key], type, depth + 1)]; }));
  } else if (typeof value !== schema.type) fail('invoke_parameter_type');
  if (typeof value === 'string' && (value.length > 8192 || /bearer\s|basic\s|eyJ[A-Za-z0-9_-]+\./i.test(value))) fail('invoke_secret_or_large_input');
  return value;
}
export function validateInputs(inputs, parameters) {
  if (Buffer.byteLength(JSON.stringify(inputs)) > 65536) fail('invoke_input_limit');
  const result = {};
  for (const [pointer, value] of Object.entries(inputs)) {
    if (sensitive.test(pointer)) fail('invoke_secret_input');
    parts(pointer);
    const parameter = parameters.find(p => p.path === pointer);
    if (!parameter) fail('invoke_unknown_input');
    result[pointer] = validateValue(value, parameter.schema);
  }
  return result;
}
export function describeParameters(body, paths, discovery = null) {
  const result = [];
  const add = (value, pointer, depth) => {
    if (sensitive.test(pointer) || privateField.test(pointer)) return;
    if (depth > 12 || result.length >= 100) {
      if (!discovery) fail('invoke_parameter_discovery_limit: supply explicit inputPaths');
      discovery.complete = false; discovery.continuation = 'Specify inputPaths to inspect selected fields without the automatic inventory limit'; return;
    }
    if (value !== null && typeof value === 'object') {
      // Screen state often carries large derived carrier lists; only scalar overrides are auto-discovered.
      if (Array.isArray(value.List)) return; // Native list wrapper includes an EmptyListItem template, not an input value.
      if (!Array.isArray(value)) for (const [k, v] of Object.entries(value)) add(v, pointer + '/' + k.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1);
    } else result.push({ path: pointer, schema: typeOf(value), ...(['number', 'boolean'].includes(typeof value) || /^-?\d+(?:\.\d+)?$/.test(String(value)) ? { observedValue: value } : {}) });
  };
  if (paths.length) for (const pointer of paths) {
    parts(pointer); if (sensitive.test(pointer) || /^\/(versionInfo|viewName)(\/|$)/.test(pointer)) fail('invoke_protected_input');
    result.push({ path: pointer, schema: typeOf(at(body, pointer)) });
  } else {
    if (body.inputParameters) add(body.inputParameters, '/inputParameters', 0);
    else if (body.screenData?.variables) add(body.screenData.variables, '/screenData/variables', 0);
    if (body.clientVariables) add(body.clientVariables, '/clientVariables', 0);
  }
  for (const a of result) for (const b of result) if (a !== b && b.path.startsWith(a.path + '/')) fail('invoke_overlapping_inputs');
  return result;
}
const readableText = /^(?:status|statuscode|success|code|errorcode|product|prdct|company|branch|description|descx|message|errormessage|error|detail|title|reason|field|path|floodzone|quotenumber|completequotenumber|address|city|state|zip|zipcode|messagetype|messageid|messagedescription)$/i;
export function filterOutput(value, name = '', depth = 0) {
  if (sensitive.test(name) || privateField.test(name)) return '[redacted]';
  if (depth > 12) return '[depth limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(v => filterOutput(v, name, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, filterOutput(v, k, depth + 1)]));
  if (typeof value !== 'string') return '[redacted]';
  if (/bearer\s|basic\s|eyJ[A-Za-z0-9_-]+\.|(?:password|secret|token|authorization)\s*[:=]/i.test(value)) return '[redacted]';
  return (/^-?\d+(?:\.\d+)?$/.test(value) || readableText.test(name)) ? value.slice(0, 512) : '[redacted]';
}

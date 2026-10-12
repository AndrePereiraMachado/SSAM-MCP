// Published REST entry adapter. The model selects the URL, verb and wire names;
// the published OpenAPI supplies its serialization contract. Neither an arbitrary
// URL nor a caller-supplied Authorization header is an execution surface.
import { createHash } from 'node:crypto';
import { nativeCustomAuthenticationContract, readBasicAuthenticationContract, readRequestHeaderGuard } from './debug-native-endpoint-custom.mjs';

const fail = code => { throw new Error('debug_native_endpoint_' + code); };
const KEY = /^[A-Za-z0-9_+]{22}$/, SHA = /^[a-f0-9]{64}$/i;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PRIVATE = /password|authorization|cookie|credential|token|secret/i;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Decimal/Currency and identifiers arrive from the native canonicalizer as
// strings. Keep their value exact; converting them through Number first would
// round both request tokens and comparisons against OpenAPI limits.
function decimalParts(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!text || text.length > 512) fail('input_number_invalid');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,4}))?$/.exec(text);
  if (!match || match[2].length + (match[3]?.length ?? 0) > 256) fail('input_number_invalid');
  const power = Number(match[4] ?? 0);
  if (Math.abs(power) > 1024) fail('input_number_invalid');
  const integer = match[2].replace(/^0+(?=\d)/, ''), fraction = match[3] ?? '';
  let digits = (integer + fraction).replace(/^0+/, ''), exponent = power - fraction.length;
  if (!digits) return { coefficient: 0n, exponent: 0, wire: match[1] + '0' + (fraction ? '.' + fraction : '') + (power ? 'e' + power : '') };
  const zeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (zeros) { digits = digits.slice(0, -zeros); exponent += zeros; }
  return { coefficient: BigInt(match[1] + digits), exponent,
    wire: match[1] + integer + (fraction ? '.' + fraction : '') + (power ? 'e' + power : '') };
}

function compareDecimal(left, right) {
  const a = decimalParts(left), b = decimalParts(right), exponent = Math.min(a.exponent, b.exponent);
  const x = a.coefficient * 10n ** BigInt(a.exponent - exponent), y = b.coefficient * 10n ** BigInt(b.exponent - exponent);
  return x < y ? -1 : x > y ? 1 : 0;
}

function losslessNumbers(key, value, context) {
  if (typeof value !== 'number') return value;
  const token = context?.source;
  if (typeof token !== 'string') {
    if (!Number.isSafeInteger(value)) fail('lossless_json_runtime_required');
    return value;
  }
  // Preserve exact source for a rounded decimal, under/overflow, or an unsafe
  // integer. Small decimals whose native JSON spelling round-trips stay numbers.
  if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) return decimalParts(token).wire;
  return compareDecimal(token, String(value)) === 0 ? value : decimalParts(token).wire;
}

function bounded(value, depth = 0, count = { n: 0 }) {
  if (depth > 24 || ++count.n > 50000) fail('contract_size_limit');
  if (typeof value === 'string' && value.length > 1048576) fail('contract_size_limit');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) fail('contract_key_invalid'); bounded(child, depth + 1, count);
  }
}

export function nativeEndpointBinding(binding) {
  let url; try { url = new URL(binding?.runtimeUrl); } catch { fail('binding_invalid'); }
  if (!['o11', 'odc'].includes(binding?.lane) || !KEY.test(binding.moduleKey ?? '') ||
      !/^[A-Za-z_]\w*$/.test(binding.module ?? '') || !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
      !SHA.test(binding.sourceSha256 ?? '') || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' + binding.module + '/') fail('binding_invalid');
  return { lane: binding.lane, runtimeUrl: url.href, module: binding.module, moduleKey: binding.moduleKey,
    revision: binding.revision, sourceSha256: binding.sourceSha256.toLowerCase() };
}

function scopedUrl(value, binding, base = binding.runtimeUrl) {
  let url; try { url = new URL(value, base); } catch { fail('url_invalid'); }
  const app = new URL(binding.runtimeUrl);
  if (url.protocol !== 'https:' || url.origin !== app.origin || !url.pathname.startsWith(app.pathname) ||
      url.username || url.password || url.hash || /%(?:2e|2f|5c)/i.test(url.pathname) || /[\\\x00-\x20]/.test(value)) fail('url_outside_publication');
  return url;
}

function readingSource(source, binding) {
  if (!object(source) || typeof source.body !== 'string' || Buffer.byteLength(source.body) > 8 * 1024 * 1024 ||
      !SHA.test(source.sha256 ?? '') || digest(source.body) !== source.sha256.toLowerCase()) fail('source_changed');
  const url = scopedUrl(source.url, binding);
  if (url.search && !/^\?(?:swagger|wsdl)$/i.test(url.search)) fail('source_url_invalid');
  let document; try { document = JSON.parse(source.body, losslessNumbers); } catch { fail('openapi_invalid'); }
  bounded(document); return { document, url: url.href, sha256: source.sha256.toLowerCase() };
}

function resolveRef(document, value, chain = []) {
  if (!object(value)) fail('schema_invalid');
  if (!value.$ref) return value;
  if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/') || chain.includes(value.$ref) || chain.length > 20) fail('reference_unsupported');
  let target = document;
  for (const part of value.$ref.slice(2).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (FORBIDDEN.has(part) || !object(target) || !own(target, part)) fail('reference_unresolved'); target = target[part];
  }
  return resolveRef(document, target, [...chain, value.$ref]);
}

function schemaOf(document, source, chain = []) {
  if (!object(source)) fail('schema_invalid');
  const schema = resolveRef(document, source);
  if (chain.includes(schema) || chain.length > 20) fail('recursive_schema_unsupported');
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.not || schema.discriminator || schema.xml) fail('schema_variant_unsupported');
  const type = schema.type ?? (schema.properties ? 'object' : null);
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(type)) fail('schema_type_unsupported');
  const result = { type, ...(schema.format ? { format: schema.format } : {}), nullable: schema.nullable === true || schema['x-nullable'] === true };
  for (const key of ['enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[key] !== undefined) result[key] = schema[key];
  if (schema.pattern !== undefined) fail('schema_pattern_unsupported'); // Never execute untrusted regular expressions.
  if (type === 'object') {
    result.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, schemaOf(document, value, [...chain, schema])]));
    result.required = schema.required ?? [];
    if (!Array.isArray(result.required) || result.required.some(key => !own(result.properties, key))) fail('schema_required_invalid');
    // Unspecified additional properties are allowed by OpenAPI, but the native
    // model has a fixed structure. An explicit map schema needs its own adapter.
    if (schema.additionalProperties && schema.additionalProperties !== false) fail('schema_map_unsupported');
  } else if (type === 'array') result.items = schemaOf(document, schema.items, [...chain, schema]);
  return result;
}

function complete(node) {
  if (!object(node) || !Array.isArray(node.children) || node.childrenOmitted !== 0 ||
      node.childrenTotal !== node.children.length || Object.keys(node.propertyErrors ?? {}).length ||
      Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail('model_incomplete');
  for (const child of node.children) complete(child);
}

function originalRestModel(model, binding, entryKey) {
  if (model?.schema !== 'ssam-reading/1' || model.sourceSha256?.toLowerCase() !== binding.sourceSha256 ||
      model.model !== binding.module || model.tree?.kind !== 'RestService') fail('model_binding_invalid');
  complete(model.tree);
  const service = model.tree, actions = service.children.filter(node => node.kind === 'RestServiceAction' && node.key === entryKey);
  if (!KEY.test(service.key ?? '') || !KEY.test(entryKey ?? '') || actions.length !== 1) fail('model_entry_unresolved');
  const action = actions[0], method = action.properties?.HTTPMethod;
  // Authentication outside None/Basic/Custom compiles so the capability can refuse it with a typed code.
  if (!METHODS.has(method) || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(service.properties?.Authentication ?? '')) fail('model_protocol_unsupported');
  // Transport as the model states it (PX01 enum names); refused by the capability, CrossSiteRequests recorded only.
  const flows = service.children.filter(node => node.kind === 'RestServiceAuthenticationFlow'), types = flows.map(node => node.properties?.AuthenticationCallbackType ?? null);
  const transport = { internalAccess: service.properties.InternalAccess ?? null, httpSecurity: service.properties.HttpSecurity ?? null,
    crossSiteRequests: service.properties.CrossSiteRequests ?? null,
    authenticationCallbackType: types.includes('OAuth2') ? 'OAuth2' : types.length === 1 ? types[0] : null };
  // URL is a native getter, not a URL assembled from a display name. Some SDKs
  // provide it only on the service plus the action's URLPath.
  const direct = action.properties?.URL;
  const base = service.properties?.URL;
  let entryUrl;
  if (direct) entryUrl = scopedUrl(direct, binding);
  else if (base && typeof action.properties?.URLPath === 'string') {
    const baseUrl = scopedUrl(base, binding);
    entryUrl = scopedUrl(baseUrl.href.replace(/\/$/, '') + '/' + action.properties.URLPath.replace(/^\//, ''), binding);
  } else fail('model_url_unavailable');
  if (entryUrl.search) fail('model_url_invalid');
  const parameter = (node, input) => {
    const p = node.properties ?? {}, where = p[input ? 'ReceiveIn' : 'SendIn'];
    if (!['URL', 'Header', 'Body'].includes(where) || PRIVATE.test(node.name ?? '') || p.IsSensitive === 'Sensitive') fail('private_or_unknown_parameter');
    return { name: node.name, wireName: p[input ? 'ReceiveAs' : 'SendAs'] || node.name, where,
      required: p.IsMandatory === 'True', modelType: p.DataType ?? null };
  };
  return { serviceKey: service.key, entryKey, name: action.name, method, url: entryUrl.href,
    authentication: service.properties.Authentication, transport,
    inputs: action.children.filter(node => ['RestServiceActionInput', 'InputParameter'].includes(node.kind)).map(node => parameter(node, true)),
    outputs: action.children.filter(node => ['RestServiceActionOutput', 'OutputParameter'].includes(node.kind)).map(node => parameter(node, false)) };
}

function serverUrl(document, pathItem, operation, binding, sourceUrl) {
  if (document.swagger === '2.0') {
    if (document.schemes && !document.schemes.includes('https')) fail('https_required');
    const host = document.host ?? new URL(sourceUrl).host;
    return scopedUrl('https://' + host + (document.basePath ?? '/'), binding);
  }
  if (!/^3\.0\.\d+$/.test(document.openapi ?? '')) fail('openapi_version_unsupported');
  const servers = operation.servers ?? pathItem.servers ?? document.servers;
  if (!Array.isArray(servers) || servers.length !== 1 || typeof servers[0].url !== 'string' || servers[0].variables || /[{}]/.test(servers[0].url)) fail('openapi_server_ambiguous');
  return scopedUrl(servers[0].url, binding, sourceUrl);
}

function jsonMedia(content) {
  if (!object(content)) fail('content_type_unsupported');
  const found = Object.keys(content).filter(key => key === 'application/json');
  if (found.length !== 1) fail('content_type_unsupported'); return content[found[0]].schema;
}

// Use the RestService subtree (including its actions and parameters) from the
// SAME published capture used to resolve the call graph. No operationId override.
export function compileNativeRestEndpoint({ binding: inputBinding, model, entryKey, source }) {
  const binding = nativeEndpointBinding(inputBinding), native = originalRestModel(model, binding, entryKey);
  const captured = readingSource(source, binding), { document } = captured, candidates = [];
  for (const [route, pathItemSource] of Object.entries(document.paths ?? {})) {
    if (!route.startsWith('/') || route.includes('?') || route.includes('#')) fail('openapi_path_invalid');
    const pathItem = resolveRef(document, pathItemSource), operation = pathItem[native.method.toLowerCase()];
    if (!operation) continue;
    const server = serverUrl(document, pathItem, operation, binding, captured.url);
    const url = scopedUrl(server.href.replace(/\/$/, '') + route, binding);
    if (url.href === native.url) candidates.push({ operation, pathItem, url: url.href });
  }
  if (candidates.length !== 1) fail('model_openapi_route_mismatch');
  const { operation, pathItem, url } = candidates[0];
  const security = operation.security ?? document.security ?? [];
  if (!Array.isArray(security)) fail('security_contract_invalid');
  const schemes = document.securityDefinitions ?? document.components?.securitySchemes ?? {};
  const basic = security.length === 1 && object(security[0]) && Object.keys(security[0]).length === 1 &&
    Object.values(security[0])[0]?.length === 0 && (() => {
      const declared = schemes[Object.keys(security[0])[0]];
      return declared?.type === 'basic' || declared?.type === 'http' && declared.scheme?.toLowerCase() === 'basic';
    })();
  const noAuthentication = security.length === 0 || security.every(item => object(item) && Object.keys(item).length === 0);
  // ODC Basic without the OpenAPI basic scheme stays a typed SSAM refusal (odc_basic_unqualified), not a compile failure.
  if (native.authentication === 'Basic' && !basic && binding.lane !== 'odc' || native.authentication === 'None' && !noAuthentication) fail('model_openapi_auth_mismatch');
  // Basic: the OnAuthentication contract selects app-user (O11 platform login) or an endpoint-credential basic record.
  // An O11 capture without OnAuthentication keeps the platform validation (app-user path).
  let basicContract = null, basicRefusal;
  if (native.authentication === 'Basic' && (binding.lane === 'odc' || model.tree.children.some(node => node.kind === 'RestServiceAuthenticationFlow'))) {
    try { basicContract = readBasicAuthenticationContract(model.tree, binding.lane); }
    catch (error) { basicRefusal = /^debug_native_endpoint_basic_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_native_endpoint_basic_callback_missing'; }
    if (!basic) { basicContract = null; basicRefusal = 'debug_native_endpoint_basic_openapi_mismatch'; }
  }
  // None: a literal request-header guard (OnRequest or method flow) needs the endpoint-credential header record.
  let guard = null, guardRefusal;
  if (native.authentication === 'None') {
    try { guard = readRequestHeaderGuard(model.tree, entryKey, binding.lane); }
    catch (error) { guardRefusal = /^debug_native_endpoint_custom_authentication_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_native_endpoint_custom_authentication_unqualified'; }
  }
  // Custom: the OnAuthentication contract decides; an unqualified one stays a typed reason, not a compile failure.
  let custom = null, customRefusal;
  const unqualified = code => { custom = null; customRefusal = 'debug_native_endpoint_custom_authentication_' + code; };
  if (native.authentication === 'Custom') {
    try { custom = nativeCustomAuthenticationContract({ binding, model }); }
    catch (error) { customRefusal = /^debug_native_endpoint_custom_authentication_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_native_endpoint_custom_authentication_unqualified'; }
    // OpenAPI may restate the same header scheme, never declare another one.
    if (custom && !noAuthentication && !security.every(item => object(item) && Object.keys(item).length && Object.keys(item).every(name => {
      const declared = schemes[name];
      return declared?.type === 'apiKey' && declared.in === 'header' && custom.headers.some(h => h.name.toLowerCase() === String(declared.name).toLowerCase());
    }))) unqualified('openapi_mismatch');
  }
  const parameters = new Map();
  for (const item of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = resolveRef(document, item);
    if (!['path', 'query', 'header', 'body'].includes(parameter.in) || typeof parameter.name !== 'string' || PRIVATE.test(parameter.name)) fail('parameter_unsupported');
    if (parameter.allowReserved || parameter.content || parameter.style && !['form', 'simple'].includes(parameter.style)) fail('parameter_serialization_unsupported');
    parameters.set(parameter.in + ':' + parameter.name, parameter);
  }
  const requestParameters = [], bodyParameters = [...parameters.values()].filter(p => p.in === 'body');
  if (bodyParameters.length > 1) fail('body_ambiguous');
  let bodySchema, bodyRequired = false;
  if (document.swagger === '2.0' && bodyParameters.length) {
    if (!(operation.consumes ?? document.consumes ?? []).includes('application/json')) fail('content_type_unsupported');
    bodySchema = schemaOf(document, bodyParameters[0].schema); bodyRequired = bodyParameters[0].required === true;
  } else if (operation.requestBody) {
    const body = resolveRef(document, operation.requestBody); bodySchema = schemaOf(document, jsonMedia(body.content)); bodyRequired = body.required === true;
  }
  for (const parameter of parameters.values()) if (parameter.in !== 'body') {
    const matching = native.inputs.filter(p => p.wireName === parameter.name && p.where === (parameter.in === 'header' ? 'Header' : 'URL'));
    if (matching.length !== 1 || matching[0].required !== (parameter.required === true)) fail('model_openapi_input_mismatch');
    const schema = schemaOf(document, parameter.schema ?? parameter);
    if (schema.type === 'object' || schema.type === 'array' && schema.items.type === 'object') fail('parameter_serialization_unsupported');
    if (parameter.in === 'path' && schema.type === 'array') fail('parameter_serialization_unsupported');
    if (parameter.in === 'header' && (schema.type === 'array' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(parameter.name) || /^(?:host|connection|content-length|content-type|accept|user-agent|origin|referer|proxy-)/i.test(parameter.name))) fail('header_unsupported');
    const collection = document.swagger === '2.0' ? parameter.collectionFormat ?? 'csv' : parameter.explode !== false && parameter.in === 'query' ? 'multi' : 'csv';
    if (schema.type === 'array' && !['csv', 'multi'].includes(collection)) fail('parameter_serialization_unsupported');
    requestParameters.push({ ...matching[0], in: parameter.in, schema, collection });
  }
  // A business header with the credential's name would let request JSON replace the private value.
  if (custom && requestParameters.some(p => p.in === 'header' && custom.headers.some(h => h.name.toLowerCase() === p.wireName.toLowerCase()))) unqualified('header_collision');
  const bodyInputs = native.inputs.filter(p => p.where === 'Body');
  let bodyBinding;
  if (bodyInputs.length) {
    if (!bodySchema) fail('model_openapi_input_mismatch');
    if (bodyInputs.length === 1 && (document.swagger === '2.0' && bodyParameters[0]?.name === bodyInputs[0].wireName ||
        bodySchema.type !== 'object' || !own(bodySchema.properties, bodyInputs[0].wireName))) bodyBinding = { mode: 'whole', inputs: bodyInputs };
    else if (bodySchema.type === 'object' && bodyInputs.every(p => own(bodySchema.properties, p.wireName)) &&
        Object.keys(bodySchema.properties).length === bodyInputs.length) bodyBinding = { mode: 'fields', inputs: bodyInputs };
    else fail('model_openapi_input_mismatch');
  } else if (bodySchema) fail('model_openapi_input_mismatch');
  if (requestParameters.length + bodyInputs.length !== native.inputs.length) fail('model_openapi_input_mismatch');
  const responseContracts = {};
  for (const [status, value] of Object.entries(operation.responses ?? {})) {
    if (!/^(?:[1-5]\d\d|default)$/.test(status)) fail('response_status_unsupported');
    const response = resolveRef(document, value);
    const mediaTypes = document.swagger === '2.0' ? operation.produces ?? document.produces ?? [] : Object.keys(response.content ?? {});
    const mediaType = mediaTypes.includes('application/json') ? 'application/json' : mediaTypes.includes('text/plain') ? 'text/plain' : null;
    const schema = document.swagger === '2.0' ? response.schema : response.content ? response.content[mediaType]?.schema : null;
    if ((schema || response.content) && !mediaType) fail('content_type_unsupported');
    const compiled = schema ? schemaOf(document, schema) : null;
    if (mediaType === 'text/plain' && compiled && !['string', 'boolean', 'integer', 'number'].includes(compiled.type)) fail('content_type_unsupported');
    responseContracts[status] = { schema: compiled, ...(compiled ? { mediaType } : {}) };
  }
  if (!Object.keys(responseContracts).some(status => /^2\d\d$/.test(status))) fail('success_response_missing');
  const protocol = native.authentication === 'Custom' ? 'custom' : native.authentication === 'Basic' ? 'basic'
    : native.authentication !== 'None' ? 'unsupported' : guard || guardRefusal ? 'header' : 'none';
  return freeze({ schema: 'ssam-native-rest-entry/1', binding, entry: native, url, method: native.method,
    authentication: { native: native.authentication, protocol,
      ...(native.authentication === 'Custom' ? { custom, ...(customRefusal ? { customRefusal } : {}) } : {}),
      ...(native.authentication === 'Basic' ? { basic: basicContract, ...(basicRefusal ? { basicRefusal } : {}) } : {}),
      ...(guard ? { source: guard.source, headers: guard.headers, guard } : guardRefusal ? { headers: [], guardRefusal } : {}),
      appUserIdentityProved: false, rolesProved: false, propagationProved: false },
    source: { url: captured.url, sha256: captured.sha256 }, parameters: requestParameters,
    bodySchema, bodyRequired, bodyBinding, responses: responseContracts });
}

function validated(value, schema, depth = 0, output = false) {
  if (depth > 20) fail('input_size_limit');
  if (value === null) { if (schema.nullable) return null; fail('input_null_invalid'); }
  if (schema.type === 'object') {
    if (!object(value) || Object.keys(value).some(key => !own(schema.properties, key) || !output && PRIVATE.test(key))) fail('input_object_invalid');
    if (schema.required.some(key => !own(value, key))) fail('input_required');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, validated(child, schema.properties[key], depth + 1, output)]));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > Math.min(schema.maxItems ?? 10000, 10000) || value.length < (schema.minItems ?? 0)) fail('input_array_invalid');
    return value.map(item => validated(item, schema.items, depth + 1, output));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > Math.min(schema.maxLength ?? 1048576, 1048576) || value.length < (schema.minLength ?? 0)) fail('input_string_invalid');
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail('input_date_invalid');
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) fail('input_date_invalid');
    if (schema.format === 'byte' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) fail('input_binary_invalid');
  } else if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail('input_boolean_invalid'); }
  else if (schema.type === 'integer') {
    const text = Number.isSafeInteger(value) ? String(value) : value;
    if (typeof text !== 'string' || !/^-?\d{1,19}$/.test(text)) fail('input_integer_invalid');
    const integer = BigInt(text);
    if (schema.format === 'int64') {
      if (integer < -9223372036854775808n || integer > 9223372036854775807n) fail('input_integer_invalid');
      value = integer.toString();
    } else {
      if (schema.format === 'int32' && (integer < -2147483648n || integer > 2147483647n)) fail('input_number_out_of_range');
      // A schema without an Int64 declaration cannot silently round an unsafe
      // integer. Int32 identifiers become numbers only after the exact check.
      if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) fail('input_integer_invalid');
      value = Number(integer);
    }
  } else if (schema.type === 'number') {
    const decimal = decimalParts(value);
    // Canonical decimal strings stay strings internally; jsonWire emits this
    // validated spelling as a JSON number rather than quoting it.
    if (typeof value === 'string') value = decimal.wire;
  }
  const numeric = schema.type === 'number' || schema.type === 'integer';
  if (numeric && (schema.minimum !== undefined && compareDecimal(value, schema.minimum) < (schema.exclusiveMinimum === true ? 1 : 0) ||
      schema.maximum !== undefined && compareDecimal(value, schema.maximum) > (schema.exclusiveMaximum === true ? -1 : 0))) fail('input_number_out_of_range');
  if (schema.enum && !schema.enum.some(item => numeric ? compareDecimal(item, value) === 0 : item === value)) fail('input_enum_invalid');
  return value;
}

function jsonWire(value, schema) {
  if (value === null) return 'null';
  if (schema.type === 'object') return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ':' + jsonWire(item, schema.properties[key])).join(',') + '}';
  if (schema.type === 'array') return '[' + value.map(item => jsonWire(item, schema.items)).join(',') + ']';
  return (schema.type === 'number' || schema.type === 'integer') && typeof value === 'string' ? value : JSON.stringify(value);
}

export function buildNativeEndpointRequest(plan, inputs = {}) {
  if (plan?.schema !== 'ssam-native-rest-entry/1' || !object(inputs)) fail('plan_invalid');
  bounded(inputs);
  const known = plan.entry.inputs.map(p => p.name);
  if (Object.keys(inputs).some(key => !known.includes(key) || PRIVATE.test(key))) fail('input_unknown');
  let route = plan.url; const query = new URLSearchParams(), headers = { Accept: [...new Set(Object.values(plan.responses).filter(r => r.schema).map(r => r.mediaType ?? 'application/json'))].join(', ') || 'application/json' };
  for (const parameter of plan.parameters) {
    if (!own(inputs, parameter.name)) { if (parameter.required) fail('input_required'); continue; }
    const value = validated(inputs[parameter.name], parameter.schema);
    const wire = Array.isArray(value) ? value.map(String) : [String(value)];
    if (parameter.in === 'path') {
      if (wire[0] === '.' || wire[0] === '..' || /[\\/]/.test(wire[0])) fail('input_path_invalid');
      const token = encodeURI('{' + parameter.wireName + '}');
      if (!route.includes(token) && !route.includes('{' + parameter.wireName + '}')) fail('path_parameter_unbound');
      route = route.replaceAll(token, encodeURIComponent(wire[0])).replaceAll('{' + parameter.wireName + '}', encodeURIComponent(wire[0]));
    } else if (parameter.in === 'query') {
      if (parameter.collection === 'multi') for (const item of wire) query.append(parameter.wireName, item);
      else query.append(parameter.wireName, wire.join(','));
    } else { if (/[\r\n\x00]/.test(wire[0])) fail('input_header_invalid'); headers[parameter.wireName] = wire[0]; }
  }
  if (/[{}]|%7[BD]/i.test(route)) fail('path_parameter_unbound');
  const url = scopedUrl(route, plan.binding); if (query.size) url.search = query.toString();
  let body;
  if (plan.bodyBinding) {
    const fields = plan.bodyBinding.inputs;
    if (fields.some(p => p.required && !own(inputs, p.name))) fail('input_required');
    const present = fields.filter(p => own(inputs, p.name));
    if (!present.length) { if (plan.bodyRequired) fail('input_required'); }
    else {
      const value = plan.bodyBinding.mode === 'whole' ? inputs[fields[0].name] : Object.fromEntries(present.map(p => [p.wireName, inputs[p.name]]));
      body = jsonWire(validated(value, plan.bodySchema), plan.bodySchema); headers['Content-Type'] = 'application/json';
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) fail('input_size_limit');
    }
  }
  return { url: url.href, method: plan.method, headers, ...(body === undefined ? {} : { body }) };
}

export function decodeNativeEndpointResponse(plan, { status, contentType, body, headers = {} }) {
  if (!Number.isInteger(status) || status < 100 || status > 599 || typeof body !== 'string' || Buffer.byteLength(body) > 4 * 1024 * 1024) fail('response_invalid');
  const contract = plan.responses[String(status)] ?? plan.responses.default;
  if (!contract) fail('response_status_undeclared');
  if (!contract.schema) { if (body.trim()) fail('response_body_undeclared'); return { status, successful: status >= 200 && status < 300, body: null }; }
  const mediaType = contract.mediaType ?? 'application/json';
  if ((contentType ?? '').split(';', 1)[0].trim().toLowerCase() !== mediaType) fail('response_content_type_mismatch');
  if (mediaType === 'text/plain' && ['number', 'integer'].includes(contract.schema.type) &&
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(body.trim())) fail('response_schema_mismatch');
  let value; try { value = mediaType === 'text/plain' && contract.schema.type === 'string' ? body : JSON.parse(body, losslessNumbers); }
  catch { fail('response_json_invalid'); }
  try { value = validated(value, contract.schema, 0, true); } catch { fail('response_schema_mismatch'); }
  const outputs = {}, successful = status >= 200 && status < 300;
  if (successful) {
    const bodyOutputs = plan.entry.outputs.filter(output => output.where === 'Body');
    for (const output of bodyOutputs) {
      if (object(value) && own(value, output.wireName)) outputs[output.name] = value[output.wireName];
      else if (bodyOutputs.length === 1) outputs[output.name] = value;
      else fail('response_model_output_mismatch');
    }
    for (const output of plan.entry.outputs.filter(item => item.where === 'Header')) {
      const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === output.wireName.toLowerCase());
      if (entries.length !== 1) fail('response_model_output_mismatch'); outputs[output.name] = entries[0][1];
    }
  }
  // Do not pretend schema validation proves business success, identity or roles.
  return { status, successful, body: value, outputs };
}

export async function acquireNativeRestContract({ binding: inputBinding, model, entryKey, documentationUrl }, { fetchImpl = fetch } = {}) {
  const binding = nativeEndpointBinding(inputBinding);
  // Refuse wrong/partial captures, and a service reachable only from the platform internal network, before network.
  if (originalRestModel(model, binding, entryKey).transport.internalAccess === 'Yes') fail('internal_access_only');
  const url = scopedUrl(documentationUrl, binding);
  // The caller supplies the URL observed in the app's native documentation,
  // never an endpoint inferred by appending a guessed Swagger suffix.
  const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } });
  if (response.status !== 200 || response.url && response.url !== url.href) fail('documentation_unavailable');
  const reader = response.body?.getReader(), chunks = []; let length = 0;
  if (!reader) fail('documentation_unavailable');
  while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength;
    if (length > 8 * 1024 * 1024) { await reader.cancel(); fail('contract_size_limit'); } chunks.push(Buffer.from(chunk.value)); }
  const body = Buffer.concat(chunks).toString('utf8'), source = { url: url.href, body, sha256: digest(body) };
  return { source, plan: compileNativeRestEndpoint({ binding, model, entryKey, source }) };
}

// Exposed SOAP and consumed SOAP are different model types. A SOAP action found
// in a consumed integration is not made into a new callable endpoint.
export function nativeSoapEndpointCapability(node, lane) {
  return { executable: false, kind: node?.kind ?? null, lane,
    error: node?.kind === 'SOAPAction' ? 'debug_native_endpoint_consumed_soap_requires_original_caller'
      : 'debug_native_endpoint_published_wsdl_and_native_authentication_required',
    appUserIdentityProved: false, rolesProved: false, propagationProved: false };
}

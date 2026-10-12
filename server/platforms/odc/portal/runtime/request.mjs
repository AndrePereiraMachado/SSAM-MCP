import { fail } from './errors.mjs';
import { resolveRef } from './catalog.mjs';

const parameterLocations = ['path', 'query'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// Portfolio v2 documents comma-separated library types but omits explode:false.
// Live comparison (2026-10-09) showed repeated keys silently drop the second type.
// Keep this compatibility correction scoped; other APIs retain their OpenAPI defaults.
function queryParameter(operation, parameter) {
  return operation.id === 'portfolio-api-v2:get:/libraries' && parameter.name === 'type'
    && parameter.style === undefined && parameter.explode === undefined
    ? { ...parameter, explode: false } : parameter;
}

function binary(value, maxBytes) {
  if (!plain(value) || typeof value.$base64 !== 'string'
    || Object.keys(value).some(key => !['$base64', 'filename'].includes(key))
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.$base64)) {
    fail('INPUT_INVALID', 'Binary input must be an object with canonical $base64 and an optional filename. Local paths and URLs are not accepted.');
  }
  const bytes = Buffer.from(value.$base64, 'base64');
  if (bytes.length > maxBytes) fail('REQUEST_TOO_LARGE', 'Binary input exceeds the request size limit.');
  if (value.filename !== undefined && (typeof value.filename !== 'string' || !/^[A-Za-z0-9_. -]{1,128}$/.test(value.filename))) {
    fail('INPUT_INVALID', 'Binary filename must be a simple filename, without paths or control characters.');
  }
  return bytes;
}

function effectiveType(spec, schema) {
  const s = resolveRef(spec, schema);
  if (s?.type) return s.type;
  for (const child of s?.allOf ?? []) { const type = effectiveType(spec, child); if (type) return type; }
  return undefined;
}

function addQuery(url, parameter, value) {
  const style = parameter.style ?? 'form';
  const explode = parameter.explode ?? style === 'form';
  const name = parameter.name;
  if (Array.isArray(value)) {
    if (style === 'form' && explode) for (const item of value) url.searchParams.append(name, String(item));
    else if (['form', 'spaceDelimited', 'pipeDelimited'].includes(style)) {
      url.searchParams.append(name, value.join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
    } else fail('CONTRACT_UNSUPPORTED', 'Unsupported query array serialization.');
  } else if (plain(value)) {
    if (style === 'deepObject') for (const [key, entry] of Object.entries(value)) url.searchParams.append(`${name}[${key}]`, String(entry));
    else if (style === 'form' && explode) for (const [key, entry] of Object.entries(value)) url.searchParams.append(key, String(entry));
    else if (style === 'form') url.searchParams.append(name, Object.entries(value).flat().join(','));
    else fail('CONTRACT_UNSUPPORTED', 'Unsupported query object serialization.');
  } else url.searchParams.append(name, value === null ? '' : String(value));
}

export function prepareRequest(catalog, operationId, input, config) {
  const { operation, api } = catalog.get(operationId);
  if (!plain(input) || Object.keys(input).some(key => !['path', 'query', 'body', 'contentType'].includes(key))) {
    fail('INPUT_INVALID', 'Request accepts only path, query, body and contentType; URLs and arbitrary headers cannot be supplied.');
  }
  const parameters = operation.parameters.map(p => resolveRef(api.spec, p));
  for (const location of parameterLocations) {
    const values = input[location] ?? {};
    if (!plain(values)) fail('INPUT_INVALID', `${location} parameters must be an object.`);
    for (const name of Object.keys(values)) {
      if (!parameters.some(p => p.in === location && p.name === name)) fail('INPUT_INVALID', 'Unknown request parameter.', { location });
    }
  }
  let pathname = api.basePath + operation.path;
  for (const p of parameters) {
    if (!parameterLocations.includes(p.in)) fail('CONTRACT_UNSUPPORTED', 'This contract uses a parameter location not supported by this pinned adapter.');
    const values = input[p.in] ?? {};
    if (!own(values, p.name)) {
      if (p.required) fail('INPUT_INVALID', 'Required parameter is missing.', { location: `${p.in}.${p.name}` });
      continue;
    }
    const value = values[p.name];
    catalog.validate(api, p.schema, value, `${p.in}.${p.name}`);
    if (p.in === 'path') {
      if (!['string', 'number'].includes(typeof value) || (p.style && p.style !== 'simple')) fail('CONTRACT_UNSUPPORTED', 'Only simple scalar path parameters are supported by these contracts.');
      const string = String(value);
      // Encoded or double-encoded slash/dot traversal is not passed to upstream routers.
      if (!string || string === '.' || string === '..' || /[\/%\\?#\u0000-\u001f]/.test(string)) fail('INPUT_INVALID', 'Unsafe path parameter.');
      pathname = pathname.replace(`{${p.name}}`, encodeURIComponent(string));
    }
  }
  if (/[{}]/.test(pathname)) fail('INPUT_INVALID', 'Not all route parameters were supplied.');
  // Catalog-only dry validation works without an operator origin, never sends to the placeholder.
  const url = new URL(pathname, config.origin ?? 'https://not-configured.invalid');
  if (url.pathname !== pathname || (config.origin && url.origin !== config.origin)) fail('INPUT_INVALID', 'Route normalization changed the expected path.');
  for (const p of parameters.filter(p => p.in === 'query')) if (own(input.query ?? {}, p.name)) addQuery(url, queryParameter(operation, p), input.query[p.name]);
  const headers = { accept: 'application/json' };
  let body;
  const requestBody = resolveRef(api.spec, operation.requestBody);
  if (own(input, 'body')) {
    if (!requestBody) fail('INPUT_INVALID', 'This operation does not define a request body.');
    const content = requestBody.content ?? {};
    const contentType = input.contentType ?? (content['application/json'] ? 'application/json' : Object.keys(content).find(c => !c.includes('*')));
    if (typeof contentType !== 'string' || /[\r\n]/.test(contentType)) fail('INPUT_INVALID', 'Choose a concrete media type declared by this operation.');
    const media = content[contentType] ?? (/^application\/[A-Za-z0-9.+-]+\+json$/.test(contentType) ? content['application/*+json'] : undefined);
    if (!media || contentType.includes('*')) fail('INPUT_INVALID', 'Content type does not match this operation.');
    if (contentType === 'application/json' || contentType.endsWith('+json')) {
      catalog.validate(api, media.schema, input.body, 'body');
      body = JSON.stringify(input.body);
      headers['content-type'] = contentType;
    } else if (contentType === 'application/octet-stream') {
      body = binary(input.body, config.maxRequestBytes);
      headers['content-type'] = contentType;
    } else if (contentType === 'multipart/form-data') {
      if (!plain(input.body)) fail('INPUT_INVALID', 'Multipart body must be an object.');
      const schema = resolveRef(api.spec, media.schema);
      const validationCopy = { ...input.body };
      const form = new FormData();
      for (const [name, value] of Object.entries(input.body)) {
        const property = resolveRef(api.spec, schema?.properties?.[name]);
        if (!property) fail('INPUT_INVALID', 'Unknown multipart field.');
        const type = media.encoding?.[name]?.contentType;
        if (property.format === 'binary') {
          const bytes = binary(value, config.maxRequestBytes);
          validationCopy[name] = value.$base64;
          form.append(name, new Blob([bytes], { type: type ?? 'application/octet-stream' }), value.filename ?? 'upload.bin');
        } else if (type?.includes('json') || effectiveType(api.spec, property) === 'object') {
          form.append(name, new Blob([JSON.stringify(value)], { type: type ?? 'application/json' }));
        } else form.append(name, String(value));
      }
      catalog.validate(api, media.schema, validationCopy, 'body');
      body = form;
      // Fetch generates the multipart boundary. Never accept it from the model.
    } else fail('CONTRACT_UNSUPPORTED', 'Unsupported request media type.');
  } else {
    if (input.contentType) fail('INPUT_INVALID', 'contentType requires a body.');
    if (requestBody?.required) fail('INPUT_INVALID', 'A request body is required by this operation.');
  }
  // Count the final serialized multipart bytes, including the generated boundary.
  if (body !== undefined && !(body instanceof FormData) && Buffer.byteLength(body) > config.maxRequestBytes) {
    fail('REQUEST_TOO_LARGE', 'Serialized body exceeds the request size limit.');
  }
  return { operation, api, url, method: operation.method, headers, body };
}

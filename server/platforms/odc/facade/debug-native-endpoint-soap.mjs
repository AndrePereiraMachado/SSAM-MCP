// SOAP 1.1 document/literal adapter for a published WSDL and matching native
// exposed service. Consumed SOAP actions, RPC/encoded, WS-Security, MTOM and
// Windows integrated authentication require different native adapters. An app-level HTTP
// header check read in the method flow uses the private endpoint-credential dialog.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { nativeEndpointBinding } from './debug-native-endpoint.mjs';
import { nativeCustomAuthenticationContract } from './debug-native-endpoint-custom.mjs';

const WSDL = 'http://schemas.xmlsoap.org/wsdl/', SOAP = 'http://schemas.xmlsoap.org/wsdl/soap/';
const ENVELOPE = 'http://schemas.xmlsoap.org/soap/envelope/', XSD = 'http://www.w3.org/2001/XMLSchema';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const fail = code => { throw new Error('debug_native_endpoint_' + code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const children = (node, namespace, name) => [...node.children].filter(child => child.namespaceURI === namespace && (!name || child.localName === name));
const one = rows => { if (rows.length !== 1) fail('soap_contract_ambiguous'); return rows[0]; };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) fail('soap_xml_invalid');
  try { return new JSDOM(text, { contentType: 'application/xml' }); } catch { fail('soap_xml_invalid'); }
}
function qualified(node, value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*$/.test(value)) fail('soap_qname_invalid');
  const [a, b] = value.split(':'); const namespace = node.lookupNamespaceURI(b ? a : null);
  if (!namespace) fail('soap_qname_invalid'); return { name: b ?? a, namespace };
}
function scopedUrl(raw, binding) {
  let url; try { url = new URL(raw, binding.runtimeUrl); } catch { fail('soap_url_invalid'); }
  if (url.origin !== new URL(binding.runtimeUrl).origin || !url.pathname.startsWith('/' + binding.module + '/') ||
      url.username || url.password || url.hash || /%(?:2e|2f|5c)/i.test(url.pathname)) fail('url_outside_publication');
  return url;
}
function complete(node) {
  if (!object(node) || !Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail('model_incomplete');
  for (const child of node.children) complete(child);
}

// Typed refusal for the published service's own authentication settings. Neither is
// claimed as an OutSystems Cloud platform limit without read-only descriptor evidence.
const SOAP_AUTHENTICATION = { soap_integrated_authentication_unsupported: 'Windows Integrated authentication',
  soap_client_certificate_unsupported: 'an SSL client certificate', soap_native_authentication_unsupported: 'this native authentication setting' };
const soapAuthenticationRefusal = (code, native) => ({ executable: false, error: 'debug_native_endpoint_' + code,
  ...(code === 'soap_native_authentication_unsupported' ? {} : { alias: 'debug_native_endpoint_soap_native_authentication_unsupported' }),
  ...(native ? { native } : {}), policy: 'ssam', platformLimitProved: false,
  limitation: 'The SSAM SOAP endpoint adapter does not supply ' + SOAP_AUTHENTICATION[code] + '; this is not claimed as a platform limit without read-only Service Studio descriptor and OutSystems Cloud evidence.' });

export function nativeSoapAuthenticationRefusal(properties = {}) {
  const integrated = properties?.IntegratedAuthentication, security = properties?.HTTPSecurity;
  const code = integrated === 'True' ? 'soap_integrated_authentication_unsupported'
    : /^SSL\s*with\s*client\s*certificates?$/i.test(security ?? '') ? 'soap_client_certificate_unsupported'
    : integrated !== 'False' || !['SSL', 'None'].includes(security) ? 'soap_native_authentication_unsupported' : null;
  return code ? soapAuthenticationRefusal(code, { IntegratedAuthentication: integrated ?? null, HTTPSecurity: security ?? null }) : null;
}

// For a prepare receipt (entryAbi.authentication) when acquisition refused before any GET.
export function nativeSoapAuthenticationRefusalFromError(error) {
  const code = /^debug_native_endpoint_(soap_[a-z_]+)$/.exec(error?.message ?? '')?.[1];
  return Object.hasOwn(SOAP_AUTHENTICATION, code ?? '') ? soapAuthenticationRefusal(code) : null;
}

// O11 exposed SOAP has no OnAuthentication: an app-level check reads request headers in the
// WebServiceMethod flow. The custom-contract reader judges exactly that flow's request-header
// API and native login calls (literal GetRequestHeader names only); other calls are the method's
// own logic. A method that reads no request header keeps the anonymous contract.
const HEADER_CALL = /^Reference:HTTPRequestHandler\//;
const LOGIN_CALL = /^Reference:(?:\(System\)\/[A-Za-z]*ActionSignature:(?:Login|LoginPassword)|Users\/[A-Za-z]*ActionSignature:User_Login)$/;
const shell = (kind, key, properties, children) => ({ kind, key, properties, children, childrenTotal: children.length, childrenOmitted: 0,
  propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] });
function soapHeaderAuthentication(binding, model, service, action) {
  const picked = [], walk = node => { for (const child of node.children) {
    const called = /^Execute[A-Za-z]*ActionNode$/.test(child.kind) ? child.propertyReferences?.Action?.path ?? '' : '';
    if (HEADER_CALL.test(called) || LOGIN_CALL.test(called)) picked.push(child); else walk(child); } };
  walk(action);
  if (!picked.some(node => HEADER_CALL.test(node.propertyReferences.Action.path))) return { native: 'None', protocol: 'none' };
  let custom = null, customRefusal;
  try {
    const read = nativeCustomAuthenticationContract({ binding, model: { ...model, tree: shell('RestService', service.key, { Authentication: 'Custom' },
      [shell('RestServiceAuthenticationFlow', action.key, {}, picked)]) } });
    // SOAPAction is the adapter's own header; the credential never overrides it.
    if (read.headers.some(header => header.name.toLowerCase() === 'soapaction')) throw new Error('debug_native_endpoint_custom_authentication_header_collision');
    custom = { scheme: 'header', headers: read.headers, callsLogin: read.callsLogin, methodKey: action.key, serviceKey: service.key, source: 'published WebServiceMethod flow' };
  } catch (error) { customRefusal = /^debug_native_endpoint_custom_authentication_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_native_endpoint_custom_authentication_unqualified'; }
  return { native: 'None', protocol: 'header', custom, ...(customRefusal ? { customRefusal } : {}) };
}
// WS-Policy / WS-Security markers: the adapter never builds a SOAP security header.
const WS_SECURITY = new Set(['http://schemas.xmlsoap.org/ws/2004/09/policy', 'http://www.w3.org/ns/ws-policy',
  'http://docs.oasis-open.org/ws-sx/ws-securitypolicy/200702', 'http://schemas.xmlsoap.org/ws/2005/07/securitypolicy', 'http://schemas.xmlsoap.org/ws/2002/12/secext',
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd', 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd']);

export function compileNativeSoapEndpoint({ binding: value, model, entryKey, source }) {
  const binding = nativeEndpointBinding(value);
  if (model?.schema !== 'ssam-reading/1' || model.model !== binding.module || model.sourceSha256?.toLowerCase() !== binding.sourceSha256 ||
      !['SOAPService', 'SoapService', 'WebService'].includes(model.tree?.kind)) fail('soap_model_binding_invalid');
  complete(model.tree);
  const service = model.tree, action = one(service.children.filter(node => ['SOAPServiceAction', 'SoapServiceAction', 'WebServiceMethod'].includes(node.kind) && node.key === entryKey));
  const refusal = nativeSoapAuthenticationRefusal(service.properties);
  if (refusal) throw new Error(refusal.error);
  if (typeof source?.body !== 'string' || hash(source.body) !== source.sha256?.toLowerCase()) fail('source_changed');
  const sourceUrl = scopedUrl(source.url, binding), dom = parse(source.body), document = dom.window.document;
  try {
    const definitions = document.documentElement;
    if ([...document.getElementsByTagName('*')].some(element => WS_SECURITY.has(element.namespaceURI) ||
        [...element.attributes].some(attribute => WS_SECURITY.has(attribute.namespaceURI)))) fail('soap_ws_security_unsupported');
    if (definitions.namespaceURI !== WSDL || definitions.localName !== 'definitions' || document.getElementsByTagNameNS(WSDL, 'import').length ||
        document.getElementsByTagNameNS(XSD, 'import').length || document.getElementsByTagNameNS(XSD, 'include').length || document.getElementsByTagNameNS(XSD, 'redefine').length)
      fail('soap_external_contract_unsupported');
    const namespace = definitions.getAttribute('targetNamespace');
    const global = (name, qname) => one(children(definitions, WSDL, name).filter(node => node.getAttribute('name') === qname.name && namespace === qname.namespace));
    const publishedService = one(children(definitions, WSDL, 'service').filter(node => node.getAttribute('name') === service.name));
    const ports = children(publishedService, WSDL, 'port').filter(port => children(port, SOAP, 'address').length === 1);
    const port = one(ports), address = one(children(port, SOAP, 'address')), endpoint = scopedUrl(address.getAttribute('location'), binding);
    if (endpoint.search) fail('soap_url_invalid');
    const nativeBinding = global('binding', qualified(port, port.getAttribute('binding')));
    const soapBinding = one(children(nativeBinding, SOAP, 'binding'));
    const bindingStyle = soapBinding.getAttribute('style');
    if (soapBinding.getAttribute('transport') !== 'http://schemas.xmlsoap.org/soap/http' || bindingStyle && bindingStyle !== 'document') fail('soap_binding_unsupported');
    const operation = one(children(nativeBinding, WSDL, 'operation').filter(node => node.getAttribute('name') === action.name));
    const soapOperation = one(children(operation, SOAP, 'operation'));
    const operationStyle = soapOperation.getAttribute('style');
    if (operationStyle && operationStyle !== 'document' || (operationStyle || bindingStyle) !== 'document') fail('soap_binding_unsupported');
    const soapAction = soapOperation.getAttribute('soapAction');
    if (!soapAction || /[\x00-\x20"\\]/.test(soapAction)) fail('soap_action_invalid');
    for (const direction of ['input', 'output']) {
      const node = one(children(operation, WSDL, direction)), body = one(children(node, SOAP, 'body'));
      if (body.getAttribute('use') !== 'literal' || children(node, SOAP, 'header').length || body.hasAttribute('encodingStyle')) fail('soap_binding_unsupported');
    }
    const portType = global('portType', qualified(nativeBinding, nativeBinding.getAttribute('type')));
    const declaration = one(children(portType, WSDL, 'operation').filter(node => node.getAttribute('name') === action.name));
    const schemas = [...document.getElementsByTagNameNS(XSD, 'schema')];
    const schemaGlobal = (name, qname) => one(schemas.filter(schema => schema.getAttribute('targetNamespace') === qname.namespace)
      .flatMap(schema => children(schema, XSD, name).filter(node => node.getAttribute('name') === qname.name)));
    const describe = (element, ancestry = []) => {
      if (ancestry.includes(element) || ancestry.length > 16) fail('soap_recursive_type_unsupported');
      if (element.hasAttribute('ref')) {
        const referred = describe(schemaGlobal('element', qualified(element, element.getAttribute('ref'))), [...ancestry, element]);
        const min = element.getAttribute('minOccurs') || '1', max = element.getAttribute('maxOccurs') || '1';
        if (!/^\d{1,5}$/.test(min) || max !== 'unbounded' && !/^\d{1,5}$/.test(max)) fail('soap_occurrence_unsupported');
        return { ...referred, required: min !== '0', repeated: max !== '1', minItems: Number(min), maxItems: max === 'unbounded' ? 10000 : Number(max) };
      }
      const name = element.getAttribute('name'); if (!/^[A-Za-z_][\w.-]*$/.test(name) || /password|credential|authorization|cookie|token|secret/i.test(name)) fail('soap_parameter_unsupported');
      let schema = element.parentElement;
      while (schema && (schema.namespaceURI !== XSD || schema.localName !== 'schema')) schema = schema.parentElement;
      if (!schema) fail('soap_schema_unresolved');
      const qualifiedElement = element.parentElement === schema || element.getAttribute('form') === 'qualified' || !element.hasAttribute('form') && schema.getAttribute('elementFormDefault') === 'qualified';
      const minOccurs = element.getAttribute('minOccurs') || '1', maxOccurs = element.getAttribute('maxOccurs') || '1';
      if (!/^\d{1,5}$/.test(minOccurs) || maxOccurs !== 'unbounded' && !/^\d{1,5}$/.test(maxOccurs)) fail('soap_occurrence_unsupported');
      const spec = { name, namespace: qualifiedElement ? schema.getAttribute('targetNamespace') : '',
        required: minOccurs !== '0', repeated: maxOccurs !== '1', minItems: Number(minOccurs), maxItems: maxOccurs === 'unbounded' ? 10000 : Number(maxOccurs),
        nullable: element.getAttribute('nillable') === 'true' };
      if (element.hasAttribute('default') || element.hasAttribute('fixed')) fail('soap_default_value_unsupported');
      let complex;
      if (element.hasAttribute('type')) {
        const type = qualified(element, element.getAttribute('type'));
        if (type.namespace === XSD) {
          if (!['string', 'boolean', 'int', 'long', 'integer', 'decimal', 'double', 'float', 'date', 'time', 'dateTime', 'base64Binary'].includes(type.name)) fail('soap_scalar_unsupported');
          return { ...spec, type: type.name };
        }
        complex = schemaGlobal('complexType', type);
      } else complex = one(children(element, XSD, 'complexType'));
      if (children(complex, XSD).some(node => !['sequence', 'annotation'].includes(node.localName))) fail('soap_complex_type_unsupported');
      const sequences = children(complex, XSD, 'sequence');
      // Native O11 emits an empty complexType for a no-parameter method.
      if (!sequences.length) return { ...spec, type: 'record', fields: [] };
      const sequence = one(sequences);
      if (children(sequence, XSD).some(node => node.localName !== 'element')) fail('soap_complex_type_unsupported');
      return { ...spec, type: 'record', fields: children(sequence, XSD, 'element').map(child => describe(child, [...ancestry, element])) };
    };
    const message = direction => {
      const ref = one(children(declaration, WSDL, direction)), nativeMessage = global('message', qualified(ref, ref.getAttribute('message')));
      const part = one(children(nativeMessage, WSDL, 'part'));
      if (!part.hasAttribute('element') || part.hasAttribute('type')) fail('soap_binding_unsupported');
      return describe(schemaGlobal('element', qualified(part, part.getAttribute('element'))));
    };
    const request = message('input'), response = message('output');
    const inputs = action.children.filter(node => node.kind === 'InputParameter'), outputs = action.children.filter(node => node.kind === 'OutputParameter');
    // Native O11 ASMX emits reference-valued structures as optional XML elements
    // even when the action parameter is mandatory. Keep that model requirement
    // for invocation; do not treat XML occurrence as the action's input policy.
    const nativeStructureOccurrence = (node, field) => binding.lane === 'o11' && service.kind === 'WebService' &&
      action.kind === 'WebServiceMethod' && node.properties?.IsMandatory === 'True' &&
      /^Structure:/.test(node.properties?.DataType ?? '') && field.type === 'record' && !field.repeated && !field.required;
    const sameSignature = (nodes, body) => body.type === 'record' && nodes.length === body.fields.length && nodes.every((node, i) =>
      node.name === body.fields[i].name && ['True', 'False'].includes(node.properties?.IsMandatory) &&
      ((node.properties.IsMandatory === 'True') === body.fields[i].required || nativeStructureOccurrence(node, body.fields[i])));
    if (!sameSignature(inputs, request) || outputs.length !== (response.fields?.length ?? -1) || outputs.some((node, i) => node.name !== response.fields[i].name)) fail('soap_model_signature_mismatch');
    inputs.forEach((node, i) => { if (nativeStructureOccurrence(node, request.fields[i])) request.fields[i].required = true; });
    return { schema: 'ssam-native-soap-entry/1', binding, entry: { serviceKey: service.key, entryKey, name: action.name,
      inputs: inputs.map(node => ({ name: node.name })), outputs: outputs.map(node => ({ name: node.name })) },
      url: endpoint.href, method: 'POST', source: { url: sourceUrl.href, sha256: source.sha256.toLowerCase() },
      soapAction, request, response, authentication: { ...soapHeaderAuthentication(binding, model, service, action),
        appUserIdentityProved: false, rolesProved: false, propagationProved: false } };
  } finally { dom.window.close(); }
}

function scalar(value, type) {
  if (type === 'string') { if (typeof value !== 'string') fail('soap_input_type_invalid'); return value; }
  if (type === 'boolean') { if (typeof value !== 'boolean') fail('soap_input_type_invalid'); return String(value); }
  if (['int', 'long', 'integer'].includes(type)) {
    const text = Number.isSafeInteger(value) ? String(value) : value;
    if (typeof text !== 'string' || !/^-?(?:0|[1-9]\d{0,18})$/.test(text) || type === 'int' && (BigInt(text) < -2147483648n || BigInt(text) > 2147483647n) ||
        type === 'long' && (BigInt(text) < -9223372036854775808n || BigInt(text) > 9223372036854775807n)) fail('soap_input_type_invalid'); return text;
  }
  if (['decimal', 'double', 'float'].includes(type)) {
    if (!['string', 'number'].includes(typeof value) || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) fail('soap_input_type_invalid'); return String(value);
  }
  if (typeof value !== 'string') fail('soap_input_type_invalid');
  if (type === 'base64Binary' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('soap_input_type_invalid');
  if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail('soap_input_type_invalid');
  if (type === 'dateTime' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) fail('soap_input_type_invalid');
  if (type === 'time' && !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) fail('soap_input_type_invalid');
  return value;
}
function serialize(spec, value) {
  if (value === undefined) { if (spec.required) fail('soap_input_required'); return ''; }
  if (spec.repeated) {
    if (!Array.isArray(value) || value.length > Math.min(10000, spec.maxItems) || value.length < spec.minItems) fail('soap_input_array_invalid');
    return value.map(item => serialize({ ...spec, repeated: false }, item)).join('');
  }
  const start = '<' + spec.name + ' xmlns="' + xml(spec.namespace) + '"';
  if (value === null) { if (!spec.nullable) fail('soap_input_null_invalid'); return start + ' xmlns:xsi="' + XSI + '" xsi:nil="true"/>'; }
  let content;
  if (spec.type === 'record') {
    if (!object(value) || Object.keys(value).some(key => !spec.fields.some(field => field.name === key))) fail('soap_input_object_invalid');
    content = spec.fields.map(field => serialize(field, value[field.name])).join('');
  } else content = xml(scalar(value, spec.type));
  return start + '>' + content + '</' + spec.name + '>';
}

export function buildNativeSoapRequest(plan, inputs = {}) {
  if (plan?.schema !== 'ssam-native-soap-entry/1') fail('soap_plan_invalid');
  const body = '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="' + ENVELOPE + '"><soap:Body>' + serialize(plan.request, inputs) + '</soap:Body></soap:Envelope>';
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) fail('input_size_limit');
  return { url: plan.url, method: 'POST', headers: { Accept: 'text/xml', 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"' + plan.soapAction + '"' }, body };
}

function decode(spec, element) {
  if (element.namespaceURI !== spec.namespace || element.localName !== spec.name) fail('soap_response_schema_mismatch');
  if (element.getAttributeNS(XSI, 'nil') === 'true') { if (!spec.nullable) fail('soap_response_schema_mismatch'); return null; }
  if (spec.type === 'record') {
    const result = {}, elements = [...element.children]; let cursor = 0;
    for (const field of spec.fields) {
      const matches = [];
      while (elements[cursor]?.localName === field.name && elements[cursor]?.namespaceURI === field.namespace) matches.push(elements[cursor++]);
      if (field.required && !matches.length || !field.repeated && matches.length > 1 || field.repeated && (matches.length < field.minItems || matches.length > field.maxItems)) fail('soap_response_schema_mismatch');
      if (field.repeated) result[field.name] = matches.map(node => decode({ ...field, repeated: false }, node));
      else if (matches.length) result[field.name] = decode(field, matches[0]);
    }
    if (cursor !== elements.length) fail('soap_response_schema_mismatch'); return result;
  }
  if (element.children.length) fail('soap_response_schema_mismatch');
  const text = element.textContent;
  if (spec.type === 'boolean') { if (!['true', 'false', '1', '0'].includes(text)) fail('soap_response_schema_mismatch'); return text === 'true' || text === '1'; }
  try { scalar(spec.type === 'int' ? Number(text) : text, spec.type); } catch { fail('soap_response_schema_mismatch'); }
  return spec.type === 'int' ? Number(text) : text;
}

export function decodeNativeSoapResponse(plan, { status, contentType, body }) {
  if (!/^text\/xml(?:\s*;|$)/i.test(contentType ?? '') || !Number.isInteger(status)) fail('soap_response_invalid');
  const dom = parse(body);
  try {
    const envelope = dom.window.document.documentElement;
    if (envelope.namespaceURI !== ENVELOPE || envelope.localName !== 'Envelope') fail('soap_response_invalid');
    const content = one([...one(children(envelope, ENVELOPE, 'Body')).children]);
    if (content.namespaceURI === ENVELOPE && content.localName === 'Fault') return { status, successful: false,
      fault: { code: one([...content.children].filter(node => node.localName === 'faultcode')).textContent,
        reason: one([...content.children].filter(node => node.localName === 'faultstring')).textContent }, outputs: {} };
    const outputs = decode(plan.response, content);
    return { status, successful: status >= 200 && status < 300, body: outputs, outputs };
  } finally { dom.window.close(); }
}

export async function acquireNativeSoapEntry({ binding: rawBinding, entry, readTree, sourceContract }, { fetchImpl = fetch, documentationRoute } = {}) {
  const binding = nativeEndpointBinding(rawBinding);
  const guard = () => {
    if (sourceContract?.sha256?.toLowerCase() !== binding.sourceSha256 || typeof sourceContract.path !== 'string' ||
        hash(fs.readFileSync(sourceContract.path)) !== binding.sourceSha256) fail('source_changed');
  };
  guard();
  if (!/^[A-Za-z0-9_+]{22}$/.test(entry?.key ?? '') || typeof entry.path !== 'string' || typeof readTree !== 'function') fail('model_entry_unresolved');
  const parts = entry.path.split('/'), serviceAt = parts.findIndex(part => /^(?:SOAPService|SoapService|WebService):/.test(part));
  if (serviceAt < 0 || serviceAt !== parts.length - 2 || !/^(?:SOAPServiceAction|SoapServiceAction|WebServiceMethod):/.test(parts.at(-1))) fail('model_entry_unresolved');
  const read = await readTree(parts.slice(0, serviceAt + 1).join('/'));
  guard();
  const model = read?.schema === 'ssam-reading/1' ? read : { schema: 'ssam-reading/1', model: binding.module,
    sourceSha256: binding.sourceSha256, tree: read?.tree ?? read };
  if (model.model !== binding.module || model.sourceSha256?.toLowerCase() !== binding.sourceSha256 ||
      !['SOAPService', 'SoapService', 'WebService'].includes(model.tree?.kind)) fail('soap_model_binding_invalid');
  complete(model.tree);
  // The typed authentication refusal precedes the documentation route and every GET.
  const refusal = nativeSoapAuthenticationRefusal(model.tree.properties);
  if (refusal) throw new Error(refusal.error);
  const readDescription = async (url, content) => {
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Accept: content }, signal: AbortSignal.timeout(30000) });
    if (response.status !== 200 || response.url && response.url !== url.href) fail('description_unavailable');
    const reader = response.body?.getReader(), chunks = []; let bytes = 0;
    if (!reader) fail('description_unavailable');
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); fail('contract_size_limit'); } chunks.push(Buffer.from(chunk.value)); }
    guard(); return { body: Buffer.concat(chunks).toString('utf8'), contentType: response.headers.get('content-type') ?? '' };
  };
  // Legacy O11 exposes documentation through its native Open Documentation
  // command. Follow the WSDL link returned by that original page; no endpoint
  // or WSDL suffix is guessed from the action name.
  let observed = model.tree.properties?.URL, documentation;
  if (!observed && binding.lane === 'o11' && model.tree.kind === 'WebService') {
    const original = documentationRoute ?? (await import('./debug-o11-soap-route.mjs')).originalO11SoapDocumentationRoute;
    documentation = await original(binding, model.tree);
    const page = scopedUrl(documentation.url, binding), description = await readDescription(page, 'text/html');
    if (!/^text\/html(?:\s*;|$)/i.test(description.contentType)) fail('description_unavailable');
    const dom = new JSDOM(description.body, { url: page.href });
    try {
      const links = [...new Set([...dom.window.document.querySelectorAll('a[href]')].map(a => {
        const url = new URL(a.getAttribute('href'), page); return url.origin === page.origin && url.pathname === page.pathname && /^\?wsdl$/i.test(url.search) ? url.href : null;
      }).filter(Boolean))];
      observed = one(links); documentation = { ...documentation, sha256: hash(description.body) };
    } finally { dom.window.close(); }
  }
  if (typeof observed !== 'string' || !observed) fail('soap_published_wsdl_url_unavailable');
  const url = scopedUrl(observed, binding);
  if (!/^\?wsdl$/i.test(url.search) && !(url.pathname.toLowerCase().endsWith('.wsdl') && !url.search)) fail('soap_published_wsdl_url_unavailable');
  const description = await readDescription(url, 'text/xml, application/xml');
  if (!/^(?:text|application)\/xml(?:\s*;|$)/i.test(description.contentType)) fail('description_unavailable');
  const body = description.body, contract = { binding, model, entryKey: entry.key,
    source: { url: url.href, body, sha256: hash(body), ...(documentation ? { documentation } : {}) } };
  return { contract, plan: compileNativeSoapEndpoint(contract) };
}

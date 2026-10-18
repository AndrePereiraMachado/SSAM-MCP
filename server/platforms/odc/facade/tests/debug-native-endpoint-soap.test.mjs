import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileNativeSoapEndpoint, buildNativeSoapRequest, decodeNativeSoapResponse, acquireNativeSoapEntry, nativeSoapAuthenticationRefusal, nativeSoapAuthenticationRefusalFromError } from '../debug-native-endpoint-soap.mjs';
import { nativeEndpointAuthenticationCapability, invokePrivateNativeEndpoint } from '../debug-native-endpoint-worker.mjs';
import { endpointCredentialBinding } from '../debug-app-user.mjs';
import { header as customHeader, call as customCall, argument as customArgument } from './fixtures/debug-native-custom-fixture.mjs';

const key = c => c.repeat(22), hash = value => createHash('sha256').update(value).digest('hex');
const node = (kind, name, properties, children = []) => ({ kind, name, key: kind === 'SOAPServiceAction' ? key('b') : key('c'),
  properties, children, childrenTotal: children.length, childrenOmitted: 0, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] });
const wsdl = `<?xml version="1.0"?><wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:example:orders" targetNamespace="urn:example:orders">
<wsdl:types><xsd:schema targetNamespace="urn:example:orders" elementFormDefault="qualified">
<xsd:element name="Find"><xsd:complexType><xsd:sequence><xsd:element name="Id" type="xsd:long"/><xsd:element name="Label" type="xsd:string" minOccurs="0"/></xsd:sequence></xsd:complexType></xsd:element>
<xsd:element name="FindResponse"><xsd:complexType><xsd:sequence><xsd:element name="Id" type="xsd:long"/><xsd:element name="Label" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
</xsd:schema></wsdl:types>
<wsdl:message name="FindInput"><wsdl:part name="parameters" element="tns:Find"/></wsdl:message><wsdl:message name="FindOutput"><wsdl:part name="parameters" element="tns:FindResponse"/></wsdl:message>
<wsdl:portType name="OrdersSoap"><wsdl:operation name="Find"><wsdl:input message="tns:FindInput"/><wsdl:output message="tns:FindOutput"/></wsdl:operation></wsdl:portType>
<wsdl:binding name="OrdersBinding" type="tns:OrdersSoap"><soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/><wsdl:operation name="Find"><soap:operation soapAction="urn:example:orders/Find"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation></wsdl:binding>
<wsdl:service name="Orders"><wsdl:port name="OrdersSoap" binding="tns:OrdersBinding"><soap:address location="https://dev.example.test/Store/Orders.asmx"/></wsdl:port></wsdl:service></wsdl:definitions>`;
function fixture(text = wsdl, extra = []) {
  const binding = { lane: 'o11', runtimeUrl: 'https://dev.example.test/Store/', module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: 'e'.repeat(64) };
  const action = node('SOAPServiceAction', 'Find', {}, [node('InputParameter', 'Id', { IsMandatory: 'True' }), node('InputParameter', 'Label', { IsMandatory: 'False' }),
    node('OutputParameter', 'Id', {}), node('OutputParameter', 'Label', {}), ...extra]);
  const model = { schema: 'ssam-reading/1', model: 'Store', sourceSha256: binding.sourceSha256,
    tree: node('SOAPService', 'Orders', { IntegratedAuthentication: 'False', HTTPSecurity: 'SSL' }, [action]) };
  return { binding, model, entryKey: key('b'), source: { url: binding.runtimeUrl + 'Orders.asmx?WSDL', body: text, sha256: hash(text) } };
}
const response = value => '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + value + '</s:Body></s:Envelope>';

test('SOAP uses WSDL address/action and document literal namespace with lossless long inputs', () => {
  const plan = compileNativeSoapEndpoint(fixture());
  const request = buildNativeSoapRequest(plan, { Id: '9223372036854775807', Label: 'A&B <C>' });
  assert.equal(request.url, 'https://dev.example.test/Store/Orders.asmx');
  assert.equal(request.headers.SOAPAction, '"urn:example:orders/Find"');
  assert.match(request.body, /9223372036854775807/); assert.match(request.body, /A&amp;B &lt;C&gt;/);
  assert.equal(nativeEndpointAuthenticationCapability(plan).requiredContext, 'explicit-anonymous');
});

test('SOAP response preserves long outputs and requires the original namespace and output signature', () => {
  const plan = compileNativeSoapEndpoint(fixture());
  const body = response('<FindResponse xmlns="urn:example:orders"><Id>9223372036854775807</Id><Label>Result</Label></FindResponse>');
  const result = decodeNativeSoapResponse(plan, { status: 200, contentType: 'text/xml; charset=utf-8', body });
  assert.equal(result.outputs.Id, '9223372036854775807'); assert.equal(result.outputs.Label, 'Result');
  assert.throws(() => decodeNativeSoapResponse(plan, { status: 200, contentType: 'text/xml', body: body.replaceAll('urn:example:orders', 'urn:other') }), /soap_response_schema_mismatch/);
});

test('O11 mandatory structure remains required when ASMX emits minOccurs zero', () => {
  const text = wsdl.replace('<xsd:element name="Id" type="xsd:long"/>',
    '<xsd:element name="Id" minOccurs="0"><xsd:complexType><xsd:sequence><xsd:element name="Value" type="xsd:long"/></xsd:sequence></xsd:complexType></xsd:element>');
  const f = fixture(text);
  f.model.tree.kind = 'WebService'; f.model.tree.children[0].kind = 'WebServiceMethod';
  f.model.tree.children[0].children[0].properties.DataType = 'Structure:Payload';
  const plan = compileNativeSoapEndpoint(f);
  assert.equal(plan.request.fields[0].required, true);
  assert.throws(() => buildNativeSoapRequest(plan, {}), /soap_input_required/);
  assert.match(buildNativeSoapRequest(plan, {Id:{Value:'9223372036854775807'}}).body, /9223372036854775807/);
  f.model.tree.children[0].children[0].properties.DataType = 'LongInteger';
  assert.throws(() => compileNativeSoapEndpoint(f), /soap_model_signature_mismatch/);
  f.model.tree.children[0].children[0].properties.DataType = 'Structure:Payload';
  f.binding.lane = 'odc';
  assert.throws(() => compileNativeSoapEndpoint(f), /soap_model_signature_mismatch/);
});

test('SOAP fault is a definitive native fault, not successful business output', () => {
  const plan = compileNativeSoapEndpoint(fixture());
  const result = decodeNativeSoapResponse(plan, { status: 500, contentType: 'text/xml',
    body: response('<s:Fault xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>s:Server</faultcode><faultstring>Validation rejected</faultstring></s:Fault>') });
  assert.equal(result.successful, false); assert.equal(result.fault.reason, 'Validation rejected');
});

test('SOAP refuses external schemas, DTDs, RPC and integrated authentication before execution', () => {
  assert.throws(() => compileNativeSoapEndpoint(fixture(wsdl.replace('<wsdl:types>', '<wsdl:import location="https://other.test/schema"/><wsdl:types>'))), /soap_external_contract_unsupported/);
  assert.throws(() => compileNativeSoapEndpoint(fixture(wsdl.replace('<?xml version="1.0"?>', '<!DOCTYPE document SYSTEM "file:///C:/private">'))), /soap_xml_invalid/);
  assert.throws(() => compileNativeSoapEndpoint(fixture(wsdl.replace('style="document"', 'style="rpc"'))), /soap_binding_unsupported/);
  const f = fixture(); f.model.tree.properties.IntegratedAuthentication = 'True';
  assert.throws(() => compileNativeSoapEndpoint(f), /^Error: debug_native_endpoint_soap_integrated_authentication_unsupported$/);
  for (const security of ['SSLWithClientCertificates', 'SSL with client certificate']) {
    const g = fixture(); g.model.tree.properties.HTTPSecurity = security;
    assert.throws(() => compileNativeSoapEndpoint(g), /^Error: debug_native_endpoint_soap_client_certificate_unsupported$/);
  }
  const h = fixture(); h.model.tree.properties.HTTPSecurity = 'Unknown';
  assert.throws(() => compileNativeSoapEndpoint(h), /^Error: debug_native_endpoint_soap_native_authentication_unsupported$/);
});

test('SOAP Integrated and client-certificate refusals are typed, aliased and not claimed as platform limits', () => {
  const integrated = nativeSoapAuthenticationRefusal({ IntegratedAuthentication: 'True', HTTPSecurity: 'SSL' });
  assert.equal(integrated.executable, false); assert.equal(integrated.error, 'debug_native_endpoint_soap_integrated_authentication_unsupported');
  assert.equal(integrated.alias, 'debug_native_endpoint_soap_native_authentication_unsupported'); assert.equal(integrated.platformLimitProved, false);
  assert.match(integrated.limitation, /not claimed as a platform limit/);
  const certificate = nativeSoapAuthenticationRefusal({ IntegratedAuthentication: 'False', HTTPSecurity: 'SSLWithClientCertificates' });
  assert.equal(certificate.error, 'debug_native_endpoint_soap_client_certificate_unsupported'); assert.equal(certificate.platformLimitProved, false);
  assert.equal(nativeSoapAuthenticationRefusal({ IntegratedAuthentication: 'False', HTTPSecurity: 'SSL' }), null);
  assert.equal(nativeSoapAuthenticationRefusal({ IntegratedAuthentication: 'False', HTTPSecurity: 'None' }), null);
  // A prepare receipt built from the acquisition refusal carries the same typed code.
  const receipt = nativeSoapAuthenticationRefusalFromError(new Error('debug_native_endpoint_soap_client_certificate_unsupported'));
  assert.equal(receipt.error, 'debug_native_endpoint_soap_client_certificate_unsupported'); assert.equal(receipt.platformLimitProved, false);
  assert.equal(receipt.alias, 'debug_native_endpoint_soap_native_authentication_unsupported');
  assert.equal(nativeSoapAuthenticationRefusalFromError(new Error('debug_native_endpoint_soap_binding_unsupported')), null);
  assert.equal(nativeSoapAuthenticationRefusalFromError(new Error('debug_native_endpoint_source_changed')), null);
});

test('SOAP authentication refusal is typed from the hash-bound model before any documentation or WSDL GET', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-soap-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.oml'); fs.writeFileSync(file, 'synthetic published model');
  for (const [properties, code, kind] of [[{ IntegratedAuthentication: 'True' }, 'soap_integrated_authentication_unsupported', 'SOAPService'],
    [{ HTTPSecurity: 'SSLWithClientCertificates' }, 'soap_client_certificate_unsupported', 'SOAPService'],
    [{ IntegratedAuthentication: 'True' }, 'soap_integrated_authentication_unsupported', 'WebService']]) {
    const f = fixture(); f.binding.sourceSha256 = hash(fs.readFileSync(file)); f.model.sourceSha256 = f.binding.sourceSha256;
    Object.assign(f.model.tree.properties, properties, { URL: '/Store/Orders.asmx?WSDL' });
    if (kind === 'WebService') { f.model.tree.kind = 'WebService'; f.model.tree.children[0].kind = 'WebServiceMethod'; delete f.model.tree.properties.URL; }
    let gets = 0, routes = 0;
    const input = { binding: f.binding, entry: { key: key('b'), path: kind === 'WebService' ? 'WebService:Orders/WebServiceMethod:Find' : 'SOAPService:Orders/SOAPServiceAction:Find' },
      readTree: async () => f.model, sourceContract: { path: file, sha256: f.binding.sourceSha256 } };
    await assert.rejects(acquireNativeSoapEntry(input, { fetchImpl: async () => { gets++; return new Response(wsdl, { headers: { 'Content-Type': 'text/xml' } }); },
      documentationRoute: async () => { routes++; return { url: 'https://dev.example.test/Store/Orders.asmx' }; } }), new RegExp('^Error: debug_native_endpoint_' + code + '$'));
    assert.equal(gets, 0); assert.equal(routes, 0);
  }
});

test('SOAP operation name or input changes cannot silently target another model entry', () => {
  const f = fixture(); f.model.tree.children[0].children[0].name = 'OtherId';
  assert.throws(() => compileNativeSoapEndpoint(f), /soap_model_signature_mismatch/);
  assert.throws(() => compileNativeSoapEndpoint(fixture(wsdl.replace('https://dev.example.test/Store/Orders.asmx', 'https://other.test/Store/Orders.asmx'))), /url_outside_publication/);
  const plan = compileNativeSoapEndpoint(fixture());
  assert.throws(() => buildNativeSoapRequest(plan, { Id: '9223372036854775808' }), /soap_input_type_invalid/);
  assert.throws(() => buildNativeSoapRequest(plan, { Id: 1, Extra: 2 }), /soap_input_object_invalid/);
});

test('SOAP acquisition refuses the missing native WSDL URL before GET and guards the OML hash', async t => {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-soap-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.oml'); fs.writeFileSync(file, 'synthetic published model');
  f.binding.sourceSha256 = hash(fs.readFileSync(file)); f.model.sourceSha256 = f.binding.sourceSha256;
  const input = { binding: f.binding, entry: { key: key('b'), path: 'SOAPService:Orders/SOAPServiceAction:Find' },
    readTree: async () => f.model, sourceContract: { path: file, sha256: f.binding.sourceSha256 } };
  let gets = 0; const services = { fetchImpl: async url => { gets++; assert.equal(url, 'https://dev.example.test/Store/Orders.asmx?WSDL'); return new Response(wsdl, { headers: { 'Content-Type': 'text/xml' } }); } };
  await assert.rejects(acquireNativeSoapEntry(input, services), /soap_published_wsdl_url_unavailable/); assert.equal(gets, 0);
  f.model.tree.properties.URL = '/Store/Orders.asmx?WSDL';
  assert.equal((await acquireNativeSoapEntry(input, services)).plan.entry.entryKey, key('b')); assert.equal(gets, 1);
  fs.writeFileSync(file, 'different published model');
  await assert.rejects(acquireNativeSoapEntry(input, services), /source_changed/); assert.equal(gets, 1);
});

test('Native O11 WebService follows its SDK documentation route and the observed WSDL link', async t => {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-soap-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.oml'); fs.writeFileSync(file, 'synthetic legacy service transport source');
  f.binding.sourceSha256 = hash(fs.readFileSync(file)); f.model.sourceSha256 = f.binding.sourceSha256;
  f.model.tree.kind = 'WebService'; f.model.tree.children[0].kind = 'WebServiceMethod';
  const calls = [], page = 'https://dev.example.test/Store/Orders.asmx';
  const input = { binding: f.binding, entry: { key: key('b'), path: 'WebService:Orders/WebServiceMethod:Find' },
    readTree: async selector => { assert.equal(selector, 'WebService:Orders'); return f.model; },
    sourceContract: { path: file, sha256: f.binding.sourceSha256 } };
  const services = { documentationRoute: async (binding, service) => {
      assert.equal(binding.moduleKey, key('a')); assert.equal(service.key, key('c'));
      return { url: page, source: 'qualified-native-command' };
    }, fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.redirect, 'error');
      return url === page ? new Response('<a href="Orders.asmx?WSDL">Service Description</a>', { headers: { 'Content-Type': 'text/html' } })
        : new Response(wsdl, { headers: { 'Content-Type': 'text/xml' } }); } };
  const acquired = await acquireNativeSoapEntry(input, services);
  assert.deepEqual(calls, [page, page + '?WSDL']); assert.equal(acquired.plan.entry.entryKey, key('b'));
  assert.equal(acquired.contract.source.documentation.source, 'qualified-native-command');
  services.fetchImpl = async () => new Response('<a href="https://external.example/Orders.asmx?WSDL">External</a>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(acquireNativeSoapEntry(input, services), /soap_contract_ambiguous/);
});

test('Published native O11 WSDL supports operation-level document style and zero-input process launch', () => {
  const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-probe-native-soap.json', import.meta.url), 'utf8'));
  const body = fs.readFileSync(new URL('./fixtures/debug-o11-probe-published.wsdl', import.meta.url), 'utf8');
  const binding = {lane:'o11', module:'SSAMDebuggerProbe', moduleKey:'bf7WCuRy7keTqvquautTGg', revision:5871,
    runtimeUrl:'https://personal-2qqw9srv.outsystemscloud.com/SSAMDebuggerProbe/', sourceSha256:captured.provenance.sourceSha256};
  const contract = {binding, model:{schema:'ssam-reading/1',model:binding.module,sourceSha256:binding.sourceSha256,tree:captured.tree},
    source:{url:binding.runtimeUrl+'ProbeSoap.asmx?WSDL',body,sha256:hash(body)}};
  const scalar = compileNativeSoapEndpoint({...contract,entryKey:'IGaRHxKOTEC3z3BtAfC2PA'});
  assert.equal(scalar.request.namespace,'http://www.outsystems.com');
  assert.match(buildNativeSoapRequest(scalar,{Value:41}).body, /<Value xmlns="http:\/\/www.outsystems.com">41<\/Value>/);
  const launch = compileNativeSoapEndpoint({...contract,entryKey:'1SRyqiLD50mFgo7lwxBa3A'});
  assert.deepEqual(launch.request.fields, []); assert.deepEqual(launch.response.fields.map(f=>f.name),['ProcessId']);
  assert.match(buildNativeSoapRequest(launch,{}).body, /<LaunchProcess xmlns="http:\/\/www.outsystems.com"><\/LaunchProcess>/);
  const invalidBody = body.replaceAll('style="document"','style="rpc"');
  assert.throws(()=>compileNativeSoapEndpoint({...contract,entryKey:'IGaRHxKOTEC3z3BtAfC2PA',source:{...contract.source,body:invalidBody,sha256:hash(invalidBody)}}), /soap_binding_unsupported/);
});

// ---- app-level header credential read inside the exposed WebServiceMethod flow (O11 SOAP has no OnAuthentication) ----
const SOAP_SECRET = 'synthetic-soap-header-value';
const guarded = (flow = [customHeader('"X-Api-Key"', 'h', '1')], text = wsdl) => fixture(text, flow);

test('SOAP method reading a literal request header qualifies for the endpoint-credential context', () => {
  for (const legacy of [false, true]) {
    const f = guarded([customHeader('"X-Api-Key"', 'h', '1'), customCall(null, 'DoWork', 'w'),
      customCall('Users', 'User_Login', 'u', [customArgument('Username', '"svc"', '2', 'Reference:Users/ServerActionSignature:User_Login')])]);
    if (legacy) { f.model.tree.kind = 'WebService'; f.model.tree.children[0].kind = 'WebServiceMethod'; }
    const plan = compileNativeSoapEndpoint(f);
    assert.equal(plan.authentication.native, 'None'); assert.equal(plan.authentication.protocol, 'header');
    assert.deepEqual(plan.authentication.custom.headers, [{ name: 'X-Api-Key', required: true }]);
    assert.equal(plan.authentication.custom.serviceKey, key('c')); assert.equal(plan.authentication.custom.methodKey, key('b'));
    assert.equal(plan.authentication.custom.callsLogin, true); assert.equal(plan.authentication.appUserIdentityProved, false);
    const capability = nativeEndpointAuthenticationCapability(plan);
    assert.equal(capability.executable, true); assert.equal(capability.requiredContext, 'endpoint-credential');
    assert.deepEqual(capability.headers, ['X-Api-Key']); assert.equal(capability.source, 'published WebServiceMethod flow');
  }
  // A method that reads no request header keeps the anonymous contract.
  assert.equal(compileNativeSoapEndpoint(fixture()).authentication.protocol, 'none');
});

test('SOAP computed, reserved or ambiguous header reads stay a typed refusal, never anonymous', () => {
  for (const [flow, reason] of [
    [[customHeader('"X-" + Suffix', 'h', '1')], 'header_name_computed'],
    [[customHeader('"SOAPAction"', 'h', '1')], 'header_collision'],
    [[customHeader('"Authorization"', 'h', '1')], 'authorization_scheme_ambiguous'],
    [[customHeader('"Cookie"', 'h', '1')], 'cookie_unsupported'],
    [[customCall('HTTPRequestHandler', 'GetRequestContent', 'h')], 'query_or_body_unsupported'],
  ]) {
    const plan = compileNativeSoapEndpoint(guarded(flow));
    assert.equal(plan.authentication.protocol, 'header'); assert.equal(plan.authentication.custom, null);
    const capability = nativeEndpointAuthenticationCapability(plan);
    assert.equal(capability.executable, false); assert.equal(capability.error, 'debug_native_endpoint_custom_authentication_unqualified');
    assert.equal(capability.reason, 'debug_native_endpoint_custom_authentication_' + reason);
  }
});

function soapEndpointFixture(t) {
  const f = guarded(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-soap-credential-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiresAt = new Date(Date.now() + 60000).toISOString(), operationId = randomUUID();
  const binding = endpointCredentialBinding({ ...f.binding, serviceKey: key('c'), headers: ['X-Api-Key'] }, 'f'.repeat(32));
  const descriptor = { credentialRef: randomUUID(), binding, expiresAt, kind: 'endpoint-credential' };
  const record = { ok: true, kind: 'endpoint-credential', binding, expiresAt, headers: [{ name: 'X-Api-Key', value: SOAP_SECRET }] };
  const input = { root, directory: path.join(root, '.local', 'debugger', operationId), operationId, scenarioId: 'one', timeoutSeconds: 2,
    protocol: 'soap', contract: f, inputs: { Id: 1 }, context: 'endpoint-credential', descriptor };
  const opened = [];
  return { input, opened, vault: async mode => { assert.equal(mode, 'read'); const copy = structuredClone(record); opened.push(copy); return copy; } };
}

test('SOAP endpoint credential header is sent once from the vault and never reaches the receipt', async t => {
  const f = soapEndpointFixture(t); let requests = 0;
  const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async (url, request) => {
    requests++; assert.equal(url, 'https://dev.example.test/Store/Orders.asmx'); assert.equal(request.headers['X-Api-Key'], SOAP_SECRET);
    assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Content-Type', 'SOAPAction', 'X-Api-Key']);
    // The value is an HTTP header only: no SOAP envelope header and never in the body.
    assert.ok(!request.body.includes(SOAP_SECRET)); assert.ok(!/Header/.test(request.body));
    return new Response(response('<FindResponse xmlns="urn:example:orders"><Id>1</Id><Label>echo ' + SOAP_SECRET + '</Label></FindResponse>'),
      { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
  } });
  assert.equal(result.ok, true, result.error); assert.equal(requests, 1);
  assert.equal(result.authentication.protocol, 'header'); assert.equal(result.authentication.context, 'endpoint-credential');
  assert.equal(result.authentication.credentialsFromPrivateDialog, true); assert.deepEqual(result.authentication.endpointHeaders, ['X-Api-Key']);
  assert.equal(result.result.outputs.Label, 'echo [private]'); assert.equal(f.opened[0].headers[0].value, '');
  assert.ok(!JSON.stringify(result).includes(SOAP_SECRET));
  assert.ok(!fs.readFileSync(path.join(f.input.directory, 'endpoint-one.json'), 'utf8').includes(SOAP_SECRET));
  const repeated = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async () => { requests++; } });
  assert.equal(repeated.error, 'debug_native_endpoint_already_submitted'); assert.equal(requests, 1);
});

test('SOAP header credential refuses JSON values, the anonymous context and an unqualified read before any send', async t => {
  const f = soapEndpointFixture(t), services = { vault: f.vault, fetchImpl: async () => assert.fail('must not send') };
  for (const field of ['headers', 'credentials', 'endpointCredential', 'privateValues'])
    await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, [field]: { 'X-Api-Key': 'synthetic' } }, services), /private_value_in_request/);
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, inputs: { Id: 1, 'X-Api-Key': 'synthetic' } }, services), /soap_input_object_invalid/);
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, context: 'explicit-anonymous', descriptor: undefined }, services), /context_explicit_required/);
  const computed = guarded([customHeader('"X-" + Suffix', 'h', '1')]);
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, contract: computed }, services), /custom_authentication_unqualified/);
  assert.equal(f.opened.length, 0);
});

test('WS-Security SOAP headers and security policies stay refused with a header credential', () => {
  const header = wsdl.replace('<wsdl:input><soap:body use="literal"/></wsdl:input>',
    '<wsdl:input><soap:header message="tns:FindInput" part="parameters" use="literal"/><soap:body use="literal"/></wsdl:input>');
  assert.throws(() => compileNativeSoapEndpoint(guarded(undefined, header)), /soap_binding_unsupported/);
  const policy = wsdl.replace('<wsdl:types>', '<wsp:Policy xmlns:wsp="http://www.w3.org/ns/ws-policy" xmlns:sp="http://docs.oasis-open.org/ws-sx/ws-securitypolicy/200702"><sp:TransportBinding/></wsp:Policy><wsdl:types>');
  assert.throws(() => compileNativeSoapEndpoint(guarded(undefined, policy)), /^Error: debug_native_endpoint_soap_ws_security_unsupported$/);
  const reference = wsdl.replace('<soap:binding ', '<wsp:PolicyReference xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy" URI="#P"/><soap:binding ');
  assert.throws(() => compileNativeSoapEndpoint(fixture(reference)), /soap_ws_security_unsupported/);
  const plan = compileNativeSoapEndpoint(guarded());
  assert.ok(!/Header|Security/.test(buildNativeSoapRequest(plan, { Id: 1 }).body));
});

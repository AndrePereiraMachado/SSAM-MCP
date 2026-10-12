import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { compileNativeRestEndpoint, buildNativeEndpointRequest, decodeNativeEndpointResponse, nativeSoapEndpointCapability } from '../debug-native-endpoint.mjs';
import { invokePrivateNativeEndpoint, invokeNativeEndpointWorker, recoverNativeEndpointMarker, nativeEndpointAuthenticationCapability, nativeEndpointRequestBudget } from '../debug-native-endpoint-worker.mjs';
import { canonicalizeInputs } from '../debug-odc-native-types.mjs';
import { endpointCredentialBinding } from '../debug-app-user.mjs';
import { customFixture, node as customNode, header as customHeader } from './fixtures/debug-native-custom-fixture.mjs';
import { basicFixture, guardFixture, userLogin, developerCheck, start as flowStart, end as flowEnd } from './fixtures/debug-native-basic-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const key = c => c.repeat(22), operationId = '11111111-2222-4333-8444-555555555555';
function node(kind, name, properties = {}, children = [], id = 'd') {
  return { kind, name, key: key(id), properties, children, childrenTotal: children.length, childrenOmitted: 0,
    propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] };
}
function fixture() {
  const binding = { lane: 'o11', module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: 'e'.repeat(64), runtimeUrl: 'https://dev.example.test/Store/' };
  const action = node('RestServiceAction', 'Update', { URL: '/Store/rest/Orders/{Id}', HTTPMethod: 'POST' }, [
    node('RestServiceActionInput', 'OrderId', { ReceiveAs: 'Id', ReceiveIn: 'URL', IsMandatory: 'True', DataType: 'Long Integer' }, [], 'i'),
    node('RestServiceActionInput', 'Labels', { ReceiveAs: 'label', ReceiveIn: 'URL', IsMandatory: 'False' }, [], 'j'),
    node('RestServiceActionInput', 'Request', { ReceiveIn: 'Body', IsMandatory: 'True' }, [], 'k'),
    node('RestServiceActionOutput', 'Result', { SendIn: 'Body', SendAs: 'Result' }, [], 'l'),
  ], 'b');
  const model = { schema: 'ssam-reading/1', model: 'Store', sourceSha256: binding.sourceSha256,
    tree: node('RestService', 'Orders', { URL: '/Store/rest/Orders', Authentication: 'Basic' }, [action], 'c') };
  const document = { swagger: '2.0', host: 'dev.example.test', basePath: '/Store/rest/Orders', schemes: ['https'],
    consumes: ['application/json'], produces: ['application/json'], securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }],
    paths: { '/{Id}': { post: { operationId: 'Update', parameters: [
      { in: 'path', name: 'Id', required: true, type: 'integer', format: 'int64' },
      { in: 'query', name: 'label', required: false, type: 'array', collectionFormat: 'multi', items: { type: 'string' } },
      { in: 'body', name: 'Request', required: true, schema: { $ref: '#/definitions/Order' } },
    ], responses: { 200: { description: 'OK', schema: { $ref: '#/definitions/Order' } }, 401: { description: 'Unauthorized', schema: { type: 'object', properties: { Message: { type: 'string' } } } } } } } },
    definitions: { Order: { type: 'object', required: ['Amount', 'Id'], properties: { Amount: { type: 'number' }, Id: { type: 'integer', format: 'int64' } } } } };
  const contract = () => { const body = JSON.stringify(document); return { binding, model, entryKey: key('b'), source: { url: binding.runtimeUrl + 'rest/Orders/swagger.json', body, sha256: sha(body) } }; };
  return { binding, action, model, document, contract };
}

test('REST declared text/plain scalar outputs preserve text, false, zero and exact numbers', () => {
  for (const [schema, body, expected] of [
    [{type:'string'}, '  false\n', '  false\n'], [{type:'string'}, '', ''],
    [{type:'boolean'}, 'false', false], [{type:'integer',format:'int32'}, '0', 0],
    [{type:'integer',format:'int64'}, '9223372036854775807', '9223372036854775807'],
    [{type:'number'}, '0.123456789012345678901', '0.123456789012345678901'],
  ]) {
    const f=fixture();f.document.produces=['text/plain'];
    f.document.paths['/{Id}'].post.responses={200:{description:'OK',schema}};
    const plan=compileNativeRestEndpoint(f.contract());
    assert.equal(buildNativeEndpointRequest(plan,{OrderId:1,Request:{Amount:1,Id:2}}).headers.Accept,'text/plain');
    assert.equal(decodeNativeEndpointResponse(plan,{status:200,contentType:'text/plain; charset=utf-8',body}).outputs.Result,expected);
    assert.throws(()=>decodeNativeEndpointResponse(plan,{status:200,contentType:'text/html',body}),/content_type_mismatch/);
  }
});
test('REST text/plain requires a declared scalar contract and rejects coercion',()=>{
  const f=fixture();f.document.produces=['text/plain'];
  assert.throws(()=>compileNativeRestEndpoint(f.contract()),/content_type_unsupported/);
  f.document.paths['/{Id}'].post.responses={200:{description:'OK',schema:{type:'boolean'}}};
  const plan=compileNativeRestEndpoint(f.contract());
  for(const body of ['"false"','0','null','<html/>']) assert.throws(()=>decodeNativeEndpointResponse(plan,{status:200,contentType:'text/plain',body}),/response_(schema_mismatch|json_invalid)/);
  f.document.paths['/{Id}'].post.responses[200].schema={type:'number'};
  const numeric=compileNativeRestEndpoint(f.contract());
  for(const body of ['"1"','01','+1','null',''])assert.throws(()=>decodeNativeEndpointResponse(numeric,{status:200,contentType:'text/plain',body}),/response_schema_mismatch/);
});
test('OpenAPI 3 selects the declared text/plain response schema',()=>{
  const f=fixture(),operation=f.document.paths['/{Id}'].post,bodySchema=f.document.definitions.Order;
  const post={
    parameters:operation.parameters.filter(p=>p.in!=='body').map(p=>({...p,schema:p.in==='path'?{type:'integer',format:'int64'}:{type:'array',items:{type:'string'}}})),
    requestBody:{required:true,content:{'application/json':{schema:bodySchema}}},
    responses:{200:{description:'OK',content:{'text/plain':{schema:{type:'boolean'}}}}},
  };
  for(const key of Object.keys(f.document))delete f.document[key];
  Object.assign(f.document,{openapi:'3.0.3',servers:[{url:'https://dev.example.test/Store/rest/Orders'}],
    components:{securitySchemes:{basic:{type:'http',scheme:'basic'}}},security:[{basic:[]}],paths:{'/{Id}':{post}}});
  const plan=compileNativeRestEndpoint(f.contract());
  assert.equal(plan.responses['200'].mediaType,'text/plain');
  assert.equal(decodeNativeEndpointResponse(plan,{status:200,contentType:'text/plain',body:'true'}).outputs.Result,true);
});
test('REST serializes the original route and lossless Int64s with native input names', () => {
  const f = fixture(), plan = compileNativeRestEndpoint(f.contract());
  const request = buildNativeEndpointRequest(plan, { OrderId: '9223372036854775807', Labels: ['A/B', 'two words'], Request: { Amount: 1.5, Id: '9223372036854775807' } });
  assert.equal(request.url, 'https://dev.example.test/Store/rest/Orders/9223372036854775807?label=A%2FB&label=two+words');
  assert.equal(request.body, '{"Amount":1.5,"Id":9223372036854775807}');
  assert.equal(request.method, 'POST'); assert.equal(request.headers.Authorization, undefined);
  assert.equal(plan.authentication.appUserIdentityProved, false);
});

test('matching display names cannot override a different model URL, verb or snapshot', () => {
  const f = fixture(); f.action.properties.URL = '/Store/rest/Orders/Other';
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /model_openapi_route_mismatch/);
  f.action.properties.URL = '/Store/rest/Orders/{Id}'; f.action.properties.HTTPMethod = 'DELETE';
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /model_openapi_route_mismatch/);
  f.action.properties.HTTPMethod = 'POST'; f.model.sourceSha256 = 'f'.repeat(64);
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /model_binding_invalid/);
});

test('REST refuses a changed source, incomplete model, foreign host and native/OpenAPI auth mismatch', () => {
  const f = fixture(), broken = f.contract(); broken.source.body += ' ';
  assert.throws(() => compileNativeRestEndpoint(broken), /source_changed/);
  f.model.tree.childrenOmitted = 1;
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /model_incomplete/);
  f.model.tree.childrenOmitted = 0; f.document.host = 'other.example.test';
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /url_outside_publication/);
  f.document.host = 'dev.example.test'; f.document.security = [];
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /model_openapi_auth_mismatch/);
});

test('OpenAPI refs stay local and parameter locations agree with the model', () => {
  const f = fixture(); f.document.definitions.Order = { $ref: 'https://elsewhere.test/schema.json' };
  assert.throws(() => compileNativeRestEndpoint(f.contract()), /reference_unsupported/);
  const g = fixture(); g.action.children[0].properties.ReceiveIn = 'Header';
  assert.throws(() => compileNativeRestEndpoint(g.contract()), /model_openapi_input_mismatch/);
  const h = fixture(); h.document.definitions.Order.properties.Parent = { $ref: '#/definitions/Order' };
  assert.throws(() => compileNativeRestEndpoint(h.contract()), /recursive_schema_unsupported/);
});

test('bad business inputs cannot inject headers or bypass original required fields', () => {
  const plan = compileNativeRestEndpoint(fixture().contract());
  assert.throws(() => buildNativeEndpointRequest(plan, { OrderId: 'x', Request: { Amount: 1, Id: 2 } }), /input_integer_invalid/);
  assert.throws(() => buildNativeEndpointRequest(plan, { OrderId: 1 }), /input_required/);
  assert.throws(() => buildNativeEndpointRequest(plan, { OrderId: 1, Request: { Amount: 1, Id: 2 }, Authorization: 'override' }), /input_unknown/);
  assert.throws(() => buildNativeEndpointRequest(plan, { OrderId: 1, Request: { Amount: 1, Id: '9223372036854775808' } }), /input_integer_invalid/);
});

test('REST responses preserve Int64 and map the native output without claiming identity', () => {
  const plan = compileNativeRestEndpoint(fixture().contract());
  const result = decodeNativeEndpointResponse(plan, { status: 200, contentType: 'application/json; charset=utf-8', body: '{"Amount":1.5,"Id":9223372036854775807}' });
  assert.equal(result.outputs.Result.Id, '9223372036854775807');
  assert.throws(() => decodeNativeEndpointResponse(plan, { status: 200, contentType: 'application/json', body: '{"Amount":1}' }), /response_schema_mismatch/);
  assert.throws(() => decodeNativeEndpointResponse(plan, { status: 200, contentType: 'text/html', body: '{}' }), /response_content_type_mismatch/);
  assert.equal(decodeNativeEndpointResponse(plan, { status: 401, contentType: 'application/json', body: '{"Message":"Denied"}' }).successful, false);
});

test('ODC canonical Decimal/Currency and Identifier strings serialize as exact native JSON numbers', () => {
  const f = fixture(); f.binding.lane = 'odc';
  f.document.paths['/{Id}'].post.parameters[0].format = 'int32';
  f.document.definitions.Order.properties.Amount.format = 'decimal';
  f.document.definitions.Order.properties.Price = { type: 'number', format: 'decimal' };
  f.document.definitions.Order.required.push('Price');
  const amount = '12345678901234567890.123456789', price = '0.0000000000000000000000000001';
  const canonical = canonicalizeInputs({ OrderId: '2147483647', Request: { Amount: amount, Price: price, Id: '9223372036854775807' } }, [
    { name: 'OrderId', dataType: 'Identifier', mandatory: true },
    { name: 'Request', dataType: 'Record', mandatory: true, fields: [
      { name: 'Amount', dataType: 'Decimal', mandatory: true }, { name: 'Price', dataType: 'Currency', mandatory: true },
      { name: 'Id', dataType: 'Long Integer', mandatory: true },
    ] },
  ]);
  const inputs = Object.fromEntries(Object.entries(canonical).map(([name, value]) => [name, value.value]));
  const request = buildNativeEndpointRequest(compileNativeRestEndpoint(f.contract()), inputs);
  assert.equal(request.url, 'https://dev.example.test/Store/rest/Orders/2147483647');
  assert.equal(request.body, '{"Amount":12345678901234567890.123456789,"Price":0.0000000000000000000000000001,"Id":9223372036854775807}');
  assert.throws(() => buildNativeEndpointRequest(compileNativeRestEndpoint(f.contract()), { ...inputs, OrderId: '2147483648' }), /input_number_out_of_range/);
});

test('REST decimal bounds and numeric enums compare the exact value, including lossless OpenAPI bounds', () => {
  const f = fixture();
  f.document.definitions.Order.properties.Amount = { type: 'number', minimum: '__minimum__', maximum: '__maximum__' };
  const contract = f.contract();
  contract.source.body = contract.source.body.replace('"__minimum__"', '9007199254740992.125').replace('"__maximum__"', '9007199254740992.126');
  contract.source.sha256 = sha(contract.source.body);
  const plan = compileNativeRestEndpoint(contract), request = amount => buildNativeEndpointRequest(plan, { OrderId: 1, Request: { Amount: amount, Id: 2 } });
  assert.match(request('9007199254740992.1255').body, /"Amount":9007199254740992\.1255/);
  assert.throws(() => request('9007199254740992.124999999999999999'), /input_number_out_of_range/);
  assert.throws(() => request('9007199254740992.126000000000000001'), /input_number_out_of_range/);
  assert.match(request('09007199254740992.1250').body, /"Amount":9007199254740992\.1250/);
  const g = fixture(); g.document.definitions.Order.properties.Amount = { type: 'number', enum: [1.5], minimum: 1.5, exclusiveMinimum: true };
  assert.throws(() => buildNativeEndpointRequest(compileNativeRestEndpoint(g.contract()), { OrderId: 1, Request: { Amount: '1.500', Id: 2 } }), /input_number_out_of_range/);
  delete g.document.definitions.Order.properties.Amount.exclusiveMinimum;
  assert.match(buildNativeEndpointRequest(compileNativeRestEndpoint(g.contract()), { OrderId: 1, Request: { Amount: '1.500', Id: 2 } }).body, /"Amount":1\.500/);
});

test('REST output decimals preserve raw source when JSON Number would lose precision', () => {
  const plan = compileNativeRestEndpoint(fixture().contract());
  const result = decodeNativeEndpointResponse(plan, { status: 200, contentType: 'application/json',
    body: '{"Amount":0.1234567890123456789012345678,"Id":9223372036854775807}' });
  assert.equal(result.outputs.Result.Amount, '0.1234567890123456789012345678');
  assert.equal(result.outputs.Result.Id, '9223372036854775807');
  const exponent = decodeNativeEndpointResponse(plan, { status: 200, contentType: 'application/json',
    body: '{"Amount":1.234567890123456789e-12,"Id":2}' });
  assert.equal(exponent.outputs.Result.Amount, '1.234567890123456789e-12');
  assert.equal(decodeNativeEndpointResponse(plan, { status: 200, contentType: 'application/json', body: '{"Amount":1.5,"Id":2}' }).outputs.Result.Amount, 1.5);
});

test('decimal strings reject JSON injection and have bounded coefficient/exponent size', () => {
  const plan = compileNativeRestEndpoint(fixture().contract());
  const request = value => buildNativeEndpointRequest(plan, { OrderId: 1, Request: { Amount: value, Id: 2 } });
  for (const value of ['1,"Id":4', 'NaN', 'Infinity', '1e9999', '1'.repeat(257), ' 1.0', '+1.0'])
    assert.throws(() => request(value), /input_number_invalid/);
  assert.match(request('001.2300').body, /"Amount":1\.2300/);
});

test('Custom REST and ODC Basic credentials are not replaced with an assumed app-user bearer', () => {
  const f = fixture(); f.model.tree.properties.Authentication = 'Custom';
  const unqualified = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(f.contract()));
  assert.equal(unqualified.executable, false); assert.equal(unqualified.requiredContext, undefined);
  assert.equal(unqualified.error, 'debug_native_endpoint_custom_authentication_unqualified');
  assert.equal(unqualified.reason, 'debug_native_endpoint_custom_authentication_callback_missing');
  const g = fixture(); g.binding.lane = 'odc';
  const odc = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(g.contract()));
  assert.equal(odc.executable, false); assert.equal(odc.error, 'debug_native_endpoint_odc_basic_unqualified');
  assert.equal(odc.alias, 'debug_native_endpoint_basic_credentials_unavailable_after_odc_srp');
  assert.equal(odc.policy, 'ssam'); assert.equal(odc.platformLimit, false);
  assert.match(odc.limitation, /SSAM policy/); assert.match(odc.limitation, /not a platform limit/);
  assert.equal(odc.reason, 'debug_native_endpoint_basic_callback_missing'); // a capture without OnAuthentication stays unqualified
  assert.equal(nativeSoapEndpointCapability({ kind: 'SOAPAction' }, 'odc').error, 'debug_native_endpoint_consumed_soap_requires_original_caller');
});

test('Custom REST requires endpoint-credential context only for a qualified published OnAuthentication contract', () => {
  const c = customFixture(), plan = compileNativeRestEndpoint(c.contract());
  assert.equal(plan.authentication.native, 'Custom'); assert.equal(plan.authentication.protocol, 'custom');
  assert.deepEqual(plan.authentication.custom.headers, [{ name: 'X-Api-Key', required: true }]);
  const qualified = nativeEndpointAuthenticationCapability(plan);
  assert.equal(qualified.executable, true); assert.equal(qualified.requiredContext, 'endpoint-credential');
  assert.deepEqual(qualified.headers, ['X-Api-Key']); assert.equal(qualified.callsLogin, true);
  assert.equal(qualified.appUserIdentityProved, false);
  // OpenAPI may restate the same header scheme; another scheme is not the published contract.
  c.document.securityDefinitions = { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }; c.document.security = [{ key: [] }];
  assert.equal(nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(c.contract())).requiredContext, 'endpoint-credential');
  for (const scheme of [{ type: 'basic' }, { type: 'apiKey', in: 'query', name: 'X-Api-Key' }, { type: 'apiKey', in: 'header', name: 'X-Other' }]) {
    c.document.securityDefinitions = { key: scheme };
    const refused = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(c.contract()));
    assert.equal(refused.executable, false); assert.equal(refused.reason, 'debug_native_endpoint_custom_authentication_openapi_mismatch');
  }
  // A business header input with the credential's name would let request JSON override the private value.
  const collision = customFixture();
  collision.action.children.push(customNode('RestServiceActionInput', 'Key', { ReceiveIn: 'Header', ReceiveAs: 'X-Api-Key', IsMandatory: 'False' }, [], 'k'));
  collision.action.childrenTotal++;
  collision.document.paths['/Echo'].post.parameters.push({ in: 'header', name: 'X-Api-Key', required: false, type: 'string' });
  assert.equal(nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(collision.contract())).reason, 'debug_native_endpoint_custom_authentication_header_collision');
  const unqualified = customFixture({ flow: [customHeader('"Authorization"', 'h')] });
  assert.equal(nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(unqualified.contract())).reason, 'debug_native_endpoint_custom_authentication_authorization_scheme_ambiguous');
  const odc = customFixture({ lane: 'odc' });
  assert.equal(nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(odc.contract())).reason, 'debug_native_endpoint_custom_authentication_request_header_api_unqualified');
});

function endpointFixture(t) {
  const c = customFixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-custom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const binding = endpointCredentialBinding({ ...c.binding, serviceKey: key('c'), headers: ['X-Api-Key'] }, 'f'.repeat(32));
  const descriptor = { credentialRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', binding, expiresAt, kind: 'endpoint-credential' };
  const record = { ok: true, kind: 'endpoint-credential', binding, expiresAt, headers: [{ name: 'X-Api-Key', value: 'synthetic-endpoint-secret' }] };
  const input = { root, directory: path.join(root, '.local', 'debugger', operationId), operationId, scenarioId: 'one', timeoutSeconds: 2,
    contract: c.contract(), inputs: { Value: 'hello' }, context: 'endpoint-credential', descriptor };
  const opened = [];
  return { ...c, root, input, record, opened, vault: async mode => { assert.equal(mode, 'read'); const copy = structuredClone(record); opened.push(copy); return copy; } };
}

test('Custom endpoint sends exactly the declared private headers once and zeroes them afterwards', async t => {
  const f = endpointFixture(t); let requests = 0;
  const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async (url, request) => {
    requests++; assert.equal(request.headers['X-Api-Key'], 'synthetic-endpoint-secret');
    assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Content-Type', 'X-Api-Key']);
    return Response.json('echo synthetic-endpoint-secret');
  } });
  assert.equal(result.ok, true, result.error); assert.equal(requests, 1);
  assert.equal(result.authentication.context, 'endpoint-credential'); assert.equal(result.authentication.credentialsFromPrivateDialog, true);
  assert.deepEqual(result.authentication.endpointHeaders, ['X-Api-Key']); assert.equal(result.authentication.appUserIdentityProved, false);
  assert.equal(result.result.outputs.Result, 'echo [private]'); assert.equal(result.memoryReferencesReleased, true);
  assert.equal(f.opened[0].headers[0].value, '');
  assert.ok(!JSON.stringify(result).includes('synthetic-endpoint-secret'));
  assert.ok(!fs.readFileSync(path.join(f.input.directory, 'endpoint-one.json'), 'utf8').includes('synthetic-endpoint-secret'));
  const repeated = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async () => { requests++; return Response.json('x'); } });
  assert.equal(repeated.error, 'debug_native_endpoint_already_submitted'); assert.equal(requests, 1);
});

test('endpoint credentials bound elsewhere, expired, malformed or of another kind are refused before send', async t => {
  for (const patch of [
    f => { f.input.descriptor.binding = { ...f.input.descriptor.binding, serviceKey: key('z') }; },
    f => { f.input.descriptor.binding = { ...f.input.descriptor.binding, headers: ['X-Other'] }; },
    f => { f.input.descriptor.binding = { ...f.input.descriptor.binding, revision: 41 }; },
    f => { f.input.descriptor.expiresAt = new Date(Date.now() - 1000).toISOString(); },
    f => { f.record.binding = { ...f.record.binding, sessionId: 'e'.repeat(32) }; },
    f => { f.record.expiresAt = new Date(Date.now() - 1000).toISOString(); },
    f => { f.record.kind = 'credentials'; },
    f => { f.record.headers = [{ name: 'X-Other', value: 'synthetic' }]; },
    f => { f.record.headers = [{ name: 'X-Api-Key', value: 'synthetic\r\nInjected: 1' }]; },
  ]) {
    const f = endpointFixture(t); patch(f); let requests = 0;
    const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async () => { requests++; return Response.json('x'); } });
    assert.equal(result.ok, false); assert.equal(result.sent, false); assert.equal(requests, 0);
    assert.match(result.error, /^debug_native_endpoint_credential_(scope_mismatch|unavailable)$/);
    const locks = path.join(f.root, '.local', 'debugger', 'native-endpoint-bindings');
    assert.equal(fs.existsSync(locks) ? fs.readdirSync(locks).length : 0, 0);
  }
});

test('a Custom plan needs the endpoint-credential context; request JSON never carries header values', async t => {
  const f = endpointFixture(t), services = { vault: f.vault, fetchImpl: async () => assert.fail('must not send') };
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, context: 'app-user' }, services), /context_explicit_required/);
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, context: 'explicit-anonymous', descriptor: undefined }, services), /context_explicit_required/);
  for (const field of ['headers', 'credentials', 'endpointCredential', 'privateValues'])
    await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, [field]: { 'X-Api-Key': 'synthetic' } }, services), /private_value_in_request/);
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, inputs: { Value: 'hello', 'X-Api-Key': 'synthetic' } }, services), /input_unknown/);
  const now = Date.now(), lease = { context: 'endpoint-credential', timeoutSeconds: 30, contract: { binding: { lane: 'o11' } },
    inspectionExpiresAt: new Date(now + 45000).toISOString(), descriptor: { expiresAt: new Date(now + 60000).toISOString() } };
  assert.equal(nativeEndpointRequestBudget(lease, now), 45000);
  assert.throws(() => nativeEndpointRequestBudget({ ...lease, descriptor: { expiresAt: new Date(now + 40000).toISOString() } }, now), /inspection_deadline_invalid/);
});

test('a lost Custom reply stays uncertain, keeps the binding lock and still zeroes the private header', async t => {
  const f = endpointFixture(t); let requests = 0;
  const first = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async () => { requests++; throw new Error('synthetic-endpoint-secret'); } });
  assert.equal(first.state, 'uncertain'); assert.equal(first.bindingLockRetained, true); assert.equal(f.opened[0].headers[0].value, '');
  assert.ok(!JSON.stringify(first).includes('synthetic-endpoint-secret'));
  const repeat = await invokePrivateNativeEndpoint({ ...f.input, scenarioId: 'two' }, { vault: f.vault, fetchImpl: async () => { requests++; } });
  assert.equal(repeat.error, 'debug_native_endpoint_binding_blocked'); assert.equal(requests, 1);
});

function privateFixture(t) {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-rest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = { ...f.binding, app: 'Store', sessionId: 'f'.repeat(32) };
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const descriptor = { credentialRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', binding, expiresAt };
  const record = { ok: true, kind: 'credentials', binding, expiresAt, username: 'synthetic-user', password: 'synthetic-private' };
  const input = { root, directory: path.join(root, '.local', 'debugger', operationId), operationId, scenarioId: 'one', timeoutSeconds: 2,
    contract: f.contract(), inputs: { OrderId: 1, Request: { Amount: 1, Id: 2 } }, context: 'app-user', descriptor };
  return { ...f, root, input, vault: async () => ({ ...record }), record };
}

test('private Basic sends exactly once and keeps authentication distinct from UID/roles evidence', async t => {
  const f = privateFixture(t); let requests = 0;
  const services = { vault: f.vault, fetchImpl: async (url, request) => {
    requests++; assert.equal(request.headers.Authorization, 'Basic ' + Buffer.from('synthetic-user:synthetic-private').toString('base64'));
    assert.equal(request.redirect, 'error');
    return Response.json({ Amount: 1, Id: 2 });
  } };
  const result = await invokePrivateNativeEndpoint(f.input, services);
  assert.equal(result.ok, true); assert.equal(result.authentication.credentialsFromPrivateDialog, true);
  assert.equal(result.authentication.appUserIdentityProved, false); assert.equal(result.authentication.rolesProved, false);
  assert.equal(result.authentication.propagationProved, false); assert.equal(result.memoryReferencesReleased, true);
  assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  const repeated = await invokePrivateNativeEndpoint(f.input, services);
  assert.equal(repeated.error, 'debug_native_endpoint_already_submitted'); assert.equal(requests, 1);
});

test('a child finalization refusal recovers its pinned durable answer without another request or marker mutation', async t => {
  const f=privateFixture(t);let requests=0;
  const answered=await invokePrivateNativeEndpoint(f.input,{vault:f.vault,fetchImpl:async()=>{requests++;return Response.json({Amount:1,Id:2});}});
  assert.equal(answered.answered,true);
  const file=path.join(f.input.directory,'endpoint-one.json'),marker={...answered};delete marker.bindingLockRetained;
  fs.writeFileSync(file,JSON.stringify(marker));const before=fs.readFileSync(file);
  const recovered=await invokeNativeEndpointWorker(f.input,{spawnImpl:()=>{
    const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};
    child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({ok:false,state:'refused',error:'debug_native_endpoint_execution_failed'}));child.emit('close',0);});
    return child;
  }});
  assert.equal(recovered.recoveredFromMarker,true);assert.equal(recovered.answered,true);assert.equal(recovered.uncertain,false);
  assert.equal(recovered.memoryReferencesReleased,true);assert.equal(recovered.bindingLockRetained,false);
  assert.equal(requests,1);assert.deepEqual(fs.readFileSync(file),before);
  const lock=path.join(f.root,'.local','debugger','native-endpoint-bindings',sha(f.binding.lane+'|'+f.binding.runtimeUrl+'|'+f.binding.moduleKey)+'.lock');
  fs.writeFileSync(lock,'{}');assert.equal(recoverNativeEndpointMarker(f.input).uncertain,true);
  fs.unlinkSync(lock);
  for(const patch of [{binding:{...marker.binding,moduleKey:key('z')}},{contractSha256:'f'.repeat(64)},{entryKey:key('z')},{operationId:'different'}]){
    fs.writeFileSync(file,JSON.stringify({...marker,...patch}));
    assert.equal(recoverNativeEndpointMarker(f.input).error,'debug_native_endpoint_worker_outcome_unavailable');
  }
});

test('lost REST reply retains uncertain evidence and a later call cannot resubmit', async t => {
  const f = privateFixture(t); let requests = 0;
  const services = { vault: f.vault, fetchImpl: async () => { requests++; throw new Error('private remote detail'); } };
  const first = await invokePrivateNativeEndpoint(f.input, services);
  assert.equal(first.state, 'uncertain'); assert.equal(first.uncertain, true);
  assert.equal(first.bindingLockRetained, true);
  const repeat = await invokePrivateNativeEndpoint(f.input, services); assert.equal(repeat.error, 'debug_native_endpoint_binding_blocked'); assert.equal(requests, 1);
  const anotherScenario = await invokePrivateNativeEndpoint({ ...f.input, scenarioId: 'two' }, services);
  assert.equal(anotherScenario.error, 'debug_native_endpoint_binding_blocked'); assert.equal(requests, 1);
  const file = JSON.parse(fs.readFileSync(path.join(f.input.directory, 'endpoint-one.json'), 'utf8'));
  assert.equal(file.state, 'uncertain'); assert.ok(!JSON.stringify(file).includes('private remote detail'));
});

test('different app-user bindings and anonymous ambiguity are refused before REST send', async t => {
  const f = privateFixture(t); let requests = 0;
  const services = { vault: f.vault, fetchImpl: async () => { requests++; return Response.json({}); } };
  f.input.descriptor.binding = { ...f.input.descriptor.binding, moduleKey: key('z') };
  const result = await invokePrivateNativeEndpoint(f.input, services);
  assert.equal(result.error, 'debug_native_endpoint_app_user_scope_mismatch'); assert.equal(requests, 0);
  const g = fixture(); g.model.tree.properties.Authentication = 'None'; g.document.security = [];
  const capability = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(g.contract()));
  assert.equal(capability.requiredContext, 'explicit-anonymous');
});
test('interactive endpoint deadline is fixed, app-bound and checked before send', async t => {
  const f = privateFixture(t), now = Date.now();
  f.input.inspectionExpiresAt = new Date(now + 45000).toISOString();
  assert.equal(nativeEndpointRequestBudget(f.input, now), 45000);
  assert.equal(nativeEndpointRequestBudget(f.input, now + 30000), 15000);
  for (const patch of [{ inspectionExpiresAt: new Date(now - 1).toISOString() },
    { inspectionExpiresAt: new Date(now + 601000).toISOString() }, { context: 'explicit-anonymous' },
    { descriptor: { ...f.input.descriptor, expiresAt: new Date(now + 40000).toISOString() } }])
    assert.throws(() => nativeEndpointRequestBudget({ ...f.input, ...patch }, now), /inspection_deadline_invalid/);
  let requests = 0;
  const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, now: () => now, fetchImpl: async (_, request) => {
    requests++; assert.equal(request.signal.aborted, false); return Response.json({ Amount: 1, Id: 2 });
  } });
  assert.equal(result.ok, true); assert.equal(requests, 1);
  assert.deepEqual(result.inspection, { expiresAt: f.input.inspectionExpiresAt, fixed: true });
  const expired = privateFixture(t); expired.input.inspectionExpiresAt = new Date(now - 1).toISOString();
  await assert.rejects(invokePrivateNativeEndpoint(expired.input, { vault: expired.vault, now: () => now,
    fetchImpl: async () => { requests++; throw Error('must not send'); } }), /inspection_deadline_invalid/);
  assert.equal(requests, 1);
});

for (const lane of ['o11','odc']) test(`explicit anonymous ${lane} endpoint deadline needs no app lease and refuses a descriptor or unknown lane`, () => {
  const now=Date.now(),input={context:'explicit-anonymous',timeoutSeconds:30,contract:{binding:{lane}},inspectionExpiresAt:new Date(now+45000).toISOString()};
  assert.equal(nativeEndpointRequestBudget(input,now),45000);assert.equal(nativeEndpointRequestBudget(input,now+30000),15000);
  for(const patch of [{descriptor:{expiresAt:new Date(now+60000).toISOString()}},{contract:{binding:{lane:'unknown'}}},
    {context:'anonymous'},{inspectionExpiresAt:new Date(now-1).toISOString()},{inspectionExpiresAt:new Date(now+601000).toISOString()}])
    assert.throws(()=>nativeEndpointRequestBudget({...input,...patch},now),/inspection_deadline_invalid/);
});

// Transport (PX02): typed pre-send refusals from the hash-bound model; CrossSiteRequests is recorded only.
test('InternalAccess=Yes, client-certificate HttpSecurity and OAuth2 callbacks are typed refusals; SSL and Restrict run', () => {
  const internal = fixture(); internal.model.tree.properties.InternalAccess = 'Yes';
  const plan = compileNativeRestEndpoint(internal.contract());
  assert.deepEqual(plan.entry.transport, { internalAccess: 'Yes', httpSecurity: null, crossSiteRequests: null, authenticationCallbackType: null });
  const refused = nativeEndpointAuthenticationCapability(plan);
  assert.equal(refused.executable, false); assert.equal(refused.error, 'debug_native_endpoint_internal_access_only');
  assert.equal(refused.platformRestriction, true); assert.equal(refused.evidence, 'model property InternalAccess=Yes');
  assert.match(refused.limitation, /outside the platform internal network/); assert.equal(refused.requiredContext, undefined);
  const ssl = fixture(); Object.assign(ssl.model.tree.properties, { InternalAccess: 'No', HttpSecurity: 'SSL', CrossSiteRequests: 'Restrict' });
  const sslPlan = compileNativeRestEndpoint(ssl.contract());
  assert.deepEqual(sslPlan.entry.transport, { internalAccess: 'No', httpSecurity: 'SSL', crossSiteRequests: 'Restrict', authenticationCallbackType: null });
  assert.equal(nativeEndpointAuthenticationCapability(sslPlan).requiredContext, 'app-user');
  // A server-side call sends no Origin header whatever CrossSiteRequests says.
  const request = buildNativeEndpointRequest(sslPlan, { OrderId: 1, Request: { Amount: 1, Id: 2 } });
  assert.ok(!Object.keys(request.headers).some(name => /^origin$/i.test(name)));
  for (const value of ['SSLWithClientCertificate', 'ClientCertificate', 'Other']) {
    const f = fixture(); f.model.tree.properties.HttpSecurity = value;
    const certificate = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(f.contract()));
    assert.equal(certificate.executable, false); assert.equal(certificate.error, 'debug_native_endpoint_client_certificate_unsupported');
    assert.equal(certificate.policy, 'ssam'); assert.equal(certificate.platformRestriction, false); assert.equal(certificate.platformLimit, false);
  }
  const oauth = fixture();
  oauth.model.tree.children.push(node('RestServiceAuthenticationFlow', 'OnAuthentication', { AuthenticationCallbackType: 'OAuth2' }, [], 'f'));
  oauth.model.tree.childrenTotal++;
  const oauthPlan = compileNativeRestEndpoint(oauth.contract());
  assert.equal(oauthPlan.entry.transport.authenticationCallbackType, 'OAuth2');
  assert.equal(nativeEndpointAuthenticationCapability(oauthPlan).error, 'debug_native_endpoint_exposed_oauth2_unqualified');
  const other = fixture(); other.model.tree.properties.Authentication = 'OAuth2'; other.document.security = []; delete other.document.securityDefinitions;
  const otherCapability = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(other.contract()));
  assert.equal(otherCapability.error, 'debug_native_endpoint_exposed_oauth2_unqualified'); assert.equal(otherCapability.policy, 'ssam');
});

test('an InternalAccess=Yes plan is refused by the worker before vault, lock or send', async t => {
  const f = privateFixture(t); f.model.tree.properties.InternalAccess = 'Yes'; f.input.contract = f.contract(); let calls = 0;
  await assert.rejects(invokePrivateNativeEndpoint(f.input, { vault: async () => { calls++; }, fetchImpl: async () => { calls++; } }), /internal_access_only/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(f.root, '.local', 'debugger', 'native-endpoint-bindings')), false);
});

// Basic (PX02): ODC and O11 developer-validated Basic use an endpoint-credential 'basic' record; O11 platform login keeps app-user.
test('qualified ODC Basic and O11 developer-logic Basic need the endpoint-credential basic context; O11 platform login keeps app-user', () => {
  const odc = basicFixture({ lane: 'odc' }), plan = compileNativeRestEndpoint(odc.contract());
  assert.deepEqual(plan.authentication.basic, { scheme: 'basic', validation: 'developer-logic', inputNames: ['Username', 'Password'],
    credentialsReferencedInFlow: true, callbackKey: key('f'), serviceKey: key('c') });
  const qualified = nativeEndpointAuthenticationCapability(plan);
  assert.equal(qualified.executable, true); assert.equal(qualified.requiredContext, 'endpoint-credential');
  assert.equal(qualified.credentialScheme, 'basic'); assert.equal(qualified.appUserIdentityProved, false);
  assert.deepEqual(qualified.headers, ['Authorization']);
  assert.equal(qualified.limitation, 'ODC Basic credentials are validated by developer logic in OnAuthentication; no app-user identity follows');
  for (const [options, reason] of [[{ lane: 'odc', flow: null }, 'debug_native_endpoint_basic_callback_missing'],
    [{ lane: 'odc', inputs: [] }, 'debug_native_endpoint_basic_callback_missing'], [{ lane: 'odc', security: false }, 'debug_native_endpoint_basic_openapi_mismatch']]) {
    const unqualified = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(basicFixture(options).contract()));
    assert.equal(unqualified.executable, false); assert.equal(unqualified.error, 'debug_native_endpoint_odc_basic_unqualified');
    assert.equal(unqualified.alias, 'debug_native_endpoint_basic_credentials_unavailable_after_odc_srp'); assert.equal(unqualified.reason, reason);
    assert.equal(unqualified.policy, 'ssam'); assert.equal(unqualified.platformLimit, false);
  }
  const developer = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(basicFixture({ flow: [flowStart(), developerCheck(), flowEnd()] }).contract()));
  assert.equal(developer.requiredContext, 'endpoint-credential'); assert.equal(developer.credentialScheme, 'basic');
  assert.match(developer.limitation, /Basic credentials are validated by developer logic in OnAuthentication; no app-user identity follows/);
  const login = compileNativeRestEndpoint(basicFixture().contract());
  assert.equal(login.authentication.basic.validation, 'platform-login');
  const platform = nativeEndpointAuthenticationCapability(login);
  assert.equal(platform.requiredContext, 'app-user'); assert.equal(platform.credentialScheme, undefined);
  const ambiguous = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(basicFixture({ flow: [flowStart(), userLogin('"svc"'), flowEnd()] }).contract()));
  assert.equal(ambiguous.executable, false); assert.equal(ambiguous.error, 'debug_native_endpoint_basic_validation_ambiguous');
});

const BASIC_USER = 'synthetic-basic-user', BASIC_PASSWORD = 'synthetic-basic-pass';
const BASIC_B64 = Buffer.from(BASIC_USER + ':' + BASIC_PASSWORD).toString('base64');
function basicEndpointFixture(t, options = { lane: 'odc' }) {
  const b = basicFixture(options), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-basic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  // PX03 vault record shape (debug-app-user-vault.ps1 basic mode): {kind:'endpoint-credential', scheme:'basic', binding, username, password}; no `use`.
  const binding = endpointCredentialBinding({ ...b.binding, serviceKey: key('c'), headers: ['Authorization'], scheme: 'basic' }, 'f'.repeat(32));
  const descriptor = { credentialRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', binding, expiresAt, kind: 'endpoint-credential', scheme: 'basic' };
  const record = { ok: true, kind: 'endpoint-credential', scheme: 'basic', binding, expiresAt, username: BASIC_USER, password: BASIC_PASSWORD };
  const input = { root, directory: path.join(root, '.local', 'debugger', operationId), operationId, scenarioId: 'one', timeoutSeconds: 2,
    contract: b.contract(), inputs: { Value: 'hello' }, context: 'endpoint-credential', descriptor };
  const opened = [];
  return { ...b, root, input, record, opened, vault: async mode => { assert.equal(mode, 'read'); const copy = structuredClone(record); opened.push(copy); return copy; } };
}
const locksOf = root => { const dir = path.join(root, '.local', 'debugger', 'native-endpoint-bindings'); return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0; };

for (const options of [{ lane: 'odc' }, { lane: 'o11', flow: [flowStart(), developerCheck(), flowEnd()] }]) test(`endpoint-credential basic (${options.lane}) sends one Authorization Basic header and keeps every form private`, async t => {
  const f = basicEndpointFixture(t, options); let requests = 0;
  const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async (url, request) => {
    requests++; assert.equal(request.headers.Authorization, 'Basic ' + BASIC_B64);
    assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
    return Response.json('echo ' + BASIC_USER + ' ' + BASIC_PASSWORD + ' ' + BASIC_B64);
  } });
  assert.equal(result.ok, true, result.error); assert.equal(requests, 1);
  assert.equal(result.authentication.context, 'endpoint-credential'); assert.equal(result.authentication.scheme, 'basic');
  assert.equal(result.authentication.credentialsFromPrivateDialog, true); assert.equal(result.authentication.appUserIdentityProved, false);
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].username, ''); assert.equal(f.opened[0].password, '');
  const receipt = fs.readFileSync(path.join(f.input.directory, 'endpoint-one.json'), 'utf8');
  for (const secret of [BASIC_USER, BASIC_PASSWORD, BASIC_B64, 'Basic ' + BASIC_B64]) {
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!receipt.includes(secret));
  }
});

test('O11 developer-logic Basic never uses the app-user record; platform login refuses an endpoint-credential record', async t => {
  const f = basicEndpointFixture(t, { lane: 'o11', flow: [flowStart(), developerCheck(), flowEnd()] }); let calls = 0;
  const services = { vault: async () => { calls++; }, fetchImpl: async () => { calls++; } };
  await assert.rejects(invokePrivateNativeEndpoint({ ...f.input, context: 'app-user' }, services), /context_explicit_required/);
  const login = basicEndpointFixture(t, { lane: 'o11' });
  await assert.rejects(invokePrivateNativeEndpoint(login.input, services), /context_explicit_required/);
  assert.equal(calls, 0);
});

test('a basic record bound elsewhere, of another scheme or with an RFC 7617-invalid username is refused before send', async t => {
  for (const patch of [
    f => { f.input.descriptor.binding = { ...f.input.descriptor.binding, scheme: 'header' }; },
    f => { const { scheme, ...binding } = f.input.descriptor.binding; f.input.descriptor.binding = binding; },
    f => { f.input.descriptor.binding = { ...f.input.descriptor.binding, headers: ['X-Other'] }; },
    f => { f.record.scheme = 'header'; },
    f => { f.record.username = 'user:name'; },
    f => { f.record.password = 'pass\r\nInjected: 1'; },
    f => { f.record.password = ''; },
    f => { f.record.expiresAt = new Date(Date.now() - 1000).toISOString(); },
  ]) {
    const f = basicEndpointFixture(t); patch(f); let requests = 0;
    const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async () => { requests++; return Response.json('x'); } });
    assert.equal(result.ok, false); assert.equal(result.sent, false); assert.equal(requests, 0);
    assert.match(result.error, /^debug_native_endpoint_credential_(scope_mismatch|unavailable)$/); assert.equal(locksOf(f.root), 0);
    assert.ok(!JSON.stringify(result).includes(BASIC_PASSWORD));
  }
});

// Redaction-only records (PX02/PX03): user-typed secrets used solely to redact; never placed in a request.
test('a redact-only descriptor or record is refused before lock or fetch in every context', async t => {
  const makers = [t => basicEndpointFixture(t), t => endpointFixture(t), t => privateFixture(t)];
  for (const make of makers) for (const patch of [d => { d.use = 'redact-only'; }, d => { d.binding = { ...d.binding, use: 'redact-only' }; }, d => { d.kind = 'redaction-secret'; }]) {
    const f = make(t); patch(f.input.descriptor); let calls = 0;
    await assert.rejects(invokePrivateNativeEndpoint(f.input, { vault: async () => { calls++; }, fetchImpl: async () => { calls++; } }),
      /^Error: debug_native_endpoint_redaction_record_not_sendable$/);
    assert.equal(calls, 0); assert.equal(locksOf(f.root), 0);
  }
  const f = basicEndpointFixture(t); f.record.use = 'redact-only'; let requests = 0;
  const result = await invokePrivateNativeEndpoint(f.input, { vault: f.vault, fetchImpl: async () => { requests++; } });
  assert.equal(result.error, 'debug_native_endpoint_redaction_record_not_sendable'); assert.equal(result.sent, false);
  assert.equal(requests, 0); assert.equal(locksOf(f.root), 0); assert.equal(f.opened[0].password, '');
});

// Header guard (PX02): Authentication=None plus a literal request-header guard -> endpoint-credential header record.
test('Authentication=None with a qualified header guard sends exactly the guard header; no guard stays explicit-anonymous', async t => {
  for (const lane of ['o11', 'odc']) {
    const g = guardFixture({ lane }), plan = compileNativeRestEndpoint(g.contract());
    assert.deepEqual({ native: plan.authentication.native, protocol: plan.authentication.protocol, source: plan.authentication.source, headers: plan.authentication.headers },
      { native: 'None', protocol: 'header', source: 'OnRequest', headers: [{ name: 'X-SSAM-Guard', required: true }] });
    const capability = nativeEndpointAuthenticationCapability(plan);
    assert.equal(capability.executable, true); assert.equal(capability.requiredContext, 'endpoint-credential');
    assert.equal(capability.credentialScheme, 'header'); assert.deepEqual(capability.headers, ['X-SSAM-Guard']);
  }
  const g = guardFixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const binding = endpointCredentialBinding({ ...g.binding, serviceKey: key('c'), headers: ['X-SSAM-Guard'] }, 'f'.repeat(32));
  const record = { ok: true, kind: 'endpoint-credential', binding, expiresAt, headers: [{ name: 'X-SSAM-Guard', value: 'synthetic-guard-value' }] };
  const input = { root, directory: path.join(root, '.local', 'debugger', operationId), operationId, scenarioId: 'one', timeoutSeconds: 2,
    contract: g.contract(), inputs: { Value: 'hello' }, context: 'endpoint-credential',
    descriptor: { credentialRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', binding, expiresAt, kind: 'endpoint-credential' } };
  let requests = 0;
  const result = await invokePrivateNativeEndpoint(input, { vault: async () => structuredClone(record), fetchImpl: async (url, request) => {
    requests++; assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Content-Type', 'X-SSAM-Guard']);
    assert.equal(request.headers['X-SSAM-Guard'], 'synthetic-guard-value'); return Response.json('synthetic-guard-value');
  } });
  assert.equal(result.ok, true, result.error); assert.equal(requests, 1); assert.deepEqual(result.authentication.endpointHeaders, ['X-SSAM-Guard']);
  assert.ok(!JSON.stringify(result).includes('synthetic-guard-value'));
  assert.ok(!fs.readFileSync(path.join(input.directory, 'endpoint-one.json'), 'utf8').includes('synthetic-guard-value'));
  assert.equal(nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(guardFixture({ onRequest: null }).contract())).requiredContext, 'explicit-anonymous');
  const collision = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(guardFixture({ headerInputs: ['X-SSAM-Guard'] }).contract()));
  assert.equal(collision.executable, false); assert.equal(collision.error, 'debug_native_endpoint_request_header_guard_unqualified');
  assert.equal(collision.reason, 'debug_native_endpoint_custom_authentication_header_collision');
});

test('an unguarded None endpoint that sets status or response headers stays explicit-anonymous', () => {
  const writers = [flowStart('m'), customNode('ExecuteServerActionNode', 'SetStatusCode', { Action: 'ServerActionSignature:SetStatusCode' }, [], 'w',
    { propertyReferences: { Action: { kind: 'ServerActionSignature', name: 'SetStatusCode', key: 'W'.repeat(22), path: 'Reference:HTTPRequestHandler/ServerActionSignature:SetStatusCode' } } }), flowEnd('n')];
  for (const lane of ['o11', 'odc']) {
    const capability = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(guardFixture({ lane, onRequest: null, method: writers }).contract()));
    assert.equal(capability.executable, true); assert.equal(capability.requiredContext, 'explicit-anonymous');
  }
});

test('O11 developer-logic Basic through a local action reports that its login, if any, needs server evidence', () => {
  const local = customNode('ExecuteServerActionNode', 'CheckCredentials', { Action: 'ServerActionSignature:CheckCredentials' }, [], 'l',
    { propertyReferences: { Action: { kind: 'ServerActionSignature', name: 'CheckCredentials', key: 'L'.repeat(22), path: 'ServerAction:CheckCredentials' } } });
  const capability = nativeEndpointAuthenticationCapability(compileNativeRestEndpoint(basicFixture({ flow: [flowStart(), developerCheck(), local, flowEnd()] }).contract()));
  assert.equal(capability.requiredContext, 'endpoint-credential'); assert.equal(capability.credentialScheme, 'basic');
  assert.deepEqual(capability.localActions, ['CheckCredentials']); assert.equal(capability.appUserIdentityProved, false);
  assert.match(capability.limitation, /local actions SSAM does not read \(CheckCredentials\); any login they perform needs server evidence/);
});

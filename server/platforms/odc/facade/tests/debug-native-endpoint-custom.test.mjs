import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCustomAuthenticationContract, readBasicAuthenticationContract, readRequestHeaderGuard } from '../debug-native-endpoint-custom.mjs';
import { readFileSync } from 'node:fs';
import { customFixture, node, call, header, argument, expression, key, GET_REQUEST_HEADER } from './fixtures/debug-native-custom-fixture.mjs';
import { basicFixture, guardFixture, basicInput, userLogin, developerCheck, headerList, start as bStart, end as bEnd } from './fixtures/debug-native-basic-fixture.mjs';

const refused = (flow, code, patch = () => {}) => {
  const f = customFixture({ flow }); patch(f);
  assert.throws(() => nativeCustomAuthenticationContract(f), new RegExp('^Error: debug_native_endpoint_custom_authentication_' + code + '$'));
};
const start = () => node('StartNode', '', {}, [], 's'), end = () => node('EndNode', '', {}, [], 'e');
// The GetRequestHeader node exactly as a real published O11 capture reads it (HeaderName, child Expression).
const realHeader = (literal = null) => {
  const n = JSON.parse(readFileSync(new URL('./fixtures/debug-native-custom-real-getrequestheader.json', import.meta.url), 'utf8'));
  if (literal) { const a = n.children[0]; a.properties.Value = literal; Object.assign(a.children[0].properties, { DisplayValue: literal, Text: literal }); }
  return n;
};

test('a literal header read through the native O11 request-header API qualifies the published OnAuthentication', () => {
  const f = customFixture();
  const contract = nativeCustomAuthenticationContract(f);
  assert.deepEqual(contract, { scheme: 'header', headers: [{ name: 'X-Api-Key', required: true }], callsLogin: true,
    callbackKey: key('f'), serviceKey: key('c') });
  const two = customFixture({ flow: [start(), header('"X-Tenant"', 'h', '1'), header('"X-Api-Key"', 'g', '2'), header('"x-api-key"', 'j', '3'), end()] });
  assert.deepEqual(nativeCustomAuthenticationContract(two), { scheme: 'header', callsLogin: false, callbackKey: key('f'), serviceKey: key('c'),
    headers: [{ name: 'X-Tenant', required: true }, { name: 'X-Api-Key', required: true }] });
});

test('the GetRequestHeader node of a real published capture is read through its HeaderName argument', () => {
  refused([start(), realHeader(), end()], 'cookie_unsupported');
  assert.deepEqual(nativeCustomAuthenticationContract(customFixture({ flow: [start(), realHeader('"X-Api-Key"'), end()] })),
    { scheme: 'header', headers: [{ name: 'X-Api-Key', required: true }], callsLogin: false, callbackKey: key('f'), serviceKey: key('c') });
});

test('a header name argument that is not the literal HeaderName of GetRequestHeader is refused', () => {
  refused([start(), call('HTTPRequestHandler', 'GetRequestHeader', 'h', [argument('Name', '"X-Api-Key"', '1', GET_REQUEST_HEADER)]), end()], 'header_name_computed');
  refused([start(), call('HTTPRequestHandler', 'GetRequestHeader', 'h', [argument('HeaderName', '"X-Api-Key"', '1')]), end()], 'header_name_computed');
  refused([start(), header('"X-Api-Key"', 'h'), end()], 'header_name_computed', f => { f.service.children[1].children[1].children[0].children[0].properties.Text = 'Site.Key'; });
  refused([start(), header('"X-Api-Key"', 'h'), end()], 'header_name_computed', f => {
    const a = f.service.children[1].children[1].children[0]; a.children.push(expression('"X-Other"', '7')); a.childrenTotal++; });
});

test('only the named login actions are accepted outside the request-header API', () => {
  const login = (module, action) => customFixture({ flow: [start(), header('"X-Api-Key"', 'h'), call(module, action, 'u'), end()] });
  assert.equal(nativeCustomAuthenticationContract(login('(System)', 'Login')).callsLogin, true);
  assert.equal(nativeCustomAuthenticationContract(login('(System)', 'LoginPassword')).callsLogin, true);
  assert.equal(nativeCustomAuthenticationContract(login('Users', 'User_Login')).callsLogin, true);
  refused([start(), header('"X-Api-Key"', 'h'), call('Users', 'User_GetUnifiedLoginUrl', 'u'), end()], 'call_unqualified');
  refused([start(), header('"X-Api-Key"', 'h'), call('Users', 'User_LoginSomething', 'u'), end()], 'call_unqualified');
  refused([start(), header('"X-Api-Key"', 'h'), call('(System)', 'Logout', 'u'), end()], 'call_unqualified');
});

test('computed header names, cookies, query or body credentials and an Authorization scheme are refused', () => {
  refused([start(), header('"X-" + "Key"', 'h'), end()], 'header_name_computed');
  refused([start(), header('Site.HeaderName', 'h'), end()], 'header_name_computed');
  refused([start(), header('"X Key"', 'h'), end()], 'header_name_computed');
  refused([start(), call('HTTPRequestHandler', 'GetRequestHeader', 'h', [argument('Other', '"X-Api-Key"', '1')]), end()], 'header_name_computed');
  refused([start(), header('"Cookie"', 'h'), end()], 'cookie_unsupported');
  refused([start(), call('HTTPRequestHandler', 'GetCookie', 'h', [argument('Name', '"session"', '1')]), end()], 'cookie_unsupported');
  refused([start(), call('HTTPRequestHandler', 'GetRequestParameter', 'h', [argument('Name', '"key"', '1')]), end()], 'query_or_body_unsupported');
  refused([start(), call('HTTPRequestHandler', 'GetRequestContent', 'h'), end()], 'query_or_body_unsupported');
  refused([start(), header('"Authorization"', 'h'), end()], 'authorization_scheme_ambiguous');
  refused([start(), header('"Host"', 'h'), end()], 'header_unsupported');
});

test('missing, ambiguous or opaque OnAuthentication logic and ODC are not qualified', () => {
  refused(null, 'callback_missing');
  refused(undefined, 'callback_ambiguous', f => { f.service.children.push({ ...f.service.children[1], key: key('z') }); f.service.childrenTotal++; });
  refused(undefined, 'callback_type_mismatch', f => { f.service.children[1].properties.AuthenticationCallbackType = 'Basic'; });
  refused([start(), end()], 'header_missing');
  refused([start(), header('"X-Api-Key"', 'h'), call(null, 'ValidateKey', 'v'), end()], 'call_unqualified');
  refused([start(), header('"X-Api-Key"', 'h'), call('Other', 'Read', 'v'), end()], 'call_unqualified');
  refused([node('RestServiceAuthenticationFlowInput', 'Username', {}, [], 'p'), start(), header('"X-Api-Key"', 'h'), end()], 'callback_input_unsupported');
  const odc = customFixture({ lane: 'odc' });
  assert.throws(() => nativeCustomAuthenticationContract(odc), /custom_authentication_request_header_api_unqualified/);
});

test('the contract is read only from the same hash-bound, complete published capture', () => {
  refused(undefined, 'model_binding_invalid', f => { f.model.sourceSha256 = 'f'.repeat(64); });
  refused(undefined, 'model_binding_invalid', f => { f.binding.sourceSha256 = 'f'.repeat(64); });
  refused(undefined, 'model_binding_invalid', f => { f.model.tree.properties.Authentication = 'Basic'; });
  refused(undefined, 'model_incomplete', f => { f.service.children[1].children[1].childrenOmitted = 1; });
  refused(undefined, 'model_incomplete', f => { f.service.children[1].children[1].children[0].propertiesMissing = ['Value']; });
});

// Basic OnAuthentication: two native inputs; ODC is always developer logic, O11 is classified.
const basicRefused = (options, code) => { const f = basicFixture(options);
  assert.throws(() => readBasicAuthenticationContract(f.service, f.binding.lane), new RegExp('^Error: debug_native_endpoint_basic_' + code + '$')); };

test('readBasicAuthenticationContract reads the native inputs and reports ODC Basic as developer logic', () => {
  const f = basicFixture({ lane: 'odc' });
  assert.deepEqual(readBasicAuthenticationContract(f.service, 'odc'), { scheme: 'basic', validation: 'developer-logic',
    inputNames: ['Username', 'Password'], credentialsReferencedInFlow: true, callbackKey: key('f'), serviceKey: key('c') });
  const unread = basicFixture({ lane: 'odc', flow: [bStart(), bEnd()] });
  assert.equal(readBasicAuthenticationContract(unread.service, 'odc').credentialsReferencedInFlow, false);
  const renamed = basicFixture({ lane: 'odc', inputs: [basicInput('User', 'p'), basicInput('Secret', 'q')],
    flow: [bStart(), node('If', 'Valid?', { Condition: 'User = Site.ApiUser and Secret = "x"' }, [], 'v'), bEnd()] });
  assert.deepEqual(readBasicAuthenticationContract(renamed.service, 'odc').inputNames, ['User', 'Secret']);
  // Missing or incomplete OnAuthentication keeps the P08 refusal with the callback_missing reason.
  basicRefused({ lane: 'odc', flow: null }, 'callback_missing');
  basicRefused({ lane: 'odc', inputs: [basicInput('Username', 'p')] }, 'callback_missing');
  basicRefused({ lane: 'odc', inputs: [basicInput('Username', 'p'), basicInput('Password', 'q'), basicInput('Extra', 'r')] }, 'callback_missing');
  basicRefused({ lane: 'odc', callbackType: 'Custom' }, 'callback_missing');
  basicRefused({ lane: 'odc', callbackType: null }, 'callback_missing');
});

test('O11 Basic is platform-login only for one User_Login bound to the callback inputs by identifier', () => {
  const f = basicFixture();
  assert.deepEqual(readBasicAuthenticationContract(f.service, 'o11'), { scheme: 'basic', validation: 'platform-login', loginProvider: 'Users',
    inputNames: ['Username', 'Password'], credentialsReferencedInFlow: true, callbackKey: key('f'), serviceKey: key('c') });
  const provider = basicFixture({ flow: [bStart(), userLogin('Username', 'Password', 'u', 'CustomUsers'), bEnd()] });
  assert.equal(readBasicAuthenticationContract(provider.service, 'o11').loginProvider, 'CustomUsers');
  const developer = basicFixture({ flow: [bStart(), developerCheck(), bEnd()] });
  assert.equal(readBasicAuthenticationContract(developer.service, 'o11').validation, 'developer-logic');
  basicRefused({ flow: [bStart(), userLogin('"svc"'), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), userLogin('Username', 'Site.Password'), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), userLogin('Username', 'Username'), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), userLogin(), userLogin('Username', 'Password', 'k'), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), userLogin(), header('"X-Api-Key"', 'h'), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), userLogin(), call('(System)', 'Login', 'l'), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: null }, 'callback_missing');
});

// Authentication=None guarded by a literal request header (OnRequest callback or the method flow).
const guardRefused = (options, code) => { const f = guardFixture(options);
  assert.throws(() => readRequestHeaderGuard(f.service, key('b'), f.binding.lane), new RegExp('^Error: debug_native_endpoint_custom_authentication_' + code + '$')); };

test('readRequestHeaderGuard qualifies literal OnRequest and method header reads', () => {
  const o11 = guardFixture();
  assert.deepEqual(readRequestHeaderGuard(o11.service, key('b'), 'o11'), { native: 'None', protocol: 'header', source: 'OnRequest',
    headers: [{ name: 'X-SSAM-Guard', required: true }], callbackKey: key('g'), serviceKey: key('c') });
  const odc = guardFixture({ lane: 'odc' });
  assert.deepEqual(readRequestHeaderGuard(odc.service, key('b'), 'odc').headers, [{ name: 'X-SSAM-Guard', required: true }]);
  for (const action of ['ListFilter', 'ListAny']) {
    const g = guardFixture({ lane: 'odc', onRequest: [bStart(), headerList('Request.Headers.Current.Name = "X-SSAM-Guard"', 'x', 'Request.Headers', action), bEnd()] });
    assert.equal(readRequestHeaderGuard(g.service, key('b'), 'odc').source, 'OnRequest');
  }
  const method = guardFixture({ onRequest: null, method: [bStart('m'), header('"X-SSAM-Guard"', 'h'), bEnd('n')] });
  assert.deepEqual(readRequestHeaderGuard(method.service, key('b'), 'o11'), { native: 'None', protocol: 'header', source: 'method',
    headers: [{ name: 'X-SSAM-Guard', required: true }], callbackKey: null, serviceKey: key('c') });
  // No guard: unchanged explicit-anonymous (null), including a business list that is not Request.Headers.
  assert.equal(readRequestHeaderGuard(guardFixture({ onRequest: null }).service, key('b'), 'o11'), null);
  assert.equal(readRequestHeaderGuard(guardFixture({ onRequest: [bStart(), bEnd()] }).service, key('b'), 'o11'), null);
  assert.equal(readRequestHeaderGuard(guardFixture({ lane: 'odc', onRequest: [bStart(), headerList('Name = "X"', 'x', 'Orders'), bEnd()] }).service, key('b'), 'odc'), null);
});

test('readRequestHeaderGuard refuses computed names, cookies, query keys, Authorization and business-header collisions', () => {
  guardRefused({ onRequest: [bStart(), header('"X-" + Site.Suffix', 'h'), bEnd()] }, 'header_name_computed');
  guardRefused({ lane: 'odc', onRequest: [bStart(), headerList('Name = Site.GuardName'), bEnd()] }, 'header_name_computed');
  guardRefused({ lane: 'odc', onRequest: [bStart(), headerList('ToLower(Name) = "x-ssam-guard"'), bEnd()] }, 'header_name_computed');
  guardRefused({ onRequest: [bStart(), call('HTTPRequestHandler', 'GetCookie', 'h', [argument('Name', '"session"', '1')]), bEnd()] }, 'cookie_unsupported');
  guardRefused({ lane: 'odc', onRequest: [bStart(), headerList('Name = "session"', 'x', 'Request.Cookies'), bEnd()] }, 'cookie_unsupported');
  guardRefused({ lane: 'odc', onRequest: [bStart(), headerList('Name = "Cookie"'), bEnd()] }, 'cookie_unsupported');
  guardRefused({ onRequest: [bStart(), call('HTTPRequestHandler', 'GetRequestParameter', 'h', [argument('Name', '"key"', '1')]), bEnd()] }, 'query_or_body_unsupported');
  guardRefused({ lane: 'odc', onRequest: [bStart(), headerList('Name = "key"', 'x', 'Request.QueryParameters'), bEnd()] }, 'query_or_body_unsupported');
  guardRefused({ onRequest: [bStart(), header('"Authorization"', 'h'), bEnd()] }, 'authorization_scheme_ambiguous');
  guardRefused({ lane: 'odc', onRequest: [bStart(), headerList('Name = "Authorization"'), bEnd()] }, 'authorization_scheme_ambiguous');
  guardRefused({ headerInputs: ['X-SSAM-Guard'] }, 'header_collision');
  // ODC has no qualified GetRequestHeader (P08): only the OnRequest Request.Headers shape qualifies there.
  guardRefused({ lane: 'odc', onRequest: [bStart(), header('"X-SSAM-Guard"', 'h'), bEnd()] }, 'request_header_api_unqualified');
});

// Response writers and request metadata (SetStatusCode, AddHeader, SetCookie, GetIP, GetRequestURL) carry no credential.
test('readRequestHeaderGuard ignores HTTPRequestHandler actions that read no credential', () => {
  const writers = id => [call('HTTPRequestHandler', 'SetStatusCode', id + '1', [argument('StatusCode', '200', id + '2')]),
    call('HTTPRequestHandler', 'AddHeader', id + '3', [argument('Name', '"X-Trace"', id + '4'), argument('Value', '"1"', id + '5')]),
    call('HTTPRequestHandler', 'SetCookie', id + '6'), call('HTTPRequestHandler', 'GetIP', id + '7'), call('HTTPRequestHandler', 'GetRequestURL', id + '8')];
  for (const lane of ['o11', 'odc']) {
    assert.equal(readRequestHeaderGuard(guardFixture({ lane, onRequest: null, method: [bStart('m'), ...writers('w'), bEnd('n')] }).service, key('b'), lane), null);
    assert.equal(readRequestHeaderGuard(guardFixture({ lane, onRequest: [bStart(), ...writers('z'), bEnd()] }).service, key('b'), lane), null);
  }
  const guarded = guardFixture({ method: [bStart('m'), ...writers('w'), bEnd('n')] });
  assert.deepEqual(readRequestHeaderGuard(guarded.service, key('b'), 'o11').headers, [{ name: 'X-SSAM-Guard', required: true }]);
  guardRefused({ onRequest: null, method: [bStart('m'), call('HTTPRequestHandler', 'GetFormValue', 'h', [argument('Name', '"k"', '1')]), bEnd('n')] }, 'query_or_body_unsupported');
  guardRefused({ onRequest: null, method: [bStart('m'), call('HTTPRequestHandler', 'GetRequestHeaders', 'h'), bEnd('n')] }, 'header_name_computed');
});

test('readRequestHeaderGuard checks completeness of the OnRequest and target method only', () => {
  const f = guardFixture({ onRequest: null });
  f.service.children.push(node('RestServiceAction', 'Other', {}, [], 'y', { propertiesOmitted: { URL: 'size' } })); f.service.childrenTotal++;
  assert.equal(readRequestHeaderGuard(f.service, key('b'), 'o11'), null);
  const g = guardFixture(); g.service.children[1].propertiesMissing = ['CallbackType'];
  assert.throws(() => readRequestHeaderGuard(g.service, key('b'), 'o11'), /^Error: debug_native_endpoint_custom_authentication_model_incomplete$/);
  const h = guardFixture({ onRequest: null }); h.service.childrenOmitted = 1;
  assert.throws(() => readRequestHeaderGuard(h.service, key('b'), 'o11'), /^Error: debug_native_endpoint_custom_authentication_model_incomplete$/);
});

test('Basic OnAuthentication: only credential reads are ambiguous; local actions stay developer logic and are reported', () => {
  const status = call('HTTPRequestHandler', 'SetStatusCode', 't', [argument('StatusCode', '401', 'T')]);
  const login = basicFixture({ flow: [bStart(), userLogin(), status, bEnd()] });
  assert.equal(readBasicAuthenticationContract(login.service, 'o11').validation, 'platform-login');
  basicRefused({ flow: [bStart(), userLogin(), call('HTTPRequestHandler', 'GetRequestParameter', 'h', [argument('Name', '"k"', '1')]), bEnd()] }, 'validation_ambiguous');
  basicRefused({ flow: [bStart(), userLogin(), call('HTTPRequestHandler', 'GetCookie', 'h'), bEnd()] }, 'validation_ambiguous');
  const local = basicFixture({ flow: [bStart(), call(null, 'CheckCredentials', 'l', [argument('User', 'Username', 'L'), argument('Secret', 'Password', 'M')]), bEnd()] });
  const read = readBasicAuthenticationContract(local.service, 'o11');
  assert.equal(read.validation, 'developer-logic'); assert.deepEqual(read.localActions, ['CheckCredentials']);
  assert.equal(readBasicAuthenticationContract(basicFixture({ flow: [bStart(), developerCheck(), bEnd()] }).service, 'o11').localActions, undefined);
});

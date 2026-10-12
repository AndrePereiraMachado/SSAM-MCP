// Synthetic published RestService with Authentication=Basic (OnAuthentication with the two
// RestServiceAuthenticationFlowInput children the Studio generates) or Authentication=None guarded by a
// literal request header in OnRequest / the method flow. Nodes reuse the P08 custom fixture helpers.
import { node, call, argument, expression, key, sha, header } from './debug-native-custom-fixture.mjs';
export { node, call, argument, expression, key, sha, header };

const USER_LOGIN = 'Reference:Users/ServerActionSignature:User_Login';
export const LIST_INDEX_OF = 'Reference:(System)/ServerActionSignature:ListIndexOf';
export const start = id => node('StartNode', '', {}, [], id ?? 's'), end = id => node('EndNode', '', {}, [], id ?? 'e');
export const basicInput = (name, id) => node('RestServiceAuthenticationFlowInput', name, { DataType: 'Text' }, [], id);
// User_Login(<username>, <password>, False) as the native reading shows the argument values.
export const userLogin = (username = 'Username', password = 'Password', id = 'u', module = 'Users') => call(module, 'User_Login', id, [
  argument('Username', username, '2', 'Reference:' + module + '/ServerActionSignature:User_Login'),
  argument('Password', password, '3', 'Reference:' + module + '/ServerActionSignature:User_Login'),
  argument('Persistent', 'False', '4', USER_LOGIN)]);
// Developer validation against site properties: no login, the callback inputs referenced by identifier.
export const developerCheck = (id = 'v') => node('If', 'Valid?', { Condition: 'Username = Site.ApiUser and Password = Site.ApiPassword' }, [], id);
// ListIndexOf/ListFilter/ListAny over the OnRequest Request.Headers with a literal Name comparison.
export const headerList = (condition, id = 'x', list = 'Request.Headers', action = 'ListIndexOf') => call('(System)', action, id, [
  argument('List', list, '5', 'Reference:(System)/ServerActionSignature:' + action),
  argument('Condition', condition, '6', 'Reference:(System)/ServerActionSignature:' + action)]);

export function basicFixture({ lane = 'o11', flow, inputs, callbackType = 'Basic', security = true, properties = {} } = {}) {
  const oml = 'synthetic basic-auth published model';
  const binding = { lane, module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: sha(oml), runtimeUrl: 'https://dev.example.test/Store/' };
  const action = node('RestServiceAction', 'Echo', { HTTPMethod: 'POST', URL: '/Store/rest/Api/Echo' }, [
    node('RestServiceActionInput', 'Value', { ReceiveIn: 'Body', IsMandatory: 'True' }, [], 'i'),
    node('RestServiceActionOutput', 'Result', { SendIn: 'Body' }, [], 'o'),
  ], 'b');
  const children = [...(inputs ?? [basicInput('Username', 'p'), basicInput('Password', 'q')]),
    ...(flow ?? [start(), lane === 'o11' ? userLogin() : developerCheck(), end()])];
  const onAuthentication = flow === null ? null : node('RestServiceAuthenticationFlow', 'OnAuthentication', callbackType === null ? {} : { AuthenticationCallbackType: callbackType }, children, 'f');
  const service = node('RestService', 'Api', { URL: '/Store/rest/Api', Authentication: 'Basic', ...properties }, onAuthentication ? [action, onAuthentication] : [action], 'c');
  const model = { schema: 'ssam-reading/1', model: binding.module, sourceSha256: binding.sourceSha256, tree: service };
  const document = { swagger: '2.0', host: 'dev.example.test', basePath: '/Store/rest/Api', schemes: ['https'],
    consumes: ['application/json'], produces: ['application/json'],
    ...(security ? { securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }] } : {}),
    paths: { '/Echo': { post: { parameters: [{ in: 'body', name: 'Value', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'OK', schema: { type: 'string' } }, 401: { description: 'Unauthorized' } } } } } };
  const contract = () => { const body = JSON.stringify(document);
    return { binding, model, entryKey: key('b'), source: { url: binding.runtimeUrl + 'rest/Api/swagger.json', body, sha256: sha(body) } }; };
  return { oml, binding, action, service, model, document, contract };
}

// Authentication=None; onRequest / method are flow node lists (null = no OnRequest callback).
export function guardFixture({ lane = 'o11', onRequest, method = [], properties = {}, headerInputs = [] } = {}) {
  const oml = 'synthetic guarded published model';
  const binding = { lane, module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: sha(oml), runtimeUrl: 'https://dev.example.test/Store/' };
  const action = node('RestServiceAction', 'Echo', { HTTPMethod: 'POST', URL: '/Store/rest/Api/Echo' }, [
    node('RestServiceActionInput', 'Value', { ReceiveIn: 'Body', IsMandatory: 'True' }, [], 'i'),
    ...headerInputs.map((wire, i) => node('RestServiceActionInput', 'Header' + i, { ReceiveIn: 'Header', ReceiveAs: wire, IsMandatory: 'False' }, [], String(i))),
    node('RestServiceActionOutput', 'Result', { SendIn: 'Body' }, [], 'o'), ...method,
  ], 'b');
  const callback = onRequest === null ? null : node('RestServiceCallbackActionFlow', 'OnRequest', { CallbackType: 'OnRequest' }, [
    node('RestServiceCallbackActionFlowInput', 'Request', { DataType: 'HTTPRequest' }, [], 'r'),
    node('RestServiceCallbackActionFlowOutput', 'CustomizedRequest', { DataType: 'HTTPRequest' }, [], 'w'),
    ...(onRequest ?? [start(), lane === 'o11' ? header('"X-SSAM-Guard"', 'h') : headerList('Name = "X-SSAM-Guard"'), end()])], 'g');
  const service = node('RestService', 'Api', { URL: '/Store/rest/Api', Authentication: 'None', ...properties }, callback ? [action, callback] : [action], 'c');
  const model = { schema: 'ssam-reading/1', model: binding.module, sourceSha256: binding.sourceSha256, tree: service };
  const document = { swagger: '2.0', host: 'dev.example.test', basePath: '/Store/rest/Api', schemes: ['https'],
    consumes: ['application/json'], produces: ['application/json'],
    paths: { '/Echo': { post: { parameters: [{ in: 'body', name: 'Value', required: true, schema: { type: 'string' } },
      ...headerInputs.map(wire => ({ in: 'header', name: wire, required: false, type: 'string' }))],
      responses: { 200: { description: 'OK', schema: { type: 'string' } }, 401: { description: 'Unauthorized' } } } } } };
  const contract = () => { const body = JSON.stringify(document);
    return { binding, model, entryKey: key('b'), source: { url: binding.runtimeUrl + 'rest/Api/swagger.json', body, sha256: sha(body) } }; };
  return { oml, binding, action, service, model, document, contract };
}

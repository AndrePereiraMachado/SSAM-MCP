// Synthetic published RestService with Authentication=Custom. The OnAuthentication
// subtree follows the native reading: RestServiceAuthenticationFlow with the
// O11 HTTPRequestHandler.GetRequestHeader call. Arguments follow the real published reading
// (debug-native-custom-real-getrequestheader.json): Parameter resolved to the callee signature and one
// child Expression whose Text restates Value.
import { createHash } from 'node:crypto';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const key = c => c.repeat(22);
export function node(kind, name, properties = {}, children = [], id = 'd', extra = {}) {
  return { kind, name, key: key(id), properties, propertyReferences: {}, children, childrenTotal: children.length,
    childrenOmitted: 0, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [], ...extra };
}
export const expression = (value, id) => node('Expression', '', { Type: 'BasicType:Text', DisplayValue: value, Text: value }, [], id, { key: key(id) + '.#Value' });
export const argument = (parameter, value, id, owner = 'Reference:X/ServerActionSignature:X') => node('Argument', '', { Value: value, Parameter: 'InputParameterSignature:' + parameter }, [expression(value, id)], id,
  { propertyReferences: { Parameter: { kind: 'InputParameterSignature', name: parameter, key: key(id.toUpperCase()), path: owner + '/InputParameterSignature:' + parameter } } });
export const call = (module, action, id, args = []) => node('ExecuteServerActionNode', action, { Action: 'ServerActionSignature:' + action }, args, id,
  { propertyReferences: { Action: { kind: 'ServerActionSignature', name: action, key: key(id.toUpperCase()),
    path: module ? 'Reference:' + module + '/ServerActionSignature:' + action : 'ServerAction:' + action } } });
export const GET_REQUEST_HEADER = 'Reference:HTTPRequestHandler/ServerActionSignature:GetRequestHeader';
export const header = (name, id, argumentId = '9') => call('HTTPRequestHandler', 'GetRequestHeader', id, [argument('HeaderName', name, argumentId, GET_REQUEST_HEADER)]);

export function customFixture({ lane = 'o11', flow } = {}) {
  const oml = 'synthetic custom-auth published model';
  const binding = { lane, module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: sha(oml), runtimeUrl: 'https://dev.example.test/Store/' };
  const action = node('RestServiceAction', 'Echo', { HTTPMethod: 'POST', URL: '/Store/rest/Api/Echo' }, [
    node('RestServiceActionInput', 'Value', { ReceiveIn: 'Body', IsMandatory: 'True' }, [], 'i'),
    node('RestServiceActionOutput', 'Result', { SendIn: 'Body' }, [], 'o'),
  ], 'b');
  const onAuthentication = flow === null ? null : node('RestServiceAuthenticationFlow', 'OnAuthentication', { AuthenticationCallbackType: 'Custom' }, flow ?? [
    node('StartNode', '', {}, [], 's'), header('"X-Api-Key"', 'h', '1'),
    call('Users', 'User_Login', 'u', [argument('Username', '"svc"', '2', 'Reference:Users/ServerActionSignature:User_Login')]), node('EndNode', '', {}, [], 'e'),
  ], 'f');
  const service = node('RestService', 'Api', { URL: '/Store/rest/Api', Authentication: 'Custom' }, onAuthentication ? [action, onAuthentication] : [action], 'c');
  const model = { schema: 'ssam-reading/1', model: binding.module, sourceSha256: binding.sourceSha256, tree: service };
  const document = { swagger: '2.0', host: 'dev.example.test', basePath: '/Store/rest/Api', schemes: ['https'],
    consumes: ['application/json'], produces: ['application/json'],
    paths: { '/Echo': { post: { parameters: [{ in: 'body', name: 'Value', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'OK', schema: { type: 'string' } }, 401: { description: 'Unauthorized' } } } } } };
  const contract = () => { const body = JSON.stringify(document);
    return { binding, model, entryKey: key('b'), source: { url: binding.runtimeUrl + 'rest/Api/swagger.json', body, sha256: sha(body) } }; };
  return { oml, binding, action, service, model, document, contract };
}

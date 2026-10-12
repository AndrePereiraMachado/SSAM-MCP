import { createHash } from 'node:crypto';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const key = letter => letter.repeat(22);
const node = (kind, name, properties, children = [], letter = 'C') => ({ kind, name, properties,
  key: key(letter), children, childrenTotal: children.length, childrenOmitted: 0, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] });
export function restFixture(lane = 'odc', authentication = 'None') {
  const oml = 'synthetic immutable published model';
  const binding = { lane, tenant: 'dev.example.test', runtimeUrl: 'https://dev.example.test/App/', module: 'App', moduleKey: key('M'),
    revision: 42, sourceSha256: sha(oml) };
  const entry = { key: key('A'), kind: 'RestServiceAction', name: 'Echo', entryKind: 'rest-method', path: 'RestService:Api/RestServiceAction:Echo' };
  const action = node('RestServiceAction', 'Echo', { HTTPMethod: 'POST', URL: '/App/rest/Api/Echo', URLPath: '/Echo' }, [
    node('RestServiceActionInput', 'Value', { ReceiveIn: 'Body', IsMandatory: 'True' }, [], 'I'),
    node('RestServiceActionOutput', 'Result', { SendIn: 'Body' }, [], 'O'),
  ], 'A');
  const model = { schema: 'ssam-reading/1', model: binding.module, sourceSha256: binding.sourceSha256,
    tree: node('RestService', 'Api', { URL: '/App/rest/Api', Authentication: authentication }, [action]) };
  const document = { swagger: '2.0', host: 'dev.example.test', basePath: '/App/rest/Api', schemes: ['https'],
    consumes: ['application/json'], produces: ['application/json'],
    ...(authentication === 'Basic' ? { securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }] } : {}),
    paths: { '/Echo': { post: { parameters: [{ in: 'body', name: 'Value', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'OK', schema: { type: 'string' } } } } } } };
  const body = JSON.stringify(document);
  const contract = { binding, model, entryKey: entry.key, source: { url: 'https://dev.example.test/App/rest/Api/swagger.json', body, sha256: sha(body) } };
  return { oml, binding, entry, model, body, contract };
}

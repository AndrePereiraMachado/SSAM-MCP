export function credentialRows() {
  const host = 'tenant.example.test';
  const context = { host, service: 'service-center', auth: 'credential' };
  const request = { ...context, op: 'request', method: 'GET', url: `https://${host}/ServiceCenter/Errors_List.aspx` };
  const rows = [];
  const add = (name, value, code = null) => rows.push({ name, request: value, expected: code ? { error: code } : { ok: true } });
  for (const op of ['status', 'prompt', 'login', 'forget', 'sign-out']) add(op, { ...context, op });
  add('SC logs', request);
  add('SC stored profile', { ...context, op: 'status', profile: 'a'.repeat(64) });
  add('SC profile selection', { ...context, op: 'prompt', mode: 'select-profile' });
  add('Portal account', { ...context, service: 'odc-portal', op: 'login' });
  add('Portal API client', { ...context, service: 'odc-portal', auth: 'api-client', op: 'login' });
  for (const route of ['/api/apps/v1/apps', '/apps/', '/apps/scripts/_osbundle-index.js', '/apps/scripts/deep/module.js', '/apps/moduleservices/moduleversioninfo', '/apps/screenservices/apps/List'])
    add('Portal GET ' + route, { ...request, service: 'odc-portal', url: `https://${host}${route}` });
  add('SC read POST', { ...request, method: 'POST', body: Buffer.from('search=text').toString('base64'), contentType: 'application/x-www-form-urlencoded' });
  add('Portal authorized write', { ...request, service: 'odc-portal', url: `https://${host}/api/apps/v1/apps`, method: 'PATCH', body: Buffer.from('{}').toString('base64'), contentType: 'application/json', write: true, operationId: 'apps-update', authorizeSha256: 'b'.repeat(64) });
  for (const [method, route] of [['POST', '/apps/'], ['POST', '/apps/scripts/index.js'], ['GET', '/identity/'], ['GET', '/authentication/']])
    add('Portal blocks ' + method + ' ' + route, { ...request, service: 'odc-portal', method, url: `https://${host}${route}` }, 'PARAMS_INVALID');
  for (const [name, change] of [
    ['unknown parameter', { extra: true }], ['unknown operation', { op: 'confirm' }], ['unknown service', { service: 'arbitrary' }], ['invalid auth for SC', { auth: 'api-client' }],
    ['unknown host', { host: 'localhost' }], ['uppercase host', { host: 'Tenant.example.test' }], ['profile path', { profile: 'SSAM/Other' }],
    ['another host', { url: 'https://other.example.test/ServiceCenter/Errors_List.aspx' }], ['HTTP', { url: `http://${host}/ServiceCenter/Errors_List.aspx` }],
    ['URL password', { url: `https://person:password@${host}/ServiceCenter/Errors_List.aspx` }], ['fragment', { url: request.url + '#fragment' }], ['raw traversal', { url: `https://${host}/ServiceCenter/../secret` }],
    ['encoded traversal', { url: `https://${host}/ServiceCenter/%2e%2e/secret` }], ['GET body', { body: 'eA==', contentType: 'application/json' }], ['invalid base64', { method: 'POST', body: '***', contentType: 'application/json' }],
    ['noncanonical base64', { method: 'POST', body: 'Zh==', contentType: 'application/json' }], ['unsupported content type', { contentType: 'multipart/form-data' }],
    ['header injection', { accept: 'text/html\r\nAuthorization: x' }], ['write without receipt', { method: 'DELETE', write: true }],
    ['secret JSON field', { method: 'POST', body: Buffer.from('{"access_token":"x"}').toString('base64'), contentType: 'application/json' }],
    ['secret form field', { method: 'POST', body: Buffer.from('client_secret=x').toString('base64'), contentType: 'application/x-www-form-urlencoded' }],
    ['secret query', { url: request.url + '?access_token=x' }], ['CSRF query', { url: request.url + '?csrfToken=x' }],
  ]) add(name, { ...request, ...change }, 'PARAMS_INVALID');
  add('private host', { ...request, host: 'machine.local' }, 'CREDENTIAL_HOST_INTERNAL');
  add('unsupported private injection', { ...request, secretRefs: [{ field: 'password' }] }, 'CREDENTIAL_SECRET_REFS_UNAVAILABLE');
  const timer = new URL(`https://${host}/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/`);
  timer.search = new URLSearchParams({ EventNames: 'TimerExecuted', StartInstant: '2026-11-02T00:00:00.000Z', EndInstant: '2026-11-02T00:30:00.000Z', NumberOfResults: '10' }).toString();
  for (const auth of ['basic', 'service-token']) {
    add('timer ' + auth, { ...request, auth, url: timer.href });
    add('timer ' + auth + ' refuses another route', { ...request, auth }, 'PARAMS_INVALID');
    add('timer ' + auth + ' refuses duplicate query', { ...request, auth, url: timer.href + '&NumberOfResults=1' }, 'PARAMS_INVALID');
    add('timer ' + auth + ' refuses long window', { ...request, auth, url: timer.href.replace('00%3A30', '02%3A30') }, 'PARAMS_INVALID');
    add('timer ' + auth + ' refuses padded limit', { ...request, auth, url: timer.href.replace('NumberOfResults=10', 'NumberOfResults=010') }, 'PARAMS_INVALID');
  }
  return rows;
}

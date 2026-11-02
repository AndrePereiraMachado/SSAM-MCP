// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
// SC_PROTOCOL_INVALID with its cause (meta de 20/10, item 21; lote 4, F6). Until 25/10 the friction queue kept only the code of
// the 34 SC_PROTOCOL_INVALID of 14..24/10; the answers preserved in the sessions show the seven after 20/10 were all local
// argument refusals, replayed here with their exact MCP arguments over a fake Studio bridge: each one is now resolved
// (normalizations) or refused as SC_ARGUMENT_INVALID with the argument, the fix and the corrected call. What Service Center
// itself may answer instead of what a call expects (its login page, an error page, a redirect out of /ServiceCenter/,
// JSON) is SC_PROTOCOL_INVALID with protocol {operation, expected, got, sample, form} and the continuation of that form,
// through a loopback HTTP server and the Studio web transport. Nothing real is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { ArgumentInvalid, ProtocolError } from '../service-center/errors.mjs';
import { Transport } from '../service-center/http.mjs';
import { serviceCenterTool, limitModules } from '../service-center/index.mjs';
import { ProtocolMismatch, protocolContinuation, protocolForm, protocolSample } from '../service-center/protocol.mjs';
import { serviceCenterArguments } from '../o11-operations.mjs';
import { UsersTransport, UsersError } from '../users/client.mjs';
import { runWithExecutor } from '../executor.mjs';
import { FakeBridge, SC, temp } from './fixtures/sc-fake-bridge.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1'; process.env.SSAM_PROMPT_WAIT_MS = '0';
const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

function world({ pages = {} } = {}) {
  const bridge = new FakeBridge({ pages, api: {
    ListEspaces: [{ Key: 'k-office', Name: 'OfficePet_CS', Id: 641 }, { Key: 'k-reserve', Name: 'SSAMCoverageReserve', Id: 712 }, { Key: 'k-core', Name: 'SSAMCoverageCore', Id: 713 }],
    ListExtensions: [],
    ListApplications: [{ Key: 'app-loan', Name: 'Equipment Loan Portal' }, { Key: 'app-consumer', Name: 'SSAMCoverageConsumer' }],
    GetConsumers: a => [{ Name: 'Consumer of ' + a.producerESpaceKey }],
    GetESpaceId: a => ({ 'k-office': 641, 'k-reserve': 712, 'k-core': 713 })[a.eSpaceKey],
    GetApplicationDependenciesDetails: a => ({ application: a.appKey, dependencies: [] }),
    GetApplicationDetails: a => ({ Key: a.appKey, Name: 'SSAMCoverageConsumer' }),
  } });
  const deps = { journal: new Journal(temp()), locate: () => bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no prompt with a Studio connected'), exports: temp(), registry: REGISTRY, sleep: async () => {} };
  const call = (input, kind = 'read') => serviceCenterTool(serviceCenterArguments(input, kind), deps);
  return { bridge, call, api: name => bridge.calls.filter(c => c[0] === 'api' && c[2] === name) };
}

// ---- the seven SC_PROTOCOL_INVALID of 21..24/10, as the sessions sent them -------------------------------------------------

test('22388a8e: consumers with the module name as moduleId resolves the module and its key, and says so', async () => {
  const w = world();
  const answer = await w.call({ action: 'consumers', host: PERSONAL, moduleId: 'OfficePet_CS', session: 'studio', authPrompt: 'never' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(w.api('GetConsumers').map(c => c[3].producerESpaceKey), ['k-office']);
  assert.deepEqual(answer.result.normalizations.map(n => [n.argument, n.as]), [['moduleId', 'module'], ['module', 'moduleKey']]);
  assert.equal(answer.result.normalizations[1].key, 'k-office');
});

test('3853bf8f: no host is SC_ARGUMENT_INVALID with the registered hosts and the call with the only personal one', async () => {
  const w = world();
  const answer = await w.call({ action: 'application-dependencies', application: 'Equipment Loan Portal' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'SC_ARGUMENT_INVALID');
  assert.equal(answer.result.argument, 'host');
  assert.equal(answer.result.error, 'Required: --host');
  assert.match(answer.result.fix, new RegExp(PERSONAL.replaceAll('.', '\\.') + ' personal'));
  assert.deepEqual(answer.continuation, { tool: 'o11_service_center_read', arguments: { action: 'application-dependencies', application: 'Equipment Loan Portal', host: PERSONAL },
    why: 'the only personal environment registered; another host is named by the user' });
  assert.equal(w.bridge.calls.length, 0, 'nothing reached the Studio');
});

test('11983068, badc66e0: application-dependencies and application by name resolve the application key', async () => {
  const w = world();
  const dependencies = await w.call({ action: 'application-dependencies', application: 'Equipment Loan Portal', host: PERSONAL });
  assert.equal(dependencies.ok, true, JSON.stringify(dependencies));
  assert.deepEqual(w.api('GetApplicationDependenciesDetails').map(c => c[3].appKey), ['app-loan']);
  const application = await w.call({ action: 'application', application: 'SSAMCoverageConsumer', host: PERSONAL, session: 'auto', authPrompt: 'never' });
  assert.equal(application.ok, true, JSON.stringify(application));
  assert.equal(application.result.normalizations[0].key, 'app-consumer');
  // an exact name that matches nothing still refuses, with its own code and the fix
  const unknown = await w.call({ action: 'application', application: 'Nope', host: PERSONAL });
  assert.equal(unknown.code, 'SC_ARGUMENT_INVALID');
  assert.equal(unknown.result.argument, 'application');
  assert.match(unknown.result.fix, /o11_service_center_read \{action:"applications"\}/);
});

test('b6d87b98, 00344ee7: module-id by module name resolves the key and answers the numeric ID', async () => {
  const w = world();
  for (const [module, id] of [['SSAMCoverageCore', 713], ['SSAMCoverageReserve', 712]]) {
    const answer = await w.call({ action: 'module-id', host: PERSONAL, module, authPrompt: 'never' });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.result.result, id);
  }
  const ambiguous = world();
  ambiguous.bridge.replies.ListEspaces = [{ Key: 'a', Name: 'Twin' }, { Key: 'b', Name: 'Twin' }];
  const twice = await ambiguous.call({ action: 'module-id', host: PERSONAL, module: 'Twin' });
  assert.equal(twice.code, 'SC_ARGUMENT_INVALID');
  assert.match(twice.result.error, /found 2/);
});

test('47bf32e0: timer-run with the module name as moduleId resolves its numeric ID before the page; an error page then is SC_PROTOCOL_INVALID with the protocol detail', async () => {
  const w = world({ pages: { [`GET ${SC}eSpace_Edit.aspx?EspaceId=712`]: { ok: true, status: 500, finalUrl: `https://${PERSONAL}${SC}eSpace_Edit.aspx?EspaceId=712`, contentType: 'text/html',
    html: '<html><head><title>Runtime Error</title></head><body><h1>Server Error in \'/ServiceCenter\' Application.</h1><input type="hidden" name="__VIEWSTATE" value="c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0"></body></html>' } } });
  const answer = await w.call({ action: 'timer-run', host: PERSONAL, moduleId: 'SSAMCoverageReserve', name: 'C06QualificationTimer', authPrompt: 'never' }, 'write');
  assert.equal(answer.code, 'SC_PROTOCOL_INVALID', JSON.stringify(answer));
  assert.equal(answer.result.normalizations[0].argument, 'moduleId');
  assert.ok(w.bridge.calls.some(c => c[0] === 'web' && c[3] === `${SC}eSpace_Edit.aspx?EspaceId=712`), 'the page of the resolved numeric ID');
  const { protocol } = answer.result;
  assert.equal(protocol.operation, `GET ${SC}eSpace_Edit.aspx`);
  assert.equal(protocol.form, 'error-page');
  assert.match(protocol.got, /HTTP 500, text\/html, error-page/);
  assert.match(protocol.sample, /Runtime Error/);
  assert.doesNotMatch(protocol.sample, /c2VjcmV0/);
  assert.ok(protocol.sample.length <= 300);
  // a write is never repeated: the session status is the next call
  assert.equal(answer.continuation.tool, 'o11_service_center_session');
});

// ---- what Service Center answers instead, one form each ----------------------------------------------------------------------

async function loopback(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
const HOST = 'sc.example.test';

test('login HTML in place of the OsAjax reply: form login, sample without the session values, continuation sign-in', async () => {
  const server = await loopback((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body><form method="post" action="Login.aspx"><div class="sc-layout-login"><input type="hidden" name="__OSVSTATE" value="opaque-state-value"><input name="user" value="agnes@example.test"><input type="password" name="pass" value="hunter2"></div></form></body></html>');
  });
  try {
    const t = new Transport(HOST, { origin: server.origin });
    const error = await t.text('Error_Logs.aspx').then(() => null, e => e);
    assert.ok(error instanceof ProtocolMismatch, String(error));
    assert.equal(error.code, 'SC_PROTOCOL_INVALID');
    assert.deepEqual([error.protocol.operation, error.protocol.form], [`GET ${SC}Error_Logs.aspx`, 'login']);
    assert.match(error.protocol.expected, /OsAjax or JSON/);
    for (const secret of ['opaque-state-value', 'agnes@example.test', 'hunter2']) assert.doesNotMatch(error.protocol.sample, new RegExp(secret));
    const next = protocolContinuation(error.protocol, { host: HOST, retry: { tool: 'o11_service_center_read', arguments: { action: 'logs', host: HOST } } });
    assert.deepEqual([next.continuation.tool, next.continuation.arguments], ['o11_service_center_session', { action: 'sign-in', host: HOST }]);
  } finally { await server.close(); }
});

test('a redirect out of /ServiceCenter/ is form redirect with the destination host and no query; continuation the session status', async () => {
  const server = await loopback((request, response) => { response.writeHead(302, { Location: 'https://elsewhere.example.test/portal?code=SECRETCODE&state=abc' }); response.end(); });
  try {
    const error = await new Transport(HOST, { origin: server.origin }).request('Home.aspx').then(() => null, e => e);
    assert.ok(error instanceof ProtocolMismatch, String(error));
    assert.equal(error.protocol.form, 'redirect');
    assert.match(error.protocol.got, /HTTP 302, redirect to elsewhere\.example\.test\/portal/);
    assert.doesNotMatch(JSON.stringify(error.protocol), /SECRETCODE/);
    assert.equal(protocolContinuation(error.protocol, { host: HOST }).continuation.arguments.action, 'status');
  } finally { await server.close(); }
});

test('JSON where a page is expected is form json, its secret fields masked; a read is retried once', async () => {
  const server = await loopback((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ Errors: [{ Message: 'Session expired' }], access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', SessionKey: 'k1' }));
  });
  try {
    const error = await new Transport(HOST, { origin: server.origin }).request('Solutions_List.aspx').then(() => null, e => e);
    assert.ok(error instanceof ProtocolMismatch, String(error));
    assert.equal(error.message, 'Expected Service Center HTML; protocol variant unsupported');
    assert.equal(error.protocol.form, 'json');
    assert.match(error.protocol.sample, /Session expired/);
    assert.doesNotMatch(error.protocol.sample, /eyJ|k1/);
    const retry = { tool: 'o11_service_center_read', arguments: { action: 'solutions', host: HOST } };
    assert.deepEqual(protocolContinuation(error.protocol, { host: HOST, retry }).continuation.arguments, retry.arguments);
  } finally { await server.close(); }
});

test('an HTTP error page is form error-page; the forms and the sample are pure functions', () => {
  assert.equal(protocolForm({ status: 503, contentType: 'text/html', body: '<title>Service Unavailable</title>' }), 'error-page');
  assert.equal(protocolForm({ status: 401 }), 'login');
  assert.equal(protocolForm({ status: 302, location: 'https://id.outsystems.com/oauth?x' }), 'login');
  assert.equal(protocolForm({ status: 200, contentType: 'text/plain', body: 'weird' }), 'unexpected');
  assert.equal(protocolSample('Authorization: Bearer abcdefghijklmnop and password=hunter2'), 'Authorization: Bearer … and password=…');
  assert.equal(protocolSample('ab cd '.repeat(200)).length, 300);
  assert.equal(protocolSample('x'.repeat(1000)), '…', 'a long run (base64, a key) is masked whole');
  assert.equal(protocolSample(null), null);
});

test('page-layout: a path outside the pages refuses with its argument, the /ServiceCenter/ prefix is a normalization; ArgumentInvalid is a ProtocolError', async () => {
  assert.ok(new ArgumentInvalid('host', 'Required: --host', 'give host') instanceof ProtocolError);
  const w = world();
  const answer = await w.call({ action: 'page-layout', host: PERSONAL, path: '/ServiceCenter/../Login.aspx' });
  assert.equal(answer.code, 'SC_ARGUMENT_INVALID');
  assert.equal(answer.result.argument, 'path');
  // the prefix itself is a normalization, never a refusal (19/10: path "/ServiceCenter/Error_Logs.aspx")
  const normalized = await world({ pages: { [`GET ${SC}Error_Logs.aspx`]: { ok: true, status: 200, contentType: 'application/json', html: '{"a":1}' } } })
    .call({ action: 'page-layout', host: PERSONAL, path: '/ServiceCenter/Error_Logs.aspx' });
  assert.equal(normalized.result.normalizations[0].as, 'Error_Logs.aspx');
  assert.equal(normalized.result.protocol.form, 'json');
});

test('81fce8e9: moduleLimit limits the modules listing and says the total', () => {
  const listing = { operation: 'ListEspaces', result: Array.from({ length: 397 }, (_, i) => ({ Key: 'k' + i, Name: 'M' + i })) };
  const limited = limitModules(listing, 5);
  assert.equal(limited.result.length, 5);
  assert.deepEqual(limited.limited, { moduleLimit: 5, total: 397, returned: 5 });
  assert.equal(limitModules(listing, null), listing);
  const rows = limitModules({ rows: [1, 2, 3] }, 2);
  assert.deepEqual([rows.rows, rows.limited.total], [[1, 2], 3]);
});

test('81fce8e9 through the tool: modules with moduleLimit answers that many', async () => {
  const w = world();
  const answer = await w.call({ action: 'modules', host: PERSONAL, moduleLimit: 2 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.result.result.length, 2);
  assert.equal(answer.result.limited.total, 3);
});

test('an unconfirmed write receipt has a code of its own and the verify continuation, never SC_LOCAL_FAILURE', async () => {
  const result = { ok: false, host: PERSONAL, operationId: '3e5f4006-1cbc-4fec-a03a-821f4120de63', state: 'uncertain', error: 'Response or readback was not confirmed' };
  const { serviceCenterTool: tool } = await import('../service-center/index.mjs');
  // the tool's wrapper over a runner that answers that receipt (the 32 SC_LOCAL_FAILURE of 14/10)
  const answer = await toolWith(tool, result);
  assert.equal(answer.code, 'SC_WRITE_UNCERTAIN');
  assert.deepEqual(answer.continuation.arguments, { action: 'verify', host: PERSONAL, operationId: result.operationId });
});

// serviceCenterTool reads runServiceCenter's answer; a write whose journal already holds the receipt answers it as it is.
async function toolWith(tool, receipt) {
  const journal = new Journal(temp());
  const original = journal.lookup.bind(journal);
  journal.lookup = id => (id === receipt.operationId ? { ...receipt, identity: { host: PERSONAL, action: 'timer-run', moduleId: '712', name: 'T' } } : original(id));
  return tool(['receipt', '--operation-id=' + receipt.operationId], { journal, registry: REGISTRY, locate: () => null, present: async () => false });
}

test('any other SC_PROTOCOL_INVALID carries the operation and the refusal as its protocol detail (the queue records it)', async () => {
  const w = world();
  w.bridge.replies.CheckSolutionPublish = { messages: [] };
  const answer = await w.call({ action: 'solution-publish-status', host: PERSONAL, publishId: '17', operationId: '7f1a2b3c-0000-4000-8000-000000000001' });
  assert.equal(answer.code, 'SC_PROTOCOL_INVALID');
  assert.deepEqual(answer.result.protocol, { operation: 'solution-publish-status', expected: 'a Service Center answer this operation knows',
    got: 'Publication status must match the recorded host, operation and job', sample: null, form: 'unexpected' });
});

// ---- HTTP 404 has its own answer (review of the server line: SC_PROTOCOL_INVALID came back for a 404, naming Service Center
// even on a Users page) ----------------------------------------------------------------------------------------------------

test('a 404 page of the Studio web transport is SC_PAGE_NOT_FOUND with the live listing as next call, never SC_PROTOCOL_INVALID or a retry', async () => {
  const w = world({ pages: { [`GET ${SC}eSpace_Edit.aspx?EspaceId=9999`]: { ok: true, status: 404, finalUrl: `https://${PERSONAL}${SC}eSpace_Edit.aspx?EspaceId=9999`, contentType: 'text/html',
    html: '<html><head><title>404 - File or directory not found.</title></head><body>Not found</body></html>' } } });
  const answer = await w.call({ action: 'timers', host: PERSONAL, moduleId: '9999', authPrompt: 'never' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'SC_PAGE_NOT_FOUND', JSON.stringify(answer));
  assert.equal(answer.result.protocol.operation, `GET ${SC}eSpace_Edit.aspx`);
  assert.match(answer.result.protocol.got, /^HTTP 404\b/);
  assert.match(answer.result.error, new RegExp('HTTP 404 for GET /ServiceCenter/eSpace_Edit\.aspx: the page, or the ID or key it names, does not exist on ' + PERSONAL.replaceAll('.', '\.')));
  assert.match(answer.result.error, /Repeating the same call answers the same\.$/);
  assert.deepEqual(answer.continuation.arguments, { action: 'modules', host: PERSONAL });
  assert.equal(answer.result.alternatives, undefined, 'no retry of the same read is offered');
});

test('a 404 of the direct transport is PageNotFound (SC_PAGE_NOT_FOUND); any other HTTP error stays a protocol mismatch', async () => {
  let status = 404;
  const server = await loopback((request, response) => { response.writeHead(status, { 'Content-Type': 'text/html' }); response.end('<title>Not Found</title>'); });
  try {
    const missing = await new Transport(HOST, { origin: server.origin }).request('eSpace_Edit.aspx?EspaceId=1').then(() => null, e => e);
    assert.ok(missing instanceof ProtocolMismatch, String(missing));
    assert.equal(missing.code, 'SC_PAGE_NOT_FOUND');
    assert.equal(missing.message, 'Service Center returned HTTP 404', 'the transport sentence the download classifier reads (http-404)');
    status = 500;
    const broken = await new Transport(HOST, { origin: server.origin }).request('eSpace_Edit.aspx?EspaceId=1').then(() => null, e => e);
    assert.equal(broken.code, 'SC_PROTOCOL_INVALID');
    assert.equal(broken.protocol.form, 'error-page');
  } finally { await server.close(); }
});

test('a 404 of a Users page is USERS_PAGE_NOT_FOUND and names Users, never Service Center', async () => {
  const server = await loopback((request, response) => { response.writeHead(404, { 'Content-Type': 'text/html' }); response.end('<title>Not Found</title>'); });
  try {
    const error = await new UsersTransport(HOST, { origin: server.origin }).request('User_Show.aspx?UserId=42').then(() => null, e => e);
    assert.ok(error instanceof UsersError, String(error));
    assert.equal(error.code, 'USERS_PAGE_NOT_FOUND');
    assert.match(error.message, /^Users answered HTTP 404 for User_Show\.aspx: the page, or the user, group or role its ID names, does not exist on sc\.example\.test\./);
    assert.doesNotMatch(error.message, /Service Center/);
  } finally { await server.close(); }
});

test('hosted, a call without host lists no environment of the server registry and suggests none', async () => {
  const workspace = temp();
  const context = { id: 'protocol-test', hosted: true, workspace, executor: { call: async () => { throw new Error('nothing is sent'); } } };
  const answer = await runWithExecutor(context, () => serviceCenterTool(serviceCenterArguments({ action: 'application-dependencies', application: 'Equipment Loan Portal' }, 'read'),
    { journal: new Journal(temp()), locate: () => assert.fail('nothing is located'), present: async () => false, running: async () => false, exports: temp(), registry: REGISTRY }));
  assert.equal(answer.code, 'SC_ARGUMENT_INVALID');
  assert.equal(answer.result.argument, 'host');
  assert.equal(answer.result.fix, 'give host: the O11 environment DNS name');
  assert.doesNotMatch(JSON.stringify(answer), /personal-0000test|readonly\.example/);
  assert.equal(answer.continuation, undefined);
});

// Review W2-DIAG, correction 2: one rule masks every secret of the sample, never case by case.
test('the sample masks quoted and unquoted secrets of any secret-named key, cookie headers, value attributes and textarea bodies', () => {
  const cases = [
    ['password = "s3cr3t value"', ['s3cr3t']],
    ["pwd='p4ss w0rd'", ['p4ss']],
    ['<input type=hidden name=__VIEWSTATE value=c2VjcmV0c2VjcmV0>', ['c2VjcmV0']],
    ['{"pass":"hunter2","apiKey":"abc123","SessionToken":"zzz","refresh_token":42}', ['hunter2', 'abc123', 'zzz', '42']],
    ['Set-Cookie: ASP.NET_SessionId=abcd1234efgh; osVisitor=xyz-123', ['abcd1234efgh', 'xyz-123']],
    ['Cookie: .ASPXAUTH=0123456789ABCDEF; OSSESSION=deadbeef', ['0123456789ABCDEF', 'deadbeef']],
    ['<a href="/ServiceCenter/Login.aspx?ReturnUrl=x&OSToken=abcdef0123">x</a>', ['abcdef0123']],
    ['<textarea name="secret">plain secret in body</textarea>', ['plain secret in body']],
    ['<td>Password:</td><td>Hunter2</td>', ['Hunter2']],
    ['Data Source=db;User ID=sa;Password=Hunter2!x;Initial Catalog=X', ['Hunter2']],
    ['Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l', ['YWxhZGRpbjpvcGVuc2VzYW1l']],
    ['X-Auth-Key: k-12345', ['k-12345']],
    ['key 0123456789abcdef0123456789abcdef', ['0123456789abcdef0123456789abcdef']],
    ['-----BEGIN RSA PRIVATE KEY----- MIIBOgIBAAJBAKj34Gkx -----END RSA PRIVATE KEY-----', ['MIIBOgIBAAJBAKj34Gkx']],
  ];
  for (const [input, secrets] of cases) {
    const sample = protocolSample(input);
    for (const secret of secrets) assert.ok(!sample.includes(secret), `${input} -> ${sample}`);
  }
  // What is no secret stays readable: the error text and the names.
  assert.equal(protocolSample('<title>Runtime Error</title> Server Error in \'/ServiceCenter\' Application.'), '<title>Runtime Error</title> Server Error in \'/ServiceCenter\' Application.');
  assert.match(protocolSample('Set-Cookie: a=b'), /^Set-Cookie: …$/);
  assert.match(protocolSample('<a href="/ServiceCenter/Login.aspx?ReturnUrl=x&OSToken=abc">'), /ReturnUrl=x&OSToken=…/);
});

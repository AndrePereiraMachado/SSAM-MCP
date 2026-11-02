import { privateChild, completedPrivateChild } from './fixtures/private-child.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialSession, validateCredentialRequest, CREDENTIAL_KIND } from '../lib/credential-session.mjs';
import { createPrivateRuntime, createSecretRedactor, privateScope, createLoginBrake } from '../lib/private-runtime.mjs';
import { createUsersKind, usersScope } from '../lib/users.mjs';
import { helloKinds } from '../lib/kinds.mjs';
import { createAgent } from '../lib/agent.mjs';
import { credentialRows } from './fixtures/credential-table.mjs';

const host = 'tenant.example.test';
const base = { host, service: 'service-center', auth: 'credential' };
const request = { ...base, op: 'request', url: 'https://' + host + '/ServiceCenter/Errors_List.aspx', method: 'GET' };
const b64 = value => Buffer.from(value).toString('base64');
const page = (over = {}) => ({ ok: true, status: 200, contentType: 'text/html', body: b64('<html>logs</html>'), ...over });
for (const row of credentialRows()) test('shared credential table: ' + row.name, () => {
  let result;
  try { validateCredentialRequest(row.request); result = { ok: true }; } catch (error) { result = { error: error.code }; }
  assert.deepEqual(result, row.expected);
});
function kind(over = {}) {
  const calls = [], answers = [];
  const agent = createCredentialSession({ dataRoot: path.join(os.tmpdir(), 'credential-test'), platform: 'win32', lookup: async () => [{ address: '93.184.216.34' }],
    exec: async (file, args, input) => { calls.push({ file, args, input: JSON.parse(input) }); return JSON.stringify(answers.shift() ?? page()); }, ...over });
  return { agent, calls, answers };
}

test('credential.session is announced without changing the existing Users kind', () => {
  assert.equal(CREDENTIAL_KIND, 'credential.session');
  assert.ok(helloKinds(null).includes(CREDENTIAL_KIND));
  assert.ok(helloKinds(null).includes('o11.users'));
});

test('private vault scopes preserve Users identity and isolate server accounts', () => {
  assert.equal(privateScope('C:\\agent', 'account-a'), usersScope('C:\\agent', 'account-a'));
  assert.notEqual(privateScope('C:\\agent', 'account-a'), privateScope('C:\\agent', 'account-b'));
});

for (const op of ['status', 'prompt', 'login', 'forget', 'sign-out']) test('credential protocol accepts ' + op, () => validateCredentialRequest({ ...base, op }));
for (const [name, change] of [
  ['a password field', { password: 'do-not-send' }], ['a cookie header', { headers: { cookie: 'do-not-send' } }],
  ['another host', { url: 'https://other.example.test/ServiceCenter/Errors_List.aspx' }],
  ['HTTP', { url: 'http://' + host + '/ServiceCenter/Errors_List.aspx' }],
  ['credentials in URL', { url: 'https://a:b@' + host + '/ServiceCenter/Errors_List.aspx' }],
  ['encoded traversal', { url: 'https://' + host + '/ServiceCenter/%2e%2e/private' }],
  ['raw traversal', { url: 'https://' + host + '/ServiceCenter/../private' }],
  ['host-local access', { host: 'something.local' }], ['profile path', { profile: 'SSAM/another/account' }],
  ['body on GET', { body: b64('x=1'), contentType: 'application/x-www-form-urlencoded' }],
  ['secret JSON', { method: 'POST', body: b64('{"nested":{"access_token":"secret"}}'), contentType: 'application/json' }],
  ['secret form', { method: 'POST', body: b64('client_secret=secret'), contentType: 'application/x-www-form-urlencoded' }],
  ['write without authorization', { method: 'DELETE', write: true }],
  ['unsupported secret injection', { secretRefs: [{ field: 'password' }] }],
]) test('credential protocol refuses ' + name + ' before a helper starts', async () => {
  const k = kind();
  await assert.rejects(k.agent.execute({ ...request, ...change }));
  assert.equal(k.calls.length, 0);
});

test('Portal metadata reads are allowed, but not metadata writes or identity pages', () => {
  for (const route of ['/apps/', '/apps/scripts/_osbundle-index.js', '/apps/moduleservices/moduleversioninfo', '/apps/screenservices/apps/List'])
    validateCredentialRequest({ ...request, service: 'odc-portal', url: 'https://' + host + route });
  for (const route of ['/identity/', '/authentication/', '/apps/scripts/a.js'])
    assert.throws(() => validateCredentialRequest({ ...request, service: 'odc-portal', method: 'POST', url: 'https://' + host + route }));
});

test('private sessions and authentication echoes never enter the public result', async () => {
  const password = 'SentinelPassword-A9<&>', token = 'SentinelToken-B8', cookie = 'SentinelCookie-C7';
  const k = kind();
  k.answers.push({ ok: true, authenticated: true, privateSession: { token, cookies: { SID: cookie } }, secretValues: [password, token, cookie] });
  assert.deepEqual(await k.agent.execute({ ...base, op: 'login' }), { authenticated: true });
  k.answers.push(page({ body: b64([password, encodeURIComponent(password), b64(password), token, cookie].join('|')), location: '/next?echo=' + cookie, url: request.url + '?echo=' + token, extra: password }));
  const result = await k.agent.execute(request);
  const bytes = JSON.stringify(result) + Buffer.from(result.body, 'base64').toString();
  for (const secret of [password, token, cookie, encodeURIComponent(password), b64(password)]) assert.ok(!bytes.includes(secret));
  assert.deepEqual(k.calls[1].input.privateSession, { token, cookies: { SID: cookie } });
  assert.ok(k.calls.every(c => !JSON.stringify(c.args).includes(password) && !JSON.stringify(c.args).includes(cookie) && !JSON.stringify(c.args).includes(token)));
  assert.ok(!Object.hasOwn(result, 'privateSession'));
  assert.ok(!Object.hasOwn(result, 'extra'));
});

test('sessions stay separate for host, service, profile and auth', async () => {
  const k = kind();
  k.answers.push({ ok: true, authenticated: true, privateSession: { token: 'private-session' } });
  await k.agent.execute({ ...base, op: 'login' });
  for (const changes of [{ host: 'other.example.test' }, { service: 'odc-portal' }, { profile: 'a'.repeat(64) }]) {
    k.answers.push({ ok: true, available: false });
    await k.agent.execute({ ...base, op: 'status', ...changes });
    assert.equal(k.calls.at(-1).input.privateSession, null);
  }
});

test('helper failures return a fixed error instead of stdout, stderr or exception text', async () => {
  for (const exec of [async () => { throw new Error('SECRET-RAW'); }, async () => 'SECRET-RAW', async () => JSON.stringify({ ok: false, code: 'SECRET-RAW', message: 'SECRET-RAW' })]) {
    const k = kind({ exec });
    await assert.rejects(k.agent.execute(request), e => e.code === 'CREDENTIAL_REQUEST_FAILED' && !JSON.stringify(e).includes('SECRET-RAW') && !e.message.includes('SECRET-RAW'));
  }
});

test('shared window budget spans Users and credential prompts', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-shared-windows-'));
  const runtime = createPrivateRuntime({ dataRoot });
  const users = createUsersKind({ dataRoot, privateRuntime: runtime, platform: 'win32', wait: async () => {}, lookup: async () => [{ address: '93.184.216.34' }],
    exec: async () => JSON.stringify({ ok: true, hosts: [] }), start: (file, args) => { fs.writeFileSync(args[args.indexOf('-PromptStatusPath') + 1], 'visible'); return privateChild(); } });
  await users.execute({ op: 'prompt', host });
  const k = kind({ dataRoot, privateRuntime: runtime });
  await assert.rejects(k.agent.execute({ ...base, op: 'prompt' }), e => e.code === 'CREDENTIAL_WINDOW_BUSY');
});

test('unsupported platforms refuse before any helper starts', async () => {
  const k = kind({ platform: 'linux' });
  await assert.rejects(k.agent.execute({ ...base, op: 'status' }), e => e.code === 'CREDENTIAL_PLATFORM_UNAVAILABLE');
  assert.equal(k.calls.length, 0);
});

test('secret redaction covers JSON, HTML and both base64 encodings', () => {
  const redactor = createSecretRedactor(), secret = 'Aa"<&\'Z';
  redactor.add(secret);
  for (const value of [secret, JSON.stringify(secret).slice(1, -1), b64(secret), Buffer.from(secret, 'utf16le').toString('base64'), 'Aa&quot;&lt;&amp;&#39;Z']) assert.equal(redactor.text(value), '[redacted]');
});

test('secret tracking is bounded and fails closed instead of dropping old secrets', () => {
  const redactor = createSecretRedactor();
  for (let i = 0; i < 4096; i++) redactor.add('secret-' + i);
  assert.throws(() => redactor.add('one-more'), e => e.code === 'CREDENTIAL_SECRET_LIMIT');
  assert.equal(redactor.text('secret-0'), '[redacted]');
  redactor.clear();
  assert.throws(() => redactor.add('x'.repeat(65537)), e => e.code === 'CREDENTIAL_SECRET_LIMIT');
});

test('cookie metadata is not treated as a secret, while cookie values are', async () => {
  const k = kind();
  k.answers.push(page({ privateSession: { cookies: [{ name: 'SID', value: 'private-cookie', path: '/', domain: host }] }, body: b64('/ServiceCenter/SID private-cookie') }));
  const value = await k.agent.execute(request);
  assert.equal(Buffer.from(value.body, 'base64').toString(), '/ServiceCenter/SID [redacted]');
});

test('a helper redaction has an explicit fixed note', async () => {
  const k = kind();
  k.answers.push(page({ redacted: true, notes: ['never-trust-private-helper-text'] }));
  assert.deepEqual((await k.agent.execute(request)).notes, ['Sensitive authentication values were removed from the response.']);
});

test('binary responses containing a secret in UTF-16 are refused', async () => {
  const k = kind();
  k.answers.push(page({ contentType: 'application/octet-stream', body: Buffer.from('private-binary-secret', 'utf16le').toString('base64'), secretValues: ['private-binary-secret'] }));
  await assert.rejects(k.agent.execute(request), e => e.code === 'CREDENTIAL_REQUEST_FAILED');
});

test('a completed profile window invalidates old session state', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-profile-change-'));
  const k = kind({ dataRoot, start: (file, args) => { return completedPrivateChild(); } });
  k.answers.push({ ok: true, authenticated: true, privateSession: { token: 'old-profile-token' } });
  await k.agent.execute({ ...base, op: 'login' });
  await k.agent.execute({ ...base, op: 'prompt', mode: 'select-profile' });
  await k.agent.execute(request);
  assert.equal(k.calls.at(-1).input.privateSession, null);
});

test('agent result, outbox and log bytes exclude simulated private input and session secrets', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-wire-scan-'));
  const secret = 'sentinel-private-password-N4', cookie = 'sentinel-cookie-T3', token = 'sentinel-token-Q6';
  const logs = [];
  const agent = createAgent({ root: dataRoot, config: { credential: 'test-account-identity', server: 'http://127.0.0.1:9' }, log: (...items) => logs.push(items),
    deps: { machine: null, locate: async () => null, processes: async () => [], platform: 'win32', fetch: async () => { throw new Error('no external network in this test'); },
      credentials: { lookup: async () => [{ address: '93.184.216.34' }], exec: async () => JSON.stringify(page({ privateSession: { token, cookies: { SID: cookie } }, secretValues: [secret, cookie, token],
        body: b64([secret, token, cookie].join(' ')) })) } } });
  const response = await agent.execute(CREDENTIAL_KIND, request);
  assert.equal(response.ok, true);
  agent.outbox.finish(response.id, response);
  const wire = agent.outbox.take();
  const bytes = JSON.stringify({ response, wire, logs }) + Buffer.from(response.value.body, 'base64').toString();
  for (const value of [secret, cookie, token, b64(secret), b64(cookie), b64(token)]) assert.ok(!bytes.includes(value));
  assert.ok(!fs.existsSync(path.join(dataRoot, 'private', 'credential', 'session.json')), 'no session file exists');
});

test('two uncertain sign-ins stop across restart, and a saved private prompt resets the brake', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-login-brake-'));
  const k = kind({ dataRoot, exec: async () => { throw new Error('private transport failed'); } });
  for (let i = 0; i < 2; i++) await assert.rejects(k.agent.execute({ ...base, op: 'login' }), e => e.code === 'CREDENTIAL_REQUEST_FAILED');
  const other = kind({ dataRoot, start: (file, args) => { return completedPrivateChild(); } });
  await assert.rejects(other.agent.execute({ ...base, op: 'login' }), e => e.code === 'CREDENTIAL_LOGIN_PAUSED');
  assert.equal(other.calls.length, 0);
  await other.agent.execute({ ...base, op: 'prompt' });
  other.answers.push({ ok: true, authenticated: true });
  assert.deepEqual(await other.agent.execute({ ...base, op: 'login' }), { authenticated: true });
  const counters = fs.readFileSync(path.join(dataRoot, 'private', 'credential', 'sign-in-failures.json'), 'utf8');
  assert.equal(counters, '{}');
});

test('an expired session is discarded before the next request, with no automatic replay', async () => {
  const k = kind();
  k.answers.push({ ok: true, authenticated: true, privateSession: { token: 'expired-session-token' } });
  await k.agent.execute({ ...base, op: 'login' });
  k.answers.push(page({ status: 401 }));
  assert.equal((await k.agent.execute(request)).status, 401);
  assert.equal(k.calls.length, 2);
  k.answers.push({ ok: true, available: true, authenticated: false });
  assert.equal((await k.agent.execute({ ...base, op: 'status' })).authenticated, false);
  assert.equal(k.calls.at(-1).input.privateSession, null);
});

test('monitoring authentication permits only the exact bounded timer-events GET', () => {
  const url = new URL('https://' + host + '/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/');
  url.search = new URLSearchParams({ EventNames: 'TimerExecuted', StartInstant: '2026-11-02T00:00:00.000Z', EndInstant: '2026-11-02T00:30:00.000Z', NumberOfResults: '10' }).toString();
  for (const auth of ['basic', 'service-token']) {
    const r = { ...request, auth, url: url.href };
    validateCredentialRequest(r);
    for (const change of [{ method: 'POST' }, { url: request.url }, { url: r.url + '&NumberOfResults=20' }, { url: r.url.replace('TimerExecuted', 'OtherEvent') },
      { url: r.url.replace('NumberOfResults=10', 'NumberOfResults=101') }, { url: r.url.replace('00%3A30', '02%3A30') }]) assert.throws(() => validateCredentialRequest({ ...r, ...change }));
  }
});

test('legacy text encoding is preserved byte for byte without a redaction', async () => {
  const k = kind(), body = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  k.answers.push(page({ contentType: 'text/html; charset=windows-1252', body: body.toString('base64') }));
  const result = await k.agent.execute(request);
  assert.equal(result.body, body.toString('base64'));
  assert.equal(result.contentType, 'text/html; charset=windows-1252');
  assert.equal(result.notes, undefined);
});

test('redacting legacy text explicitly converts it to UTF-8 with an English note', async () => {
  const k = kind(), body = Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0xe9]), Buffer.from(' private-marker')]);
  k.answers.push(page({ contentType: 'text/html; charset=windows-1252', body: body.toString('base64'), secretValues: ['private-marker'] }));
  const result = await k.agent.execute(request);
  assert.equal(Buffer.from(result.body, 'base64').toString(), 'café [redacted]');
  assert.equal(result.contentType, 'text/html; charset=utf-8');
  assert.ok(result.notes.includes('Response text was converted from windows-1252 to UTF-8 to remove sensitive authentication values.'));
});

test('the shared login brake fails closed on corrupt or unreadable state, for both private families', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-brake-integrity-')), file = path.join(dir, 'attempts.json');
  for (const unavailableCode of ['CREDENTIAL_LOGIN_PAUSED', 'USERS_LOGIN_PAUSED']) {
    const brake = createLoginBrake({ file, scope: 'test', unavailableCode });
    for (const bad of ['{', 'null', '[]', '{"test|host":-1}', '{"test|host":"0"}']) {
      fs.writeFileSync(file, bad);
      assert.throws(() => brake.count('host'), e => e.code === unavailableCode);
      assert.throws(() => brake.set('host', 0), e => e.code === unavailableCode);
      assert.equal(fs.readFileSync(file, 'utf8'), bad, 'corrupt data is never silently replaced with an empty brake');
    }
    const unreadable = createLoginBrake({ file: dir, scope: 'test', unavailableCode });
    assert.throws(() => unreadable.count('host'), e => e.code === unavailableCode);
  }
  const empty = createLoginBrake({ file: path.join(dir, 'not-created.json'), scope: 'test' });
  assert.equal(empty.count('host'), 0, 'a genuinely absent initial file is allowed');
});

for (const secret of ['a','1']) test('short cookie '+secret+' preserves public URL and MIME while redacting JSON strings', async()=>{
 const k=kind();k.answers.push(page({contentType:'application/json; charset=utf-8',url:'https://hostile.invalid/private',body:b64(JSON.stringify({x:secret})),privateSession:{cookies:[{name:'fixture',value:secret,path:'/'}]}}));
 const result=await k.agent.execute(request);
 assert.equal(result.url,request.url);assert.doesNotThrow(()=>new URL(result.url));assert.equal(result.contentType,'application/json; charset=utf-8');
 assert.equal(JSON.parse(Buffer.from(result.body,'base64').toString()).x,'[redacted]');assert.ok(result.notes.length);
});
test('short token that would corrupt JSON number grammar refuses with a fixed structure error',async()=>{
 const k=kind();k.answers.push(page({contentType:'application/json',body:b64('{"value":1}'),secretValues:['1']}));
 await assert.rejects(k.agent.execute(request),e=>e.code==='CREDENTIAL_RESPONSE_STRUCTURE_REDACTED'&&e.executed===false);
});
test('response MIME cannot carry arbitrary private parameters',async()=>{
 const k=kind();k.answers.push(page({contentType:'application/json; secret=private-value',body:b64('{}')}));
 await assert.rejects(k.agent.execute(request),e=>e.code==='CREDENTIAL_RESPONSE_METADATA_INVALID'&&!e.message.includes('private-value'));
});
test('response redirect redaction preserves URL grammar and refuses an unapproved origin',async()=>{
 const k=kind();k.answers.push(page({location:'https://'+host+'/ServiceCenter/?x=private-value',secretValues:['private-value']}));
 const response=await k.agent.execute(request);assert.equal(new URL(response.location).searchParams.get('x'),'[redacted]');assert.ok(response.notes.length);
 k.answers.push(page({location:'https://other.invalid/?x=private-value'}));assert.equal((await k.agent.execute(request)).location,'');
});

test('original invalid JSON is distinct from redaction-caused invalidity, including sent POSTs',async()=>{
 for (const [type,body,code] of [['application/json','not-json','CREDENTIAL_RESPONSE_INVALID'],['application/json','{"x":1}','CREDENTIAL_RESPONSE_STRUCTURE_REDACTED'],['application/json; secret=hidden','{}','CREDENTIAL_RESPONSE_METADATA_INVALID']]){
  const k=kind();k.answers.push(page({contentType:type,body:b64(body),secretValues:['1']}));
  await assert.rejects(k.agent.execute({...request,method:'POST'}),e=>e.code===code&&e.executed===null);
 }
});
test('recognized MIME is canonical with an explicit normalization note',async()=>{
 const k=kind();k.answers.push(page({contentType:'Application/JSON; Charset="UTF-8"',body:b64('{}')}));
 const result=await k.agent.execute(request);assert.equal(result.contentType,'application/json; charset=utf-8');
 assert.deepEqual(result.notes,['Response content type was normalized to a recognized media type and charset.']);
});

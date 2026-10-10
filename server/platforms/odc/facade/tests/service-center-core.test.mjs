// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
// Port of kernel/tests/test_service_center.py (33 cases): synthetic protocol fixtures; no customer HTML, credentials
// or live mutations. The direct HTTPS path runs on an in-memory `send`; the vault login on a fake vault that posts the
// way vault.mjs's PowerShell does (the real PowerShell path is service-center-vault.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Document, Page, button, formFields } from '../service-center/html.mjs';
import { Transport } from '../service-center/http.mjs';
import { Client, Journal, tables } from '../service-center/client.mjs';
import { createVault } from '../service-center/vault.mjs';
import { main } from '../service-center/index.mjs';
import { BridgeError, ProtocolError } from '../service-center/errors.mjs';
import { quote } from '../service-center/urls.mjs';
import { temp, files, uuid } from './fixtures/sc-fake-bridge.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1';
const HOST = 'test.example.com';
const BASE = `https://${HOST}/ServiceCenter/`;
const LOGIN = `<form method="post" action="Login.aspx"><input type="hidden" name="__OSVSTATE" value="state">
<input name="user"><input type="password" name="pass"><input type="submit" name="login" value="Log in"></form>`;

const page = (html, at = 'Home.aspx') => new Page(BASE + at, new Document(html));
const detail = (action = 'Run Now', value = 'old') => page(`<form method="post" action="Timer_Edit.aspx?id=7"><input type="hidden" name="state" value="opaque">
<label for="v">Value</label><textarea id="v" name="Input_Value">${value}</textarea>
<input type="submit" name="operation" value="${action}"></form>`, 'Timer_Edit.aspx?id=7');
const response = (status, body = '', { contentType = 'text/html; charset=utf-8', location = '' } = {}) => ({ status, location, contentType, setCookie: [], body: Buffer.from(body) });
const formOf = body => Object.fromEntries(new URLSearchParams(body));

// An in-memory HTTP exchange, as nodeSend() returns it; answers come in order.
function fakeSend(answers) {
  const calls = [];
  const send = async request => { calls.push(request); const next = answers.shift(); if (next instanceof Error) throw next; return typeof next === 'function' ? next(request) : next; };
  send.calls = calls;
  return send;
}
// The vault of the login tests: it adds the user and password to the body exactly as vault.mjs's PowerShell does,
// and posts through the same fake HTTP. reads counts credential reads.
function loginVault(send) {
  const vault = { host: HOST, target: `SSAM/O11/${HOST}/ServiceCenter`, reads: 0, present: async () => true,
    secretTarget: (k, n) => createVault(HOST, null, { present: async () => true }).secretTarget(k, n),
    login: async form => {
      vault.reads++;
      const body = (form.body ? form.body + '&' : '') + `${quote(form.userField, '', true)}=test-user&${quote(form.passwordField, '', true)}=private-test-password`;
      return send({ method: 'POST', url: form.url, headers: { Cookie: form.cookie }, body, timeoutMs: form.timeoutMs, limit: form.limit });
    } };
  return vault;
}
const fakeVault = () => ({ host: HOST, reads: 0, present: async () => true, secretTarget: (k, n) => `SSAM/O11/${HOST}/${k}/${n}` });

class FakeTransport extends Transport {
  constructor(pages) { super(HOST); this.pages = [...pages]; this.requests = []; this.refs = []; this.secrets = false; }
  async secretsSupported() { return this.secrets; }
  async request(url, fields = null, secretRefs = null) {
    this.requests.push([this.url(url), Object.fromEntries(fields ?? [])]);
    this.refs.push(secretRefs);
    const next = this.pages.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

class Operations extends Client {
  constructor(action = 'Run Now', reply = null, after = null) {
    const transport = new FakeTransport([reply ?? page('<div class="Feedback_Message_Success">Scheduled</div>')]);
    super(fakeVault(), transport);
    this.transport = transport; this.before = detail(action); this.after = after; this.reads = 0;
  }
  async detail() { this.reads++; return this.reads > 1 && this.after ? this.after : this.before; }
}
const isProtocol = pattern => error => error instanceof ProtocolError && (!pattern || pattern.test(error.message));

test('same origin and path before any request', () => {
  const t = new Transport(HOST);
  for (const url of ['https://evil.test/ServiceCenter/Login.aspx', 'http://' + HOST + '/ServiceCenter/', '../Users/Login.aspx', '/ServiceCenter/%2e%2e/Users/',
    'https://user@' + HOST + '/ServiceCenter/', BASE + '../Users/Login.aspx', 'https://' + HOST + ':443/ServiceCenter/', '//evil.test/ServiceCenter/'])
    assert.throws(() => t.url(url), isProtocol(), url);
  assert.equal(t.url('Error_Logs.aspx?x=1'), BASE + 'Error_Logs.aspx?x=1');
});

test('vault does not fall back to another host', () => {
  for (const target of ['SSAM/O11/evil.test/ServiceCenter', 'SSAM/ODC/test/Portal', 'any']) assert.throws(() => createVault(HOST, target), isProtocol());
  assert.equal(createVault(HOST, null, { present: async () => false }).target, `SSAM/O11/${HOST}/ServiceCenter`);
});

test('login uses hidden state and only one attempt', async () => {
  // A successful login redirects (POST Login.aspx -> 302 -> GET); the redirect carries no credential.
  const send = fakeSend([response(200, LOGIN), response(302, '', { location: 'Home.aspx' }), response(200, '<a href="Logout.aspx">Log out</a>')]);
  const vault = loginVault(send);
  const client = new Client(vault, new Transport(HOST, { send }));
  await client.login(); await client.login();
  assert.equal(vault.reads, 1);
  assert.equal(send.calls.length, 3);
  assert.deepEqual([send.calls[2].method, send.calls[2].body], ['GET', null]);
  assert.deepEqual(formOf(send.calls[1].body), { __OSVSTATE: 'state', user: 'test-user', pass: 'private-test-password', login: 'Log in' });
});

test('bad login fails without server feedback or secret', async () => {
  const send = fakeSend([response(200, LOGIN), response(200, LOGIN + '<span class="ValidationMessage">private-test-password</span>')]);
  await assert.rejects(new Client(loginVault(send), new Transport(HOST, { send })).login(), e => isProtocol()(e) && !e.message.includes('private-test-password'));
  assert.equal(send.calls.length, 2);
});

test('logout marker is required', async () => {
  const send = fakeSend([response(200, LOGIN), response(302, '', { location: 'Home.aspx' }), response(200, '<p>Unexpected identity provider</p>')]);
  await assert.rejects(new Client(loginVault(send), new Transport(HOST, { send })).login(), isProtocol(/confirm/));
});

// Port of 7e7a6d41 (live on 11.42): after the session expired every page answered HTTP 200 at the asked URL with the
// login form; such a page is never read as data.
test('an expired session answering the login form in place is never read', async () => {
  const send = fakeSend([response(200, LOGIN), response(302, '', { location: 'Home.aspx' }), response(200, '<a href="Logout.aspx">Log out</a>'), response(200, LOGIN)]);
  await assert.rejects(new Client(loginVault(send), new Transport(HOST, { send })).get('Error_Logs.aspx'), isProtocol(/session expired/));
});

test('form preserves unicode and whitespace but not other buttons', () => {
  const d = detail('Save', '  a\n b &amp; ç  ');
  const fields = Object.fromEntries(formFields(d.doc.first('form'), button(d, ['Save'])));
  assert.equal(fields.Input_Value, '  a\n b & ç  ');
  assert.equal(fields.state, 'opaque');
  assert.equal(fields.operation, 'Save');
});

test('unknown scripted form fails before post', async () => {
  const d = page('<form method="post"><input type="submit" name="go" value="Save" onclick="OsAjax(event)"></form>');
  const t = new FakeTransport([]);
  await assert.rejects(t.submit(d, button(d, ['Save'])), isProtocol(/scripted/));
  assert.deepEqual(t.requests, []);
});

test('external form action is refused', async () => {
  const d = page('<form method="post" action="https://evil.test/"><input type="submit" name="go" value="Save"></form>');
  const t = new FakeTransport([]);
  await assert.rejects(t.submit(d, button(d, ['Save'])), isProtocol());
  assert.deepEqual(t.requests, []);
});

test('site property values redacted in listing', () => {
  const d = page('<table><tr><th>Name</th><th>Default Value</th><th>Effective Value</th></tr><tr><td>Token</td><td>abc-secret</td><td>def-secret</td></tr></table>');
  const encoded = JSON.stringify(tables(d, true));
  assert.ok(!encoded.includes('secret'));
  assert.ok(encoded.includes('Token'));
});

test('log rows, headers, entities and pagination', async () => {
  const first = page('<table><tr><th>Message</th></tr><tr><td>Error &amp; detail</td></tr></table><a rel="next" href="Error_Logs.aspx?p=2">Next</a>', 'Error_Logs.aspx');
  const second = page('<table><tr><th>Message</th></tr><tr><td>Second</td></tr></table>', 'Error_Logs.aspx?p=2');
  const c = new Client(fakeVault(), new FakeTransport([second])); c.authenticated = true;
  const result = await c.pages(first, 10);
  assert.deepEqual(result.rows.map(r => r.fields.Message), ['Error & detail', 'Second']);
  assert.equal(result.truncated, false);
});

test('limit reports truncation and does not fetch next', async () => {
  const d = page('<table><tr><th>M</th></tr><tr><td>1</td></tr></table><a rel="next" href="Next.aspx">Next</a>');
  const t = new FakeTransport([]); const c = new Client(fakeVault(), t);
  assert.equal((await c.pages(d, 1)).truncated, true);
  assert.deepEqual(t.requests, []);
});

test('duplicate target or incomplete listing refuses', async () => {
  const c = new Client(fakeVault(), new FakeTransport([]));
  c.resourceListing = async () => ({ truncated: false, rows: [{ links: [{ name: 'Worker', href: BASE + '1' }, { name: 'Worker', href: BASE + '2' }] }] });
  await assert.rejects(c.detail(2, 'timers', 'Worker'), isProtocol(/exact name/));
});

test('unsupported filter fails without search post', async () => {
  const d = page('<form method="post"><input name="unrecognized"><input type="submit" name="f" value="Filter"></form>');
  const c = new Client(fakeVault(), new FakeTransport([])); c.get = async () => d;
  await assert.rejects(c.logs('error', 100, { module: 'Orders' }), isProtocol(/unambiguous/));
  assert.deepEqual(c.http.requests, []);
});

test('error filters are resolved and submitted', async () => {
  const d = page('<form method="post"><select name="wtEspace_Selector"><option value="0">All</option><option value="42">Orders</option></select><input name="wtInput1"><input type="submit" name="f" value="Filter"></form>', 'Error_Logs.aspx');
  const t = new FakeTransport([page('<table><tr><th>Message</th></tr></table>')]); const c = new Client(fakeVault(), t);
  c.get = async () => d;
  await c.logs('error', 100, { module: 'Orders', message: 'failed' });
  assert.equal(t.requests[0][1].wtEspace_Selector, '42');
  assert.equal(t.requests[0][1].wtInput1, 'failed');
});

test('plan does not write or read a property secret', async () => {
  const c = new Operations('Save');
  const plan = await c.mutate('property-set', '3', 'Token');
  assert.equal(plan.execute, false);
  assert.ok(!JSON.stringify(plan).includes('old'));
  assert.deepEqual(c.http.requests, []);
});

test('execution requires authorization before network', async () => {
  const c = new Operations();
  await assert.rejects(c.mutate('timer-run', '3', 'Worker', { execute: true }), isProtocol());
  assert.equal(c.reads, 0);
});

test('successful timer only means scheduled and receipt does not replay', async () => {
  const j = new Journal(temp()); const op = uuid(); const c = new Operations();
  const result = await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: op, journal: j });
  assert.equal(result.state, 'accepted');
  assert.equal(result.executionCompleted, false);
  const again = await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: op, journal: j });
  assert.equal(again.existingReceipt, true); assert.equal(again.replayed, false);
  assert.equal(c.http.requests.length, 1);
});

test('lost reply is uncertain and blocks a new id', async () => {
  const j = new Journal(temp()); const c = new Operations('Run Now', new ProtocolError('lost'));
  const result = await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: uuid(), journal: j });
  assert.equal(result.state, 'uncertain');
  await assert.rejects(c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: uuid(), journal: j }), isProtocol(/pending\/uncertain/));
  assert.equal(c.http.requests.length, 1);
});

test('receipt is durable before send', async () => {
  const j = new Journal(temp()); const c = new Operations(); const op = uuid();
  const original = c.http.request.bind(c.http);
  let seen = null;
  c.http.request = async (...args) => { seen = JSON.parse(fs.readFileSync(j.path(op), 'utf8')).state; return original(...args); };
  await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: op, journal: j });
  assert.equal(seen, 'sending');
});

test('deactivate confirmed by new control', async () => {
  const c = new Operations('Deactivate', null, detail('Activate'));
  const result = await c.mutate('timer-deactivate', '3', 'Worker', { execute: true, words: 'deactivate Worker', operationId: uuid(), journal: new Journal(temp()) });
  assert.equal(result.state, 'confirmed');
});

test('property confirmed by readback and no values in receipt', async () => {
  const dir = temp();
  const c = new Operations('Save', null, detail('Save', 'new-secret-value'));
  const result = await c.mutate('property-set', '3', 'Token', { value: 'new-secret-value', execute: true, words: 'change Token', operationId: uuid(), journal: new Journal(dir) });
  assert.equal(result.state, 'confirmed');
  const evidence = files(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  for (const secret of ['new-secret-value', 'change Token', 'opaque']) assert.ok(!evidence.includes(secret), secret);
});

test('HTTP 200 error is not success', async () => {
  const c = new Operations('Run Now', page('<div class="Feedback_Message_Error">No permission</div>'));
  const result = await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: uuid(), journal: new Journal(temp()) });
  assert.equal(result.ok, false); assert.equal(result.state, 'uncertain');
});

test('receipt id cannot change target', async () => {
  const j = new Journal(temp()); const op = uuid(); const c = new Operations();
  await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: op, journal: j });
  await assert.rejects(c.mutate('timer-run', '4', 'Worker', { execute: true, words: 'run Worker', operationId: op, journal: j }), isProtocol(/different target/));
});

test('cli refuses a secret for a timer', async () => {
  await assert.rejects(main(['timer-run', '--host', HOST, '--module-id', '2', '--name', 'Worker', '--value-vault', 'some-target'],
    { journal: new Journal(temp()), locate: () => assert.fail('no Studio is located'), present: () => assert.fail('no vault'), running: async () => false }), isProtocol());
});

test('receipt path traversal refused', () => {
  assert.throws(() => new Journal(temp()).lookup('../outside'), isProtocol());
});

test('OutSystems ID redirect is classified without vault read', async () => {
  const send = fakeSend([response(302, '', { location: 'https://id.outsystems.com/community/login?private=opaque' })]);
  const vault = loginVault(send);
  await assert.rejects(new Client(vault, new Transport(HOST, { send })).login(), e => isProtocol(/OutSystems ID SSO/)(e) && !e.message.includes('opaque'));
  assert.equal(vault.reads, 0);
});

test('POST 307 never replays even on the same host', async () => {
  const send = fakeSend([response(307, '', { location: 'Write2.aspx' }), response(200, '<p/>')]);
  await assert.rejects(new Transport(HOST, { send }).request('Write.aspx', [['v', 'secret']]), isProtocol(/replay/));
  assert.equal(send.calls.length, 1);
});

test('unknown page cannot be reported as empty logs', async () => {
  await assert.rejects(new Client(fakeVault(), new FakeTransport([])).pages(page('<p>Access denied</p>')), isProtocol(/schema/));
});

test('verify can release an uncertain deactivation without post', async () => {
  const dir = temp(); const j = new Journal(dir); const c = new Operations('Deactivate', new ProtocolError('lost'));
  const r = await c.mutate('timer-deactivate', '3', 'Worker', { execute: true, words: 'deactivate Worker', operationId: uuid(), journal: j });
  c.before = detail('Activate');
  const result = await c.verify(r, j);
  assert.equal(result.observedDesiredState, true);
  assert.deepEqual(files(dir, /\.lock$/), []);
  assert.equal(c.http.requests.length, 1);
});

// P6: verify of a Run Now reads the timer; right after the attempt an unchanged Last Run proves nothing yet, so the receipt
// stays uncertain and keeps the lock (the resolutions are in service-center-receipt-resolution.test.mjs).
test('verify of a fresh Run Now with Last Run unchanged keeps it uncertain and the lock held', async () => {
  const dir = temp(); const j = new Journal(dir); const c = new Operations('Run Now', new ProtocolError('lost'));
  const r = await c.mutate('timer-run', '3', 'Worker', { execute: true, words: 'run Worker', operationId: uuid(), journal: j });
  c.resourceListing = async () => ({ truncated: false, rows: [{ links: [{ name: 'Worker', href: BASE + 'Timer_Edit.aspx?id=7' }] }] });
  const result = await c.verify(r, j);
  assert.equal(result.state, 'uncertain');
  assert.ok(result.recheckAfter);
  assert.ok(files(dir, /\.lock$/).length);
  assert.equal(c.http.requests.length, 1, 'verify sends nothing');
});

test('boolean property unchecks without sending the field', async () => {
  const checkbox = checked => page('<form method="post"><label for="v">Value</label><input id="v" name="v" type="checkbox" value="True" ' + (checked ? 'checked' : '') + '><input type="submit" name="save" value="Save"></form>');
  const c = new Operations('Save', null, checkbox(false)); c.before = checkbox(true);
  const r = await c.mutate('property-set', '3', 'Enabled', { value: 'false', execute: true, words: 'disable Enabled', operationId: uuid(), journal: new Journal(temp()) });
  assert.equal(r.state, 'confirmed');
  assert.ok(!Object.hasOwn(c.http.requests[0][1], 'v'));
});

test('secret property goes as a vault reference and is never claimed readback-verified', async () => {
  const target = `SSAM/O11/${HOST}/SiteProperty/Token`;
  const masked = page('<form method="post"><label for="v">Value</label><input id="v" name="v" type="password"><input type="submit" name="save" value="Save"></form>');
  const dir = temp();
  // A secret field never takes a value from a file: the value would pass through this process.
  let c = new Operations('Run Now', null, masked); c.before = masked;
  await assert.rejects(c.mutate('property-set', '3', 'Token', { value: 'new-secret', execute: true, words: 'update Token', operationId: uuid(), journal: new Journal(dir) }), isProtocol(/value-vault/));
  // Without a transport that fills secretRefs (the Studio window), nothing is reserved or sent.
  await assert.rejects(c.mutate('property-set', '3', 'Token', { secret: target, execute: true, words: 'update Token', operationId: uuid(), journal: new Journal(dir) }),
    e => e instanceof BridgeError && e.code === 'STUDIO_REQUIRED');
  assert.deepEqual([c.http.requests, files(dir)], [[], []]);
  c = new Operations('Run Now', page('<div class="Feedback_Message_Success">Site property saved</div>'), masked);
  c.before = masked; c.http.secrets = true;
  const r = await c.mutate('property-set', '3', 'Token', { secret: target, execute: true, words: 'update Token', operationId: uuid(), journal: new Journal(dir) });
  assert.equal(r.state, 'accepted');
  assert.equal(r.valueVerified, false);
  assert.deepEqual([c.http.requests[0][1], c.http.refs[0]], [{ save: 'Save', v: '' }, [{ pointer: '/v', target, field: 'password' }]]);
});

test('error detail preserves stack lines and omits hidden form state', async () => {
  const c = new Client(fakeVault(), new FakeTransport([]));
  c.get = async () => page('<main><input type="hidden" value="private-state"><pre>Exception\n  at ActionOne\n  at ActionTwo</pre><script>private-script</script></main>');
  const r = await c.errorDetail('error-123');
  assert.ok(r.detail.includes('\n  at ActionOne\n  at ActionTwo'));
  assert.ok(!r.detail.includes('private-'));
});

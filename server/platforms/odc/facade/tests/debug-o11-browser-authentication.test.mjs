import test from 'node:test';
import assert from 'node:assert/strict';
import { createO11BrowserSession, createO11BrowserAuthentication } from '../debug-o11-browser-authentication.mjs';

const M = 'Fixture_UI', runtimeUrl = 'https://fixture-o11.example.com/' + M + '/', versionToken = 'JiJG+RhMVA8EWH4jngemOA';
const login = { modelFactory: M + '.Common.Login.mvc$model', controllerFactory: M + '.Common.Login.mvc$controller', method: 'doLogin$ServerAction',
  viewName: 'Common.Login', apiVersion: 'abcdefghijklmnopqrstuv', endpoint: '/' + M + '/screenservices/' + M + '/Common/Login/ServiceAPIDoLogin' };
const binding = { lane: 'o11', runtimeUrl, app: M, sessionId: 'a'.repeat(32), module: M, moduleKey: 'Mif02PxcH0K7KiABEHTwMg' };
const descriptor = { credentialRef: '11111111-2222-4333-8444-555555555555', binding, expiresAt: new Date(Date.now() + 60000).toISOString() };
const secret = { username: 'fixture.user', password: 'fixture-password-value' };

function fixture({ loginReply = 'accepted', journal = true, loginCookie = true, versionCookie = false } = {}) {
  const journals = [], sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, method: options.method, headers: { ...options.headers }, body: options.body });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const path = new URL(url).pathname;
    if (path === login.endpoint) {
      if (loginReply === 'lost') throw new Error('socket hang up');
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', 'nr1Users=session-secret; Path=/; Secure; HttpOnly');
      if (loginCookie) headers.append('Set-Cookie', 'nr2Users=crf%3dtoken%3buid%3d7; Path=/; Secure');
      return new Response(JSON.stringify(loginReply === 'rejected' ? { exception: { name: 'InvalidLoginException' } } : { data: {} }), { status: 200, headers });
    }
    if (path.endsWith('/moduleservices/roles')) return new Response('"roles"', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path.endsWith('/moduleservices/moduleversioninfo')) return new Response(JSON.stringify({ versionToken }), { status: 200,
      headers: versionCookie ? { 'Set-Cookie': 'nr2Users=crf%3dtoken%3buid%3d7; Path=/; Secure' } : {} });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const vault = async (mode, input) => { assert.equal(mode, 'read'); assert.equal(input.credentialRef, descriptor.credentialRef);
    return { ok: true, kind: 'credentials', binding: input.binding, expiresAt: input.expiresAt, ...secret }; };
  const session = createO11BrowserSession({ runtimeUrl, module: M, versionToken, userProvider: 'Users', login, binding, fetchImpl, vault,
    validateDescriptor: d => ({ credentialRef: d.credentialRef, binding: d.binding, expiresAt: d.expiresAt }),
    beforeSignIn: async metadata => { journals.push(['submission', metadata]); return { recorded: journal }; },
    recordSignInResult: async metadata => { journals.push(['result', metadata]); return { recorded: true }; } });
  return { session, journals, sent };
}
const xhr = (url, init = {}) => ({ url, method: 'GET', headers: {}, ...init });
const loginBody = placeholders => JSON.stringify({ versionInfo: { moduleVersion: versionToken, apiVersion: login.apiVersion }, viewName: login.viewName,
  inputParameters: { Username: placeholders.username, Password: placeholders.password, RememberLogin: false } });

test('the guarded transport forwards only version checks before sign-in and refuses foreign, non-XHR and app requests', async () => {
  const f = fixture();
  assert.equal(await f.session.request(xhr('https://other.example.com/' + M + '/moduleservices/moduleversioninfo?1760000000000'), 'XHR'), undefined);
  assert.equal(await f.session.request(xhr(runtimeUrl + 'moduleservices/moduleversioninfo?1760000000000'), 'Script'), undefined);
  assert.equal(await f.session.request(xhr(runtimeUrl + 'moduleservices/roles?1760000000000'), 'XHR'), undefined);
  assert.equal(await f.session.request(xhr(runtimeUrl + 'screenservices/' + M + '/ActionX', { method: 'POST', postData: '{}' }), 'XHR'), undefined);
  assert.equal(await f.session.request(xhr(login.endpoint.replace('/' + M + '/', runtimeUrl), { method: 'POST', postData: loginBody({ username: 'u', password: 'p' }) }), 'XHR'), undefined);
  const version = await f.session.request(xhr(runtimeUrl + 'moduleservices/moduleversioninfo?1760000000000', { headers: { Cookie: 'page=1', 'X-Evil': '1' } }), 'XHR');
  assert.equal(version.status, 200); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.Cookie, undefined); assert.equal(f.sent[0].headers['X-Evil'], undefined);
  assert.equal(f.session.receipt().requests.refused, 5);
});

test('sign-in substitutes private credentials for page placeholders once, journals it and keeps HttpOnly cookies host-side', async () => {
  const f = fixture(), placeholders = await f.session.arm(descriptor);
  assert.match(placeholders.username, /^[a-f0-9]{48}$/); assert.notEqual(placeholders.username, secret.username);
  await assert.rejects(f.session.arm(descriptor), /already_armed/);
  const url = new URL(login.endpoint, runtimeUrl).href;
  // A body that does not carry the exact placeholders is refused before any journal.
  assert.equal(await f.session.request(xhr(url, { method: 'POST', postData: loginBody(secret) }), 'XHR'), undefined);
  assert.equal(f.journals.length, 0);
  const reply = await f.session.request(xhr(url, { method: 'POST', postData: loginBody(placeholders), headers: { 'X-CSRFToken': 'anon', 'Content-Type': 'application/json' } }), 'XHR');
  assert.equal(reply.status, 200);
  const forwarded = JSON.parse(f.sent[0].body);
  assert.equal(forwarded.inputParameters.Username, secret.username); assert.equal(forwarded.inputParameters.Password, secret.password);
  assert.equal(f.sent[0].headers['X-CSRFToken'], 'anon');
  const cookies = reply.headers.filter(h => h.name === 'Set-Cookie').map(h => h.value);
  assert.equal(cookies.length, 1); assert.match(cookies[0], /^nr2Users=/);
  assert.deepEqual(f.journals.map(j => j[0]), ['submission', 'result']); assert.equal(f.journals[1][1].accepted, true);
  assert.doesNotMatch(JSON.stringify([f.journals, f.session.receipt()]), /fixture\.user|fixture-password-value|session-secret/);
  assert.equal(await f.session.request(xhr(url, { method: 'POST', postData: loginBody(placeholders) }), 'XHR'), undefined);
  f.session.disarm();
  // App requests now carry the host jar, never the page cookie header.
  const roles = await f.session.request(xhr(runtimeUrl + 'moduleservices/roles?1760000000001', { headers: { Cookie: 'nr1Users=forged' } }), 'XHR');
  assert.equal(roles.status, 200); assert.match(f.sent[1].headers.Cookie, /nr1Users=session-secret/); assert.doesNotMatch(f.sent[1].headers.Cookie, /forged/);
  const post = await f.session.request(xhr(runtimeUrl + 'screenservices/' + M + '/MainFlow/Home/DataActionGetX', { method: 'POST',
    postData: JSON.stringify({ versionInfo: { moduleVersion: versionToken, apiVersion: 'x' }, viewName: 'MainFlow.Home', screenData: { variables: {} } }) }), 'XHR');
  assert.equal(post.status, 200);
  assert.equal(await f.session.request(xhr(runtimeUrl + 'screenservices/' + M + '/MainFlow/Home/DataActionGetX', { method: 'POST',
    postData: JSON.stringify({ versionInfo: { moduleVersion: 'stale', apiVersion: 'x' } }) }), 'XHR'), undefined);
  assert.equal(f.session.sessionCookieRetained([{ name: 'nr2Users', value: 'crf%3dtoken%3buid%3d7' }]), true);
  assert.equal(f.session.sessionCookieRetained([{ name: 'nr2Users', value: 'other' }]), false);
  assert.deepEqual(f.session.receipt().requests, { submitted: 2, answered: 2, uncertain: 0, refused: 3 }); assert.equal(f.session.receipt().userCookieIssued, true);
  assert.equal((await f.session.clear()).cleared, true); assert.equal(f.session.sessionCookieRetained([{ name: 'nr2Users', value: 'crf%3dtoken%3buid%3d7' }]), false);
  assert.equal(await f.session.request(xhr(runtimeUrl + 'moduleservices/roles?1760000000002'), 'XHR'), undefined);
});

test('an unrecorded sign-in submission is never sent; a lost sign-in reply is uncertain and ends the session', async () => {
  const unrecorded = fixture({ journal: false }), p = await unrecorded.session.arm(descriptor), url = new URL(login.endpoint, runtimeUrl).href;
  assert.equal(await unrecorded.session.request(xhr(url, { method: 'POST', postData: loginBody(p) }), 'XHR'), undefined);
  assert.equal(unrecorded.sent.length, 0); assert.equal(unrecorded.session.receipt().signIn.submitted, false);
  const lost = fixture({ loginReply: 'lost' }), q = await lost.session.arm(descriptor);
  assert.equal(await lost.session.request(xhr(url, { method: 'POST', postData: loginBody(q) }), 'XHR'), undefined);
  assert.deepEqual(lost.session.receipt().signIn, { armed: true, submitted: true, answered: false, accepted: false, uncertain: true });
  assert.equal(lost.journals[1][1].transportUnconfirmed, true);
  assert.equal(await lost.session.request(xhr(runtimeUrl + 'moduleservices/moduleversioninfo?1760000000000'), 'XHR'), undefined);
});

test('authentication runs the original login in the preparation realm, reloads a clean realm and keeps the session the sign-in issued', async () => {
  for (const outcome of ['confirmed', 'mismatch', 'rejected', 'not-issued']) {
    const f = fixture({ loginReply: outcome === 'rejected' ? 'rejected' : 'accepted', loginCookie: outcome !== 'not-issued', versionCookie: outcome === 'not-issued' }), calls = [];
    // A user cookie set by anything but the sign-in reply never counts as the vault user's session.
    if (outcome === 'not-issued') await f.session.request(xhr(runtimeUrl + 'moduleservices/moduleversioninfo?1760000000000'), 'XHR');
    const page = {
      async evaluate(fn, arg) {
        calls.push('login'); assert.equal(arg.handle, '__ssamO11Runtime_' + 'e'.repeat(48)); assert.deepEqual(arg.login, login);
        assert.doesNotMatch(JSON.stringify(arg), /fixture\.user|fixture-password-value/);
        await f.session.request(xhr(new URL(login.endpoint, runtimeUrl).href, { method: 'POST', postData: loginBody(arg.placeholders) }), 'XHR');
        return { loginAnswered: true, registered: outcome !== 'rejected', userIdentified: outcome !== 'rejected' };
      },
      async send(method, params) { calls.push(method); assert.deepEqual(params.urls, [runtimeUrl]);
        return { cookies: [{ name: 'nr2Users', value: outcome === 'mismatch' ? 'x' : 'crf%3dtoken%3buid%3d7' }] }; } };
    const auth = createO11BrowserAuthentication({ page, session: f.session, runtimeHandle: '__ssamO11Runtime_' + 'e'.repeat(48), login, runtimeUrl,
      reload: async () => { calls.push('reload'); } });
    if (outcome === 'confirmed') {
      const result = await auth.authenticate(descriptor);
      // identityMatches here: the mount page holds the session the server issued for the vault user's credentials, with a
      // non-null user id; no expected user id is known, so none is compared.
      assert.deepEqual(result, { authenticated: true, identityMatches: true, identityEvidence: { credentialsAcceptedByServer: true, sessionIssuedBySignIn: true,
        userIdentifiedInPreparation: true, sessionCookieRetained: true, expectedUserIdCompared: false },
        signInResultRecorded: true, realmReloaded: true, mounted: false, permissionCheck: false });
      assert.deepEqual(auth.receipt(), { attempted: true, confirmed: true, realmReloaded: true, sessionIssuedBySignIn: true, sessionCookieRetained: true, expectedUserIdCompared: false });
      assert.deepEqual(calls, ['login', 'reload', 'Network.getCookies']); assert.equal(auth.receipt().confirmed, true);
      await assert.rejects(auth.authenticate(descriptor), /already_attempted/);
    } else {
      await assert.rejects(auth.authenticate(descriptor), /identity_unconfirmed/);
      assert.equal(auth.receipt().confirmed, false);
      if (outcome === 'rejected') assert.deepEqual(calls, ['login']);
    }
    // Credentials leave memory whatever the outcome.
    assert.equal(f.session.receipt().credentialsHeld, false);
  }
});

import './fixtures/isolated-profile.mjs';
// Lane F of the 2026-10-05 package (docs/PACOTE-SESSOES-NOVO.md, C05 3): the hidden Service Center window of a signed-in
// Studio expired within minutes and every page read answered WEB_SIGN_IN_REQUIRED asking the user to sign in again
// (4 times in session dd2b79c0, 9 in 890a2354; "ele ja tava logado"). Now a read answered by the sign-in page re-enters
// silently once (sc_web login {reenter}) and reads again; a login is asked only when the Studio itself is logged out; an
// older bridge without reentry never turns an expiry into a credential prompt; a write is never resent. Offline: a fake
// bridge (fixtures/sc-fake-bridge.mjs) and the synthetic modern pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client, Journal } from '../service-center/client.mjs';
import { StudioWebTransport } from '../service-center/http.mjs';
import { BridgeError } from '../service-center/errors.mjs';
import { main, runServiceCenter } from '../service-center/index.mjs';
import { FakeBridge, SC, fakeVault, html, temp, uuid } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'sc.example.test';
const HIDDEN = ['sc_api:soap', 'sc_web', 'sc_web:login'];
const ESPACE = `GET ${SC}eSpace_Edit.aspx?EspaceId=102`;
// What an expired window answers: the Service Center sign-in page at the asked URL.
const LOGIN = '<html><body><form method="post" action="_Login.aspx"><input type="text" name="User"><input type="password" name="Password"></form></body></html>';

// A bridge whose sc_web answers carry reentry/keepAlive (ScWebSession.Describe), or an older one without them.
class ReentryBridge extends FakeBridge {
  constructor({ reentry = true, studioSigned = true, ...options } = {}) {
    super({ capabilities: HIDDEN, ...options });
    this.reentry = reentry; this.studioSigned = studioSigned; this.logins = [];
  }
  session(host) {
    const info = super.session(host);
    info.studio.signedIn = this.studioSigned;
    if (this.reentry) Object.assign(info.web, { reentry: 'studio-sso', keepAlive: { intervalSeconds: 120, active: info.web.signedIn } });
    return info;
  }
  web(host, action, options = {}) {
    if (action === 'login') this.logins.push({ reenter: options.reenter === true });
    return super.web(host, action, options);
  }
}

function deps(bridge, extra = {}) {
  const dir = temp();
  return { journal: new Journal(path.join(dir, 'receipts')), locate: () => bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no credential prompt while the Studio is signed in'), exports: dir, ...extra };
}

test('the SC client does not ask for a login when the Studio session is active and only the window expired', async () => {
  const bridge = new ReentryBridge({ pages: { [ESPACE]: [LOGIN, html('factory/espace-edit.html')] } });
  const result = await main(['timers', '--host', HOST, '--module-id', '102'], deps(bridge));
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map(r => r.fields.Name), ['ProcessQueue', 'NightlyCleanup']);
  // One silent re-entry (reenter: the window reloads instead of trusting the page on screen), then the same read again.
  assert.deepEqual(bridge.logins, [{ reenter: true }]);
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'web').map(c => [c[1], c[2]]), [['fetch', 'GET'], ['login', null], ['fetch', 'GET']]);
});

test('a login is asked only when the Studio itself is logged out, and then it is the Studio\'s own sign-in', async () => {
  const bridge = new ReentryBridge({ pages: { [ESPACE]: [LOGIN, html('factory/espace-edit.html')] } });
  // Signed in when the call starts, logged out by the time the window expired.
  const session = bridge.session.bind(bridge); let calls = 0;
  bridge.session = host => { const info = session(host); if (++calls > 1) info.studio.signedIn = false; return info; };
  const answer = await runServiceCenter(['timers', '--host', HOST, '--module-id', '102'], deps(bridge));
  assert.deepEqual([answer.ok, answer.code, answer.continuation.tool, answer.continuation.arguments.action], [false, 'STUDIO_NOT_SIGNED_IN', 'o11_service_center_session', 'sign-in']);
  assert.deepEqual(bridge.logins, []);
});

test('an older bridge without reentry never turns an expiry into a credential prompt', async () => {
  const bridge = new ReentryBridge({ reentry: false, pages: { [ESPACE]: [LOGIN, html('factory/espace-edit.html')] } });
  const answer = await runServiceCenter(['timers', '--host', HOST, '--module-id', '102'], deps(bridge));
  assert.equal(answer.code, 'WEB_SIGN_IN_REQUIRED');
  assert.match(answer.error, /Studio is logged in on sc\.example\.test, but its Service Center window expired/);
  assert.deepEqual(bridge.logins, []);
  // With a stored login the older bridge re-enters with it, silently.
  const stored = new ReentryBridge({ reentry: false, pages: { [ESPACE]: [LOGIN, html('factory/espace-edit.html')] } });
  const result = await main(['timers', '--host', HOST, '--module-id', '102'], deps(stored, { present: async () => true }));
  assert.equal(result.ok, true);
  assert.deepEqual(stored.logins, [{ reenter: true }]);
});

test('a re-entry the identity provider refuses says so once, without a prompt and without a second read', async () => {
  const bridge = new ReentryBridge({ pages: { [ESPACE]: [LOGIN, html('factory/espace-edit.html')] },
    login: new BridgeError('SECRET_NOT_FOUND', 'no single sign-on session and no stored login', { write: false, executed: false }) });
  const answer = await runServiceCenter(['timers', '--host', HOST, '--module-id', '102'], deps(bridge));
  assert.equal(answer.code, 'WEB_SIGN_IN_INTERACTIVE');
  assert.match(answer.error, /identity provider asked its Service Center window for a login again/);
  assert.equal(bridge.calls.filter(c => c[0] === 'web' && c[1] === 'fetch').length, 1);
});

test('a write postback answered by the sign-in page is never re-entered or resent', async () => {
  const timer = SC + 'eSpace_Timer_Edit.aspx?EspaceKey=7c3d9e10-0000-4000-8000-00000000e102&Cyclic_Job_Key=9a8b7c6d-0000-4000-8000-00000000c001';
  const bridge = new ReentryBridge({ pages: { [ESPACE]: html('factory/espace-edit.html'), [`GET ${timer}`]: html('timers/timer-edit.active.html'),
    [`POST ${SC}eSpace_Timer_Edit.aspx`]: LOGIN } });
  const dir = temp();
  const transport = new StudioWebTransport(HOST, bridge, { reenter: () => assert.fail('a write is never re-entered') });
  const receipt = await new Client(fakeVault(HOST), transport, dir).mutate('timer-run', '102', 'ProcessQueue',
    { execute: true, words: 'go', operationId: uuid(), journal: new Journal(path.join(dir, 'receipts')) });
  assert.equal(receipt.ok, false);
  assert.deepEqual(bridge.logins, []);
  assert.equal(bridge.posts().length, 1);
});
import './fixtures/isolated-profile.mjs';
// Regression coverage for fully headless SC authentication. Legacy window-only
// bridges must never trigger window login; selected profiles use direct HTTPS.
// All identities, responses and cookies below are synthetic and offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { SsoSessionCache } from '../service-center/sso-session-cache.mjs';
import { Client, Journal } from '../service-center/client.mjs';
import { StudioWebTransport } from '../service-center/http.mjs';
import { AuthRequired } from '../service-center/errors.mjs';
import { runServiceCenter, serviceCenterTool } from '../service-center/index.mjs';
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

test('a signed-in legacy window-only bridge never touches its window; with nothing stored only the private prompt opens', async () => {
  const bridge = new ReentryBridge();
  const prompts = [];
  const answer = await runServiceCenter(['timers', '--host', HOST, '--module-id', '102'], deps(bridge, { promptWaitMs: 0,
    opener: (host, kind) => { prompts.push([host, kind]); return { opened: true }; } }));
  assert.equal(answer.code, 'CREDENTIAL_PROMPT_PENDING');
  assert.deepEqual(prompts, [[HOST, 'ServiceCenter']]);
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'web' || c[0] === 'login'), []);
  assert.deepEqual(bridge.logins, []);
});

test('explicit Studio selection cannot fall back to a window or a stored profile', async () => {
  const bridge = new ReentryBridge();
  const answer = await runServiceCenter(['timers', '--host', HOST, '--module-id', '102', '--session', 'studio'], deps(bridge, {
    present: async () => true,
    profiles: { resolve: () => assert.fail('explicit Studio selection must not change identity source') }
  }));
  assert.equal(answer.code, 'HEADLESS_AUTH_UNAVAILABLE');
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'web' || c[0] === 'login'), []);
});

function profileDeps(bridge, { challenge = false } = {}) {
  const counts = { reads: 0, logins: 0, closes: 0, profiles: 0 };
  const target = `SSAM/O11/${HOST}/ServiceCenter`;
  const ssoCache = new SsoSessionCache({ schedule: () => null, cancel: () => {} });
  return { counts, ssoCache, options: deps(bridge, {
    ssoCache,
    profiles: { resolve: async (context, options) => {
      counts.profiles++;
      assert.equal(context.host, HOST);
      assert.equal(context.principal, 'dev@example.test');
      assert.equal(options.interactive, false);
      return { ok: true, principal: context.principal, target };
    } },
    createSso: auth => {
      assert.equal(auth.user, 'dev@example.test');
      assert.equal(auth.credentialTarget, target);
      assert.equal(auth.bridge, bridge);
      const jar = new CookieJar();
      return { jar, authenticateSc: async () => {
        counts.logins++;
        if (challenge) throw new AuthRequired('IDENTITY_CHALLENGE_REQUIRED', 'Synthetic identity challenge');
        jar.setCookieSync('SCSession=synthetic-private; Secure; Path=/ServiceCenter/', `https://${HOST}/ServiceCenter/`);
      }, close: async () => { counts.closes++; jar.removeAllCookiesSync(); } };
    },
    send: async req => {
      counts.reads++;
      if (!req.headers.Cookie) return { status: 302, location: 'https://id.outsystems.com/community/login', setCookie: [], body: Buffer.alloc(0) };
      return { status: 200, contentType: 'text/html', setCookie: [], body: Buffer.from(html('factory/espace-edit.html')) };
    }
  }) };
}

test('a selected same-principal profile reads through headless SSO without legacy window login', async () => {
  const bridge = new ReentryBridge({ reentry: false });
  const fixture = profileDeps(bridge);
  const answer = await serviceCenterTool(['timers', '--host', HOST, '--module-id', '102'], fixture.options);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.auth.path, 'vault-sso');
  assert.deepEqual(answer.result.rows.map(r => r.fields.Name), ['ProcessQueue', 'NightlyCleanup']);
  assert.deepEqual(fixture.counts, { reads: 2, logins: 1, closes: 1, profiles: 1 });
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'web' || c[0] === 'login'), []);
  assert.doesNotMatch(JSON.stringify(answer), /synthetic-private|SCSession/);
  fixture.ssoCache.clear();
});

test('an identity challenge stops once without opening UI or retrying the protected read', async () => {
  const bridge = new ReentryBridge();
  const fixture = profileDeps(bridge, { challenge: true });
  const answer = await serviceCenterTool(['timers', '--host', HOST, '--module-id', '102'], fixture.options);
  assert.equal(answer.code, 'IDENTITY_CHALLENGE_REQUIRED');
  assert.equal(answer.stage, 'authentication');
  assert.deepEqual(fixture.counts, { reads: 1, logins: 1, closes: 1, profiles: 1 });
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'web' || c[0] === 'login'), []);
  assert.equal(fixture.ssoCache.entries.size, 0);
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
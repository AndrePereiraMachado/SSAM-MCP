// Lane F8 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md, A13). The real case (session cx-0e61, 06/10 01:18): the
// Studio was signed in by SSO, o11_service_center_read logs answered CREDENTIAL_PROMPT_OPENED "No Service Center login
// is stored for <host>: a private Windows prompt opened" and the session stopped until 10:06. Now:
//   - a bridge with sc_web:studioSession signs its hidden Service Center window in through the Studio's own session first
//     (no vault, nothing typed); the stored login is asked only when the page still asks for a login;
//   - an older bridge keeps the path of today (silent re-entry, else the stored login);
//   - a pending private prompt is waited for in the same call (SSAM_PROMPT_WAIT_MS), else CREDENTIAL_PROMPT_PENDING with
//     the same call as continuation.
// Offline: a fake bridge and synthetic Service Center pages; the clock and the sleeps of the wait are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { BridgeError, AuthRequired } from '../service-center/errors.mjs';
import { Resolver, PROMPT_WAIT_MS, promptWaitMs, reenterWindow } from '../service-center/auth.mjs';
import { STUDIO_SESSION } from '../service-center/bridge.mjs';
import { runServiceCenter, sameCall } from '../service-center/index.mjs';
import { FakeBridge, SC, fixture, temp } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const TARGET = `SSAM/O11/${HOST}/ServiceCenter`;
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const LOG_PAGES = { [`GET ${SC}Error_Logs.aspx`]: fixture('error-logs-1.html'), [`POST ${SC}Error_Logs.aspx`]: fixture('error-logs-2.html') };

// The bridge of the connected Studio: signed in on the host, its hidden window not yet. studioSession: the manifest flag;
// sso: whether the Studio's own session signs the window in; reentry: the web field of an older bridge with silent re-entry.
class Bridge extends FakeBridge {
  constructor({ studioSession = true, sso = true, reentry = false } = {}) {
    super({ web: false, pages: LOG_PAGES, capabilities: ['sc_api:soap', 'sc_web', 'sc_web:login', ...(studioSession ? [STUDIO_SESSION] : [])] });
    this.sso = sso; this.reentry = reentry; this.logins = [];
  }
  session(host) { const info = super.session(host); if (this.reentry) info.web.reentry = 'studio-sso'; return info; }
  web(host, action, options = {}) {
    if (action !== 'login') return super.web(host, action, options);
    this.logins.push(options.studioSession === true ? 'studio-session' : 'stored-login');
    if (options.studioSession && !this.sso) throw new BridgeError('WEB_SIGN_IN_NEEDS_LOGIN', 'the page asks for a login; nothing was typed', { reentry: 'needs-login' });
    this.webSigned = true;
    return { ok: true, signedIn: true, submitted: !options.studioSession, hidden: true, via: options.studioSession ? 'studio-session' : 'stored-login' };
  }
}

// A fake clock: each sleep moves it; present answers from a list (the last value repeats).
function clock() { let t = 0; const sleeps = []; return { now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; }, sleeps }; }
const answers = (...values) => { const calls = []; const fn = async target => { calls.push(target); return values.length > 1 ? values.shift() : values[0]; }; fn.calls = calls; return fn; };

function run(argv, { bridge, present = async () => assert.fail('the vault is not asked'), opener = () => assert.fail('no prompt'), wait = {}, locate } = {}) {
  const dir = temp();
  return runServiceCenter([...argv, '--host=' + HOST], { journal: new Journal(path.join(dir, 'receipts')), locate: locate ?? (() => bridge), present, opener,
    running: async () => false, exports: dir, registry: REGISTRY, promptWaitMs: wait.waitMs ?? 0, promptSleep: wait.sleep, now: wait.now });
}

test('logs through the Studio session with sc_web:studioSession: no vault entry, no prompt, the window signed in by the Studio itself', async () => {
  const bridge = new Bridge();
  const logs = await run(['logs', '--kind=error', '--limit=10'], { bridge });
  assert.equal(logs.ok, true, JSON.stringify(logs));
  assert.equal(logs.auth.path, 'studio-web');
  assert.deepEqual(bridge.logins, ['studio-session']);
  assert.deepEqual(logs.rows.map(r => r.fields.Message), ['NullReference in Checkout', 'Timeout calling PaymentsAPI', 'Invoice rounding']);
  // The explicit web-sign-in takes the same path and says so.
  const signIn = await run(['session-web-sign-in'], { bridge: new Bridge() });
  assert.deepEqual([signIn.ok, signIn.window, signIn.via], [true, 'hidden', 'studio-session']);
});

test('the Studio session asks for a typed login: only then the stored login (present), one sign-in more; nothing prompted', async () => {
  const bridge = new Bridge({ sso: false });
  const present = answers(true);
  const logs = await run(['logs', '--kind=error', '--limit=10'], { bridge, present });
  assert.equal(logs.ok, true);
  assert.deepEqual(bridge.logins, ['studio-session', 'stored-login']);
  assert.deepEqual(present.calls, [TARGET]);
});

test('an older bridge (no sc_web:studioSession) keeps the path of today: silent re-entry, else the stored login', async () => {
  const silent = new Bridge({ studioSession: false, reentry: true });
  assert.equal((await run(['logs', '--kind=error', '--limit=10'], { bridge: silent })).ok, true);
  assert.deepEqual(silent.logins, ['stored-login'], 'the login verb without session:"studio"');
  const stored = new Bridge({ studioSession: false });
  assert.equal((await run(['logs', '--kind=error', '--limit=10'], { bridge: stored, present: answers(true) })).ok, true);
  assert.deepEqual(stored.logins, ['stored-login']);
});

test('a pending private prompt is waited for in the same call: stored during the wait, the call goes on and answers the logs', async () => {
  const bridge = new Bridge({ sso: false });
  const c = clock();
  const present = answers(false, false, false, true);   // the first look, then two polls, then stored
  const prompts = [];
  const logs = await run(['logs', '--kind=error', '--limit=10'], { bridge, present, opener: (host, kind) => { prompts.push([host, kind]); return { opened: true }; },
    wait: { waitMs: PROMPT_WAIT_MS, sleep: c.sleep, now: c.now } });
  assert.equal(logs.ok, true, JSON.stringify(logs));
  assert.deepEqual(prompts, [[HOST, 'ServiceCenter']], 'one prompt, opened once');
  assert.deepEqual(bridge.logins, ['studio-session', 'stored-login']);
  assert.ok(c.sleeps.length >= 2 && c.sleeps.every(ms => ms <= 1000));
});

test('not stored in time: CREDENTIAL_PROMPT_PENDING, resumable, with the same call as continuation; nothing read, no login submitted', async () => {
  const bridge = new Bridge({ studioSession: false });
  const c = clock();
  const pending = await run(['logs', '--kind=error', '--limit=10', '--stack-contains=Pay'], { bridge, present: answers(false), opener: () => ({ opened: true }),
    wait: { waitMs: 3000, sleep: c.sleep, now: c.now } });
  assert.deepEqual([pending.ok, pending.code], [false, 'CREDENTIAL_PROMPT_PENDING']);
  assert.deepEqual([pending.auth.path, pending.auth.target, pending.auth.waitedMs, pending.auth.resumable], ['prompt', TARGET, 3000, true]);
  assert.deepEqual(pending.continuation.tool, 'o11_service_center_read');
  assert.deepEqual(pending.continuation.arguments, { action: 'logs', host: HOST, limit: 10, stackContains: 'Pay' });
  assert.equal(c.sleeps.reduce((a, b) => a + b, 0), 3000, 'a bounded wait, never longer');
  assert.deepEqual(bridge.logins, [], 'no login without the stored entry');
  assert.equal(bridge.calls.filter(x => x[0] === 'web' && x[1] === 'fetch').length, 0);
  // The A13 case on an older bridge without a prompt wait (0): pending at once, never CREDENTIAL_PROMPT_OPENED.
  const now = await run(['logs', '--kind=error'], { bridge: new Bridge({ studioSession: false }), present: answers(false), opener: () => ({ opened: true }) });
  assert.equal(now.code, 'CREDENTIAL_PROMPT_PENDING');
});

test('without a Studio the vault path waits too, and a session sign-in answers stored or pending', async () => {
  const c = clock();
  const resolver = new Resolver(HOST, { locate: () => null, present: answers(false, false, true), running: async () => false, opener: () => ({ opened: true }),
    wait: { waitMs: 10000, sleep: c.sleep, now: c.now } });
  const auth = await resolver.resolve('web');
  assert.equal(auth.path, 'vault');
  assert.ok(auth.attempts.some(a => a.path === 'prompt' && a.outcome === 'stored'));
  const lifetime = new Resolver(HOST, { locate: () => null, present: answers(false), running: async () => false, opener: () => ({ opened: true }), wait: { waitMs: 0 } });
  await assert.rejects(lifetime.resolve('lifetime'), e => e instanceof AuthRequired && e.code === 'CREDENTIAL_PROMPT_PENDING' && e.auth.target === `SSAM/O11/${HOST}/LifeTime`);
  const signIn = await run(['session-sign-in'], { locate: () => null, present: answers(false), opener: () => ({ opened: true }) });
  assert.deepEqual([signIn.code, signIn.continuation.tool, signIn.continuation.arguments], ['CREDENTIAL_PROMPT_PENDING', 'o11_service_center_session', { action: 'sign-in', host: HOST }]);
});

test('an expired window re-enters through the Studio session first; the stored login only when it exists; never a prompt', async () => {
  const fine = new Bridge();
  await reenterWindow(fine, HOST, { present: async () => assert.fail('the vault is not asked') });
  assert.deepEqual(fine.logins, ['studio-session']);
  const stored = new Bridge({ sso: false });
  await reenterWindow(stored, HOST, { present: async () => true });
  assert.deepEqual(stored.logins, ['studio-session', 'stored-login']);
  const none = new Bridge({ sso: false });
  await assert.rejects(reenterWindow(none, HOST, { present: async () => false }),
    e => e instanceof AuthRequired && e.code === 'WEB_SIGN_IN_INTERACTIVE' && e.continuation.arguments.action === 'web-sign-in');
  assert.deepEqual(none.logins, ['studio-session']);
});

test('SSAM_PROMPT_WAIT_MS bounds the wait (default 120 s, 0 does not wait) and sameCall rebuilds the MCP call of an argv', () => {
  assert.equal(PROMPT_WAIT_MS, 120000);
  assert.equal(promptWaitMs({}), 120000);
  assert.equal(promptWaitMs({ SSAM_PROMPT_WAIT_MS: '0' }), 0);
  assert.equal(promptWaitMs({ SSAM_PROMPT_WAIT_MS: '5000' }), 5000);
  assert.equal(promptWaitMs({ SSAM_PROMPT_WAIT_MS: 'x' }), 120000);
  assert.equal(promptWaitMs({ SSAM_PROMPT_WAIT_MS: '5000' }, 10), 10);
  assert.deepEqual(sameCall(['logs', '--host=h.test', '--kind=general', '--max-pages=50', '--export']),
    { tool: 'o11_service_center_read', arguments: { action: 'logs', host: 'h.test', kind: 'general', maxPages: 50, export: true } });
  assert.deepEqual(sameCall(['property-set', '--host=h.test', '--module-id=7', '--name=Key', '--value-vault=SSAM/O11/h.test/SiteProperty/Key', '--execute',
    '--operation-id=11111111-2222-4333-8444-555555555555', '--words=sim pode']),
  { tool: 'o11_service_center_write', arguments: { action: 'property-set', host: 'h.test', moduleId: '7', name: 'Key', operationId: '11111111-2222-4333-8444-555555555555',
    words: "<the user's own words>", valueVault: 'SSAM/O11/h.test/SiteProperty/Key', execute: true } });
  assert.deepEqual(sameCall(['session-web-sign-in', '--host=h.test']), { tool: 'o11_service_center_session', arguments: { action: 'web-sign-in', host: 'h.test' } });
});

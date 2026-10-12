// The F8 credential cases over the headless transport. The Studio session first (studio-http), then a compatible
// stored profile, and only when the host has nothing stored the private Windows prompt (windows-o11-credential.ps1),
// waited for in the same call (SSAM_PROMPT_WAIT_MS, never past the read budget), else CREDENTIAL_PROMPT_PENDING.
// No legacy window is ever signed in, no identity source changes silently and an existing entry is never overwritten.
// Synthetic bridges, credentials, prompts and clocks only; no external service, no real vault, no window.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { AuthRequired } from '../service-center/errors.mjs';
import { Resolver, PROMPT_WAIT_MS, awaitStored, promptWaitMs, reenterWindow } from '../service-center/auth.mjs';
import { boundedRead } from '../read-budget.mjs';
import { STUDIO_SESSION } from '../service-center/bridge.mjs';
import { runServiceCenter, sameCall } from '../service-center/index.mjs';
import { FakeBridge, SC, fixture, temp } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const TARGET = `SSAM/O11/${HOST}/ServiceCenter`;
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const LOG_PAGES = { [`GET ${SC}Error_Logs.aspx`]: fixture('error-logs-1.html'), [`POST ${SC}Error_Logs.aspx`]: fixture('error-logs-2.html') };

// Legacy capability and metadata remain insufficient for headless execution.
class Bridge extends FakeBridge {
  constructor({ studioSession = true, reentry = false } = {}) {
    super({ web: false, pages: LOG_PAGES, capabilities: ['sc_api:soap', 'sc_web', 'sc_web:login', ...(studioSession ? [STUDIO_SESSION] : [])] });
    this.reentry = reentry; this.logins = [];
  }
  session(host) { const info = super.session(host); if (this.reentry) info.web.reentry = 'studio-sso'; return info; }
  web(host, action, options = {}) {
    if (action === 'login') { this.logins.push(action); assert.fail('legacy window login is forbidden'); }
    return super.web(host, action, options);
  }
}

// A fake clock: each sleep moves it; present answers from a list (the last value repeats).
function clock() { let t = 0; const sleeps = []; return { now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; }, sleeps }; }
const answers = (...values) => { const calls = []; const fn = async target => { calls.push(target); return values.length > 1 ? values.shift() : values[0]; }; fn.calls = calls; return fn; };

function run(argv, { bridge, profiles, present = async () => assert.fail('the vault is not asked'), opener = () => assert.fail('no prompt'), wait = {}, locate } = {}) {
  const dir = temp();
  return runServiceCenter([...argv, '--host=' + HOST], { journal: new Journal(path.join(dir, 'receipts')), locate: locate ?? (() => bridge), present, opener,
    running: async () => false, profiles, exports: dir, registry: REGISTRY, promptWaitMs: wait.waitMs ?? 0, promptSleep: wait.sleep, now: wait.now });
}

test('native Studio HTTP reads logs without vault lookup, window login or credential prompt', async () => {
  const bridge = new FakeBridge({ pages: LOG_PAGES });
  const logs = await run(['logs', '--kind=error', '--limit=10'], { bridge });
  assert.equal(logs.ok, true, JSON.stringify(logs));
  assert.equal(logs.auth.path, 'studio-http');
  assert.deepEqual(logs.rows.map(r => r.fields.Message), ['NullReference in Checkout', 'Timeout calling PaymentsAPI', 'Invoice rounding']);
  assert.equal(bridge.calls.filter(c => c[0] === 'login' || c[0] === 'web' && ['login', 'open'].includes(c[1])).length, 0);
});

test('legacy window-session capability never signs a window in; with nothing stored the private prompt opens (pending)', async () => {
  const bridge = new Bridge();
  const present = answers(false), prompts = [];
  const logs = await run(['logs', '--kind=error', '--limit=10'], { bridge, present, opener: (host, kind) => { prompts.push([host, kind]); return { opened: true }; } });
  assert.equal(logs.code, 'CREDENTIAL_PROMPT_PENDING', JSON.stringify(logs));
  assert.deepEqual([logs.auth.path, logs.auth.target, logs.auth.resumable], ['prompt', TARGET, true]);
  assert.deepEqual(prompts, [[HOST, 'ServiceCenter']]);
  assert.deepEqual(bridge.logins, []);
  assert.equal(bridge.calls.filter(c => c[0] === 'web').length, 0);
});

test('legacy reentry metadata cannot authorize a window; a stored login resolves directly to vault, nothing stored opens the prompt', async () => {
  for (const stored of [false, true]) {
    const bridge = new Bridge({ studioSession: false, reentry: true });
    const prompts = [];
    const resolver = new Resolver(HOST, { locate: () => bridge, present: answers(stored), wait: { waitMs: 0 },
      opener: (host, kind) => { prompts.push(kind); return { opened: true }; } });
    if (stored) assert.equal((await resolver.resolve('web')).path, 'vault');
    else await assert.rejects(resolver.resolve('web'), e => e.code === 'CREDENTIAL_PROMPT_PENDING');
    assert.deepEqual(prompts, stored ? [] : ['ServiceCenter']);
    assert.deepEqual(bridge.logins, []);
    assert.equal(bridge.calls.filter(c => c[0] === 'web').length, 0);
  }
});

test('a missing credential opens the private prompt once and waits, bounded: stored during the wait, the call goes on', async () => {
  const c = clock(), present = answers(false, false, false, true), prompts = [];
  const resolver = new Resolver(HOST, { locate: () => new Bridge(), present, wait: { waitMs: PROMPT_WAIT_MS, sleep: c.sleep, now: c.now },
    opener: (host, kind) => { prompts.push([host, kind]); return { opened: true }; } });
  const auth = await resolver.resolve('web');
  assert.equal(auth.path, 'vault');
  assert.deepEqual(prompts, [[HOST, 'ServiceCenter']], 'one prompt, opened once');
  assert.ok(auth.attempts.some(a => a.path === 'prompt' && a.outcome === 'stored'));
  assert.ok(c.sleeps.length >= 2 && c.sleeps.every(ms => ms <= 1000));
  // Not stored in time: CREDENTIAL_PROMPT_PENDING, resumable, with the same call as continuation; nothing read.
  const d = clock(), bridge = new Bridge();
  const pending = await run(['logs', '--kind=error', '--limit=10', '--stack-contains=Pay'], { bridge, present: answers(false),
    opener: () => ({ opened: true }), wait: { waitMs: 3000, sleep: d.sleep, now: d.now } });
  assert.deepEqual([pending.ok, pending.code, pending.auth.waitedMs, pending.auth.resumable], [false, 'CREDENTIAL_PROMPT_PENDING', 3000, true]);
  assert.equal(pending.continuation.tool, 'o11_service_center_read');
  assert.deepEqual(pending.continuation.arguments, { action: 'logs', host: HOST, limit: 10, stackContains: 'Pay' });
  assert.equal(d.sleeps.reduce((a, b) => a + b, 0), 3000, 'a bounded wait, never longer');
  assert.deepEqual(bridge.logins, []);
  assert.equal(bridge.calls.filter(x => x[0] === 'web').length, 0);
});

test('authPrompt=never refuses without opening the prompt', async () => {
  const resolver = new Resolver(HOST, { prompt: 'never', locate: () => null, present: answers(false), running: async () => false,
    opener: () => assert.fail('authPrompt=never') });
  await assert.rejects(resolver.resolve('web'), e => e instanceof AuthRequired && e.code === 'AUTH_REQUIRED');
});

test('with the stored-profile broker and nothing stored, the private prompt stores one that is selected and remembered', async () => {
  const c = clock(), prompts = [], remembered = [], scopes = [];
  const profiles = {
    resolve: async (scope, options) => { scopes.push([scope, options]); assert.equal(options.interactive, false);
      return options.target ? { ok: true, target: options.target, principal: 'dev@example.test', source: 'explicit-target' } : { ok: false, code: 'AUTH_REQUIRED', candidateCount: 0 }; },
    remember: async (scope, selected) => { remembered.push([scope, selected.target, selected.principal]); return { ok: true }; } };
  const resolver = new Resolver(HOST, { locate: () => null, running: async () => false, present: answers(false, false, true), profiles,
    opener: (host, kind) => { prompts.push([host, kind]); return { opened: true }; }, wait: { waitMs: 10000, sleep: c.sleep, now: c.now } });
  const auth = await resolver.resolve('web');
  assert.deepEqual([auth.path, auth.credentialTarget, auth.credentialSelection, auth.user], ['vault', TARGET, 'private-window', 'dev@example.test']);
  assert.deepEqual(prompts, [[HOST, 'ServiceCenter']]);
  assert.deepEqual(scopes.map(([s, o]) => [s.principal, o.target ?? null]), [[null, null], [null, TARGET]]);
  assert.deepEqual(remembered, [[{ lane: 'o11', host: HOST, principal: null }, TARGET, 'dev@example.test']]);
});

test('an entry that exists (another principal or an ambiguous choice) is never overwritten through the prompt', async () => {
  for (const [present, answer] of [[answers(true), { ok: false, code: 'AUTH_REQUIRED', candidateCount: 0 }],
    [answers(false), { ok: false, code: 'CREDENTIAL_SELECTION_REQUIRED', candidateCount: 2 }]]) {
    const resolver = new Resolver(HOST, { locate: () => null, running: async () => false, present, wait: { waitMs: 0 },
      profiles: { resolve: async () => answer }, opener: () => assert.fail('an existing entry is never overwritten') });
    await assert.rejects(resolver.resolve('web'), e => e instanceof AuthRequired && e.code === answer.code);
  }
});

test('inside a read the wait for the prompt ends before the read budget does', async () => {
  const c = clock();
  const waited = await boundedRead('pa2-f8-budget-' + Date.now(), () => awaitStored(async () => false, TARGET,
    { waitMs: PROMPT_WAIT_MS, sleep: c.sleep, now: c.now }), { timeoutMs: 5000 });
  assert.equal(waited.stored, false);
  assert.ok(waited.waitedMs <= 3000 && waited.waitedMs >= 2000, String(waited.waitedMs));
});

test('ambiguous stored identity returns a same-call continuation without opening a selector or sending a read', async () => {
  const bridge = new Bridge({ studioSession: false });
  const c = clock();
  const pending = await run(['logs', '--kind=error', '--limit=10', '--stack-contains=Pay'], { bridge,
    profiles: { resolve: async (scope, options) => {
      assert.equal(scope.principal, 'dev@example.test');
      assert.equal(scope.host, HOST);
      assert.equal(options.interactive, false);
      return { ok: false, code: 'CREDENTIAL_SELECTION_REQUIRED', candidateCount: 2 };
    } }, wait: { waitMs: 3000, sleep: c.sleep, now: c.now } });
  assert.equal(pending.code, 'CREDENTIAL_SELECTION_REQUIRED');
  assert.equal(pending.auth.candidateCount, 2);
  assert.equal(pending.continuation.tool, 'o11_service_center_read');
  assert.deepEqual(pending.continuation.arguments, { action: 'logs', host: HOST, limit: 10, stackContains: 'Pay' });
  assert.deepEqual(c.sleeps, []);
  assert.deepEqual(bridge.logins, []);
  assert.equal(bridge.calls.filter(c => c[0] === 'web').length, 0);
});

test('without a Studio, missing SC and LifeTime credentials open their own prompt; a session sign-in answers pending', async () => {
  for (const need of ['web', 'lifetime']) {
    const c = clock(), present = answers(false), prompts = [];
    const resolver = new Resolver(HOST, { locate: () => null, present, running: async () => false,
      opener: (host, kind) => { prompts.push(kind); return { opened: true }; }, wait: { waitMs: 10000, sleep: c.sleep, now: c.now } });
    const target = need === 'web' ? TARGET : `SSAM/O11/${HOST}/LifeTime`;
    await assert.rejects(resolver.resolve(need), e => e instanceof AuthRequired && e.code === 'CREDENTIAL_PROMPT_PENDING' && e.auth.target === target);
    assert.deepEqual(prompts, [need === 'web' ? 'ServiceCenter' : 'LifeTime']);
    assert.equal(c.sleeps.reduce((a, b) => a + b, 0), 10000);
  }
  const signIn = await run(['session-sign-in'], { locate: () => null, present: answers(false), opener: () => ({ opened: true }) });
  assert.deepEqual([signIn.code, signIn.continuation.tool, signIn.continuation.arguments], ['CREDENTIAL_PROMPT_PENDING', 'o11_service_center_session', { action: 'sign-in', host: HOST }]);
});

test('window reentry compatibility refuses every window-only bridge even when credentials are stored', async () => {
  for (const studioSession of [true, false]) {
    const bridge = new Bridge({ studioSession });
    await assert.rejects(reenterWindow(bridge, HOST, { present: () => assert.fail('no vault lookup') }),
      e => e instanceof AuthRequired && e.code === 'HEADLESS_AUTH_UNAVAILABLE');
    assert.deepEqual(bridge.logins, []);
    assert.equal(bridge.calls.filter(c => c[0] === 'web').length, 0);
  }
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

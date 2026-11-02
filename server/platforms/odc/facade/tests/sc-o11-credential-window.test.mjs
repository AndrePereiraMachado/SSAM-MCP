// Lote 4, F3 (relato 88a0d528, 14/10/2026): db-connection-test answered CREDENTIAL_PROMPT_PENDING and declared a private
// window open that the person could not find, not even by Alt+Tab: the legacy O11 prompt was a detached Get-Credential
// whose window nobody confirmed. The O11 opener now uses the ODC prompt manager (O11 kinds): it reports a window only when
// the manager confirms it visible, a repeated call brings the open window to the front, the pending answer carries the
// exact question to relay, and a cancel ends the wait at once and leaves no state. No real window: a simulated manager.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openPrompt, promptAndWait, promptTitle } from '../service-center/auth.mjs';
import { AuthRequired, ProtocolError } from '../service-center/errors.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { Journal } from '../service-center/client.mjs';
import { O11_PROMPT_KINDS, promptContext, promptStateDir } from '../../portal/runtime/credential-prompt.mjs';
import { temp } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'test.example.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const helper = path.join(import.meta.dirname, '..', '..', 'portal', 'runtime', 'windows-credential-prompt.ps1');

// A simulated prompt manager: answers per action from a script of window states, and counts the windows it "opened".
function manager(states = {}) {
  const calls = [];
  let windows = 0;
  const fn = async (kind, host, name, action) => {
    calls.push([kind, host, name, action]);
    const next = states[action]?.shift?.() ?? states[action];
    if (action === 'ensure' && next?.opened) windows++;
    return next ?? { state: 'absent', visible: false };
  };
  return Object.assign(fn, { calls, windows: () => windows });
}
const visible = (opened = true) => ({ state: 'visible', visible: true, foreground: true, pid: 4242, opened, alreadyOpen: !opened });

test('the O11 kinds go to the managed window with the targets of the legacy prompt', async () => {
  const m = manager({ ensure: [visible()] });
  const window = await openPrompt(HOST, 'DatabaseConnection', 'LegacyERP', { manager: m, env: { USERPROFILE: temp() } });
  assert.deepEqual(m.calls[0], ['o11-database', HOST, 'LegacyERP', 'ensure']);
  assert.equal(window.target, `SSAM/O11/${HOST}/DatabaseConnection/LegacyERP`);
  assert.deepEqual([window.opened, window.visible, window.foreground, window.pid], [true, true, true, 4242]);
  assert.equal(window.title, `SSAM - ${HOST} - o11-database`);
  await assert.rejects(openPrompt(HOST, 'DatabaseConnection', '../x', { manager: m }), e => e instanceof ProtocolError);
  assert.deepEqual(O11_PROMPT_KINDS, { ServiceCenter: 'o11-service-center', LifeTime: 'o11-lifetime', DatabaseConnection: 'o11-database', SiteProperty: 'o11-setting' });
  // The helper writes exactly the targets credentialTarget names, and labels the form O11.
  const script = fs.readFileSync(helper, 'utf8');
  for (const target of ['SSAM/O11/$HostName/ServiceCenter', 'SSAM/O11/$HostName/LifeTime', 'SSAM/O11/$HostName/DatabaseConnection/$EntryName', 'SSAM/O11/$HostName/SiteProperty/$EntryName'])
    assert.ok(script.includes(target), target);
  assert.ok(script.includes("ValidateSet('portal','api-client','database','setting','o11-service-center','o11-lifetime','o11-database','o11-setting')"));
});

test('a window the manager does not confirm is refused with its code, never declared open', async () => {
  for (const answer of [{ state: 'failed', visible: false, code: 'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE' }, { state: 'starting', visible: false },
    { state: 'failed', visible: false, opened: false, code: 'CREDENTIAL_PROMPT_UNAVAILABLE' }]) {
    const error = await openPrompt(HOST, 'ServiceCenter', null, { manager: manager({ ensure: [answer] }) }).then(() => assert.fail('must refuse'), e => e);
    assert.ok(error instanceof AuthRequired);
    assert.equal(error.code, answer.code ?? 'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE');
    assert.match(error.message, /could not be confirmed on the screen/);
    assert.match(error.message, /does not claim it opened/);
    assert.equal(error.answer().auth.window.visible, false);
  }
});

test('a repeated call focuses the window that is open, never a second one', async () => {
  const m = manager({ ensure: [visible(true), visible(false)] });
  const first = await openPrompt(HOST, 'ServiceCenter', null, { manager: m });
  const again = await openPrompt(HOST, 'ServiceCenter', null, { manager: m });
  assert.equal(first.opened, true);
  assert.deepEqual([again.opened, again.alreadyOpen, again.foreground], [false, true, true]);
  assert.equal(m.windows(), 1);
});

test('pending: the window facts and the exact question, nothing stored, the same call goes on', async () => {
  const dir = temp();
  const m = manager({ ensure: [visible()], status: { state: 'visible', visible: true, pid: 4242 } });
  const answer = await runServiceCenter(['session-sign-in', '--host', HOST], { journal: new Journal(dir), locate: () => null, running: async () => false,
    present: async () => false, registry: REGISTRY, exports: dir, promptManager: m, promptWaitMs: 0, env: { USERPROFILE: dir } });
  assert.equal(answer.code, 'CREDENTIAL_PROMPT_PENDING');
  assert.deepEqual(answer.auth.window, { title: promptTitle(HOST, 'ServiceCenter'), visible: true, foreground: true, pid: 4242 });
  assert.equal(answer.question, `A private SSAM window titled "SSAM - ${HOST} - o11-service-center" is open on your screen. Please type the Service Center `
    + 'login there (an OutSystems account: its e-mail and password), then click Save (or Cancel to stop). Nothing goes through this chat. '
    + 'Tell me when it is saved and I will continue.');
  assert.deepEqual(answer.continuation.arguments, { action: 'sign-in', host: HOST });
  assert.doesNotMatch(JSON.stringify(answer.continuation), /password|secret|credential/i);
});

test('a cancel ends the wait at once, clears the window state and continues only when the person asks', async () => {
  const env = { USERPROFILE: temp() };
  const state = promptStateDir('o11-database', HOST, 'LegacyERP', env);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'window.json'), JSON.stringify({ contextKey: promptContext('o11-database', HOST, 'LegacyERP').key, state: 'cancelled' }));
  const m = manager({ ensure: [visible()], status: { state: 'cancelled', visible: false } });
  let clock = 0, sleeps = 0;
  const error = await promptAndWait({ host: HOST, kind: 'DatabaseConnection', name: 'LegacyERP', target: `SSAM/O11/${HOST}/DatabaseConnection/LegacyERP`,
    opener: (h, k, n) => openPrompt(h, k, n, { manager: m, env }), present: async () => false, why: 'The database login for LegacyERP is not stored',
    wait: { waitMs: 120000, interval: 1000, now: () => clock, sleep: async ms => { sleeps++; clock += ms; } } }).then(() => assert.fail('must refuse'), e => e);
  assert.equal(error.code, 'CREDENTIAL_PROMPT_CANCELLED');
  assert.ok(sleeps <= 3, 'the wait stopped at the first status check, not at the deadline');
  assert.match(error.message, /nothing was stored and nothing was sent/);
  assert.equal(fs.existsSync(path.join(state, 'window.json')), false, 'no state left behind');
  // An ensure that finds the window already cancelled refuses the same way, without opening another.
  const direct = await openPrompt(HOST, 'ServiceCenter', null, { manager: manager({ ensure: [{ state: 'cancelled', visible: false }] }), env })
    .then(() => assert.fail('must refuse'), e => e);
  assert.equal(direct.code, 'CREDENTIAL_PROMPT_CANCELLED');
  // Through the tool: the continuation is the same call, opened only when the person asks.
  const dir = temp();
  const answer = await runServiceCenter(['session-sign-in', '--host', HOST], { journal: new Journal(dir), locate: () => null, running: async () => false,
    present: async () => false, registry: REGISTRY, exports: dir, promptManager: manager({ ensure: [{ state: 'cancelled', visible: false }] }), env: { USERPROFILE: dir } });
  assert.equal(answer.code, 'CREDENTIAL_PROMPT_CANCELLED');
  assert.match(answer.continuation.why, /only when the person asks/);
  const unconfirmed = await runServiceCenter(['session-sign-in', '--host', HOST], { journal: new Journal(dir), locate: () => null, running: async () => false,
    present: async () => false, registry: REGISTRY, exports: dir, promptManager: manager({ ensure: [{ state: 'failed', visible: false, code: 'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE' }] }), env: { USERPROFILE: dir } });
  assert.equal(unconfirmed.code, 'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE');
  assert.deepEqual(unconfirmed.continuation.arguments, { action: 'sign-in', host: HOST });
});

test('the ODC contexts keep their rules beside the O11 kinds', () => {
  assert.throws(() => promptContext('database', 'example.test', 'x'.repeat(65)));
  assert.equal(typeof promptContext('o11-database', 'example.test', 'x'.repeat(100)).key, 'string');
  assert.throws(() => promptContext('o11-service-center', 'example.test', 'named'));
  assert.notEqual(promptContext('o11-database', 'example.test', 'Sales').key, promptContext('database', 'example.test', 'Sales').key);
  assert.match(promptStateDir('o11-lifetime', 'example.test', '', { USERPROFILE: 'C:\\u' }), /prompts[\\/]o11-[a-f0-9]{64}$/);
  assert.match(promptStateDir('portal', 'example.test', '', { USERPROFILE: 'C:\\u' }), /prompts[\\/]odc-[a-f0-9]{64}$/);
});

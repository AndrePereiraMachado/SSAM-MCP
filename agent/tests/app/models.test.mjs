// The pure models: settings (defaults, the update server rule, precedence), the agent view (summarize, exit policy),
// the update reducer and the tray menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, normalize, loadSettings, saveSettings, updateUrlProblem, resolveUpdateUrl } from '../../src/main/core/settings.mjs';
import { summarize, exitPolicy, restartDelayMs, readState, EXIT_TEXT } from '../../src/main/core/agent-state.mjs';
import { INITIAL, reduce, updateText, canCheck, describeUpdateError } from '../../src/main/core/update-model.mjs';
import { menuFor, iconFor, tooltipFor } from '../../src/main/core/tray-model.mjs';
import { defaultRoot, rootFiles } from '../../src/main/core/paths.mjs';

test('settings: defaults, a round trip, and only https (or loopback http) as the update server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-app-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    assert.deepEqual(loadSettings(file), { ...DEFAULTS });
    // Start at login and the automatic install are on unless turned off.
    assert.equal(DEFAULTS.autostart, true);
    assert.equal(DEFAULTS.updateAutoInstall, true);
    const saved = saveSettings(file, { root: 'C:\\SSAM-Agent ', autostart: false, updateUrl: 'https://updates.example.com/ssam-agent/', updateCheckHours: '12', updateAutoInstall: false });
    assert.deepEqual(saved, { root: 'C:\\SSAM-Agent', autostart: false, updateUrl: 'https://updates.example.com/ssam-agent', updateCheckHours: 12, updateAutoInstall: false });
    assert.deepEqual(loadSettings(file), saved);
    assert.equal(normalize({}).autostart, true);
    assert.equal(normalize({ autostart: 'no' }).autostart, true);
    assert.equal(normalize({ updateUrl: 'http://updates.example.com/x' }).updateUrl, null);
    assert.equal(normalize({ updateUrl: 'http://127.0.0.1:7340/x' }).updateUrl, 'http://127.0.0.1:7340/x');
    assert.equal(normalize({ updateCheckHours: 0 }).updateCheckHours, 6);
    assert.match(updateUrlProblem('ftp://x'), /https/);
    assert.match(updateUrlProblem('not a url'), /not a valid URL/);
    assert.equal(updateUrlProblem(null), null);
    fs.writeFileSync(file, '{broken');
    assert.deepEqual(loadSettings(file), { ...DEFAULTS });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the update server: the environment wins over the setting, which wins over the build; none means off', () => {
  assert.deepEqual(resolveUpdateUrl({ env: { SSAM_UPDATE_URL: 'https://e/x/' }, settings: { updateUrl: 'https://s' }, build: 'https://b' }), { url: 'https://e/x', source: 'env' });
  assert.deepEqual(resolveUpdateUrl({ env: {}, settings: { updateUrl: 'https://s' }, build: 'https://b' }), { url: 'https://s', source: 'settings' });
  assert.deepEqual(resolveUpdateUrl({ env: { SSAM_UPDATE_URL: 'http://plain.example.com' }, settings: {}, build: 'https://b' }), { url: 'https://b', source: 'build' });
  assert.deepEqual(resolveUpdateUrl({ env: {}, settings: {}, build: null }), { url: null, source: null });
});

test('paths: the default root of each platform and the files of a root', () => {
  assert.equal(defaultRoot({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\customer' } }), 'C:\\Users\\customer\\AppData\\Roaming\\SSAM-Agent\\data');
  assert.equal(defaultRoot({ platform: 'darwin', env: { HOME: '/Users/customer/' } }), '/Users/customer/Library/SSAM-Agent/data');
  const files = rootFiles(path.join('C:', 'SSAM-Agent'));
  assert.equal(path.basename(files.credential), 'credential');
  assert.equal(path.basename(path.dirname(files.state)), 'private');
  assert.equal(path.basename(files.script), 'ssam-agent.mjs');
});

test('the agent view: not set up, external, each state while running, the final exits and a crash', () => {
  assert.equal(summarize({ setUp: false, running: false, state: null }).status, 'not-set-up');
  assert.equal(summarize({ setUp: true, running: false, state: null, packProblem: 'damaged' }).status, 'attention');
  assert.equal(summarize({ setUp: true, running: false, state: { pid: 5, state: 'connected' }, external: true }).status, 'external');
  for (const [state, status] of [['starting', 'starting'], ['connecting', 'connecting'], ['connected', 'connected'], ['reconnecting', 'reconnecting']])
    assert.equal(summarize({ setUp: true, running: true, state: { pid: 7, state, server: 'https://s', at: '2026-10-20T10:00:00Z', delayMs: 4000 } }).status, status, state);
  assert.match(summarize({ setUp: true, running: true, state: { state: 'reconnecting', delayMs: 4000 } }).detail, /in 4 s/);
  for (const code of [2, 3, 4]) {
    const view = summarize({ setUp: true, running: false, state: null, lastExit: code });
    assert.equal(view.status, 'attention');
    assert.equal(view.attention, true);
    assert.ok(view.detail.includes(EXIT_TEXT[code]));
    assert.equal(exitPolicy(code), 'final');
  }
  assert.equal(exitPolicy(0), 'stopped');
  assert.equal(exitPolicy(1), 'restart');
  assert.equal(exitPolicy(137), 'restart');
  assert.equal(summarize({ setUp: true, running: false, state: null, lastExit: 1 }).status, 'stopped');
  assert.match(summarize({ setUp: true, running: false, state: null, lastExit: 1 }).detail, /starts it again/);
  assert.equal(summarize({ setUp: true, running: false, state: null, lastExit: 0 }).detail, 'The agent is not running.');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(restartDelayMs), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test('readState keeps only what the agent writes, with the right types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-app-state-'));
  try {
    const file = path.join(dir, 'agent.json');
    assert.equal(readState(file), null);
    fs.writeFileSync(file, JSON.stringify({ pid: 42, server: 'https://s', state: 'stopped', at: '2026-10-20T10:00:00.000Z', exitCode: 2, reason: 'revoked', extra: 1 }));
    assert.deepEqual(readState(file), { pid: 42, state: 'stopped', at: '2026-10-20T10:00:00.000Z', server: 'https://s', exitCode: 2, reason: 'revoked', delayMs: null });
    fs.writeFileSync(file, '{"state": 5}');
    assert.equal(readState(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the update reducer follows electron-updater and the text says what to do', () => {
  let state = reduce(INITIAL, { type: 'off' });
  assert.equal(state.status, 'off');
  assert.match(updateText(state, '0.1.0'), /Updates are off/);
  state = reduce(state, { type: 'configured', url: 'https://u' });
  assert.equal(state.status, 'idle');
  assert.equal(canCheck(state), true);
  state = reduce(state, { type: 'checking-for-update' });
  assert.equal(canCheck(state), false);
  state = reduce(state, { type: 'update-available', version: '0.2.0' });
  state = reduce(state, { type: 'download-progress', percent: 42.6 });
  assert.equal(state.status, 'downloading');
  assert.equal(state.percent, 43);
  assert.match(updateText(state, '0.1.0'), /43%/);
  state = reduce(state, { type: 'update-downloaded', version: '0.2.0' });
  assert.equal(state.status, 'ready');
  assert.match(updateText(state, '0.1.0'), /restart/);
  // An error after the download is ready does not lose the ready update.
  assert.equal(reduce(state, { type: 'error', message: 'x' }).status, 'ready');
  const failed = reduce(reduce(INITIAL, { type: 'checking-for-update' }), { type: 'error', message: 'ECONNREFUSED' });
  assert.equal(failed.status, 'error');
  assert.match(updateText(failed, '0.1.0'), /ECONNREFUSED/);
  const upToDate = reduce(INITIAL, { type: 'update-not-available', at: '2026-10-20T10:00:00Z' });
  assert.equal(upToDate.status, 'up-to-date');
  assert.match(updateText(upToDate, '0.1.0'), /up to date/);
  // The words of an error: a 404 on latest.yml is an empty update server, DNS and refused connections are the network.
  assert.match(describeUpdateError('Cannot find channel "latest.yml" update info: HttpError: 404 "method: GET url: https://dist.ssam.pro/u/ssam-agent/latest.yml?noCache=1\n\nPlease double check that your authentication token is correct.'), /no version published yet/);
  assert.match(describeUpdateError('HttpError: 404 latest-mac.yml'), /no version published yet/);
  assert.match(describeUpdateError('net::ERR_NAME_NOT_RESOLVED'), /could not be found/);
  assert.match(describeUpdateError('connect ECONNREFUSED 1.2.3.4:443'), /did not answer/);
  assert.equal(describeUpdateError('something else\nsecond line'), 'something else');
});

test('the tray: icon colour, tooltip and menu for each situation', () => {
  const settings = { autostart: true };
  const stopped = summarize({ setUp: true, running: false, state: null });
  const menu = menuFor({ view: stopped, update: INITIAL, appVersion: '0.1.0', settings });
  const ids = menu.filter(item => item.id).map(item => item.id);
  assert.deepEqual(ids, ['status', 'panel', 'start', 'check-updates', 'autostart', 'quit']);
  assert.equal(menu.find(item => item.id === 'autostart').checked, true);
  assert.equal(iconFor(stopped), 'grey');
  const connected = summarize({ setUp: true, running: true, state: { state: 'connected', server: 'https://s' } });
  assert.ok(menuFor({ view: connected, update: INITIAL, appVersion: '0.1.0', settings }).some(item => item.id === 'stop'));
  assert.equal(iconFor(connected), 'green');
  assert.equal(iconFor(summarize({ setUp: true, running: true, state: { state: 'reconnecting' } })), 'amber');
  const notSetUp = summarize({ setUp: false, running: false, state: null });
  assert.equal(iconFor(notSetUp), 'red');
  assert.match(menuFor({ view: notSetUp, update: INITIAL, appVersion: '0.1.0', settings }).find(item => item.id === 'start').label, /Set up/);
  const ready = reduce(INITIAL, { type: 'update-downloaded', version: '0.2.0' });
  const withUpdate = menuFor({ view: stopped, update: ready, appVersion: '0.1.0', settings });
  assert.match(withUpdate.find(item => item.id === 'install-update').label, /0\.2\.0/);
  assert.match(tooltipFor(stopped, ready, '0.1.0'), /Update 0\.2\.0 ready/);
  const off = menuFor({ view: stopped, update: reduce(INITIAL, { type: 'off' }), appVersion: '0.1.0', settings }).find(item => item.id === 'check-updates');
  assert.equal(off.enabled, false);
  const busy = menuFor({ view: stopped, update: INITIAL, appVersion: '0.1.0', settings, busy: true }).find(item => item.id === 'start');
  assert.equal(busy.enabled, false);
});

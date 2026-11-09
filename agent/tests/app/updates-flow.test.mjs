// Behaviour of src/main/electron/updates.mjs against a fake electron-updater that keeps the order of BaseUpdater 6.8.9:
// executeDownload's done dispatches update-downloaded and, in the same tick, addQuitHandler reads autoInstallOnAppQuit (the
// Squirrel fetch of MacUpdater reads it there too). Review of 0.2.8: M1 (a stale verification that finishes last must not
// make an update ready; the file that runs is hashed again), M2 (a verified Windows update still installs on quit, without
// electron-updater's own install-on-quit), B5 (a refusal after a ready is not shown as ready).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createUpdates, fileDigest } from '../../src/main/electron/updates.mjs';
import { reduce, INITIAL, updateText, canCheck } from '../../src/main/core/update-model.mjs';
import { UPDATE_CODES } from '../../src/main/core/update-signature.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeUpdater() {
  const quitHandlers = [];
  const fake = Object.assign(new EventEmitter(), {
    autoInstallOnAppQuit: true, installerPath: null, checks: 0, quitAndInstallCalls: [], installCalls: [], ownQuitHandler: 0,
    setFeedURL() {}, async checkForUpdates() { this.checks++; },
    quitAndInstall(...args) { this.quitAndInstallCalls.push(args); }, install(...args) { this.installCalls.push(args); return true; },
    app: { onQuit: handler => quitHandlers.push(handler) },
    quitHandlers,
    // BaseUpdater.executeDownload done: dispatch, then addQuitHandler in the same tick.
    downloaded(info) { this.installerPath = info.downloadedFile; this.emit('update-downloaded', info); const seen = this.autoInstallOnAppQuit; if (seen) this.ownQuitHandler++; return seen; },
  });
  return fake;
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-flow-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ssam-agent-app-9.9.9-setup.exe');
  fs.writeFileSync(file, 'the owner signed installer');
  const info = { version: '9.9.9', downloadedFile: file, files: [{ url: 'ssam-agent-app-9.9.9-setup.exe', sha512: 'x', size: 1 }] };
  const fake = fakeUpdater(); const entries = []; let stopped = 0;
  const log = { write: (event, data) => entries.push({ event, ...data }), updaterLogger: null };
  // The default verification answers what the real one does: the bytes measured at verification time.
  const approve = () => ({ approved: { file, ...fileDigest(file) } });
  const updates = createUpdates({ url: 'https://dist.example/u', log, platform: 'win32', isPackaged: true, autoInstall: false, currentVersion: '0.2.8',
    updatePublicKey: 'MCowBQYDK2VwAyEA' + 'A'.repeat(43) + '=', updater: fake, stopAgent: async () => { stopped++; }, verifyUpdate: async () => approve(), ...options });
  t.after(() => updates.dispose());
  return { dir, file, info, fake, entries, updates, approve, get stopped() { return stopped; } };
}

test('M1: a stale verification that finishes after a newer, refused download never makes the update ready', async t => {
  let call = 0; let f;
  f = fixture(t, { verifyUpdate: async () => { const n = ++call; if (n === 1) { const answer = f.approve(); await wait(60); return answer; } return { problem: { code: UPDATE_CODES.SIGNATURE_MISSING, message: 'refused' } }; } });
  f.fake.emit('update-available', { version: '9.9.9' });
  f.fake.downloaded(f.info);                                   // verification 1: good bytes measured, then slow
  await wait(10);
  assert.equal(f.updates.state.status, 'verifying');
  await f.updates.check({ force: true });
  assert.equal(f.fake.checks, 0, 'no check starts while a download is being verified');
  fs.writeFileSync(f.file, 'evil installer, same name');      // the feed served other bytes under the same path
  f.fake.downloaded(f.info);                                   // verification 2: refused at once
  await wait(120);
  assert.equal(f.updates.state.status, 'error');
  assert.equal(await f.updates.installNow(), false);
  assert.deepEqual(f.fake.quitAndInstallCalls, []);
  assert.ok(f.entries.some(e => e.event === 'update-verification-superseded'));
  for (const handler of f.fake.quitHandlers) handler(0);
  assert.deepEqual(f.fake.installCalls, [], 'and nothing installs on quit');
});

test('M1: the installer is hashed again right before it runs; a file changed after verification is refused', async t => {
  const f = fixture(t);
  f.fake.downloaded(f.info); await wait(10);
  assert.equal(f.updates.state.status, 'ready');
  fs.writeFileSync(f.file, 'replaced after verification');
  assert.equal(await f.updates.installNow(), false);
  assert.deepEqual(f.fake.quitAndInstallCalls, []);
  assert.equal(f.stopped, 0, 'the agent is not stopped for an installer that will not run');
  assert.equal(f.entries.find(e => e.event === 'update-refused')?.code, UPDATE_CODES.STATEMENT_MISMATCH);
  assert.equal(f.updates.state.status, 'error');
  assert.doesNotMatch(updateText(f.updates.state, '0.2.8'), /ready/, 'B5: the panel no longer says ready');
});

test('M1: an installer path other than the verified file is refused', async t => {
  const f = fixture(t);
  f.fake.downloaded(f.info); await wait(10);
  const other = path.join(f.dir, 'other.exe'); fs.copyFileSync(f.file, other); f.fake.installerPath = other;
  assert.equal(await f.updates.installNow(), false);
  assert.deepEqual(f.fake.quitAndInstallCalls, []);
});

test('M1: a new download while the agent is being stopped cancels the install', async t => {
  let release; let f;
  f = fixture(t, { stopAgent: () => new Promise(resolve => { release = resolve; }) });
  f.fake.downloaded(f.info); await wait(10);
  const pending = f.updates.installNow(); await wait(5);
  f.fake.emit('download-progress', { percent: 10 });
  release();
  assert.equal(await pending, false);
  assert.deepEqual(f.fake.quitAndInstallCalls, []);
});

test('a verified download installs: the agent is stopped, then quitAndInstall(silent, run after)', async t => {
  const f = fixture(t);
  f.fake.downloaded(f.info); await wait(10);
  assert.equal(await f.updates.installNow(), true);
  assert.equal(f.stopped, 1);
  assert.deepEqual(f.fake.quitAndInstallCalls, [[true, true]]);
});

test('M2: on Windows a verified update installs on quit through the module own handler, never electron-updater own', async t => {
  const f = fixture(t);
  const seen = f.fake.downloaded(f.info);
  assert.equal(seen, false, 'electron-updater never registers its own install-on-quit on Windows');
  await wait(10);
  assert.equal(f.fake.autoInstallOnAppQuit, false, 'and the flag stays off after the verification');
  assert.equal(f.fake.ownQuitHandler, 0);
  assert.equal(f.fake.quitHandlers.length, 1, 'the module registered its own quit handler after the verification');
  f.fake.autoInstallOnAppQuit = true; // whatever set it, the next download forces it off in the same tick
  assert.equal(f.fake.downloaded(f.info), false);
  await wait(10);
  assert.equal(f.fake.quitHandlers.length, 1, 'once');
  f.fake.quitHandlers[0](1);
  assert.deepEqual(f.fake.installCalls, [], 'not on a failing exit code');
  f.fake.quitHandlers[0](0);
  assert.deepEqual(f.fake.installCalls, [[true, false]]);
  assert.ok(f.entries.some(e => e.event === 'update-install-on-quit'));
});

test('M2: a refused or changed update is not installed on quit', async t => {
  const refused = fixture(t, { verifyUpdate: async () => ({ problem: { code: UPDATE_CODES.SIGNATURE_INVALID, message: 'bad' } }) });
  refused.fake.downloaded(refused.info); await wait(10);
  assert.equal(refused.fake.quitHandlers.length, 0, 'no handler without a verified download');
  const changed = fixture(t);
  changed.fake.downloaded(changed.info); await wait(10);
  fs.writeFileSync(changed.file, 'changed before quit');
  changed.fake.quitHandlers[0](0);
  assert.deepEqual(changed.fake.installCalls, []);
  assert.equal(changed.entries.find(e => e.event === 'update-refused')?.code, UPDATE_CODES.STATEMENT_MISMATCH);
});

// Review M1 of agent/mac-028: macOS no longer hands the download to Squirrel.Mac in the tick of update-downloaded (the full Mac
// flow is in mac-update.test.mjs).
test('macOS: MacUpdater sees autoInstallOnAppQuit false in the same tick; a refused download is never handed to Squirrel', async t => {
  const f = fixture(t, { platform: 'darwin', verifyUpdate: async () => ({ problem: { code: UPDATE_CODES.DOWNGRADE, message: 'UPDATE_DOWNGRADE: older' } }) });
  f.fake.nativeUpdater = Object.assign(new EventEmitter(), { checks: 0, checkForUpdates() { this.checks++; } });
  assert.equal(f.fake.downloaded(f.info), false);
  await wait(10);
  assert.equal(f.updates.state.status, 'error');
  assert.equal(f.fake.nativeUpdater.checks, 0);
  assert.equal(f.fake.quitHandlers.length, 0);
});

test('a verification that throws is a refusal with a code', async t => {
  const f = fixture(t, { verifyUpdate: async () => { throw new Error('boom'); } });
  f.fake.downloaded(f.info); await wait(10);
  assert.equal(f.updates.state.status, 'error');
  assert.equal(f.entries.find(e => e.event === 'update-refused')?.code, UPDATE_CODES.SIGNATURE_INVALID);
});

test('B5 and the model: verifying blocks checks, a refusal ends ready, a plain error keeps ready', () => {
  const verifying = reduce(INITIAL, { type: 'verifying', version: '9.9.9' });
  assert.equal(verifying.status, 'verifying'); assert.equal(canCheck(verifying), false);
  assert.match(updateText(verifying, '0.2.8'), /Verifying the signature of update 9\.9\.9/);
  assert.equal(reduce(verifying, { type: 'error', message: 'net' }).status, 'verifying');
  const ready = reduce(verifying, { type: 'update-downloaded', version: '9.9.9' });
  assert.equal(reduce(ready, { type: 'error', message: 'net' }).status, 'ready');
  const refused = reduce(ready, { type: 'update-refused', message: 'UPDATE_STATEMENT_MISMATCH: changed' });
  assert.equal(refused.status, 'error'); assert.match(refused.error, /UPDATE_STATEMENT_MISMATCH/);
  assert.equal(canCheck(refused), true);
});

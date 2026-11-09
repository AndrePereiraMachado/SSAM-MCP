// Review M1 of agent/mac-028: the Mac app checks a downloaded update before Squirrel.Mac sees it. electron-updater (MacUpdater
// 6.8.9) checks only the sha512 that latest-mac.yml announces and compares only that file's label (allowDowngrade); Squirrel.Mac
// checks only the code signature. So the genuinely signed 0.2.7 app, zipped again and announced as 0.2.9, would roll every Mac
// back. The Info.plist inside the ZIP (sealed by the signature Squirrel checks) must be com.ssam.agent "SSAM Agent", exactly the
// announced version and newer than this app; only then is the ZIP, hashed again, handed to Squirrel.Mac.
// The fake updater keeps MacUpdater's order: update-downloaded is dispatched, then autoInstallOnAppQuit is read in the same tick
// (MacUpdater.js:219-224), and quitAndInstall hands over to Squirrel (nativeUpdater) only through checkForUpdates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createUpdates, readMacBundle } from '../../src/main/electron/updates.mjs';
import { checkMacUpdate, macBundleProblem, plistStrings } from '../../src/main/core/update-verify.mjs';
import { installerVersionProblem } from '../../src/main/core/update-model.mjs';
import { UPDATE_CODES } from '../../src/main/core/update-signature.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = (version, extra = {}) => ({ name: 'SSAM Agent', identifier: 'com.ssam.agent', shortVersion: version, bundleVersion: version, ...extra });

// What electron-builder writes (macPackager.js:397-398, electronMac.js:93), nested dicts and arrays included.
const infoPlist = version => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>SSAM Agent</string>
  <key>CFBundleExecutable</key>
  <string>SSAM Agent</string>
  <key>CFBundleIdentifier</key>
  <string>com.ssam.agent</string>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleURLName</key><string>nested</string><key>CFBundleVersion</key><string>9.9.9</string></dict></array>
  <key>ElectronAsarIntegrity</key>
  <dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string></dict></dict>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict>
</plist>
`;

test('plistStrings reads the top-level strings of the Info.plist electron-builder writes, never a nested one', () => {
  const values = plistStrings(infoPlist('0.2.9'));
  assert.equal(values.CFBundleIdentifier, 'com.ssam.agent');
  assert.equal(values.CFBundleShortVersionString, '0.2.9');
  assert.equal(values.CFBundleVersion, '0.2.9', 'not the 9.9.9 of the nested dict');
  assert.equal(values.CFBundleURLName, undefined);
  assert.equal(plistStrings('bplist00 binary'), null);
});

test('macBundleProblem: a downgrade relabelled as a higher version, an equal version and the wrong app are refused; an upgrade passes', () => {
  // 0.2.7 (genuinely signed) announced by the feed as 0.2.9: the bundle is not the announced version.
  const relabelled = macBundleProblem({ bundle: bundle('0.2.7'), label: '0.2.9', current: '0.2.8' });
  assert.equal(relabelled.code, UPDATE_CODES.INSTALLER_MISMATCH);
  assert.match(relabelled.message, /version 0\.2\.7, but the update server announced 0\.2\.9/);
  // The same app again, or an older one announced as itself.
  assert.equal(macBundleProblem({ bundle: bundle('0.2.8'), label: '0.2.8', current: '0.2.8' }).code, UPDATE_CODES.DOWNGRADE);
  assert.equal(macBundleProblem({ bundle: bundle('0.2.7'), label: '0.2.7', current: '0.2.8' }).code, UPDATE_CODES.DOWNGRADE);
  assert.equal(macBundleProblem({ bundle: bundle('0.2.9'), label: '0.2.9', current: '0.2.8' }), null);
  assert.equal(macBundleProblem({ bundle: bundle('0.2.9', { bundleVersion: '0.2.9.4711' }), label: '0.2.9', current: '0.2.8' }), null, 'a CI build number is allowed');
  for (const [wrong, pattern] of [[{ identifier: 'com.other.app' }, /com\.other\.app/], [{ name: 'Other' }, /Other\.app/], [{ bundleVersion: '0.2.7' }, /CFBundleVersion/],
    [{ shortVersion: '0.2.9-evil' }, /no readable version/], [{ error: 'unzip failed' }, /unzip failed/]])
    assert.match(macBundleProblem({ bundle: bundle('0.2.9', wrong), label: '0.2.9', current: '0.2.8' }).message, pattern);
  assert.match(macBundleProblem({ bundle: null, label: '0.2.9', current: '0.2.8' }).message, /no readable SSAM Agent\.app Info\.plist/);
});

test('the Mac version rule is the Windows one (installerVersionProblem) on every version case', () => {
  for (const [version, label, current] of [['0.2.7', '0.2.9', '0.2.8'], ['0.2.8', '0.2.8', '0.2.8'], ['0.2.7', '0.2.7', '0.2.8'], ['0.2.9', '0.2.9', '0.2.8'], ['0.3.0', '0.3.0', '0.2.8'], ['1.0.0', '0.3.0', '0.2.8']])
    assert.equal(macBundleProblem({ bundle: bundle(version), label, current }) === null, installerVersionProblem({ productVersion: version, productName: 'SSAM Agent', label, current }) === null, `${version} as ${label} over ${current}`);
});

test('readMacBundle reads exactly one top-level app bundle from the ZIP (unzip), and plutil only for a binary plist', () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '-Z1') return '__MACOSX/\n__MACOSX/SSAM Agent.app/Contents/._Info.plist\nSSAM Agent.app/\nSSAM Agent.app/Contents/Info.plist\nSSAM Agent.app/Contents/Frameworks/X.framework/Resources/Info.plist\n';
    if (args[0] === '-p') return Buffer.from(infoPlist('0.2.9'));
    throw new Error('unexpected ' + cmd);
  };
  assert.deepEqual(readMacBundle('/tmp/update.zip', { exec }), bundle('0.2.9'));
  assert.deepEqual(calls.map(c => c[0]), ['/usr/bin/unzip', '/usr/bin/unzip']);
  assert.deepEqual(calls[1], ['/usr/bin/unzip', '-p', '/tmp/update.zip', 'SSAM Agent.app/Contents/Info.plist']);
  const two = readMacBundle('/tmp/u.zip', { exec: () => 'A.app/Contents/Info.plist\nB.app/Contents/Info.plist\n' });
  assert.match(two.error, /2 app bundles/);
  const binary = readMacBundle('/tmp/u.zip', { exec: (cmd, args) => cmd.endsWith('plutil') ? infoPlist('0.2.9') : args[0] === '-Z1' ? 'SSAM Agent.app/Contents/Info.plist\n' : Buffer.from('bplist00') });
  assert.equal(binary.shortVersion, '0.2.9');
  assert.match(readMacBundle('/tmp/u.zip', { exec: () => { throw new Error('unzip: cannot find zipfile'); } }).error, /cannot find zipfile/);
});

function macFixture(t, { zipVersion = '0.2.9', label = '0.2.9', current = '0.2.8', autoInstall = false, readBundle = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-update-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `ssam-agent-app-${label}-mac-arm64.zip`);
  fs.writeFileSync(file, `the zip of SSAM Agent.app ${zipVersion}`);
  const sha512 = createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  const info = { version: label, downloadedFile: file, files: [{ url: path.basename(file), sha512, size: fs.statSync(file).size }] };
  const native = Object.assign(new EventEmitter(), { checks: 0, checkForUpdates() { this.checks++; } });
  const fake = Object.assign(new EventEmitter(), {
    autoInstallOnAppQuit: true, nativeUpdater: native, squirrelFetches: 0, checks: 0, quitAndInstallCalls: [],
    setFeedURL() {}, async checkForUpdates() { this.checks++; },
    quitAndInstall(...args) { this.quitAndInstallCalls.push(args); },
    app: { onQuit: () => { throw new Error('no own quit handler on macOS'); } },
    // MacUpdater.updateDownloaded: dispatch, then in the same tick hand the ZIP to Squirrel when autoInstallOnAppQuit is on.
    downloaded(i) { this.emit('update-downloaded', i); if (this.autoInstallOnAppQuit) { this.squirrelFetches++; native.checkForUpdates(); } },
  });
  const entries = []; let stopped = 0;
  const log = { write: (event, data) => entries.push({ event, ...data }), updaterLogger: null };
  const updates = createUpdates({ url: 'https://dist.example/u', log, platform: 'darwin', isPackaged: true, autoInstall, currentVersion: current, updater: fake,
    readBundle: readBundle ?? (() => bundle(zipVersion)), stopAgent: async () => { stopped++; }, handoffMs: 200 });
  t.after(() => updates.dispose());
  return { file, info, fake, native, entries, updates, get stopped() { return stopped; } };
}

test('Mac flow: a downgrade relabelled as a higher version is refused and never reaches Squirrel.Mac', async t => {
  const f = macFixture(t, { zipVersion: '0.2.7', label: '0.2.9' });
  f.fake.downloaded(f.info);
  assert.equal(f.fake.squirrelFetches, 0, 'MacUpdater saw autoInstallOnAppQuit false in the tick of update-downloaded');
  await wait(30);
  assert.equal(f.updates.state.status, 'error');
  assert.match(f.updates.state.error, /UPDATE_INSTALLER_MISMATCH: the downloaded app is version 0\.2\.7, but the update server announced 0\.2\.9/);
  assert.equal(f.native.checks, 0, 'Squirrel.Mac never fetched it');
  assert.equal(await f.updates.installNow(), false);
  assert.deepEqual(f.fake.quitAndInstallCalls, []);
  assert.equal(f.stopped, 0);
  assert.equal(f.entries.find(e => e.event === 'update-refused')?.code, UPDATE_CODES.INSTALLER_MISMATCH);
});

test('Mac flow: an update with the same version as this app is refused', async t => {
  const f = macFixture(t, { zipVersion: '0.2.8', label: '0.2.8', current: '0.2.8' });
  f.fake.downloaded(f.info); await wait(30);
  assert.equal(f.updates.state.status, 'error');
  assert.equal(f.entries.find(e => e.event === 'update-refused')?.code, UPDATE_CODES.DOWNGRADE);
  assert.equal(f.native.checks, 0);
});

test('Mac flow: a valid upgrade is checked, handed to Squirrel.Mac once, ready after Squirrel took it, then installed', async t => {
  const f = macFixture(t, { zipVersion: '0.2.9', label: '0.2.9' });
  f.fake.downloaded(f.info);
  assert.equal(f.fake.squirrelFetches, 0);
  await wait(30);
  assert.equal(f.native.checks, 1, 'handed to Squirrel.Mac after the check');
  assert.equal(f.updates.state.status, 'verifying', 'not ready before Squirrel.Mac checked the signature');
  assert.equal(await f.updates.installNow(), false);
  f.native.emit('update-downloaded');
  await wait(10);
  assert.equal(f.updates.state.status, 'ready');
  assert.equal(f.updates.state.version, '0.2.9');
  assert.ok(f.entries.some(e => e.event === 'update-handoff'));
  assert.equal(await f.updates.installNow(), true);
  assert.equal(f.stopped, 1);
  assert.deepEqual(f.fake.quitAndInstallCalls, [[true, true]]);
});

test('Mac flow: Squirrel.Mac refusing the signature, or never answering, leaves nothing ready', async t => {
  const refused = macFixture(t);
  refused.fake.downloaded(refused.info); await wait(30);
  refused.native.emit('error', new Error('Code signature at URL file:///... did not pass validation'));
  await wait(10);
  assert.equal(refused.updates.state.status, 'error');
  assert.match(refused.updates.state.error, /UPDATE_SIGNATURE_INVALID: Squirrel\.Mac refused the update: Code signature/);
  assert.equal(await refused.updates.installNow(), false);
  const silent = macFixture(t);
  silent.fake.downloaded(silent.info); await wait(300);
  assert.equal(silent.updates.state.status, 'error');
  assert.match(silent.updates.state.error, /did not take the update in time/);
});

test('Mac flow: a ZIP changed after the check is not handed to Squirrel.Mac; one not listed by the feed is refused', async t => {
  let release;
  const f = macFixture(t, { readBundle: () => new Promise(resolve => { release = () => resolve(bundle('0.2.9')); }) });
  f.fake.downloaded(f.info); await wait(20);
  fs.writeFileSync(f.file, 'other bytes after the check');
  release(); await wait(20);
  assert.equal(f.native.checks, 0);
  assert.equal(f.entries.find(e => e.event === 'update-refused')?.code, UPDATE_CODES.STATEMENT_MISMATCH);
  const answer = await checkMacUpdate({ info: { ...f.info, files: [{ url: 'x.zip', sha512: 'A'.repeat(86) + '==', size: 1 }] }, currentVersion: '0.2.8', readBundle: () => bundle('0.2.9') });
  assert.equal(answer.problem.code, UPDATE_CODES.STATEMENT_MISMATCH);
});

test('Mac flow: a newer download during the hand-off supersedes it', async t => {
  const f = macFixture(t);
  f.fake.downloaded(f.info); await wait(30);
  assert.equal(f.native.checks, 1);
  f.fake.emit('download-progress', { percent: 5 });
  f.native.emit('update-downloaded');
  await wait(10);
  assert.notEqual(f.updates.state.status, 'ready');
  assert.ok(f.entries.some(e => e.event === 'update-verification-superseded'));
  assert.equal(await f.updates.installNow(), false);
});
